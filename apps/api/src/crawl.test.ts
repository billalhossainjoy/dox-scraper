import { describe, expect, it, vi } from "vitest";
import { DomainRateLimiter } from "@dox-scraper/crawler";
import { SqliteCrawlStore } from "@dox-scraper/storage";
import { createApp } from "./app.js";
import { CrawlManager, ownerDigestForKey } from "./crawl-manager.js";

const URL = "https://example.com/start";
const KEY = "test-only-secret";

function robots(statusCode = 200, body = "User-agent: DoxScraper\nAllow: /\n") {
  return {
    requestedUrl: "https://example.com/robots.txt",
    finalUrl: "https://example.com/robots.txt",
    statusCode,
    html: body,
    contentType: "text/plain",
    headers: { "content-type": "text/plain" },
    fetchedAt: "2026-11-18T00:00:00.000Z",
    redirectCount: 0,
  };
}

function setup(opts: {
  robotsBody?: string;
  robotsStatus?: number;
  loadPage?: (url: string) => Promise<{
    finalUrl: string; statusCode: number; html: string; contentType: string;
  }>;
  fetchRobots?: (url: string, signal: AbortSignal) => Promise<ReturnType<typeof robots>>;
} = {}) {
  const store = new SqliteCrawlStore({ path: ":memory:" });
  const fetchRobots = vi.fn(opts.fetchRobots ?? (async () =>
    robots(opts.robotsStatus ?? 200, opts.robotsBody)));
  const loadPage = vi.fn(opts.loadPage ?? (async (url: string) => ({
    finalUrl: url,
    statusCode: 200,
    contentType: "text/html",
    html: url === URL
      ? '<html><body><main><h1>Start</h1><a href="/next">Next</a></main></body></html>'
      : '<html><body><main><h1>Next</h1></main></body></html>',
  })));
  const manager = new CrawlManager({
    store,
    allowedOrigins: ["https://example.com"],
    fetchRobots,
    loadPage,
    limiter: new DomainRateLimiter({ minDelayMs: 0, maxRetries: 0 }),
  });
  const app = createApp({
    apiKey: KEY,
    crawlEnabled: true,
    crawlManager: manager,
  });
  return { app, store, manager, fetchRobots, loadPage };
}

function request(
  app: ReturnType<typeof createApp>,
  path: string,
  method: "POST" | "GET" | "DELETE" = "GET",
  body: unknown = { url: URL, maxPages: 2, maxDepth: 1 },
  key: string | null = KEY,
) {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = "Bearer " + key;
  if (method === "POST") headers["content-type"] = "application/json";
  return app.request(path, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

async function waitForJob(manager: CrawlManager, id: string, expectedState: string) {
  return vi.waitFor(() => {
    const job = manager.getJob(id, ownerDigestForKey(KEY));
    expect(job.state).toBe(expectedState);
    return job;
  }, { timeout: 15000, interval: 20 });
}

describe("authenticated crawl job routes", () => {
  it("keeps crawl routes disabled by default without starting network work", async () => {
    const app = createApp({ apiKey: KEY, crawlEnabled: false });
    const response = await request(app, "/v1/crawl", "POST");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CRAWL_DISABLED" },
    });
  });

  it("requires authentication on create, status, results and cancellation", async () => {
    const { app, store, fetchRobots } = setup();
    for (const [method, path] of [
      ["POST", "/v1/crawl"],
      ["GET", "/v1/crawl/not-a-job"],
      ["GET", "/v1/crawl/not-a-job/results"],
      ["DELETE", "/v1/crawl/not-a-job"],
    ] as const) {
      expect((await request(app, path, method, undefined, null)).status).toBe(401);
      expect((await request(app, path, method, undefined, "wrong")).status).toBe(401);
    }
    expect(fetchRobots).not.toHaveBeenCalled();
    store.close();
  });

  it("rejects invalid requests, unknown origins and oversized budgets", async () => {
    const { app, store, fetchRobots } = setup();
    for (const payload of [
      { url: "http://127.0.0.1/" },
      { url: "https://example.com/", maxPages: 51 },
      { url: "https://example.com/", maxDepth: 4 },
      { url: "https://example.com/", unknown: 1 },
    ]) {
      expect((await request(app, "/v1/crawl", "POST", payload)).status).toBe(400);
    }
    expect((await request(app, "/v1/crawl", "POST", {
      url: "https://other.example/start",
    })).status).toBe(403);
    expect(fetchRobots).not.toHaveBeenCalled();
    store.close();
  });

  it("returns 202 and provides persisted status, ordered paginated results, and ownership isolation", async () => {
    const { app, store, manager, fetchRobots, loadPage } = setup();
    const created = await request(app, "/v1/crawl", "POST");
    expect(created.status).toBe(202);
    const json = (await created.json()) as { data: { id: string } };
    const id = json.data.id;
    expect(created.headers.get("location")).toBe("/v1/crawl/" + id);
    await waitForJob(manager, id, "completed");

    const status = await request(app, "/v1/crawl/" + id);
    expect(status.status).toBe(200);
    const statusJson = (await status.json()) as {
      data: { state: string; completed: number; pages: Array<{ url: string }> };
    };
    expect(statusJson.data.state).toBe("completed");
    expect(statusJson.data.completed).toBe(2);
    expect(statusJson.data.pages.map((page) => page.url)).toEqual([
      URL, "https://example.com/next",
    ]);
    const results = await request(app, "/v1/crawl/" + id + "/results?limit=1&offset=1");
    expect(results.status).toBe(200);
    await expect(results.json()).resolves.toMatchObject({
      data: {
        total: 2,
        limit: 1,
        offset: 1,
        results: [{ url: "https://example.com/next", markdown: expect.stringContaining("# Next") }],
      },
    });
    expect(fetchRobots).toHaveBeenCalledTimes(1);
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(() => manager.getJob(id, ownerDigestForKey("different-key")))
      .toThrowError("Crawl job not found");
    expect(() => manager.results(id, ownerDigestForKey("different-key"), 1, 0))
      .toThrowError("Crawl job not found");
    expect((await request(app, "/v1/crawl/" + id, "DELETE")).status).toBe(409);
    store.close();
  });

  it("obeys robots.txt disallow rules and does not fetch restricted pages", async () => {
    const { app, store, manager, loadPage } = setup({
      robotsBody: "User-agent: DoxScraper\nDisallow: /\n",
    });
    const response = await request(app, "/v1/crawl", "POST");
    const json = (await response.json()) as { data: { id: string } };
    const job = await waitForJob(manager, json.data.id, "completed");
    expect(job.skipped).toBe(1);
    expect(job.completed).toBe(0);
    expect(loadPage).not.toHaveBeenCalled();
    store.close();
  });

  it("fails closed on unavailable robots policy and never fetches page HTML", async () => {
    const { app, store, manager, loadPage } = setup({ robotsStatus: 503 });
    const response = await request(app, "/v1/crawl", "POST");
    const json = (await response.json()) as { data: { id: string } };
    const job = await waitForJob(manager, json.data.id, "failed");
    expect(job.error).toContain("robots.txt unavailable");
    expect(loadPage).not.toHaveBeenCalled();
    store.close();
  });

  it("allows explicit 404 robots absence on an operator-approved origin", async () => {
    const { app, store, manager, loadPage } = setup({ robotsStatus: 404 });
    const response = await request(app, "/v1/crawl", "POST", {
      url: URL, maxPages: 1, maxDepth: 0,
    });
    const json = (await response.json()) as { data: { id: string } };
    const job = await waitForJob(manager, json.data.id, "completed");
    expect(job.completed).toBe(1);
    expect(loadPage).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("cancels queued/running jobs before any HTML fetch and blocks simultaneous submissions", async () => {
    const controller = vi.fn(async (_url: string, signal: AbortSignal) => {
      return new Promise<ReturnType<typeof robots>>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("Cancelled"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
        void resolve;
      });
    });
    const { app, store, manager, loadPage } = setup({ fetchRobots: controller });
    const first = await request(app, "/v1/crawl", "POST");
    expect(first.status).toBe(202);
    const json = (await first.json()) as { data: { id: string } };
    const busy = await request(app, "/v1/crawl", "POST");
    expect(busy.status).toBe(429);
    const stopped = await request(app, "/v1/crawl/" + json.data.id, "DELETE");
    expect(stopped.status).toBe(200);
    const job = await waitForJob(manager, json.data.id, "cancelled");
    expect(job.completed).toBe(0);
    expect(loadPage).not.toHaveBeenCalled();
    store.close();
  });

  it("validates results pagination without allowing oversized reads", async () => {
    const { app, store } = setup();
    for (const query of ["?limit=0", "?limit=51", "?limit=-1", "?offset=-1", "?offset=1000001"]) {
      expect((await request(app, "/v1/crawl/missing/results" + query)).status).toBe(400);
    }
    store.close();
  });
});
