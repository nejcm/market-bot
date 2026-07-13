// Normalized MCP cache. Keyed by mapping ID, evidence-packet shape version,
// Canonical arguments, and a non-secret catalog fingerprint. Stores only what the
// Effective persistence policy permits and only normalized packets — never raw
// Provider text or credentials. Fresh hits bypass the server; a stale entry is
// Returned as audit-only and must not enter current normalized evidence.

import { join } from "node:path";
import type { McpServerEntry } from "./types";
import type { McpEvidencePacket, McpEvidencePacketShape, McpPersistencePolicy } from "./types";

const MINUTE_MS = 60 * 1000;

export interface McpCacheKeyInput {
  readonly mappingId: string;
  readonly shape: McpEvidencePacketShape;
  readonly args: unknown;
  readonly catalogFingerprint: string;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Deterministic serialization with recursively sorted object keys, so equivalent
// Arguments produce the same cache key regardless of property order.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .toSorted(([a], [b]) => (a < b ? -1 : (a > b ? 1 : 0)))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

export function canonicalArgumentsJson(args: unknown): string {
  return JSON.stringify(canonicalize(args));
}

// Non-secret fingerprint of a catalog server entry: transport + endpoint only.
// Header templates (which reference secrets) are deliberately excluded.
export function catalogServerFingerprint(entry: McpServerEntry): string {
  return entry.type === "http" ? `http:${entry.url}` : `stdio:${entry.command}`;
}

export async function mcpCacheKey(input: McpCacheKeyInput): Promise<string> {
  return sha256Hex(
    [
      input.mappingId,
      input.shape,
      input.catalogFingerprint,
      canonicalArgumentsJson(input.args),
    ].join("\n"),
  );
}

interface McpCacheEntry {
  readonly key: string;
  readonly mappingId: string;
  readonly shape: McpEvidencePacketShape;
  readonly fetchedAt: string;
  readonly packet: McpEvidencePacket;
}

export interface McpCacheOptions {
  readonly dir: string;
  readonly disabled: boolean;
  readonly now: () => Date;
  readonly freshnessTtlMinutes: number;
}

export type McpCacheReadResult =
  | { readonly status: "disabled" }
  | { readonly status: "miss" }
  | { readonly status: "hit-fresh"; readonly packet: McpEvidencePacket }
  | { readonly status: "stale-fallback"; readonly packet: McpEvidencePacket };

function entryPath(dir: string, key: string): string {
  return join(dir, "mcp", `${key}.json`);
}

function isCacheEntry(value: unknown, key: string): value is McpCacheEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as McpCacheEntry).key === key &&
    typeof (value as McpCacheEntry).fetchedAt === "string" &&
    !Number.isNaN(new Date((value as McpCacheEntry).fetchedAt).getTime()) &&
    typeof (value as McpCacheEntry).packet === "object"
  );
}

export async function readMcpCache(
  key: string,
  options: McpCacheOptions,
): Promise<McpCacheReadResult> {
  if (options.disabled) {
    return { status: "disabled" };
  }
  const file = Bun.file(entryPath(options.dir, key));
  if (!(await file.exists())) {
    return { status: "miss" };
  }
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    return { status: "miss" };
  }
  if (!isCacheEntry(parsed, key)) {
    return { status: "miss" };
  }
  const ageMs = options.now().getTime() - new Date(parsed.fetchedAt).getTime();
  if (ageMs <= options.freshnessTtlMinutes * MINUTE_MS) {
    return { status: "hit-fresh", packet: parsed.packet };
  }
  return { status: "stale-fallback", packet: parsed.packet };
}

// Writes a normalized packet under the effective persistence policy. "none"
// Stores nothing; "metadata-only" and "full" store the normalized packet, which
// By construction never contains full article bodies. Write failures are
// Non-fatal.
export async function writeMcpCache(
  key: string,
  input: {
    readonly mappingId: string;
    readonly shape: McpEvidencePacketShape;
    readonly packet: McpEvidencePacket;
  },
  persistence: McpPersistencePolicy,
  options: McpCacheOptions,
): Promise<void> {
  if (options.disabled || persistence === "none") {
    return;
  }
  const entry: McpCacheEntry = {
    key,
    mappingId: input.mappingId,
    shape: input.shape,
    fetchedAt: options.now().toISOString(),
    packet: input.packet,
  };
  try {
    await Bun.write(entryPath(options.dir, key), JSON.stringify(entry));
  } catch {
    // Cache write failures are non-fatal; the run continues without caching.
  }
}
