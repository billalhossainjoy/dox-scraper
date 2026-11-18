import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { ScrapeResult } from "./scrape.js";

const sample: ScrapeResult = {
  requestedUrl: "https://example.org/",
  finalUrl: "https://example.org/",
  statusCode: 200,
  title: "Fixture",
  description: null,
  canonicalUrl: null,
  language: "en",
  headings: [],
  links: [],
  markdown: "# Fixture",
  contentText: "Fixture",
  fetchedAt: "2026-11-18T00:00:00.000Z",
  redirectCount: 0,
};

const KEY = "local-only-test-key";

function request(app: ReturnType<typeof createApp>, body: string, length?: number) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${KEY}`,
    "content-type": "application/json",
  };
  if (length !== undefined) headers["content-length"] = String(length);
  return app.request("/v1/scrape", {
    method: "POST",
    headers,
    body,
  });
}

describe("scrape route security and resource bounds", () => {
  it("rejects a declared request body larger than 16 KiB before scraping", async () => {
    const scrape = vi.fn(async () => sample);
    const app = createApp({ apiKey: KEY, scrape });
    const body = JSON.stringify({
      url: "https://example.org/",
      padding: "x".repeat(17 * 1024),
    });
    const response = await request(app, body, Buffer.byteLength(body));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "BODY_TOO_LARGE" },
    });
    expect(scrape).not.toHaveBeenCalled();
  });

  it("enforces two concurrent jobs and releases the slot after completion", async () => {
    let resolveAll!: (value: ScrapeResult) => void;
    const work = new Promise<ScrapeResult>((resolve) => {
      resolveAll = resolve;
    });
    let startedCount = 0;
    let bothStarted!: () => void;
    const ready = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const scrape = vi.fn(() => {
      startedCount += 1;
      if (startedCount === 2) bothStarted();
      return work;
    });
    const app = createApp({ apiKey: KEY, scrape });
    const body = JSON.stringify({ url: "https://example.org/" });

    const first = request(app, body);
    const second = request(app, body);
    await ready;

    const busy = await request(app, body);
    expect(busy.status).toBe(429);
    await expect(busy.json()).resolves.toMatchObject({
      success: false,
      error: { code: "BUSY" },
    });
    expect(scrape).toHaveBeenCalledTimes(2);

    resolveAll(sample);
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    const afterCompletion = await request(app, body);
    expect(afterCompletion.status).toBe(200);
    expect(scrape).toHaveBeenCalledTimes(3);
  });

  it("rejects an unauthenticated oversized payload without invoking scraping", async () => {
    const scrape = vi.fn(async () => sample);
    const app = createApp({ apiKey: KEY, scrape });
    const response = await app.request("/v1/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.org/" }),
    });
    expect(response.status).toBe(401);
    expect(scrape).not.toHaveBeenCalled();
  });

  it("rejects invalid bounded settings without invoking scraping", async () => {
    const scrape = vi.fn(async () => sample);
    const app = createApp({ apiKey: KEY, scrape });
    for (const options of [
      { timeoutMs: 999 },
      { timeoutMs: 30_001 },
      { maxBytes: 1023 },
      { maxBytes: 2 * 1024 * 1024 + 1 },
      { maxRedirects: -1 },
      { maxRedirects: 6 },
      { maxCharacters: 0 },
      { maxCharacters: 250_001 },
    ]) {
      const response = await request(app, JSON.stringify({ url: "https://example.org/", options }));
      expect(response.status).toBe(400);
    }
    expect(scrape).not.toHaveBeenCalled();
  });
});
