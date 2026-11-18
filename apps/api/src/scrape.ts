import { fetchPage } from "@dox-scraper/fetcher";
import { extractPage, type ExtractedHeading, type ExtractedLink } from "@dox-scraper/extractor";
import { htmlToMarkdown } from "@dox-scraper/markdown";

export interface ScrapeOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  maxCharacters?: number;
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
}

export class ScrapeServiceError extends Error {
  constructor(
    public readonly code: "UPSTREAM_RATE_LIMITED" | "UPSTREAM_HTTP_ERROR" | "UNSUPPORTED_CONTENT_TYPE",
    public readonly httpStatus: 429 | 502,
    message: string,
  ) {
    super(message);
    this.name = "ScrapeServiceError";
  }
}

/** Single-page scraping orchestration; no crawling or browser fallback yet. */
export async function scrapePage(url: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
  const response = await fetchPage(url, {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    maxRedirects: options.maxRedirects,
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

  const extracted = extractPage(response.html, response.finalUrl);
  const markdown = htmlToMarkdown(extracted.contentHtml, {
    baseUrl: response.finalUrl,
    maxCharacters: options.maxCharacters,
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
  };
}
