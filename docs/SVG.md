# Safe SVG handling in scraped Markdown — Issue #50

SVG is a vector image format. Webpages commonly use it in two forms:
**linked SVG files** and **inline `<svg>...</svg>` markup**.

The Dox Scraper extraction/Markdown pipeline handles those differently
to preserve useful content without copying potentially executable SVG
XML into a model-facing result.

## Linked SVG image

An ordinary HTML image is preserved as a Markdown image reference:

```html
<img src="/assets/dose-chart.svg" alt="Dosage chart">
```

becomes:

```md
![Dosage chart](https://example.com/assets/dose-chart.svg)
```

The URL is resolved against the fetched page's final HTTP(S) URL.
Unsafe `data:`, `javascript:` and credential-bearing URLs do not
become image references. **The scraper does not download, rasterize,
inspect, or execute the linked SVG file.** Markdown consumers decide
whether and how to render the remote image; treat it as untrusted.

## Inline SVG

Inline SVG can include `<script>`, `<foreignObject>`, animation,
event handlers and external references. The extractor **never outputs
the SVG XML** and never interprets vector paths as text.

For a meaningful graphic:

```html
<svg role="img" aria-label="Dosage schedule">
  <path d="M0 0 L10 10"></path>
</svg>
```

the extracted text/Markdown contains:

```text
SVG image: Dosage schedule
```

Description precedence: `aria-label`, direct child `<title>`,
then direct child `<desc>`. The label is normalized, limited to
160 characters, and inserted as ordinary escaped text. Script,
foreign-object, path, embedded-link and handler markup never carries
through to the output. No network request is made for an SVG
reference or `<use>` element.

SVGs marked `aria-hidden="true"`, `role="presentation"` or
`role="none"`, or explicitly hidden with CSS `display:none` or
`visibility:hidden`, are discarded. Unlabeled SVG is also
discarded rather than emitting potentially noisy path data.

The independently callable `htmlToMarkdown()` converter applies
the same safe inline SVG treatment, even if the caller bypasses
`extractPage()`. This means standalone converter use doesn't emit
executable SVG markup.

## Deliberate limitations

- No SVG-to-PNG conversion, OCR, computer vision or diagram
  interpretation.
- No direct `image/svg+xml` scraping: `POST /v1/scrape`
  remains an HTML webpage extractor and rejects standalone SVG
  responses as an unsupported content type.
- Linked SVG URLs in Markdown are **references**, not verified
  safe files or downloaded assets.
- An unlabeled inline SVG cannot be reliably described from path
  geometry alone, so it is omitted.
- SVG descriptions are untrusted website content; a text label
  may be misleading and is **not** a source of executable actions.

## Verification

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

The extractor, standalone Markdown converter, and full API scrape
pipeline have tests for linked `.svg` images, accessible inline
graphics, hidden/decorative graphics, input length limits and
potentially executable SVG markup.
