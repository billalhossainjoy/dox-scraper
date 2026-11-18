import { CrawlJob, type CrawlJobOptions } from "@dox-scraper/crawler";
import { extractPage } from "@dox-scraper/extractor";
import { htmlToMarkdown } from "@dox-scraper/markdown";
import type { SqliteCrawlStore } from "./index.js";

/**
 * Create a crawl with durable job/page checkpoints and extracted content.
 * The caller must still supply site-permission checks, a real rate limiter,
 * and an SSRF-safe loader with redirect following disabled.
 *
 * This does not start jobs automatically and does not create API routes.
 */
export function createPersistedCrawlJob(
  store: SqliteCrawlStore,
  options: CrawlJobOptions,
): CrawlJob {
  const externalSnapshot = options.onSnapshot;
  const externalPage = options.onPage;

  const job = new CrawlJob({
    ...options,
    onSnapshot(snapshot) {
      store.saveSnapshot(snapshot);
      externalSnapshot?.(snapshot);
    },
    async onPage(page, signal) {
      signal.throwIfAborted();
      if (externalPage) await externalPage(page, signal);
      signal.throwIfAborted();
      const extracted = extractPage(page.html, page.finalUrl);
      const markdown = htmlToMarkdown(extracted.contentHtml, {
        baseUrl: page.finalUrl,
        maxCharacters: 100_000,
      });
      store.savePageResult({
        jobId: job.id,
        url: page.url,
        markdown,
        contentText: extracted.contentText.slice(0, 100_000),
        metadata: {
          title: extracted.title,
          description: extracted.description,
          canonicalUrl: extracted.canonicalUrl,
          language: extracted.language,
          headings: extracted.headings.slice(0, 100),
          links: extracted.links.slice(0, 200),
          depth: page.depth,
          statusCode: page.statusCode,
        },
      });
    },
  });
  store.saveSnapshot(job.snapshot());
  return job;
}
