import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DomainRateLimiter,
  RateLimitError,
  parseRetryAfter,
} from "./rate-limit.js";

const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";

function makeLimiter(options: ConstructorParameters<typeof DomainRateLimiter>[0] = {}) {
  return new DomainRateLimiter({
    minDelayMs: 0,
    maxRetries: 0,
    baseBackoffMs: 1000,
    maxBackoffMs: 8000,
    jitterRatio: 0,
    ...options,
  });
}

describe("per-hostname scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("allows independent hostnames to start without sharing a delay", async () => {
    const limiter = makeLimiter({ minDelayMs: 1000 });
    const starts: string[] = [];
    const first = limiter.execute(URL_A, async () => {
      starts.push("first");
      return { statusCode: 200 };
    });
    const second = limiter.execute("https://other.com/page", async () => {
      starts.push("second");
      return { statusCode: 200 };
    });
    await Promise.all([first, second]);
    expect(starts).toEqual(["first", "second"]);
  });

  it("spaces request starts on the same hostname", async () => {
    const limiter = makeLimiter({ minDelayMs: 1200, maxConcurrency: 2 });
    const starts: number[] = [];
    const task = () => limiter.execute(URL_A, async () => {
      starts.push(Date.now());
      return { statusCode: 200 };
    });
    const base = Date.now();
    const requests = [task(), task(), task()];
    await vi.advanceTimersByTimeAsync(1199);
    expect(starts).toEqual([base]);
    await vi.advanceTimersByTimeAsync(1201);
    await Promise.all(requests);
    expect(starts).toEqual([base, base + 1200, base + 2400]);
  });

  it("caps active requests even when minimum spacing is zero", async () => {
    const limiter = makeLimiter({ maxConcurrency: 2 });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const request = vi.fn(async () => {
      await gate;
      return { statusCode: 200 };
    });
    const tasks = [
      limiter.execute(URL_A, request),
      limiter.execute(URL_B, request),
      limiter.execute(URL_A, request),
    ];
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    finish();
    await Promise.all(tasks);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("never grants more than maxQueue pending requests", async () => {
    const limiter = makeLimiter({ maxQueue: 1 });
    const first = await limiter.acquire(URL_A);
    const queued = limiter.acquire(URL_B);
    await expect(limiter.acquire(URL_A)).rejects.toMatchObject({ code: "QUEUE_FULL" });
    first.release();
    const second = await queued;
    second.release();
  });

  it("unblocks an aborted queue waiter and does not leak its place", async () => {
    const limiter = makeLimiter();
    const first = await limiter.acquire(URL_A);
    const controller = new AbortController();
    const queued = limiter.acquire(URL_B, controller.signal);
    controller.abort(new Error("User cancelled"));
    await expect(queued).rejects.toThrow("User cancelled");
    first.release();
    const next = await limiter.acquire(URL_A);
    next.release();
  });

  it("bounds number of tracked hostnames and reclaims idle ones", async () => {
    const limiter = makeLimiter({ maxDomains: 1 });
    const active = await limiter.acquire(URL_A);
    await expect(limiter.acquire("https://other.com/")).rejects.toMatchObject({
      code: "DOMAIN_LIMIT_REACHED",
    });
    active.release();
    const other = await limiter.acquire("https://other.com/");
    other.release();
  });

  it("rejects invalid configuration and local destinations", async () => {
    expect(() => makeLimiter({ maxConcurrency: 5 })).toThrow(RangeError);
    expect(() => makeLimiter({ maxRetries: 4 })).toThrow(RangeError);
    expect(() => makeLimiter({ minDelayMs: -1 })).toThrow(RangeError);
    expect(() => makeLimiter({ maxBackoffMs: 2, baseBackoffMs: 3 })).toThrow(RangeError);
    expect(() => makeLimiter({ jitterRatio: 1.2 })).toThrow(RangeError);
    const limiter = makeLimiter();
    await expect(limiter.acquire("http://127.0.0.1/")).rejects.toThrow();
    expect(RateLimitError.name).toBe("RateLimitError");
  });
});

describe("throttling and bounded retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("supports Retry-After seconds and HTTP dates", () => {
    const now = Date.now();
    expect(parseRetryAfter("5", now)).toBe(5000);
    expect(parseRetryAfter("Wed, 18 Nov 2026 12:00:10 GMT", now)).toBe(10000);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("invalid", now)).toBeNull();
    expect(parseRetryAfter("-3", now)).toBeNull();
  });

  it("respects Retry-After before retrying an HTTP 429", async () => {
    const limiter = makeLimiter({ maxRetries: 1 });
    const calls: number[] = [];
    const request = vi.fn(async () => {
      calls.push(Date.now());
      return calls.length === 1
        ? { statusCode: 429, headers: { "Retry-After": "5" } }
        : { statusCode: 200 };
    });
    const work = limiter.execute(URL_A, request);
    await vi.advanceTimersByTimeAsync(4999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await work;
    expect(result.statusCode).toBe(200);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(5000);
  });

  it("uses exponential backoff, a bounded retry count and a throttle pause", async () => {
    const limiter = makeLimiter({
      maxRetries: 3,
      baseBackoffMs: 1000,
      maxBackoffMs: 8000,
      throttleThreshold: 3,
      throttlePauseMs: 20000,
    });
    const starts: number[] = [];
    const work = limiter.execute(URL_A, async () => {
      starts.push(Date.now());
      return { statusCode: 503 };
    });
    await vi.advanceTimersByTimeAsync(25000);
    const last = await work;
    expect(last.statusCode).toBe(503);
    const initial = starts[0]!;
    expect(starts.map((time) => time - initial)).toEqual([0, 1000, 3000, 23000]);
    expect(starts).toHaveLength(4);
  });

  it("pauses a hostname after access denial without retrying 403", async () => {
    const limiter = makeLimiter({ maxRetries: 3, accessDeniedPauseMs: 10000 });
    const blocked = await limiter.execute(URL_A, async () => ({ statusCode: 403 }));
    expect(blocked.statusCode).toBe(403);

    const request = vi.fn(async () => ({ statusCode: 200 }));
    const next = limiter.execute(URL_B, request);
    await vi.advanceTimersByTimeAsync(9999);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("honors explicit Retry-After across separate jobs using a shared limiter", async () => {
    const limiter = makeLimiter({ maxRetries: 0 });
    const first = await limiter.acquire(URL_A);
    first.observe(429, "7");
    first.release();

    const request = vi.fn(async () => ({ statusCode: 200 }));
    const wait = limiter.execute(URL_B, request);
    await vi.advanceTimersByTimeAsync(6999);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stops after configured retries without trying to circumvent restrictions", async () => {
    const limiter = makeLimiter({ maxRetries: 2, baseBackoffMs: 100, maxBackoffMs: 100 });
    const request = vi.fn(async () => ({ statusCode: 429 }));
    const work = limiter.execute(URL_A, request);
    await vi.advanceTimersByTimeAsync(1000);
    const response = await work;
    expect(response.statusCode).toBe(429);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
