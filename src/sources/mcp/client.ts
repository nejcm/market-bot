// Streamable HTTP MCP client. Slice 2 supports Streamable HTTP only (JSON and
// SSE response modes are handled by the SDK transport). One session per eligible
// Server per run: initialize, discover tools, validate, call, and always close
// The transport in `finally`. stdio is recognized but never spawned.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolveHeaderTemplate } from "./catalog";
import type { McpServerEntry } from "./types";

const CLIENT_INFO = { name: "market-bot", version: "1" } as const;

// Bounds on provider-controlled discovery metadata before it can reach model
// Context (Slice 2B). Names/descriptions are truncated; oversized input schemas
// Are dropped rather than forwarded.
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_TOOL_DESCRIPTION_LENGTH = 2000;
const MAX_INPUT_SCHEMA_JSON_LENGTH = 20_000;

export class UnsupportedTransportError extends Error {
  constructor(public readonly serverId: string) {
    super(`server "${serverId}" uses an unsupported transport for Slice 2`);
    this.name = "UnsupportedTransportError";
  }
}

export class MissingCredentialError extends Error {
  constructor(public readonly serverId: string) {
    super(`server "${serverId}" is missing a required credential environment variable`);
    this.name = "MissingCredentialError";
  }
}

export interface McpDiscoveredTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

export interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
}

export interface McpCallResult {
  readonly content: readonly McpContentBlock[];
  readonly structuredContent?: unknown;
  readonly isError: boolean;
}

export interface McpSession {
  listTools(): Promise<readonly McpDiscoveredTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface OpenMcpSessionOptions {
  readonly entry: McpServerEntry;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  // Injected network implementation; defaults to global fetch. Tests inject a
  // Real loopback fetch to exercise the transport without a live provider.
  readonly fetch?: typeof fetch;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

// Bounds one discovered tool: truncates name/description and drops an oversized
// Input schema. Provider text is treated as untrusted data, never instructions.
export function boundDiscoveredTool(raw: {
  readonly name: unknown;
  readonly description?: unknown;
  readonly inputSchema?: unknown;
}): McpDiscoveredTool | undefined {
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    return undefined;
  }
  const name = truncate(raw.name, MAX_TOOL_NAME_LENGTH);
  const description =
    typeof raw.description === "string"
      ? truncate(raw.description, MAX_TOOL_DESCRIPTION_LENGTH)
      : undefined;
  let inputSchema: Record<string, unknown> | undefined;
  if (typeof raw.inputSchema === "object" && raw.inputSchema !== null) {
    const json = JSON.stringify(raw.inputSchema);
    if (json.length <= MAX_INPUT_SCHEMA_JSON_LENGTH) {
      inputSchema = raw.inputSchema as Record<string, unknown>;
    }
  }
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
  };
}

function resolveHttpHeaders(
  entry: McpServerEntry & { readonly type: "http" },
  env: Record<string, string | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, template] of Object.entries(entry.headers ?? {})) {
    const resolved = resolveHeaderTemplate(template, env);
    if (resolved === undefined) {
      throw new MissingCredentialError(entry.id);
    }
    headers[key] = resolved;
  }
  return headers;
}

function toContentBlocks(content: unknown): readonly McpContentBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((block) => {
    const record = block as { type?: unknown; text?: unknown };
    const type = typeof record.type === "string" ? record.type : "unknown";
    return typeof record.text === "string" ? { type, text: record.text } : { type };
  });
}

// Opens a Streamable HTTP session. stdio entries throw UnsupportedTransportError
// Without spawning a process; unresolved header credentials throw
// MissingCredentialError before any network call. Prefer withMcpSession, which
// Guarantees the transport is closed.
export async function openMcpSession(options: OpenMcpSessionOptions): Promise<McpSession> {
  const { entry } = options;
  if (entry.type !== "http") {
    throw new UnsupportedTransportError(entry.id);
  }
  const env = options.env ?? process.env;
  const headers = resolveHttpHeaders(entry, env);

  const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
    requestInit: { headers, ...(options.signal !== undefined ? { signal: options.signal } : {}) },
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  // Advertise no client capabilities: tools-only usage, no sampling, elicitation,
  // Roots, or resource/prompt participation.
  const client = new Client(CLIENT_INFO, { capabilities: {} });

  const requestOptions = {
    timeout: options.timeoutMs,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };

  // The SDK's concrete transport is structurally incompatible with the Transport
  // Interface only under exactOptionalPropertyTypes; it does implement it.
  try {
    await client.connect(transport as unknown as Transport, requestOptions);
  } catch (error) {
    // A failed initialize must not leave the transport open.
    await transport.close().catch(() => {});
    throw error;
  }

  return {
    async listTools() {
      const result = await client.listTools(undefined, requestOptions);
      const tools = Array.isArray(result.tools) ? result.tools : [];
      return tools
        .map((tool) => boundDiscoveredTool(tool))
        .filter((tool): tool is McpDiscoveredTool => tool !== undefined);
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args }, undefined, requestOptions);
      return {
        content: toContentBlocks(result.content),
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        isError: result.isError === true,
      };
    },
    async close() {
      try {
        await client.close();
      } catch {
        // Closing a session that already failed must never surface as a run error.
      }
    },
  };
}

export async function withMcpSession<T>(
  options: OpenMcpSessionOptions,
  run: (session: McpSession) => Promise<T>,
): Promise<T> {
  const session = await openMcpSession(options);
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}
