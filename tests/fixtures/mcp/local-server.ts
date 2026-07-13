// Deterministic local MT-compatible MCP server for the normal Bun test suite.
// Runs the pinned SDK server over node:http so client tests exercise the real
// Streamable HTTP transport (JSON and SSE modes), not a mocked facade.

import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface LocalMcpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

export interface LocalMcpCallResult {
  readonly content?: readonly unknown[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export interface LocalMcpServerOptions {
  // Streamable HTTP response mode: JSON (true) or SSE (false, default).
  readonly enableJsonResponse?: boolean;
  // Advertised tools; defaults to a single MT `search_news`.
  readonly tools?: readonly LocalMcpToolDescriptor[];
  // Tool executor; defaults to a valid metadata-only news_search.v1 result.
  readonly onCallTool?: (
    name: string,
    args: Record<string, unknown>,
  ) => LocalMcpCallResult | Promise<LocalMcpCallResult>;
  // Milliseconds to stall before handling every request (drives timeout/abort).
  readonly requestDelayMs?: number;
  // Milliseconds to stall only session-termination DELETE requests.
  readonly terminationDelayMs?: number;
  // Reject the initialize POST with HTTP 500 (drives initialization failure).
  readonly failInitialize?: boolean;
}

export interface LocalMcpServer {
  readonly url: string;
  // Session IDs the client asked the server to terminate via HTTP DELETE.
  readonly sessionDeletes: readonly string[];
  close(): Promise<void>;
}

const DEFAULT_TOOL: LocalMcpToolDescriptor = {
  name: "search_news",
  description: "MT Newswires search_news",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

function defaultCallResult(): LocalMcpCallResult {
  const packet = {
    shape: "news_search.v1",
    items: [
      {
        title: "Example headline",
        publishedAt: "2026-01-01T00:00:00.000Z",
        providerArticleId: "mt-1",
      },
    ],
  };
  return {
    structuredContent: packet,
    content: [{ type: "text", text: JSON.stringify(packet) }],
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function isInitialize(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { method?: unknown }).method === "initialize"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

export async function startLocalMcpServer(
  options: LocalMcpServerOptions = {},
): Promise<LocalMcpServer> {
  const tools = options.tools ?? [DEFAULT_TOOL];
  const onCallTool = options.onCallTool ?? (() => defaultCallResult());

  const server = new Server(
    { name: "local-mt-fixture", version: "1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema ?? { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await onCallTool(request.params.name, request.params.arguments ?? {});
    return {
      content: result.content ?? [],
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
    };
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    ...(options.enableJsonResponse !== undefined
      ? { enableJsonResponse: options.enableJsonResponse }
      : {}),
  });
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);

  // Track live sockets so close() can force-destroy them. The timeout/abort tests
  // Abandon in-flight requests; without a forced teardown those sockets and the
  // Delay timer would outlive the test and destabilize unrelated suites.
  const sockets = new Set<Socket>();
  const sessionDeletes: string[] = [];
  let closed = false;

  const http: HttpServer = createServer(async (req, res) => {
    const delayMs =
      req.method === "DELETE" && options.terminationDelayMs !== undefined
        ? options.terminationDelayMs
        : options.requestDelayMs;
    if (delayMs !== undefined) {
      await delay(delayMs);
    }
    if (closed) {
      res.destroy();
      return;
    }
    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"];
      if (typeof sessionId === "string") {
        sessionDeletes.push(sessionId);
      }
    }
    const body = await readJsonBody(req);
    if (options.failInitialize === true && isInitialize(body)) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "initialize rejected" }));
      return;
    }
    await transport.handleRequest(
      req as Parameters<typeof transport.handleRequest>[0],
      res as Parameters<typeof transport.handleRequest>[1],
      body,
    );
  });
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind local MCP server");
  }
  const url = `http://127.0.0.1:${String(address.port)}/mcp`;

  return {
    url,
    get sessionDeletes() {
      return sessionDeletes;
    },
    async close() {
      closed = true;
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
