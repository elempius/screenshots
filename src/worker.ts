export interface Env {
  BUCKET: R2Bucket;
  UPLOAD_TOKEN: string;
  MAX_UPLOAD_BYTES?: string;
}

const ROUTE_PREFIX = "/";
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SLUG_LENGTH = 8;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

class PayloadTooLargeError extends Error {}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      switch (request.method) {
        case "POST":
          return await handleUpload(request, env, url);
        case "GET":
        case "HEAD":
          return await handleServe(request, env, url, ctx);
        default:
          return text("ERROR: method not allowed", 405, { allow: "GET, HEAD, POST" });
      }
    } catch (err) {
      console.error(JSON.stringify({ msg: "unhandled error", error: String(err) }));
      return text("ERROR: internal error", 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleUpload(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname !== ROUTE_PREFIX) {
    return text("ERROR: not found", 404);
  }
  if (!(await isAuthorized(request, env))) {
    return text("ERROR: unauthorized", 401);
  }

  const maxBytes = parseMaxBytes(env);
  const declaredLengthHeader = request.headers.get("content-length");
  const declaredLength = declaredLengthHeader === null ? NaN : Number(declaredLengthHeader);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return text("ERROR: payload too large", 413);
  }

  const uploadRequest = Number.isFinite(declaredLength)
    ? request
    : limitRequestBody(request, maxBytes);
  let form: FormData;
  try {
    form = await uploadRequest.formData();
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return text("ERROR: payload too large", 413);
    }
    return text("ERROR: expected multipart/form-data", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return text("ERROR: missing 'file' upload", 400);
  }
  if (file.size > maxBytes) {
    return text("ERROR: payload too large", 413);
  }

  const contentType = normalizeContentType(file.type);
  if (contentType === null) {
    return text("ERROR: unsupported content type", 415, {
      accept: Object.keys(IMAGE_EXTENSIONS).join(", "),
    });
  }
  const metadata = { httpMetadata: { contentType, cacheControl: IMMUTABLE_CACHE } };

  // Retry in the (astronomically unlikely) event of a slug collision with an
  // existing object; a null result means the precondition blocked the write.
  let key = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    key = generateKey(contentType);
    const written = await env.BUCKET.put(key, file, {
      ...metadata,
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (written !== null) break;
  }

  console.log(JSON.stringify({ msg: "uploaded", key, size: file.size, contentType }));
  return text(`SUCCESS: ${url.origin}${ROUTE_PREFIX}${key}`, 200);
}

async function handleServe(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!url.pathname.startsWith(ROUTE_PREFIX)) {
    return notFoundPage(request.method);
  }
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length));
  } catch {
    return notFoundPage(request.method);
  }
  if (key === "") {
    return notFoundPage(request.method);
  }

  const isHead = request.method === "HEAD";

  // Cache under the normalized (query-free) URL so variants like /key.png?v=1
  // share one cache entry instead of bypassing and fragmenting the cache.
  // ignoreMethod lets GET-cached entries also serve HEAD requests.
  const cacheRequest = normalizedCacheRequest(request);
  const cacheableRequest = !request.headers.has("if-match") && !request.headers.has("if-unmodified-since");
  if (cacheableRequest) {
    const cached = await caches.default.match(cacheRequest, { ignoreMethod: true });
    if (cached) {
      return isHead ? headFrom(cached) : cached;
    }
  }

  const object = await env.BUCKET.get(key, {
    onlyIf: request.headers,
    range: request.headers,
  });
  if (object === null) {
    return notFoundPage(request.method);
  }

  // R2 reports a range even when the client did not send one (a full-object
  // range), so decide partial vs. full from whether it covers the whole object.
  const range = object.range ? parseRange(object.range, object.size) : undefined;
  const partial = !!range && (range.offset !== 0 || range.length !== object.size);
  const status = partial ? 206 : 200;

  const headers = serveHeaders(object);
  headers.set("content-length", String(range?.length ?? object.size));
  if (partial && range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  }
  if (!("body" in object) || object.body === null) {
    return new Response(null, { status: conditionalFailureStatus(request.headers), headers });
  }

  const response = new Response(object.body, { status, headers });
  if (isHead) {
    return headFrom(response);
  }
  if (status === 200) {
    ctx.waitUntil(caches.default.put(cacheRequest, response.clone()));
  }
  return response;
}

function normalizedCacheRequest(request: Request): Request {
  const url = new URL(request.url);
  url.search = "";
  return new Request(url, request);
}

function headFrom(response: Response): Response {
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
}

function serveHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("x-content-type-options", "nosniff");
  if (!headers.has("cache-control")) {
    headers.set("cache-control", IMMUTABLE_CACHE);
  }
  return headers;
}

function conditionalFailureStatus(headers: Headers): number {
  return headers.has("if-match") || headers.has("if-unmodified-since") ? 412 : 304;
}

function limitRequestBody(request: Request, maxBytes: number): Request {
  if (request.body === null) {
    return request;
  }

  let total = 0;
  const body = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(new PayloadTooLargeError());
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Request(request, { body });
}

// Requires an Authorization bearer token so it never appears in URLs or logs.
async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ") || !env.UPLOAD_TOKEN) {
    return false;
  }
  const provided = header.slice("Bearer ".length).trim();
  return await constantTimeEquals(provided, env.UPLOAD_TOKEN);
}

async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}

function generateKey(contentType: string): string {
  const now = new Date();
  const stamp =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}-UTC`;
  return `${stamp}-${randomSlug()}.${extensionFor(contentType)}`;
}

function randomSlug(): string {
  let slug = "";
  while (slug.length < SLUG_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(SLUG_LENGTH - slug.length));
    for (const b of bytes) {
      if (b < 248) {
        slug += SLUG_ALPHABET[b % 62];
        if (slug.length === SLUG_LENGTH) break;
      }
    }
  }
  return slug;
}

// Returns null for unknown types so unsupported uploads are rejected.
function normalizeContentType(rawType: string): string | null {
  const type = rawType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type in IMAGE_EXTENSIONS ? type : null;
}

function extensionFor(contentType: string): string {
  return IMAGE_EXTENSIONS[contentType];
}

// Note: R2's range objects carry all keys (e.g. suffix: undefined), so test
// values rather than key presence.
function parseRange(range: R2Range, size: number): { offset: number; length: number } {
  const r = range as {
    suffix?: number;
    offset?: number;
    length?: number;
  };
  if (r.suffix !== undefined) {
    const length = Math.min(r.suffix, size);
    return { offset: size - length, length };
  }
  const offset = r.offset ?? 0;
  return { offset, length: Math.min(r.length ?? size - offset, size - offset) };
}

function parseMaxBytes(env: Env): number {
  const configured = Number(env.MAX_UPLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function text(body: string, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...extraHeaders },
  });
}

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not Found</title>
<style>
  :root { color-scheme: light dark; }
  body {
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; margin: 0;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f6f6f7; color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16171a; color: #e4e4e6; }
  }
  main { text-align: center; padding: 2rem; }
  h1 { font-size: 5rem; margin: 0; font-weight: 700; letter-spacing: -0.03em; opacity: 0.85; }
  p { margin: 0.5rem 0 0; opacity: 0.6; }
</style>
</head>
<body>
<main>
<h1>404</h1>
<p>Nothing here.</p>
</main>
</body>
</html>
`;

function notFoundPage(method: string): Response {
  if (method === "HEAD") {
    return new Response(null, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
