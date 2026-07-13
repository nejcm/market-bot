import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  canonicalArgumentsJson,
  catalogServerFingerprint,
  mcpCacheKey,
  readMcpCache,
  writeMcpCache,
  type McpCacheOptions,
} from "../src/sources/mcp/cache";
import type { McpHttpServerEntry, NewsSearchV1Packet } from "../src/sources/mcp/types";

const PACKET: NewsSearchV1Packet = {
  shape: "news_search.v1",
  items: [{ title: "t", publishedAt: "2026-01-01T00:00:00.000Z", providerArticleId: "mt-1" }],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function options(overrides: Partial<McpCacheOptions> = {}): McpCacheOptions {
  return {
    dir,
    disabled: false,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    freshnessTtlMinutes: 60,
    ...overrides,
  };
}

describe("cache keys", () => {
  test("is stable regardless of argument key order", async () => {
    const a = await mcpCacheKey({
      mappingId: "m",
      shape: "news_search.v1",
      args: { a: 1, b: 2 },
      catalogFingerprint: "f",
    });
    const b = await mcpCacheKey({
      mappingId: "m",
      shape: "news_search.v1",
      args: { b: 2, a: 1 },
      catalogFingerprint: "f",
    });
    expect(a).toBe(b);
  });

  test("differs on mapping, arguments, and fingerprint", async () => {
    const base = {
      mappingId: "m",
      shape: "news_search.v1" as const,
      args: { q: "x" },
      catalogFingerprint: "f",
    };
    const keys = await Promise.all([
      mcpCacheKey(base),
      mcpCacheKey({ ...base, mappingId: "n" }),
      mcpCacheKey({ ...base, args: { q: "y" } }),
      mcpCacheKey({ ...base, catalogFingerprint: "g" }),
    ]);
    expect(new Set(keys).size).toBe(4);
  });

  test("canonicalizes by dropping undefined and sorting", () => {
    expect(canonicalArgumentsJson({ b: 1, a: undefined, c: 2 })).toBe('{"b":1,"c":2}');
  });

  test("fingerprint excludes header templates", () => {
    const entry: McpHttpServerEntry = {
      id: "mt",
      type: "http",
      url: "https://mt.test/mcp",
      headers: { Authorization: "Bearer ${TOKEN}" },
    };
    expect(catalogServerFingerprint(entry)).toBe("http:https://mt.test/mcp");
  });
});

describe("cache read/write", () => {
  async function write(
    persistence: "metadata-only" | "full" | "none",
    opts = options(),
  ): Promise<string> {
    const key = "abc";
    await writeMcpCache(
      key,
      { mappingId: "m", shape: "news_search.v1", packet: PACKET },
      persistence,
      opts,
    );
    return key;
  }

  test("misses when absent", async () => {
    expect(await readMcpCache("missing", options())).toEqual({ status: "miss" });
  });

  test("returns a fresh hit within TTL", async () => {
    const key = await write("metadata-only");
    expect(await readMcpCache(key, options())).toEqual({ status: "hit-fresh", packet: PACKET });
  });

  test("returns a stale fallback past TTL", async () => {
    const key = await write("metadata-only");
    const later = options({ now: () => new Date("2026-01-01T02:00:00.000Z") });
    expect(await readMcpCache(key, later)).toEqual({ status: "stale-fallback", packet: PACKET });
  });

  test("does not write under persistence none", async () => {
    const key = await write("none");
    expect(await readMcpCache(key, options())).toEqual({ status: "miss" });
  });

  test("disabled cache never reads or writes", async () => {
    const disabled = options({ disabled: true });
    await write("metadata-only", disabled);
    expect(await readMcpCache("abc", disabled)).toEqual({ status: "disabled" });
    // Even a prior fresh write is skipped, so an enabled read also misses
    expect(await readMcpCache("abc", options())).toEqual({ status: "miss" });
  });
});
