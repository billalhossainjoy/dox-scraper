import { load } from "cheerio";
import { validateTargetUrl } from "@dox-scraper/fetcher";

export interface DiscoveredLink {
  /** Normalized absolute HTTP(S) URL without a fragment. */
  url: string;
  /** Anchor text, aria-label, title, or image alt text. */
  text: string;
}

export interface LinkDiscoveryOptions {
  /** Crawl seed URL; defaults to the URL of the page being parsed. */
  allowedOrigin?: string;
  /** Max distinct links returned, 1-5000, defaults to 1000. */
  maxLinks?: number;
  /** Ignore anchors declaring rel=nofollow; defaults to true. */
  respectNoFollow?: boolean;
}

const NON_HTML_EXTENSIONS = new Set([
  "pdf", "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico",
  "mp3", "mp4", "m4a", "wav", "ogg", "webm", "mov", "avi", "mkv",
  "woff", "woff2", "ttf", "otf", "eot",
  "zip", "tar", "gz", "tgz", "bz2", "7z", "rar",
  "csv", "xml", "json", "js", "css", "map", "wasm",
  "exe", "dmg", "deb", "rpm", "apk", "ipa",
  "doc", "docx", "ppt", "pptx", "xls", "xlsx",
]);

function isNonHtmlAsset(url: URL): boolean {
  const lastSegment = url.pathname.split("/").pop() ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(lastSegment);
  } catch {
    return true;
  }
  const extension = decoded.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return extension !== undefined && NON_HTML_EXTENSIONS.has(extension);
}

function normalizeCandidate(href: string, page: URL): URL | null {
  const value = href.trim();
  if (!value) return null;

  try {
    const candidate = validateTargetUrl(new URL(value, page));
    return isNonHtmlAsset(candidate) ? null : candidate;
  } catch {
    // Invalid URL, unsupported scheme, credentials, or non-public IP.
    return null;
  }
}

/**
 * Normalize a candidate link against a fetched page.
 * This does not authorize fetching: apply robots.txt and rate limits later.
 */
export function normalizeCrawlUrl(href: string, pageUrl: string): string | null {
  const page = validateTargetUrl(pageUrl);
  return normalizeCandidate(href, page)?.href ?? null;
}

/**
 * Discover same-origin links in raw HTML without contacting the network.
 * The seed origin is compared by scheme, hostname AND port. Query strings
 * are preserved but URL fragments are stripped for deduplication.
 */
export function discoverSameOriginLinks(
  html: string,
  pageUrl: string,
  options: LinkDiscoveryOptions = {},
): DiscoveredLink[] {
  const page = validateTargetUrl(pageUrl);
  const crawlOrigin = validateTargetUrl(options.allowedOrigin ?? pageUrl).origin;
  const maxLinks = options.maxLinks ?? 1000;

  if (!Number.isInteger(maxLinks) || maxLinks < 1 || maxLinks > 5000) {
    throw new RangeError("maxLinks must be an integer between 1 and 5000");
  }
  // A redirect outside the seed origin must not expand our crawl scope.
  if (page.origin !== crawlOrigin) return [];

  const $ = load(html);
  const results: DiscoveredLink[] = [];
  const seen = new Set<string>([page.href]);
  const respectNoFollow = options.respectNoFollow ?? true;

  for (const element of $("a[href]").toArray()) {
    if (results.length >= maxLinks) break;
    const anchor = $(element);
    const href = anchor.attr("href");
    if (!href) continue;

    const rel = (anchor.attr("rel") ?? "").toLowerCase().split(/\s+/);
    if (respectNoFollow && rel.includes("nofollow")) continue;

    const target = normalizeCandidate(href, page);
    if (!target || target.origin !== crawlOrigin || seen.has(target.href)) continue;
    seen.add(target.href);

    const text = (
      anchor.text() ||
      anchor.attr("aria-label") ||
      anchor.attr("title") ||
      anchor.find("img[alt]").first().attr("alt") ||
      ""
    ).replace(/\s+/g, " ").trim();
    results.push({ url: target.href, text });
  }
  return results;
}
