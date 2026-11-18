import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "dox-scraper-api",
    version: "0.1.0"
  })
);

export default app;
