/**
 * MCP is a deliberately thin client for the existing authenticated REST API.
 * No tool executes arbitrary fetches or accesses the crawl database directly.
 */
export interface DoxApi {
  post(path: string, payload: unknown): Promise<unknown>;
  get(path: string): Promise<unknown>;
}

export class DoxApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "DoxApiError";
  }
}

export interface DoxApiOptions {
  apiUrl?: string;
  apiKey: string;
  /** Optional Cloudflare Access service token for remote HTTPS routes. */
  accessClientId?: string;
  accessClientSecret?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  transport?: typeof fetch;
}

function boundedInt(n: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new RangeError(label + " must be an integer between " + min + " and " + max);
  }
  return n;
}

/** The MCP host operator configures a trusted REST API origin, not a tool. */
export function parseApiOrigin(input: string): string {
  let parsed: URL;
  try { parsed = new URL(input); }
  catch { throw new TypeError("Invalid DOX_MCP_API_URL"); }

  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== "/" || !["https:", "http:"].includes(parsed.protocol)) {
    throw new TypeError("MCP API URL must be a plain HTTP(S) origin without credentials, path or query");
  }
  const local = ["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !local) {
    throw new TypeError("Remote MCP REST API endpoints must use HTTPS");
  }
  return parsed.origin;
}

export class DoxRestClient implements DoxApi {
  private readonly origin: string;
  private readonly apiKey: string;
  private readonly accessClientId: string | null;
  private readonly accessClientSecret: string | null;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly transport: typeof fetch;

  constructor(options: DoxApiOptions) {
    if (!options.apiKey || options.apiKey.length < 1) {
      throw new TypeError("DOX_SCRAPER_API_KEY is required for MCP requests");
    }
    this.origin = parseApiOrigin(options.apiUrl ?? "http://127.0.0.1:3000");
    this.apiKey = options.apiKey;
    const accessId = options.accessClientId ?? "";
    const accessSecret = options.accessClientSecret ?? "";
    if (Boolean(accessId) !== Boolean(accessSecret)) {
      throw new TypeError("Both Cloudflare Access service-token fields must be provided");
    }
    if ([accessId, accessSecret].some((value) =>
      value.length > 2048 || [...value].some((char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) {
      throw new TypeError("Invalid Cloudflare Access credential value");
    }
    if (accessId && !this.origin.startsWith("https://")) {
      throw new TypeError("Cloudflare Access credentials require a remote HTTPS API endpoint");
    }
    this.accessClientId = accessId || null;
    this.accessClientSecret = accessSecret || null;
    this.timeoutMs = boundedInt(options.timeoutMs ?? 30_000, 1000, 60_000, "timeoutMs");
    this.maxResponseBytes = boundedInt(
      options.maxResponseBytes ?? 1024 * 1024,
      1024, 2 * 1024 * 1024, "maxResponseBytes",
    );
    this.transport = options.transport ?? fetch;
  }

  post(path: string, payload: unknown): Promise<unknown> {
    return this.request("POST", path, payload);
  }

  get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  private async request(method: "GET" | "POST", path: string, payload?: unknown): Promise<unknown> {
    if (!/^\/v1\/(scrape|crawl)(?:\/[a-zA-Z0-9_-]+)?$/.test(path)) {
      throw new TypeError("Only pre-approved Dox Scraper API endpoints may be called");
    }
    const target = new URL(path, this.origin);
    const headers: Record<string, string> = {
      authorization: "Bearer " + this.apiKey,
      accept: "application/json",
      ...(this.accessClientId && this.accessClientSecret ? {
        "CF-Access-Client-Id": this.accessClientId,
        "CF-Access-Client-Secret": this.accessClientSecret,
      } : {}),
    };
    if (method === "POST") headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.transport(target.href, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "manual",
        cache: "no-store",
      });
    } catch (error) {
      throw new DoxApiError(
        "API_UNREACHABLE", 502,
        error instanceof Error && error.name === "TimeoutError"
          ? "Dox Scraper API request timed out"
          : "Cannot reach the configured Dox Scraper API",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new DoxApiError("API_REDIRECT_REJECTED", 502, "REST API redirects are not followed");
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > this.maxResponseBytes) {
      await response.body?.cancel();
      throw new DoxApiError("API_RESPONSE_TOO_LARGE", 502, "REST API result exceeds MCP size limit");
    }

    const reader = response.body?.getReader();
    if (!reader) throw new DoxApiError("API_INVALID_RESPONSE", 502, "REST API response had no body");
    const chunks: Uint8Array[] = [];
    let lengthSoFar = 0;
    try {
      while (true) {
        const read = await reader.read();
        if (read.done) break;
        lengthSoFar += read.value.byteLength;
        if (lengthSoFar > this.maxResponseBytes) {
          await reader.cancel();
          throw new DoxApiError("API_RESPONSE_TOO_LARGE", 502, "REST API response exceeds MCP size limit");
        }
        chunks.push(read.value);
      }
    } finally { reader.releaseLock(); }
    const body = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(body) as unknown; }
    catch { throw new DoxApiError("API_INVALID_RESPONSE", 502, "REST API returned invalid JSON"); }
    if (typeof parsed !== "object" || parsed === null || !("success" in parsed)) {
      throw new DoxApiError("API_INVALID_RESPONSE", 502, "REST API returned an unexpected response envelope");
    }
    const envelope = parsed as { success: unknown; data?: unknown; error?: { code?: string; message?: string } };
    if (!response.ok || envelope.success !== true) {
      throw new DoxApiError(
        typeof envelope.error?.code === "string" ? envelope.error.code : "REST_API_ERROR",
        response.status,
        typeof envelope.error?.message === "string"
          ? envelope.error.message.slice(0, 300) : "REST API request failed",
      );
    }
    return envelope.data;
  }
}
