import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import {
  isAllowedHost, routeForLog, validatePublicHostname,
  type AccessLogEntry,
} from "./edge-security.js";

describe("Cloudflare tunnel origin hardening", () => {
  it("accepts only exact public hostnames or loopback for local health", () => {
    const expected = "scraper.example.com";
    for (const hostname of [
      expected, expected + ":443", "localhost", "localhost:3000",
      "127.0.0.1", "127.0.0.1:3000", "[::1]", "[::1]:3000",
    ]) {
      expect(isAllowedHost(hostname, expected)).toBe(true);
    }
    for (const hostname of [
      undefined, "", "other.example.com", "sub.scraper.example.com",
      "scraper.example.com.evil.test", "scraper.example.com:1234",
      "scraper.example.com@evil.test", "scraper.example.com/path",
      "scraper.example.com,evil.test", "localhost:99999",
    ]) {
      expect(isAllowedHost(hostname, expected)).toBe(false);
    }
    expect(isAllowedHost(undefined, "")).toBe(true);
  });

  it("rejects wildcard or malformed public hostname configuration", () => {
    for (const value of [
      "http://scraper.example.com", "*.example.com", "scraper.example.com:443",
      "scraper.example.com/", "SCRAPER.EXAMPLE.COM", "localhost", "bad..example.com",
      "scraper.example.com?access=true",
    ]) {
      expect(() => validatePublicHostname(value)).toThrow(TypeError);
    }
    expect(validatePublicHostname("scraper.example.com")).toBe("scraper.example.com");
  });

  it("rejects mismatched Host before the API route or token check", async () => {
    const app = createApp({
      apiKey: "example-secret",
      publicHostname: "scraper.example.com",
    });
    const bad = await app.request("http://evil.example.com/v1/scrape", {
      method: "POST",
      headers: {
        host: "evil.example.com",
        authorization: "Bearer example-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(bad.status).toBe(421);
    await expect(bad.json()).resolves.toMatchObject({
      error: { code: "UNEXPECTED_HOST" },
    });

    const good = await app.request("http://127.0.0.1:3000/health", {
      headers: { host: "127.0.0.1:3000", "x-forwarded-host": "evil.example.com" },
    });
    expect(good.status).toBe(200);

    const publicHost = await app.request("https://scraper.example.com/health", {
      headers: { host: "scraper.example.com" },
    });
    expect(publicHost.status).toBe(200);
    expect(publicHost.headers.get("cache-control")).toBe("no-store");
    expect(publicHost.headers.get("x-content-type-options")).toBe("nosniff");
    expect(publicHost.headers.get("x-frame-options")).toBe("DENY");
    expect(publicHost.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("keeps the API bearer token mandatory even on the configured public host", async () => {
    const app = createApp({
      apiKey: "example-secret",
      publicHostname: "scraper.example.com",
    });
    const response = await app.request("https://scraper.example.com/v1/scrape", {
      method: "POST",
      headers: {
        host: "scraper.example.com",
        "cf-access-client-id": "untrusted-header-must-not-authenticate",
        "cf-access-client-secret": "untrusted-header-must-not-authenticate",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("never logs query strings, request bodies, tokens or client headers", async () => {
    const log = vi.fn<(entry: AccessLogEntry) => void>();
    const app = createApp({
      apiKey: "keep-bearer-secret",
      publicHostname: "scraper.example.com",
      onAccessLog: log,
    });
    const response = await app.request(
      "https://scraper.example.com/v1/scrape?token=should-not-log", {
        method: "POST",
        headers: {
          host: "scraper.example.com",
          authorization: "Bearer keep-bearer-secret",
          "cf-access-client-secret": "keep-access-secret",
          "content-type": "application/json",
        },
        body: '{"url":"https://example.com?secret=do-not-log","unknown":true}',
      },
    );
    expect(response.status).toBe(400);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      method: "POST", route: "/v1/scrape", status: 400,
    });
    const recorded = JSON.stringify(log.mock.calls);
    for (const secret of [
      "should-not-log", "keep-bearer-secret", "keep-access-secret",
      "do-not-log", "example.com",
    ]) {
      expect(recorded).not.toContain(secret);
    }
    expect(routeForLog("GET", "/v1/crawl/12345678-1234-4123-8123-123456789abc/results"))
      .toBe("/v1/crawl/:id/results");
    expect(routeForLog("POST", "/accidental-secret-key")).toBe("/other");
  });
});
