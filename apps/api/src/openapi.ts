export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Dox Scraper API",
    version: "0.1.0",
    description: "Self-hosted HTML-to-Markdown scraping and optional authenticated crawl jobs.",
  },
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        responses: {
          "200": { description: "Service is running" },
        },
      },
    },
    "/v1/scrape": {
      post: {
        summary: "Fetch a public webpage and return extracted metadata and Markdown",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["url"],
                properties: {
                  url: { type: "string", format: "uri", maxLength: 2048 },
                  options: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      timeoutMs: { type: "integer", minimum: 1000, maximum: 30000 },
                      maxBytes: { type: "integer", minimum: 1024, maximum: 2097152 },
                      maxRedirects: { type: "integer", minimum: 0, maximum: 5 },
                      maxCharacters: { type: "integer", minimum: 1, maximum: 250000 },
                      render: { type: "string", enum: ["http", "browser"], default: "http" },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Scraped page metadata and Markdown",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["success", "data"],
                  properties: {
                    success: { type: "boolean", const: true },
                    data: { $ref: "#/components/schemas/ScrapeResult" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid JSON or request fields" },
          "401": { description: "Missing or invalid API token" },
          "413": { description: "Request body exceeds 16 KiB" },
          "415": { description: "Content-Type must be application/json" },
          "429": { description: "Server concurrency limit reached or upstream website rate limited" },
          "502": { description: "Target fetch/extraction failed" },
          "503": { description: "API key not configured or browser rendering disabled" },
          "403": { description: "Browser rendering origin is not allowlisted" },
          "504": { description: "Target fetch timed out" },
        },
      },
    },
    "/v1/crawl": {
      post: {
        summary: "Submit an asynchronous same-origin crawl job",
        description: "Disabled by default. Requires an operator allowlist, successful robots.txt policy checks, and per-origin rate limiting. Crawl access is scoped to the API key.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url"],
                additionalProperties: false,
                properties: {
                  url: { type: "string", format: "uri", maxLength: 2048 },
                  maxPages: { type: "integer", minimum: 1, maximum: 50, default: 20 },
                  maxDepth: { type: "integer", minimum: 0, maximum: 3, default: 2 },
                },
              },
            },
          },
        },
        responses: {
          "202": { description: "Accepted; Location header points to job status" },
          "400": { description: "Invalid crawl request" },
          "401": { description: "Invalid or missing API key" },
          "403": { description: "Origin is not on the operator allowlist" },
          "413": { description: "Request exceeds 4 KiB" },
          "415": { description: "Content-Type is not application/json" },
          "429": { description: "At most one crawl job is active by default" },
          "503": { description: "Crawl API or API key not configured" },
        },
      },
    },
    "/v1/crawl/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        summary: "Read a credential-owned crawl job and its per-page statuses",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "Crawl snapshot and per-page progress" },
          "401": { description: "Missing or invalid key" },
          "404": { description: "Job absent or belongs to another credential" },
          "503": { description: "Crawl API disabled" },
        },
      },
      delete: {
        summary: "Request cancellation of an active crawl job",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "Cancellation accepted; returns latest snapshot" },
          "401": { description: "Missing or invalid key" },
          "404": { description: "Job absent or belongs to another credential" },
          "409": { description: "Job already completed/failed" },
          "503": { description: "Crawl API disabled" },
        },
      },
    },
    "/v1/crawl/{id}/results": {
      get: {
        summary: "Page through stored Markdown results belonging to a crawl",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 1000000, default: 0 } },
        ],
        responses: {
          "200": {
            description: "Returns {success:true,data:{results,total,limit,offset}}. Results contain Markdown, plain text, SHA-256 and metadata, in crawl order.",
          },
          "400": { description: "Invalid pagination" },
          "401": { description: "Missing or invalid key" },
          "404": { description: "Job absent or belongs to another credential" },
          "503": { description: "Crawl API disabled" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "DOX_SCRAPER_API_KEY" },
    },
    schemas: {
      ScrapeResult: {
        type: "object",
        required: [
          "requestedUrl", "finalUrl", "statusCode", "title", "description",
          "canonicalUrl", "language", "headings", "links", "markdown", "contentText",
          "fetchedAt", "redirectCount",
        ],
        properties: {
          requestedUrl: { type: "string", format: "uri" },
          finalUrl: { type: "string", format: "uri" },
          statusCode: { type: "integer" },
          title: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          canonicalUrl: { type: ["string", "null"], format: "uri" },
          language: { type: ["string", "null"] },
          headings: {
            type: "array",
            items: {
              type: "object",
              required: ["level", "text"],
              properties: { level: { type: "integer" }, text: { type: "string" } },
            },
          },
          links: {
            type: "array",
            items: {
              type: "object",
              required: ["url", "text", "external"],
              properties: {
                url: { type: "string", format: "uri" },
                text: { type: "string" },
                external: { type: "boolean" },
              },
            },
          },
          markdown: { type: "string" },
          contentText: { type: "string" },
          fetchedAt: { type: "string", format: "date-time" },
          redirectCount: { type: "integer", minimum: 0 },
          renderMode: { type: "string", enum: ["browser"], description: "Only included for explicit browser rendering" },
          cache: {
            type: "object",
            description: "Optional response-cache metadata for the default API service",
            properties: {
              status: { type: "string", enum: ["MISS", "HIT", "NOT_MODIFIED", "REFRESHED", "BYPASS"] },
              contentSha256: { type: ["string", "null"], description: "SHA-256 fingerprint of downloaded HTML" },
              changed: { type: "boolean" },
              cachedAt: { type: ["string", "null"], format: "date-time" },
              checkedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
  },
} as const;
