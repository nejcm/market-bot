// Normalized MCP cache. Keyed by mapping ID, evidence-packet shape version,
// Canonical arguments, and a non-secret catalog fingerprint. Stores only what the
// Effective persistence policy permits and only normalized packets — never raw
// Provider text or credentials. Fresh hits bypass the server; a stale entry is
// Returned as audit-only and must not enter current normalized evidence.

import { join } from "node:path";
import { isRecord } from "../guards";
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
const MAX_TITLE_LENGTH = 500;
const MAX_PUBLISHED_AT_LENGTH = 64;
const MAX_PROVIDER_ARTICLE_ID_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const MAX_PUBLISHER_LENGTH = 256;
const MAX_SUMMARY_LENGTH = 4000;
const MAX_SNIPPET_LENGTH = 2000;

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
    const headers = Object.fromEntries(
      Object.entries(entry.headers ?? {}).toSorted(([a], [b]) => compareStrings(a, b)),
    );
    return JSON.stringify({ type: "http", id: entry.id, url: entry.url, headers });
  }
  return JSON.stringify({
    type: "stdio",
    id: entry.id,
    command: entry.command,
    args: entry.args ?? [],
  });
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

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isOptionalBoundedString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function sanitizeNewsSearchV1Item(value: unknown): NewsSearchV1Item | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const item = value;
  if (
    !isBoundedNonEmptyString(item.title, MAX_TITLE_LENGTH) ||
    !isBoundedNonEmptyString(item.publishedAt, MAX_PUBLISHED_AT_LENGTH) ||
    !isBoundedNonEmptyString(item.providerArticleId, MAX_PROVIDER_ARTICLE_ID_LENGTH) ||
    !isOptionalBoundedString(item.url, MAX_URL_LENGTH) ||
    !isOptionalBoundedString(item.publisher, MAX_PUBLISHER_LENGTH) ||
    !isOptionalBoundedString(item.summary, MAX_SUMMARY_LENGTH) ||
    !isOptionalBoundedString(item.snippet, MAX_SNIPPET_LENGTH)
  ) {
    return undefined;
  }
  return {
    title: item.title,
    publishedAt: item.publishedAt,
    providerArticleId: item.providerArticleId,
    ...(item.url !== undefined ? { url: item.url } : {}),
    ...(item.publisher !== undefined ? { publisher: item.publisher } : {}),
    ...(item.summary !== undefined ? { summary: item.summary } : {}),
    ...(item.snippet !== undefined ? { snippet: item.snippet } : {}),
  };
}

function sanitizeNewsSearchV1Packet(value: unknown): NewsSearchV1Packet | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const packet = value;
  if (
    packet.shape !== "news_search.v1" ||
    !Array.isArray(packet.items) ||
    packet.items.length > MAX_PACKET_ITEMS
  ) {
    return undefined;
  }
  const items = packet.items.map(sanitizeNewsSearchV1Item);
  if (!items.every((item): item is NewsSearchV1Item => item !== undefined)) {
    return undefined;
  }
  return { shape: "news_search.v1", items };
}

function parseCacheEntry(value: unknown, key: string): McpCacheEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entry = value;
  const packet = sanitizeNewsSearchV1Packet(entry.packet);
  if (
    entry.key !== key ||
    !isBoundedNonEmptyString(entry.mappingId, 512) ||
    typeof entry.fetchedAt !== "string" ||
    Number.isNaN(new Date(entry.fetchedAt).getTime()) ||
    packet === undefined ||
    entry.shape !== packet.shape
  ) {
    return undefined;
  }
  return {
    key,
    mappingId: entry.mappingId,
    shape: packet.shape,
    fetchedAt: entry.fetchedAt,
    packet,
  };
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
  const entry = parseCacheEntry(parsed, key);
  if (entry === undefined) {
    return { status: "miss" };
  }
  const ageMs = options.now().getTime() - new Date(entry.fetchedAt).getTime();
  if (ageMs < 0) {
    return { status: "miss" };
  }
  if (ageMs <= options.freshnessTtlMinutes * MINUTE_MS) {
    return { status: "hit-fresh", packet: entry.packet };
  }
  if (ageMs <= options.fallbackDays * DAY_MS) {
    return { status: "stale-fallback", packet: entry.packet };
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
  const packet = sanitizeNewsSearchV1Packet(input.packet);
  if (packet === undefined || packet.shape !== input.shape) {
    return;
  }
  const entry: McpCacheEntry = {
    key,
    mappingId: input.mappingId,
    shape: input.shape,
    fetchedAt: options.now().toISOString(),
    packet,
  };
  try {
    await Bun.write(entryPath(options.dir, key), JSON.stringify(entry));
  } catch {
    // Cache write failures are non-fatal; the run continues without caching.
  }
}
