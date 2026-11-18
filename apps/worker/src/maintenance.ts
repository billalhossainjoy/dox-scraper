import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SqliteCrawlStore } from "@dox-scraper/storage";

/**
 * Small, network-free maintenance worker. Crawl execution currently lives in
 * the API's single-process CrawlManager. This worker only prunes expired
 * persisted cache entries; it never runs or recovers crawls.
 */
export function pruneCache(store: Pick<SqliteCrawlStore, "pruneExpiredCache">): number {
  return store.pruneExpiredCache();
}

export function maintenanceInterval(raw: string | undefined): number {
  const value = raw ?? "60";
  if (!/^[1-9]\d*$/.test(value)) {
    throw new RangeError("DOX_WORKER_INTERVAL_SECONDS must be a positive integer");
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 3600) {
    throw new RangeError("DOX_WORKER_INTERVAL_SECONDS must be between 10 and 3600");
  }
  return seconds * 1000;
}

/** Atomic heartbeat for a Docker HEALTHCHECK with no HTTP listener. */
export function writeHeartbeat(path: string, now = Date.now()): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Invalid heartbeat timestamp");
  const temporary = path + ".tmp";
  writeFileSync(temporary, String(now), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

/** Fail if maintenance stopped or the heartbeat file is absent/invalid. */
export function healthyHeartbeat(
  path: string,
  maxAgeMs: number,
  now = Date.now(),
): boolean {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!/^\d+$/.test(raw)) return false;
    const timestamp = Number(raw);
    return Number.isSafeInteger(timestamp) && timestamp <= now &&
      now - timestamp <= maxAgeMs;
  } catch {
    return false;
  }
}
