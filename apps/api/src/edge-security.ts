import type { MiddlewareHandler } from "hono";

export interface AccessLogEntry {
  timestamp: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
}

export interface EdgeSecurityOptions {
  /** Exact DNS hostname, without scheme, port or wildcard. Empty disables host filtering. */
  publicHostname?: string;
  /** No queries, headers, IPs or request bodies are ever logged. */
  onAccessLog?: (entry: AccessLogEntry) => void;
}

const DNS_LABEL = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;

export function validatePublicHostname(value: string): string {
  if (!value) return "";
  const hostname = value.toLowerCase();
  const labels = hostname.split(".");
  if (hostname.length > 253 || labels.length < 2 ||
      labels.some((part) => !DNS_LABEL.test(part)) ||
      hostname !== value) {
    throw new TypeError(
      "DOX_PUBLIC_HOSTNAME must be a lowercase DNS hostname without scheme, port, path or wildcard",
    );
  }
  return hostname;
}

/**
 * Defense in depth only: Host checks do not authenticate callers or replace
 * Cloudflare Access, the API bearer secret, or the loopback-only port bind.
 */
export function isAllowedHost(header: string | undefined, expected: string): boolean {
  if (!expected) return true;
  if (!header || header.length > 300 ||
      /[\s/@?#,\\]/.test(header)) return false;
  const host = header.toLowerCase();
  if (host === expected || host === expected + ":443") return true;

  // Loopback is retained for local health checks and maintenance.
  if (host === "localhost" || host === "127.0.0.1" ||
      host === "[::1]") return true;
  const match = /^(localhost|127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/.exec(host);
  return !!match && Number(match[2]) <= 65535;
}

/** Routes are allowlisted before logging to prevent token/URL leakage. */
export function routeForLog(method: string, path: string): string {
  if (method === "GET" && path === "/health") return "/health";
  if (method === "GET" && path === "/openapi.json") return "/openapi.json";
  if (method === "POST" && path === "/v1/scrape") return "/v1/scrape";
  if (method === "POST" && path === "/v1/crawl") return "/v1/crawl";
  if (/^\/v1\/crawl\/[a-f0-9-]{36}$/.test(path)) {
    if (method === "GET" || method === "DELETE") return "/v1/crawl/:id";
  }
  if (method === "GET" && /^\/v1\/crawl\/[a-f0-9-]{36}\/results$/.test(path)) {
    return "/v1/crawl/:id/results";
  }
  return "/other";
}

export function edgeSecurity(options: EdgeSecurityOptions = {}): MiddlewareHandler {
  const expected = validatePublicHostname(options.publicHostname ?? "");
  return async (c, next) => {
    const start = performance.now();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");

    if (!isAllowedHost(c.req.header("host"), expected)) {
      return c.json({
        success: false,
        error: { code: "UNEXPECTED_HOST", message: "Request Host is not configured" },
      }, 421);
    }

    try {
      await next();
    } finally {
      if (options.onAccessLog) {
        options.onAccessLog({
          timestamp: new Date().toISOString(),
          method: c.req.method,
          route: routeForLog(c.req.method, new URL(c.req.url).pathname),
          status: c.res.status,
          durationMs: Math.max(0, Math.round(performance.now() - start)),
        });
      }
    }
  };
}
