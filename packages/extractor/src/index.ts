import { load } from "cheerio";
import sanitizeHtml from "sanitize-html";

export interface ExtractedHeading {
  level: number;
  text: string;
}

export interface ExtractedLink {
  url: string;
  text: string;
  external: boolean;
}

export interface ExtractedPage {
  sourceUrl: string;
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  language: string | null;
  headings: ExtractedHeading[];
  links: ExtractedLink[];
  contentHtml: string;
  contentText: string;
}

const NOISE_ELEMENTS = [
  "script", "style", "noscript", "template", "iframe", "object", "embed",
  "canvas", "nav", "footer", "header", "aside", "form",
  "dialog", "[hidden]", "[aria-hidden='true']",
  ".cookie-banner", ".cookie-consent", ".advertisement", ".ads",
  "[role='navigation']", "[role='banner']", "[role='complementary']",
];

const MAX_SVG_DESCRIPTIONS = 100;
const MAX_SVG_DESCRIPTION_CHARACTERS = 240;

/**
 * Replace meaningful inline SVG elements with bounded, escaped text.
 * Do not serialize or render any SVG markup. The same boundary is applied
 * in both extraction and independently invoked Markdown conversion.
 */
function preserveSvgDescriptions($: ReturnType<typeof load>): void {
  let preserved = 0;
  $("svg").each((_, element) => {
    const svg = $(element);
    // Outer SVGs own their subtrees. Avoid processing detached nested SVGs.
    if (svg.parents("svg").length > 0) return;
    const role = (svg.attr("role") ?? "").toLowerCase().trim();
    if (svg.is("[hidden]") ||
        (svg.attr("aria-hidden") ?? "").toLowerCase().trim() === "true" ||
        role === "presentation" || role === "none" || role === "decorative") {
      svg.remove();
      return;
    }
    // These subtree types can hide script or attacker-controlled content
    // in otherwise accessible <title>/<desc> descriptions.
    svg.find("script,style,foreignObject,foreignobject,iframe,object,embed,template").remove();
    const descriptions = [
      svg.attr("aria-label"),
      svg.children("title").first().text(),
      svg.children("desc").first().text(),
    ];
    let label = "";
    for (const value of descriptions) {
      const candidate = (value ?? "")
        .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
        .replace(/\s+/g, " ").trim();
      if (candidate) {
        label = Array.from(candidate).slice(0, MAX_SVG_DESCRIPTION_CHARACTERS).join("");
        break;
      }
    }
    if (!label || preserved >= MAX_SVG_DESCRIPTIONS) {
      svg.remove();
      return;
    }
    // Cheerio .text() escapes HTML metacharacters. No SVG attributes,
    // event handlers, paths, scripts or XML make it past this point.
    const textNode = $("<span></span>").text(label);
    svg.replaceWith(textNode);
    preserved += 1;
  });
}

const CONTENT_SELECTORS = [
  "article", "main", "[role='main']", "[itemprop='articleBody']",
  ".article-content", ".post-content", ".entry-content",
  "#main-content", "#content", "body",
];

function cleanInlineText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function firstNonempty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const cleaned = cleanInlineText(value);
    if (cleaned) return cleaned;
  }
  return null;
}

function toHttpUrl(value: string | undefined, baseUrl: URL): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim(), baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Parse HTML and extract page metadata, main content, headings and navigable links.
 * The contentHtml field is restricted to a small, safe HTML subset for downstream
 * transformation. Treat ALL scraped text and links as untrusted input.
 */
export function extractPage(html: string, source: string): ExtractedPage {
  const baseUrl = new URL(source);
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
    throw new Error("source must be an absolute HTTP or HTTPS URL");
  }

  const $ = load(html);

  // Read metadata before removing layout and script/style elements.
  const title = firstNonempty(
    $("head title").first().text(),
    $('meta[property="og:title"]').attr("content"),
    $('meta[name="twitter:title"]').attr("content"),
    $("h1").first().text(),
  );
  const description = firstNonempty(
    $('meta[name="description"]').attr("content"),
    $('meta[property="og:description"]').attr("content"),
    $('meta[name="twitter:description"]').attr("content"),
  );
  const canonicalUrl = toHttpUrl($('link[rel~="canonical"]').first().attr("href"), baseUrl);
  const language = firstNonempty($("html").attr("lang"));

  preserveSvgDescriptions($);
  $(NOISE_ELEMENTS.join(",")).remove();

  let contentSelector = "body";
  for (const selector of CONTENT_SELECTORS) {
    const element = $(selector).first();
    if (element.length > 0 && cleanInlineText(element.text()).length > 0) {
      contentSelector = selector;
      break;
    }
  }
  const content = $(contentSelector).first();

  const headings: ExtractedHeading[] = content
    .find("h1,h2,h3,h4,h5,h6")
    .toArray()
    .slice(0, 100)
    .map((node) => {
      const element = $(node);
      return {
        level: Number(node.tagName.slice(1)),
        text: cleanInlineText(element.text()),
      };
    })
    .filter((item) => item.text.length > 0);

  const links: ExtractedLink[] = [];
  const seen = new Set<string>();

  for (const node of content.find("a[href]").toArray()) {
    if (links.length >= 500) break;
    const anchor = $(node);
    const url = toHttpUrl(anchor.attr("href"), baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    links.push({
      url,
      text: firstNonempty(anchor.text(), anchor.attr("aria-label"), anchor.attr("title"), anchor.find("img").first().attr("alt")) ?? "",
      external: new URL(url).origin !== baseUrl.origin,
    });
  }

  // Sanitize before producing portable HTML. Do not preserve executable markup.
  const contentHtml = sanitizeHtml(content.html() ?? "", {
    allowedTags: [
      "p", "div", "span", "section", "article", "main", "h1", "h2", "h3",
      "h4", "h5", "h6", "br", "hr", "strong", "b", "em", "i", "u",
      "ul", "ol", "li", "blockquote", "pre", "code", "a", "img",
      "table", "thead", "tbody", "tfoot", "tr", "td", "th",
      "figure", "figcaption", "sup", "sub", "del", "s", "details", "summary",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https"],
    disallowedTagsMode: "discard",
  });

  const $content = load('<body>' + contentHtml + '</body>');
  $content("br").replaceWith("\n");
  $content("p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,tr").each((_, element) => {
    $content(element).before("\n");
    $content(element).after("\n");
  });

  const contentText = $content("body")
    .text()
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    sourceUrl: baseUrl.href,
    title,
    description,
    canonicalUrl,
    language,
    headings,
    links,
    contentHtml,
    contentText,
  };
}
