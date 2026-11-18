import { healthyHeartbeat, maintenanceInterval } from "./maintenance.js";

const path = process.env.DOX_WORKER_HEARTBEAT ?? "/tmp/dox-worker.heartbeat";

try {
  const interval = maintenanceInterval(process.env.DOX_WORKER_INTERVAL_SECONDS);
  if (!healthyHeartbeat(path, Math.max(15_000, interval * 3))) {
    console.error("Worker heartbeat is missing or stale");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid worker health configuration");
  process.exitCode = 1;
}
