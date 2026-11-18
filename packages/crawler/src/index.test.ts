import { describe, expect, it } from "vitest";
import { discoverSameOriginLinks, normalizeCrawlUrl } from "./index.js";

const pageUrl = "https://example.com/articles/one";
const fixture = `<!doctype html><html><body>
  <nav><a href="/">Home</a>
       <a href="/articles/two">Second article</a>
       <a href="/articles/two#details">Duplicate article</a>
       <a href="https://example.com/articles/two">Duplicate absolute</a></nav>
  <main>
    <a href="../topics?name=medicine">Topic</a>
    <a href="https://EXAMPLE.com:443/articles/three#intro">Third article</a>
    <a href="?page=2">Next page</a>
    <a href="#section">Self fragment</a>
    <a href="https://other.com/news">External</a>
    <a href="//other.com/a">Protocol-relative external</a>
    <a href="mailto:support@example.com">Email</a>
    <a href="javascript:alert(1)">Script</a>
    <a href="ftp://example.com/archive">FTP</a>
    <a href="https://user:pass@example.com/private">Credentials</a>
    <a href="https://127.0.0.1/private">Loopback IP</a>
    <a href="/files/manual.PDF?download=1">Download</a>
    <a href="/images/strip%2Ejpg">Encoded image extension</a>
    <a href="/articles/four" rel="ugc nofollow">Don't follow</a>
    <a href="/articles/five" title="Article five"></a>
    <a href="/articles/six"><img alt="Article six" src="/six.png"></a>
    <a href="/articles/seven" aria-label="Article seven"></a>
  </main></body></html>`;

describe("same-origin link discovery", () => {
  it("normalizes relative URLs, removes fragments, preserves queries, and skips duplicates", () => {
    expect(discoverSameOriginLinks(fixture, pageUrl)).toEqual([
      { url: "https://example.com/", text: "Home" },
      { url: "https://example.com/articles/two", text: "Second article" },
      { url: "https://example.com/topics?name=medicine", text: "Topic" },
      { url: "https://example.com/articles/three", text: "Third article" },
      { url: "https://example.com/articles/one?page=2", text: "Next page" },
      { url: "https://example.com/articles/five", text: "Article five" },
      { url: "https://example.com/articles/six", text: "Article six" },
      { url: "https://example.com/articles/seven", text: "Article seven" },
    ]);
  });

  it("limits the result count", () => {
    expect(discoverSameOriginLinks(fixture, pageUrl, { maxLinks: 2 })).toHaveLength(2);
    expect(() => discoverSameOriginLinks(fixture, pageUrl, { maxLinks: 0 })).toThrow(RangeError);
    expect(() => discoverSameOriginLinks(fixture, pageUrl, { maxLinks: 5001 })).toThrow(RangeError);
  });

  it("respects rel=nofollow by default", () => {
    expect(discoverSameOriginLinks(fixture, pageUrl).map((link) => link.url))
      .not.toContain("https://example.com/articles/four");
    expect(discoverSameOriginLinks(fixture, pageUrl, { respectNoFollow: false }).map((link) => link.url))
      .toContain("https://example.com/articles/four");
  });

  it("honors the original seed origin, including after redirects", () => {
    expect(discoverSameOriginLinks('<a href="/another">Another</a>', pageUrl, {
      allowedOrigin: "https://example.com/",
    })).toEqual([{ url: "https://example.com/another", text: "Another" }]);
    expect(discoverSameOriginLinks('<a href="https://example.com/back">Back</a>', "https://other.com/", {
      allowedOrigin: "https://example.com/",
    })).toEqual([]);
  });

  it("rejects other subdomains and non-default ports", () => {
    const result = discoverSameOriginLinks(
      '<a href="https://blog.example.com/a">Subdomain</a><a href="https://example.com:8443/a">Other port</a>',
      pageUrl,
    );
    expect(result).toEqual([]);
  });

  it("normalizes paths, default ports and fragments", () => {
    expect(normalizeCrawlUrl("../guide#intro", pageUrl)).toBe("https://example.com/guide");
    expect(normalizeCrawlUrl("https://EXAMPLE.com:443/a#b", pageUrl)).toBe("https://example.com/a");
    expect(normalizeCrawlUrl("/search?q=tablet", pageUrl)).toBe("https://example.com/search?q=tablet");
  });

  it.each([
    "javascript:alert(1)",
    "mailto:hello@example.com",
    "data:text/html,abc",
    "file:///etc/passwd",
    "https://127.0.0.1/admin",
    "https://10.0.0.1/",
    "https://user:password@example.com/private",
    "/file.pdf",
    "/image%2EPNG",
    "/download.tar.gz",
    "",
  ])("filters unsupported or unsafe URL %s", (href) => {
    expect(normalizeCrawlUrl(href, pageUrl)).toBeNull();
  });

  it("rejects unsafe or invalid page URLs", () => {
    expect(() => discoverSameOriginLinks("<p>hello</p>", "http://localhost")).toThrow();
    expect(() => normalizeCrawlUrl("/ok", "not a URL")).toThrow();
  });

  it("handles malformed HTML with no valid links", () => {
    expect(discoverSameOriginLinks("<div><a>missing href</a>", pageUrl)).toEqual([]);
  });
});
