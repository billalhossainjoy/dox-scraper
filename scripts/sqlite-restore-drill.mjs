/* global console, process */
import { createHash } from "node:crypto";
import {
  constants, copyFileSync, createReadStream, lstatSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const RESTORE_MARKER = ".dox-disposable-restore-volume";
export const RESTORE_MARKER_CONTENT = "DOX_SCRAPER_DISPOSABLE_RESTORE_V1\n";
const EXPECTED_TABLES = ["crawl_jobs", "crawl_pages", "page_results", "cache_entries"];

async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function verifyDoxDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("Restored SQLite integrity check failed");
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("Restored SQLite foreign keys are invalid");
    }
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    const tables = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all().map(({ name }) => name));
    if (!Number.isInteger(version) || version < 1 || version > 2 ||
        EXPECTED_TABLES.some((name) => !tables.has(name))) {
      throw new Error("Backup is not a supported Dox Scraper schema");
    }
    return { schemaVersion: version };
  } finally {
    db.close();
  }
}

/**
 * Copy a verified, operator-supplied backup into a *fresh*, explicitly marked
 * disposable restore volume. This is NOT a production restore command.
 *
 * It refuses nonempty directories, symlinks, existing SQLite files, and
 * backup hashes that differ from the trusted expected SHA-256.
 */
export async function restoreDisposableSnapshot({
  backupPath, targetDirectory, expectedSha256,
}) {
  if (typeof backupPath !== "string" || typeof targetDirectory !== "string" ||
      !backupPath.trim() || !targetDirectory.trim() ||
      typeof expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new TypeError("A backup, disposable target and trusted SHA-256 are required");
  }

  const source = resolve(backupPath);
  const root = resolve(targetDirectory);
  const sourceInfo = lstatSync(source);
  const rootInfo = lstatSync(root);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() ||
      !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Backup must be a regular file and target must be a real directory");
  }
  if (source === root || source.startsWith(root + sep) ||
      root.startsWith(source + sep) || root === "/" || root === "/data" ||
      realpathSync(root) !== root) {
    throw new Error("Refusing unsafe or overlapping restore paths");
  }

  const names = readdirSync(root);
  if (names.length !== 1 || names[0] !== RESTORE_MARKER) {
    throw new Error("Disposable target must contain only the restore-drill marker");
  }
  const marker = join(root, RESTORE_MARKER);
  const markerInfo = lstatSync(marker);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() ||
      readFileSync(marker, "utf8") !== RESTORE_MARKER_CONTENT) {
    throw new Error("Missing or invalid disposable restore marker");
  }
  const originalHash = await sha256File(source);
  if (originalHash !== expectedSha256) {
    throw new Error("Backup checksum does not match trusted SHA-256");
  }
  // A trusted checksum authenticates the read-only source bytes.
  // WAL-mode backups may require SQLite to create -shm while opening;
  // do not open SQL on the read-only backup mount. Instead verify
  // integrity/schema only after copying to a writable disposable volume.
  const destination = join(root, "dox.sqlite");
  let copied = false;
  try {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    copied = true;
    if ((await sha256File(destination)) !== originalHash) {
      throw new Error("Restored file checksum mismatch");
    }
    const restored = verifyDoxDatabase(destination);
    return {
      schemaVersion: restored.schemaVersion,
      sha256: originalHash,
      bytes: statSync(destination).size,
      // No production path is emitted to tool output.
    };
  } catch (error) {
    if (copied) {
      rmSync(destination, { force: true });
      rmSync(destination + "-wal", { force: true });
      rmSync(destination + "-shm", { force: true });
    }
    throw error;
  }
}

function parseCli(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const value = args[++i];
    if (!value || !["--backup", "--target-dir", "--sha256"].includes(key) ||
        Object.hasOwn(options, key)) {
      throw new TypeError("Usage: node sqlite-restore-drill.mjs --backup /backups/file.sqlite --target-dir /restore-drill --sha256 SHA256");
    }
    options[key] = value;
  }
  if (options["--target-dir"] !== "/restore-drill") {
    throw new Error("CLI restore drills are restricted to /restore-drill, never /data");
  }
  return {
    backupPath: options["--backup"],
    targetDirectory: options["--target-dir"],
    expectedSha256: options["--sha256"],
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  (async () => {
    const result = await restoreDisposableSnapshot(parseCli(process.argv.slice(2)));
    console.log("Disposable SQLite restore verified", result);
  })().catch((error) => {
    // Only print strictly allowlisted, constant error strings or safe
    // Node/SQLite error CODES. Never print filesystem paths or SQL values.
    const known = new Set([
      "Refusing unsafe or overlapping restore paths",
      "Disposable target must contain only the restore-drill marker",
      "Missing or invalid disposable restore marker",
      "Backup checksum does not match trusted SHA-256",
      "Backup is not a supported Dox Scraper schema",
      "Restored SQLite integrity check failed",
      "Restored SQLite foreign keys are invalid",
      "Restored file checksum mismatch",
      "Backup must be a regular file and target must be a real directory",
    ]);
    const detail = known.has(error?.message) ? error.message
      : typeof error?.code === "string" && /^[A-Z_]{3,48}$/.test(error.code)
        ? error.code : "INVALID_BACKUP_OR_TARGET";
    console.error("Restore drill failed:", detail);
    process.exitCode = 1;
  });
}
