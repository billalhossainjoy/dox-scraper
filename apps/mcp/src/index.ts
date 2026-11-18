import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DoxRestClient } from "./api.js";
import { createMcpServer } from "./server.js";

/**
 * Only the MCP host process has the API token; it is never provided as
 * a tool argument, returned in a result, or logged on stdout.
 *
 * stdout is reserved for JSON-RPC stdio messages. Debug errors go to stderr.
 */
async function main(): Promise<void> {
  const client = new DoxRestClient({
    apiUrl: process.env.DOX_MCP_API_URL ?? "http://127.0.0.1:3000",
    apiKey: process.env.DOX_SCRAPER_API_KEY ?? "",
    accessClientId: process.env.DOX_CF_ACCESS_CLIENT_ID ?? "",
    accessClientSecret: process.env.DOX_CF_ACCESS_CLIENT_SECRET ?? "",
  });
  await serveStdio(() => createMcpServer(client));
}

void main().catch((error: unknown) => {
  console.error(
    "Dox Scraper MCP startup failed:",
    error instanceof Error ? error.message : "Unknown startup error",
  );
  process.exitCode = 1;
});
