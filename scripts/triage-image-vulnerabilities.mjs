/* global console, process */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VALID_ID = /^(?:CVE-\d{4}-\d{4,}|GHSA-[A-Za-z0-9-]{9,})$/;
const VALID_PACKAGE = /^[A-Za-z0-9@._+/-]{1,90}$/;
const VALID_VERSION = /^[A-Za-z0-9:._+~^><=|,* -]{1,100}$/;
const MAX_ROWS = 24;

function safe(value, regex) {
  return typeof value === "string" && regex.test(value) ? value : "[redacted]";
}

/**
 * Public advisory facts only. Trivy image names, target paths, metadata,
 * descriptions, links, and complete reports are intentionally discarded.
 */
export function triageTrivyReport(report) {
  if (!report || !Array.isArray(report.Results)) {
    throw new Error("Invalid Trivy Results");
  }
  const totals = {
    critical: 0, high: 0, fixableCritical: 0, fixableHigh: 0,
    os: 0, library: 0,
  };
  const entries = [];
  const unique = new Set();
  for (const result of report.Results) {
    if (!result || typeof result !== "object") {
      throw new Error("Invalid Trivy result");
    }
    if (result.Vulnerabilities !== undefined &&
        !Array.isArray(result.Vulnerabilities)) {
      throw new Error("Invalid Trivy Vulnerabilities");
    }
    const component = result.Class === "os-pkgs" ? "os"
      : result.Class === "lang-pkgs" ? "library" : "unknown";
    for (const vuln of result.Vulnerabilities ?? []) {
      if (!vuln || typeof vuln !== "object") {
        throw new Error("Invalid Trivy vulnerability");
      }
      const severity = vuln.Severity;
      if (severity !== "HIGH" && severity !== "CRITICAL") continue;
      const fixed = typeof vuln.FixedVersion === "string" && vuln.FixedVersion.trim() !== "";
      if (severity === "CRITICAL") {
        totals.critical++;
        if (fixed) totals.fixableCritical++;
      } else {
        totals.high++;
        if (fixed) totals.fixableHigh++;
      }
      if (component === "os") totals.os++;
      if (component === "library") totals.library++;

      // Only list CRITICAL (even without a fix) and fixable HIGH.
      if (!(severity === "CRITICAL" || fixed)) continue;
      const id = safe(vuln.VulnerabilityID, VALID_ID);
      const pkg = safe(vuln.PkgName, VALID_PACKAGE);
      const installed = safe(vuln.InstalledVersion, VALID_VERSION);
      const patched = fixed ? safe(vuln.FixedVersion, VALID_VERSION) : "not-reported";
      const key = [severity, component, id, pkg, installed, patched].join("|");
      if (unique.has(key)) continue;
      unique.add(key);
      entries.push({ severity, component, id, pkg, installed, patched });
    }
  }
  entries.sort((a,b)=>
    (a.severity === "CRITICAL" ? 0 : 1) -
    (b.severity === "CRITICAL" ? 0 : 1) ||
    a.component.localeCompare(b.component) ||
    a.id.localeCompare(b.id) ||
    a.pkg.localeCompare(b.pkg));
  return { totals, entries: entries.slice(0, MAX_ROWS),
    truncated: entries.length > MAX_ROWS };
}

export function printTriage(paths, log = console.log) {
  if (!Array.isArray(paths) || paths.length !== 2) {
    throw new TypeError("Expected two Trivy report file paths");
  }
  for (const [index, path] of paths.entries()) {
    let result;
    try {
      const raw = readFileSync(path, "utf8");
      if (raw.length > 8_000_000) throw new Error("Oversized report");
      result = triageTrivyReport(JSON.parse(raw));
    } catch {
      throw new Error("Unable to validate Trivy report");
    }
    const name = index === 0 ? "API" : "Worker";
    log(name + " advisory totals: " + result.totals.critical +
      " CRITICAL (" + result.totals.fixableCritical + " fixable), " +
      result.totals.high + " HIGH (" + result.totals.fixableHigh +
      " fixable); " + result.totals.os + " OS, " +
      result.totals.library + " library findings");
    for (const entry of result.entries) {
      log(name + " " + entry.severity + " " + entry.component +
        " " + entry.id + " package=" + entry.pkg +
        " installed=" + entry.installed + " fixed=" + entry.patched);
    }
    if (result.truncated) log(name + " more advisories omitted (24 row limit)");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    printTriage(process.argv.slice(2));
  } catch {
    console.error("Security triage failed: report absent or malformed");
    process.exitCode = 1;
  }
}
