import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { FetchError, fetchPage, isPublicIp, readLimitedStream, resolveRedirect, validateTargetUrl } from "./index.js";

describe("public address policy", () => {
  it.each(["127.0.0.1", "10.0.0.1", "192.168.1.5", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1", "2001:db8::1"])(
    "rejects non-public IP %s",
    (ip) => expect(isPublicIp(ip)).toBe(false),
  );

  it("accepts globally routable addresses", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
  });
});

describe("URL validation", () => {
  it.each(["file:///etc/passwd", "ftp://example.com", "http://localhost", "http://127.0.0.1", "http://[::1]", "http://user:pass@example.com", "not a URL"])(
    "rejects invalid or unsafe target %s",
    (url) => expect(() => validateTargetUrl(url)).toThrow(FetchError),
  );

  it("removes the fragment from a valid URL", () => {
    expect(validateTargetUrl("https://example.com/article#section").href).toBe("https://example.com/article");
  });

  it("blocks redirects to local destinations", () => {
    expect(() => resolveRedirect(new URL("https://example.com/"), "http://127.0.0.1/admin")).toThrow(FetchError);
  });

  it("resolves a safe relative redirect", () => {
    expect(resolveRedirect(new URL("https://example.com/a"), "/b").href).toBe("https://example.com/b");
  });
});

describe("response byte limit", () => {
  it("accepts a small response", async () => {
    await expect(readLimitedStream(Readable.from([Buffer.from("hello")]), 5)).resolves.toEqual(Buffer.from("hello"));
  });

  it("rejects oversized responses", async () => {
    await expect(readLimitedStream(Readable.from([Buffer.from("hello!")]), 5)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });
});

describe("conditional HTTP validators", () => {
  it("rejects line breaks and nulls before making any HTTP request", async () => {
    for (const header of ["xyz\r\nX-Evil: true", "xyz\nfoo", "xyz\u0000bar"]) {
      await expect(fetchPage("https://example.com/", { ifNoneMatch: header }))
        .rejects.toMatchObject({ code: "INVALID_URL" });
      await expect(fetchPage("https://example.com/", { ifModifiedSince: header }))
        .rejects.toMatchObject({ code: "INVALID_URL" });
    }
  });
});
