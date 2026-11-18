import { createHash } from "node:crypto";
import {
  FetchError,
  fetchPage,
  validateTargetUrl,
  type FetchPageOptions,
  type FetchPageResult,
} from "@dox-scraper/fetcher";

export type CacheStatus = "MISS" | "HIT" | "NOT_MODIFIED" | "REFRESHED" | "BYPASS";

export interface CacheMetadata {
  status: CacheStatus;
  contentSha256: string | null;
  /** True only if a previously stored page's content hash changed. */
  changed: boolean;
  /** Original first fetch timestamp, if the response is stored. */
  cachedAt: string | null;
  /** Time of this response or cache revalidation. */
  checkedAt: string;
}

export type CachedFetchResult = FetchPageResult & { cache: CacheMetadata };

export interface ResponseCacheOptions {
  /** Maximum local freshness. Default: 5 minutes. */
  ttlMs?: number;
  /** Maximum saved entries in the in-memory LRU. Default: 100. */
  maxEntries?: number;
  /** Maximum bytes across stored UTF-8 HTML bodies. Default: 32 MiB. */
  maxTotalBytes?: number;
  /** Individual cached HTML body limit. Default: 2 MiB. */
  maxEntryBytes?: number;
  /** Injected fetcher for testing. Default: the SSRF-validated fetchPage. */
  fetcher?: (url: string, options?: FetchPageOptions) => Promise<FetchPageResult>;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

export class CacheError extends Error {
  constructor(
    public readonly code: "UNEXPECTED_NOT_MODIFIED" | "INVALID_VALIDATOR_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "CacheError";
  }
}

interface StoredEntry {
  page: FetchPageResult;
  sha256: string;
  etag: string | null;
  lastModified: string | null;
  cachedAt: string;
  checkedAt: string;
  expiresAt: number;
  bodyBytes: number;
}

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(name + " must be an integer between " + min + " and " + max);
  }
  return value;
}

function readHeader(headers: FetchPageResult["headers"], name: string): string | null {
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] ?? null : null;
}

function safeValidator(value: string | null, maxLength: number): string | null {
  if (!value || value.length > maxLength || /[\r\n\x00]/.test(value)) return null;
  return value;
}

function permitsStorage(headers: FetchPageResult["headers"]): boolean {
  const cacheControl = (readHeader(headers, "cache-control") ?? "").toLowerCase();
  const vary = (readHeader(headers, "vary") ?? "").trim();
  return !/(?:^|,)\s*(?:no-store|private)(?:\s*[,;=]|$)/.test(cacheControl) && vary === "";
}

function freshnessMs(headers: FetchPageResult["headers"], ttlMs: number): number {
  const control = (readHeader(headers, "cache-control") ?? "").toLowerCase();
  if (/(?:^|,)\s*no-cache(?:\s*[,;=]|$)/.test(control)) return 0;
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/.exec(control);
  if (match?.[1]) {
    const seconds = Number(match[1]);
    return Number.isFinite(seconds) ? Math.min(ttlMs, seconds * 1000) : 0;
  }
  return ttlMs;
}

function copyPage(page: FetchPageResult): FetchPageResult {
  return { ...page, headers: { ...page.headers } };
}

/**
 * Small in-memory response cache for public, unauthenticated HTML.
 *
 * A fresh hit makes no HTTP request. An expired entry with an ETag or
 * Last-Modified validator performs an HTTP conditional GET. HTTP 304
 * reuses the stored body; HTTP 200 computes a new SHA-256 fingerprint.
 *
 * No cookies or authorization are sent by the default fetcher. Do not
 * reuse this class to cache authenticated/user-specific pages without
 * adding an explicit authorization/representation cache key.
 */
export class ResponseCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly maxEntryBytes: number;
  private readonly fetcher: (url: string, options?: FetchPageOptions) => Promise<FetchPageResult>;
  private readonly now: () => number;
  private readonly entries = new Map<string, StoredEntry>();
  private totalBytes = 0;

  constructor(options: ResponseCacheOptions = {}) {
    this.ttlMs = integer(options.ttlMs ?? 300000, "ttlMs", 0, 86400000);
    this.maxEntries = integer(options.maxEntries ?? 100, "maxEntries", 1, 10000);
    this.maxTotalBytes = integer(options.maxTotalBytes ?? 32 * 1024 * 1024, "maxTotalBytes", 1024, 512 * 1024 * 1024);
    this.maxEntryBytes = integer(options.maxEntryBytes ?? 2 * 1024 * 1024, "maxEntryBytes", 1024, 20 * 1024 * 1024);
    this.fetcher = options.fetcher ?? fetchPage;
    this.now = options.now ?? Date.now;
  }

  stats() {
    return { entries: this.entries.size, bodyBytes: this.totalBytes };
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private remove(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.totalBytes -= existing.bodyBytes;
    this.entries.delete(key);
  }

  private get(key: string): StoredEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  private store(key: string, entry: StoredEntry): void {
    this.remove(key);
    if (entry.bodyBytes > this.maxEntryBytes || entry.bodyBytes > this.maxTotalBytes) return;
    while (this.entries.size >= this.maxEntries || this.totalBytes + entry.bodyBytes > this.maxTotalBytes) {
      const oldKey = this.entries.keys().next().value;
      if (typeof oldKey !== "string") break;
      this.remove(oldKey);
    }
    this.entries.set(key, entry);
    this.totalBytes += entry.bodyBytes;
  }

  private outcome(page: FetchPageResult, status: CacheStatus, sha256: string | null,
                  changed: boolean, entry?: StoredEntry): CachedFetchResult {
    return {
      ...copyPage(page),
      cache: {
        status,
        contentSha256: sha256,
        changed,
        cachedAt: entry?.cachedAt ?? null,
        checkedAt: new Date(this.now()).toISOString(),
      },
    };
  }

  async fetch(url: string, options: FetchPageOptions = {}): Promise<CachedFetchResult> {
    const requested = validateTargetUrl(url).href;
    const key = JSON.stringify([requested, options.userAgent ?? "", options.maxRedirects ?? 5]);
    const prior = this.get(key);
    const limit = options.maxBytes ?? 2 * 1024 * 1024;
    if (prior && prior.bodyBytes > limit) {
      throw new FetchError("RESPONSE_TOO_LARGE", "Cached response exceeds the requested byte limit");
    }
    if (prior && prior.expiresAt > this.now()) {
      return this.outcome(prior.page, "HIT", prior.sha256, false, prior);
    }

    // Never forward opaque validators from one origin to another:
    // conditional headers are added only for a previously direct URL.
    const canRevalidate = prior && prior.page.finalUrl === requested;
    const validators = {
      ...(canRevalidate && prior.etag ? { ifNoneMatch: prior.etag } : {}),
      ...(canRevalidate && prior.lastModified ? { ifModifiedSince: prior.lastModified } : {}),
    };
    const response = await this.fetcher(requested, { ...options, ...validators });

    if (response.statusCode === 304) {
      if (!prior || response.finalUrl !== prior.page.finalUrl) {
        throw new CacheError("UNEXPECTED_NOT_MODIFIED", "304 without a matching cached representation");
      }
      const merged: FetchPageResult = {
        ...copyPage(prior.page),
        headers: { ...prior.page.headers, ...response.headers },
      };
      const checkedAt = new Date(this.now()).toISOString();
      const refreshed: StoredEntry = {
        ...prior,
        page: merged,
        checkedAt,
        expiresAt: this.now() + freshnessMs(merged.headers, this.ttlMs),
        etag: safeValidator(readHeader(merged.headers, "etag"), 1024),
        lastModified: safeValidator(readHeader(merged.headers, "last-modified"), 128),
      };
      if (permitsStorage(merged.headers)) this.store(key, refreshed);
      else this.remove(key);
      return this.outcome(merged, "NOT_MODIFIED", refreshed.sha256, false, refreshed);
    }

    if (response.statusCode !== 200) {
      return this.outcome(response, "BYPASS", null, false);
    }
    const page = copyPage(response);
    const bodyBytes = Buffer.byteLength(page.html, "utf8");
    const sha256 = createHash("sha256").update(page.html, "utf8").digest("hex");
    const changed = prior ? prior.sha256 !== sha256 : false;
    const timestamp = new Date(this.now()).toISOString();
    const entry: StoredEntry = {
      page,
      sha256,
      etag: safeValidator(readHeader(page.headers, "etag"), 1024),
      lastModified: safeValidator(readHeader(page.headers, "last-modified"), 128),
      cachedAt: timestamp,
      checkedAt: timestamp,
      expiresAt: this.now() + freshnessMs(page.headers, this.ttlMs),
      bodyBytes,
    };
    const canStore = permitsStorage(page.headers) &&
      bodyBytes <= this.maxEntryBytes && bodyBytes <= this.maxTotalBytes;
    if (canStore) this.store(key, entry);
    else this.remove(key);

    return this.outcome(page,
      canStore ? prior ? "REFRESHED" : "MISS" : "BYPASS",
      sha256, changed, canStore ? entry : undefined);
  }
}
