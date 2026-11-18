import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FetchError, fetchPage, type FetchPageResult } from "@dox-scraper/fetcher";
import { createApp } from "./app.js";
import type { ScrapeResult } from "./scrape.js";

// Exercise the real Hono route, scrape service, Cheerio extractor and Markdown
// converter. Only the outbound HTTP boundary is mocked: tests never hit the
// public internet or depend on a third-party website.
vi.mock("@dox-scraper/fetcher", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPage: vi.fn(),
}));

const html = readFileSync(new URL("../test-fixtures/medicine-article.html", import.meta.url), "utf8");
const fetchMock = vi.mocked(fetchPage);
const upstreamResponse: FetchPageResult = {
  requestedUrl: "https://example.org/go",
  finalUrl: "https://example.org/medicines/sample?campaign=testing",
  statusCode: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  contentType: "text/html; charset=utf-8",
  html,
  fetchedAt: "2026-11-18T00:00:00.000Z",
  redirectCount: 1,
};

function request(body: object = { url: "https://example.org/go" }) {
  const app = createApp({ apiKey: "local-only-test-key" });
  return app.request("/v1/scrape", {
    method: "POST",
    headers: {
      authorization: "Bearer local-only-test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("full scrape HTTP pipeline (fixture-backed)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ...upstreamResponse });
  });

  it("returns correctly resolved metadata, links and Markdown", async () => {
    const response = await request();
    expect(response.status).toBe(200);

    const json = (await response.json()) as { success: boolean; data: ScrapeResult };
    expect(json.success).toBe(true);
    expect(json.data).toMatchObject({
      requestedUrl: "https://example.org/go",
      finalUrl: "https://example.org/medicines/sample?campaign=testing",
      statusCode: 200,
      title: "Example Tablet 500 mg | Sample Reference",
      description: "Example medicine entry for automated tests",
      canonicalUrl: "https://example.org/medicines/sample",
      language: "en",
      fetchedAt: "2026-11-18T00:00:00.000Z",
      redirectCount: 1,
    });
    expect(json.data.headings).toEqual([
      { level: 1, text: "Example Tablet 500 mg" },
      { level: 2, text: "Dosage forms" },
    ]);
    expect(json.data.links).toContainEqual({
      url: "https://example.org/medicines/related",
      text: "Related product",
      external: false,
    });
    expect(json.data.markdown).toContain("# Example Tablet 500 mg");
    expect(json.data.markdown).toContain("**Example compound**");
    expect(json.data.markdown).toMatch(/^-\s+Tablet$/m);
    expect(json.data.markdown).toContain("| 500 mg");
    expect(json.data.markdown).toContain("[Related product](https://example.org/medicines/related#strength)");
    expect(json.data.markdown).toContain("![Sample pack](https://example.org/assets/medicine.png)");

    expect(json.data.contentText).not.toContain("Site branding");
    expect(json.data.contentText).not.toContain("Privacy and tracking links");
    expect(json.data.markdown).not.toContain("<script");
    expect(json.data.markdown).not.toContain("onclick=");
    expect(json.data.markdown).not.toContain("onerror=");
    expect(json.data.markdown).not.toContain("javascript:");
    expect(json.data.markdown).not.toContain("alert(");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes safe request bounds through to the fetcher and Markdown converter", async () => {
    const response = await request({
      url: "https://example.org/go",
      options: { timeoutMs: 5000, maxBytes: 8192, maxRedirects: 2, maxCharacters: 20 },
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: ScrapeResult };
    expect(json.data.markdown.length).toBeLessThanOrEqual(20);
    expect(fetchMock).toHaveBeenCalledWith("https://example.org/go", {
      timeoutMs: 5000,
      maxBytes: 8192,
      maxRedirects: 2,
    });
  });

  it.each([
    ["BLOCKED_ADDRESS", 400],
    ["INVALID_URL", 400],
    ["TIMEOUT", 504],
    ["RESPONSE_TOO_LARGE", 502],
    ["NETWORK_ERROR", 502],
  ] as const)("maps fetcher %s errors to HTTP %i", async (code, status) => {
    fetchMock.mockRejectedValueOnce(new FetchError(code, "Fixture error"));
    const response = await request();
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code, message: "Fixture error" },
    });
  });

  it("surfaces an upstream rate limit without automatic retries", async () => {
    fetchMock.mockResolvedValueOnce({ ...upstreamResponse, statusCode: 429 });
    const response = await request();
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "UPSTREAM_RATE_LIMITED" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-HTML responses without invoking extraction", async () => {
    fetchMock.mockResolvedValueOnce({
      ...upstreamResponse,
      contentType: "application/pdf",
      headers: { "content-type": "application/pdf" },
    });
    const response = await request();
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "UNSUPPORTED_CONTENT_TYPE" },
    });
  });
});
