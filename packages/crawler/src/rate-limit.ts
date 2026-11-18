import { validateTargetUrl } from "@dox-scraper/fetcher";

export interface DomainRateLimitOptions {
  /** Minimum time between request starts per hostname. Default 1500 ms. */
  minDelayMs?: number;
  /** Maximum active requests per hostname. Default 1, maximum 4. */
  maxConcurrency?: number;
  /** Maximum buffered requests per hostname. Default 100. */
  maxQueue?: number;
  /** Retries for HTTP 429/503 only. Default 2; maximum 3. */
  maxRetries?: number;
  /** Initial backoff on HTTP 429/503. Default 2000 ms. */
  baseBackoffMs?: number;
  /** Maximum exponential backoff excluding server Retry-After. Default 30000 ms. */
  maxBackoffMs?: number;
  /** Extra randomized delay as a fraction of backoff. Default 0.25. */
  jitterRatio?: number;
  /** Throttle responses required for a longer pause. Default 3. */
  throttleThreshold?: number;
  /** Pause after repeated 429/503 responses. Default 60000 ms. */
  throttlePauseMs?: number;
  /** Pause on HTTP 403. Default 300000 ms. */
  accessDeniedPauseMs?: number;
  /** Maximum unique hostname state entries. Default 500. */
  maxDomains?: number;
  /** Injected randomness for deterministic tests. Must return [0, 1). */
  random?: () => number;
}

export interface DomainPermit {
  /** Record an upstream result before releasing a permit. */
  observe(statusCode: number, retryAfter?: string | null): void;
  /** Idempotent; must be called after every request. */
  release(): void;
}

export interface RateLimitedResponse {
  statusCode: number;
  headers?: { [key: string]: string | string[] | number | undefined };
}

export class RateLimitError extends Error {
  constructor(
    public readonly code: "QUEUE_FULL" | "DOMAIN_LIMIT_REACHED" | "ABORTED",
    message: string,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

interface Waiter {
  resolve: (permit: DomainPermit) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

interface DomainState {
  active: number;
  nextStartAt: number;
  pausedUntil: number;
  throttles: number;
  queue: Waiter[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

type Settings = Required<Omit<DomainRateLimitOptions, "random">> & {
  random: () => number;
};

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(name + " must be an integer from " + min + " to " + max);
  }
  return value;
}

function hostnameOf(url: string): string {
  return validateTargetUrl(url).hostname.toLowerCase();
}

function aborted(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new RateLimitError("ABORTED", "Request cancelled");
}

/**
 * Parse HTTP Retry-After (delta-seconds or HTTP-date) into a nonnegative
 * millisecond interval. Invalid values return null. Large valid values
 * remain effective instead of being silently shortened.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  const text = value?.trim();
  if (!text) return null;
  // Reject signed numeric values rather than misreading them as dates.
  if (/^[+-]\d+$/.test(text)) return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000
      ? seconds * 1000 : null;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function getRetryAfter(headers: RateLimitedResponse["headers"]): string | null {
  if (!headers) return null;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after");
  if (!entry) return null;
  const value = entry[1];
  return typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? null) : null;
}

/**
 * Conservative in-memory per-hostname scheduler:
 * - FIFO request queue and maxConcurrency slots
 * - spacing between request start times
 * - backoff/pause on HTTP 429, 503, and 403
 * - no proxies, identity rotation, captcha or block circumvention
 *
 * Share ONE instance across all jobs in a Node.js process. Multiple processes
 * need a distributed coordinator before any claims of global limiting.
 */
export class DomainRateLimiter {
  private readonly config: Settings;
  private readonly domains = new Map<string, DomainState>();

  constructor(options: DomainRateLimitOptions = {}) {
    this.config = {
      minDelayMs: integer(options.minDelayMs ?? 1500, "minDelayMs", 0, 60000),
      maxConcurrency: integer(options.maxConcurrency ?? 1, "maxConcurrency", 1, 4),
      maxQueue: integer(options.maxQueue ?? 100, "maxQueue", 1, 1000),
      maxRetries: integer(options.maxRetries ?? 2, "maxRetries", 0, 3),
      baseBackoffMs: integer(options.baseBackoffMs ?? 2000, "baseBackoffMs", 1, 30000),
      maxBackoffMs: integer(options.maxBackoffMs ?? 30000, "maxBackoffMs", 1, 300000),
      jitterRatio: options.jitterRatio ?? 0.25,
      throttleThreshold: integer(options.throttleThreshold ?? 3, "throttleThreshold", 1, 10),
      throttlePauseMs: integer(options.throttlePauseMs ?? 60000, "throttlePauseMs", 1, 3600000),
      accessDeniedPauseMs: integer(options.accessDeniedPauseMs ?? 300000, "accessDeniedPauseMs", 1, 86400000),
      maxDomains: integer(options.maxDomains ?? 500, "maxDomains", 1, 10000),
      random: options.random ?? Math.random,
    };
    if (!Number.isFinite(this.config.jitterRatio) ||
        this.config.jitterRatio < 0 || this.config.jitterRatio > 1) {
      throw new RangeError("jitterRatio must be between 0 and 1");
    }
    if (this.config.maxBackoffMs < this.config.baseBackoffMs) {
      throw new RangeError("maxBackoffMs cannot be smaller than baseBackoffMs");
    }
    if (typeof this.config.random !== "function") {
      throw new TypeError("random must be a function");
    }
  }

  private state(host: string): DomainState {
    let state = this.domains.get(host);
    if (state) return state;
    if (this.domains.size >= this.config.maxDomains) {
      // Reclaim only idle, no-longer-paused domains. Never evict active queues.
      const now = Date.now();
      for (const [name, old] of this.domains) {
        if (old.active === 0 && old.queue.length === 0 && old.pausedUntil <= now) {
          if (old.timer) clearTimeout(old.timer);
          this.domains.delete(name);
          break;
        }
      }
      if (this.domains.size >= this.config.maxDomains) {
        throw new RateLimitError("DOMAIN_LIMIT_REACHED", "Domain scheduler capacity reached");
      }
    }
    state = { active: 0, nextStartAt: 0, pausedUntil: 0, throttles: 0, queue: [], timer: undefined };
    this.domains.set(host, state);
    return state;
  }

  private pump(state: DomainState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    while (state.active < this.config.maxConcurrency && state.queue.length > 0) {
      const now = Date.now();
      const eligibleAt = Math.max(state.nextStartAt, state.pausedUntil);
      if (eligibleAt > now) {
        // Node timers cannot safely exceed 2^31-1 milliseconds.
        state.timer = setTimeout(() => {
          state.timer = undefined;
          this.pump(state);
        }, Math.min(eligibleAt - now, 2147483647));
        return;
      }
      const waiter = state.queue.shift()!;
      if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
      if (waiter.signal?.aborted) {
        waiter.reject(aborted(waiter.signal));
        continue;
      }

      state.active += 1;
      state.nextStartAt = Math.max(state.nextStartAt, now) + this.config.minDelayMs;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        state.active -= 1;
        this.pump(state);
      };
      waiter.resolve({
        observe: (statusCode, retryAfter) => this.observeState(state, statusCode, retryAfter),
        release,
      });
    }
  }

  /** Acquire a per-hostname lease. Call release() in a finally block. */
  async acquire(url: string, signal?: AbortSignal): Promise<DomainPermit> {
    const host = hostnameOf(url);
    if (signal?.aborted) return Promise.reject(aborted(signal));
    const state = this.state(host);
    if (state.queue.length >= this.config.maxQueue) {
      return Promise.reject(new RateLimitError("QUEUE_FULL", "Too many queued requests for this hostname"));
    }
    return new Promise<DomainPermit>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (signal) {
        waiter.signal = signal;
        waiter.abort = () => {
          const position = state.queue.indexOf(waiter);
          if (position === -1) return;
          state.queue.splice(position, 1);
          signal.removeEventListener("abort", waiter.abort!);
          reject(aborted(signal));
          this.pump(state);
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      state.queue.push(waiter);
      this.pump(state);
    });
  }

  private observeState(state: DomainState, status: number, retryAfter?: string | null): void {
    const now = Date.now();
    if (status >= 200 && status < 400) {
      state.throttles = 0;
      return;
    }
    if (status === 403) {
      state.pausedUntil = Math.max(state.pausedUntil, now + this.config.accessDeniedPauseMs);
    } else if (status === 429 || status === 503) {
      state.throttles += 1;
      const power = Math.min(state.throttles - 1, 15);
      const base = Math.min(this.config.maxBackoffMs, this.config.baseBackoffMs * 2 ** power);
      const random = this.config.random();
      const jitter = Math.floor(base * this.config.jitterRatio * Math.max(0, Math.min(0.999999, random)));
      const retryMs = parseRetryAfter(retryAfter, now) ?? 0;
      const repeatedPause = state.throttles >= this.config.throttleThreshold
        ? this.config.throttlePauseMs : 0;
      state.pausedUntil = Math.max(state.pausedUntil, now + Math.max(base + jitter, retryMs, repeatedPause));
    }
    // Recompute a queued request's wakeup if the target just signaled a pause.
    if (status === 403 || status === 429 || status === 503) this.pump(state);
  }

  /**
   * Update throttling state from a response received outside execute().
   * Prefer permit.observe() when using acquire() to avoid losing state.
   */
  observe(url: string, statusCode: number, retryAfter?: string | null): void {
    this.observeState(this.state(hostnameOf(url)), statusCode, retryAfter);
  }

  /**
   * Run a single request with per-hostname concurrency and spacing.
   * Retries only 429/503, up to maxRetries, using shared cooldown state;
   * returns the final response on exhaustion (never retries HTTP 403).
   * The callback MUST honor the supplied cancellation signal.
   */
  async execute<T extends RateLimitedResponse>(
    url: string,
    request: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const taskSignal = signal ?? new AbortController().signal;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const permit = await this.acquire(url, taskSignal);
      let result: T;
      try {
        if (taskSignal.aborted) throw aborted(taskSignal);
        result = await request(taskSignal);
        permit.observe(result.statusCode, getRetryAfter(result.headers));
      } finally {
        permit.release();
      }
      if ((result.statusCode !== 429 && result.statusCode !== 503) ||
          attempt === this.config.maxRetries) return result;
    }
    throw new Error("Unreachable retry state");
  }
}
