import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import ipaddr from "ipaddr.js";

export interface FetchPageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
}

export interface FetchPageResult {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  headers: IncomingHttpHeaders;
  contentType: string | null;
  html: string;
  fetchedAt: string;
  redirectCount: number;
}

export class FetchError extends Error {
  constructor(
    public readonly code: "INVALID_URL" | "BLOCKED_ADDRESS" | "TOO_MANY_REDIRECTS" | "RESPONSE_TOO_LARGE" | "TIMEOUT" | "NETWORK_ERROR" | "INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/**
 * A conservative allowlist policy: only addresses classified as global unicast.
 * ipaddr.process converts IPv4-mapped IPv6 addresses to IPv4 before classification.
 */
export function isPublicIp(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export function validateTargetUrl(input: string | URL): URL {
  let target: URL;
  try {
    target = new URL(input.toString());
  } catch {
    throw new FetchError("INVALID_URL", "A valid absolute HTTP or HTTPS URL is required");
  }
  if (!["http:", "https:"].includes(target.protocol) || !target.hostname) {
    throw new FetchError("INVALID_URL", "Only absolute HTTP and HTTPS URLs are supported");
  }
  if (target.username || target.password) {
    throw new FetchError("INVALID_URL", "URLs containing credentials are not supported");
  }

  const host = target.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new FetchError("BLOCKED_ADDRESS", "Local network hosts are not allowed");
  }
  if (isIP(host) && !isPublicIp(host)) {
    throw new FetchError("BLOCKED_ADDRESS", "Non-public IP addresses are not allowed");
  }
  target.hash = "";
  return target;
}

export function resolveRedirect(current: URL, location: string): URL {
  let destination: URL;
  try {
    destination = new URL(location, current);
  } catch {
    throw new FetchError("INVALID_RESPONSE", "The server returned an invalid redirect URL");
  }
  return validateTargetUrl(destination);
}

export async function readLimitedStream(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const piece of stream) {
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
    size += chunk.byteLength;
    if (size > maxBytes) {
      stream.destroy();
      throw new FetchError("RESPONSE_TOO_LARGE", `Response exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

interface SingleResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

async function requestOnce(target: URL, options: Required<FetchPageOptions>): Promise<SingleResponse> {
  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = client(
      target,
      {
        method: "GET",
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: {
          "user-agent": options.userAgent,
          accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
          "accept-encoding": "identity",
        },
        // Validate the addresses immediately before the socket connects.
        // In particular, do not trust a DNS preflight check followed by a second lookup.
        lookup: (hostname, lookupOptions, callback) => {
          dnsLookup(
            hostname,
            { all: true, family: lookupOptions.family, hints: lookupOptions.hints },
            (error, addresses) => {
              if (error) {
                callback(error, "", 4);
                return;
              }
              if (addresses.length === 0 || addresses.some((item) => !isPublicIp(item.address))) {
                callback(new FetchError("BLOCKED_ADDRESS", "DNS returned a non-public IP address"), "", 4);
                return;
              }
              const address = addresses[0]!;
              callback(null, address.address, address.family);
            },
          );
        },
      },
      async (response: IncomingMessage) => {
        const statusCode = response.statusCode ?? 0;
        const isRedirect = [301, 302, 303, 307, 308].includes(statusCode);
        if (isRedirect) {
          response.resume();
          resolve({ statusCode, headers: response.headers, body: "" });
          return;
        }
        const sizeHeader = response.headers["content-length"];
        if (sizeHeader && Number(sizeHeader) > options.maxBytes) {
          response.destroy();
          reject(new FetchError("RESPONSE_TOO_LARGE", "Content-Length exceeds the maximum response size"));
          return;
        }
        try {
          const body = (await readLimitedStream(response, options.maxBytes)).toString("utf8");
          resolve({ statusCode, headers: response.headers, body });
        } catch (error) {
          reject(error);
        }
      },
    );
    request.on("error", (error) => {
      if (error instanceof FetchError) {
        reject(error);
      } else if ((error as NodeJS.ErrnoException).name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR") {
        reject(new FetchError("TIMEOUT", "The HTTP request timed out"));
      } else {
        reject(new FetchError("NETWORK_ERROR", error.message));
      }
    });
    request.end();
  });
}

export async function fetchPage(input: string, config: FetchPageOptions = {}): Promise<FetchPageResult> {
  const options: Required<FetchPageOptions> = {
    timeoutMs: config.timeoutMs ?? 15_000,
    maxBytes: config.maxBytes ?? 2 * 1024 * 1024,
    maxRedirects: config.maxRedirects ?? 5,
    userAgent: config.userAgent ?? "DoxScraper/0.1 (+https://github.com/billalhossainjoy/dox-scraper)",
  };
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000 ||
      !Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 20 * 1024 * 1024 ||
      !Number.isInteger(options.maxRedirects) || options.maxRedirects < 0 || options.maxRedirects > 20) {
    throw new FetchError("INVALID_URL", "Invalid timeout, response size, or redirect limit");
  }

  const requestedUrl = validateTargetUrl(input).href;
  let current = validateTargetUrl(input);
  for (let redirectCount = 0; redirectCount <= options.maxRedirects; redirectCount++) {
    const response = await requestOnce(current, options);
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      if (!location) {
        throw new FetchError("INVALID_RESPONSE", "Redirect response is missing Location");
      }
      if (redirectCount === options.maxRedirects) {
        throw new FetchError("TOO_MANY_REDIRECTS", "Redirect limit reached");
      }
      current = resolveRedirect(current, location);
      continue;
    }
    return {
      requestedUrl,
      finalUrl: current.href,
      statusCode: response.statusCode,
      headers: response.headers,
      contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : null,
      html: response.body,
      fetchedAt: new Date().toISOString(),
      redirectCount,
    };
  }
  throw new FetchError("TOO_MANY_REDIRECTS", "Redirect limit reached");
}
