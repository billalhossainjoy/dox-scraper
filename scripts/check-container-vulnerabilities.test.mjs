import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { checkImageReports, summarizeImageScan } from "./check-container-vulnerabilities.mjs";

const roots = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function reports(api, worker = { Results: [] }) {
  const dir = mkdtempSync(join(tmpdir(), "dox-image-audit-"));
  roots.push(dir);
  const files = [join(dir, "api.json"), join(dir, "worker.json")];
  writeFileSync(files[0], JSON.stringify(api));
  writeFileSync(files[1], JSON.stringify(worker));
  return files;
}

test("reads genuine Trivy report shape and summarizes image vulnerability severity", () => {
  const scan = summarizeImageScan({
    SchemaVersion: 2,
    Results: [{
      Target: "private-image-name",
      Vulnerabilities: [
        { VulnerabilityID: "CVE-2026-12345", Severity: "HIGH", FixedVersion: "4.0" },
        { VulnerabilityID: "CVE-2026-12346", Severity: "CRITICAL", FixedVersion: "" },
        { VulnerabilityID: "CVE-2026-12347", Severity: "CRITICAL", FixedVersion: "4.1" },
      ],
    }],
  });
  assert.equal(scan.high, 1);
  assert.equal(scan.critical, 2);
  assert.equal(scan.fixableHigh, 1);
  assert.equal(scan.fixableCritical, 1);
  assert.deepEqual(scan.blockingIds, ["CVE-2026-12345", "CVE-2026-12346", "CVE-2026-12347"]);
});

test("allows unfixed HIGH advisories, with counts still visible", () => {
  const lines = [];
  assert.equal(checkImageReports(reports({
    Results: [{ Vulnerabilities: [
      { VulnerabilityID: "CVE-2026-12345", Severity: "HIGH" },
    ] }],
  }), (line) => lines.push(line)), true);
  assert.ok(lines[0].startsWith("API: 0 CRITICAL (0 with fixes); 1 HIGH (0 with fixes)."));
  assert.ok(lines[1].startsWith("Worker: 0 CRITICAL"));
});

test("blocks unfixed CRITICAL even when scanner reports no fixed version", () => {
  const lines = [];
  const inputs = reports({ Results: [{ Target: "secret-registry/image",
    Vulnerabilities: [
      { VulnerabilityID: "CVE-2026-12346", Severity: "CRITICAL", FixedVersion: "" },
    ] }] });
  assert.throws(() => checkImageReports(inputs, x => lines.push(x)),
    /CRITICAL or fixable HIGH/);
  assert.ok(lines.some(x => x.includes("CVE-2026-12346")));
  assert.ok(lines.every(x => !x.includes("secret-registry")));
});

test("blocks fixable CRITICAL CVEs without leaking image names or entire reports", () => {
  const lines = [];
  const files = reports({
    Results: [{
      Target: "very-private-image:tag",
      Vulnerabilities: [{ VulnerabilityID: "CVE-2026-12345",
        Severity: "CRITICAL", FixedVersion: "1.2.3", PkgName: "secret-package-name" }],
    }],
  });
  assert.throws(() => checkImageReports(files, (line) => lines.push(line)),
    /CRITICAL or fixable HIGH/);
  const output = lines.join("\n");
  assert.ok(output.includes("CVE-2026-12345"));
  assert.equal(output.includes("very-private-image"), false);
  assert.equal(output.includes("secret-package-name"), false);
});

test("blocks fixable HIGH advisories and logs only bounded sanitized advisory IDs", () => {
  const lines = [];
  const input = reports({
    Results: [{ Vulnerabilities: [{
      VulnerabilityID: "CVE-2026-54321", Severity: "HIGH",
      FixedVersion: "6.28.4", PkgName: "private-high-package",
    }] }],
  });
  assert.throws(() => checkImageReports(input, (line) => lines.push(line)),
    /CRITICAL or fixable HIGH/);
  assert.ok(lines.some((line) => line.includes("CVE-2026-54321")));
  assert.ok(lines.every((line) => !line.includes("private-high-package")));
});

test("fails closed on a missing/malformed report or unexpected vulnerability structure", () => {
  const dir = mkdtempSync(join(tmpdir(), "dox-image-audit-invalid-"));
  roots.push(dir);
  const missing = join(dir, "missing.json");
  const good = join(dir, "ok.json");
  writeFileSync(good, '{"Results":[]}');
  assert.throws(() => checkImageReports([missing, good], () => {}), /missing or invalid/);
  writeFileSync(missing, "not JSON");
  assert.throws(() => checkImageReports([missing, good], () => {}), /missing or invalid/);
  writeFileSync(missing, '{"Results":[{"Vulnerabilities":"wrong"}]}');
  assert.throws(() => checkImageReports([missing, good], () => {}), /missing or invalid/);
  assert.throws(() => checkImageReports([good], () => {}), /both/);
});

test("caps printed identifiers, ignoring malicious or untrusted ID formatting", () => {
  const scan = summarizeImageScan({
    Results: [{
      Vulnerabilities: Array.from({ length: 30 }, (_, i) => ({
        Severity: "CRITICAL",
        FixedVersion: "fixed",
        VulnerabilityID: "CVE-2026-" + (10000 + i),
      })),
    }],
  });
  assert.equal(scan.fixableCritical, 30);
  assert.equal(scan.blockingIds.length, 20);
});
