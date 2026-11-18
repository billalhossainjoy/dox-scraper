import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCrawlStore } from "@dox-scraper/storage";
import {
  healthyHeartbeat, maintenanceInterval, pruneCache, writeHeartbeat,
} from "./maintenance.js";

const folders: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("network-free maintenance worker", () => {
  it("prunes expired cached HTML but retains live cache entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    const store = new SqliteCrawlStore({ path: ":memory:" });
    const now = Date.now();
    store.saveCache({
      cacheKey: "soon", url: "https://example.com/soon",
      html: "<html>Soon</html>", expiresAtMs: now + 1000,
    });
    store.saveCache({
      cacheKey: "later", url: "https://example.com/later",
      html: "<html>Later</html>", expiresAtMs: now + 50000,
    });
    vi.setSystemTime(new Date(now + 2000));
    expect(pruneCache(store)).toBe(1);
    expect(store.getCache("soon")).toBeNull();
    expect(store.getCache("later")?.html).toBe("<html>Later</html>");
    expect(pruneCache(store)).toBe(0);
    store.close();
  });

  it("rejects unsafe maintenance intervals", () => {
    expect(maintenanceInterval(undefined)).toBe(60_000);
    expect(maintenanceInterval("10")).toBe(10_000);
    expect(maintenanceInterval("3600")).toBe(3600000);
    for (const invalid of ["", "0", "1", "9", "-1", "10.5", "3601", "1e3", "abc"]) {
      expect(() => maintenanceInterval(invalid)).toThrow(RangeError);
    }
  });

  it("maintains a timestamped heartbeat with stale-file detection", () => {
    const folder = mkdtempSync(join(tmpdir(), "dox-worker-"));
    folders.push(folder);
    const filename = join(folder, "heartbeat");
    const timestamp = 1_700_000_000_000;
    expect(healthyHeartbeat(filename, 30000, timestamp)).toBe(false);
    writeHeartbeat(filename, timestamp);
    expect(healthyHeartbeat(filename, 30000, timestamp)).toBe(true);
    expect(healthyHeartbeat(filename, 30000, timestamp + 29999)).toBe(true);
    expect(healthyHeartbeat(filename, 30000, timestamp + 30001)).toBe(false);
    expect(healthyHeartbeat(filename, 30000, timestamp - 1)).toBe(false);
  });
});
