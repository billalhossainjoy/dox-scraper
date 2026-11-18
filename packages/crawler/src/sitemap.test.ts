import { describe, expect, it } from "vitest";
import type { FetchPageResult } from "@dox-scraper/fetcher";
import {
  discoverSitemapUrls,
  parseRobotsSitemaps,
  parseSitemapXml,
  type SitemapFetcher,
} from "./sitemap.js";

const ORIGIN = "https://example.com";
type MockPage = { html: string; status?: number; finalUrl?: string };

function mockFetcher(pages: Record<string, MockPage>) {
  const requested: string[] = [];
  const fetcher: SitemapFetcher = async (url, options): Promise<FetchPageResult> => {
    requested.push(url);
    expect(options.maxBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(options.timeoutMs).toBeLessThanOrEqual(30_000);
    const page = pages[url];
    if (!page) throw new Error(`Unexpected network access: ${url}`);
    return {
      requestedUrl: url,
      finalUrl: page.finalUrl ?? url,
      statusCode: page.status ?? 200,
      headers: { "content-type": "application/xml" },
      contentType: "application/xml",
      html: page.html,
      fetchedAt: "2026-11-18T00:00:00.000Z",
      redirectCount: 0,
    };
  };
  return { fetcher, requested };
}

function urlSet(...locations: string[]): string {
  return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map(
    (url) => `<url><loc>${url.replaceAll("&", "&amp;")}</loc></url>`,
  ).join("")}</urlset>`;
}

function sitemapIndex(...locations: string[]): string {
  return `<?xml version="1.0"?><sitemapindex>${locations.map(
    (url) => `<sitemap><loc>${url}</loc></sitemap>`,
  ).join("")}</sitemapindex>`;
}

describe("pure sitemap parsing", () => {
  it("extracts all valid robots Sitemap declarations case-insensitively", () => {
    expect(parseRobotsSitemaps(
      "User-agent: *\nDisallow: /private\nSitemap: https://example.com/a.xml\n" +
      "sitemap : /b.xml # comment\n# Sitemap: https://example.com/ignored.xml",
    )).toEqual(["https://example.com/a.xml", "/b.xml"]);
  });

  it("parses regular URL sets and XML namespace prefixes", () => {
    expect(parseSitemapXml(urlSet("https://example.com/a", "https://example.com/b?x=1&amp;y=2")))
      .toMatchObject({ type: "urlset" });
    const parsed = parseSitemapXml(
      '<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      '<sm:url><sm:loc>https://example.com/a</sm:loc></sm:url></sm:urlset>',
    );
    expect(parsed).toEqual({ type: "urlset", locations: ["https://example.com/a"] });
  });

  it("parses sitemap indexes and excludes invalid XML roots", () => {
    expect(parseSitemapXml(sitemapIndex("https://example.com/child.xml"))).toEqual({
      type: "sitemapindex",
      locations: ["https://example.com/child.xml"],
    });
    expect(parseSitemapXml("<html><body>not a sitemap</body></html>")).toEqual({
      type: "unknown",
      locations: [],
    });
  });
});

describe("bounded same-origin sitemap discovery", () => {
  it("reads robots sitemap declarations, follows indexes and removes duplicate URLs", async () => {
    const { fetcher, requested } = mockFetcher({
      [`${ORIGIN}/robots.txt`]: {
        html: `User-agent: *\nDisallow: /nope\nSitemap: ${ORIGIN}/maps/root.xml\nSitemap: /maps/extra.xml\nSitemap: https://outside.example/sitemap.xml`,
      },
      [`${ORIGIN}/maps/root.xml`]: {
        html: sitemapIndex(`${ORIGIN}/maps/child.xml`, `${ORIGIN}/maps/root.xml`),
      },
      [`${ORIGIN}/maps/extra.xml`]: {
        html: urlSet(`${ORIGIN}/about`, `${ORIGIN}/files/scan.pdf`, "https://outside.example/a"),
      },
      [`${ORIGIN}/sitemap.xml`]: { status: 404, html: "" },
      [`${ORIGIN}/maps/child.xml`]: {
        html: urlSet(
          `${ORIGIN}/about#fragment`,
          `${ORIGIN}/medicine?search=a&sort=asc`,
          `${ORIGIN}/medicine?search=b`,
          `${ORIGIN}/assets/photo.png`,
        ),
      },
    });
    const result = await discoverSitemapUrls(`${ORIGIN}/start`, {}, fetcher);

    expect(result.sitemapUrls).toEqual([
      `${ORIGIN}/maps/root.xml`, `${ORIGIN}/maps/extra.xml`, `${ORIGIN}/maps/child.xml`,
    ]);
    expect(result.pageUrls).toEqual([
      `${ORIGIN}/about`, `${ORIGIN}/medicine?search=a&sort=asc`,
      `${ORIGIN}/medicine?search=b`,
    ]);
    expect(result.errors).toEqual([]);
    expect(requested).toEqual([
      `${ORIGIN}/robots.txt`,
      `${ORIGIN}/maps/root.xml`,
      `${ORIGIN}/maps/extra.xml`,
      `${ORIGIN}/sitemap.xml`,
      `${ORIGIN}/maps/child.xml`,
    ]);
    expect(requested).not.toContain("https://outside.example/sitemap.xml");
  });

  it("falls back to /sitemap.xml when robots.txt is missing", async () => {
    const { fetcher } = mockFetcher({
      [`${ORIGIN}/robots.txt`]: { status: 404, html: "" },
      [`${ORIGIN}/sitemap.xml`]: { html: urlSet(`${ORIGIN}/a`, `${ORIGIN}/b`) },
    });
    const result = await discoverSitemapUrls(`${ORIGIN}/products`, {}, fetcher);
    expect(result.pageUrls).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`]);
    expect(result.sitemapUrls).toEqual([`${ORIGIN}/sitemap.xml`]);
  });

  it("does not follow indexes or collect URLs outside the seed origin", async () => {
    const { fetcher, requested } = mockFetcher({
      [`${ORIGIN}/robots.txt`]: {
        html: "Sitemap: https://evil.example/index.xml\nSitemap: /local.xml",
      },
      [`${ORIGIN}/local.xml`]: {
        html: sitemapIndex("https://evil.example/other.xml", `${ORIGIN}/safe.xml`),
      },
      [`${ORIGIN}/sitemap.xml`]: { html: urlSet("https://evil.example/leak", `${ORIGIN}/ok`) },
      [`${ORIGIN}/safe.xml`]: { html: urlSet(`${ORIGIN}/another`) },
    });
    const result = await discoverSitemapUrls(`${ORIGIN}/`, {}, fetcher);
    expect(result.pageUrls).toEqual([`${ORIGIN}/ok`, `${ORIGIN}/another`]);
    expect(requested.every((url) => new URL(url).origin === ORIGIN)).toBe(true);
  });

  it("refuses redirects that leave the original origin", async () => {
    const { fetcher } = mockFetcher({
      [`${ORIGIN}/robots.txt`]: { status: 404, html: "" },
      [`${ORIGIN}/sitemap.xml`]: {
        html: urlSet("https://evil.example/leak"),
        finalUrl: "https://evil.example/sitemap.xml",
      },
    });
    const result = await discoverSitemapUrls(`${ORIGIN}/`, {}, fetcher);
    expect(result.pageUrls).toEqual([]);
    expect(result.errors).toMatchObject([{ code: "OUT_OF_SCOPE" }]);
  });

  it("skips unsupported .xml.gz and unknown XML", async () => {
    const { fetcher, requested } = mockFetcher({
      [`${ORIGIN}/robots.txt`]: { html: `Sitemap: ${ORIGIN}/compressed.xml.gz\nSitemap: ${ORIGIN}/broken.xml` },
      [`${ORIGIN}/broken.xml`]: { html: "<html>wrong document</html>" },
      [`${ORIGIN}/sitemap.xml`]: { status: 404, html: "" },
    });
    const result = await discoverSitemapUrls(`${ORIGIN}/`, {}, fetcher);
    expect(requested).not.toContain(`${ORIGIN}/compressed.xml.gz`);
    expect(result.errors.map((x) => x.code)).toEqual([
      "UNSUPPORTED_SITEMAP_FORMAT", "INVALID_SITEMAP",
    ]);
  });

  it("caps the number of sitemap requests and result URLs", async () => {
    const { fetcher, requested } = mockFetcher({
      [`${ORIGIN}/robots.txt`]: { status: 404, html: "" },
      [`${ORIGIN}/sitemap.xml`]: { html: sitemapIndex(`${ORIGIN}/a.xml`, `${ORIGIN}/b.xml`) },
      [`${ORIGIN}/a.xml`]: { html: urlSet(`${ORIGIN}/1`, `${ORIGIN}/2`, `${ORIGIN}/3`) },
    });
    const result = await discoverSitemapUrls(`${ORIGIN}/`, { maxSitemaps: 2, maxUrls: 2 }, fetcher);
    expect(result.pageUrls).toEqual([`${ORIGIN}/1`, `${ORIGIN}/2`]);
    expect(result.sitemapUrls).toHaveLength(2);
    expect(requested).not.toContain(`${ORIGIN}/b.xml`);
  });

  it("reports request errors without failing the entire sitemap discovery", async () => {
    const { fetcher } = mockFetcher({
      [`${ORIGIN}/robots.txt`]: { html: "Sitemap: /broken.xml" },
      [`${ORIGIN}/sitemap.xml`]: { html: urlSet(`${ORIGIN}/good`) },
    });
    const result = await discoverSitemapUrls(`${ORIGIN}/`, {}, fetcher);
    expect(result.pageUrls).toEqual([`${ORIGIN}/good`]);
    expect(result.errors).toMatchObject([{ url: `${ORIGIN}/broken.xml`, code: "FETCH_FAILED" }]);
  });

  it("stops discovery when robots.txt is rate limited", async () => {
    const { fetcher, requested } = mockFetcher({
      [`${ORIGIN}/robots.txt`]: { status: 429, html: "" },
    });
    const result = await discoverSitemapUrls(`${ORIGIN}/`, {}, fetcher);
    expect(result.pageUrls).toEqual([]);
    expect(result.errors.map((error) => error.code)).toEqual(["UPSTREAM_UNAVAILABLE"]);
    expect(requested).toEqual([`${ORIGIN}/robots.txt`]);
  });

  it("stops subsequent sitemap requests on rate limiting", async () => {
    const { fetcher, requested } = mockFetcher({
      [`${ORIGIN}/robots.txt`]: { html: "Sitemap: /busy.xml" },
      [`${ORIGIN}/busy.xml`]: { status: 429, html: "" },
    });
    const result = await discoverSitemapUrls(`${ORIGIN}/`, {}, fetcher);
    expect(result.pageUrls).toEqual([]);
    expect(result.errors.map((error) => error.code)).toEqual(["UPSTREAM_UNAVAILABLE"]);
    expect(requested).toEqual([`${ORIGIN}/robots.txt`, `${ORIGIN}/busy.xml`]);
  });

  it("validates bounds and the seed URL before making requests", async () => {
    const { fetcher, requested } = mockFetcher({});
    await expect(discoverSitemapUrls("http://localhost", {}, fetcher)).rejects.toThrow();
    await expect(discoverSitemapUrls(`${ORIGIN}/`, { maxSitemaps: 0 }, fetcher)).rejects.toThrow(RangeError);
    await expect(discoverSitemapUrls(`${ORIGIN}/`, { maxUrls: 5001 }, fetcher)).rejects.toThrow(RangeError);
    await expect(discoverSitemapUrls(`${ORIGIN}/`, { maxBytes: 30 }, fetcher)).rejects.toThrow(RangeError);
    await expect(discoverSitemapUrls(`${ORIGIN}/`, { timeoutMs: 999 }, fetcher)).rejects.toThrow(RangeError);
    expect(requested).toEqual([]);
  });
});
