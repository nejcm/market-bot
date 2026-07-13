import { describe, expect, test } from "bun:test";
import {
  MissingCredentialError,
  UnsupportedTransportError,
  boundDiscoveredTool,
  openMcpSession,
  withMcpSession,
} from "../src/sources/mcp/client";
import type { McpHttpServerEntry, McpStdioServerEntry } from "../src/sources/mcp/types";
import { startLocalMcpServer } from "./fixtures/mcp/local-server";

// The shared preload replaces global fetch with a guard; the transport tests must
// Reach a real loopback server, so they inject the preserved real fetch.
const realFetch = (globalThis as unknown as { realFetchForTests: typeof fetch }).realFetchForTests;

function httpEntry(url: string, headers?: Record<string, string>): McpHttpServerEntry {
  return { id: "mtnewswire", type: "http", url, ...(headers !== undefined ? { headers } : {}) };
}

describe("openMcpSession transport", () => {
  for (const enableJsonResponse of [true, false]) {
    test(`discovers and calls a tool over ${enableJsonResponse ? "JSON" : "SSE"}`, async () => {
      const server = await startLocalMcpServer({ enableJsonResponse });
      try {
        await withMcpSession(
          { entry: httpEntry(server.url), timeoutMs: 5000, fetch: realFetch },
          async (session) => {
            const tools = await session.listTools();
            expect(tools.map((tool) => tool.name)).toEqual(["search_news"]);

            const result = await session.callTool("search_news", { query: "AAPL" });
            expect(result.isError).toBe(false);
            expect(result.structuredContent).toMatchObject({ shape: "news_search.v1" });
          },
        );
      } finally {
        await server.close();
      }
    });
  }

  test("keeps a single session across sequential calls", async () => {
    const server = await startLocalMcpServer({ enableJsonResponse: true });
    try {
      await withMcpSession(
        { entry: httpEntry(server.url), timeoutMs: 5000, fetch: realFetch },
        async (session) => {
          const first = await session.callTool("search_news", { query: "a" });
          const second = await session.callTool("search_news", { query: "b" });
          expect(first.isError).toBe(false);
          expect(second.isError).toBe(false);
        },
      );
    } finally {
      await server.close();
    }
  });

  test("terminates the server session on close", async () => {
    const server = await startLocalMcpServer({ enableJsonResponse: true });
    try {
      await withMcpSession(
        { entry: httpEntry(server.url), timeoutMs: 5000, fetch: realFetch },
        async (session) => {
          await session.listTools();
        },
      );
      expect(server.sessionDeletes.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  test("rejects when initialization fails", async () => {
    const server = await startLocalMcpServer({ failInitialize: true });
    try {
      await expect(
        openMcpSession({ entry: httpEntry(server.url), timeoutMs: 2000, fetch: realFetch }),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  test("times out a slow server", async () => {
    const server = await startLocalMcpServer({ requestDelayMs: 400 });
    try {
      await expect(
        openMcpSession({ entry: httpEntry(server.url), timeoutMs: 50, fetch: realFetch }),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  test("aborts via signal without connecting", async () => {
    const server = await startLocalMcpServer({ requestDelayMs: 400 });
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        openMcpSession({
          entry: httpEntry(server.url),
          timeoutMs: 5000,
          signal: controller.signal,
          fetch: realFetch,
        }),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  test("guarantees close even when the body throws", async () => {
    const server = await startLocalMcpServer({ enableJsonResponse: true });
    let closed = false;
    try {
      await expect(
        withMcpSession(
          { entry: httpEntry(server.url), timeoutMs: 5000, fetch: realFetch },
          async (session) => {
            const original = session.close.bind(session);
            session.close = async () => {
              closed = true;
              await original();
            };
            throw new Error("boom");
          },
        ),
      ).rejects.toThrow("boom");
      expect(closed).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("openMcpSession guards", () => {
  test("refuses stdio without spawning a process", async () => {
    const entry: McpStdioServerEntry = { id: "local-stdio", type: "stdio", command: "node" };
    await expect(openMcpSession({ entry, timeoutMs: 1000 })).rejects.toBeInstanceOf(
      UnsupportedTransportError,
    );
  });

  test("refuses when a header credential is unresolved", async () => {
    const entry = httpEntry("https://example.test/mcp", {
      Authorization: "Bearer ${MISSING_TOKEN}",
    });
    await expect(openMcpSession({ entry, timeoutMs: 1000, env: {} })).rejects.toBeInstanceOf(
      MissingCredentialError,
    );
  });
});

describe("boundDiscoveredTool", () => {
  test("keeps a well-formed tool", () => {
    expect(
      boundDiscoveredTool({
        name: "search_news",
        description: "MT",
        inputSchema: { type: "object" },
      }),
    ).toEqual({ name: "search_news", description: "MT", inputSchema: { type: "object" } });
  });

  test("rejects a tool without a name", () => {
    expect(boundDiscoveredTool({ name: 123 })).toBeUndefined();
  });

  test("truncates an overlong description", () => {
    const bound = boundDiscoveredTool({ name: "t", description: "x".repeat(5000) });
    expect(bound?.description?.length).toBe(2000);
  });

  test("drops an oversized input schema", () => {
    const bound = boundDiscoveredTool({
      name: "t",
      inputSchema: { blob: "y".repeat(30_000) },
    });
    expect(bound?.inputSchema).toBeUndefined();
  });
});
