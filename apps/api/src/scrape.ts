import { fetchPage, type FetchPageOptions, type FetchPageResult } from "@dox-scraper/fetcher";
import type { CacheMetadata } from "@dox-scraper/cache";
import { extractPage, type ExtractedHeading, type ExtractedLink } from "@dox-scraper/extractor";
import { htmlToMarkdown } from "@dox-scraper/markdown";

export interface ScrapeOptions {
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  maxRedirects?: number | undefined;
  maxCharacters?: number | undefined;
  /** Explicit opt-in: browser rendering is never selected automatically. */
  render?: "http" | "browser" | undefined;
}

export interface ScrapeResult {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  language: string | null;
  headings: ExtractedHeading[];
  links: ExtractedLink[];
  markdown: string;
  contentText: string;
  fetchedAt: string;
  redirectCount: number;
  /** Populated by the cached API service, omitted for uncached direct calls. */
  cache?: CacheMetadata;
  /** Set only when browser rendering was explicitly requested. */
  renderMode?: "browser";
}

export class ScrapeServiceError extends Error {
  constructor(
    public readonly code: "UPSTREAM_RATE_LIMITED" | "UPSTREAM_HTTP_ERROR" | "UNSUPPORTED_CONTENT_TYPE" |
      "BROWSER_DISABLED" | "BROWSER_NOT_ALLOWED",
    public readonly httpStatus: 403 | 429 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = "ScrapeServiceError";
  }
}

export type BrowserHtmlRenderer = (input: {
  url: string;
  html: string;
  totalTimeoutMs: number;
  maxHtmlBytes: number;
}) => Promise<{ html: string }>;

export type ScrapeFetcher = (
  url: string,
  options: FetchPageOptions,
) => Promise<FetchPageResult & { cache?: CacheMetadata }>;

/** Single-page scraping orchestration; no crawling or browser fallback yet. */
export async function scrapePage(
  url: string,
  options: ScrapeOptions = {},
  load: ScrapeFetcher = fetchPage,
  browserRender?: BrowserHtmlRenderer,
): Promise<ScrapeResult> {
  const response = await load(url, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
  });

  if (response.statusCode === 429) {
    throw new ScrapeServiceError(
      "UPSTREAM_RATE_LIMITED",
      429,
      "The target site is rate limiting requests. Respect its limits before retrying.",
    );
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new ScrapeServiceError(
      "UPSTREAM_HTTP_ERROR",
      502,
      `Target website returned HTTP ${response.statusCode}`,
    );
  }

  const mediaType = response.contentType?.split(";")[0]?.trim().toLowerCase();
  if (mediaType && mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
    throw new ScrapeServiceError(
      "UNSUPPORTED_CONTENT_TYPE",
      502,
      "Target response is not an HTML webpage",
    );
  }

  let html = response.html;
  if (options.render === "browser") {
    if (!browserRender) {
      throw new ScrapeServiceError(
        "BROWSER_DISABLED", 503, "Browser rendering is not configured",
      );
    }
    const rendered = await browserRender({
      url: response.finalUrl,
      html,
      totalTimeoutMs: options.timeoutMs ?? 15_000,
      maxHtmlBytes: options.maxBytes ?? 2 * 1024 * 1024,
    });
    html = rendered.html;
  }
  const extracted = extractPage(html, response.finalUrl);
  const markdown = htmlToMarkdown(extracted.contentHtml, {
    baseUrl: response.finalUrl,
    ...(options.maxCharacters !== undefined ? { maxCharacters: options.maxCharacters } : {}),
  });

  return {
    requestedUrl: response.requestedUrl,
    finalUrl: response.finalUrl,
    statusCode: response.statusCode,
    title: extracted.title,
    description: extracted.description,
    canonicalUrl: extracted.canonicalUrl,
    language: extracted.language,
    headings: extracted.headings,
    links: extracted.links,
    markdown,
    contentText: extracted.contentText,
    fetchedAt: response.fetchedAt,
    redirectCount: response.redirectCount,
    ...(response.cache ? { cache: response.cache } : {}),
    ...(options.render === "browser" ? { renderMode: "browser" as const } : {}),
  };
}
