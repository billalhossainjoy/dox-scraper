import { load } from "cheerio";
import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";
import { gfm } from "@truto/turndown-plugin-gfm";

export interface MarkdownOptions {
  /** Absolute URL of the extracted webpage; used to resolve relative links/images. */
  baseUrl: string;
  /** Upper bound for the resulting Markdown string (default: 250,000 chars). */
  maxCharacters?: number;
}

const MAX_ALLOWED_CHARACTERS = 1_000_000;

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



function resolveHttpUrl(raw: string | undefined, base: URL): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim(), base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Converts extracted HTML into readable Markdown for a permitted webpage.
 * HTML and linked resources are untrusted; this function does not retrieve
 * external resources, execute JavaScript, or perform browser rendering.
 */
export function htmlToMarkdown(html: string, options: MarkdownOptions): string {
  if (typeof html !== "string") {
    throw new TypeError("html must be a string");
  }
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute HTTP or HTTPS URL");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
    throw new TypeError("baseUrl must be an absolute HTTP or HTTPS URL without credentials");
  }

  const maxCharacters = options.maxCharacters ?? 250_000;
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > MAX_ALLOWED_CHARACTERS) {
    throw new RangeError("maxCharacters must be an integer from 1 to 1000000");
  }

  if (!html.trim()) return "";

  const $ = load(html);
  preserveSvgDescriptions($);
  $("script,style,noscript,iframe,object,embed,form,canvas,template").remove();

  // Relative links/images must resolve against the final page URL, not
  // the default HTML parser context (which has no browsing base).
  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const destination = resolveHttpUrl(anchor.attr("href"), base);
    if (destination) anchor.attr("href", destination);
    else anchor.removeAttr("href");
  });

  $("img[src]").each((_, element) => {
    const picture = $(element);
    const destination = resolveHttpUrl(picture.attr("src"), base);
    if (destination) picture.attr("src", destination);
    else picture.remove();
  });

  // Even when the upstream extractor sanitizes HTML, make the converter
  // safe to call independently with raw untrusted HTML.
  const safeHtml = sanitizeHtml($.root().html() ?? "", {
    allowedTags: [
      "h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "span",
      "article", "main", "section", "br", "hr", "strong", "b",
      "em", "i", "ul", "ol", "li", "blockquote", "pre", "code",
      "a", "img", "table", "thead", "tbody", "tfoot", "tr",
      "th", "td", "del", "s", "sup", "sub", "figure", "figcaption",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title"],
      th: ["colspan", "rowspan"],
      td: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https"],
    disallowedTagsMode: "discard",
  });

  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    strongDelimiter: "**",
    emDelimiter: "*",
    linkStyle: "inlined",
  });
  turndown.use(gfm);

  const markdown = turndown.turndown(safeHtml).trim();
  if (markdown.length <= maxCharacters) return markdown;
  return markdown.slice(0, maxCharacters).trimEnd();
}
