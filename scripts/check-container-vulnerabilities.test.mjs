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
  assert.deepEqual(scan.blockingIds, ["CVE-2026-12347"]);
});

test("allows zero/fix-unavailable findings but surfaces both HIGH and CRITICAL totals", () => {
  const lines = [];
  assert.equal(checkImageReports(reports({
    Results: [{ Vulnerabilities: [
      { VulnerabilityID: "CVE-2026-12345", Severity: "HIGH", FixedVersion: "v2" },
      { VulnerabilityID: "CVE-2026-12346", Severity: "CRITICAL" },
    ] }],
  }), (line) => lines.push(line)), true);
  assert.ok(lines[0].startsWith("API: 1 CRITICAL (0 with fixes); 1 HIGH (1 with fixes)."));
  assert.ok(lines[1].startsWith("Worker: 0 CRITICAL"));
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
    /Actionable CRITICAL/);
  const output = lines.join("\n");
  assert.ok(output.includes("CVE-2026-12345"));
  assert.equal(output.includes("very-private-image"), false);
  assert.equal(output.includes("secret-package-name"), false);
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
