import { validatePublicHostname } from "./edge-security.js";

type RuntimeEnvironment = Record<string, string | undefined>;

const BOOLEAN_FLAGS = [
  "DOX_ENABLE_CRAWL_API",
  "DOX_ENABLE_BROWSER_RENDERING",
  "DOX_HTTP_ACCESS_LOGS",
] as const;

const BAD_KEY_FRAGMENTS = [
  "replace", "changeme", "change-me", "your-", "your_", "example",
  "sample", "placeholder", "password", "test-only", "ci-only",
  "not-a-production", "default-key", "demo-key",
];

/**
 * This is a defensive production gate, NOT proof of cryptographic entropy.
 * Generate a fresh 32-byte secret with: openssl rand -hex 32.
 *
 * The API must never start listening in production with the shipped
 * .env.example placeholder or with a short/obviously demo credential.
 */
export function isPlausibleProductionKey(key: string | undefined): boolean {
  if (!key || key.length < 43 || key.length > 256) return false;
  if (!/^[a-zA-Z0-9_+=/-]+$/.test(key)) return false;
  if (new Set(key).size < 12) return false;
  const lower = key.toLowerCase();
  if (BAD_KEY_FRAGMENTS.some((word) => lower.includes(word))) return false;
  return true;
}

function validateOrigins(value: string): boolean {
  const items = value.split(",").map((entry) => entry.trim());
  if (items.length === 0 || items.some((entry) => !entry)) return false;
  return items.every((entry) => {
    try {
      const target = new URL(entry);
      return (target.protocol === "https:" || target.protocol === "http:") &&
        target.origin === entry &&
        !target.username && !target.password &&
        !target.hash && !target.search && target.pathname === "/";
    } catch { return false; }
  });
}

/**
 * Fail closed *before* creating the production HTTP server. This explicitly
 * does not relax API authentication in development; it only avoids breaking
 * local scripts that use short temporary keys for offline tests.
 *
 * Never interpolate or print environment variable values in errors.
 */
export function assertProductionConfiguration(env: RuntimeEnvironment): void {
  if (env.NODE_ENV !== "production") return;

  const issues: string[] = [];

  if (!isPlausibleProductionKey(env.DOX_SCRAPER_API_KEY)) {
    issues.push(
      "DOX_SCRAPER_API_KEY must be a fresh high-entropy value (use: openssl rand -hex 32)",
    );
  }

  for (const name of BOOLEAN_FLAGS) {
    const value = env[name];
    if (value !== undefined && value !== "true" && value !== "false") {
      issues.push(name + " must be either true or false");
    }
  }

  const hostname = env.DOX_PUBLIC_HOSTNAME ?? "";
  if (hostname) {
    try {
      validatePublicHostname(hostname);
    } catch {
      issues.push("DOX_PUBLIC_HOSTNAME must be a lowercase exact DNS hostname");
    }
  }

  if (env.DOX_ENABLE_CRAWL_API === "true" &&
      !validateOrigins(env.DOX_CRAWL_ALLOWED_ORIGINS ?? "")) {
    issues.push("DOX_CRAWL_ALLOWED_ORIGINS must contain exact HTTP(S) origins when crawling is enabled");
  }

  // There is no network-isolated browser service in the production Compose
  // stack. Do not allow switching it on in this API process by a typo/override.
  if (env.DOX_ENABLE_BROWSER_RENDERING === "true") {
    issues.push("DOX_ENABLE_BROWSER_RENDERING must remain false in the current production deployment");
  }

  if (issues.length > 0) {
    throw new Error("Production configuration rejected:\n" + issues.map((x) => "- " + x).join("\n"));
  }
}
