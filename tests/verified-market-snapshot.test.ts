import { describe, expect, test } from "bun:test";
import { legacyMarketOverviewCommand } from "./support/commands";
import { parseYahooChartOhlcv, readYahooRegularSession } from "../src/sources/yahoo";
import { computeIndicators, MIN_BARS_FOR_SNAPSHOT } from "../src/sources/indicators";
import { collectVerifiedMarketSnapshot } from "../src/sources/verified-market-snapshot";
import {
  INDICATOR_KEYS,
  verifiedSnapshotCitationRule,
  verifiedSnapshotSourceId,
} from "../src/research/verified-snapshot-contract";
import { deriveCanonicalInstrumentIdentity } from "../src/sources/instrument-identity";
import { buildStagePrompt } from "../src/research/prompts";
import { buildDepthProfile } from "../src/research/depth-profile";
import { deterministicSourceGaps } from "../src/research/deterministic-gaps";
import { buildSourceList, readPredictions } from "../src/research/report-assembly";
import type { AppConfig } from "../src/config";
import type { ResearchCommand } from "../src/cli/args";
import type { CollectedSources } from "../src/sources/types";
import type { IndicatorMap, InstrumentIdentity, VerifiedMarketSnapshot } from "../src/domain/types";
import { collectSources } from "../src/sources/collector";
import {
  createCollectContext,
  resetSourceResilienceForTests,
  setSourceHostMinDelayMsForTests,
} from "../src/sources/source-request";
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
  meta?: unknown,
): unknown {
  return {
    chart: {
      result: [
        {
          timestamp: timestamps,
          ...(meta === undefined ? {} : { meta }),
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

function sessionEpoch(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function tsRange(count: number): number[] {
  return Array.from({ length: count }, (_, i) => ts(i));
}

function jsonResponse(payload: unknown): Response {
  return Response.json(payload);
}

function makeCtxAt(now: string, fetchImpl: (url: string) => Promise<Response>) {
  resetSourceResilienceForTests();
  const { context } = createCollectContext(
    { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
    { equityMoverLimit: 5, cryptoMoverLimit: 5, newsLimit: 5, sourceTimeoutMs: 5000 },
    new Date(now),
    async (input: string | URL | Request) => fetchImpl(String(input)),
    [],
  );
  return context;
}

// Daily bars ending on 2024-03-20, optionally carrying trading-period metadata.
function sessionChartPayload(regular?: unknown, barCount = 80): unknown {
  const timestamps = Array.from({ length: barCount }, (_, i) => {
    const d = new Date("2024-03-20");
    d.setDate(d.getDate() - (barCount - 1 - i));
    return Math.floor(d.getTime() / 1000);
  });
  return yahooChartPayload(
    timestamps,
    { close: timestamps.map((_, index) => 100 + index) },
    regular === undefined ? undefined : { currentTradingPeriod: { regular } },
  );
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
// Contract — locked indicator key schema (ADR 0004)
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
  test("returns empty bars and dropped bars for non-object payload", () => {
    expect(parseYahooChartOhlcv(null)).toEqual({ bars: [], droppedBars: [] });
    expect(parseYahooChartOhlcv("string")).toEqual({ bars: [], droppedBars: [] });
    expect(parseYahooChartOhlcv(42)).toEqual({ bars: [], droppedBars: [] });
  });

  test("returns empty bars and dropped bars when chart result is missing", () => {
    expect(parseYahooChartOhlcv({ chart: {} })).toEqual({ bars: [], droppedBars: [] });
    expect(parseYahooChartOhlcv({ chart: { result: [] } })).toEqual({
      bars: [],
      droppedBars: [],
    });
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
    const { bars, droppedBars } = parseYahooChartOhlcv(payload);
    expect(bars).toHaveLength(3);
    expect(bars[0]).toMatchObject({ open: 100, high: 105, low: 98, close: 103, volume: 1_000_000 });
    expect(bars[2]).toMatchObject({ close: 105 });
    expect(droppedBars).toEqual([]);
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
    const { bars, droppedBars } = parseYahooChartOhlcv(payload);
    // Bar 1 (null open) and bar 2 (null high) should be skipped
    expect(bars).toHaveLength(2);
    expect(bars[0]?.close).toBe(103);
    expect(bars[1]?.close).toBe(106);
    expect(droppedBars).toEqual([
      { date: "2024-01-02", missingFields: ["open"] },
      { date: "2024-01-03", missingFields: ["high"] },
    ]);
  });

  test("skips bars with null close", () => {
    const timestamps = tsRange(3);
    const payload = yahooChartPayload(timestamps, {
      close: [100, null, 102],
    });
    const { bars, droppedBars } = parseYahooChartOhlcv(payload);
    expect(bars).toHaveLength(2);
    expect(bars[0]?.close).toBe(100);
    expect(bars[1]?.close).toBe(102);
    expect(droppedBars).toEqual([{ date: "2024-01-02", missingFields: ["close"] }]);
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
    const { bars, droppedBars } = parseYahooChartOhlcv(payload, "2024-06-15");
    expect(bars).toHaveLength(2);
    expect(bars.at(-1)?.date).toBe("2024-06-15");
    expect(droppedBars).toEqual([]);
  });

  test("returns all bars when analysisDate is undefined", () => {
    const timestamps = tsRange(5);
    const payload = yahooChartPayload(timestamps, {});
    const { bars, droppedBars } = parseYahooChartOhlcv(payload);
    expect(bars).toHaveLength(5);
    expect(droppedBars).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ReadYahooRegularSessionWindow — the only exchange-schedule metadata in a chart payload
// ---------------------------------------------------------------------------

/*
 * An absurd bar timestamp reaches the shared date conversion, which the session-window range check
 * never guards: `new Date(1e300 * 1000)` is Invalid Date and its toISOString() throws RangeError.
 * Parsing must drop the bar instead of exploding the whole collector.
 */
describe("parseYahooChartOhlcv date conversion", () => {
  test("drops a bar whose timestamp cannot convert to a calendar date", () => {
    const payload = yahooChartPayload([ts(0), 1e300, ts(1)], {
      open: [1, 2, 3],
      high: [1, 2, 3],
      low: [1, 2, 3],
      close: [1, 2, 3],
      volume: [1, 2, 3],
    });
    expect(() => parseYahooChartOhlcv(payload)).not.toThrow();
    expect(parseYahooChartOhlcv(payload).bars.map((bar) => bar.date)).toEqual([
      "2024-01-01",
      "2024-01-02",
    ]);
  });

  test("drops a bar with a non-finite timestamp", () => {
    const payload = yahooChartPayload([Number.NaN, ts(0)], {
      open: [1, 2],
      high: [1, 2],
      low: [1, 2],
      close: [1, 2],
      volume: [1, 2],
    });
    expect(parseYahooChartOhlcv(payload).bars.map((bar) => bar.date)).toEqual(["2024-01-01"]);
  });
});

describe("readYahooRegularSession", () => {
  function periodPayload(regular: unknown): unknown {
    return yahooChartPayload(tsRange(2), {}, { currentTradingPeriod: { regular } });
  }

  test("reads the current regular trading period", () => {
    expect(
      readYahooRegularSession(
        periodPayload({
          start: sessionEpoch("2024-03-20T13:30:00Z"),
          end: sessionEpoch("2024-03-20T20:00:00Z"),
        }),
      ),
    ).toEqual({
      status: "ok",
      window: {
        startDate: "2024-03-20",
        endSeconds: sessionEpoch("2024-03-20T20:00:00Z"),
        endsAt: "2024-03-20T20:00:00.000Z",
      },
    });
  });

  test("reports absent only when the schedule properties are genuinely missing", () => {
    expect(readYahooRegularSession(yahooChartPayload(tsRange(2), {}))).toEqual({
      status: "absent",
    });
    expect(
      readYahooRegularSession(yahooChartPayload(tsRange(2), {}, { currentTradingPeriod: {} })),
    ).toEqual({ status: "absent" });
    expect(readYahooRegularSession(yahooChartPayload(tsRange(2), {}, {}))).toEqual({
      status: "absent",
    });
    expect(readYahooRegularSession(null)).toEqual({ status: "absent" });
  });

  /*
   * A present-but-corrupt container is a provider defect, not an absence. Routing it to `absent`
   * handed it to the age heuristic, which suppresses the gap entirely for an older bar.
   */
  test("reports unusable for a present but malformed schedule container", () => {
    expect(readYahooRegularSession(yahooChartPayload(tsRange(2), {}, "corrupt"))).toMatchObject({
      status: "unusable",
      detail: expect.stringContaining("meta"),
    });
    expect(
      readYahooRegularSession(
        yahooChartPayload(tsRange(2), {}, { currentTradingPeriod: "corrupt" }),
      ),
    ).toMatchObject({
      status: "unusable",
      detail: expect.stringContaining("currentTradingPeriod"),
    });
    expect(readYahooRegularSession(periodPayload(null))).toMatchObject({
      status: "unusable",
      detail: expect.stringContaining("regular is null"),
    });
    expect(readYahooRegularSession(periodPayload([1, 2]))).toMatchObject({ status: "unusable" });
  });

  /*
   * Absence says nothing about the provider; an implausible value is a provider defect, and the
   * two must not collapse — the caller declares one and may stay silent on the other.
   */
  test("reports unusable, not absent, for wrong types and non-finite bounds", () => {
    expect(
      readYahooRegularSession(periodPayload({ start: "1710941400", end: null })),
    ).toMatchObject({ status: "unusable" });
    expect(
      readYahooRegularSession(periodPayload({ start: Number.POSITIVE_INFINITY, end: Number.NaN })),
    ).toMatchObject({ status: "unusable" });
  });

  /*
   * The defect that motivated the range check: milliseconds are finite, convert to a year ~58000,
   * and produce a startDate that can never match a bar date — silently classifying an open session
   * as complete.
   */
  test("rejects a millisecond epoch", () => {
    const read = readYahooRegularSession(
      periodPayload({
        start: sessionEpoch("2024-03-20T13:30:00Z") * 1000,
        end: sessionEpoch("2024-03-20T20:00:00Z") * 1000,
      }),
    );
    expect(read.status).toBe("unusable");
    expect(read).toMatchObject({ detail: expect.stringContaining("plausible epoch seconds") });
  });

  test("rejects bounds outside the plausible epoch-seconds range", () => {
    expect(readYahooRegularSession(periodPayload({ start: 0, end: 3600 }))).toMatchObject({
      status: "unusable",
    });
    expect(readYahooRegularSession(periodPayload({ start: -1, end: -1 }))).toMatchObject({
      status: "unusable",
    });
    expect(
      readYahooRegularSession(periodPayload({ start: 1e18, end: Number.MAX_SAFE_INTEGER })),
    ).toMatchObject({ status: "unusable" });
  });

  test("rejects a non-increasing session", () => {
    const open = sessionEpoch("2024-03-20T13:30:00Z");
    expect(readYahooRegularSession(periodPayload({ start: open, end: open }))).toMatchObject({
      status: "unusable",
      detail: expect.stringContaining("duration"),
    });
    expect(
      readYahooRegularSession(
        periodPayload({ start: open, end: sessionEpoch("2024-03-20T09:00:00Z") }),
      ),
    ).toMatchObject({ status: "unusable", detail: expect.stringContaining("duration") });
  });

  test("rejects an implausible session duration in either direction", () => {
    const open = sessionEpoch("2024-03-20T13:30:00Z");
    expect(readYahooRegularSession(periodPayload({ start: open, end: open + 60 }))).toMatchObject({
      status: "unusable",
      detail: expect.stringContaining("duration"),
    });
    expect(
      readYahooRegularSession(periodPayload({ start: open, end: open + 86_401 })),
    ).toMatchObject({ status: "unusable", detail: expect.stringContaining("duration") });
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

  function chartPayloadWith80Bars(nullLatestClose = false): unknown {
    const timestamps = Array.from({ length: 80 }, (_, i) => {
      const d = new Date("2024-01-01");
      d.setDate(d.getDate() + i);
      return Math.floor(d.getTime() / 1000);
    });
    return yahooChartPayload(timestamps, {
      close: timestamps.map((_, index) =>
        nullLatestClose && index === timestamps.length - 1 ? null : 100 + index,
      ),
    });
  }

  test("returns snapshot when Yahoo returns >= 60 valid bars", async () => {
    const ctx = makeCtx(async () => jsonResponse(chartPayloadWith80Bars()));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", analysisDate);
    expect(result.snapshot).toBeDefined();
    expect(result.sourceGaps).toEqual([]);
    expect(result.snapshot?.symbol).toBe("AAPL");
    expect(result.snapshot?.assetClass).toBe("equity");
    expect(result.snapshot?.latestSessionDate).toBe("2024-03-20");
  });

  test("declares a newer dropped Yahoo bar without replacing the latest usable session", async () => {
    const ctx = makeCtx(async () => jsonResponse(chartPayloadWith80Bars(true)));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", analysisDate);

    expect(result.snapshot?.latestSessionDate).toBe("2024-03-19");
    expect(result.sourceGaps).toEqual([
      {
        source: "yahoo-verified-chart",
        message:
          "Yahoo chart bar 2024-03-20 has missing or non-numeric fields: close; latest usable session is 2024-03-19",
        symbol: "AAPL",
        provider: "yahoo",
        capability: "market-data",
        cause: "provider-data-missing",
        evidenceQualityImpact: "no-cap",
      },
    ]);
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

  // -------------------------------------------------------------------------
  // Session completeness — a bar whose regular session has not closed is not a close
  // -------------------------------------------------------------------------

  const SESSION_DATE = "2024-03-20";
  const SESSION_OPEN = sessionEpoch(`${SESSION_DATE}T13:30:00Z`);
  const SESSION_CLOSE = sessionEpoch(`${SESSION_DATE}T20:00:00Z`);

  test("drops the latest bar when its regular session has not ended at fetch time", async () => {
    const payload = sessionChartPayload({ start: SESSION_OPEN, end: SESSION_CLOSE });
    const ctx = makeCtxAt(`${SESSION_DATE}T15:00:00Z`, async () => jsonResponse(payload));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", SESSION_DATE);

    expect(result.snapshot?.latestSessionDate).toBe("2024-03-19");
    expect(result.snapshot?.ohlcv.date).toBe("2024-03-19");
    expect(result.priceHistory?.at(-1)?.date).toBe("2024-03-19");
    expect(result.snapshot?.recentCloses.at(-1)?.date).toBe("2024-03-19");
    expect(result.sourceGaps).toEqual([
      {
        source: "yahoo-verified-chart",
        message:
          "Yahoo chart bar 2024-03-20 was an in-progress session at fetch time " +
          `${ctx.fetchedAt} (regular session closes 2024-03-20T20:00:00.000Z); it was dropped ` +
          "before indicators and the snapshot is anchored on the last completed session 2024-03-19",
        symbol: "AAPL",
        provider: "yahoo",
        capability: "market-data",
        cause: "session-in-progress",
        evidenceQualityImpact: "no-cap",
        triage: "diagnostic",
      },
    ]);
  });

  test("recomputes indicators after the in-progress bar is removed, not before", async () => {
    const payload = sessionChartPayload({ start: SESSION_OPEN, end: SESSION_CLOSE });
    const ctx = makeCtxAt(`${SESSION_DATE}T15:00:00Z`, async () => jsonResponse(payload));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", SESSION_DATE);

    const { bars } = parseYahooChartOhlcv(payload, SESSION_DATE);
    expect(result.snapshot?.indicators).toEqual(computeIndicators(bars.slice(0, -1)));
    expect(result.snapshot?.indicators).not.toEqual(computeIndicators(bars));
  });

  test("keeps the latest bar once its regular session has closed", async () => {
    const payload = sessionChartPayload({ start: SESSION_OPEN, end: SESSION_CLOSE });
    const ctx = makeCtxAt(`${SESSION_DATE}T21:00:00Z`, async () => jsonResponse(payload));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", SESSION_DATE);

    expect(result.snapshot?.latestSessionDate).toBe(SESSION_DATE);
    expect(result.sourceGaps).toEqual([]);
  });

  /*
   * The pre-open case, and the counterpart to the stale-schedule check below: a schedule NEWER
   * than the newest bar is legitimate — the exchange has rolled to the next session while the last
   * bar is the previous, provably closed one. It must stay silent, not be read as stale.
   */
  test("keeps the latest bar when the open session is a later one it does not belong to", async () => {
    const payload = sessionChartPayload({
      start: sessionEpoch("2024-03-21T13:30:00Z"),
      end: sessionEpoch("2024-03-21T20:00:00Z"),
    });
    const ctx = makeCtxAt("2024-03-21T12:00:00Z", async () => jsonResponse(payload));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", "2024-03-21");

    expect(result.snapshot?.latestSessionDate).toBe(SESSION_DATE);
    expect(result.sourceGaps).toEqual([]);
  });

  test("keeps and declares the latest bar when the payload carries no session schedule", async () => {
    const payload = sessionChartPayload();
    const ctx = makeCtxAt(`${SESSION_DATE}T15:00:00Z`, async () => jsonResponse(payload));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", SESSION_DATE);

    expect(result.snapshot?.latestSessionDate).toBe(SESSION_DATE);
    expect(result.sourceGaps).toEqual([
      {
        source: "yahoo-verified-chart",
        message:
          `Yahoo chart bar ${SESSION_DATE} could not be verified as a completed session at ` +
          `fetch time ${ctx.fetchedAt} (the payload carried no regular trading-period ` +
          "schedule); the bar is retained and may be an in-progress session",
        symbol: "AAPL",
        provider: "yahoo",
        capability: "market-data",
        cause: "malformed-response",
        evidenceQualityImpact: "no-cap",
      },
    ]);
  });

  test("stays silent without a schedule once the latest bar predates the fetch window", async () => {
    const payload = sessionChartPayload();
    const ctx = makeCtxAt("2024-03-25T15:00:00Z", async () => jsonResponse(payload));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", "2024-03-25");

    expect(result.snapshot?.latestSessionDate).toBe(SESSION_DATE);
    expect(result.sourceGaps).toEqual([]);
  });

  /*
   * A schedule that fails validation must reach the DECLARED path. Before validation a millisecond
   * epoch produced a startDate no bar could match, so this bar was kept as a completed session
   * with no Source Gap at all — the defect the drop exists to prevent.
   */
  test("declares, rather than silently accepts, a bar behind an implausible schedule", async () => {
    const payload = sessionChartPayload({ start: SESSION_OPEN * 1000, end: SESSION_CLOSE * 1000 });
    const ctx = makeCtxAt(`${SESSION_DATE}T15:00:00Z`, async () => jsonResponse(payload));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", SESSION_DATE);

    expect(result.snapshot?.latestSessionDate).toBe(SESSION_DATE);
    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps?.[0]).toMatchObject({
      source: "yahoo-verified-chart",
      cause: "malformed-response",
      symbol: "AAPL",
    });
    expect(result.sourceGaps?.[0]?.message).toContain("could not be verified as a completed");
    expect(result.sourceGaps?.[0]?.message).toContain("schedule was implausible");
  });

  test("declares an out-of-order schedule even for a bar the age heuristic would clear", async () => {
    const payload = sessionChartPayload({ start: SESSION_CLOSE, end: SESSION_OPEN });
    const ctx = makeCtxAt("2024-03-25T15:00:00Z", async () => jsonResponse(payload));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", "2024-03-25");

    expect(result.snapshot?.latestSessionDate).toBe(SESSION_DATE);
    expect(result.sourceGaps?.[0]?.message).toContain("duration");
    expect(result.sourceGaps?.[0]?.cause).toBe("malformed-response");
  });

  /*
   * The minimum-bar check runs AFTER the drop, so with exactly MIN_BARS_FOR_SNAPSHOT parsed bars
   * there is no snapshot to anchor. The gap prose has to say that instead of claiming an anchor.
   */
  test("says no snapshot was produced when the drop leaves too few bars", async () => {
    const payload = sessionChartPayload(
      { start: SESSION_OPEN, end: SESSION_CLOSE },
      MIN_BARS_FOR_SNAPSHOT,
    );
    const ctx = makeCtxAt(`${SESSION_DATE}T15:00:00Z`, async () => jsonResponse(payload));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", SESSION_DATE);

    expect(result.snapshot).toBeUndefined();
    const sessionGap = result.sourceGaps?.find((gap) => gap.cause === "session-in-progress");
    expect(sessionGap?.message).toContain(
      `leaving ${String(MIN_BARS_FOR_SNAPSHOT - 1)} completed bars`,
    );
    expect(sessionGap?.message).toContain("no snapshot was produced");
    expect(sessionGap?.message).not.toContain("anchored");
    expect(result.sourceGaps?.some((gap) => gap.cause === "validation-failed")).toBe(true);
  });

  /*
   * A stale schedule is structurally valid but describes an EARLIER session than the newest bar,
   * so it proves nothing about that bar. Comparing dates for equality alone read this as complete
   * and emitted no gap — the same silent acceptance a malformed window would have caused.
   */
  test("declares a bar newer than the schedule instead of accepting it as complete", async () => {
    const payload = sessionChartPayload({
      start: sessionEpoch("2024-03-19T13:30:00Z"),
      end: sessionEpoch("2024-03-19T20:00:00Z"),
    });
    const ctx = makeCtxAt(`${SESSION_DATE}T15:00:00Z`, async () => jsonResponse(payload));
    const result = await collectVerifiedMarketSnapshot(ctx, "AAPL", SESSION_DATE);

    expect(result.snapshot?.latestSessionDate).toBe(SESSION_DATE);
    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps?.[0]?.cause).toBe("malformed-response");
    expect(result.sourceGaps?.[0]?.message).toContain("schedule is stale");
    expect(result.sourceGaps?.[0]?.message).toContain("older than the newest bar 2024-03-20");
  });

  /*
   * An anchored trim is the collector succeeding. Without an explicit triage it defaulted to
   * Material and put a routine intraday run in the Default View.
   */
  test("marks an anchored trim Diagnostic and the no-snapshot trim Material", async () => {
    const window = { start: SESSION_OPEN, end: SESSION_CLOSE };
    const anchoredCtx = makeCtxAt(`${SESSION_DATE}T15:00:00Z`, async () =>
      jsonResponse(sessionChartPayload(window)),
    );
    const anchored = await collectVerifiedMarketSnapshot(anchoredCtx, "AAPL", SESSION_DATE);
    expect(anchored.snapshot).toBeDefined();
    expect(anchored.sourceGaps?.[0]?.triage).toBe("diagnostic");

    const shortCtx = makeCtxAt(`${SESSION_DATE}T15:00:00Z`, async () =>
      jsonResponse(sessionChartPayload(window, MIN_BARS_FOR_SNAPSHOT)),
    );
    const short = await collectVerifiedMarketSnapshot(shortCtx, "AAPL", SESSION_DATE);
    expect(short.snapshot).toBeUndefined();
    expect(
      short.sourceGaps?.find((gap) => gap.cause === "session-in-progress")?.triage,
    ).toBeUndefined();
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
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
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

  test("includes verified representative snapshot sources for research runs", () => {
    const list = buildSourceList(
      {
        jobType: "research",
        assetClass: "equity",
        subject: "biotech",
        subjectKey: "biotech",
        predictionProxySymbol: "XBI",
        depth: "deep",
      },
      collectedSources({
        verifiedRepresentativeSnapshots: [
          { ...verifiedSnapshotFixture(), symbol: "AMGN" },
          { ...verifiedSnapshotFixture(), symbol: "GILD" },
        ],
      }),
      undefined,
      "2026-01-01T00:00:00.000Z",
    );

    expect(list.map((source) => source.id)).toEqual(
      expect.arrayContaining(["verified-snapshot-AMGN", "verified-snapshot-GILD"]),
    );
  });

  test("does not include verified-snapshot source for daily run", () => {
    const list = buildSourceList(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
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
    return buildStagePrompt("specialist-analysis", {
      command,
      collectedSources: sources,
      config,
      context: {
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
          quickModelParams: undefined,
          synthesisModelParams: undefined,
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
      loaded: { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    });
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
      { now: new Date("2026-05-20T00:00:00.000Z"), fetchImpl: tickerFetch, retryDelaysMs: [] },
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
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      sourceOptions,
      { now: new Date("2026-05-20T00:00:00.000Z"), fetchImpl: tickerFetch, retryDelaysMs: [] },
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
      {
        now: new Date("2026-05-20T00:00:00.000Z"),
        fetchImpl: (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes("/v8/finance/chart/")) {
            return Promise.reject(new Error("chart unavailable"));
          }
          return tickerFetch(input);
        },
        retryDelaysMs: [],
      },
    );

    expect(result.verifiedMarketSnapshot).toBeUndefined();
    expect(
      result.sourceGaps.some(
        (gap) => gap.source === "yahoo-verified-chart" && gap.evidenceQualityImpact === "core-cap",
      ),
    ).toBe(true);
  });
});
