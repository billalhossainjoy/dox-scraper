import { describe, expect, it, vi } from "vitest";
import { createPersistedCrawlJob, SqliteCrawlStore } from "./index.js";

const ORIGIN = "https://example.com";
const SEED = ORIGIN + "/start";

describe("durable crawl integration", () => {
  it("saves each discovered page, status transition and extracted Markdown", async () => {
    const store = new SqliteCrawlStore({ path: ":memory:" });
    const permission = vi.fn(async () => true);
    const loadPage = vi.fn(async (url: string) => ({
      finalUrl: url,
      statusCode: 200,
      contentType: "text/html",
      html: url === SEED
        ? '<html><head><title>Index</title></head><body><main><h1>Index</h1>' +
          '<p>Home page</p><a href="/next">Next</a></main></body></html>'
        : '<html><head><title>Next</title></head><body><main><h1>Next</h1>' +
          '<p>Detail page</p></main></body></html>',
    }));
    const onSnapshot = vi.fn();
    const job = createPersistedCrawlJob(store, {
      seedUrl: SEED,
      maxPages: 5,
      maxDepth: 1,
      canFetch: permission,
      acquirePermit: async () => {},
      loadPage,
      onSnapshot,
    });

    expect(store.getJob(job.id)?.state).toBe("queued");
    const result = await job.start();
    expect(result.state).toBe("completed");
    expect(store.getJob(job.id)).toEqual(result);
    expect(result.pages.map((item) => item.url)).toEqual([SEED, ORIGIN + "/next"]);
    expect(store.getPageResult(job.id, SEED)).toMatchObject({
      markdown: expect.stringContaining("# Index"),
      metadata: { title: "Index", statusCode: 200, depth: 0 },
    });
    expect(store.getPageResult(job.id, ORIGIN + "/next")).toMatchObject({
      markdown: expect.stringContaining("# Next"),
      metadata: { title: "Next", statusCode: 200, depth: 1 },
    });
    expect(onSnapshot).toHaveBeenCalled();
    expect(permission).toHaveBeenCalledTimes(2);
    expect(loadPage).toHaveBeenCalledTimes(2);
    store.close();
  });

  it("fails closed when required permission checking fails", async () => {
    const store = new SqliteCrawlStore({ path: ":memory:" });
    const loadPage = vi.fn(async () => ({
      finalUrl: SEED, statusCode: 200, contentType: "text/html", html: "<p>Blocked</p>",
    }));
    const job = createPersistedCrawlJob(store, {
      seedUrl: SEED,
      canFetch: async () => { throw new Error("robots.txt unavailable"); },
      acquirePermit: async () => {},
      loadPage,
    });
    const result = await job.start();
    expect(result.state).toBe("failed");
    expect(store.getJob(job.id)).toEqual(result);
    expect(store.getPageResult(job.id, SEED)).toBeNull();
    expect(loadPage).not.toHaveBeenCalled();
    store.close();
  });
});
