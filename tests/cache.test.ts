import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  isAccessionDocumentRequest,
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
    mkdirSync(join(tmpDir, "accession"), { recursive: true });
    writeFileSync(join(tmpDir, "accession", "doc.json"), "{}");
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
    expect(existsSync(join(tmpDir, "accession", "doc.json"))).toBe(true);
  });
});

const filingUrl =
  "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/aapl-20260627.htm";

describe("accession-addressed SEC documents", () => {
  test("classifies archived filing documents by canonical URL shape", () => {
    const accepted = [
      filingUrl,
      "https://WWW.SEC.GOV/Archives/edgar/data/1171843/000117184326005241/ex99-1.htm",
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/0000320193-26-000010.txt",
    ];
    const rejected = [
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/0000320193-26-000010-index.html",
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/0000320193-26-000010-index.htm",
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/index.json",
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/%69ndex.json",
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/index%2Ejson",
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/index%2ejson",
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/doc%E0%A4%A.htm",
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/",
      "https://www.sec.gov/Archives/edgar/data/320193/00003201932600001/doc.htm",
      "https://www.sec.gov/Archives/edgar/data/aapl/000032019326000010/doc.htm",
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/doc.htm?x=1",
      "http://www.sec.gov/Archives/edgar/data/320193/000032019326000010/doc.htm",
      "https://www.sec.gov.evil.test/Archives/edgar/data/320193/000032019326000010/doc.htm",
      "https://sec.gov/Archives/edgar/data/320193/000032019326000010/doc.htm",
      "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
      "https://data.sec.gov/submissions/CIK0000320193.json",
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=320193",
      "not a url",
    ];

    expect(accepted.filter((url) => !isAccessionDocumentRequest(request(url)))).toEqual([]);
    expect(rejected.filter((url) => isAccessionDocumentRequest(request(url)))).toEqual([]);
    expect(
      isAccessionDocumentRequest(request(filingUrl, "sec-filing-text", { method: "POST" })),
    ).toBe(false);
  });

  test("hits across days without fetching and keeps the original snapshot metadata", async () => {
    let calls = 0;
    const fetchText = async () => {
      calls += 1;
      return makeFetchResult("<html>10-Q</html>", "sec-filing-text");
    };
    const write = withCache(fetchText, makeOptions(tmpDir));
    await write(request(filingUrl, "sec-filing-text"));

    const sha = await cacheKey(filingUrl, "sec-filing-text");
    expect(existsSync(join(tmpDir, "accession", `${sha}.json`))).toBe(true);
    expect(existsSync(join(tmpDir, today))).toBe(false);

    const result = await withCache(
      fetchText,
      makeOptions(tmpDir, { now: makeNow("2026-06-18") }),
    )(request(filingUrl, "sec-filing-text"));

    expect(calls).toBe(1);
    expect(result).toEqual({
      payload: "<html>10-Q</html>",
      rawSnapshot: {
        id: `raw-sec-filing-text-${fetchedAt}`,
        adapter: "sec-filing-text",
        fetchedAt,
        payload: "<html>10-Q</html>",
        cacheStatus: "current",
      },
    });
    const stored = await Bun.file(join(tmpDir, "accession", `${sha}.json`)).json();
    expect(stored.cachedDate).toBe(today);
  });

  test("refetches and overwrites once the revalidation budget expires", async () => {
    let calls = 0;
    const fetchText = async () => {
      calls += 1;
      return makeFetchResult(`v${calls}`, "sec-filing-text");
    };
    await withCache(fetchText, makeOptions(tmpDir))(request(filingUrl, "sec-filing-text"));

    const result = await withCache(
      fetchText,
      makeOptions(tmpDir, { now: makeNow("2026-06-20") }),
    )(request(filingUrl, "sec-filing-text"));

    expect(calls).toBe(2);
    expect("rawSnapshot" in result && result.payload).toBe("v2");
    const sha = await cacheKey(filingUrl, "sec-filing-text");
    const stored = await Bun.file(join(tmpDir, "accession", `${sha}.json`)).json();
    expect(stored).toMatchObject({ payload: "v2", cachedDate: "2026-06-20" });
  });

  test.each([
    ["corrupt JSON", "{not json", 0],
    ["null", "null", 0],
    ["wrong metadata", { cacheKey: "wrong", adapter: "sec-filing-text", cachedDate: today }, 1],
    ["bad cached date", { adapter: "sec-filing-text", cachedDate: "yesterday" }, 1],
    ["object cached date", { adapter: "sec-filing-text", cachedDate: { toString: null } }, 1],
    ["array cached date", { adapter: "sec-filing-text", cachedDate: [today] }, 1],
    ["invalid payload", { adapter: "sec-filing-text", cachedDate: today, payload: 42 }, 0],
  ] as const)("%s entry refetches and overwrites", async (_label, content, gaps) => {
    const sha = await cacheKey(filingUrl, "sec-filing-text");
    mkdirSync(join(tmpDir, "accession"), { recursive: true });
    writeFileSync(
      join(tmpDir, "accession", `${sha}.json`),
      typeof content === "string"
        ? content
        : JSON.stringify({ cacheKey: sha, fetchedAt, payload: "old", ...content }),
    );
    let calls = 0;
    const opts = makeOptions(tmpDir);
    const result = await withCache(
      async () => {
        calls += 1;
        return makeFetchResult("fresh", "sec-filing-text");
      },
      opts,
      {
        isPayload: (payload): payload is string => typeof payload === "string",
        invalidMessage: "cached text payload was not a string",
      },
    )(request(filingUrl, "sec-filing-text"));

    expect(calls).toBe(1);
    expect("rawSnapshot" in result && result.payload).toBe("fresh");
    expect(opts.staleFallbackGaps).toHaveLength(gaps);
    const stored = await Bun.file(join(tmpDir, "accession", `${sha}.json`)).json();
    expect(stored).toMatchObject({ payload: "fresh", cachedDate: today });
  });

  test.each([
    ["outside the fallback window", 7, 0],
    ["inside the fallback window", 40, 1],
  ] as const)(
    "failed refetch of an expired entry %s keeps stale-fallback semantics",
    async (_label, fallbackDays, gaps) => {
      await withCache(
        async () => makeFetchResult("old", "sec-filing-text"),
        makeOptions(tmpDir),
      )(request(filingUrl, "sec-filing-text"));
      const failure = { source: "sec-filing-text", message: "HTTP 503" } as const;
      const opts = makeOptions(tmpDir, { now: makeNow("2026-06-20"), fallbackDays });

      const result = await withCache(
        async () => failure as never,
        opts,
      )(request(filingUrl, "sec-filing-text"));

      expect(opts.staleFallbackGaps).toHaveLength(gaps);
      if (gaps === 0) {
        expect(result).toBe(failure);
      } else {
        expect(result).toMatchObject({
          payload: "",
          rawSnapshot: { payload: "old", cacheStatus: "stale-fallback" },
        });
        expect(opts.staleFallbackGaps[0]?.message).toContain("stalenessDays=31");
      }
    },
  );

  test("stale fallback skips a newer candidate whose payload is invalid", async () => {
    await withCache(
      async () => makeFetchResult("old", "sec-filing-text"),
      makeOptions(tmpDir),
    )(request(filingUrl, "sec-filing-text"));
    const sha = await cacheKey(filingUrl, "sec-filing-text");
    mkdirSync(join(tmpDir, "2026-06-20"), { recursive: true });
    writeFileSync(
      join(tmpDir, "2026-06-20", `${sha}.json`),
      JSON.stringify({
        cacheKey: sha,
        adapter: "sec-filing-text",
        fetchedAt,
        cachedDate: "2026-06-20",
        payload: null,
      }),
    );
    const opts = makeOptions(tmpDir, { now: makeNow("2026-06-20"), fallbackDays: 40 });

    const result = await withCache(
      async () => ({ source: "sec-filing-text", message: "HTTP 503" }) as never,
      opts,
      {
        isPayload: (payload): payload is string => typeof payload === "string",
        invalidMessage: "cached text payload was not a string",
      },
    )(request(filingUrl, "sec-filing-text"));

    expect(result).toMatchObject({
      payload: "",
      rawSnapshot: { payload: "old", cacheStatus: "stale-fallback" },
    });
    expect(opts.staleFallbackGaps.map((gap) => gap.message)).toEqual([
      "cache-fallback adapter=sec-filing-text stalenessDays=31",
    ]);
  });

  test("failed accession miss falls back to today's legacy day entry", async () => {
    const sha = await cacheKey(filingUrl, "sec-filing-text");
    mkdirSync(join(tmpDir, today), { recursive: true });
    writeFileSync(
      join(tmpDir, today, `${sha}.json`),
      JSON.stringify({
        cacheKey: sha,
        adapter: "sec-filing-text",
        fetchedAt,
        cachedDate: today,
        payload: "legacy",
      }),
    );
    const opts = makeOptions(tmpDir);

    const result = await withCache(
      async () => ({ source: "sec-filing-text", message: "HTTP 503" }) as never,
      opts,
    )(request(filingUrl, "sec-filing-text"));

    expect(result).toMatchObject({
      payload: "",
      rawSnapshot: { payload: "legacy", cacheStatus: "stale-fallback" },
    });
    expect(opts.staleFallbackGaps[0]?.message).toContain("stalenessDays=0");
  });

  test("respects a custom cache root and a disabled cache", async () => {
    const root = join(tmpDir, "custom");
    let calls = 0;
    const fetchText = async () => {
      calls += 1;
      return makeFetchResult("doc", "sec-filing-text");
    };
    const disabled = withCache(fetchText, makeOptions(root, { disabled: true }));
    await disabled(request(filingUrl, "sec-filing-text"));
    await disabled(request(filingUrl, "sec-filing-text"));
    expect(existsSync(root)).toBe(false);

    await withCache(fetchText, makeOptions(root))(request(filingUrl, "sec-filing-text"));
    const sha = await cacheKey(filingUrl, "sec-filing-text");
    expect(existsSync(join(root, "accession", `${sha}.json`))).toBe(true);
    expect(calls).toBe(3);
  });

  test("generated filing indexes stay day-scoped", async () => {
    const indexUrl =
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/0000320193-26-000010-index.html";
    await withCache(
      async () => makeFetchResult("<table/>", "sec-filing-index"),
      makeOptions(tmpDir),
    )(request(indexUrl, "sec-filing-index"));

    const sha = await cacheKey(indexUrl, "sec-filing-index");
    expect(existsSync(join(tmpDir, today, `${sha}.json`))).toBe(true);
    expect(existsSync(join(tmpDir, "accession"))).toBe(false);
  });
});

const cacheKey = makeCacheKeyForTest;
