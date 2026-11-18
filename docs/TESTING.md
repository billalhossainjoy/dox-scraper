# Testing strategy

Dox Scraper uses Vitest for tests. The tests should be **deterministic,
offline and safe to run from CI**. Do not scrape real production sites from
the automated test suite.

## Run locally

Install dependencies and build internal workspace packages before running
tests that import their compiled exports.

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

## Coverage by layer

- `packages/fetcher/src/index.test.ts`: URL validation, private/reserved
  address restrictions, redirect validation and response byte limits.
- `packages/extractor/src/index.test.ts`: Cheerio metadata extraction,
  HTML sanitation, boilerplate removal and link deduplication.
- `packages/markdown/src/index.test.ts`: HTML-to-Markdown formatting,
  GFM tables, code fences, unsafe markup removal and maximum output size.
- `apps/api/src/scrape-service.test.ts`: pipeline orchestration with a
  mocked fetcher.
- `apps/api/src/scrape.test.ts`: route validation, authentication and errors
  with an injected scrape service.
- `apps/api/src/scrape-integration.test.ts`: realistic fixture passes
  through Hono, the service, Cheerio and Markdown; only the outbound HTTP
  boundary is mocked.
- `apps/api/src/scrape-api-guards.test.ts`: body-size limits, concurrency
  controls and request option bounds.

## Adding regression tests

1. Save a minimal HTML fixture under `apps/api/test-fixtures/` if the bug
   involves an unexpected webpage structure.
2. Mock `fetchPage` for route and full-pipeline integration tests.
3. Assert the relevant security behavior and user-facing API response.
4. Add a focused unit test for lower-level parsing or validation bugs.
5. Run the full quality-check suite above.

Do not include secrets, user data or copyrighted medicine-database dumps
in fixtures. The sample entries in this repository are fictional.
