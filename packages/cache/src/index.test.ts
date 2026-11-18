import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FetchPageOptions, FetchPageResult } from "@dox-scraper/fetcher";
import { CacheError, ResponseCache } from "./index.js";

const URL = "https://example.com/articles/one";

function response(
  html: string,
  headers: FetchPageResult["headers"] = {},
  statusCode = 200,
): FetchPageResult {
  return {
    requestedUrl: URL,
    finalUrl: URL,
    statusCode,
    headers: { "content-type": "text/html", ...headers },
    contentType: "text/html",
    html,
    fetchedAt: "2026-11-18T00:00:00.000Z",
    redirectCount: 0,
  };
}

describe("ResponseCache", () => {
  it("stores a successful public page, fingerprints it and reuses fresh content", async () => {
    let now = 1700000000000;
    const fetcher = vi.fn(async () => response("<h1>Example</h1>", { etag: '"version1"' }));
    const cache = new ResponseCache({ fetcher, now: () => now, ttlMs: 5000 });

    const first = await cache.fetch(URL);
    const second = await cache.fetch(URL);
    expect(first.cache.status).toBe("MISS");
    expect(second.cache.status).toBe("HIT");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second.html).toBe("<h1>Example</h1>");
    expect(second.cache.contentSha256).toBe(
      createHash("sha256").update("<h1>Example</h1>").digest("hex"),
    );
    expect(first.cache.changed).toBe(false);
    expect(cache.stats()).toEqual({ entries: 1, bodyBytes: Buffer.byteLength(first.html) });
    now += 100;
    expect((await cache.fetch(URL)).cache.status).toBe("HIT");
  });

  it("uses If-None-Match to revalidate after expiration without downloading HTML again", async () => {
    let now = 1700000000000;
    const fetcher = vi.fn(async (_url: string, options?: FetchPageOptions) => {
      if (options?.ifNoneMatch === '"abc"') return response("", { etag: '"abc"' }, 304);
      return response("original body", { etag: '"abc"' });
    });
    const cache = new ResponseCache({ fetcher, ttlMs: 1000, now: () => now });
    const first = await cache.fetch(URL);
    now += 1001;
    const again = await cache.fetch(URL);
    expect(again.cache.status).toBe("NOT_MODIFIED");
    expect(again.statusCode).toBe(200);
    expect(again.html).toBe("original body");
    expect(again.cache.contentSha256).toBe(first.cache.contentSha256);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(2, URL, { ifNoneMatch: '"abc"' });
    expect((await cache.fetch(URL)).cache.status).toBe("HIT");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("supports If-Modified-Since when no ETag exists", async () => {
    let now = 1700000000000;
    const modified = "Wed, 18 Nov 2026 12:00:00 GMT";
    const fetcher = vi.fn(async (_url: string, opts?: FetchPageOptions) =>
      opts?.ifModifiedSince
        ? response("", { "last-modified": modified }, 304)
        : response("old", { "last-modified": modified }),
    );
    const cache = new ResponseCache({ fetcher, now: () => now, ttlMs: 1000 });
    await cache.fetch(URL);
    now += 1001;
    expect((await cache.fetch(URL)).cache.status).toBe("NOT_MODIFIED");
    expect(fetcher).toHaveBeenNthCalledWith(2, URL, { ifModifiedSince: modified });
  });

  it("detects a content fingerprint change after revalidation", async () => {
    let now = 1700000000000;
    let current = "first";
    const fetcher = vi.fn(async () => response(current, { etag: '"xyz"' }));
    const cache = new ResponseCache({ fetcher, ttlMs: 1000, now: () => now });
    const first = await cache.fetch(URL);
    now += 1001;
    current = "second";
    const next = await cache.fetch(URL);
    expect(next.cache.status).toBe("REFRESHED");
    expect(next.cache.changed).toBe(true);
    expect(next.cache.contentSha256).not.toEqual(first.cache.contentSha256);
    expect(next.html).toBe("second");
  });

  it("skips private, no-store, and Vary responses", async () => {
    for (const headers of [
      { "cache-control": "private" },
      { "cache-control": "public, no-store" },
      { vary: "Accept-Language" },
    ]) {
      const fetcher = vi.fn(async () => response("not cacheable", headers));
      const cache = new ResponseCache({ fetcher });
      expect((await cache.fetch(URL)).cache.status).toBe("BYPASS");
      expect((await cache.fetch(URL)).cache.status).toBe("BYPASS");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(cache.stats().entries).toBe(0);
    }
  });

  it("requires revalidation for no-cache and respects server max-age", async () => {
    let now = 1700000000000;
    const fetcher = vi.fn(async () => response("content", { "cache-control": "no-cache" }));
    const cache = new ResponseCache({ fetcher, ttlMs: 10000, now: () => now });
    await cache.fetch(URL);
    expect((await cache.fetch(URL)).cache.status).toBe("REFRESHED");
    expect(fetcher).toHaveBeenCalledTimes(2);

    const anotherFetcher = vi.fn(async () => response("content", { "cache-control": "max-age=1" }));
    const limited = new ResponseCache({ fetcher: anotherFetcher, ttlMs: 10000, now: () => now });
    await limited.fetch(URL);
    now += 1001;
    expect((await limited.fetch(URL)).cache.status).toBe("REFRESHED");
    expect(anotherFetcher).toHaveBeenCalledTimes(2);
  });

  it("never serves a cached body exceeding a narrower requested maxBytes", async () => {
    const fetcher = vi.fn(async () => response("x".repeat(2048)));
    const cache = new ResponseCache({ fetcher });
    await cache.fetch(URL);
    await expect(cache.fetch(URL, { maxBytes: 1000 })).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("evicts least recently used entries when capacity is exceeded", async () => {
    const fetcher = vi.fn(async (url: string) => ({ ...response("x".repeat(1024)), finalUrl: url }));
    const cache = new ResponseCache({ fetcher, maxEntries: 2, maxTotalBytes: 2048, maxEntryBytes: 1024 });
    const A = URL;
    const B = "https://example.com/articles/two";
    const C = "https://example.com/articles/three";
    await cache.fetch(A);
    await cache.fetch(B);
    await cache.fetch(A); // Touch A, so B is the next eviction.
    await cache.fetch(C);
    expect(cache.stats()).toEqual({ entries: 2, bodyBytes: 2048 });
    await cache.fetch(A);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await cache.fetch(B);
    expect(fetcher).toHaveBeenCalledTimes(4);
    cache.clear();
    expect(cache.stats()).toEqual({ entries: 0, bodyBytes: 0 });
  });

  it("does not cache 429 or 503 error responses", async () => {
    const fetcher = vi.fn(async () => response("Too many requests", { "retry-after": "5" }, 429));
    const cache = new ResponseCache({ fetcher });
    expect((await cache.fetch(URL)).cache.status).toBe("BYPASS");
    expect((await cache.fetch(URL)).cache.status).toBe("BYPASS");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects an unexpected HTTP 304 without a cache entry", async () => {
    const cache = new ResponseCache({ fetcher: async () => response("", {}, 304) });
    await expect(cache.fetch(URL)).rejects.toMatchObject({
      code: "UNEXPECTED_NOT_MODIFIED",
    });
    expect(CacheError.name).toBe("CacheError");
  });

  it("does not send validators when revalidating a redirecting URL", async () => {
    let now = 1700000000000;
    const fetcher = vi.fn(async (url: string, opts?: FetchPageOptions) => {
      expect(opts?.ifNoneMatch).toBeUndefined();
      return {
        ...response("redirect result", { etag: '"abc"' }),
        requestedUrl: url,
        finalUrl: "https://different.example/article",
        redirectCount: 1,
      };
    });
    const cache = new ResponseCache({ fetcher, ttlMs: 1000, now: () => now });
    await cache.fetch(URL);
    now += 1001;
    await cache.fetch(URL);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
