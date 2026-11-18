import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./index.js";

const baseUrl = "https://example.com/blog/post";

describe("safe SVG Markdown conversion", () => {
  it("preserves safe accessible SVG text and linked SVG image URLs", () => {
    const html = '<main><p>A <svg aria-label="Quarterly sales chart"><path d="M0 0"/></svg> follows.</p>' +
      '<p><svg><title>Distribution by region</title><desc>Ignored desc</desc></svg></p>' +
      '<p><svg><desc>Incidence per thousand people</desc></svg></p>' +
      '<img src="/images/graph.svg" alt="Detailed chart"></main>';
    const output = htmlToMarkdown(html, { baseUrl });
    for (const label of ["Quarterly sales chart", "Distribution by region", "Incidence per thousand people"]) {
      expect(output).toContain(label);
    }
    expect(output).not.toContain("Ignored desc");
    expect(output).toContain("![Detailed chart](https://example.com/images/graph.svg)");
    expect(output).not.toMatch(/<svg|<path/i);
  });

  it("removes decorative, hidden, script and foreignObject SVG content", () => {
    const html = '<p>Visible' +
      '<svg><script>injected-script</script><path d="M0 0"/></svg>' +
      '<svg aria-hidden="true" aria-label="should-not-show"></svg>' +
      '<svg role="presentation"><title>hidden-title</title></svg>' +
      '<svg role="img"><title>Safe label <script>stolen-secret</script>' +
      '<foreignObject><p>foreign-content</p></foreignObject> only</title></svg>' +
      '<img src="data:image/svg+xml;base64,PHN2Zy8+" alt="unsafe">' +
      '<img src="javascript:alert(1)" alt="also unsafe">' +
      '<img src="/vector.svg" alt="Safe external SVG"></p>';
    const output = htmlToMarkdown(html, { baseUrl });
    expect(output).toContain("Visible");
    expect(output).toContain("Safe label");
    expect(output).toContain("only");
    expect(output).toContain("![Safe external SVG](https://example.com/vector.svg)");
    for (const forbidden of ["should-not-show", "hidden-title", "injected-script",
      "stolen-secret", "foreign-content", "data:image", "javascript:"]) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).not.toContain("<svg");
    expect(output).not.toContain("![unsafe]");
  });

  it("limits SVG labels and overall Markdown output", () => {
    const repeated = Array.from({ length: 125 }, (_, index) =>
      '<svg role="img"><desc>Description ' + (index + 1) + ': ' + "A".repeat(500) + '</desc></svg>'
    ).join("");
    const output = htmlToMarkdown('<main>' + repeated + '</main>', {
      baseUrl, maxCharacters: 700,
    });
    expect(output.length).toBeLessThanOrEqual(700);
    expect(output).toContain("Description 1:");
    expect(output).not.toContain("Description 125:");
    expect(output).not.toContain("A".repeat(241));
  });

  it("discards protocol unsafe links while keeping ordinary SVG image links absolute HTTPS", () => {
    const output = htmlToMarkdown(
      '<p><svg role="img" aria-label="Safe diagram"></svg>' +
      '<img alt="safe" src="/assets/example.svg">' +
      '<img alt="unsafe" src="data:image/svg+xml,<svg/>"></p>',
      { baseUrl },
    );
    expect(output).toContain("Safe diagram");
    expect(output).toContain("![safe](https://example.com/assets/example.svg)");
    expect(output).not.toContain("data:image");
  });
});
