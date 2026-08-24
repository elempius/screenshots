import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/worker";

const keys: string[] = [];

afterEach(async () => {
  if (keys.length > 0) {
    await env.BUCKET.delete(keys.splice(0));
  }
});

async function request(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const workerEnv = { ...env, UPLOAD_TOKEN: "test-token" };
  const response = await worker.fetch(new Request(`https://screenshots.example${path}`, init), workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function put(key: string, value: string): Promise<R2Object> {
  keys.push(key);
  return (await env.BUCKET.put(key, value, { httpMetadata: { contentType: "text/plain" } }))!;
}

async function upload(body: BodyInit | undefined, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", "Bearer test-token");
  return request("/", {
    method: "POST",
    body,
    ...init,
    headers,
  });
}

function multipart(file: { name: string; type: string; contents?: string }): FormData {
  const form = new FormData();
  form.set("file", new File([file.contents ?? "data"], file.name, { type: file.type }));
  return form;
}

describe("screenshot uploading", () => {
  it("accepts uploads with a bearer token and stores the file", async () => {
    const response = await request("/", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: multipart({ name: "shot.png", type: "image/png" }),
    });

    expect(response.status).toBe(200);
    const url = await response.text();
    expect(url).toMatch(/^SUCCESS: https:\/\/screenshots\.example\/[\w-]+\.png$/);

    const key = url.split("/").pop()!;
    keys.push(key);
    const object = await env.BUCKET.get(key);
    expect(await object?.text()).toBe("data");
    expect(object?.httpMetadata?.contentType).toBe("image/png");
    expect(object?.httpMetadata?.cacheControl).toContain("immutable");
  });

  it("rejects uploads without credentials", async () => {
    const noAuth = await request("/", { method: "POST" });
    expect(noAuth.status).toBe(401);

    const wrongToken = await request("/", {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: multipart({ name: "a.png", type: "image/png" }),
    });
    expect(wrongToken.status).toBe(401);

    const queryToken = await request("/?token=test-token", {
      method: "POST",
      body: multipart({ name: "a.png", type: "image/png" }),
    });
    expect(queryToken.status).toBe(401);
  });

  it("rejects non-multipart bodies", async () => {
    const response = await upload("not-a-form");
    expect(response.status).toBe(400);
  });

  it("rejects an empty or missing file field", async () => {
    const emptyFile = await upload(new FormData());
    expect(emptyFile.status).toBe(400);
  });

  it("rejects payloads over the configured limit", async () => {
    const response = await upload(multipart({ name: "big.png", type: "image/png", contents: "x" }), {
      headers: { "content-length": String(64 * 1024 * 1024) },
    });
    expect(response.status).toBe(413);
  });

  it("rejects unsupported content types", async () => {
    const response = await upload(multipart({ name: "x.txt", type: "text/plain" }));
    expect(response.status).toBe(415);
    expect(response.headers.get("accept")).toContain("image/png");

    const missingType = await upload(multipart({ name: "y.bin", type: "" }));
    expect(missingType.status).toBe(415);
  });
});

describe("screenshot serving", () => {
  it("advertises HEAD in method-not-allowed responses", async () => {
    const response = await request("/", { method: "PUT" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, POST");
  });

  it("returns 412 when If-Match fails", async () => {
    const key = "conditional-test";
    await put(key, "payload");

    const response = await request(`/${key}`, {
      headers: { "If-Match": '"wrong-etag"' },
    });

    expect(response.status).toBe(412);
  });

  it("serves R2 ranges consistently on cache misses", async () => {
    const key = "range-test";
    await put(key, "0123456789");

    const response = await request(`/${key}`, {
      headers: { Range: "bytes=2-5" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("2345");
  });

  it("honors validators for HEAD requests", async () => {
    const key = "head-test";
    const object = await put(key, "payload");

    const response = await request(`/${key}`, {
      method: "HEAD",
      headers: { "If-None-Match": object.httpEtag },
    });

    expect(response.status).toBe(304);
  });

  it("serves HEAD with an explicit content-length", async () => {
    const key = "head-length-test";
    await put(key, "payload");

    const response = await request(`/${key}`, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("7");
    expect(await response.text()).toBe("");
  });

  it("serves requests with query strings under the same key", async () => {
    const key = "query-string-test";
    await put(key, "payload");

    const response = await request(`/${key}?download=1&v=2`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("payload");
  });

  it("includes last-modified from the upload time", async () => {
    const key = "last-modified-test";
    const object = await put(key, "payload");

    const response = await request(`/${key}`);

    expect(response.headers.get("last-modified")).toBe(object.uploaded.toUTCString());
  });
});
