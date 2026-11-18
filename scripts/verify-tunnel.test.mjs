import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyTunnel, TunnelVerificationError } from "./verify-tunnel.mjs";

const ENV = Object.freeze({
  DOX_PUBLIC_URL: "https://scraper.example.com",
  DOX_CF_ACCESS_CLIENT_ID: "test-access-id",
  DOX_CF_ACCESS_CLIENT_SECRET: "test-access-secret",
  DOX_SCRAPER_API_KEY: "test-bearer",
});

function mockTransport(mode = "normal") {
  const seen = [];
  const transport = async (url, opts) => {
    seen.push({ url, opts });
    assert.equal(opts.redirect, "manual");
    assert.equal(new URL(url).origin, "https://scraper.example.com");
    const path = new URL(url).pathname;
    const access = opts.headers["CF-Access-Client-Id"] === "test-access-id" &&
      opts.headers["CF-Access-Client-Secret"] === "test-access-secret";

    if (!access) {
      return new Response(null, { status: mode === "public-health" ? 200 : 403 });
    }
    if (path === "/health") {
      if (mode === "invalid-access") return new Response(null, { status: 403 });
      return new Response(JSON.stringify({ status: "ok", service: "dox-scraper-api" }), {
        status: 200,
      });
    }
    assert.equal(path, "/v1/scrape");
    assert.equal(opts.method, "POST");
    assert.equal(opts.body, "{}");
    const auth = opts.headers.authorization;
    if (!auth) return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401 });
    if (auth !== "Bearer test-bearer") {
      return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401 });
    }
    return new Response(JSON.stringify({
      success: false, error: { code: "VALIDATION_ERROR" },
    }), { status: 400, headers: { "cache-control": "no-store" } });
  };
  return { seen, transport };
}

test("remote tunnel dual-auth check passes without scraping external pages", async () => {
  const { seen, transport } = mockTransport();
  const reports = [];
  const result = await verifyTunnel(ENV, transport, (line) => reports.push(line));
  assert.equal(result, true);
  assert.equal(seen.length, 5);
  assert.equal(reports.length, 6);
  assert.equal(seen[0].opts.headers["CF-Access-Client-Id"], undefined);
  assert.equal(seen[1].opts.headers["CF-Access-Client-Id"], "test-access-id");
  assert.equal(seen[4].opts.headers.authorization, "Bearer test-bearer");
  assert.ok(reports.every((item) => !item.includes("test-bearer") &&
    !item.includes("test-access-secret")));
});

test("refuses public routes not protected by Cloudflare Access", async () => {
  const { transport } = mockTransport("public-health");
  await assert.rejects(
    () => verifyTunnel(ENV, transport, () => {}),
    (error) => error instanceof TunnelVerificationError &&
      /Unauthenticated public health/.test(error.message),
  );
});

test("fails when Cloudflare Access service token is invalid", async () => {
  const { transport } = mockTransport("invalid-access");
  await assert.rejects(
    () => verifyTunnel(ENV, transport, () => {}),
    /Access service-token authentication failed/,
  );
});

test("rejects missing secrets and untrusted public URLs before networking", async () => {
  const { seen, transport } = mockTransport();
  for (const config of [
    { ...ENV, DOX_PUBLIC_URL: "http://scraper.example.com" },
    { ...ENV, DOX_PUBLIC_URL: "https://scraper.example.com/path" },
    { ...ENV, DOX_PUBLIC_URL: "https://id:pass@scraper.example.com" },
    { ...ENV, DOX_CF_ACCESS_CLIENT_SECRET: "" },
    { ...ENV, DOX_SCRAPER_API_KEY: "" },
  ]) {
    await assert.rejects(() => verifyTunnel(config, transport, () => {}), TunnelVerificationError);
  }
  assert.equal(seen.length, 0);
});
