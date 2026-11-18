/* global process, console */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Consume JSON from Trivy's pinned container scanner and fail closed on
 * malformed reports. Only actionable (FixedVersion available) CRITICAL
 * findings block. Other findings are displayed as counts for review.
 * Never log image paths, build environment, Docker secrets or whole reports.
 */
export function summarizeImageScan(document) {
  if (!document || typeof document !== "object" ||
      !Array.isArray(document.Results)) {
    throw new Error("Trivy report is missing its Results array");
  }
  const counts = {
    high: 0, critical: 0, fixableHigh: 0,
    fixableCritical: 0, unknown: 0,
  };
  const blockingIds = new Set();
  for (const result of document.Results) {
    if (!result || typeof result !== "object") {
      throw new Error("Invalid Trivy result entry");
    }
    const findings = result.Vulnerabilities ?? [];
    if (!Array.isArray(findings)) throw new Error("Invalid Trivy vulnerability list");
    for (const finding of findings) {
      if (!finding || typeof finding !== "object") throw new Error("Invalid Trivy finding");
      const severity = String(finding.Severity ?? "").toUpperCase();
      const fixable = typeof finding.FixedVersion === "string" &&
        finding.FixedVersion.trim().length > 0;
      if (severity === "HIGH") {
        counts.high += 1;
        if (fixable) counts.fixableHigh += 1;
      } else if (severity === "CRITICAL") {
        counts.critical += 1;
        if (fixable) {
          counts.fixableCritical += 1;
          const id = finding.VulnerabilityID;
          if (typeof id === "string" &&
              /^(?:CVE-\d{4}-\d{4,}|GHSA-[a-zA-Z0-9-]+)$/.test(id)) {
            blockingIds.add(id);
          }
        }
      } else {
        counts.unknown += 1;
      }
    }
  }
  return { ...counts, blockingIds: [...blockingIds].slice(0, 20).sort() };
}

export function checkImageReports(paths, log = console.log) {
  if (!Array.isArray(paths) || paths.length !== 2) {
    throw new TypeError("Supply both the API and worker Trivy JSON reports");
  }
  let totalBlockers = 0;
  for (const [index, path] of paths.entries()) {
    let result;
    try {
      const json = JSON.parse(readFileSync(path, "utf8"));
      result = summarizeImageScan(json);
    } catch {
      // The report path may contain secrets; never interpolate errors.
      throw new Error("Container vulnerability report missing or invalid");
    }
    const service = index === 0 ? "API" : "Worker";
    log(service + ": " + result.critical + " CRITICAL (" +
      result.fixableCritical + " with fixes); " + result.high +
      " HIGH (" + result.fixableHigh + " with fixes).");
    if (result.blockingIds.length > 0) {
      log(service + " actionable CRITICAL advisories: " + result.blockingIds.join(", "));
    }
    totalBlockers += result.fixableCritical;
  }
  if (totalBlockers > 0) {
    throw new Error("Actionable CRITICAL container vulnerabilities require remediation");
  }
  return true;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    checkImageReports(process.argv.slice(2));
  } catch (error) {
    console.error("Container security gate failed:",
      error instanceof Error ? error.message : "Unexpected scan failure");
    process.exitCode = 1;
  }
}
