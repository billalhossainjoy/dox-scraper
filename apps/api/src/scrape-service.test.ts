import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPage } from "@dox-scraper/fetcher";
import { scrapePage } from "./scrape.js";

vi.mock("@dox-scraper/fetcher", () => ({
  fetchPage: vi.fn(),
}));

const response = {
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  statusCode: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  contentType: "text/html; charset=utf-8",
  html: `<!doctype html><html lang="en">
    <head><title>Example Article</title><meta name="description" content="A test page"></head>
    <body><main><h1>Example Article</h1><p>Hello <strong>world</strong></p>
    <a href="/next">More information</a></main></body>
  </html>`,
  fetchedAt: "2026-11-18T00:00:00.000Z",
  redirectCount: 0,
};

describe("scrapePage pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchPage).mockResolvedValue({ ...response });
  });

  it("fetches, extracts and converts the page into Markdown", async () => {
    const result = await scrapePage("https://example.com/");

    expect(result.statusCode).toBe(200);
    expect(result.title).toBe("Example Article");
    expect(result.description).toBe("A test page");
    expect(result.headings).toEqual([{ level: 1, text: "Example Article" }]);
    expect(result.markdown).toContain("# Example Article");
    expect(result.markdown).toContain("Hello **world**");
    expect(result.links).toContainEqual({
      url: "https://example.com/next",
      text: "More information",
      external: false,
    });
    expect(result.fetchedAt).toBe("2026-11-18T00:00:00.000Z");
    expect(fetchPage).toHaveBeenCalledWith("https://example.com/", {});
  });

  it("passes configurable bounds to fetching and Markdown conversion", async () => {
    const result = await scrapePage("https://example.com/", {
      timeoutMs: 6000,
      maxBytes: 4096,
      maxRedirects: 2,
      maxCharacters: 10,
    });
    expect(fetchPage).toHaveBeenCalledWith("https://example.com/", {
      timeoutMs: 6000,
      maxBytes: 4096,
      maxRedirects: 2,
    });
    expect(result.markdown.length).toBeLessThanOrEqual(10);
  });

  it("does not parse non-HTML content", async () => {
    vi.mocked(fetchPage).mockResolvedValueOnce({
      ...response,
      contentType: "application/pdf",
      headers: { "content-type": "application/pdf" },
    });
    await expect(scrapePage("https://example.com/")).rejects.toMatchObject({
      code: "UNSUPPORTED_CONTENT_TYPE",
      httpStatus: 502,
    });
  });

  it("does not retry websites responding with HTTP 429", async () => {
    vi.mocked(fetchPage).mockResolvedValueOnce({
      ...response,
      statusCode: 429,
    });
    await expect(scrapePage("https://example.com/")).rejects.toMatchObject({
      code: "UPSTREAM_RATE_LIMITED",
      httpStatus: 429,
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("returns a structured error for other upstream HTTP failures", async () => {
    vi.mocked(fetchPage).mockResolvedValueOnce({
      ...response,
      statusCode: 403,
    });
    await expect(scrapePage("https://example.com/")).rejects.toMatchObject({
      code: "UPSTREAM_HTTP_ERROR",
      httpStatus: 502,
    });
  });
});
