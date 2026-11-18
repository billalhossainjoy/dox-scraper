import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertProductionConfiguration,
  isPlausibleProductionKey,
} from "./production-config.js";

function production(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "production",
    DOX_SCRAPER_API_KEY: randomBytes(32).toString("hex"),
    DOX_ENABLE_CRAWL_API: "false",
    DOX_ENABLE_BROWSER_RENDERING: "false",
    DOX_HTTP_ACCESS_LOGS: "true",
    ...overrides,
  };
}

describe("production configuration preflight", () => {
  it("accepts a freshly generated 32-byte hex bearer key", () => {
    const env = production();
    expect(isPlausibleProductionKey(env.DOX_SCRAPER_API_KEY)).toBe(true);
    expect(() => assertProductionConfiguration(env)).not.toThrow();
  });

  it.each([
    undefined,
    "",
    "replace-with-a-long-random-secret",
    "YOUR_GENERATED_LONG_RANDOM_SECRET",
    "password-password-password-password-password",
    "ci-only-not-a-production-credential",
    "test-only-not-a-production-credential",
    "a".repeat(64),
    "Ab3!".repeat(16),
    "abcdef0123456789\nX-Evil:yes" + "a".repeat(40),
    "   " + "a".repeat(64),
    "x".repeat(257),
  ])("rejects missing, placeholder, obviously weak or malformed credentials", (key) => {
    expect(isPlausibleProductionKey(key)).toBe(false);
    expect(() => assertProductionConfiguration(production({
      DOX_SCRAPER_API_KEY: key,
    }))).toThrow(/DOX_SCRAPER_API_KEY/);
  });

  it("does not leak secrets or other environment values in the error", () => {
    const secret = "replace-with-a-long-random-secret";
    try {
      assertProductionConfiguration(production({
        DOX_SCRAPER_API_KEY: secret,
        DOX_PUBLIC_HOSTNAME: "bad.example.com/path?private",
      }));
      throw new Error("Unexpected success");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = String(error);
      expect(message).toContain("DOX_SCRAPER_API_KEY");
      expect(message).toContain("DOX_PUBLIC_HOSTNAME");
      expect(message).not.toContain(secret);
      expect(message).not.toContain("private");
    }
  });

  it("rejects unknown or malformed production feature flags", () => {
    for (const key of [
      "DOX_ENABLE_CRAWL_API",
      "DOX_ENABLE_BROWSER_RENDERING",
      "DOX_HTTP_ACCESS_LOGS",
    ]) {
      expect(() => assertProductionConfiguration(production({
        [key]: "yes",
      }))).toThrow(new RegExp(key));
    }
  });

  it("forbids enabling browser execution inside the current production API", () => {
    expect(() => assertProductionConfiguration(production({
      DOX_ENABLE_BROWSER_RENDERING: "true",
    }))).toThrow(/DOX_ENABLE_BROWSER_RENDERING/);
  });

  it("requires explicit origins if crawling is enabled", () => {
    const invalid = [
      "", "https://example.com/", "https://example.com/private",
      "https://user:password@example.com", "*.example.com",
      "https://example.com,,https://docs.example.com",
      "ftp://example.com",
    ];
    for (const origins of invalid) {
      expect(() => assertProductionConfiguration(production({
        DOX_ENABLE_CRAWL_API: "true",
        DOX_CRAWL_ALLOWED_ORIGINS: origins,
      }))).toThrow(/DOX_CRAWL_ALLOWED_ORIGINS/);
    }
    expect(() => assertProductionConfiguration(production({
      DOX_ENABLE_CRAWL_API: "true",
      DOX_CRAWL_ALLOWED_ORIGINS: "https://example.com,https://docs.example.com",
    }))).not.toThrow();
  });

  it("rejects malformed public hostname before binding a port", () => {
    for (const hostname of [
      "http://scraper.example.com", "*.example.com",
      "SCRAPER.EXAMPLE.COM", "scraper.example.com/path",
      "scraper.example.com:3000",
    ]) {
      expect(() => assertProductionConfiguration(production({
        DOX_PUBLIC_HOSTNAME: hostname,
      }))).toThrow(/DOX_PUBLIC_HOSTNAME/);
    }
    expect(() => assertProductionConfiguration(production({
      DOX_PUBLIC_HOSTNAME: "scraper.example.com",
    }))).not.toThrow();
  });

  it("keeps development mode functional for local scripts and tests", () => {
    expect(() => assertProductionConfiguration({
      NODE_ENV: "development",
      DOX_SCRAPER_API_KEY: "local-key",
      DOX_ENABLE_CRAWL_API: "false",
    })).not.toThrow();
    expect(() => assertProductionConfiguration({
      NODE_ENV: "test",
    })).not.toThrow();
  });
});
