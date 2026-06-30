import { describe, expect, test } from "bun:test";
import { parseYahooChartOhlcv } from "../src/sources/yahoo";
import { collectVerifiedMarketSnapshot } from "../src/sources/verified-market-snapshot";
import {
  INDICATOR_KEYS,
  verifiedSnapshotCitationRule,
  verifiedSnapshotSourceId,
} from "../src/research/verified-snapshot-contract";
import { deriveCanonicalInstrumentIdentity } from "../src/sources/instrument-identity";
import {
  buildDepthProfile,
  buildStagePrompt,
  deterministicSourceGaps,
} from "../src/research/research-context";
import { buildSourceList, readPredictions } from "../src/research/report-assembly";
import type { AppConfig } from "../src/config";
import type { ResearchCommand } from "../src/cli/args";
import type { CollectedSources } from "../src/sources/types";
import type { IndicatorMap, InstrumentIdentity, VerifiedMarketSnapshot } from "../src/domain/types";
import {
  collectSources,
  createCollectContext,
  resetSourceResilienceForTests,
  setSourceHostMinDelayMsForTests,
} from "../src/sources/collector";
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

const NULL_INDICATORS: Record<keyof IndicatorMap, null> = {
  ema10: null,
  sma50: null,
  sma200: null,
  rsi14: null,
  macd: null,
  macdSignal: null,
  macdHistogram: null,
  bollUpper: null,
  bollMiddle: null,
  bollLower: null,
  atr14: null,
};

function verifiedSnapshotFixture(): VerifiedMarketSnapshot {
  return {
    symbol: "AAPL",
    assetClass: "equity",
    analysisDate: "2026-01-01",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    latestSessionDate: "2025-12-31",
    ohlcv: { date: "2025-12-31", open: 100, high: 105, low: 99, close: 103, volume: 1_000_000 },
    indicators: NULL_INDICATORS,
    recentCloses: [],
  };
}

// ---------------------------------------------------------------------------
// Contract — locked indicator key schema (ADR 0019)
// ---------------------------------------------------------------------------

describe("verified-snapshot contract", () => {
  test("INDICATOR_KEYS covers every IndicatorMap key", () => {
    // `satisfies` proves the keys are valid; this proves the enumeration is complete
    const keys: string[] = [...INDICATOR_KEYS];
    expect(keys.toSorted()).toEqual(Object.keys(NULL_INDICATORS).toSorted());
  });

  test("citation rule pins the locked source-ID and no-fabrication clauses", () => {
    const rule = verifiedSnapshotCitationRule("AAPL");
    expect(rule).toContain(`MUST cite source ID "${verifiedSnapshotSourceId("AAPL")}"`);
    expect(rule).toContain(
      "Do not state indicator values that are not present in verifiedMarketSnapshot",
    );
    expect(rule).toContain("Never mix bar-close indicators with live quote price");
  });
});

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
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
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

  test("empty symbol skips without fetching and without a gap", async () => {
    let fetchCount = 0;
    const ctx = makeCtx(async () => {
      fetchCount += 1;
      return jsonResponse(chartPayloadWith80Bars());
    });
    const result = await collectVerifiedMarketSnapshot(ctx, "", analysisDate);
    expect(result.snapshot).toBeUndefined();
    expect(result.sourceGaps).toHaveLength(0);
    expect(fetchCount).toBe(0);
  });

  test("snapshot carries ISO fetchedAt from the collect context on a fresh fetch", async () => {
    const ctx = makeCtx(async () => jsonResponse(chartPayloadWith80Bars()));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", analysisDate);
    expect(result.snapshot?.fetchedAt).toBe(ctx.fetchedAt);
  });

  test("snapshot preserves the raw snapshot fetchedAt when served from cache", async () => {
    const cachedFetchedAt = "2024-06-14T08:00:00.000Z";
    const base = makeCtx(async () => jsonResponse(chartPayloadWith80Bars()));
    const ctx = {
      ...base,
      request: {
        ...base.request,
        json: async () => ({
          rawSnapshot: {
            id: `raw-yahoo-verified-chart-${cachedFetchedAt}`,
            adapter: "yahoo-verified-chart",
            fetchedAt: cachedFetchedAt,
            payload: chartPayloadWith80Bars(),
          },
          payload: chartPayloadWith80Bars(),
        }),
      },
    };
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", analysisDate);
    expect(result.snapshot?.fetchedAt).toBe(cachedFetchedAt);
    expect(result.snapshot?.fetchedAt).not.toBe(base.fetchedAt);
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

  test("emits a no-cap gap when no matching snapshot", () => {
    const result = deriveCanonicalInstrumentIdentity([], "AAPL");
    expect(result.identity).toBeUndefined();
    expect(result.gap).toMatchObject({
      source: "instrument-identity",
      capability: "market-data",
      cause: "provider-data-missing",
      evidenceQualityImpact: "no-cap",
    });
  });

  test("emits a no-cap gap when snapshot has no identity", () => {
    const snapshots = [marketSnapshot({ symbol: "AAPL" })];
    const result = deriveCanonicalInstrumentIdentity(snapshots, "AAPL");
    expect(result.identity).toBeUndefined();
    expect(result.gap?.message).toContain("AAPL");
  });

  test("no gap when identity is derived", () => {
    const snapshots = [marketSnapshot({ symbol: "AAPL", identity })];
    const result = deriveCanonicalInstrumentIdentity(snapshots, "AAPL");
    expect(result.gap).toBeUndefined();
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
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
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
    const snapshot = verifiedSnapshotFixture();
    const gaps = deterministicSourceGaps(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
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
      {
        jobType: "market-overview",
        assetClass: "equity",
        depth: "brief",
        horizonTradingDays: 5,
        legacyAlias: "daily",
      },
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
  const snapshot = verifiedSnapshotFixture();

  const sources: CollectedSources = collectedSources({
    marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
    verifiedMarketSnapshot: snapshot,
  });

  test("includes verified-snapshot source for ticker run with snapshot", () => {
    const list = buildSourceList(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
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
      {
        jobType: "market-overview",
        assetClass: "equity",
        depth: "brief",
        horizonTradingDays: 5,
        legacyAlias: "daily",
      },
      sources,
    );
    expect(list.find((s) => s.id.startsWith("verified-snapshot-"))).toBeUndefined();
  });

  test("snapshot source ID matches the shared helper and carries ISO fetchedAt", () => {
    const list = buildSourceList(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      sources,
    );
    const snapshotSource = list.find((s) => s.id === verifiedSnapshotSourceId("AAPL"));
    expect(snapshotSource).toBeDefined();
    expect(snapshotSource?.fetchedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Prediction validation against allowedSourceIds (final-synthesis seam)
// ---------------------------------------------------------------------------

function rawPrediction(sourceIds: readonly string[]): unknown {
  return {
    id: "pred-1",
    claim: "AAPL closes higher over 5 trading days",
    kind: "direction",
    subject: "AAPL",
    measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
    horizonTradingDays: 5,
    probability: 0.6,
    sourceIds,
  };
}

describe("readPredictions — verified snapshot citations", () => {
  const knownIds = new Set([verifiedSnapshotSourceId("AAPL"), "market-aapl"]);

  test("prediction citing the snapshot source ID passes validation", () => {
    const result = readPredictions([rawPrediction([verifiedSnapshotSourceId("AAPL")])], knownIds);
    expect(result.predictions).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  test("prediction citing an unknown snapshot ID fails validation", () => {
    const result = readPredictions([rawPrediction(["verified-snapshot-UNKNOWN"])], knownIds);
    expect(result.predictions).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Evidence payload injection (via buildStagePrompt)
// ---------------------------------------------------------------------------

describe("buildStagePrompt — verified snapshot + identity injection", () => {
  const config: AppConfig = {
    provider: "openai",
    quickModel: "quick-test",
    synthesisModel: "synthesis-test",
    modelTimeoutMs: 120_000,
    dataDir: "data/runs",
    promptDir: "prompts",
    sourceOptions: {
      equityMoverLimit: 2,
      cryptoMoverLimit: 2,
      newsLimit: 2,
      sourceTimeoutMs: 1000,
    },
    evidenceRequestOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
    webGatherOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
    webGatherDisabled: false,
    webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
    alphaSearchOptions: {
      apeWisdomFilter: "all-stocks",
      apeWisdomBriefPageLimit: 5,
      apeWisdomDeepPageLimit: 10,
      validationCandidateLimit: 25,
      leadLimit: 15,
      topCandidateLimit: 15,
      secDiscoveryLimit: 25,
      secFormTypes: ["S-1", "F-1", "8-K", "6-K"],
      minPrice: 0.5,
      minVolume: 100_000,
      minMarketCap: 50_000_000,
      maxMarketCap: 10_000_000_000,
    },
  };

  const command: ResearchCommand = {
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    depth: "brief",
  };

  const identity: InstrumentIdentity = { displayName: "Apple Inc.", exchange: "NASDAQ" };

  function buildPrompt(sources: CollectedSources): string {
    return buildStagePrompt(
      "specialist-analysis",
      command,
      sources,
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["AAPL"],
          focus: ["instrument"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "insufficient-data",
          proxyCount: 0,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext: undefined,
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
  }

  test("snapshot, source ID, citation rule, and identity appear in the evidence payload", () => {
    const prompt = buildPrompt(
      collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
        verifiedMarketSnapshot: verifiedSnapshotFixture(),
        resolvedInstrumentIdentity: identity,
      }),
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: {
        readonly verifiedMarketSnapshot?: { readonly symbol?: string };
        readonly verifiedMarketSnapshotSourceId?: string;
        readonly verifiedMarketSnapshotCitationRule?: string;
        readonly resolvedInstrumentIdentity?: { readonly displayName?: string };
        readonly resolvedIdentityInstruction?: string;
      };
    };

    expect(parsed.evidence?.verifiedMarketSnapshot?.symbol).toBe("AAPL");
    expect(parsed.evidence?.verifiedMarketSnapshotSourceId).toBe(verifiedSnapshotSourceId("AAPL"));
    expect(parsed.evidence?.verifiedMarketSnapshotCitationRule).toBe(
      verifiedSnapshotCitationRule("AAPL"),
    );
    expect(parsed.evidence?.resolvedInstrumentIdentity?.displayName).toBe("Apple Inc.");
    expect(parsed.evidence?.resolvedIdentityInstruction).toContain(
      "do not substitute a different company",
    );
  });

  test("snapshot and identity blocks absent when not collected; gap line present instead", () => {
    const prompt = buildPrompt(
      collectedSources({ marketSnapshots: [marketSnapshot({ symbol: "AAPL" })] }),
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: {
        readonly verifiedMarketSnapshot?: unknown;
        readonly resolvedInstrumentIdentity?: unknown;
        readonly sourceGaps?: readonly string[];
      };
    };

    expect(parsed.evidence?.verifiedMarketSnapshot).toBeUndefined();
    expect(parsed.evidence?.resolvedInstrumentIdentity).toBeUndefined();
    expect(parsed.evidence?.sourceGaps?.some((g) => g.includes("Verified Market Snapshot"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// CollectSources wiring (equity ticker gate)
// ---------------------------------------------------------------------------

function wiringChartPayload(): unknown {
  const timestamps = Array.from({ length: 80 }, (_, i) => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    d.setUTCDate(d.getUTCDate() + i);
    return Math.floor(d.getTime() / 1000);
  });
  return yahooChartPayload(timestamps, {});
}

function wiringQuotePayload(): unknown {
  return {
    quoteResponse: {
      result: [
        {
          symbol: "AAPL",
          regularMarketPrice: 190,
          regularMarketChangePercent: 2,
          regularMarketVolume: 80_000_000,
          fullExchangeName: "NasdaqGS",
          currency: "USD",
          shortName: "Apple Inc.",
        },
      ],
    },
  };
}

function tickerFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url.includes("/v8/finance/chart/")) {
    return Promise.resolve(jsonResponse(wiringChartPayload()));
  }
  if (url.includes("quote")) {
    return Promise.resolve(jsonResponse(wiringQuotePayload()));
  }
  return Promise.resolve(jsonResponse({}));
}

describe("collectSources — verified snapshot wiring", () => {
  const sourceOptions = {
    equityMoverLimit: 5,
    cryptoMoverLimit: 5,
    newsLimit: 5,
    sourceTimeoutMs: 5000,
  };

  test("equity ticker run collects snapshot, identity, and raw chart payload", async () => {
    resetSourceResilienceForTests();
    setSourceHostMinDelayMsForTests(0);
    const result = await collectSources(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      sourceOptions,
      new Date("2026-05-20T00:00:00.000Z"),
      tickerFetch,
      [],
    );

    expect(result.verifiedMarketSnapshot?.symbol).toBe("AAPL");
    expect(result.resolvedInstrumentIdentity?.displayName).toBe("Apple Inc.");
    expect(
      result.rawSnapshots.some((snapshot) => snapshot.adapter === "yahoo-verified-chart"),
    ).toBe(true);
  });

  test("daily equity run skips snapshot and identity entirely", async () => {
    resetSourceResilienceForTests();
    setSourceHostMinDelayMsForTests(0);
    const result = await collectSources(
      {
        jobType: "market-overview",
        assetClass: "equity",
        depth: "brief",
        horizonTradingDays: 5,
        legacyAlias: "daily",
      },
      sourceOptions,
      new Date("2026-05-20T00:00:00.000Z"),
      tickerFetch,
      [],
    );

    expect(result.verifiedMarketSnapshot).toBeUndefined();
    expect(result.resolvedInstrumentIdentity).toBeUndefined();
    expect(
      result.rawSnapshots.some((snapshot) => snapshot.adapter === "yahoo-verified-chart"),
    ).toBe(false);
  });

  test("ticker run with failing chart fetch merges the core-cap gap into sourceGaps", async () => {
    resetSourceResilienceForTests();
    setSourceHostMinDelayMsForTests(0);
    const result = await collectSources(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      sourceOptions,
      new Date("2026-05-20T00:00:00.000Z"),
      (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/v8/finance/chart/")) {
          return Promise.reject(new Error("chart unavailable"));
        }
        return tickerFetch(input);
      },
      [],
    );

    expect(result.verifiedMarketSnapshot).toBeUndefined();
    expect(
      result.sourceGaps.some(
        (gap) => gap.source === "yahoo-verified-chart" && gap.evidenceQualityImpact === "core-cap",
      ),
    ).toBe(true);
  });
});
