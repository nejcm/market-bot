import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  VerifiedMarketSnapshot,
} from "../src/domain/types";
import { renderMarkdownReport } from "../src/report/markdown";
import { loadRunArtifact } from "../src/run-artifacts";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import { summarizeSecFundamentals } from "../src/sources/extended-evidence/sec-edgar";
import {
  MIXED_PERIOD_METRIC,
  REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
} from "../src/sources/extended-evidence/valuation-comps";
import { buildYahooFundamentals } from "../src/sources/extended-evidence/yahoo-fundamentals";
import {
  formatLensValue,
  formatPeRatio,
  PE_NOT_MEANINGFUL,
} from "../src/sources/extended-evidence/value-format";
import { marketSnapshot, researchReport } from "./support/fixtures";

const command = { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" } as const;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
          revenuePeriodEnd: "2025-06-28",
          revenuePeriodMonths: 12,
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
          revenuePeriodEnd: "2025-06-28",
          revenuePeriodMonths: 12,
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
    expect(metricByKey(result, "Quality", "grossMargin")).toMatchObject({
      periodEnd: "2025-06-28",
      periodMonths: 12,
    });
    expect(metricByKey(result, "Value", "evToAnnualizedRevenue")).toMatchObject({
      periodEnd: "2025-06-28",
      periodMonths: 12,
    });
  });

  test("does not recompute net debt when valuation marks it mixed-period", () => {
    const baseEvidence = evidence();
    const mixedPeriodEvidence: ExtendedEvidence = {
      ...baseEvidence,
      items: baseEvidence.items.map((item) =>
        item.category === "valuation"
          ? {
              ...item,
              metrics: Object.fromEntries(
                Object.entries({ ...item.metrics, netDebt: MIXED_PERIOD_METRIC }).filter(
                  ([key]) => key !== "netDebtToMarketCap",
                ),
              ),
            }
          : item,
      ),
    };

    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      mixedPeriodEvidence,
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    const strength = result.artifact?.lenses.find((lens) => lens.name === "Financial Strength");
    expect(strength?.metrics.find((metric) => metric.key === "netDebt")).toBeUndefined();
    expect(strength?.metrics.find((metric) => metric.key === "netDebtToMarketCap")).toBeUndefined();
  });

  test("flags stale EV date mixing and clamps negative zero lens values", () => {
    const baseEvidence = evidence();
    const datedEvidence: ExtendedEvidence = {
      ...baseEvidence,
      items: baseEvidence.items.map((item) =>
        item.category === "valuation"
          ? {
              ...item,
              metrics: {
                ...item.metrics,
                quoteObservedAt: "2026-06-21T00:00:00.000Z",
                cashPeriodEnd: "2025-12-31",
                debtPeriodEnd: "2025-12-31",
              },
            }
          : item,
      ),
    };
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      datedEvidence,
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    expect(metricByKey(result, "Value", "evDateBasis")).toMatchObject({
      label: "EV date basis",
      value: "EV mixes market cap (quote 2026-06-21) with cash/debt (balance sheet 2025-12-31)",
      unit: "text",
    });
    expect(formatLensValue(-0.000_01, "ratio")).toBe("0.00x");
    expect(formatLensValue(-0.000_01, "number")).toBe("0.00");
    expect(formatLensValue(-0.000_01, "ratio-percent")).toBe("0.0%");
    expect(formatLensValue(-0.000_01, "whole-percent")).toBe("0.0%");
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

  test("labels parent-attributable loss changes and discloses distinct consolidated income", () => {
    const baseEvidence = evidence();
    const attributedEvidence: ExtendedEvidence = {
      ...baseEvidence,
      items: baseEvidence.items.map((item) =>
        item.category === "sec-edgar"
          ? {
              ...item,
              metrics: {
                ...item.metrics,
                netIncome: -20,
                netIncomePrior: -10,
                netIncomeDeltaPercent: -100,
                consolidatedNetIncome: -18,
                consolidatedNetIncomePeriodEnd: "2025-06-28",
                consolidatedNetIncomePeriodMonths: 12,
              },
            }
          : item,
      ),
    };
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      attributedEvidence,
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    expect(metricByKey(result, "Growth", "netIncomeDeltaPercent")).toMatchObject({
      label: "Net loss (attrib.) YoY change",
      value: -100,
    });
    expect(metricByKey(result, "Quality", "consolidatedNetIncome")).toMatchObject({
      label: "Net income (consolidated incl. NCI)",
      value: -18,
      periodEnd: "2025-06-28",
      periodMonths: 12,
    });
  });

  test("describes widening parent-attributable losses in SEC summaries", () => {
    const summary = summarizeSecFundamentals({
      facts: {
        "us-gaap": {
          NetIncomeLoss: {
            units: {
              USD: [
                {
                  val: -20,
                  form: "10-Q",
                  fp: "Q1",
                  fy: 2026,
                  filed: "2026-05-01",
                  start: "2026-01-01",
                  end: "2026-03-31",
                },
                {
                  val: -10,
                  form: "10-Q",
                  fp: "Q1",
                  fy: 2025,
                  filed: "2025-05-01",
                  start: "2025-01-01",
                  end: "2025-03-31",
                },
              ],
            },
          },
          ProfitLoss: {
            units: {
              USD: [
                {
                  val: -18,
                  form: "10-Q",
                  fp: "Q1",
                  fy: 2026,
                  filed: "2026-05-01",
                  start: "2026-01-01",
                  end: "2026-03-31",
                },
              ],
            },
          },
        },
      },
    });

    expect(summary?.summary).toContain(
      "net income attributable to parent -20 (loss widened 100.0% YoY)",
    );
    expect(summary?.summary).toContain("net income consolidated including NCI -18");
    expect(summary?.metrics.consolidatedNetIncome).toBe(-18);
  });

  test("omits duplicate consolidated net income from SEC summaries", () => {
    const incomeFact = {
      val: -20,
      form: "10-Q",
      fp: "Q1",
      fy: 2026,
      filed: "2026-05-01",
      start: "2026-01-01",
      end: "2026-03-31",
    };
    const summary = summarizeSecFundamentals({
      facts: {
        "us-gaap": {
          NetIncomeLoss: { units: { USD: [incomeFact] } },
          ProfitLoss: { units: { USD: [incomeFact] } },
        },
      },
    });

    expect(summary?.summary).toContain("net income attributable to parent -20");
    expect(summary?.summary).not.toContain("net income consolidated including NCI");
    expect(summary?.metrics.consolidatedNetIncome).toBe(-20);
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

// ---------------------------------------------------------------------------
// Forbes/Investopedia ratio expansion: SEC + Yahoo two-tier provenance.
// See plan: financial-lens-ratio-expansion. ADR 0004.
// ---------------------------------------------------------------------------

function secEvidenceWithRatios(
  overrides: Record<string, number | string> = {},
): ExtendedEvidenceItem {
  return {
    category: "sec-edgar",
    title: "AAPL SEC Fundamental Evidence",
    summary: "SEC Fundamental Evidence.",
    sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
    observedAt: "2026-06-20T00:00:00.000Z",
    metrics: {
      revenue: 100,
      grossProfit: 42,
      operatingIncome: 24,
      netIncome: 18,
      operatingCashFlow: 30,
      capex: 5,
      cash: 35,
      debt: 20,
      currentAssets: 80,
      currentLiabilities: 40,
      stockholdersEquity: 50,
      assets: 120,
      dividendsPaid: -5,
      ...overrides,
    },
  };
}

function yahooFundamentalsEvidence(
  overrides: Record<string, number | string> = {},
): ExtendedEvidenceItem {
  return {
    category: "yahoo-fundamentals",
    title: "AAPL Yahoo Fundamentals Evidence",
    summary: "Yahoo Fundamentals.",
    sourceIds: ["market-yahoo-equity-aapl"],
    observedAt: "2026-06-21T00:00:00.000Z",
    metrics: {
      trailingPE: 36.08,
      forwardPE: 31.06,
      priceToBook: 41.05,
      dividendYield: 0.36,
      epsTrailingTwelveMonths: 8.26,
      epsForward: 9.595,
      trailingAnnualDividendRate: 1.04,
      ...overrides,
    },
  };
}

function valuationEvidence(): ExtendedEvidenceItem {
  return {
    category: "valuation",
    title: "AAPL Valuation Evidence",
    summary: "Valuation Evidence.",
    sourceIds: ["market-yahoo-equity-aapl", "extended-sec-edgar-aapl-fundamentals"],
    observedAt: "2026-06-21T00:00:00.000Z",
    metrics: {
      marketCap: 1000,
      enterpriseValue: 985,
      annualizedRevenue: 400,
      evToAnnualizedRevenue: 2.46,
      marketCapToAnnualizedRevenue: 2.5,
      debtToMarketCap: 0.02,
      netDebt: -15,
      netDebtToMarketCap: -0.015,
      valuationSupportability: "supported",
    },
  };
}

function lensByName(result: ReturnType<typeof addFinancialLensEvidence>, name: string) {
  return result.artifact?.lenses.find((lens) => lens.name === name);
}

function metricByKey(
  result: ReturnType<typeof addFinancialLensEvidence>,
  lensName: string,
  key: string,
) {
  return lensByName(result, lensName)?.metrics.find((metric) => metric.key === key);
}

describe("financial lens artifact compatibility", () => {
  test("loads persisted metrics without optional period fields", async () => {
    const runDir = join(
      tmpdir(),
      `market-bot-financial-lens-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    tempDirs.push(runDir);
    await mkdir(join(runDir, "normalized"), { recursive: true });
    await Bun.write(
      join(runDir, "report.json"),
      `${JSON.stringify(researchReport({ runId: "legacy-financial-lens" }))}\n`,
    );
    await Bun.write(
      join(runDir, "normalized", "financial-lenses.json"),
      `${JSON.stringify({
        version: 1,
        generatedAt: "2026-06-22T00:00:00.000Z",
        symbol: "AAPL",
        lenses: [
          {
            name: "Quality",
            posture: "criteria-supported",
            metrics: [
              {
                key: "grossMargin",
                label: "Gross margin",
                value: 0.42,
                unit: "ratio-percent",
                sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
              },
            ],
            sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
          },
        ],
        sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
      })}\n`,
    );

    const loaded = await loadRunArtifact(runDir);

    expect(loaded.artifact?.financialLenses?.lenses[0]?.metrics[0]).toMatchObject({
      key: "grossMargin",
      value: 0.42,
    });
  });
});

describe("addFinancialLensEvidence — Forbes ratio expansion", () => {
  test("SEC ROE/ROA are annualized by net income's own period and display-only", () => {
    // 9-month netIncome 71.7 annualized by netIncomePeriodMonths=9 -> 95.6.
    // ROE = 95.6 / 50 = 1.912 (191.2%), not 71.7/50 = 143.4%.
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [
          secEvidenceWithRatios({
            netIncome: 71.7,
            netIncomePeriodMonths: 9,
            netIncomePeriodEnd: "2026-03-28",
            stockholdersEquity: 50,
            assets: 120,
          }),
          valuationEvidence(),
        ],
        gaps: [],
      },
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    const roe = metricByKey(result, "Quality", "roe");
    const roa = metricByKey(result, "Quality", "roa");
    expect(roe).toMatchObject({
      unit: "ratio-percent",
      sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
      periodEnd: "2026-03-28",
      periodMonths: 9,
    });
    expect(roe?.value).toBeCloseTo((71.7 * (12 / 9)) / 50, 5);
    expect(roa?.value).toBeCloseTo((71.7 * (12 / 9)) / 120, 5);
    // Display-only: Quality posture is unaffected by ROE/ROA (no threshold).
    expect(lensByName(result, "Quality")?.posture).not.toBe("insufficient-data");
  });

  test("SEC debt-to-equity is display-only", () => {
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [secEvidenceWithRatios(), valuationEvidence()],
        gaps: [],
      },
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    const debtToEquity = metricByKey(result, "Financial Strength", "debtToEquity");
    expect(debtToEquity).toMatchObject({ unit: "ratio", value: 20 / 50 });
  });

  test("SEC payout <= 0.8 supports Financial Strength; dividendsPaid sign handled via abs()", () => {
    // DividendsPaid -5 (XBRL outflow), netIncome 18 -> payout = 5/18 = 0.278 (<= 0.8).
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [secEvidenceWithRatios(), valuationEvidence()],
        gaps: [],
      },
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    const payout = metricByKey(result, "Financial Strength", "payoutRatio");
    expect(payout).toMatchObject({
      unit: "ratio-percent",
      value: Math.abs(-5) / 18,
      sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
    });
    expect(lensByName(result, "Financial Strength")?.posture).toBe("criteria-supported");
  });

  test("SEC payout > 0.8 does not support Financial Strength", () => {
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [secEvidenceWithRatios({ dividendsPaid: -20, netIncome: 20 }), valuationEvidence()],
        gaps: [],
      },
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    // Payout = 20/20 = 1.0 (> 0.8). Existing strength criteria all support, so the
    // Payout criterion flips the lens to criteria-mixed.
    expect(metricByKey(result, "Financial Strength", "payoutRatio")?.value).toBe(1);
    expect(lensByName(result, "Financial Strength")?.posture).toBe("criteria-mixed");
  });

  test("Yahoo PE/Forward PE/PBV appear in Value lens and are display-only", () => {
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [secEvidenceWithRatios(), valuationEvidence(), yahooFundamentalsEvidence()],
        gaps: [],
      },
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    const value = lensByName(result, "Value");
    const pe = value?.metrics.find((metric) => metric.key === "peRatio");
    const forwardPe = value?.metrics.find((metric) => metric.key === "forwardPe");
    const pbv = value?.metrics.find((metric) => metric.key === "priceToBook");
    expect(pe).toMatchObject({
      value: 36.08,
      unit: "ratio",
      sourceIds: ["market-yahoo-equity-aapl"],
      periodEnd: "2026-06-21T00:00:00.000Z",
    });
    expect(forwardPe?.value).toBe(31.06);
    expect(pbv?.value).toBe(41.05);
    // Value posture is driven only by peer supportability — PE/PBV do not change it.
    expect(value?.posture).toBe("criteria-supported");
  });

  test("renders P/E as not meaningful when the corresponding earnings are negative", () => {
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [
          secEvidenceWithRatios(),
          valuationEvidence(),
          yahooFundamentalsEvidence({
            trailingPE: -40,
            epsTrailingTwelveMonths: -2,
            forwardPE: -222.14,
            epsForward: -0.47,
          }),
        ],
        gaps: [],
      },
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    expect(metricByKey(result, "Value", "peRatio")).toMatchObject({
      value: PE_NOT_MEANINGFUL,
      unit: "text",
    });
    expect(metricByKey(result, "Value", "forwardPe")).toMatchObject({
      value: PE_NOT_MEANINGFUL,
      unit: "text",
    });
    expect(metricByKey(result, "Value", "epsForward")).toMatchObject({
      label: "Forward EPS",
      value: -0.47,
      unit: "number",
    });
    expect(result.extendedEvidence?.items.at(-1)?.metrics?.forwardPe).toBe(PE_NOT_MEANINGFUL);
  });

  test("renders P/E as not meaningful when earnings are zero", () => {
    expect(formatPeRatio(10, 0)).toBe("N/M (non-positive earnings)");
  });

  test("renders not-meaningful revenue supportability as a Value-lens caveat", () => {
    const valuation = valuationEvidence();
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [
          secEvidenceWithRatios(),
          {
            ...valuation,
            metrics: {
              ...valuation.metrics,
              valuationSupportability: "not-meaningful",
            },
          },
        ],
        gaps: [],
      },
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    const value = lensByName(result, "Value");
    expect(value?.posture).toBe("insufficient-data");
    expect(value?.metrics[0]).toMatchObject({
      key: "valuationCaveat",
      value: REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
    });
    expect(result.extendedEvidence?.items.at(-1)?.summary).toContain(
      REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
    );
  });

  test("Yahoo dividendYield is whole-percent (verified against captured fixture) and display-only", () => {
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [secEvidenceWithRatios(), valuationEvidence(), yahooFundamentalsEvidence()],
        gaps: [],
      },
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    const divYield = metricByKey(result, "Financial Strength", "dividendYield");
    // Captured AAPL fixture: dividendYield 0.36 means 0.36% (whole-percent), NOT 36%.
    // A fraction unit would be ratio-percent and render as 36.0% in the tile.
    expect(divYield).toMatchObject({ value: 0.36, unit: "whole-percent" });
    expect(divYield?.sourceIds).toEqual(["market-yahoo-equity-aapl"]);
    // Display-only: dividendYield does not add a posture criterion.
    expect(lensByName(result, "Financial Strength")?.posture).toBe("criteria-supported");
  });

  test("SEC PCF = marketCap / annualized operating cash flow, display-only", () => {
    // OperatingCashFlow 30 over 9 months -> annualized 40. PCF = 1000 / 40 = 25.
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [
          secEvidenceWithRatios({
            operatingCashFlow: 30,
            operatingCashFlowPeriodMonths: 9,
            operatingCashFlowPeriodEnd: "2026-03-28",
          }),
          valuationEvidence(),
          yahooFundamentalsEvidence(),
        ],
        gaps: [],
      },
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    const pcf = metricByKey(result, "Value", "pcfRatio");
    expect(pcf?.value).toBeCloseTo(1000 / (30 * (12 / 9)), 5);
    // Provenance reflects PCF's actual inputs: SEC (operating cash flow) + the
    // Market snapshot that supplied marketCap.
    expect(pcf?.sourceIds).toEqual([
      "extended-sec-edgar-aapl-fundamentals",
      "market-yahoo-equity-aapl",
    ]);
    expect(pcf).toMatchObject({ periodEnd: "2026-03-28", periodMonths: 9 });
  });

  test("PCF sourceIds reflect SEC + market snapshot even with no valuation item", () => {
    // Regression guard: PCF computes from snapshot marketCap + SEC operating cash
    // Flow without any valuation item. Provenance must not fall back to the (absent)
    // Valuation item's sourceIds, which would leave the metric with empty provenance.
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [secEvidenceWithRatios({ operatingCashFlow: 30, operatingCashFlowPeriodMonths: 9 })],
        gaps: [],
      },
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    const pcf = metricByKey(result, "Value", "pcfRatio");
    expect(pcf?.value).toBeCloseTo(1000 / (30 * (12 / 9)), 5);
    expect(pcf?.sourceIds).toEqual([
      "extended-sec-edgar-aapl-fundamentals",
      "market-yahoo-equity-aapl",
    ]);
  });

  test("mixed sources: PE from Yahoo, ROE from SEC, each carrying its own sourceIds", () => {
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
      {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [secEvidenceWithRatios(), valuationEvidence(), yahooFundamentalsEvidence()],
        gaps: [],
      },
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    expect(metricByKey(result, "Value", "peRatio")?.sourceIds).toEqual([
      "market-yahoo-equity-aapl",
    ]);
    expect(metricByKey(result, "Quality", "roe")?.sourceIds).toEqual([
      "extended-sec-edgar-aapl-fundamentals",
    ]);
  });

  test("Yahoo-fallback payout is display-only and does not flip Financial Strength from insufficient-data", () => {
    // No SEC item at all (non-US listing). Yahoo payout = 1.04 / 8.26 = 0.126.
    const result = addFinancialLensEvidence(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl" })],
      {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [yahooFundamentalsEvidence()],
        gaps: [],
      },
      verifiedSnapshot(),
      "2026-06-22T00:00:00.000Z",
    );

    const payout = metricByKey(result, "Financial Strength", "payoutRatio");
    expect(payout).toMatchObject({
      value: 1.04 / 8.26,
      sourceIds: ["market-yahoo-equity-aapl"],
    });
    // No SEC -> all strength criteria undefined -> insufficient-data, even with a
    // Yahoo-sourced payout present (revision 3).
    expect(lensByName(result, "Financial Strength")?.posture).toBe("insufficient-data");
  });

  test("non-US listing: only Yahoo + Momentum, SEC-dependent lenses insufficient-data", () => {
    const rrlCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "RR.L",
      depth: "deep",
    } as const;
    const result = addFinancialLensEvidence(
      rrlCommand,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-rr",
          symbol: "RR.L",
          identity: { quoteCurrency: "GBp" },
        }),
      ],
      {
        instrument: { symbol: "RR.L", assetClass: "equity" },
        items: [
          yahooFundamentalsEvidence({
            trailingPE: 20.46,
            forwardPE: 32.62,
            priceToBook: 43.31,
            dividendYield: 0.67,
            epsTrailingTwelveMonths: 0.69,
            trailingAnnualDividendRate: 0.095,
          }),
        ],
        gaps: [],
      },
      verifiedSnapshot({ symbol: "RR.L" }),
      "2026-06-22T00:00:00.000Z",
    );

    const postureByName = Object.fromEntries(
      (result.artifact?.lenses ?? []).map((lens) => [lens.name, lens.posture]),
    );
    expect(postureByName.Quality).toBe("insufficient-data");
    expect(postureByName.Growth).toBe("insufficient-data");
    expect(postureByName["Financial Strength"]).toBe("insufficient-data");
    // Value has Yahoo PE/PBV but no SEC EV metrics; supportability undefined -> insufficient-data.
    expect(postureByName.Value).toBe("insufficient-data");
    // Momentum derives from the verified snapshot indicators.
    expect(postureByName.Momentum).not.toBe("insufficient-data");
    const value = lensByName(result, "Value");
    expect(value?.metrics.find((metric) => metric.key === "peRatio")?.value).toBe(20.46);
    expect(value?.metrics.find((metric) => metric.key === "priceToBook")?.value).toBe(43.31);
    // No SEC -> no ROE/ROA/D-E/PCF metrics.
    expect(metricByKey(result, "Quality", "roe")).toBeUndefined();
    expect(metricByKey(result, "Financial Strength", "debtToEquity")).toBeUndefined();
  });
});

describe("buildYahooFundamentals", () => {
  test("derives the item from snapshot.fundamentals with the snapshot source id", () => {
    const item = buildYahooFundamentals(
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-aapl",
          fundamentals: {
            trailingPE: 36.08,
            forwardPE: 31.06,
            priceToBook: 41.05,
            bookValue: 7.26,
            dividendYield: 0.36,
            epsTrailingTwelveMonths: 8.26,
            epsForward: 9.595,
            sharesOutstanding: 14_687_356_000,
            trailingAnnualDividendRate: 1.04,
          },
        }),
      ],
      "2026-06-22T00:00:00.000Z",
    );

    expect(item?.category).toBe("yahoo-fundamentals");
    expect(item?.sourceIds).toEqual(["market-yahoo-equity-aapl"]);
    expect(item?.metrics).toMatchObject({
      trailingPE: 36.08,
      forwardPE: 31.06,
      priceToBook: 41.05,
      bookValue: 7.26,
      dividendYield: 0.36,
      epsTrailingTwelveMonths: 8.26,
      epsForward: 9.595,
      sharesOutstanding: 14_687_356_000,
      trailingAnnualDividendRate: 1.04,
    });
    expect(item?.summary).toContain("trailing PE 36.08x");
    expect(item?.summary).toContain("dividend yield 0.36%");
  });

  test("summarizes negative-earnings P/E values as not meaningful", () => {
    const item = buildYahooFundamentals(
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-aapl",
          fundamentals: {
            trailingPE: -40,
            epsTrailingTwelveMonths: -2,
            forwardPE: -222.14,
            epsForward: -0.47,
          },
        }),
      ],
      "2026-06-22T00:00:00.000Z",
    );

    expect(item?.summary).toContain(`trailing PE ${PE_NOT_MEANINGFUL}`);
    expect(item?.summary).toContain(`forward PE ${PE_NOT_MEANINGFUL}`);
  });

  test("returns undefined when the ticker snapshot has no fundamentals (Massive fallback)", () => {
    const item = buildYahooFundamentals(
      command,
      [marketSnapshot({ sourceId: "market-yahoo-equity-aapl" })],
      "2026-06-22T00:00:00.000Z",
    );

    expect(item).toBeUndefined();
  });

  test("returns undefined when the ticker snapshot is absent", () => {
    const item = buildYahooFundamentals(command, [], "2026-06-22T00:00:00.000Z");
    expect(item).toBeUndefined();
  });

  test("returns undefined for non-equity commands", () => {
    const cryptoCommand = {
      jobType: "crypto",
      assetClass: "crypto",
      symbol: "BTC",
      depth: "deep",
    } as const;
    const item = buildYahooFundamentals(cryptoCommand, [], "2026-06-22T00:00:00.000Z");
    expect(item).toBeUndefined();
  });
});
