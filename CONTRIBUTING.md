# Contributing

## Workflow

- Create focused branches from the agreed development branch.
- Use conventional commits, for example:
  - `feat(scraper): implement HTTP fetching`
  - `fix(crawler): respect Retry-After`
  - `test(extractor): cover malformed HTML`
- Keep pull requests small and linked to GitHub issues.
- Add or update tests for behavior changes.
- Never commit secrets, tokens, production data, or scraped data that you do not have rights to redistribute.

## Engineering principles

- HTTP first; browser rendering only when needed.
- Conservative resource use for Raspberry Pi 4 (8 GB RAM).
- Enforce crawl scope, page limits, timeouts, and response-size limits.
- Respect target-site policies and access restrictions.
- Treat all scraped content as untrusted input.
