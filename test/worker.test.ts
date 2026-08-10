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

describe("screenshot serving", () => {
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
});
