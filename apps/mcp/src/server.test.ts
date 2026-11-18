import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpServer } from "./server.js";
import type { DoxApi } from "./api.js";

const URL = "https://example.com/start";
const JOB = "12345678-1234-4123-8123-123456789abc";

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const item = result.content[0];
  if (!item || item.type !== "text") throw new Error("Expected MCP text result");
  return JSON.parse(item.text) as unknown;
}

describe("Dox MCP tool protocol", () => {
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  let post: ReturnType<typeof vi.fn>;
  let get: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    post = vi.fn(async (path: string) => {
      if (path === "/v1/crawl") return { id: JOB, state: "queued" };
      return {
        requestedUrl: URL, finalUrl: URL,
        statusCode: 200, title: "Example", description: "Article",
        fetchedAt: "2026-11-18T00:00:00Z", markdown: "# Example\n\nHello",
        links: [
          { url: "https://example.com/a#one", text: "A", external: false },
          { url: "/a#two", text: "Duplicate", external: false },
          { url: "https://other.example/steal", text: "Foreign", external: true },
          { url: "https://example.com/assets/scan.pdf", text: "PDF", external: false },
          { url: "https://example.com/b", text: "B", external: false },
          { url: URL + "#self", text: "Self", external: false },
        ],
      };
    });
    get = vi.fn(async () => ({
      id: JOB, state: "completed", attempted: 2, completed: 2,
    }));
    const api: DoxApi = { post, get };
    server = createMcpServer(api);
    client = new Client({ name: "dox-test-harness", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("lists exactly the four expected tools", async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "crawl_url", "get_crawl_status", "map_url", "scrape_url",
    ]);
  });

  it("scrape_url delegates only to authenticated REST scrape endpoint", async () => {
    const result = await client.callTool({
      name: "scrape_url", arguments: { url: URL, maxCharacters: 5000 },
    });
    expect(result.isError).not.toBe(true);
    expect(resultText(result)).toMatchObject({
      url: URL, title: "Example", markdown: "# Example\n\nHello",
    });
    expect(post).toHaveBeenCalledWith("/v1/scrape", {
      url: URL, options: {
        timeoutMs: 15000, maxBytes: 1048576,
        maxCharacters: 5000, render: "http",
      },
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("map_url makes one REST scrape call and filters duplicate, external and asset links", async () => {
    const result = await client.callTool({
      name: "map_url", arguments: { url: URL, maxLinks: 10 },
    });
    expect(resultText(result)).toEqual({
      url: URL, title: "Example", total: 2,
      links: [
        { url: "https://example.com/a", text: "A" },
        { url: "https://example.com/b", text: "B" },
      ],
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/v1/scrape", {
      url: URL, options: {
        timeoutMs: 15000, maxBytes: 1048576,
        maxCharacters: 1, render: "http",
      },
    });
  });

  it("crawl_url submits bounded job via the REST API", async () => {
    const result = await client.callTool({
      name: "crawl_url", arguments: { url: URL, maxPages: 5, maxDepth: 1 },
    });
    expect(resultText(result)).toEqual({
      jobId: JOB, state: "queued", statusPath: "/v1/crawl/" + JOB,
    });
    expect(post).toHaveBeenCalledWith("/v1/crawl", {
      url: URL, maxPages: 5, maxDepth: 1,
    });
  });

  it("get_crawl_status reads only the owner-protected REST endpoint", async () => {
    const result = await client.callTool({
      name: "get_crawl_status", arguments: { jobId: JOB },
    });
    expect(resultText(result)).toMatchObject({
      id: JOB, state: "completed", attempted: 2,
    });
    expect(get).toHaveBeenCalledExactlyOnceWith("/v1/crawl/" + JOB);
  });

  it("validates all inputs before invoking the API", async () => {
    const inputs = [
      { name: "scrape_url", arguments: { url: "http://127.0.0.1/private" } },
      { name: "scrape_url", arguments: { url: "javascript:alert(1)" } },
      { name: "map_url", arguments: { url: URL, maxLinks: 101 } },
      { name: "crawl_url", arguments: { url: URL, maxPages: 51 } },
      { name: "crawl_url", arguments: { url: URL, maxDepth: 4 } },
      { name: "get_crawl_status", arguments: { jobId: "../secrets" } },
    ];
    for (const input of inputs) {
      const result = await client.callTool(input);
      expect(result.isError).toBe(true);
    }
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("propagates REST authorization and crawl-policy rejections as tool errors", async () => {
    post.mockRejectedValueOnce(Object.assign(
      new Error("Missing or invalid bearer token"), { code: "UNAUTHORIZED", httpStatus: 401 },
    ));
    const result = await client.callTool({ name: "crawl_url", arguments: { url: URL } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatchObject({
      error: "UNAUTHORIZED", message: "Missing or invalid bearer token",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a response with invalid upstream schema rather than inventing a result", async () => {
    get.mockResolvedValueOnce({ state: "completed" });
    const result = await client.callTool({
      name: "get_crawl_status", arguments: { jobId: JOB },
    });
    expect(result.isError).toBe(true);
  });
});
