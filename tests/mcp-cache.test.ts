import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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
    fallbackDays: 7,
    ...overrides,
  };
}

// Writes a raw cache file bypassing writeMcpCache, to exercise validation.
async function writeRawEntry(key: string, entry: unknown): Promise<void> {
  await mkdir(join(dir, "mcp"), { recursive: true });
  await writeFile(join(dir, "mcp", `${key}.json`), JSON.stringify(entry));
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

  test("fingerprint excludes resolved credential values", () => {
    const entry: McpHttpServerEntry = {
      id: "mt",
      type: "http",
      url: "https://mt.test/mcp",
      headers: { Authorization: "Bearer ${TOKEN}" },
    };
    expect(catalogServerFingerprint(entry)).toBe(
      '{"type":"http","id":"mt","url":"https://mt.test/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}}',
    );
  });

  test("fingerprint changes when the header template changes", () => {
    const base: McpHttpServerEntry = { id: "mt", type: "http", url: "https://mt.test/mcp" };
    const tenantA = catalogServerFingerprint({
      ...base,
      headers: { Authorization: "Bearer ${TOKEN_A}" },
    });
    const tenantB = catalogServerFingerprint({
      ...base,
      headers: { Authorization: "Bearer ${TOKEN_B}" },
    });
    expect(tenantA).not.toBe(tenantB);
  });

  test("fingerprint distinguishes argument boundaries", () => {
    const combined = catalogServerFingerprint({
      id: "local",
      type: "stdio",
      command: "server",
      args: ["alpha beta"],
    });
    const separate = catalogServerFingerprint({
      id: "local",
      type: "stdio",
      command: "server",
      args: ["alpha", "beta"],
    });

    expect(combined).not.toBe(separate);
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

  test("returns a stale fallback past TTL but within the fallback window", async () => {
    const key = await write("metadata-only");
    const later = options({ now: () => new Date("2026-01-01T02:00:00.000Z") });
    expect(await readMcpCache(key, later)).toEqual({ status: "stale-fallback", packet: PACKET });
  });

  test("misses beyond the fallback window", async () => {
    const key = await write("metadata-only");
    const wayLater = options({ now: () => new Date("2026-01-20T00:00:00.000Z") });
    expect(await readMcpCache(key, wayLater)).toEqual({ status: "miss" });
  });

  test("misses an entry fetched in the future", async () => {
    const key = "future";
    await writeRawEntry(key, {
      key,
      mappingId: "m",
      shape: "news_search.v1",
      fetchedAt: "2026-01-02T00:00:00.000Z",
      packet: PACKET,
    });

    expect(await readMcpCache(key, options())).toEqual({ status: "miss" });
  });

  test("strips unknown packet and item fields from cache reads", async () => {
    const key = "unknown-fields";
    await writeRawEntry(key, {
      key,
      mappingId: "m",
      shape: "news_search.v1",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      packet: {
        shape: "news_search.v1",
        body: "raw packet text",
        items: [{ ...PACKET.items[0]!, body: "raw article text" }],
      },
    });

    expect(await readMcpCache(key, options())).toEqual({ status: "hit-fresh", packet: PACKET });
  });

  test("does not persist unknown packet and item fields", async () => {
    const packetWithRawText = {
      ...PACKET,
      body: "raw packet text",
      items: [{ ...PACKET.items[0]!, body: "raw article text" }],
    };
    await writeMcpCache(
      "sanitized-write",
      { mappingId: "m", shape: "news_search.v1", packet: packetWithRawText },
      "metadata-only",
      options(),
    );

    const persisted = await Bun.file(join(dir, "mcp", "sanitized-write.json")).text();
    expect(persisted).not.toContain("raw packet text");
    expect(persisted).not.toContain("raw article text");
  });

  test("misses packet strings beyond their bounds", async () => {
    const key = "oversized-string";
    await writeRawEntry(key, {
      key,
      mappingId: "m",
      shape: "news_search.v1",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      packet: {
        shape: "news_search.v1",
        items: [{ ...PACKET.items[0]!, title: "x".repeat(10_000) }],
      },
    });

    expect(await readMcpCache(key, options())).toEqual({ status: "miss" });
  });

  test("misses a null or malformed packet", async () => {
    const nullPacket = "null-packet";
    await writeRawEntry(nullPacket, {
      key: nullPacket,
      mappingId: "m",
      shape: "news_search.v1",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      packet: null,
    });
    expect(await readMcpCache(nullPacket, options())).toEqual({ status: "miss" });

    const badItem = "bad-item";
    await writeRawEntry(badItem, {
      key: badItem,
      mappingId: "m",
      shape: "news_search.v1",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      packet: { shape: "news_search.v1", items: [{ title: "t" }] },
    });
    expect(await readMcpCache(badItem, options())).toEqual({ status: "miss" });

    const shapeMismatch = "shape-mismatch";
    await writeRawEntry(shapeMismatch, {
      key: shapeMismatch,
      mappingId: "m",
      shape: "document_search.v1",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      packet: PACKET,
    });
    expect(await readMcpCache(shapeMismatch, options())).toEqual({ status: "miss" });
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
