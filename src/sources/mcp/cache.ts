// Normalized MCP cache. Keyed by mapping ID, evidence-packet shape version,
// Canonical arguments, and a non-secret catalog fingerprint. Stores only what the
// Effective persistence policy permits and only normalized packets — never raw
// Provider text or credentials. Fresh hits bypass the server; a stale entry is
// Returned as audit-only and must not enter current normalized evidence.

import { join } from "node:path";
import type {
  McpEvidencePacket,
  McpEvidencePacketShape,
  McpPersistencePolicy,
  McpServerEntry,
  NewsSearchV1Item,
  NewsSearchV1Packet,
} from "./types";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// Guards a corrupt or hostile cache file from yielding an unbounded packet.
const MAX_PACKET_ITEMS = 200;

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

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
        .toSorted(([a], [b]) => compareStrings(a, b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

export function canonicalArgumentsJson(args: unknown): string {
  return JSON.stringify(canonicalize(args));
}

// Non-secret fingerprint of a catalog server entry. Binds the cache to the
// Connection configuration — server ID, endpoint, and header templates — so a
// Tenant/auth change invalidates prior entries. Header templates name env vars
// (e.g. `Bearer ${TOKEN}`) and are non-secret; resolved values never appear here.
export function catalogServerFingerprint(entry: McpServerEntry): string {
  if (entry.type === "http") {
    const headers = Object.entries(entry.headers ?? {})
      .toSorted(([a], [b]) => compareStrings(a, b))
      .map(([key, template]) => `${key}=${template}`)
      .join("&");
    return `http:${entry.id}:${entry.url}:${headers}`;
  }
  return `stdio:${entry.id}:${entry.command}:${(entry.args ?? []).join(" ")}`;
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
  // Reuses MARKET_BOT_CACHE_FALLBACK_DAYS: entries past the freshness TTL are
  // Audit-only stale fallbacks up to this age; older entries miss entirely.
  readonly fallbackDays: number;
}

export type McpCacheReadResult =
  | { readonly status: "disabled" }
  | { readonly status: "miss" }
  | { readonly status: "hit-fresh"; readonly packet: McpEvidencePacket }
  | { readonly status: "stale-fallback"; readonly packet: McpEvidencePacket };

function entryPath(dir: string, key: string): string {
  return join(dir, "mcp", `${key}.json`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isNewsSearchV1Item(value: unknown): value is NewsSearchV1Item {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    isNonEmptyString(item.title) &&
    isNonEmptyString(item.publishedAt) &&
    isNonEmptyString(item.providerArticleId) &&
    isOptionalString(item.url) &&
    isOptionalString(item.publisher) &&
    isOptionalString(item.summary) &&
    isOptionalString(item.snippet)
  );
}

function isNewsSearchV1Packet(value: unknown): value is NewsSearchV1Packet {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const packet = value as Record<string, unknown>;
  return (
    packet.shape === "news_search.v1" &&
    Array.isArray(packet.items) &&
    packet.items.length <= MAX_PACKET_ITEMS &&
    packet.items.every(isNewsSearchV1Item)
  );
}

function isMcpEvidencePacket(value: unknown): value is McpEvidencePacket {
  return isNewsSearchV1Packet(value);
}

function isCacheEntry(value: unknown, key: string): value is McpCacheEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    entry.key === key &&
    isNonEmptyString(entry.mappingId) &&
    typeof entry.fetchedAt === "string" &&
    !Number.isNaN(new Date(entry.fetchedAt).getTime()) &&
    isMcpEvidencePacket(entry.packet) &&
    entry.shape === entry.packet.shape
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
  if (ageMs <= options.fallbackDays * DAY_MS) {
    return { status: "stale-fallback", packet: parsed.packet };
  }
  return { status: "miss" };
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
