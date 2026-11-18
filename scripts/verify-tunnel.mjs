import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export class TunnelVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TunnelVerificationError";
  }
}

function publicOrigin(raw) {
  let value;
  try { value = new URL(raw); }
  catch { throw new TunnelVerificationError("DOX_PUBLIC_URL must be an HTTPS origin"); }
  if (value.protocol !== "https:" || value.href !== value.origin + "/" ||
      value.username || value.password ||
      value.hostname === "localhost" || value.hostname === "127.0.0.1") {
    throw new TunnelVerificationError("DOX_PUBLIC_URL must be an HTTPS origin, without path or credentials");
  }
  return value.origin;
}

/**
 * Live verification that Cloudflare Access and the API bearer are enforced
 * independently. Never scrapes a target website or logs any credentials.
 * This is an explicit, manual post-deployment step; not a CI network test.
 */
export async function verifyTunnel(env, request = fetch, report = console.log) {
  const origin = publicOrigin(env.DOX_PUBLIC_URL ?? "");
  const accessId = env.DOX_CF_ACCESS_CLIENT_ID ?? "";
  const accessSecret = env.DOX_CF_ACCESS_CLIENT_SECRET ?? "";
  const bearer = env.DOX_SCRAPER_API_KEY ?? "";
  if (!accessId || !accessSecret || !bearer) {
    throw new TunnelVerificationError(
      "DOX_CF_ACCESS_CLIENT_ID, DOX_CF_ACCESS_CLIENT_SECRET and DOX_SCRAPER_API_KEY are all required",
    );
  }

  const access = {
    "CF-Access-Client-Id": accessId,
    "CF-Access-Client-Secret": accessSecret,
  };
  async function send(path, method = "GET", headers = {}, body) {
    let response;
    try {
      response = await request(origin + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
    } catch {
      throw new TunnelVerificationError("Cannot reach the protected hostname");
    }
    return response;
  }

  const unauth = await send("/health");
  if (unauth.status === 200 || ![302, 303, 401, 403].includes(unauth.status)) {
    throw new TunnelVerificationError(
      "Unauthenticated public health check was not rejected by Cloudflare Access",
    );
  }
  report("PASS: requests without Cloudflare Access are blocked");

  const health = await send("/health", "GET", access);
  if (health.status !== 200) {
    throw new TunnelVerificationError(
      "Access service-token authentication failed or the tunnel route is unavailable",
    );
  }
  let healthData;
  try { healthData = await health.json(); }
  catch { throw new TunnelVerificationError("Protected health endpoint did not return JSON"); }
  if (healthData?.status !== "ok" || healthData.service !== "dox-scraper-api") {
    throw new TunnelVerificationError("Protected route does not point to Dox Scraper");
  }
  report("PASS: Access service token reaches the intended API");

  const json = { "content-type": "application/json" };
  const noBearer = await send("/v1/scrape", "POST", { ...access, ...json }, "{}");
  if (noBearer.status !== 401) {
    throw new TunnelVerificationError("API accepted a request without its own bearer token");
  }
  report("PASS: Cloudflare Access alone cannot bypass API authentication");

  const wrongBearer = await send("/v1/scrape", "POST", {
    ...access, ...json, authorization: "Bearer deliberately-invalid",
  }, "{}");
  if (wrongBearer.status !== 401) {
    throw new TunnelVerificationError("API accepted an invalid bearer token");
  }
  report("PASS: invalid API bearer token was denied");

  const valid = await send("/v1/scrape", "POST", {
    ...access, ...json, authorization: "Bearer " + bearer,
  }, "{}");
  if (valid.status !== 400 || valid.headers.get("cache-control") !== "no-store") {
    throw new TunnelVerificationError(
      "Authenticated invalid request did not receive bounded validation and no-store policy",
    );
  }
  let validation;
  try { validation = await valid.json(); }
  catch { throw new TunnelVerificationError("Authenticated API did not return JSON"); }
  if (validation?.error?.code !== "VALIDATION_ERROR") {
    throw new TunnelVerificationError("Authenticated API route returned unexpected validation behavior");
  }
  report("PASS: valid dual authentication reaches the API validation layer");
  report("SUCCESS: tunnel routing and both authentication layers verified without scraping");
  return true;
}

if (process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  verifyTunnel(process.env).catch((error) => {
    console.error(
      "Tunnel verification failed:",
      error instanceof Error ? error.message : "Unknown verification error",
    );
    process.exitCode = 1;
  });
}
