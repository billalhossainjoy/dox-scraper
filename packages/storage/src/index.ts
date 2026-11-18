import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CrawlJobState, CrawlPageRecord, CrawlSnapshot } from "@dox-scraper/crawler";
import { migrate } from "./schema.js";

export { migrate } from "./schema.js";

export interface SqliteStoreOptions {
  /** File-backed database path, or ':memory:' for tests. */
  path: string;
  /** UTF-8 byte limit for one result, including Markdown/text/metadata. */
  maxResultBytes?: number;
  maxCacheBodyBytes?: number;
  maxCacheBytes?: number;
  maxCacheEntries?: number;
}

export interface PageResultInput {
  jobId: string;
  url: string;
  markdown: string;
  contentText: string;
  metadata: Record<string, unknown>;
  scrapedAt?: string;
}

export interface StoredPageResult extends Omit<PageResultInput, "scrapedAt"> {
  markdownSha256: string;
  contentBytes: number;
  scrapedAt: string;
}

export interface CacheEntryInput {
  cacheKey: string;
  url: string;
  html: string;
  expiresAtMs: number;
  etag?: string | null;
  lastModified?: string | null;
  /** Cache-Control is honored; never store private or no-store. */
  cacheControl?: string;
  /** Nonempty Vary is unsupported and will bypass persistence. */
  vary?: string;
}

export interface StoredCacheEntry {
  cacheKey: string;
  url: string;
  html: string;
  htmlSha256: string;
  etag: string | null;
  lastModified: string | null;
  cachedAt: string;
  expiresAtMs: number;
  bodyBytes: number;
}

interface JobRow {
  id: string;
  seed_url: string;
  allowed_origin: string;
  state: CrawlJobState;
  started_at: string | null;
  finished_at: string | null;
  max_pages: number;
  max_depth: number;
  attempted: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  queued: number;
  active: number;
  discovered: number;
  error: string | null;
}

interface PageRow {
  url: string;
  depth: number;
  state: CrawlPageRecord["state"];
  status_code: number | null;
  discovered_links: number | null;
  error: string | null;
}

interface ResultRow {
  job_id: string;
  url: string;
  markdown: string;
  content_text: string;
  metadata_json: string;
  markdown_sha256: string;
  content_bytes: number;
  scraped_at: string;
}

interface CacheRow {
  cache_key: string;
  url: string;
  html: string;
  html_sha256: string;
  etag: string | null;
  last_modified: string | null;
  cached_at: string;
  expires_at_ms: number;
  body_bytes: number;
}

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(name + " must be an integer from " + min + " to " + max);
  }
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeValidator(value?: string | null): string | null {
  if (!value || value.length > 1024 || [...value].some((c) =>
    c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
  return value;
}

function intoPage(row: PageRow): CrawlPageRecord {
  return {
    url: row.url,
    depth: row.depth,
    state: row.state,
    ...(row.status_code === null ? {} : { statusCode: row.status_code }),
    ...(row.discovered_links === null ? {} : { discoveredLinks: row.discovered_links }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

/**
 * Single-process, synchronous SQLite repository. Node >=24.15 supplies the
 * bundled node:sqlite module without a native npm dependency/build script.
 *
 * WAL, foreign keys, prepared statements, transactional snapshot updates,
 * schema migrations and per-entry storage budgets are enabled by default.
 * Do not store credentials or private/sensitive scraped content here.
 */
export class SqliteCrawlStore {
  private readonly db: DatabaseSync;
  private readonly maxResultBytes: number;
  private readonly maxCacheBodyBytes: number;
  private readonly maxCacheBytes: number;
  private readonly maxCacheEntries: number;

  constructor(options: SqliteStoreOptions) {
    if (!options.path?.trim() || options.path.includes("\0")) {
      throw new TypeError("A SQLite database path is required");
    }
    this.maxResultBytes = integer(options.maxResultBytes ?? 256 * 1024,
      "maxResultBytes", 1024, 2 * 1024 * 1024);
    this.maxCacheBodyBytes = integer(options.maxCacheBodyBytes ?? 2 * 1024 * 1024,
      "maxCacheBodyBytes", 1024, 20 * 1024 * 1024);
    this.maxCacheBytes = integer(options.maxCacheBytes ?? 32 * 1024 * 1024,
      "maxCacheBytes", 1024, 512 * 1024 * 1024);
    this.maxCacheEntries = integer(options.maxCacheEntries ?? 100,
      "maxCacheEntries", 1, 10000);

    const path = options.path === ":memory:" ? ":memory:" : resolve(options.path);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec("PRAGMA foreign_keys=ON");
      if (path !== ":memory:") {
        this.db.exec("PRAGMA journal_mode=WAL");
        chmodSync(path, 0o600);
      }
      migrate(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    return row.user_version;
  }

  /**
   * Idempotent transactional upsert of job status and all discovered URLs.
   * Existing page_results stay attached to their (job_id, url) records.
   */
  saveSnapshot(snapshot: CrawlSnapshot): void {
    const jobColumns = [
      "id", "seed_url", "allowed_origin", "state", "started_at", "finished_at",
      "max_pages", "max_depth", "attempted", "completed", "failed", "skipped",
      "cancelled", "queued", "active", "discovered", "error", "updated_at",
    ];
    const pageColumns = [
      "job_id", "ordinal", "url", "depth", "state", "status_code",
      "discovered_links", "error",
    ];
    const insertJob = this.db.prepare(
      "INSERT INTO crawl_jobs (" + jobColumns.join(",") + ") VALUES (" +
      jobColumns.map(() => "?").join(",") + ") ON CONFLICT(id) DO UPDATE SET " +
      jobColumns.slice(1).map((col) => col + "=excluded." + col).join(","),
    );
    const insertPage = this.db.prepare(
      "INSERT INTO crawl_pages (" + pageColumns.join(",") + ") VALUES (" +
      pageColumns.map(() => "?").join(",") + ") ON CONFLICT(job_id,url) DO UPDATE SET " +
      pageColumns.slice(1).filter((col) => col !== "url")
        .map((col) => col + "=excluded." + col).join(","),
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      insertJob.run(
        snapshot.id, snapshot.seedUrl, snapshot.allowedOrigin, snapshot.state,
        snapshot.startedAt, snapshot.finishedAt, snapshot.maxPages, snapshot.maxDepth,
        snapshot.attempted, snapshot.completed, snapshot.failed, snapshot.skipped,
        snapshot.cancelled, snapshot.queued, snapshot.active, snapshot.discovered,
        snapshot.error, new Date().toISOString(),
      );
      for (let ordinal = 0; ordinal < snapshot.pages.length; ordinal++) {
        const page = snapshot.pages[ordinal]!;
        insertPage.run(
          snapshot.id, ordinal, page.url, page.depth, page.state,
          page.statusCode ?? null, page.discoveredLinks ?? null, page.error ?? null,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getJob(id: string): CrawlSnapshot | null {
    const job = this.db.prepare("SELECT * FROM crawl_jobs WHERE id=?")
      .get(id) as unknown as JobRow | undefined;
    if (!job) return null;
    const pages = this.db.prepare(
      "SELECT url,depth,state,status_code,discovered_links,error FROM crawl_pages " +
      "WHERE job_id=? ORDER BY ordinal",
    ).all(id) as unknown as PageRow[];
    return {
      id: job.id,
      seedUrl: job.seed_url,
      allowedOrigin: job.allowed_origin,
      state: job.state,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      maxPages: job.max_pages,
      maxDepth: job.max_depth,
      attempted: job.attempted,
      completed: job.completed,
      failed: job.failed,
      skipped: job.skipped,
      cancelled: job.cancelled,
      queued: job.queued,
      active: job.active,
      discovered: job.discovered,
      error: job.error,
      pages: pages.map(intoPage),
    };
  }

  listJobs(limit = 20, offset = 0): CrawlSnapshot[] {
    integer(limit, "limit", 1, 100);
    integer(offset, "offset", 0, 1000000);
    const ids = this.db.prepare(
      "SELECT id FROM crawl_jobs ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
    ).all(limit, offset) as unknown as Array<{ id: string }>;
    return ids.flatMap(({ id }) => {
      const job = this.getJob(id);
      return job ? [job] : [];
    });
  }

  /**
   * Restart recovery does not auto-resume requests; any incomplete jobs are
   * failed closed. Call only when starting the single owner of this DB.
   */
  recoverInterruptedJobs(): number {
    const interrupted = this.db.prepare(
      "SELECT id FROM crawl_jobs WHERE state IN ('queued','running')",
    ).all() as unknown as Array<{ id: string }>;
    if (interrupted.length === 0) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { id } of interrupted) {
        this.db.prepare(
          "UPDATE crawl_pages SET state='skipped',error='PROCESS_RESTARTED' " +
          "WHERE job_id=? AND state IN ('queued','active')",
        ).run(id);
        const counts = this.db.prepare(
          "SELECT state,COUNT(*) AS n FROM crawl_pages WHERE job_id=? GROUP BY state",
        ).all(id) as unknown as Array<{ state: string; n: number }>;
        const count = (state: string) => counts.find((x) => x.state === state)?.n ?? 0;
        this.db.prepare(
          "UPDATE crawl_jobs SET state='failed',finished_at=?,error='PROCESS_RESTARTED'," +
          "completed=?,failed=?,skipped=?,cancelled=?,queued=0,active=0," +
          "discovered=(SELECT COUNT(*) FROM crawl_pages WHERE job_id=?),updated_at=? WHERE id=?",
        ).run(
          new Date().toISOString(), count("completed"), count("failed"),
          count("skipped"), count("cancelled"), id, new Date().toISOString(), id,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return interrupted.length;
  }

  savePageResult(input: PageResultInput): StoredPageResult {
    const metadataJson = JSON.stringify(input.metadata);
    if (typeof metadataJson !== "string") throw new TypeError("metadata must be JSON serializable");
    const contentBytes = Buffer.byteLength(input.markdown, "utf8") +
      Buffer.byteLength(input.contentText, "utf8") + Buffer.byteLength(metadataJson, "utf8");
    if (contentBytes > this.maxResultBytes) {
      throw new RangeError("Extracted result exceeds maxResultBytes");
    }
    const result: StoredPageResult = {
      ...input,
      markdownSha256: hash(input.markdown),
      contentBytes,
      scrapedAt: input.scrapedAt ?? new Date().toISOString(),
    };
    this.db.prepare(
      "INSERT INTO page_results(job_id,url,markdown,content_text,metadata_json," +
      "markdown_sha256,content_bytes,scraped_at) VALUES(?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(job_id,url) DO UPDATE SET markdown=excluded.markdown," +
      "content_text=excluded.content_text,metadata_json=excluded.metadata_json," +
      "markdown_sha256=excluded.markdown_sha256,content_bytes=excluded.content_bytes," +
      "scraped_at=excluded.scraped_at",
    ).run(
      input.jobId, input.url, input.markdown, input.contentText,
      metadataJson, result.markdownSha256, contentBytes, result.scrapedAt,
    );
    return result;
  }

  getPageResult(jobId: string, url: string): StoredPageResult | null {
    const row = this.db.prepare(
      "SELECT * FROM page_results WHERE job_id=? AND url=?",
    ).get(jobId, url) as unknown as ResultRow | undefined;
    if (!row) return null;
    return {
      jobId: row.job_id,
      url: row.url,
      markdown: row.markdown,
      contentText: row.content_text,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
      markdownSha256: row.markdown_sha256,
      contentBytes: row.content_bytes,
      scrapedAt: row.scraped_at,
    };
  }

  /** Store only explicitly public, representation-independent cached HTML. */
  saveCache(input: CacheEntryInput): StoredCacheEntry | null {
    const control = (input.cacheControl ?? "").toLowerCase();
    if (/(?:^|,)\s*(?:no-store|private)(?:\s*[,;=]|$)/.test(control) || input.vary?.trim()) {
      return null;
    }
    if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= Date.now()) {
      return null;
    }
    const bodyBytes = Buffer.byteLength(input.html, "utf8");
    if (bodyBytes > this.maxCacheBodyBytes || bodyBytes > this.maxCacheBytes) return null;
    const cachedAt = new Date().toISOString();
    const entry: StoredCacheEntry = {
      cacheKey: input.cacheKey,
      url: input.url,
      html: input.html,
      htmlSha256: hash(input.html),
      etag: safeValidator(input.etag),
      lastModified: safeValidator(input.lastModified),
      cachedAt,
      expiresAtMs: input.expiresAtMs,
      bodyBytes,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "INSERT INTO cache_entries(cache_key,url,html,html_sha256,etag,last_modified," +
        "cached_at,expires_at_ms,body_bytes,last_accessed_ms) VALUES(?,?,?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(cache_key) DO UPDATE SET url=excluded.url,html=excluded.html," +
        "html_sha256=excluded.html_sha256,etag=excluded.etag," +
        "last_modified=excluded.last_modified,cached_at=excluded.cached_at," +
        "expires_at_ms=excluded.expires_at_ms,body_bytes=excluded.body_bytes," +
        "last_accessed_ms=excluded.last_accessed_ms",
      ).run(
        entry.cacheKey, entry.url, entry.html, entry.htmlSha256,
        entry.etag, entry.lastModified, entry.cachedAt, entry.expiresAtMs,
        entry.bodyBytes, Date.now(),
      );
      this.pruneExpiredCache();
      while (true) {
        const stats = this.db.prepare(
          "SELECT COUNT(*) AS entries,COALESCE(SUM(body_bytes),0) AS bytes FROM cache_entries",
        ).get() as unknown as { entries: number; bytes: number };
        if (stats.entries <= this.maxCacheEntries && stats.bytes <= this.maxCacheBytes) break;
        this.db.exec(
          "DELETE FROM cache_entries WHERE cache_key=" +
          "(SELECT cache_key FROM cache_entries ORDER BY last_accessed_ms ASC,cached_at ASC LIMIT 1)",
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return entry;
  }

  getCache(cacheKey: string): StoredCacheEntry | null {
    const row = this.db.prepare(
      "SELECT * FROM cache_entries WHERE cache_key=? AND expires_at_ms>?",
    ).get(cacheKey, Date.now()) as unknown as CacheRow | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE cache_entries SET last_accessed_ms=? WHERE cache_key=?")
      .run(Date.now(), cacheKey);
    return {
      cacheKey: row.cache_key,
      url: row.url,
      html: row.html,
      htmlSha256: row.html_sha256,
      etag: row.etag,
      lastModified: row.last_modified,
      cachedAt: row.cached_at,
      expiresAtMs: row.expires_at_ms,
      bodyBytes: row.body_bytes,
    };
  }

  pruneExpiredCache(): number {
    const result = this.db.prepare(
      "DELETE FROM cache_entries WHERE expires_at_ms<=?",
    ).run(Date.now());
    return Number(result.changes);
  }

  deleteJob(id: string): boolean {
    const result = this.db.prepare("DELETE FROM crawl_jobs WHERE id=?").run(id);
    return Number(result.changes) > 0;
  }
}
