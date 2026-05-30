import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  makeCacheKeyForTest,
  pruneCache,
  withCache,
  type CacheOptions,
} from "../src/sources/cache";
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

    const file = Bun.file(
      `${tmpDir}/${today}/${await cacheKey("https://example.test/api", "test-adapter")}.json`,
    );
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

  test("reordered query params share a canonical cache key", async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return makeFetchResult({ value: 42 }, "test-adapter");
    };

    const cached = withCache(inner, makeOptions(tmpDir));

    await cached("https://example.test/api?b=2&a=1", "test-adapter", fetchedAt, 1000, fetch);
    await cached("https://example.test/api?a=1&b=2", "test-adapter", fetchedAt, 1000, fetch);

    expect(calls).toBe(1);
  });

  test("credential query params do not affect the cache key", async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return makeFetchResult({ value: 42 }, "test-adapter");
    };

    const cached = withCache(inner, makeOptions(tmpDir));

    await cached(
      "https://example.test/api?series_id=DGS10&api_key=first",
      "test-adapter",
      fetchedAt,
      1000,
      fetch,
    );
    await cached(
      "https://example.test/api?api_key=second&series_id=DGS10",
      "test-adapter",
      fetchedAt,
      1000,
      fetch,
    );
    await cached(
      "https://example.test/api?access_token=third&series_id=DGS10",
      "test-adapter",
      fetchedAt,
      1000,
      fetch,
    );

    expect(calls).toBe(1);
  });

  test("request-shaping params keep separate cache entries", async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return makeFetchResult({ value: calls }, "test-adapter");
    };

    const cached = withCache(inner, makeOptions(tmpDir));

    await cached(
      "https://example.test/api?series_id=DGS10&limit=2&api_key=secret",
      "test-adapter",
      fetchedAt,
      1000,
      fetch,
    );
    await cached(
      "https://example.test/api?series_id=DGS10&limit=3&api_key=secret",
      "test-adapter",
      fetchedAt,
      1000,
      fetch,
    );

    expect(calls).toBe(2);
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

  test("live fetch failure with stale canonical entry within fallbackDays returns stale payload and calls onStaleFallback", async () => {
    const stalePayload = { stale: true };

    const warmOpts = makeOptions(tmpDir, { now: makeNow(yesterday) });
    await withCache(async () => makeFetchResult(stalePayload, "test-adapter"), warmOpts)(
      "https://example.test/data?api_key=old&series_id=DGS10",
      "test-adapter",
      fetchedAt,
      1000,
      fetch,
    );

    const gap = { source: "test-adapter", message: "timeout" };
    const inner = async () => gap;

    const opts = makeOptions(tmpDir);
    const result = await withCache(inner, opts)(
      "https://example.test/data?series_id=DGS10&api_key=new",
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

describe("pruneCache", () => {
  test("removes raw cache days after 30 days and close files after 365 days", async () => {
    const oldRawDir = join(tmpDir, "2026-04-01");
    const freshRawDir = join(tmpDir, "2026-05-10");
    const oldCloseFile = join(tmpDir, "closes", "equity", "spy", "2025-01-01.json");
    const freshCloseFile = join(tmpDir, "closes", "equity", "spy", "2026-05-01.json");

    mkdirSync(oldRawDir, { recursive: true });
    mkdirSync(freshRawDir, { recursive: true });
    mkdirSync(join(tmpDir, "closes", "equity", "spy"), { recursive: true });
    writeFileSync(join(oldRawDir, "old.json"), "{}");
    writeFileSync(join(freshRawDir, "fresh.json"), "{}");
    writeFileSync(oldCloseFile, "{}");
    writeFileSync(freshCloseFile, "{}");

    const result = await pruneCache({
      dir: tmpDir,
      now: new Date("2026-05-20T00:00:00.000Z"),
      rawRetentionDays: 30,
      closeRetentionDays: 365,
    });

    expect(result).toEqual({ rawDaysPruned: 1, closeFilesPruned: 1 });
    expect(existsSync(oldRawDir)).toBe(false);
    expect(existsSync(freshRawDir)).toBe(true);
    expect(existsSync(oldCloseFile)).toBe(false);
    expect(existsSync(freshCloseFile)).toBe(true);
  });
});

const cacheKey = makeCacheKeyForTest;
