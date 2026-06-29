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
import type { FetchJsonResult, SourceRequest } from "../src/sources/types";

const fetchedAt = "2026-05-20T11:55:00.000Z";
const today = "2026-05-20";
const yesterday = "2026-05-19";

function makeNow(date: string): () => Date {
  return () => new Date(`${date}T12:00:00.000Z`);
}

function makeFetchResult(
  payload: unknown,
  adapter: string,
  fetchedAtOverride = fetchedAt,
): FetchJsonResult {
  return {
    rawSnapshot: {
      id: `raw-${adapter}-${fetchedAtOverride}`,
      adapter,
      fetchedAt: fetchedAtOverride,
      payload,
    },
    payload,
  };
}

function request(url: string, adapter = "test-adapter", init?: RequestInit): SourceRequest {
  return { url, adapter, init };
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

    const result = await cached(request("https://example.test/api"));

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

    await cached(request(url));
    await cached(request(url));

    expect(calls).toBe(1);
  });

  test("over-budget same-day cache refetches and overwrites on success", async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return makeFetchResult(
        { value: calls },
        "test-adapter",
        calls === 1 ? "2026-05-20T10:00:00.000Z" : "2026-05-20T11:59:00.000Z",
      );
    };

    const cached = withCache(inner, makeOptions(tmpDir));
    const url = "https://example.test/api";

    await cached(request(url));
    const result = await cached(request(url));

    expect(calls).toBe(2);
    if ("rawSnapshot" in result) {
      expect(result.payload).toEqual({ value: 2 });
      expect(result.rawSnapshot.cacheStatus).toBeUndefined();
    } else {
      throw new Error("Expected FetchJsonResult");
    }
  });

  test("over-budget same-day cache uses stale fallback on live failure", async () => {
    const stalePayload = { stale: true };
    await withCache(
      async () => makeFetchResult(stalePayload, "test-adapter", "2026-05-20T10:00:00.000Z"),
      makeOptions(tmpDir),
    )(request("https://example.test/data"));

    const opts = makeOptions(tmpDir);
    const result = await withCache(
      async () => ({ source: "test-adapter", message: "timeout" }),
      opts,
    )(request("https://example.test/data"));

    expect("rawSnapshot" in result).toBe(true);
    if ("rawSnapshot" in result) {
      expect(result.payload).toBeUndefined();
      expect(result.rawSnapshot.payload).toEqual(stalePayload);
      expect(result.rawSnapshot.cacheStatus).toBe("stale-fallback");
    }
    expect(opts.staleFallbackGaps).toHaveLength(1);
    expect(opts.staleFallbackGaps[0]?.message).toContain("stalenessDays=0");
  });

  test("reordered query params share a canonical cache key", async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return makeFetchResult({ value: 42 }, "test-adapter");
    };

    const cached = withCache(inner, makeOptions(tmpDir));

    await cached(request("https://example.test/api?b=2&a=1"));
    await cached(request("https://example.test/api?a=1&b=2"));

    expect(calls).toBe(1);
  });

  test("credential query params do not affect the cache key", async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return makeFetchResult({ value: 42 }, "test-adapter");
    };

    const cached = withCache(inner, makeOptions(tmpDir));

    await cached(request("https://example.test/api?series_id=DGS10&api_key=first"));
    await cached(request("https://example.test/api?api_key=second&series_id=DGS10"));
    await cached(request("https://example.test/api?access_token=third&series_id=DGS10"));

    expect(calls).toBe(1);
  });

  test("request-shaping params keep separate cache entries", async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return makeFetchResult({ value: calls }, "test-adapter");
    };

    const cached = withCache(inner, makeOptions(tmpDir));

    await cached(request("https://example.test/api?series_id=DGS10&limit=2&api_key=secret"));
    await cached(request("https://example.test/api?series_id=DGS10&limit=3&api_key=secret"));

    expect(calls).toBe(2);
  });

  test("POST request body participates in the cache key", async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return makeFetchResult({ value: calls }, "exa-search");
    };

    const cached = withCache(inner, makeOptions(tmpDir));
    const url = "https://api.exa.ai/search";

    await cached(request(url, "exa-search", { method: "POST", body: '{"query":"a"}' }));
    await cached(request(url, "exa-search", { method: "POST", body: '{"query":"b"}' }));
    await cached(request(url, "exa-search", { method: "POST", body: '{"query":"a"}' }));

    expect(calls).toBe(2);
  });

  test("unsupported non-GET body forms bypass cache", async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return makeFetchResult({ value: calls }, "test-adapter");
    };

    const cached = withCache(inner, makeOptions(tmpDir));
    const init = { method: "POST", body: new URLSearchParams("q=a") };

    await cached(request("https://example.test/api", "test-adapter", init));
    await cached(request("https://example.test/api", "test-adapter", init));

    expect(calls).toBe(2);
  });

  test("adapter freshness budgets classify live news and reference sources", async () => {
    let calls = 0;
    const inner = async (sourceRequest: SourceRequest) => {
      calls += 1;
      return makeFetchResult({ value: calls }, sourceRequest.adapter, "2026-05-20T11:10:00.000Z");
    };

    const cached = withCache(inner, makeOptions(tmpDir));

    await cached(request("https://example.test/live", "yahoo-ticker"));
    await cached(request("https://example.test/live", "yahoo-ticker"));
    await cached(request("https://example.test/news", "marketaux-news"));
    await cached(request("https://example.test/news", "marketaux-news"));
    await cached(request("https://example.test/sec", "sec-tickers"));
    await cached(request("https://example.test/sec", "sec-tickers"));

    expect(calls).toBe(4);
  });

  test("cache hit returns the original fetchedAt from the stored entry", async () => {
    const originalFetchedAt = "2026-05-20T11:50:00.000Z";
    const inner = async (): Promise<FetchJsonResult> => ({
      rawSnapshot: {
        id: `raw-test-adapter-${originalFetchedAt}`,
        adapter: "test-adapter",
        fetchedAt: originalFetchedAt,
        payload: { v: 1 },
      },
      payload: { v: 1 },
    });

    const firstResult = await withCache(
      inner,
      makeOptions(tmpDir),
    )(request("https://example.test/time"));

    const hitResult = await withCache(
      inner,
      makeOptions(tmpDir),
    )(request("https://example.test/time"));

    if ("rawSnapshot" in firstResult && "rawSnapshot" in hitResult) {
      expect(hitResult.rawSnapshot.fetchedAt).toBe(firstResult.rawSnapshot.fetchedAt);
      expect(hitResult.rawSnapshot.cacheStatus).toBe("current");
    } else {
      throw new Error("Expected FetchJsonResult from both calls");
    }
  });

  test("invalid cache metadata falls through to a live fetch and emits an audit gap", async () => {
    const url = "https://example.test/api";
    const sha = await cacheKey(url, "test-adapter");
    mkdirSync(join(tmpDir, today), { recursive: true });
    writeFileSync(
      join(tmpDir, today, `${sha}.json`),
      JSON.stringify({
        cacheKey: "wrong",
        adapter: "test-adapter",
        fetchedAt,
        cachedDate: today,
        payload: { value: 42 },
      }),
    );

    let calls = 0;
    const opts = makeOptions(tmpDir);
    const result = await withCache(async () => {
      calls += 1;
      return makeFetchResult({ value: 1 }, "test-adapter");
    }, opts)(request(url));

    expect(calls).toBe(1);
    expect("rawSnapshot" in result).toBe(true);
    if ("rawSnapshot" in result) {
      expect(result.payload).toEqual({ value: 1 });
      expect(result.rawSnapshot.cacheStatus).toBeUndefined();
    }
    expect(opts.staleFallbackGaps).toHaveLength(1);
    expect(opts.staleFallbackGaps[0]?.message).toContain("metadata");
  });

  test("invalid cached payload shape returns a SourceGap", async () => {
    const cached = withCache(
      async () => makeFetchResult({ value: 42 }, "test-adapter"),
      makeOptions(tmpDir),
      {
        isPayload: (payload): payload is readonly unknown[] => Array.isArray(payload),
        invalidMessage: "cached JSON payload was not an object or array",
      },
    );

    await cached(request("https://example.test/api"));
    const result = await cached(request("https://example.test/api"));

    expect("source" in result).toBe(true);
    if ("source" in result) {
      expect(result.message).toContain("cached JSON payload");
    }
  });

  test("live fetch failure retains stale payload only in the raw audit snapshot", async () => {
    const stalePayload = { stale: true };

    const warmOpts = makeOptions(tmpDir, { now: makeNow(yesterday) });
    await withCache(
      async () => makeFetchResult(stalePayload, "test-adapter"),
      warmOpts,
    )(request("https://example.test/data?api_key=old&series_id=DGS10"));

    const gap = { source: "test-adapter", message: "timeout" };
    const inner = async () => gap;

    const opts = makeOptions(tmpDir);
    const result = await withCache(
      inner,
      opts,
    )(request("https://example.test/data?series_id=DGS10&api_key=new"));

    expect("rawSnapshot" in result).toBe(true);
    if ("rawSnapshot" in result) {
      expect(result.payload).toBeUndefined();
      expect(result.rawSnapshot.payload).toEqual(stalePayload);
      expect(result.rawSnapshot.cacheStatus).toBe("stale-fallback");
    }
    expect(opts.staleFallbackGaps).toHaveLength(1);
    expect(opts.staleFallbackGaps[0]?.message).toContain("cache-fallback");
    expect(opts.staleFallbackGaps[0]?.message).toContain("stalenessDays=1");
  });

  test("live fetch failure with no stale entry within fallbackDays returns original SourceGap", async () => {
    const gap = { source: "test-adapter", message: "timeout" };
    const inner = async () => gap;

    const opts = makeOptions(tmpDir);
    const result = await withCache(inner, opts)(request("https://example.test/missing"));

    expect("source" in result).toBe(true);
    if ("source" in result) {
      expect(result.source).toBe("test-adapter");
    }
    expect(opts.staleFallbackGaps).toHaveLength(0);
  });

  test("uses shorter stale fallback window for Yahoo market-data adapters", async () => {
    const stalePayload = { stale: true };
    const fourDaysAgo = "2026-05-16";
    const yahooUrl = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=ZZZZ";

    await withCache(
      async () => makeFetchResult(stalePayload, "yahoo-regime"),
      makeOptions(tmpDir, { now: makeNow(fourDaysAgo) }),
    )(request(yahooUrl, "yahoo-regime"));

    const gap = { source: "yahoo-regime", message: "timeout" };
    const opts = makeOptions(tmpDir);
    const result = await withCache(async () => gap, opts)(request(yahooUrl, "yahoo-regime"));

    expect("source" in result).toBe(true);
    if ("source" in result) {
      expect(result.source).toBe("yahoo-regime");
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

    await cached(request(url));
    await cached(request(url));

    expect(calls).toBe(2);
  });
});

describe("pruneCache", () => {
  test("removes raw cache days after 30 days and close files after 365 days", async () => {
    const oldRawDir = join(tmpDir, "2026-04-01");
    const freshRawDir = join(tmpDir, "2026-05-10");
    const oldCloseFile = join(tmpDir, "closes", "equity", "spy", "2025-01-01.json");
    const freshCloseFile = join(tmpDir, "closes", "equity", "spy", "2026-05-01.json");
    const oldWindowFile = join(
      tmpDir,
      "close-windows",
      "equity",
      "spy",
      "2024-12-20_2025-01-01.json",
    );
    const freshWindowFile = join(
      tmpDir,
      "close-windows",
      "equity",
      "spy",
      "2026-04-20_2026-05-01.json",
    );

    mkdirSync(oldRawDir, { recursive: true });
    mkdirSync(freshRawDir, { recursive: true });
    mkdirSync(join(tmpDir, "closes", "equity", "spy"), { recursive: true });
    mkdirSync(join(tmpDir, "close-windows", "equity", "spy"), { recursive: true });
    writeFileSync(join(oldRawDir, "old.json"), "{}");
    writeFileSync(join(freshRawDir, "fresh.json"), "{}");
    writeFileSync(oldCloseFile, "{}");
    writeFileSync(freshCloseFile, "{}");
    writeFileSync(oldWindowFile, "{}");
    writeFileSync(freshWindowFile, "{}");

    const result = await pruneCache({
      dir: tmpDir,
      now: new Date("2026-05-20T00:00:00.000Z"),
      rawRetentionDays: 30,
      closeRetentionDays: 365,
    });

    expect(result).toEqual({ rawDaysPruned: 1, closeFilesPruned: 2 });
    expect(existsSync(oldRawDir)).toBe(false);
    expect(existsSync(freshRawDir)).toBe(true);
    expect(existsSync(oldCloseFile)).toBe(false);
    expect(existsSync(freshCloseFile)).toBe(true);
    expect(existsSync(oldWindowFile)).toBe(false);
    expect(existsSync(freshWindowFile)).toBe(true);
  });
});

const cacheKey = makeCacheKeyForTest;
