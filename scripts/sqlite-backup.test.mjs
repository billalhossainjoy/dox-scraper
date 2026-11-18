import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { createVerifiedBackup } from "./sqlite-backup.mjs";

const temp = [];
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dox-backup-test-"));
  temp.push(dir);
  const source = join(dir, "dox.sqlite");
  const db = new DatabaseSync(source);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA user_version=2;
    CREATE TABLE crawl_jobs (id TEXT PRIMARY KEY, seed_url TEXT NOT NULL);
    CREATE TABLE crawl_pages (
      job_id TEXT NOT NULL REFERENCES crawl_jobs(id),
      url TEXT NOT NULL,
      PRIMARY KEY (job_id, url)
    );
    CREATE TABLE page_results (
      job_id TEXT NOT NULL,
      url TEXT NOT NULL,
      markdown TEXT NOT NULL,
      FOREIGN KEY (job_id, url) REFERENCES crawl_pages(job_id, url)
    );
    CREATE TABLE cache_entries (cache_key TEXT PRIMARY KEY, html TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO crawl_jobs(id,seed_url) VALUES (?,?)")
    .run("job-1", "https://example.com");
  db.prepare("INSERT INTO crawl_pages(job_id,url) VALUES (?,?)")
    .run("job-1", "https://example.com");
  db.prepare("INSERT INTO page_results(job_id,url,markdown) VALUES (?,?,?)")
    .run("job-1", "https://example.com", "Content from WAL");
  return { dir, source, db, destination: join(dir, "backups", "sample.sqlite") };
}

test("creates a consistent backup with uncheckpointed WAL content and verified restore", async () => {
  const { dir, source, db } = fixture();
  const backupDir = join(dir, "backups");
  // Destination parent must be operator-created, never implicitly written.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(backupDir);
  const destination = join(backupDir, "snapshot.sqlite");

  try {
    const result = await createVerifiedBackup(source, destination);
    assert.equal(result.destination, destination);
    assert.equal(result.schemaVersion, 2);
    assert.ok(result.bytes > 0);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(lstatSync(destination).mode & 0o777, 0o600);

    const restored = new DatabaseSync(destination, { readOnly: true });
    try {
      assert.equal(
        restored.prepare("SELECT markdown FROM page_results WHERE job_id=?").get("job-1").markdown,
        "Content from WAL",
      );
      assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(restored.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    } finally {
      restored.close();
    }
    // Never stop or modify the live DB during the backup.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM crawl_jobs").get().n, 1);
    assert.equal(readFileSync(destination).subarray(0, 16).toString(), "SQLite format 3\0");
  } finally {
    db.close();
  }
});

test("never overwrites an existing backup, even a zero-byte file", async () => {
  const { dir, source, db } = fixture();
  const destination = join(dir, "previous.sqlite");
  writeFileSync(destination, "protected backup");
  try {
    await assert.rejects(
      createVerifiedBackup(source, destination),
      /already exists/,
    );
    assert.equal(readFileSync(destination, "utf8"), "protected backup");
  } finally {
    db.close();
  }
});

test("refuses live source path and invalid source database without publishing output", async () => {
  const { dir, source, db } = fixture();
  const destination = join(dir, "corrupt.sqlite");
  try {
    await assert.rejects(createVerifiedBackup(source, source), /must differ/);
    await assert.rejects(createVerifiedBackup(join(dir, "missing.sqlite"), destination));
    assert.equal(existsSync(destination), false);
  } finally {
    db.close();
  }
});

test("rejects a source without expected Dox schema and removes scratch files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dox-backup-invalid-"));
  temp.push(dir);
  const source = join(dir, "invalid.sqlite");
  const destination = join(dir, "backup.sqlite");
  const db = new DatabaseSync(source);
  try {
    db.exec("CREATE TABLE unrecognized (value BLOB)");
    db.prepare("INSERT INTO unrecognized(value) VALUES (?)").run(randomBytes(100));
  } finally {
    db.close();
  }
  await assert.rejects(createVerifiedBackup(source, destination), /not a supported Dox/);
  assert.equal(existsSync(destination), false);
  assert.equal((await import("node:fs")).readdirSync(dir).filter((x) => x.startsWith(".dox-backup-")).length, 0);
});

test("rejects destination in an absent directory without creating anything", async () => {
  const { dir, source, db } = fixture();
  try {
    await assert.rejects(createVerifiedBackup(source, join(dir, "missing", "x.sqlite")));
    assert.equal(existsSync(join(dir, "missing")), false);
  } finally { db.close(); }
});
