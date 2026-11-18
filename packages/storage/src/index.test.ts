import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CrawlSnapshot } from "@dox-scraper/crawler";
import { SqliteCrawlStore } from "./index.js";

const F = "https://example.com/start";

function snapshot(overrides: Partial<CrawlSnapshot> = {}): CrawlSnapshot {
  return {
    id: "job-001",
    seedUrl: F,
    allowedOrigin: "https://example.com",
    state: "queued",
    startedAt: null,
    finishedAt: null,
    maxPages: 20,
    maxDepth: 2,
    attempted: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    queued: 1,
    active: 0,
    discovered: 1,
    error: null,
    pages: [{ url: F, depth: 0, state: "queued" }],
    ...overrides,
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SQLite crawl persistence", () => {
  it("runs the migration and reopens the same database without losing data", () => {
    const root = mkdtempSync(join(tmpdir(), "dox-storage-"));
    roots.push(root);
    const filename = join(root, "nested", "crawl.sqlite");
    const store = new SqliteCrawlStore({ path: filename });
    expect(store.schemaVersion()).toBe(1);
    store.saveSnapshot(snapshot());
    store.savePageResult({
      jobId: "job-001", url: F,
      markdown: "# Example\n\nHello", contentText: "Example Hello",
      metadata: { title: "Example", language: "en" },
    });
    const fingerprint = createHash("sha256").update("# Example\n\nHello").digest("hex");
    expect(store.getPageResult("job-001", F)?.markdownSha256).toBe(fingerprint);
    store.close();

    const reopened = new SqliteCrawlStore({ path: filename });
    expect(reopened.schemaVersion()).toBe(1);
    expect(reopened.getJob("job-001")).toEqual(snapshot());
    expect(reopened.getPageResult("job-001", F)).toMatchObject({
      markdown: "# Example\n\nHello",
      contentText: "Example Hello",
      metadata: { title: "Example", language: "en" },
      markdownSha256: fingerprint,
    });
    reopened.close();
  });

  it("atomically upserts page states without losing already extracted content", () => {
    const db = new SqliteCrawlStore({ path: ":memory:" });
    db.saveSnapshot(snapshot());
    db.savePageResult({
      jobId: "job-001", url: F, markdown: "One", contentText: "One",
      metadata: { title: "One" },
    });
    const completed = snapshot({
      state: "completed",
      startedAt: "2026-11-18T00:00:00.000Z",
      finishedAt: "2026-11-18T00:00:10.000Z",
      attempted: 2, completed: 2, queued: 0, discovered: 2,
      pages: [
        { url: F, depth: 0, state: "completed", statusCode: 200, discoveredLinks: 1 },
        { url: "https://example.com/next", depth: 1, state: "completed", statusCode: 200, discoveredLinks: 0 },
      ],
    });
    db.saveSnapshot(completed);
    expect(db.getJob("job-001")).toEqual(completed);
    expect(db.getPageResult("job-001", F)?.markdown).toBe("One");
    expect(db.getJob("absent")).toBeNull();
    expect(db.listJobs().map((job) => job.id)).toEqual(["job-001"]);
    db.close();
  });

  it("recovers incomplete jobs without resuming network activity", () => {
    const db = new SqliteCrawlStore({ path: ":memory:" });
    db.saveSnapshot(snapshot({
      state: "running", startedAt: "2026-11-18T00:00:00.000Z",
      queued: 1, active: 1, attempted: 1, discovered: 2,
      pages: [
        { url: F, depth: 0, state: "active" },
        { url: "https://example.com/queued", depth: 1, state: "queued" },
      ],
    }));
    expect(db.recoverInterruptedJobs()).toBe(1);
    const recovered = db.getJob("job-001");
    expect(recovered).toMatchObject({
      state: "failed", error: "PROCESS_RESTARTED", queued: 0,
      active: 0, skipped: 2, discovered: 2,
    });
    expect(recovered?.pages.every((page) => page.error === "PROCESS_RESTARTED")).toBe(true);
    expect(db.recoverInterruptedJobs()).toBe(0);
    db.close();
  });

  it("enforces byte-size limits and foreign keys without partial writes", () => {
    const db = new SqliteCrawlStore({ path: ":memory:", maxResultBytes: 1024 });
    db.saveSnapshot(snapshot());
    expect(() => db.savePageResult({
      jobId: "job-001", url: F, markdown: "😀".repeat(400),
      contentText: "", metadata: {},
    })).toThrow(RangeError);
    expect(db.getPageResult("job-001", F)).toBeNull();
    expect(() => db.savePageResult({
      jobId: "missing", url: F, markdown: "x",
      contentText: "x", metadata: {},
    })).toThrow();
    db.close();
  });

  it("persists bounded public cache data, evicts LRU and honors privacy", () => {
    const db = new SqliteCrawlStore({
      path: ":memory:", maxCacheEntries: 2,
      maxCacheBodyBytes: 1024, maxCacheBytes: 2048,
    });
    const make = (key: string) => ({
      cacheKey: key, url: "https://example.com/" + key,
      html: "x".repeat(1024), expiresAtMs: Date.now() + 60_000,
    });
    expect(db.saveCache(make("a"))?.htmlSha256).toMatch(/^[a-f0-9]{64}$/);
    db.saveCache(make("b"));
    expect(db.getCache("a")?.cacheKey).toBe("a");
    db.saveCache(make("c"));
    expect(db.getCache("b")).toBeNull();
    expect(db.getCache("a")).not.toBeNull();
    expect(db.getCache("c")).not.toBeNull();
    expect(db.saveCache({ ...make("secret"), cacheControl: "private, no-store" })).toBeNull();
    expect(db.saveCache({ ...make("vary"), vary: "accept-language" })).toBeNull();
    expect(db.saveCache({ ...make("huge"), html: "x".repeat(2048) })).toBeNull();
    db.close();
  });

  it("survives a cache restart and expires old entries", () => {
    const root = mkdtempSync(join(tmpdir(), "dox-cache-"));
    roots.push(root);
    const path = join(root, "cache.sqlite");
    const db = new SqliteCrawlStore({ path });
    db.saveCache({
      cacheKey: "key", url: F, html: "cache body",
      etag: '"1"', expiresAtMs: Date.now() + 60_000,
    });
    db.close();

    const reopened = new SqliteCrawlStore({ path });
    expect(reopened.getCache("key")).toMatchObject({
      html: "cache body", etag: '"1"',
    });
    expect(reopened.getCache("unknown")).toBeNull();
    expect(reopened.pruneExpiredCache()).toBe(0);
    reopened.close();
  });

  it("deletes a job and cascades its pages and extracted content", () => {
    const db = new SqliteCrawlStore({ path: ":memory:" });
    db.saveSnapshot(snapshot());
    db.savePageResult({
      jobId: "job-001", url: F, markdown: "Hello", contentText: "Hello", metadata: {},
    });
    expect(db.deleteJob("job-001")).toBe(true);
    expect(db.deleteJob("job-001")).toBe(false);
    expect(db.getJob("job-001")).toBeNull();
    expect(db.getPageResult("job-001", F)).toBeNull();
    db.close();
  });
});
