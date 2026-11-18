import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, createReadStream, existsSync, linkSync,
  lstatSync, mkdtempSync, realpathSync, rmSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";

/**
 * Creates a consistent SQLite backup while writers can use WAL mode.
 * Never copies a live main SQLite file or sidecars directly.
 *
 * The target is published only after its database integrity and isolated
 * restore tests pass. Hard linking publishes atomically without replacing
 * an existing file (including a symlink).
 */
function validateDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const result = db.prepare("PRAGMA integrity_check").all();
    if (result.length !== 1 || result[0]?.integrity_check !== "ok") {
      throw new Error("SQLite integrity_check failed");
    }
    const problems = db.prepare("PRAGMA foreign_key_check").all();
    if (problems.length !== 0) {
      throw new Error("SQLite foreign key validation failed");
    }
    const { user_version } = db.prepare("PRAGMA user_version").get();
    const required = ["crawl_jobs", "crawl_pages", "page_results", "cache_entries"];
    const names = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all().map(({ name }) => name));
    if (user_version < 1 || required.some((name) => !names.has(name))) {
      throw new Error("Backup is not a supported Dox Scraper database");
    }
    return { schemaVersion: user_version };
  } finally {
    db.close();
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function createVerifiedBackup(sourcePath, destinationPath) {
  if (typeof sourcePath !== "string" || typeof destinationPath !== "string" ||
      !sourcePath.trim() || !destinationPath.trim() ||
      sourcePath.includes("\0") || destinationPath.includes("\0")) {
    throw new TypeError("A source SQLite path and a destination backup file are required");
  }
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (source === destination) {
    throw new Error("Backup destination must differ from the live database");
  }
  const sourceInfo = lstatSync(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error("Source must be a real SQLite database file, not a symlink");
  }
  const parent = realpathSync(dirname(destination));
  if (!statSync(parent).isDirectory()) throw new Error("Backup destination parent is not a directory");
  if (existsSync(destination)) throw new Error("Backup destination already exists");
  // Also reject dangling symlink destinations, which existsSync misses.
  try {
    lstatSync(destination);
    throw new Error("Backup destination already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  // No prefix/base path tricks; resolving target within the actual parent
  // prevents accidentally writing through a symlink directory.
  if (join(parent, basename(destination)) !== destination) {
    throw new Error("Backup destination must use a real parent directory");
  }

  const scratch = mkdtempSync(join(parent, ".dox-backup-"));
  const candidate = join(scratch, "backup.sqlite");
  const restore = join(scratch, "restored.sqlite");
  let sourceDb;
  try {
    sourceDb = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
    await backup(sourceDb, candidate);
    sourceDb.close();
    sourceDb = undefined;
    chmodSync(candidate, 0o600);

    const verified = validateDatabase(candidate);
    // Dry-run restoration into a DIFFERENT file, never the live source.
    copyFileSync(candidate, restore);
    const restored = validateDatabase(restore);
    if (verified.schemaVersion !== restored.schemaVersion ||
        (await sha256File(candidate)) !== (await sha256File(restore))) {
      throw new Error("Isolated SQLite restore verification failed");
    }

    // Atomic no-clobber publication; the temporary candidate and final
    // file are on the same filesystem and cannot overwrite a prior backup.
    linkSync(candidate, destination);
    return {
      destination,
      schemaVersion: verified.schemaVersion,
      bytes: statSync(destination).size,
      sha256: await sha256File(destination),
    };
  } finally {
    sourceDb?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

function cliOptions(args) {
  let source;
  let destination;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--source" && args[i + 1]) source = args[++i];
    else if (args[i] === "--destination" && args[i + 1]) destination = args[++i];
    else throw new TypeError("Usage: node sqlite-backup.mjs --source /data/dox.sqlite --destination /backups/dox-YYYYMMDD.sqlite");
  }
  if (!source || !destination) throw new TypeError("Both --source and --destination are required");
  return { source, destination };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  (async () => {
    const { source, destination } = cliOptions(process.argv.slice(2));
    const result = await createVerifiedBackup(source, destination);
    console.log("Verified SQLite backup created", {
      schemaVersion: result.schemaVersion,
      bytes: result.bytes,
      sha256: result.sha256,
    });
  })().catch((error) => {
    console.error("SQLite backup failed:", error instanceof Error ? error.message : "Unexpected error");
    process.exitCode = 1;
  });
}
