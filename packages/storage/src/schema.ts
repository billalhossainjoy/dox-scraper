import type { DatabaseSync } from "node:sqlite";

const LATEST_VERSION = 1;

/**
 * Apply versioned schema changes atomically. Never blindly downgrade an
 * existing database, and never allow partially applied migrations.
 */
export function migrate(db: DatabaseSync): number {
  const versionRow = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  const version = versionRow?.user_version ?? 0;
  if (version > LATEST_VERSION) {
    throw new Error(
      `SQLite schema version ${version} is newer than supported version ${LATEST_VERSION}`,
    );
  }
  if (version === LATEST_VERSION) return version;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (version < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS crawl_jobs (
          id TEXT PRIMARY KEY,
          seed_url TEXT NOT NULL,
          allowed_origin TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled')),
          started_at TEXT,
          finished_at TEXT,
          max_pages INTEGER NOT NULL CHECK (max_pages > 0),
          max_depth INTEGER NOT NULL CHECK (max_depth >= 0),
          attempted INTEGER NOT NULL DEFAULT 0,
          completed INTEGER NOT NULL DEFAULT 0,
          failed INTEGER NOT NULL DEFAULT 0,
          skipped INTEGER NOT NULL DEFAULT 0,
          cancelled INTEGER NOT NULL DEFAULT 0,
          queued INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 0,
          discovered INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS crawl_pages (
          job_id TEXT NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          url TEXT NOT NULL,
          depth INTEGER NOT NULL CHECK (depth >= 0),
          state TEXT NOT NULL CHECK (state IN
            ('queued','active','completed','failed','skipped','cancelled')),
          status_code INTEGER,
          discovered_links INTEGER,
          error TEXT,
          PRIMARY KEY (job_id, url),
          UNIQUE (job_id, ordinal)
        );

        CREATE TABLE IF NOT EXISTS page_results (
          job_id TEXT NOT NULL,
          url TEXT NOT NULL,
          markdown TEXT NOT NULL,
          content_text TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          markdown_sha256 TEXT NOT NULL,
          content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
          scraped_at TEXT NOT NULL,
          PRIMARY KEY (job_id, url),
          FOREIGN KEY (job_id, url)
            REFERENCES crawl_pages(job_id, url) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS cache_entries (
          cache_key TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          html TEXT NOT NULL,
          html_sha256 TEXT NOT NULL,
          etag TEXT,
          last_modified TEXT,
          cached_at TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          body_bytes INTEGER NOT NULL CHECK (body_bytes >= 0)
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_state_updated
          ON crawl_jobs(state, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pages_job_ordinal
          ON crawl_pages(job_id, ordinal);
        CREATE INDEX IF NOT EXISTS idx_cache_expiry
          ON cache_entries(expires_at_ms);

        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)")
        .run(1, new Date().toISOString());
      db.exec("PRAGMA user_version = 1");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return LATEST_VERSION;
}
