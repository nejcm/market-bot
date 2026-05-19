import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { withCache, type CacheOptions } from "../src/sources/cache";
import type { FetchJsonResult } from "../src/sources/types";

const fetchedAt = "2026-05-20T10:00:00.000Z";
const today = "2026-05-20";
const yesterday = "2026-05-19";

function makeNow(date: string): () => Date {
  return () => new Date(`${date}T12:00:00.000Z`);
}

function makeFetchResult(payload: unknown, adapter: string): FetchJsonResult {
  return {
    rawSnapshot: { id: `raw-${adapter}-${fetchedAt}`, adapter, fetchedAt, payload },
    payload,
  };
}

function makeOptions(
  cacheDir: string,
  overrides?: Partial<CacheOptions>,
): CacheOptions & { staleFallbackGaps: { source: string; message: string }[] } {
  const staleFallbackGaps: { source: string; message: string }[] = [];

  return {
    dir: cacheDir,
    disabled: false,
    fallbackDays: 7,
    now: makeNow(today),
    onStaleFallback: (gap) => {
      staleFallbackGaps.push(gap);
    },
    staleFallbackGaps,
    ...overrides,
  };
}

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cache-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("withCache", () => {
  test("miss calls inner and writes a cache file", async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return makeFetchResult({ value: 42 }, "test-adapter");
    };

    const opts = makeOptions(tmpDir);
    const cached = withCache(inner, opts);

    const result = await cached("https://example.test/api", "test-adapter", fetchedAt, 1000, fetch);

    expect(calls).toBe(1);
    expect("rawSnapshot" in result).toBe(true);

    const file = Bun.file(`${tmpDir}/${today}/${await sha256Hex("https://example.test/api")}.json`);
    expect(await file.exists()).toBe(true);
  });

  test("second call on same URL and date is a cache hit — inner not called again", async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return makeFetchResult({ value: 42 }, "test-adapter");
    };

    const opts = makeOptions(tmpDir);
    const cached = withCache(inner, opts);
    const url = "https://example.test/api";

    await cached(url, "test-adapter", fetchedAt, 1000, fetch);
    await cached(url, "test-adapter", fetchedAt, 1000, fetch);

    expect(calls).toBe(1);
  });

  test("cache hit returns the original fetchedAt from the stored entry", async () => {
    const originalFetchedAt = "2026-05-20T08:30:00.000Z";
    const inner = async () => makeFetchResult({ v: 1 }, "test-adapter");

    const firstResult = await withCache(inner, makeOptions(tmpDir))(
      "https://example.test/time",
      "test-adapter",
      originalFetchedAt,
      1000,
      fetch,
    );

    const laterFetchedAt = "2026-05-20T14:00:00.000Z";
    const hitResult = await withCache(inner, makeOptions(tmpDir))(
      "https://example.test/time",
      "test-adapter",
      laterFetchedAt,
      1000,
      fetch,
    );

    if ("rawSnapshot" in firstResult && "rawSnapshot" in hitResult) {
      expect(hitResult.rawSnapshot.fetchedAt).toBe(firstResult.rawSnapshot.fetchedAt);
    } else {
      throw new Error("Expected FetchJsonResult from both calls");
    }
  });

  test("live fetch failure with stale entry within fallbackDays returns stale payload and calls onStaleFallback", async () => {
    const stalePayload = { stale: true };

    const warmOpts = makeOptions(tmpDir, { now: makeNow(yesterday) });
    await withCache(async () => makeFetchResult(stalePayload, "test-adapter"), warmOpts)(
      "https://example.test/data",
      "test-adapter",
      fetchedAt,
      1000,
      fetch,
    );

    const gap = { source: "test-adapter", message: "timeout" };
    const inner = async () => gap;

    const opts = makeOptions(tmpDir);
    const result = await withCache(inner, opts)(
      "https://example.test/data",
      "test-adapter",
      fetchedAt,
      1000,
      fetch,
    );

    expect("rawSnapshot" in result).toBe(true);
    if ("rawSnapshot" in result) {
      expect(result.payload).toEqual(stalePayload);
    }
    expect(opts.staleFallbackGaps).toHaveLength(1);
    expect(opts.staleFallbackGaps[0]?.message).toContain("cache-fallback");
    expect(opts.staleFallbackGaps[0]?.message).toContain("stalenessDays=1");
  });

  test("live fetch failure with no stale entry within fallbackDays returns original SourceGap", async () => {
    const gap = { source: "test-adapter", message: "timeout" };
    const inner = async () => gap;

    const opts = makeOptions(tmpDir);
    const result = await withCache(inner, opts)(
      "https://example.test/missing",
      "test-adapter",
      fetchedAt,
      1000,
      fetch,
    );

    expect("source" in result).toBe(true);
    if ("source" in result) {
      expect(result.source).toBe("test-adapter");
    }
    expect(opts.staleFallbackGaps).toHaveLength(0);
  });

  test("disabled cache bypasses read and write", async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return makeFetchResult({ n: calls }, "test-adapter");
    };

    const opts = makeOptions(tmpDir, { disabled: true });
    const cached = withCache(inner, opts);
    const url = "https://example.test/disabled";

    await cached(url, "test-adapter", fetchedAt, 1000, fetch);
    await cached(url, "test-adapter", fetchedAt, 1000, fetch);

    expect(calls).toBe(2);
  });
});

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
