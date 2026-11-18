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
