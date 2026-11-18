import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./index.js";

const baseUrl = "https://example.com/articles/first";

describe("htmlToMarkdown", () => {
  it("preserves headings, emphasis, links, lists and images", () => {
    const output = htmlToMarkdown(
      `<article>
      <h1>Medicine catalog</h1>
      <p>Read the <strong>important</strong> <em>details</em>.</p>
      <ul><li>Tablet</li><li>Capsule</li></ul>
      <a href="/guides/napa">Napa guide</a>
      <img alt="Medicine strip" src="/images/strip.png">
      </article>`,
      { baseUrl },
    );

    expect(output).toContain("# Medicine catalog");
    expect(output).toContain("**important**");
    expect(output).toContain("*details*");
    expect(output).toMatch(/^-\\s+Tablet$/m);
    expect(output).toMatch(/^-\\s+Capsule$/m);
    expect(output).toContain("[Napa guide](https://example.com/guides/napa)");
    expect(output).toContain("![Medicine strip](https://example.com/images/strip.png)");
  });

  it("converts a table and strikethrough to GitHub Flavored Markdown", () => {
    const output = htmlToMarkdown(
      '<table><thead><tr><th>Brand</th><th>Strength</th></tr></thead><tbody><tr><td>Napa</td><td>500 mg</td></tr></tbody></table><p><del>Old</del> New</p>',
      { baseUrl },
    );
    expect(output).toContain("| Brand");
    expect(output).toContain("| Napa");
    expect(output).toContain("500 mg");
    expect(output).toContain("~~Old~~");
  });

  it("preserves preformatted code as a fenced block", () => {
    const output = htmlToMarkdown(
      '<h2>Example</h2><pre><code>const page = 1;\nconsole.log(page);</code></pre>',
      { baseUrl },
    );
    expect(output).toContain("## Example");
    expect(output).toContain("```");
    expect(output).toContain("const page = 1;");
    expect(output).toContain("console.log(page);");
  });

  it("removes scripts, event handlers, and unsafe links/images", () => {
    const output = htmlToMarkdown(
      '<h1>Safe</h1><p onclick="alert(1)">Text</p><script>alert(1)</script><a href="javascript:alert(1)">unsafe</a><img src="data:text/html;base64,xxx" alt="bad">',
      { baseUrl },
    );
    expect(output).toContain("# Safe");
    expect(output).toContain("Text");
    expect(output).toContain("unsafe");
    expect(output).not.toContain("javascript:");
    expect(output).not.toContain("data:text/");
    expect(output).not.toContain("alert(1)");
    expect(output).not.toContain("![bad]");
  });

  it("returns an empty string for whitespace-only content", () => {
    expect(htmlToMarkdown(" \n\t ", { baseUrl })).toBe("");
  });

  it("truncates long output at a configurable limit", () => {
    const result = htmlToMarkdown("<p>abcdefghijklmnopqrstuvwxyz</p>", { baseUrl, maxCharacters: 10 });
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("rejects invalid base URLs and invalid limits", () => {
    expect(() => htmlToMarkdown("<p>x</p>", { baseUrl: "file:///tmp/secret" })).toThrow();
    expect(() => htmlToMarkdown("<p>x</p>", { baseUrl, maxCharacters: 0 })).toThrow();
  });
});
