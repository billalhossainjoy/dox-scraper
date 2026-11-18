import { serve } from "@hono/node-server";
import { assertProductionConfiguration } from "./production-config.js";

// Validate before importing the application: enabling crawl jobs can otherwise
// open/migrate SQLite or run restart recovery as a module side effect.
assertProductionConfiguration(process.env);
const { default: app } = await import("./app.js");

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Dox Scraper API listening on http://${info.address}:${info.port}`);
});
