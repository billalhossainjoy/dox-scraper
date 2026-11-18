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
  "svg", "canvas", "nav", "footer", "header", "aside", "form",
  "dialog", "[hidden]", "[aria-hidden='true']",
  ".cookie-banner", ".cookie-consent", ".advertisement", ".ads",
  "[role='navigation']", "[role='banner']", "[role='complementary']",
];

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
 * Inline SVG can contain executable/embedded markup. Only extract a short
 * accessible label as inert text; never serialize its tags or references.
 * Unlabeled/decorative SVG is discarded as before.
 */
function replaceInlineSvg($: ReturnType<typeof load>): void {
  $("svg").each((_, node) => {
    const svg = $(node);
    const role = (svg.attr("role") ?? "").toLowerCase().trim();
    const style = (svg.attr("style") ?? "").toLowerCase();
    if (svg.attr("aria-hidden")?.toLowerCase() === "true" ||
        ["presentation", "none"].includes(role) ||
        /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:;|$)/.test(style)) {
      svg.remove();
      return;
    }
    // Do not allow script/style/foreignObject content inside an SVG label.
    svg.find("script,style,foreignObject,foreignobject").remove();
    const label = firstNonempty(
      svg.attr("aria-label"),
      svg.children("title").first().text(),
      svg.children("desc").first().text(),
    );
    if (!label) {
      svg.remove();
      return;
    }
    const clean = Array.from(label).filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    }).join("").slice(0, 160).trim();
    if (clean) svg.replaceWith($("<span></span>").text("SVG image: " + clean));
    else svg.remove();
  });
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

  replaceInlineSvg($);
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
