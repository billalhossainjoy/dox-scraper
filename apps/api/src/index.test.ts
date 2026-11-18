import { describe, expect, it } from "vitest";
import app from "./index.js";

describe("GET /health", () => {
  it("returns the service health status", async () => {
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      service: "dox-scraper-api",
      version: "0.1.0"
    });
  });
});
