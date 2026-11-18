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
  it("preserves SVG descriptions and linked SVG image references in the real scrape pipeline", async () => {
    vi.mocked(fetchPage).mockResolvedValueOnce({
      ...response,
      html: '<html><head><title>SVG Test</title></head><body><main>' +
        '<h1>Medication charts</h1>' +
        '<svg role="img" aria-label="Medication dosage timeline">' +
        '<script>alert("untrusted")</script><path d="M0 0" onload="alert(1)"/>' +
        '</svg>' +
        '<img src="/icons/tablet.svg" alt="Tablet icon" />' +
        '</main></body></html>',
    });
    const result = await scrapePage("https://example.com/");
    expect(result.markdown).toContain("SVG image: Medication dosage timeline");
    expect(result.markdown).toContain("![Tablet icon](https://example.com/icons/tablet.svg)");
    expect(result.contentText).toContain("Medication dosage timeline");
    expect(result.markdown).not.toContain("<svg");
    expect(result.markdown).not.toContain("onload=");
    expect(result.markdown).not.toContain("alert(");
  });

  it("does not treat standalone SVG XML as an HTML webpage", async () => {
    vi.mocked(fetchPage).mockResolvedValueOnce({
      ...response,
      contentType: "image/svg+xml",
      headers: { "content-type": "image/svg+xml" },
      html: '<svg><script>unsafe()</script><title>Image</title></svg>',
    });
    await expect(scrapePage("https://example.com/image.svg")).rejects.toMatchObject({
      code: "UNSUPPORTED_CONTENT_TYPE",
      httpStatus: 502,
    });
  });

});
