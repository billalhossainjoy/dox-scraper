import { McpServer } from "@modelcontextprotocol/server";
import { normalizeCrawlUrl } from "@dox-scraper/crawler";
import { validateTargetUrl } from "@dox-scraper/fetcher";
import * as z from "zod/v4";
import type { DoxApi } from "./api.js";

const targetUrl = z.string().trim().min(1).max(2048).url().refine(
  (value) => value.startsWith("http://") || value.startsWith("https://"),
  "Only HTTP and HTTPS targets are allowed",
);

const scrapeResult = z.object({
  requestedUrl: z.string(),
  finalUrl: z.string(),
  statusCode: z.number().int(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  markdown: z.string(),
  fetchedAt: z.string(),
  cache: z.object({ status: z.string() }).passthrough().optional(),
}).passthrough();

const discoveredLinks = z.object({
  finalUrl: z.string(),
  title: z.string().nullable(),
  links: z.array(z.object({
    url: z.string(),
    text: z.string(),
    external: z.boolean(),
  })).max(20_000),
}).passthrough();

const crawlSnapshot = z.object({
  id: z.string().uuid(),
  state: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
}).passthrough();

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

async function toolResult(fn: () => Promise<unknown>) {
  try { return text(await fn()); }
  catch (error) {
    // Returning a tool error preserves the actual upstream 401/403/429/503
    // semantics but never reveals token values or raw REST request headers.
    const code = error !== null && typeof error === "object" && "code" in error &&
      typeof error.code === "string" ? error.code : "MCP_REQUEST_FAILED";
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: code,
          message: error instanceof Error ? error.message.slice(0, 300) : "Tool request failed",
        }),
      }],
    };
  }
}

/** Create a testable MCP instance; all network operations go through DoxApi. */
export function createMcpServer(api: DoxApi): McpServer {
  const server = new McpServer({ name: "dox-scraper", version: "0.1.0" });

  server.registerTool("scrape_url", {
    title: "Scrape a webpage",
    description: "Use the authenticated Dox Scraper REST API to retrieve public HTML as Markdown. No direct MCP network scraping.",
    inputSchema: z.object({
      url: targetUrl,
      maxCharacters: z.number().int().min(1).max(60_000).default(20_000),
    }).strict(),
  }, async ({ url, maxCharacters }) => toolResult(async () => {
    validateTargetUrl(url);
    const page = scrapeResult.parse(await api.post("/v1/scrape", {
      url, options: {
        timeoutMs: 15_000,
        maxBytes: 1024 * 1024,
        maxCharacters,
        render: "http",
      },
    }));
    return {
      url: page.finalUrl,
      title: page.title,
      description: page.description,
      markdown: page.markdown,
      fetchedAt: page.fetchedAt,
      cache: page.cache ?? null,
    };
  }));

  server.registerTool("map_url", {
    title: "Map same-origin webpage links",
    description: "Discover up to 100 distinct, normalized same-origin links from one webpage using the authenticated single-page scrape endpoint. Does NOT spider a website or fetch its sitemap.",
    inputSchema: z.object({
      url: targetUrl,
      maxLinks: z.number().int().min(1).max(100).default(40),
    }).strict(),
  }, async ({ url, maxLinks }) => toolResult(async () => {
    // This makes exactly one authenticated scrape request; same-origin
    // mapping itself is offline and cannot request arbitrary discovered URLs.
    validateTargetUrl(url);
    const page = discoveredLinks.parse(await api.post("/v1/scrape", {
      url, options: {
        timeoutMs: 15_000,
        maxBytes: 1024 * 1024,
        maxCharacters: 1,
        render: "http",
      },
    }));
    const final = validateTargetUrl(page.finalUrl);
    const unique = new Set<string>();
    const links: Array<{ url: string; text: string }> = [];
    for (const link of page.links) {
      if (links.length >= maxLinks) break;
      if (link.external) continue;
      const normalized = normalizeCrawlUrl(link.url, final.href);
      if (!normalized || new URL(normalized).origin !== final.origin ||
          normalized === final.href || unique.has(normalized)) continue;
      unique.add(normalized);
      links.push({ url: normalized, text: link.text.slice(0, 200) });
    }
    return { url: final.href, title: page.title, total: links.length, links };
  }));

  server.registerTool("crawl_url", {
    title: "Start a bounded website crawl",
    description: "Submit a bounded asynchronous crawl through the existing authenticated REST endpoint. The operator must enable crawling, allowlist the origin and enforce robots.txt and rate limits.",
    inputSchema: z.object({
      url: targetUrl,
      maxPages: z.number().int().min(1).max(50).default(10),
      maxDepth: z.number().int().min(0).max(3).default(1),
    }).strict(),
  }, async ({ url, maxPages, maxDepth }) => toolResult(async () => {
    validateTargetUrl(url);
    const snapshot = crawlSnapshot.parse(await api.post("/v1/crawl", {
      url, maxPages, maxDepth,
    }));
    return { jobId: snapshot.id, state: snapshot.state,
      statusPath: "/v1/crawl/" + snapshot.id };
  }));

  server.registerTool("get_crawl_status", {
    title: "Get crawl-job progress",
    description: "Read the current state, page counts and per-page progress of a credential-owned crawl job. Does not read pages or bypass ownership checks.",
    inputSchema: z.object({
      jobId: z.string().uuid(),
    }).strict(),
  }, async ({ jobId }) => toolResult(async () => {
    const snapshot = crawlSnapshot.parse(await api.get(
      "/v1/crawl/" + encodeURIComponent(jobId),
    ));
    return snapshot;
  }));

  return server;
}
