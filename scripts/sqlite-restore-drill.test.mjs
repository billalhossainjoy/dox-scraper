import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import {
  RESTORE_MARKER, RESTORE_MARKER_CONTENT, restoreDisposableSnapshot,
} from "./sqlite-restore-drill.mjs";

const directories = [];
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dox-restore-drill-"));
  directories.push(root);
  const live = join(root, "live.sqlite");
  const db = new DatabaseSync(live);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA user_version=2;
    CREATE TABLE crawl_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE crawl_pages (
      job_id TEXT REFERENCES crawl_jobs(id), url TEXT NOT NULL,
      PRIMARY KEY (job_id,url)
    );
    CREATE TABLE page_results (
      job_id TEXT NOT NULL, url TEXT NOT NULL, markdown TEXT NOT NULL,
      FOREIGN KEY(job_id,url) REFERENCES crawl_pages(job_id,url)
    );
    CREATE TABLE cache_entries (cache_key TEXT PRIMARY KEY);
    CREATE TABLE deployment_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO crawl_jobs (id,state) VALUES ('job-1','completed');
    INSERT INTO crawl_pages (job_id,url) VALUES ('job-1','https://example.com/');
    INSERT INTO page_results (job_id,url,markdown)
      VALUES ('job-1','https://example.com/','Older result');
    INSERT INTO deployment_probe (id,value) VALUES (1,'before-upgrade');
  `);
  const backups = join(root, "backups");
  const scratch = join(root, "disposable");
  mkdirSync(backups);
  mkdirSync(scratch);
  writeFileSync(join(scratch, RESTORE_MARKER), RESTORE_MARKER_CONTENT);
  return { root, live, db, backupPath: join(backups, "snapshot.sqlite"), scratch };
}

async function checksum(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function restoredMarker(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      probe: db.prepare("SELECT value FROM deployment_probe WHERE id=1").get()?.value,
      markdown: db.prepare("SELECT markdown FROM page_results WHERE job_id='job-1'").get()?.markdown,
      integrity: db.prepare("PRAGMA integrity_check").get()?.integrity_check,
    };
  } finally {
    db.close();
  }
}

test("rehearses rollback of a WAL snapshot into disposable storage without changing live data", async () => {
  const { live, db, backupPath, scratch } = setup();
  try {
    await backup(db, backupPath);
    const hash = await checksum(backupPath);
    db.prepare("UPDATE deployment_probe SET value='after-upgrade' WHERE id=1").run();
    db.prepare("UPDATE page_results SET markdown='Newer result' WHERE job_id='job-1'").run();

    const result = await restoreDisposableSnapshot({
      backupPath, targetDirectory: scratch, expectedSha256: hash,
    });
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.sha256, hash);
    assert.ok(result.bytes > 0);
    assert.deepEqual(restoredMarker(join(scratch, "dox.sqlite")), {
      probe: "before-upgrade",
      markdown: "Older result",
      integrity: "ok",
    });
    assert.equal(db.prepare("SELECT value FROM deployment_probe WHERE id=1").get().value, "after-upgrade");
    assert.equal(db.prepare("SELECT markdown FROM page_results WHERE job_id='job-1'").get().markdown, "Newer result");
    assert.ok(existsSync(live));
  } finally {
    db.close();
  }
});

test("rejects incorrect trusted checksum before writing to target", async () => {
  const { db, backupPath, scratch } = setup();
  try {
    await backup(db, backupPath);
    await assert.rejects(restoreDisposableSnapshot({
      backupPath, targetDirectory: scratch, expectedSha256: "0".repeat(64),
    }), /checksum/);
    assert.deepEqual(readdirSync(scratch), [RESTORE_MARKER]);
  } finally { db.close(); }
});

test("rejects target without valid disposable marker or with other existing files", async () => {
  const { db, backupPath, scratch } = setup();
  try {
    await backup(db, backupPath);
    const hash = await checksum(backupPath);
    rmSync(join(scratch, RESTORE_MARKER));
    await assert.rejects(restoreDisposableSnapshot({
      backupPath, targetDirectory: scratch, expectedSha256: hash,
    }), /marker/);
    writeFileSync(join(scratch, RESTORE_MARKER), "forged-marker");
    await assert.rejects(restoreDisposableSnapshot({
      backupPath, targetDirectory: scratch, expectedSha256: hash,
    }), /marker/);
    writeFileSync(join(scratch, RESTORE_MARKER), RESTORE_MARKER_CONTENT);
    writeFileSync(join(scratch, "dox.sqlite"), "protected-original");
    await assert.rejects(restoreDisposableSnapshot({
      backupPath, targetDirectory: scratch, expectedSha256: hash,
    }), /marker/);
    assert.equal(readFileSync(join(scratch, "dox.sqlite"), "utf8"), "protected-original");
  } finally { db.close(); }
});

test("rejects a symlinked backup and target directory", async () => {
  const { root, db, backupPath, scratch } = setup();
  try {
    await backup(db, backupPath);
    const hash = await checksum(backupPath);
    const linkedBackup = join(root, "backup-link.sqlite");
    symlinkSync(backupPath, linkedBackup);
    await assert.rejects(restoreDisposableSnapshot({
      backupPath: linkedBackup, targetDirectory: scratch, expectedSha256: hash,
    }), /regular file/);

    const linkedRoot = join(root, "restore-link");
    symlinkSync(scratch, linkedRoot, "dir");
    await assert.rejects(restoreDisposableSnapshot({
      backupPath, targetDirectory: linkedRoot, expectedSha256: hash,
    }), /real directory/);
  } finally { db.close(); }
});

test("rejects untrusted or malformed SQLite files without leaving a restored file", async () => {
  const { db, backupPath, scratch } = setup();
  try {
    writeFileSync(backupPath, "not a sqlite database");
    const hash = await checksum(backupPath);
    await assert.rejects(restoreDisposableSnapshot({
      backupPath, targetDirectory: scratch, expectedSha256: hash,
    }));
    assert.deepEqual(readdirSync(scratch), [RESTORE_MARKER]);
  } finally { db.close(); }
});

test("does not allow restoring the source file inside the disposable destination", async () => {
  const { db, backupPath, scratch } = setup();
  try {
    await backup(db, backupPath);
    const hash = await checksum(backupPath);
    await assert.rejects(restoreDisposableSnapshot({
      backupPath, targetDirectory: "/data", expectedSha256: hash,
    }));
    await assert.rejects(restoreDisposableSnapshot({
      backupPath, targetDirectory: scratch, expectedSha256: "invalid-checksum",
    }), TypeError);
  } finally { db.close(); }
});
