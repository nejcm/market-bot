import { expect, test } from "bun:test";
import { parseArgs, type InstrumentCommand } from "../src/cli/args";
import type { ExtendedEvidence } from "../src/domain/evidence";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import {
  financialLensParityDiffs,
  expectFinancialLensParity,
  type ParityInput,
} from "./support/financial-lens-parity";
import { marketSnapshot, verifiedMarketSnapshot } from "./support/fixtures";

const command: InstrumentCommand = (() => {
  const parsed = parseArgs(["equity", "AAPL", "--deep"]);
  if (parsed.jobType !== "equity") {
    throw new Error("not an equity command");
  }
  return parsed;
})();

const AS_OF = "2026-06-22T00:00:00.000Z";

function evidence(overrides: Record<string, number | string> = {}): ExtendedEvidence {
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
          financialLensSelectionVersion: 1,
          revenue: 100,
          revenuePeriodEnd: "2026-03-31",
          grossProfit: 42,
          grossProfitPeriodEnd: "2026-03-31",
          operatingIncome: 24,
          operatingIncomePeriodEnd: "2026-03-31",
          netIncome: 18,
          netIncomePeriodEnd: "2026-03-31",
          revenueDeltaPercent: 12,
          grossMarginSelectedValue: 0.42,
          grossMarginSelectedPeriodEnd: "2026-03-31",
          cash: 35,
          cashPeriodEnd: "2026-03-31",
          debt: 20,
          debtPeriodEnd: "2026-03-31",
          currentAssets: 80,
          currentAssetsPeriodEnd: "2026-03-31",
          currentLiabilities: 40,
          currentLiabilitiesPeriodEnd: "2026-03-31",
          currentRatioSelectedValue: 2,
          currentRatioSelectedPeriodEnd: "2026-03-31",
          debtToEquitySelectedValue: 0.4,
          debtToEquitySelectedPeriodEnd: "2026-03-31",
          netDebtSelectedValue: -15,
          netDebtSelectedPeriodEnd: "2026-03-31",
          payoutRatioSelectedValue: 0.25,
          payoutRatioSelectedPeriodEnd: "2026-03-31",
          ...overrides,
        },
      },
      {
        category: "valuation",
        title: "AAPL Valuation Evidence",
        summary: "Valuation Evidence.",
        sourceIds: ["market-yahoo-equity-aapl"],
        observedAt: "2026-06-21T00:00:00.000Z",
        metrics: {
          enterpriseValue: 985,
          annualizedRevenue: 400,
          evToAnnualizedRevenue: 2.46,
          marketCapToAnnualizedRevenue: 2.5,
          valuationSupportability: "supported",
          revenuePeriodEnd: "2026-03-31",
          revenuePeriodMonths: 3,
        },
      },
      {
        category: "yahoo-fundamentals",
        title: "AAPL Yahoo Fundamentals Evidence",
        summary: "Yahoo Fundamentals.",
        sourceIds: ["market-yahoo-equity-aapl"],
        observedAt: "2026-06-21T00:00:00.000Z",
        metrics: { trailingPE: 36.08, priceToBook: 41.05, dividendYield: 0.36 },
      },
    ],
    gaps: [],
  };
}

function lens(input: ExtendedEvidence, generatedAt = AS_OF) {
  const result = addFinancialLensEvidence(
    command,
    [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
    input,
    verifiedMarketSnapshot(),
    generatedAt,
  );
  const parity: ParityInput = {
    marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
    verifiedMarketSnapshot: verifiedMarketSnapshot(),
    ...(result.extendedEvidence !== undefined ? { extendedEvidence: result.extendedEvidence } : {}),
    ...(result.artifact !== undefined ? { financialLenses: result.artifact } : {}),
    ...(result.metricSections !== undefined ? { metricSections: result.metricSections } : {}),
  };
  return { result, parity };
}

function strengthMetric(result: ReturnType<typeof lens>["result"], id: string) {
  return result.metricSections
    ?.find((section) => section.id === "financial-lens-financial-strength")
    ?.metrics.find((metric) => metric.id === id);
}

test("the rebuilt lens keeps every legacy projection when only the SEC summary exists", () => {
  const { result, parity } = lens(evidence());

  expect(financialLensParityDiffs(command, parity).map(({ key }) => key)).toEqual([
    "lens.Financial Strength.netDebt.sourceIds",
  ]);
  expectFinancialLensParity("pre-statements", command, parity, [
    {
      fixture: "pre-statements",
      key: "lens.Financial Strength.netDebt.sourceIds",
      old: ["extended-sec-edgar-aapl-fundamentals", "market-yahoo-equity-aapl"],
      new: ["extended-sec-edgar-aapl-fundamentals"],
      class: "D7",
    },
  ]);
  expect(result.artifact?.lenses.map(({ name, posture }) => [name, posture])).toEqual([
    ["Quality", "criteria-supported"],
    ["Growth", "insufficient-data"],
    ["Financial Strength", "criteria-supported"],
    ["Value", "criteria-supported"],
    ["Momentum", "criteria-supported"],
  ]);
  expect(strengthMetric(result, "netDebt")).toMatchObject({ value: -15, periodEnd: "2026-03-31" });
  expect(strengthMetric(result, "payoutRatio")).toMatchObject({ value: 0.25 });
});

test("a stale summary balance sheet is withheld with a reason and a section gap", () => {
  const { result, parity } = lens(
    evidence({
      cashPeriodEnd: "2025-06-30",
      debtPeriodEnd: "2025-06-30",
      netDebtSelectedPeriodEnd: "2025-06-30",
      currentRatioSelectedPeriodEnd: "2025-06-30",
      debtToEquitySelectedPeriodEnd: "2025-06-30",
    }),
  );

  expect(strengthMetric(result, "netDebt")).toMatchObject({
    status: "missing",
    reason: "stale net debt as of 2025-06-30",
  });
  expect(strengthMetric(result, "currentRatio")).toMatchObject({
    status: "missing",
    reason: "stale current ratio as of 2025-06-30",
  });
  const strengthGap = result.metricSectionGaps?.find(
    ({ source }) => source === "financial-lens-financial-strength",
  );
  expect(strengthGap?.triage).toBe("material");
  expect(
    financialLensParityDiffs(command, parity)
      .map(({ key }) => key)
      .toSorted(),
  ).toEqual([
    "item.metrics.currentRatio",
    "item.metrics.currentRatioPeriodEnd",
    "item.metrics.netDebt",
    "item.metrics.netDebtPeriodEnd",
    "item.summary",
    "lens.Financial Strength.currentRatio",
    "lens.Financial Strength.netDebt",
    "lens.Financial Strength.order",
  ]);
});

test("the extended evidence item drops a withheld metric instead of guessing a value", () => {
  const { result } = lens(evidence({ netDebtSelectedPeriodEnd: "2025-06-30" }));
  const item = result.extendedEvidence?.items.find(({ category }) => category === "financial-lens");

  expect(item?.metrics?.netDebt).toBeUndefined();
  expect(item?.metrics?.netDebtPeriodEnd).toBeUndefined();
  expect(item?.metrics?.financialStrengthPosture).toBe("criteria-supported");
});

test("quote-only and disabled filed inputs emit neither lens sections nor their gaps", () => {
  for (const items of [[], evidence().items.filter((item) => item.category !== "sec-edgar")]) {
    const { result } = lens({ ...evidence(), items });
    expect(result.metricSections ?? []).toEqual([]);
    expect(result.metricSectionGaps).toBeUndefined();
  }
});
