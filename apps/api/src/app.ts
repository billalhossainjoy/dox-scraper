import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { FetchError } from "@dox-scraper/fetcher";
import { openApiDocument } from "./openapi.js";
import { scrapePage, ScrapeServiceError } from "./scrape.js";

const scrapeRequest = z.object({
  url: z.string().trim().min(1).max(2048).url().refine(
    (url) => url.startsWith("https://") || url.startsWith("http://"),
    "Only HTTP and HTTPS URLs are supported",
  ),
  options: z.object({
    timeoutMs: z.number().int().min(1000).max(30000).optional(),
    maxBytes: z.number().int().min(1024).max(2 * 1024 * 1024).optional(),
    maxRedirects: z.number().int().min(0).max(5).optional(),
    maxCharacters: z.number().int().min(1).max(250_000).optional(),
  }).strict().optional(),
}).strict();

function tokenMatches(presented: string, expected: string): boolean {
  const actual = Buffer.from(presented, "utf8");
  const secret = Buffer.from(expected, "utf8");
  return actual.length === secret.length && timingSafeEqual(actual, secret);
}

export interface AppOptions {
  apiKey?: string;
  scrape?: typeof scrapePage;
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono();
  const secret = options.apiKey ?? "";
  const scrape = options.scrape ?? scrapePage;
  const MAX_CONCURRENT_SCRAPES = 2;
  let activeScrapes = 0;

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "dox-scraper-api",
      version: "0.1.0",
    }),
  );

  app.get("/openapi.json", (c) => c.json(openApiDocument));

  app.post(
    "/v1/scrape",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) =>
        c.json({ success: false, error: { code: "BODY_TOO_LARGE", message: "Request body exceeds 16 KiB" } }, 413),
    }),
    async (c) => {
      if (!secret) {
        return c.json({
          success: false,
          error: { code: "API_KEY_NOT_CONFIGURED", message: "Set DOX_SCRAPER_API_KEY before using the scraper" },
        }, 503);
      }

      const authorization = c.req.header("authorization") ?? "";
      if (!authorization.startsWith("Bearer ") || !tokenMatches(authorization.slice(7), secret)) {
        return c.json({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token" },
        }, 401);
      }

      const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        return c.json({
          success: false,
          error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json" },
        }, 415);
      }

      let payload: unknown;
      try {
        payload = await c.req.json();
      } catch {
        return c.json({ success: false, error: { code: "INVALID_JSON", message: "Malformed JSON body" } }, 400);
      }
      const parsed = scrapeRequest.safeParse(payload);
      if (!parsed.success) {
        return c.json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid scrape request",
            details: parsed.error.issues.map((issue) => ({
              field: issue.path.join("."),
              message: issue.message,
            })),
          },
        }, 400);
      }

      if (activeScrapes >= MAX_CONCURRENT_SCRAPES) {
        return c.json({
          success: false,
          error: { code: "BUSY", message: "Maximum concurrent scrape requests reached" },
        }, 429);
      }

      activeScrapes += 1;
      try {
        const result = await scrape(parsed.data.url, parsed.data.options ?? {});
        return c.json({ success: true, data: result }, 200);
      } catch (error) {
        if (error instanceof FetchError) {
          const status = error.code === "INVALID_URL" || error.code === "BLOCKED_ADDRESS" ? 400 :
            error.code === "TIMEOUT" ? 504 : 502;
          return c.json({
            success: false,
            error: { code: error.code, message: error.message },
          }, status);
        }
        if (error instanceof ScrapeServiceError) {
          return c.json({
            success: false,
            error: { code: error.code, message: error.message },
          }, error.httpStatus);
        }
        console.error("Unexpected scrape failure", error);
        return c.json({
          success: false,
          error: { code: "INTERNAL_ERROR", message: "Unable to scrape the requested webpage" },
        }, 500);
      } finally {
        activeScrapes -= 1;
      }
    },
  );

  return app;
}

export default createApp({ apiKey: process.env.DOX_SCRAPER_API_KEY });
