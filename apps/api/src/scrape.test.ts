import { describe, expect, it, vi } from "vitest";
import { FetchError } from "@dox-scraper/fetcher";
import { createApp } from "./app.js";
import type { ScrapeResult } from "./scrape.js";

const sample: ScrapeResult = {
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  statusCode: 200,
  title: "Example",
  description: "Description",
  canonicalUrl: "https://example.com/",
  language: "en",
  headings: [{ level: 1, text: "Example" }],
  links: [{ url: "https://example.com/next", text: "Next", external: false }],
  markdown: "# Example\n\nHello",
  contentText: "Example\nHello",
  fetchedAt: "2026-11-18T00:00:00.000Z",
  redirectCount: 0,
};

function post(app: ReturnType<typeof createApp>, body: unknown, token = "local-secret") {
  return app.request("/v1/scrape", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/scrape", () => {
  it("returns extracted Markdown and metadata", async () => {
    const scrape = vi.fn(async () => sample);
    const app = createApp({ apiKey: "local-secret", scrape });
    const response = await post(app, { url: "https://example.com" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: sample });
    expect(scrape).toHaveBeenCalledWith("https://example.com", {});
  });

  it("rejects requests without a valid API key", async () => {
    const scrape = vi.fn(async () => sample);
    const app = createApp({ apiKey: "local-secret", scrape });
    const missing = await app.request("/v1/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    const invalid = await post(app, { url: "https://example.com" }, "wrong-key");
    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(scrape).not.toHaveBeenCalled();
  });

  it("does not expose scraping when the API key is unconfigured", async () => {
    const app = createApp({ apiKey: "" });
    const response = await post(app, { url: "https://example.com" });
    expect(response.status).toBe(503);
  });

  it("rejects invalid URLs, extra keys and invalid options", async () => {
    const app = createApp({ apiKey: "local-secret" });
    for (const body of [
      { url: "file:///etc/passwd" },
      { url: "https://example.com", unknown: true },
      { url: "https://example.com", options: { maxBytes: -3 } },
      { url: "ftp://example.com" },
    ]) {
      const response = await post(app, body);
      expect(response.status).toBe(400);
    }
  });

  it("rejects malformed JSON and unsupported media types", async () => {
    const app = createApp({ apiKey: "local-secret" });
    const invalidJson = await app.request("/v1/scrape", {
      method: "POST",
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
      body: "{invalid",
    });
    expect(invalidJson.status).toBe(400);

    const mediaType = await app.request("/v1/scrape", {
      method: "POST",
      headers: { authorization: "Bearer local-secret", "content-type": "text/plain" },
      body: "hello",
    });
    expect(mediaType.status).toBe(415);
  });

  it("maps blocked network destinations to a client error", async () => {
    const scrape = vi.fn(async (): Promise<ScrapeResult> => {
      throw new FetchError("BLOCKED_ADDRESS", "Private address is blocked");
    });
    const app = createApp({ apiKey: "local-secret", scrape });
    const response = await post(app, { url: "https://example.com" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "BLOCKED_ADDRESS" },
    });
  });

  it("serves the OpenAPI description without requiring a key", async () => {
    const app = createApp({ apiKey: "local-secret" });
    const response = await app.request("/openapi.json");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      paths: { "/v1/scrape": { post: { security: [{ bearerAuth: [] }] } } },
    });
  });
});
