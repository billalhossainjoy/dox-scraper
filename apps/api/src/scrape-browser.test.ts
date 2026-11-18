import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPage, type FetchPageResult } from "@dox-scraper/fetcher";
import { createApp } from "./app.js";

vi.mock("@dox-scraper/fetcher", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPage: vi.fn(),
}));

const URL = "https://example.com/dynamic";
const SOURCE_HTML = '<html><head><title>Before JS</title></head><body><main><h1>Loading</h1></main></body></html>';
const RENDERED_HTML = '<html><head><title>After JS</title></head><body><main><h1>Rendered Page</h1><p>Dynamic data</p></main></body></html>';

function originalResponse(finalUrl: string = URL): FetchPageResult {
  return {
    requestedUrl: URL,
    finalUrl,
    statusCode: 200,
    headers: { "content-type": "text/html" },
    contentType: "text/html",
    html: SOURCE_HTML,
    fetchedAt: "2026-11-18T00:00:00.000Z",
    redirectCount: 0,
  };
}

function post(app: ReturnType<typeof createApp>, render = "browser") {
  return app.request("/v1/scrape", {
    method: "POST",
    headers: {
      authorization: "Bearer browser-test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ url: URL, options: { render } }),
  });
}

describe("explicit browser-rendered scrape API", () => {
  beforeEach(() => vi.mocked(fetchPage).mockReset());

  it("rejects browser rendering before fetching when disabled", async () => {
    const renderer = vi.fn(async () => ({
      url: URL, html: RENDERED_HTML, renderedAt: new Date().toISOString(),
    }));
    const app = createApp({
      apiKey: "browser-test-token",
      browserEnabled: false,
      browserAllowedOrigins: ["https://example.com"],
      browserRender: renderer,
    });
    const response = await post(app);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false, error: { code: "BROWSER_DISABLED" },
    });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(renderer).not.toHaveBeenCalled();
  });

  it("rejects unapproved origins before network access", async () => {
    const app = createApp({
      apiKey: "browser-test-token",
      browserEnabled: true,
      browserAllowedOrigins: ["https://other.example"],
    });
    const response = await post(app);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false, error: { code: "BROWSER_NOT_ALLOWED" },
    });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("returns Markdown from the rendered page, not the original HTTP HTML", async () => {
    vi.mocked(fetchPage).mockResolvedValue(originalResponse());
    const renderer = vi.fn(async () => ({
      url: URL, html: RENDERED_HTML, renderedAt: "2026-11-18T00:00:00.000Z",
    }));
    const app = createApp({
      apiKey: "browser-test-token",
      browserEnabled: true,
      browserAllowedOrigins: ["https://example.com"],
      browserRender: renderer,
    });
    const response = await post(app);
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      success: boolean;
      data: {
        title: string;
        markdown: string;
        renderMode: string;
        contentText: string;
        cache: { status: string };
      };
    };
    expect(result.success).toBe(true);
    expect(result.data.title).toBe("After JS");
    expect(result.data.markdown).toContain("# Rendered Page");
    expect(result.data.markdown).toContain("Dynamic data");
    expect(result.data.markdown).not.toContain("Loading");
    expect(result.data.renderMode).toBe("browser");
    expect(result.data.cache.status).toBe("MISS");
    expect(renderer).toHaveBeenCalledWith(expect.objectContaining({
      url: URL, html: SOURCE_HTML,
    }));
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("blocks redirects to origins not approved for browser execution", async () => {
    vi.mocked(fetchPage).mockResolvedValue(originalResponse("https://other.example/final"));
    const renderer = vi.fn(async () => ({
      url: URL, html: RENDERED_HTML, renderedAt: new Date().toISOString(),
    }));
    const app = createApp({
      apiKey: "browser-test-token",
      browserEnabled: true,
      browserAllowedOrigins: ["https://example.com"],
      browserRender: renderer,
    });
    const response = await post(app);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false, error: { code: "BROWSER_NOT_ALLOWED" },
    });
    expect(renderer).not.toHaveBeenCalled();
  });

  it("keeps HTTP as the default and never invokes a browser for ordinary scrapes", async () => {
    vi.mocked(fetchPage).mockResolvedValue(originalResponse());
    const renderer = vi.fn(async () => ({
      url: URL, html: RENDERED_HTML, renderedAt: new Date().toISOString(),
    }));
    const app = createApp({
      apiKey: "browser-test-token",
      browserEnabled: true,
      browserAllowedOrigins: ["https://example.com"],
      browserRender: renderer,
    });
    const response = await post(app, "http");
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      data: { markdown: string; renderMode?: string };
    };
    expect(result.data.markdown).toContain("# Loading");
    expect(result.data.renderMode).toBeUndefined();
    expect(renderer).not.toHaveBeenCalled();
  });

  it("rejects unrecognized render modes", async () => {
    const app = createApp({ apiKey: "browser-test-token" });
    const response = await post(app, "unsafe");
    expect(response.status).toBe(400);
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
