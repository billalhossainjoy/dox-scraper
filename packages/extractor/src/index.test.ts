import { describe, expect, it } from "vitest";
import { extractPage } from "./index.js";

const source = "https://example.com/blog/post";

const fixture = `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>  Example   Article </title>
    <meta name="description" content="  A sample description ">
    <link rel="canonical" href="/blog/post?ref=canonical">
  </head>
  <body>
    <header><h1>Site Logo</h1></header>
    <nav><a href="/menu">Navigation</a></nav>
    <main>
      <article>
        <h1>How scraping works</h1>
        <p>Useful first paragraph.</p>
        <h2>Second section</h2>
        <p>Useful second paragraph.</p>
        <a href="/guide#section">Read guide</a>
        <a href="/guide#next">Duplicate guide</a>
        <a href="https://other.example/news">Outside</a>
        <a href="javascript:alert(1)">Unsafe</a>
        <img src="https://example.com/picture.jpg" alt="Picture" onerror="alert(1)">
        <p onclick="alert(1)">Safe text <strong>and emphasis</strong>.</p>
        <script>alert("bad")</script>
        <aside>Unwanted widget</aside>
      </article>
    </main>
    <footer>Unwanted footer</footer>
  </body>
</html>`;

describe("extractPage", () => {
  it("extracts metadata, headings and main content", () => {
    const result = extractPage(fixture, source);
    expect(result.title).toBe("Example Article");
    expect(result.description).toBe("A sample description");
    expect(result.language).toBe("en");
    expect(result.canonicalUrl).toBe("https://example.com/blog/post?ref=canonical");
    expect(result.headings).toEqual([
      { level: 1, text: "How scraping works" },
      { level: 2, text: "Second section" },
    ]);
    expect(result.contentText).toContain("Useful first paragraph.");
    expect(result.contentText).toContain("Useful second paragraph.");
    expect(result.contentText).not.toContain("Unwanted footer");
    expect(result.contentText).not.toContain("Unwanted widget");
    expect(result.contentText).not.toContain("Site Logo");
  });

  it("resolves relative links, deduplicates fragments, and excludes unsafe protocols", () => {
    const result = extractPage(fixture, source);
    expect(result.links).toEqual([
      { url: "https://example.com/guide", text: "Read guide", external: false },
      { url: "https://other.example/news", text: "Outside", external: true },
    ]);
  });

  it("sanitizes executable HTML and event handlers", () => {
    const result = extractPage(fixture, source);
    expect(result.contentHtml).not.toContain("<script");
    expect(result.contentHtml).not.toContain("onerror=");
    expect(result.contentHtml).not.toContain("onclick=");
    expect(result.contentHtml).not.toContain("javascript:");
    expect(result.contentHtml).toContain("<strong>and emphasis</strong>");
  });

  it("falls back to h1 when page title is missing", () => {
    const result = extractPage("<html><body><h1>Medicine A</h1><p>Tablet 500 mg</p></body></html>", source);
    expect(result.title).toBe("Medicine A");
    expect(result.contentText).toContain("Tablet 500 mg");
  });

  it("handles malformed HTML and missing metadata", () => {
    const result = extractPage("<html><body><main><p>Not closed", source);
    expect(result.title).toBeNull();
    expect(result.description).toBeNull();
    expect(result.canonicalUrl).toBeNull();
    expect(result.contentText).toBe("Not closed");
  });

  it("rejects a non-HTTP source URL", () => {
    expect(() => extractPage("<p>hello</p>", "file:///etc/passwd")).toThrow(
      "source must be an absolute HTTP or HTTPS URL",
    );
  });
});
