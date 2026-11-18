/* global process, console, fetch, AbortSignal */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API_PORT = "3000/tcp";
const MAX_API_BYTES = 1024 * 1024 * 1024;
const MAX_WORKER_BYTES = 256 * 1024 * 1024;

function check(id, ok, failure) {
  return { id, status: ok ? "PASS" : "FAIL", ...(!ok ? { reason: failure } : {}) };
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function secureSettings(service) {
  return service?.read_only === true &&
    safeArray(service?.cap_drop).some((item) => item.toUpperCase() === "ALL") &&
    safeArray(service?.security_opt).some((item) =>
      String(item).startsWith("no-new-privileges:") &&
      String(item).endsWith("true"));
}

function nonRootUser(user) {
  return typeof user === "string" &&
    (user === "node" || user === "1000" || user === "1000:1000");
}

function publishedPort(config) {
  const ports = safeArray(config?.services?.api?.ports);
  if (ports.length !== 1) return null;
  const entry = ports[0];
  if (entry?.host_ip !== "127.0.0.1" ||
      String(entry.target) !== "3000" ||
      !/^[1-9][0-9]{0,4}$/.test(String(entry.published)) ||
      Number(entry.published) > 65535) return null;
  return Number(entry.published);
}

function runtimePortsSafe(ports, isApi) {
  const entries = Object.entries(safeObject(ports)).filter(([, bindings]) =>
    Array.isArray(bindings) && bindings.length > 0);
  if (!isApi) return entries.length === 0;
  if (entries.length !== 1 || entries[0]?.[0] !== API_PORT) return false;
  const bindings = entries[0][1];
  return bindings.length === 1 &&
    bindings[0]?.HostIp === "127.0.0.1" &&
    /^[1-9][0-9]{0,4}$/.test(String(bindings[0]?.HostPort));
}

function volumeName(container) {
  const mounts = safeArray(container?.mounts);
  const data = mounts.filter((mount) => mount.Destination === "/data");
  if (data.length !== 1 || data[0].Type !== "volume" ||
      data[0].RW !== true || !data[0].Name) return null;
  return data[0].Name;
}

function runtimeSecure(container, memoryMax, cpuMax) {
  const host = safeObject(container?.host);
  const memory = host.Memory;
  const nanoCpus = host.NanoCpus;
  return host.ReadonlyRootfs === true &&
    nonRootUser(container?.user) &&
    safeArray(host.CapDrop).some((value) => value.toUpperCase() === "ALL") &&
    safeArray(host.SecurityOpt).some((value) => String(value).startsWith("no-new-privileges")) &&
    Number.isSafeInteger(memory) && memory > 0 && memory <= memoryMax &&
    Number.isSafeInteger(nanoCpus) && nanoCpus > 0 && nanoCpus <= cpuMax &&
    host.Privileged === false;
}

function runningHealthy(container) {
  return container?.state?.Running === true &&
    container.state?.Health?.Status === "healthy";
}

/**
 * Pure, fully testable diagnostics. Never includes raw docker output,
 * container environment, target URLs, passwords or secret-bearing values.
 */
export function evaluatePiDeployment(facts) {
  const items = [];
  const add = (id, condition, message) => items.push(check(id, condition, message));
  add("host-architecture", facts.platform === "linux" && facts.arch === "arm64",
    "Run on a 64-bit Linux ARM64 Raspberry Pi host.");

  const config = safeObject(facts.compose);
  const api = config.services?.api;
  const worker = config.services?.worker;
  const port = publishedPort(config);
  add("compose-loopback", port !== null,
    "API must publish one TCP port to 127.0.0.1 only.");
  add("compose-worker-isolation",
    worker?.network_mode === "none" && safeArray(worker?.ports).length === 0,
    "Worker must have network_mode none and no published ports.");
  add("compose-container-hardening", secureSettings(api) && secureSettings(worker),
    "Both services must be read-only, drop capabilities and forbid privilege escalation.");
  add("compose-browser-disabled", api?.environment?.DOX_ENABLE_BROWSER_RENDERING === "false",
    "Browser execution must be disabled in the non-isolated API.");
  add("compose-storage-volume",
    safeArray(api?.volumes).some((mount) => mount?.target === "/data" && !mount?.read_only) &&
    safeArray(worker?.volumes).some((mount) => mount?.target === "/data" && !mount?.read_only),
    "Both services must mount a writable /data volume.");

  add("container-health", runningHealthy(facts.api) && runningHealthy(facts.worker),
    "API and maintenance worker must both be running and healthy.");
  add("container-hardening",
    runtimeSecure(facts.api, MAX_API_BYTES, 1_000_000_000) &&
    runtimeSecure(facts.worker, MAX_WORKER_BYTES, 250_000_000),
    "Runtime containers must be non-root, read-only, restricted and resource-limited.");
  add("container-network",
    runtimePortsSafe(facts.api?.ports, true) &&
    runtimePortsSafe(facts.worker?.ports, false) &&
    facts.worker?.host?.NetworkMode === "none",
    "API must publish only loopback port 3000; worker must be network-isolated.");
  const apiVolume = volumeName(facts.api);
  const workerVolume = volumeName(facts.worker);
  add("shared-sqlite-volume", !!apiVolume && apiVolume === workerVolume,
    "Both containers must share one writable named SQLite volume.");
  add("image-architecture", facts.apiImageArch === "arm64" &&
    facts.workerImageArch === "arm64",
    "Both deployed images must be linux/arm64 (not emulated amd64).");
  add("local-health", facts.localHealth === true,
    "The local API /health endpoint must return the Dox Scraper health JSON.");
  add("bearer-isolation", facts.unauthenticatedStatus === 401,
    "An unauthenticated local scrape request must return HTTP 401.");

  items.push({
    id: "cloudflare-live-policy",
    status: "WARN",
    reason: "Cloudflare Access and Tunnel are not inspected. Run the separate dual-auth live verification.",
  });
  return {
    items,
    passed: items.filter((item) => item.status === "PASS").length,
    failed: items.filter((item) => item.status === "FAIL").length,
    warnings: items.filter((item) => item.status === "WARN").length,
  };
}

function docker(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 12000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    // Never print command output: Compose config and inspect responses
    // can include user secrets and private filesystem paths.
    throw new Error("Docker command unavailable or returned an error");
  }
  return result.stdout.trim();
}

function jsonDocker(args) {
  try { return JSON.parse(docker(args)); }
  catch { throw new Error("Docker returned an unavailable or malformed JSON response"); }
}

function containerId(service) {
  const ids = docker(["compose", "ps", "-q", service]).split(/\s+/).filter(Boolean);
  if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/.test(ids[0])) {
    throw new Error("Expected exactly one existing container per service");
  }
  return ids[0];
}

function inspect(id) {
  // Exact fixed-field template avoids retrieving or logging Config.Env.
  return jsonDocker(["inspect", "--format",
    '{"state":{{json .State}},"host":{{json .HostConfig}},"mounts":{{json .Mounts}},"user":{{json .Config.User}},"ports":{{json .NetworkSettings.Ports}}}',
    id]);
}

async function localHttp(url, options = {}) {
  try {
    const response = await fetch(url, {
      ...options, redirect: "manual", signal: AbortSignal.timeout(3500),
    });
    return response;
  } catch {
    return null;
  }
}

export async function collectPiFacts() {
  const compose = jsonDocker(["compose", "config", "--format", "json"]);
  const apiId = containerId("api");
  const workerId = containerId("worker");
  const api = inspect(apiId);
  const worker = inspect(workerId);
  const apiImageArch = docker([
    "image", "inspect", "--format", "{{.Architecture}}",
    compose.services?.api?.image ?? "dox-scraper-api:local",
  ]);
  const workerImageArch = docker([
    "image", "inspect", "--format", "{{.Architecture}}",
    compose.services?.worker?.image ?? "dox-scraper-worker:local",
  ]);
  const port = publishedPort(compose);
  let localHealth = false;
  let unauthenticatedStatus = null;
  if (port !== null) {
    const url = "http://127.0.0.1:" + port;
    const response = await localHttp(url + "/health");
    if (response?.status === 200) {
      try {
        const body = await response.json();
        localHealth = body?.status === "ok" && body?.service === "dox-scraper-api";
      } catch { /* no secret-bearing body logged */ }
    }
    const unauthenticated = await localHttp(url + "/v1/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    unauthenticatedStatus = unauthenticated?.status ?? null;
  }

  return {
    platform: process.platform,
    arch: process.arch,
    compose, api, worker, apiImageArch, workerImageArch,
    localHealth, unauthenticatedStatus,
  };
}

export async function runPiPreflight(report = console.log) {
  let result;
  try {
    result = evaluatePiDeployment(await collectPiFacts());
  } catch {
    result = {
      items: [{ id: "deployment-inspection", status: "FAIL",
        reason: "Cannot inspect Docker Compose or running containers. Check Docker permissions and service health." }],
      passed: 0, failed: 1, warnings: 0,
    };
  }
  for (const item of result.items) {
    report(item.status + " " + item.id + (item.reason ? ": " + item.reason : ""));
  }
  report("Summary: " + result.passed + " passed, " + result.failed +
    " failed, " + result.warnings + " warning(s).");
  return result.failed === 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runPiPreflight().then((passed) => {
    if (!passed) process.exitCode = 1;
  }).catch(() => {
    console.error("Preflight failed to execute; no host details were printed.");
    process.exitCode = 1;
  });
}
