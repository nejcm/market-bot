import { describe, expect, test } from "bun:test";
import { parseYahooChartOhlcv } from "../src/sources/yahoo";
import { collectVerifiedMarketSnapshot } from "../src/sources/verified-market-snapshot";
import { deriveCanonicalInstrumentIdentity } from "../src/sources/instrument-identity";
import { deterministicSourceGaps } from "../src/research/research-context";
import { buildSourceList } from "../src/research/report-assembly";
import type { CollectedSources } from "../src/sources/types";
import type { InstrumentIdentity, VerifiedMarketSnapshot } from "../src/domain/types";
import { createCollectContext, resetSourceResilienceForTests } from "../src/sources/collector";
import { collectedSources, marketSnapshot } from "./support/fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function yahooChartPayload(
  timestamps: number[],
  quote: {
    open?: (number | null)[];
    high?: (number | null)[];
    low?: (number | null)[];
    close?: (number | null)[];
    volume?: (number | null)[];
  },
): unknown {
  return {
    chart: {
      result: [
        {
          timestamp: timestamps,
          indicators: {
            quote: [
              {
                open: quote.open ?? timestamps.map(() => 10),
                high: quote.high ?? timestamps.map(() => 11),
                low: quote.low ?? timestamps.map(() => 9),
                close: quote.close ?? timestamps.map((_, i) => 100 + i),
                volume: quote.volume ?? timestamps.map(() => 1_000_000),
              },
            ],
          },
        },
      ],
    },
  };
}

// Unix timestamps for simple dates (2024-01-01..N)
function ts(dayOffset: number): number {
  return Math.floor(new Date(`2024-01-${String(dayOffset + 1).padStart(2, "0")}`).getTime() / 1000);
}

function tsRange(count: number): number[] {
  return Array.from({ length: count }, (_, i) => ts(i));
}

function jsonResponse(payload: unknown): Response {
  return Response.json(payload);
}

// ---------------------------------------------------------------------------
// ParseYahooChartOhlcv
// ---------------------------------------------------------------------------

describe("parseYahooChartOhlcv", () => {
  test("returns empty array for non-object payload", () => {
    expect(parseYahooChartOhlcv(null)).toEqual([]);
    expect(parseYahooChartOhlcv("string")).toEqual([]);
    expect(parseYahooChartOhlcv(42)).toEqual([]);
  });

  test("returns empty array when chart result is missing", () => {
    expect(parseYahooChartOhlcv({ chart: {} })).toEqual([]);
    expect(parseYahooChartOhlcv({ chart: { result: [] } })).toEqual([]);
  });

  test("parses valid bars", () => {
    const timestamps = tsRange(3);
    const payload = yahooChartPayload(timestamps, {
      open: [100, 101, 102],
      high: [105, 106, 107],
      low: [98, 99, 100],
      close: [103, 104, 105],
      volume: [1_000_000, 1_200_000, 900_000],
    });
    const bars = parseYahooChartOhlcv(payload);
    expect(bars).toHaveLength(3);
    expect(bars[0]).toMatchObject({ open: 100, high: 105, low: 98, close: 103, volume: 1_000_000 });
    expect(bars[2]).toMatchObject({ close: 105 });
  });

  test("skips bars with any null OHLCV slot (interior null policy)", () => {
    const timestamps = tsRange(4);
    const payload = yahooChartPayload(timestamps, {
      open: [100, null, 102, 103],
      high: [105, 106, null, 107],
      low: [98, 99, 100, 101],
      close: [103, 104, 105, 106],
      volume: [1_000_000, 1_200_000, 900_000, 800_000],
    });
    const bars = parseYahooChartOhlcv(payload);
    // Bar 1 (null open) and bar 2 (null high) should be skipped
    expect(bars).toHaveLength(2);
    expect(bars[0]?.close).toBe(103);
    expect(bars[1]?.close).toBe(106);
  });

  test("skips bars with null close", () => {
    const timestamps = tsRange(3);
    const payload = yahooChartPayload(timestamps, {
      close: [100, null, 102],
    });
    const bars = parseYahooChartOhlcv(payload);
    expect(bars).toHaveLength(2);
    expect(bars[0]?.close).toBe(100);
    expect(bars[1]?.close).toBe(102);
  });

  test("filters bars beyond analysisDate", () => {
    const timestamps = [
      Math.floor(new Date("2024-06-01").getTime() / 1000),
      Math.floor(new Date("2024-06-15").getTime() / 1000),
      Math.floor(new Date("2024-07-01").getTime() / 1000),
    ];
    const payload = yahooChartPayload(timestamps, {
      close: [100, 200, 300],
    });
    const bars = parseYahooChartOhlcv(payload, "2024-06-15");
    expect(bars).toHaveLength(2);
    expect(bars.at(-1)?.date).toBe("2024-06-15");
  });

  test("returns all bars when analysisDate is undefined", () => {
    const timestamps = tsRange(5);
    const payload = yahooChartPayload(timestamps, {});
    expect(parseYahooChartOhlcv(payload)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// CollectVerifiedMarketSnapshot
// ---------------------------------------------------------------------------

describe("collectVerifiedMarketSnapshot", () => {
  const analysisDate = "2024-06-15";

  function makeCtx(fetchImpl: (url: string) => Promise<Response>) {
    resetSourceResilienceForTests();
    const { context } = createCollectContext(
      { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      { equityMoverLimit: 5, cryptoMoverLimit: 5, newsLimit: 5, sourceTimeoutMs: 5000 },
      new Date(analysisDate),
      async (input: string | URL | Request) => fetchImpl(String(input)),
      [],
    );
    return context;
  }

  function chartPayloadWith80Bars(): unknown {
    const timestamps = Array.from({ length: 80 }, (_, i) => {
      const d = new Date("2024-01-01");
      d.setDate(d.getDate() + i);
      return Math.floor(d.getTime() / 1000);
    });
    return yahooChartPayload(timestamps, {});
  }

  test("returns snapshot when Yahoo returns >= 60 valid bars", async () => {
    const ctx = makeCtx(async () => jsonResponse(chartPayloadWith80Bars()));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", analysisDate);
    expect(result.snapshot).toBeDefined();
    expect(result.sourceGaps).toHaveLength(0);
    expect(result.snapshot?.symbol).toBe("AAPL");
    expect(result.snapshot?.assetClass).toBe("equity");
  });

  test("returns SourceGap when fetch fails — no Massive fallback attempted", async () => {
    const ctx = makeCtx(async () => {
      throw new Error("network error");
    });
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", analysisDate);
    expect(result.snapshot).toBeUndefined();
    expect(result.sourceGaps).toHaveLength(1);
    const gap = result.sourceGaps[0]!;
    expect(gap.source).toBe("yahoo-verified-chart");
    expect(gap.capability).toBe("market-data");
    expect(gap.evidenceQualityImpact).toBe("core-cap");
  });

  test("returns SourceGap when bars < 60 (insufficient data)", async () => {
    const ctx = makeCtx(async () => {
      const timestamps = tsRange(30);
      return jsonResponse(yahooChartPayload(timestamps, {}));
    });
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", analysisDate);
    expect(result.snapshot).toBeUndefined();
    expect(result.sourceGaps[0]?.cause).toBe("validation-failed");
    expect(result.sourceGaps[0]?.evidenceQualityImpact).toBe("core-cap");
  });

  test("snapshot includes indicators, ohlcv, and recentCloses", async () => {
    const ctx = makeCtx(async () => jsonResponse(chartPayloadWith80Bars()));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", analysisDate);
    expect(result.snapshot?.ohlcv).toBeDefined();
    expect(result.snapshot?.indicators).toBeDefined();
    expect(result.snapshot?.recentCloses).toBeDefined();
    expect(Array.isArray(result.snapshot?.recentCloses)).toBe(true);
  });

  test("snapshot analysisDate equals the provided date", async () => {
    const ctx = makeCtx(async () => jsonResponse(chartPayloadWith80Bars()));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", analysisDate);
    expect(result.snapshot?.analysisDate).toBe(analysisDate);
  });
});

// ---------------------------------------------------------------------------
// DeriveCanonicalInstrumentIdentity
// ---------------------------------------------------------------------------

describe("deriveCanonicalInstrumentIdentity", () => {
  const identity: InstrumentIdentity = {
    exchange: "NASDAQ",
    quoteCurrency: "USD",
    displayName: "Apple Inc.",
    aliases: [{ provider: "yahoo", idKind: "symbol", value: "AAPL" }],
  };

  test("returns identity from existing ticker MarketSnapshot — no extra fetch", () => {
    const snapshots = [marketSnapshot({ symbol: "AAPL", identity })];
    const result = deriveCanonicalInstrumentIdentity(snapshots, "AAPL");
    expect(result.identity).toEqual(identity);
  });

  test("returns empty result when no matching snapshot", () => {
    const result = deriveCanonicalInstrumentIdentity([], "AAPL");
    expect(result.identity).toBeUndefined();
  });

  test("returns empty result when snapshot has no identity", () => {
    const snapshots = [marketSnapshot({ symbol: "AAPL" })];
    const result = deriveCanonicalInstrumentIdentity(snapshots, "AAPL");
    expect(result.identity).toBeUndefined();
  });

  test("matches by exact symbol", () => {
    const snapshots = [
      marketSnapshot({ symbol: "MSFT", identity: { displayName: "Microsoft" } }),
      marketSnapshot({ symbol: "AAPL", identity }),
    ];
    const result = deriveCanonicalInstrumentIdentity(snapshots, "AAPL");
    expect(result.identity?.displayName).toBe("Apple Inc.");
  });
});

// ---------------------------------------------------------------------------
// DeterministicSourceGaps: verified snapshot gap
// ---------------------------------------------------------------------------

describe("deterministicSourceGaps — verified snapshot gap", () => {
  test("adds missing-snapshot gap for equity ticker run when snapshot absent", () => {
    const gaps = deterministicSourceGaps(
      { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
        newsSources: [{ id: "n1", title: "news", fetchedAt: "2026-01-01", kind: "news" }],
      }),
    );
    expect(gaps.some((g) => g.includes("Verified Market Snapshot") && g.includes("AAPL"))).toBe(
      true,
    );
  });

  test("no missing-snapshot gap when snapshot is present", () => {
    const snapshot: VerifiedMarketSnapshot = {
      symbol: "AAPL",
      assetClass: "equity",
      analysisDate: "2026-01-01",
      latestSessionDate: "2025-12-31",
      ohlcv: { date: "2025-12-31", open: 100, high: 105, low: 99, close: 103, volume: 1_000_000 },
      indicators: {},
      recentCloses: [],
    };
    const gaps = deterministicSourceGaps(
      { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
        newsSources: [{ id: "n1", title: "news", fetchedAt: "2026-01-01", kind: "news" }],
        verifiedMarketSnapshot: snapshot,
      }),
    );
    expect(gaps.some((g) => g.includes("Verified Market Snapshot"))).toBe(false);
  });

  test("no missing-snapshot gap for daily equity runs", () => {
    const gaps = deterministicSourceGaps(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
        newsSources: [{ id: "n1", title: "news", fetchedAt: "2026-01-01", kind: "news" }],
      }),
    );
    expect(gaps.some((g) => g.includes("Verified Market Snapshot"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BuildSourceList: verified snapshot source
// ---------------------------------------------------------------------------

describe("buildSourceList — verified snapshot source", () => {
  const snapshot: VerifiedMarketSnapshot = {
    symbol: "AAPL",
    assetClass: "equity",
    analysisDate: "2026-01-01",
    latestSessionDate: "2025-12-31",
    ohlcv: { date: "2025-12-31", open: 100, high: 105, low: 99, close: 103, volume: 1_000_000 },
    indicators: {},
    recentCloses: [],
  };

  const sources: CollectedSources = collectedSources({
    marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
    verifiedMarketSnapshot: snapshot,
  });

  test("includes verified-snapshot source for ticker run with snapshot", () => {
    const list = buildSourceList(
      { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      sources,
    );
    const snapshotSource = list.find((s) => s.id === "verified-snapshot-AAPL");
    expect(snapshotSource).toBeDefined();
    expect(snapshotSource?.kind).toBe("market-data");
    expect(snapshotSource?.symbol).toBe("AAPL");
    expect(snapshotSource?.provider).toBe("yahoo");
  });

  test("does not include verified-snapshot source for daily run", () => {
    const list = buildSourceList(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      sources,
    );
    expect(list.find((s) => s.id.startsWith("verified-snapshot-"))).toBeUndefined();
  });

  test("snapshot source ID passes allowedSourceIds validation", () => {
    const list = buildSourceList(
      { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      sources,
    );
    const allowed = new Set(list.map((s) => s.id));
    expect(allowed.has("verified-snapshot-AAPL")).toBe(true);
  });
});
