import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPage, type FetchPageResult } from "@dox-scraper/fetcher";
import { createApp } from "./app.js";

vi.mock("@dox-scraper/fetcher", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPage: vi.fn(),
}));

const mockedFetcher = vi.mocked(fetchPage);
const PAGE = "https://example.com/medicine";

function fixture(headers: FetchPageResult["headers"] = {}): FetchPageResult {
  return {
    requestedUrl: PAGE,
    finalUrl: PAGE,
    statusCode: 200,
    headers: { "content-type": "text/html", ...headers },
    contentType: "text/html",
    html: "<html><head><title>Example Medicine</title></head><body>" +
      "<main><h1>Example Medicine</h1><p>A testing-only page.</p></main></body></html>",
    fetchedAt: "2026-11-18T00:00:00.000Z",
    redirectCount: 0,
  };
}

function scrapeRequest(app: ReturnType<typeof createApp>) {
  return app.request("/v1/scrape", {
    method: "POST",
    headers: {
      authorization: "Bearer local-test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({ url: PAGE }),
  });
}

describe("API response caching integration", () => {
  beforeEach(() => mockedFetcher.mockReset());

  it("returns a fingerprint and avoids duplicate downloads while fresh", async () => {
    mockedFetcher.mockResolvedValue(fixture({ etag: '"v1"' }));
    const app = createApp({ apiKey: "local-test-key" });

    const first = await scrapeRequest(app);
    const second = await scrapeRequest(app);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as {
      data: { markdown: string; cache: { status: string; contentSha256: string; changed: boolean } };
    };
    const b = (await second.json()) as {
      data: { markdown: string; cache: { status: string; contentSha256: string; changed: boolean } };
    };
    expect(a.data.cache.status).toBe("MISS");
    expect(b.data.cache.status).toBe("HIT");
    expect(a.data.cache.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(a.data.cache.contentSha256).toBe(b.data.cache.contentSha256);
    expect(a.data.markdown).toContain("# Example Medicine");
    expect(mockedFetcher).toHaveBeenCalledTimes(1);
  });

  it("respects upstream no-store and does not reuse the HTML body", async () => {
    mockedFetcher.mockResolvedValue(fixture({ "cache-control": "private, no-store" }));
    const app = createApp({ apiKey: "local-test-key" });
    const first = await scrapeRequest(app);
    const second = await scrapeRequest(app);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      data: { cache: { status: "BYPASS" } },
    });
    await expect(second.json()).resolves.toMatchObject({
      data: { cache: { status: "BYPASS" } },
    });
    expect(mockedFetcher).toHaveBeenCalledTimes(2);
  });
});
