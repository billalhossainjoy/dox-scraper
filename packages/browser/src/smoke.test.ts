import { describe, expect, it } from "vitest";
import { BrowserRenderer } from "./index.js";

/**
 * Optional real-Chromium smoke test. CI runs deterministic mocked browser
 * tests by default and does not download Chromium.
 *
 * To run locally in an isolated environment:
 *   DOX_CHROMIUM_PATH=/usr/bin/chromium \
 *     pnpm --filter @dox-scraper/browser exec vitest run src/smoke.test.ts
 */
describe.skipIf(!process.env.DOX_CHROMIUM_PATH)("real Chromium inline-JavaScript fixture", () => {
  it("renders an already-fetched HTML fixture without any external network access", async () => {
    const renderer = new BrowserRenderer({ executablePath: process.env.DOX_CHROMIUM_PATH });
    const result = await renderer.render({
      url: "https://example.com/local-fixture",
      html: `<!doctype html><html><head><title>Fixture</title></head><body>
        <main><h1 id="title">Loading</h1></main>
        <script>
          Promise.resolve().then(() => {
            document.getElementById("title").textContent = "Rendered with JavaScript";
          });
        </script>
      </body></html>`,
      totalTimeoutMs: 20000,
      navigationTimeoutMs: 12000,
      settleMs: 100,
    });
    expect(result.html).toContain("Rendered with JavaScript");
    expect(result.url).toBe("https://example.com/local-fixture");
  });
});
