import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "dox-scraper-api",
    version: "0.1.0"
  })
);

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Dox Scraper API listening on http://${info.address}:${info.port}`);
});

export default app;
