import { describe, expect, it } from "vitest";
import { extractPage } from "./index.js";

const source = "https://example.com/blog/post";

describe("safe SVG extraction", () => {
  it("preserves the first accessible label, title or description but no SVG markup", () => {
    const html = '<main><p>Results: ' +
      '<svg role="img" aria-label="Sales rose 20 percent"><title>Ignored title</title><path d="M0 0"/></svg>' +
      '<svg role="img"><title>Weekly revenue chart</title><desc>Backup desc</desc><circle r="8"/></svg>' +
      '<svg><desc>Quarterly earnings, by region</desc><rect width="2"/></svg>' +
      '</p><img src="/images/chart.svg" alt="Chart thumbnail" onerror="alert(1)"></main>';
    const result = extractPage(html, source);
    for (const label of ["Sales rose 20 percent", "Weekly revenue chart", "Quarterly earnings, by region"]) {
      expect(result.contentText).toContain(label);
    }
    expect(result.contentText).not.toContain("Ignored title");
    expect(result.contentHtml).toContain('src="/images/chart.svg"');
    expect(result.contentHtml).not.toMatch(/<svg|<path|<circle|<rect|onerror=/i);
  });

  it("drops unlabeled, decorative and hidden graphics, plus executable SVG content", () => {
    const html = '<main><p>Safe start</p>' +
      '<svg><path d="M0 1"/><script>stolen_data_1</script></svg>' +
      '<svg role="presentation" aria-label="hidden_chart_2"><title>hidden_title_2</title></svg>' +
      '<svg role="none"><title>hidden_title_3</title></svg>' +
      '<svg aria-hidden="TRUE"><title>hidden_title_4</title></svg>' +
      '<svg hidden><desc>hidden_title_5</desc></svg>' +
      '<svg role="img"><title>Revenue <script>stolen_data_6</script>' +
      '<foreignObject><div>stolen_data_7</div></foreignObject> after taxes</title></svg>' +
      '<p>Safe end</p></main>';
    const result = extractPage(html, source);
    expect(result.contentText).toContain("Safe start");
    expect(result.contentText).toContain("Safe end");
    expect(result.contentText).toContain("Revenue");
    expect(result.contentText).toContain("after taxes");
    for (const forbidden of ["stolen_data_1", "hidden_chart_2", "hidden_title_2",
      "hidden_title_3", "hidden_title_4", "hidden_title_5", "stolen_data_6", "stolen_data_7"]) {
      expect(result.contentText).not.toContain(forbidden);
      expect(result.contentHtml).not.toContain(forbidden);
    }
    expect(result.contentHtml).not.toMatch(/<svg|<foreignObject|<script/i);
  });

  it("escapes markup and limits SVG labels to 240 Unicode characters and 100 graphics", () => {
    const label = "A <script>alert('attack')</script> & data";
    const many = Array.from({ length: 110 }, (_, i) =>
      '<svg aria-label="Graph item ' + (i + 1) + '"></svg>').join("");
    const html = '<main><p><svg aria-label="' + label + '"></svg>' +
      '<svg aria-label="' + "z".repeat(800) + '"></svg></p>' + many + '</main>';
    const result = extractPage(html, source);
    expect(result.contentHtml).not.toContain("<script>");
    expect(result.contentHtml).toContain("&lt;script&gt;");
    expect(result.contentText).toContain(label);
    expect(result.contentText).not.toContain("Graph item 110");
    expect(result.contentText).toContain("Graph item 98");
    expect(result.contentText).not.toContain("z".repeat(241));
    expect(result.contentHtml).not.toMatch(/<svg/i);
  });

  it("does not emit unsafe inline SVG URLs or fetch SVG assets", () => {
    const result = extractPage(
      '<main><p>Hello</p><svg><title>Chart</title><image href="data:image/svg+xml;base64,PHN2Zy8+"/>' +
        '<a href="javascript:alert(1)">evil</a></svg><img alt="Data" src="/images/data.svg"></main>',
      source,
    );
    expect(result.contentText).toContain("Chart");
    expect(result.contentHtml).not.toContain("data:image");
    expect(result.contentHtml).not.toContain("javascript:");
    expect(result.contentHtml).toContain('src="/images/data.svg"');
  });
});
