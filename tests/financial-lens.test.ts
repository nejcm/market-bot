import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence, VerifiedMarketSnapshot } from "../src/domain/types";
import { renderMarkdownReport } from "../src/report/markdown";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import { marketSnapshot, researchReport } from "./support/fixtures";

const command = { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" } as const;

function verifiedSnapshot(overrides: Partial<VerifiedMarketSnapshot> = {}): VerifiedMarketSnapshot {
  return {
    symbol: "AAPL",
    assetClass: "equity",
    analysisDate: "2026-06-22",
    fetchedAt: "2026-06-22T00:00:00.000Z",
    latestSessionDate: "2026-06-21",
    ohlcv: {
      date: "2026-06-21",
      open: 190,
      high: 198,
      low: 188,
      close: 196,
      volume: 80_000_000,
    },
    indicators: {
      ema10: 192,
      sma50: 180,
      sma200: 160,
      rsi14: 58,
      macd: 3,
      macdSignal: 2,
      macdHistogram: 1,
      bollUpper: 205,
      bollMiddle: 180,
      bollLower: 155,
      atr14: 4,
    },
    recentCloses: [
      { date: "2026-06-20", close: 190 },
      { date: "2026-06-21", close: 196 },
    ],
    ...overrides,
  };
}

function evidence(): ExtendedEvidence {
  return {
    instrument: { symbol: "AAPL", assetClass: "equity" },
    items: [
      {
        category: "sec-edgar",
        title: "AAPL SEC Fundamental Evidence",
        summary: "SEC Fundamental Evidence.",
        sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
        observedAt: "2026-06-20T00:00:00.000Z",
        metrics: {
          revenue: 100,
          revenueDeltaPercent: 12,
          grossProfit: 42,
          grossProfitDeltaPercent: 10,
          operatingIncome: 24,
          operatingIncomeDeltaPercent: 8,
          netIncome: 18,
          netIncomeDeltaPercent: 6,
          dilutedEpsDeltaPercent: 5,
          operatingCashFlow: 30,
          operatingCashFlowDeltaPercent: 4,
          capex: 5,
          cash: 35,
          debt: 20,
          currentAssets: 80,
          currentLiabilities: 40,
        },
      },
      {
        category: "valuation",
        title: "AAPL Valuation Evidence",
        summary: "Valuation Evidence.",
        sourceIds: ["market-yahoo-equity-aapl", "extended-sec-edgar-aapl-fundamentals"],
        observedAt: "2026-06-21T00:00:00.000Z",
        metrics: {
          enterpriseValue: 985,
          annualizedRevenue: 400,
          evToAnnualizedRevenue: 2.46,
          marketCapToAnnualizedRevenue: 2.5,
          debtToMarketCap: 0.02,
          netDebt: -15,
          netDebtToMarketCap: -0.015,
          valuationSupportability: "supported",
        },
      },
    ],
    gaps: [],
  };
}

describe("addFinancialLensEvidence", () => {
  test("derives compact lens metrics and neutral postures", () => {
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      evidence(),
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    const item = result.extendedEvidence?.items.find(
      (entry) => entry.category === "financial-lens",
    );
    expect(result.sourceGaps).toEqual([]);
    expect(result.artifact?.version).toBe(1);
    expect(result.artifact?.lenses.map((lens) => lens.name)).toEqual([
      "Quality",
      "Growth",
      "Financial Strength",
      "Value",
      "Momentum",
    ]);
    expect(result.artifact?.lenses.map((lens) => lens.posture)).toEqual([
      "criteria-supported",
      "criteria-supported",
      "criteria-supported",
      "criteria-supported",
      "criteria-supported",
    ]);
    expect(item?.summary).toContain("Financial Lens Evidence:");
    expect(item?.sourceIds).toContain("verified-snapshot-AAPL");
    expect(item?.metrics?.qualityPosture).toBe("criteria-supported");
    expect(item?.metrics?.financialStrengthPosture).toBe("criteria-supported");
  });

  test("emits partial no-cap gap when derived inputs are missing", () => {
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl" })],
      { instrument: { symbol: "AAPL", assetClass: "equity" }, items: [], gaps: [] },
      undefined,
      "2026-06-22T00:00:00.000Z",
    );

    expect(result.artifact?.lenses).toHaveLength(5);
    expect(result.sourceGaps).toEqual([
      expect.objectContaining({
        source: "financial-lens",
        evidenceQualityImpact: "no-cap",
      }),
    ]);
    expect(result.extendedEvidence?.gaps).toEqual(result.sourceGaps);
  });

  test("reports insufficient-data, not criteria-not-supported, when SEC inputs are absent", () => {
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl" })],
      { instrument: { symbol: "AAPL", assetClass: "equity" }, items: [], gaps: [] },
      undefined,
      "2026-06-22T00:00:00.000Z",
    );

    const postureByName = Object.fromEntries(
      (result.artifact?.lenses ?? []).map((lens) => [lens.name, lens.posture]),
    );
    expect(postureByName.Quality).toBe("insufficient-data");
    expect(postureByName.Growth).toBe("insufficient-data");
    expect(postureByName["Financial Strength"]).toBe("insufficient-data");
    expect(postureByName.Value).toBe("insufficient-data");
    expect(postureByName.Momentum).toBe("insufficient-data");
  });

  test("formats ratio margins and whole-percent deltas without guessing the scale", () => {
    const partialPercents: ExtendedEvidence = {
      ...evidence(),
      items: evidence().items.map((item) =>
        item.category === "sec-edgar"
          ? {
              ...item,
              // Here 0.5 means +0.5% YoY: must render as 0.5%, never 50.0%.
              metrics: { ...item.metrics, revenueDeltaPercent: 0.5 },
            }
          : item,
      ),
    };
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      partialPercents,
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );
    const lenses = Object.fromEntries(
      (result.artifact?.lenses ?? []).map((lens) => [lens.name, lens]),
    );

    // Gross margin = 42/100 = 0.42 (ratio) -> 42.0%
    expect(lenses.Quality?.metrics.find((m) => m.key === "grossMargin")).toMatchObject({
      unit: "ratio-percent",
    });
    expect(
      result.extendedEvidence?.items.find((i) => i.category === "financial-lens")?.summary,
    ).toContain("Gross margin 42.0%");
    // Revenue YoY = 0.5 (already whole-percent) -> 0.5%
    expect(lenses.Growth?.metrics.find((m) => m.key === "revenueDeltaPercent")).toMatchObject({
      unit: "whole-percent",
    });
    expect(
      result.extendedEvidence?.items.find((i) => i.category === "financial-lens")?.summary,
    ).toContain("Revenue YoY 0.5%");
  });

  test("returns evidence unchanged for non-equity / non-ticker commands", () => {
    const overviewCommand = {
      jobType: "market-overview",
      assetClass: "equity",
      depth: "deep",
      horizonTradingDays: 5,
    } as const;
    const existing = evidence();
    const result = addFinancialLensEvidence(
      overviewCommand,
      [],
      existing,
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    expect(result.artifact).toBeUndefined();
    expect(result.sourceGaps).toEqual([]);
    expect(result.extendedEvidence).toBe(existing);
  });

  test("returns evidence unchanged for non-equity ticker commands", () => {
    const cryptoCommand = {
      jobType: "crypto",
      assetClass: "crypto",
      symbol: "BTC",
      depth: "deep",
    } as const;
    const existing = evidence();
    const result = addFinancialLensEvidence(
      cryptoCommand,
      [],
      existing,
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    expect(result.artifact).toBeUndefined();
    expect(result.extendedEvidence).toBe(existing);
  });

  test("derives momentum posture from partial indicators", () => {
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      evidence(),
      verifiedSnapshot({
        indicators: {
          ...verifiedSnapshot().indicators,
          sma50: 180,
          sma200: undefined as unknown as number,
        },
      }),
      "2026-06-22T00:00:00.000Z",
    );

    const momentum = result.artifact?.lenses.find((lens) => lens.name === "Momentum");
    // Close > sma50 and rsi in band and macd>=0 are known; sma50/sma200 cross is unknown.
    expect(momentum?.posture).toBe("criteria-supported");
    expect(momentum?.metrics.find((m) => m.key === "sma200")).toBeUndefined();
  });

  test("renders financial lens evidence in ticker markdown with citations", () => {
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      evidence(),
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );
    const { extendedEvidence } = result;
    expect(extendedEvidence).toBeDefined();
    const markdown = renderMarkdownReport(
      researchReport({
        jobType: "equity",
        symbol: "AAPL",
        sources: [
          {
            id: "market-yahoo-equity-aapl",
            title: "AAPL market data",
            fetchedAt: "2026-06-22T00:00:00.000Z",
            kind: "market-data",
          },
          {
            id: "extended-sec-edgar-aapl-fundamentals",
            title: "AAPL SEC fundamentals",
            fetchedAt: "2026-06-22T00:00:00.000Z",
            kind: "extended-evidence",
          },
          {
            id: "verified-snapshot-AAPL",
            title: "AAPL verified market snapshot",
            fetchedAt: "2026-06-22T00:00:00.000Z",
            kind: "market-data",
          },
        ],
        ...(extendedEvidence !== undefined ? { extendedEvidence } : {}),
      }),
    );

    expect(markdown).toContain("AAPL Financial Lens Evidence");
    expect(markdown).toContain("[verified-snapshot-AAPL]");
  });

  test("renders latestClose in quote currency for GBp tickers", () => {
    const gbpCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "RR.L",
      depth: "deep",
    } as const;
    const result = addFinancialLensEvidence(
      gbpCommand,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-rr",
          symbol: "RR.L",
          identity: { quoteCurrency: "GBp" },
        }),
      ],
      { instrument: { symbol: "RR.L", assetClass: "equity" }, items: [], gaps: [] },
      verifiedSnapshot({
        symbol: "RR.L",
        ohlcv: {
          date: "2026-06-21",
          open: 1400,
          high: 1420,
          low: 1395,
          close: 1411.8,
          volume: 1_000_000,
        },
      }),
      "2026-06-22T00:00:00.000Z",
    );

    const momentum = result.artifact?.lenses.find((lens) => lens.name === "Momentum");
    const latestClose = momentum?.metrics.find((m) => m.key === "latestClose");
    expect(latestClose?.unit).toBe("currency");
    expect(latestClose?.currency).toBe("GBp");
    expect(latestClose?.value).toBe(1411.8);
    const summary = result.extendedEvidence?.items.find(
      (i) => i.category === "financial-lens",
    )?.summary;
    // Pence suffix, no K/M/B scaling, no $ symbol.
    expect(summary).toContain("Latest close 1,411.8p");
    expect(summary).not.toContain("$");
  });

  test("renders latestClose in USD for US tickers (regression guard)", () => {
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      evidence(),
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    const momentum = result.artifact?.lenses.find((lens) => lens.name === "Momentum");
    const latestClose = momentum?.metrics.find((m) => m.key === "latestClose");
    expect(latestClose?.unit).toBe("currency");
    // US tickers carry no quoteCurrency on the snapshot; the fallback defaults to USD.
    expect(latestClose?.currency).toBe("USD");
    const summary = result.extendedEvidence?.items.find(
      (i) => i.category === "financial-lens",
    )?.summary;
    // Close 196 -> $196 (no K scaling under 1000).
    expect(summary).toContain("Latest close $196");
  });
});
