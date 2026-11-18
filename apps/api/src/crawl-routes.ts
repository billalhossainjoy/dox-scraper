import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { SqliteCrawlStore } from "@dox-scraper/storage";
import { FetchError } from "@dox-scraper/fetcher";
import { tokenMatches } from "./auth.js";
import {
  CrawlApiError,
  CrawlManager,
  ownerDigestForKey,
} from "./crawl-manager.js";

const crawlRequest = z.object({
  url: z.string().trim().min(1).max(2048).url().refine(
    (url) => url.startsWith("http://") || url.startsWith("https://"),
    "Only absolute HTTP(S) URLs are allowed",
  ),
  maxPages: z.number().int().min(1).max(50).optional(),
  maxDepth: z.number().int().min(0).max(3).optional(),
}).strict();

function paginationValue(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
}

export interface CrawlRoutesOptions {
  secret: string;
  enabled: boolean;
  allowedOrigins: string[];
  store?: SqliteCrawlStore;
  manager?: CrawlManager;
}

/**
 * Registers four authenticated crawl routes. Disabled by default, and
 * no database file is opened unless the operator explicitly enables crawling.
 */
export function registerCrawlRoutes(app: Hono, options: CrawlRoutesOptions): void {
  const owner = ownerDigestForKey(options.secret);
  const manager = options.enabled
    ? options.manager ?? new CrawlManager({
      store: options.store ?? new SqliteCrawlStore({
        path: process.env.DOX_CRAWL_DB_PATH || "./storage/dox.sqlite",
      }),
      allowedOrigins: options.allowedOrigins,
      maxActiveJobs: 1,
    })
    : undefined;

  const authenticate: MiddlewareHandler = async (c, next) => {
    if (!options.secret) {
      return c.json({
        success: false,
        error: { code: "API_KEY_NOT_CONFIGURED", message: "Set DOX_SCRAPER_API_KEY" },
      }, 503);
    }
    const header = c.req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ") ||
        !tokenMatches(header.slice(7), options.secret)) {
      return c.json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token" },
      }, 401);
    }
    await next();
  };

  app.use("/v1/crawl", authenticate);
  app.use("/v1/crawl/*", authenticate);

  const errorResponse = (error: unknown) => {
    if (error instanceof FetchError) {
      return {
        status: 400 as const,
        code: error.code,
        message: error.message,
      };
    }
    if (error instanceof CrawlApiError) {
      return { status: error.status, code: error.code, message: error.message };
    }
    return { status: 500 as const, code: "INTERNAL_ERROR", message: "Crawl request failed" };
  };

  app.post(
    "/v1/crawl",
    bodyLimit({
      maxSize: 4 * 1024,
      onError: (c) => c.json({
        success: false,
        error: { code: "BODY_TOO_LARGE", message: "Maximum request body is 4 KiB" },
      }, 413),
    }),
    async (c) => {
      if (!manager) {
        return c.json({
          success: false,
          error: { code: "CRAWL_DISABLED", message: "Crawling must be explicitly enabled by the operator" },
        }, 503);
      }
      if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        return c.json({
          success: false, error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json" },
        }, 415);
      }
      let payload: unknown;
      try {
        payload = await c.req.json();
      } catch {
        return c.json({
          success: false, error: { code: "INVALID_JSON", message: "Malformed JSON" },
        }, 400);
      }
      const parsed = crawlRequest.safeParse(payload);
      if (!parsed.success) {
        return c.json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid crawl request",
            details: parsed.error.issues.map((issue) => ({
              field: issue.path.join("."), message: issue.message,
            })),
          },
        }, 400);
      }
      try {
        const job = manager.submit(parsed.data, owner);
        c.header("Location", "/v1/crawl/" + job.id);
        return c.json({ success: true, data: job }, 202);
      } catch (error) {
        const response = errorResponse(error);
        if (response.status === 500) console.error("Cannot schedule crawl", error);
        return c.json({
          success: false,
          error: { code: response.code, message: response.message },
        }, response.status);
      }
    },
  );

  app.get("/v1/crawl/:id", (c) => {
    if (!manager) return c.json({
      success: false, error: { code: "CRAWL_DISABLED", message: "Crawl API disabled" },
    }, 503);
    try {
      return c.json({ success: true, data: manager.getJob(c.req.param("id"), owner) }, 200);
    } catch (error) {
      const response = errorResponse(error);
      if (response.status === 500) console.error("Cannot read crawl", error);
      return c.json({ success: false, error: {
        code: response.code, message: response.message,
      } }, response.status);
    }
  });

  app.get("/v1/crawl/:id/results", (c) => {
    if (!manager) return c.json({
      success: false, error: { code: "CRAWL_DISABLED", message: "Crawl API disabled" },
    }, 503);
    const limit = paginationValue(c.req.query("limit"), 20, 50);
    const offset = paginationValue(c.req.query("offset"), 0, 1_000_000);
    if (limit === null || offset === null || limit < 1) {
      return c.json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "limit must be 1..50 and offset 0..1000000" },
      }, 400);
    }
    try {
      return c.json({
        success: true, data: manager.results(c.req.param("id"), owner, limit, offset),
      }, 200);
    } catch (error) {
      const response = errorResponse(error);
      if (response.status === 500) console.error("Cannot read crawl results", error);
      return c.json({ success: false, error: {
        code: response.code, message: response.message,
      } }, response.status);
    }
  });

  app.delete("/v1/crawl/:id", (c) => {
    if (!manager) return c.json({
      success: false, error: { code: "CRAWL_DISABLED", message: "Crawl API disabled" },
    }, 503);
    try {
      return c.json({ success: true, data: manager.cancel(c.req.param("id"), owner) }, 200);
    } catch (error) {
      const response = errorResponse(error);
      if (response.status === 500) console.error("Cannot cancel crawl", error);
      return c.json({ success: false, error: {
        code: response.code, message: response.message,
      } }, response.status);
    }
  });
}
