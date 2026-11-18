export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Dox Scraper API",
    version: "0.1.0",
    description: "Self-hosted single-page HTML-to-Markdown scraping API. No crawl jobs or browser rendering yet.",
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
          "503": { description: "API key not configured" },
          "504": { description: "Target fetch timed out" },
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
        },
      },
    },
  },
} as const;
