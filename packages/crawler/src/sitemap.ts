import { load } from "cheerio";
import { fetchPage, validateTargetUrl, type FetchPageResult } from "@dox-scraper/fetcher";
import { normalizeCrawlUrl } from "./links.js";

export interface SitemapDiscoveryOptions {
  /** Maximum XML sitemap documents to request; defaults to 10, maximum 50. */
  maxSitemaps?: number;
  /** Maximum distinct page URLs to return; defaults to 1000, maximum 5000. */
  maxUrls?: number;
  /** Timeout for each request, in milliseconds; defaults to 15000. */
  timeoutMs?: number;
  /** Maximum bytes per sitemap document; defaults to 1 MiB, maximum 2 MiB. */
  maxBytes?: number;
}

export interface SitemapDiscoveryError {
  url: string;
  code: string;
  message: string;
}

export interface SitemapDiscoveryResult {
  seedUrl: string;
  robotsUrl: string;
  /** URLs of XML sitemap documents successfully parsed. */
  sitemapUrls: string[];
  /** Deduplicated pages confined to the original origin. */
  pageUrls: string[];
  /** Non-fatal errors, including skipped unsupported sitemap formats. */
  errors: SitemapDiscoveryError[];
}

export interface ParsedSitemap {
  type: "urlset" | "sitemapindex" | "unknown";
  locations: string[];
}

export type SitemapFetcher = (
  url: string,
  options: { timeoutMs: number; maxBytes: number; maxRedirects: number },
) => Promise<FetchPageResult>;

function validOptions(options: SitemapDiscoveryOptions) {
  const maxSitemaps = options.maxSitemaps ?? 10;
  const maxUrls = options.maxUrls ?? 1000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 1024 * 1024;

  if (!Number.isInteger(maxSitemaps) || maxSitemaps < 1 || maxSitemaps > 50) {
    throw new RangeError("maxSitemaps must be an integer between 1 and 50");
  }
  if (!Number.isInteger(maxUrls) || maxUrls < 1 || maxUrls > 5000) {
    throw new RangeError("maxUrls must be an integer between 1 and 5000");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) {
    throw new RangeError("timeoutMs must be an integer between 1000 and 30000");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 2 * 1024 * 1024) {
    throw new RangeError("maxBytes must be an integer between 1024 and 2097152");
  }
  return { maxSitemaps, maxUrls, timeoutMs, maxBytes };
}

function sameOriginUrl(candidate: string, base: URL, allowedOrigin: string): string | null {
  try {
    const target = validateTargetUrl(new URL(candidate, base));
    return target.origin === allowedOrigin ? target.href : null;
  } catch {
    return null;
  }
}

function rootName(tag: unknown): string {
  if (typeof tag !== "object" || tag === null || !("tagName" in tag)) return "";
  const name = tag.tagName;
  return typeof name === "string" ? (name.split(":").pop() ?? "").toLowerCase() : "";
}

/** Pure, offline XML parser for regular sitemaps and sitemap indexes. */
export function parseSitemapXml(xml: string): ParsedSitemap {
  // Cheerio/htmlparser2 does not expand remote XML entities or fetch external DTDs.
  const $ = load(xml, { xmlMode: true });
  const root = $.root().children().toArray().find((node) => rootName(node) !== "");
  const type = rootName(root);
  if (type !== "urlset" && type !== "sitemapindex") {
    return { type: "unknown", locations: [] };
  }

  const entry = type === "urlset" ? "url" : "sitemap";
  const locations: string[] = [];
  for (const node of $(root).children().toArray()) {
    if (rootName(node) !== entry) continue;
    const location = $(node).children().toArray().find((child) => rootName(child) === "loc");
    const value = location ? $(location).text().trim() : "";
    if (value) locations.push(value);
  }
  return { type, locations };
}

/** Read Sitemap declarations (case-insensitive) without interpreting robots rules. */
export function parseRobotsSitemaps(body: string): string[] {
  const output: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const withoutComment = line.split("#", 1)[0]?.trim() ?? "";
    const match = /^sitemap\s*:\s*(\S+)\s*$/i.exec(withoutComment);
    if (match?.[1]) output.push(match[1]);
  }
  return output;
}

function isSupportedSitemap(url: string): boolean {
  // .xml.gz and other compressed sitemap files need decompression support;
  // fail closed instead of treating compressed bytes as plain XML.
  return !/\.gz$/i.test(new URL(url).pathname);
}

function errorCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error &&
      typeof error.code === "string") return error.code;
  return "FETCH_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Sitemap request failed";
}

/**
 * Discover sitemap URLs from robots.txt and the conventional /sitemap.xml,
 * then traverse sitemap indexes and collect same-origin page URLs.
 *
 * Only sequential, bounded HTTP fetches. No crawling, rate-limit bypass,
 * or robots.txt Allow/Disallow enforcement is performed in this function.
 * Callers must apply appropriate site permissions and request pacing.
 */
export async function discoverSitemapUrls(
  seedUrl: string,
  options: SitemapDiscoveryOptions = {},
  fetcher: SitemapFetcher = fetchPage,
): Promise<SitemapDiscoveryResult> {
  const seed = validateTargetUrl(seedUrl);
  const limits = validOptions(options);
  const robotsUrl = new URL("/robots.txt", seed.origin).href;
  const queue: string[] = [];
  const queued = new Set<string>();
  const visited = new Set<string>();
  const pageSeen = new Set<string>();
  const pageUrls: string[] = [];
  const sitemapUrls: string[] = [];
  const errors: SitemapDiscoveryError[] = [];

  function enqueue(candidate: string, base: URL): void {
    const url = sameOriginUrl(candidate, base, seed.origin);
    if (!url || queued.has(url) || visited.has(url)) return;
    if (!isSupportedSitemap(url)) {
      errors.push({ url, code: "UNSUPPORTED_SITEMAP_FORMAT", message: "Compressed .gz sitemaps are not yet supported" });
      return;
    }
    // This cap also bounds memory used by malicious or enormous sitemap indexes.
    if (queued.size >= limits.maxSitemaps * 20) return;
    queued.add(url);
    queue.push(url);
  }

  // A robots.txt file can declare sitemaps in unusual locations. Limit its
  // response body separately to prevent unbounded memory consumption.
  try {
    const robots = await fetcher(robotsUrl, {
      timeoutMs: limits.timeoutMs,
      maxBytes: Math.min(256 * 1024, limits.maxBytes),
      maxRedirects: 2,
    });
    if (robots.statusCode === 200 && new URL(robots.finalUrl).origin === seed.origin) {
      for (const location of parseRobotsSitemaps(robots.html).slice(0, limits.maxSitemaps * 20)) {
        enqueue(location, new URL(robots.finalUrl));
      }
    }
  } catch (error) {
    errors.push({ url: robotsUrl, code: errorCode(error), message: errorMessage(error) });
  }

  enqueue(new URL("/sitemap.xml", seed.origin).href, seed);

  // Each index counts toward maxSitemaps. The loop cannot fan out forever.
  while (queue.length > 0 && sitemapUrls.length < limits.maxSitemaps && visited.size < limits.maxSitemaps) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    try {
      const response = await fetcher(current, {
        timeoutMs: limits.timeoutMs,
        maxBytes: limits.maxBytes,
        maxRedirects: 2,
      });
      if (response.statusCode !== 200) {
        if (response.statusCode !== 404) {
          errors.push({ url: current, code: "HTTP_ERROR", message: `Sitemap returned HTTP ${response.statusCode}` });
        }
        continue;
      }
      const final = sameOriginUrl(response.finalUrl, seed, seed.origin);
      if (!final || !isSupportedSitemap(final)) {
        errors.push({ url: current, code: "OUT_OF_SCOPE", message: "Sitemap redirected outside the original origin or to an unsupported format" });
        continue;
      }
      const parsed = parseSitemapXml(response.html);
      if (parsed.type === "unknown") {
        errors.push({ url: current, code: "INVALID_SITEMAP", message: "Response is not a sitemapindex or urlset XML document" });
        continue;
      }
      sitemapUrls.push(final);

      if (parsed.type === "sitemapindex") {
        for (const location of parsed.locations) enqueue(location, new URL(final));
      } else {
        for (const location of parsed.locations) {
          if (pageUrls.length >= limits.maxUrls) break;
          // normalizeCrawlUrl also filters unsupported assets and private IPs.
          const page = normalizeCrawlUrl(location, final);
          if (!page || new URL(page).origin !== seed.origin || pageSeen.has(page)) continue;
          pageSeen.add(page);
          pageUrls.push(page);
        }
      }
      if (pageUrls.length >= limits.maxUrls) break;
    } catch (error) {
      errors.push({ url: current, code: errorCode(error), message: errorMessage(error) });
    }
  }
  return { seedUrl: seed.href, robotsUrl, sitemapUrls, pageUrls, errors };
}
