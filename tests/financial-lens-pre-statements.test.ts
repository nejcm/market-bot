import { expect, test } from "bun:test";
import { parseArgs, type InstrumentCommand } from "../src/cli/args";
import type { ExtendedEvidence } from "../src/domain/evidence";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import { UNTAGGED_EV_BRIDGE, marketSnapshot, verifiedMarketSnapshot } from "./support/fixtures";

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
          ...UNTAGGED_EV_BRIDGE,
          financialLensSelectionVersion: 1,
          revenue: 100,
          revenuePeriodEnd: "2026-03-31",
          grossProfit: 42,
          grossProfitPeriodEnd: "2026-03-31",
          operatingIncome: 24,
          operatingIncomePeriodEnd: "2026-03-31",
          netIncome: 18,
          dividendsPaid: 4.5,
          dividendsPaidPeriodEnd: "2026-03-31",
          stockholdersEquity: 50,
          stockholdersEquityPeriodEnd: "2026-03-31",
          netIncomePeriodEnd: "2026-03-31",
          revenueDeltaPercent: 12,
          cash: 35,
          cashPeriodEnd: "2026-03-31",
          debt: 20,
          debtPeriodEnd: "2026-03-31",
          currentAssets: 80,
          currentAssetsPeriodEnd: "2026-03-31",
          currentLiabilities: 40,
          currentLiabilitiesPeriodEnd: "2026-03-31",
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
  return { result };
}

function strengthMetric(result: ReturnType<typeof lens>["result"], id: string) {
  return result.metricSections
    ?.find((section) => section.id === "financial-lens-financial-strength")
    ?.metrics.find((metric) => metric.id === id);
}

test("the rebuilt lens keeps summary projections when only the SEC summary exists", () => {
  const { result } = lens(evidence());

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

test.each([
  ["freeCashFlowProxy", "operatingCashFlow", "capex", 20, 5, 15, "FCF proxy"],
  ["cashConversion", "operatingCashFlow", "netIncome", 20, 10, 2, "Cash conversion"],
  ["cashConversion", "operatingCashFlow", "continuingIncome", 20, 10, 2, "Cash conversion"],
  ["payoutRatio", "dividendsPaid", "netIncome", 5, 10, 0.5, "payout ratio"],
  ["currentRatio", "currentAssets", "currentLiabilities", 20, 10, 2, "current ratio"],
  ["debtToEquity", "debt", "stockholdersEquity", 20, 10, 2, "debt/equity"],
] as const)(
  "summary %s requires matching %s and %s periods",
  (id, left, right, a, b, value, label) => {
    const overrides = {
      [left]: a,
      [right]: b,
      [`${left}PeriodEnd`]: "2026-03-31",
      [`${right}PeriodEnd`]: "2026-03-31",
      ...(right === "continuingIncome" ? { operatingCashFlowScope: "continuing operations" } : {}),
    };
    const metric = (input: ExtendedEvidence) =>
      lens(input)
        .result.metricSections?.flatMap(({ metrics }) => metrics)
        .find((row) => row.id === id);
    expect(metric(evidence(overrides))).toMatchObject({ status: "value", value });
    for (const period of ["2025-12-31", undefined]) {
      const input = evidence({ ...overrides, [`${right}PeriodEnd`]: period ?? "2026-03-31" });
      if (period === undefined) {
        delete input.items[0]!.metrics![`${right}PeriodEnd`];
      }
      const { result } = lens(input);
      expect(
        result.metricSections?.flatMap(({ metrics }) => metrics).find((row) => row.id === id),
      ).toMatchObject({
        status: "missing",
        reason: `no same-period SEC ${label}`,
      });
      expect(
        result.metricSectionGaps?.some(
          ({ message, triage }) =>
            triage === "material" && message.includes(`no same-period SEC ${label}`),
        ),
      ).toBe(true);
      expect(
        result.extendedEvidence?.items.find(({ category }) => category === "financial-lens")
          ?.metrics?.[id],
      ).toBeUndefined();
    }
  },
);

test("a stale summary balance sheet is withheld with a reason and a section gap", () => {
  const { result } = lens(
    evidence({
      cashPeriodEnd: "2025-06-30",
      debtPeriodEnd: "2025-06-30",
      currentAssetsPeriodEnd: "2025-06-30",
      currentLiabilitiesPeriodEnd: "2025-06-30",
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
  const item = result.extendedEvidence?.items.find(({ category }) => category === "financial-lens");
  for (const id of ["netDebt", "currentRatio"]) {
    expect(item?.metrics?.[id]).toBeUndefined();
    expect(item?.metrics?.[`${id}PeriodEnd`]).toBeUndefined();
    expect(strengthGap?.message).toContain(id === "netDebt" ? "Net debt" : "Current ratio");
  }
});

test("the extended evidence item drops a withheld metric instead of guessing a value", () => {
  const { result } = lens(evidence({ debtPeriodEnd: "2025-06-30" }));
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
