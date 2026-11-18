import { SqliteCrawlStore } from "@dox-scraper/storage";
import { maintenanceInterval, pruneCache, writeHeartbeat } from "./maintenance.js";

const path = process.env.DOX_CRAWL_DB_PATH ?? "/data/dox.sqlite";
const heartbeat = process.env.DOX_WORKER_HEARTBEAT ?? "/tmp/dox-worker.heartbeat";
const intervalMs = maintenanceInterval(process.env.DOX_WORKER_INTERVAL_SECONDS);

let store: SqliteCrawlStore | undefined;
let interval: NodeJS.Timeout | undefined;
let stopping = false;

function stop(): void {
  if (stopping) return;
  stopping = true;
  if (interval) clearInterval(interval);
  try { store?.close(); }
  catch (error) {
    console.error("Worker database shutdown failed:", error);
    process.exitCode = 1;
  }
}

function tick(): void {
  if (!store || stopping) return;
  try {
    const removed = pruneCache(store);
    writeHeartbeat(heartbeat);
    if (removed > 0) console.log("Maintenance removed expired cache entries:", removed);
  } catch (error) {
    console.error("Maintenance failed; stopping for container restart:", error);
    process.exitCode = 1;
    stop();
  }
}

try {
  store = new SqliteCrawlStore({ path });
  tick();
  if (!stopping) interval = setInterval(tick, intervalMs);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (error) {
  console.error("Dox maintenance worker could not start:", error);
  process.exitCode = 1;
  stop();
}
