import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence, VerifiedMarketSnapshot } from "../src/domain/types";
import { renderMarkdownReport } from "../src/report/markdown";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import { marketSnapshot, researchReport } from "./support/fixtures";

const command = { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" } as const;

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
        jobType: "ticker",
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
});
