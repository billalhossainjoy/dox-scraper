import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePiDeployment } from "./pi-preflight.mjs";

function container({ api = false, volume = "dox-scraper_dox_data" } = {}) {
  const memory = api ? 768 * 1024 * 1024 : 192 * 1024 * 1024;
  return {
    state: { Running: true, Health: { Status: "healthy" } },
    host: {
      ReadonlyRootfs: true, CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"], Privileged: false,
      Memory: memory, NanoCpus: api ? 1_000_000_000 : 250_000_000,
      NetworkMode: api ? "dox-scraper_default" : "none",
    },
    user: "node",
    mounts: [{
      Type: "volume", Name: volume, Destination: "/data", RW: true,
    }],
    ports: api
      ? { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3000" }] }
      : {},
  };
}

function fixture() {
  return {
    platform: "linux",
    arch: "arm64",
    compose: {
      services: {
        api: {
          image: "dox-scraper-api:local",
          ports: [{
            host_ip: "127.0.0.1", published: "3000", target: 3000, protocol: "tcp",
          }],
          volumes: [{ type: "volume", source: "dox_data", target: "/data" }],
          cap_drop: ["ALL"],
          security_opt: ["no-new-privileges:true"],
          read_only: true,
          environment: {
            DOX_ENABLE_BROWSER_RENDERING: "false",
            DOX_SCRAPER_API_KEY: "sensitive-test-key-value",
          },
        },
        worker: {
          image: "dox-scraper-worker:local",
          network_mode: "none", ports: [],
          volumes: [{ type: "volume", source: "dox_data", target: "/data" }],
          cap_drop: ["ALL"],
          security_opt: ["no-new-privileges:true"],
          read_only: true,
        },
      },
    },
    api: container({ api: true }),
    worker: container(),
    apiImageArch: "arm64",
    workerImageArch: "arm64",
    localHealth: true,
    unauthenticatedStatus: 401,
  };
}

function get(result, id) {
  const item = result.items.find((entry) => entry.id === id);
  assert.ok(item, "expected " + id);
  return item;
}

test("healthy Pi deployment produces 13 PASS checks plus a Cloudflare warning", () => {
  const facts = fixture();
  const result = evaluatePiDeployment(facts);
  assert.equal(result.failed, 0);
  assert.equal(result.passed, 13);
  assert.equal(result.warnings, 1);
  assert.equal(get(result, "cloudflare-live-policy").status, "WARN");
  assert.equal(JSON.stringify(result).includes("sensitive-test-key-value"), false);
  assert.equal(JSON.stringify(result).includes("dox-scraper_dox_data"), false);
});

test("rejects a non-ARM64 host or non-ARM64 deployed image", () => {
  const facts = fixture();
  facts.arch = "x64";
  facts.workerImageArch = "amd64";
  const result = evaluatePiDeployment(facts);
  assert.equal(get(result, "host-architecture").status, "FAIL");
  assert.equal(get(result, "image-architecture").status, "FAIL");
});

test("rejects Compose API published on a LAN/public interface", () => {
  const facts = fixture();
  facts.compose.services.api.ports[0].host_ip = "0.0.0.0";
  assert.equal(get(evaluatePiDeployment(facts), "compose-loopback").status, "FAIL");
  facts.compose.services.api.ports[0].host_ip = "127.0.0.1";
  facts.api.ports["3000/tcp"][0].HostIp = "0.0.0.0";
  assert.equal(get(evaluatePiDeployment(facts), "container-network").status, "FAIL");
});

test("detects exposed worker ports and worker network access", () => {
  const facts = fixture();
  facts.compose.services.worker.network_mode = "bridge";
  facts.compose.services.worker.ports = [{ published: "9000", target: 9000 }];
  facts.worker.ports = { "9000/tcp": [{ HostIp: "0.0.0.0", HostPort: "9000" }] };
  facts.worker.host.NetworkMode = "bridge";
  const result = evaluatePiDeployment(facts);
  assert.equal(get(result, "compose-worker-isolation").status, "FAIL");
  assert.equal(get(result, "container-network").status, "FAIL");
});

test("fails for unhealthy or stopped worker without starting or restarting it", () => {
  const facts = fixture();
  facts.worker.state.Health.Status = "unhealthy";
  assert.equal(get(evaluatePiDeployment(facts), "container-health").status, "FAIL");
  facts.worker.state.Running = false;
  assert.equal(get(evaluatePiDeployment(facts), "container-health").status, "FAIL");
});

test("rejects different or read-only SQLite data mounts", () => {
  const facts = fixture();
  facts.worker.mounts[0].Name = "another_volume";
  assert.equal(get(evaluatePiDeployment(facts), "shared-sqlite-volume").status, "FAIL");
  facts.worker.mounts[0].Name = "dox-scraper_dox_data";
  facts.worker.mounts[0].RW = false;
  assert.equal(get(evaluatePiDeployment(facts), "shared-sqlite-volume").status, "FAIL");
});

test("rejects privileged, root, writable filesystem and unlimited resources", () => {
  const facts = fixture();
  facts.api.user = "root";
  facts.worker.host.ReadonlyRootfs = false;
  facts.api.host.Memory = 0;
  facts.worker.host.NanoCpus = 0;
  facts.api.host.Privileged = true;
  assert.equal(get(evaluatePiDeployment(facts), "container-hardening").status, "FAIL");
  facts.compose.services.api.read_only = false;
  assert.equal(get(evaluatePiDeployment(facts), "compose-container-hardening").status, "FAIL");
});

test("rejects Chromium enabled or missing bearer isolation", () => {
  const facts = fixture();
  facts.compose.services.api.environment.DOX_ENABLE_BROWSER_RENDERING = "true";
  facts.unauthenticatedStatus = 200;
  facts.localHealth = false;
  const result = evaluatePiDeployment(facts);
  assert.equal(get(result, "compose-browser-disabled").status, "FAIL");
  assert.equal(get(result, "bearer-isolation").status, "FAIL");
  assert.equal(get(result, "local-health").status, "FAIL");
});

test("missing or malformed Docker inspection data fails closed without throwing", () => {
  const result = evaluatePiDeployment({ platform: "linux", arch: "arm64" });
  assert.ok(result.failed >= 9);
  assert.equal(result.items.some((item) => item.status === "PASS" &&
    item.id === "shared-sqlite-volume"), false);
});
