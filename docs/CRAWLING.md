# Link discovery — Issue #9

The `@dox-scraper/crawler` package currently provides offline
same-origin URL discovery. It does not perform network requests.

```ts
import { discoverSameOriginLinks } from "@dox-scraper/crawler";

const html = '<a href="/news">News</a><a href="https://other.org">External</a>';
const links = discoverSameOriginLinks(html, "https://example.com/start", {
  allowedOrigin: "https://example.com/",
  maxLinks: 100,
});
// [{ url: "https://example.com/news", text: "News" }]
```

Discovered URLs are normalized against the fetched page's URL: HTTP(S)
only, with no embedded credentials, no fragments, and query strings
preserved. By default, rel=nofollow links and obvious non-HTML assets
are excluded. Subdomains and different ports are outside the scope.

**Important:** Discovery does not authorize fetching. The upcoming
crawler must enforce site terms, robots.txt, per-domain rate limits,
timeouts, SSRF checks, and a bounded job queue before requesting URLs.
Do not expose unrestricted crawling publicly.

## Sitemap discovery — Issue #10

Discover sitemap documents declared in `robots.txt` and the conventional
`/sitemap.xml`; recursively parse regular XML `urlset` and
`sitemapindex` documents with a bounded, sequential request budget.

```ts
import { discoverSitemapUrls } from "@dox-scraper/crawler";

const result = await discoverSitemapUrls("https://example.com/", {
  maxSitemaps: 10,
  maxUrls: 1000,
  timeoutMs: 15000,
  maxBytes: 1048576,
});
console.log(result.pageUrls);
console.log(result.errors);
```

Only sitemap documents and page URLs on the seed's **exact origin** are
accepted; external sitemap declarations and cross-origin page URLs are
excluded. Requests use the existing SSRF-resistant HTTP fetcher.
The parser removes fragments, deduplicates URLs, and excludes common
non-HTML assets. A missing robots.txt file is not fatal; the fallback
`/sitemap.xml` is still checked. HTTP 429/503 stops further requests.
Compressed `.xml.gz` sitemaps are not yet supported; such declarations
are reported as unsupported rather than decoded.

Defaults are 10 sitemap documents, 1,000 discovered page URLs, 15 seconds
per request, and 1 MiB per sitemap body. Allowed maxima are 50 documents,
5,000 URLs, 30 seconds and 2 MiB. This operation still needs robots.txt
**Allow/Disallow enforcement**, per-domain pacing and a real crawl queue
before it should power an externally accessible crawl endpoint.
