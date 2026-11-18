# Safe SVG descriptions in extracted Markdown — Issue #50

Dox Scraper treats all HTML and SVG markup from scraped websites as **untrusted**.
It does not download or execute SVG files. Its purpose is to return meaningful
accessible text where possible, not to render or understand vector geometry.

## Inline SVG

Both `@dox-scraper/extractor` and the standalone
`@dox-scraper/markdown` converter apply the same conservative policy:

1. Discard graphics with `aria-hidden="true"`, a `hidden` attribute or
   the decorative/presentation roles `none`, `presentation` or `decorative`.
2. Read the **first nonempty** value in this order:
   `aria-label`, immediate child `<title>`, then immediate child `<desc>`.
3. Strip unsafe script/style/foreign-object subtrees before interpreting
   nested descriptions.
4. Normalize whitespace and control/bidirectional characters, preserve at
   most **240 Unicode code points** per description, and preserve descriptions
   for at most **100 inline SVGs** per page.
5. Replace a meaningful SVG with an escaped text-only HTML span before the
   final allowed-HTML sanitization and Markdown conversion. Discard unlabeled
   graphics instead of exposing vector path data.

Examples:

```html
<svg role="img" aria-label="Weekly sales increased 12%">
  <path d="M1 2..." />
</svg>
```

becomes text containing `Weekly sales increased 12%` — not inline SVG XML.

No `<svg>`, `<path>`, `<script>`, `foreignObject` or event handlers are
preserved from SVG. Title/description strings remain **untrusted website
content** even when sanitized; do not treat them as instructions.

The Markdown converter applies the same policy when used independently
on raw HTML, not just when called after the extractor. The existing
`maxCharacters` Markdown limit also applies to SVG descriptions.

## External SVG image links

An ordinary HTML image like:

```html
<img src="/images/chart.svg" alt="Revenue chart">
```

may become:

```markdown
![Revenue chart](https://example.com/images/chart.svg)
```

when the source page URL is HTTPS. The image URL is resolved against
the final page URL and must use HTTP(S) without embedded credentials.
URLs with `data:`, `javascript:` or other unsafe schemes are discarded.
Image references are **not fetched or rendered** by the converter,
and they are **not proof that the remote SVG content is safe**.

## Limitations

- No SVG rasterization, screenshot generation, OCR, image downloads,
  color/shape interpretation, rendering or execution.
- Does not scrape a direct SVG URL as an image-analysis endpoint.
- Does not resolve `aria-labelledby` references or infer descriptions
  from `path`, `text`, `use` or external linked vector geometry.
- Only immediate child SVG `title` and `desc` are used as fallback
  description sources.
- A text-only accessible description may omit visual information.
- The existing API schema and page-fetching permissions are unchanged.

## Tests

```bash
pnpm --filter @dox-scraper/extractor test
pnpm --filter @dox-scraper/markdown test
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

The tests cover hidden and decorative SVG, markup injection,
script/foreign-object content, relative `.svg` image references,
unsafe URL schemes, description counts, length caps and standalone
Markdown conversion.
