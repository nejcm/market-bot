import { expect, test } from "bun:test";
import { metricSectionsView } from "../app/client/view-model-metric-sections";
import { financialLensSectionTiles } from "../app/client/view-model-lens";
import { renderMetricSections } from "../src/report/markdown-metric-sections";
import { metricPeriodLabel } from "../src/sources/extended-evidence/value-format";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import {
  evaluateMetricSection,
  statementInput,
} from "../src/sources/extended-evidence/metric-engine";
import { buildEvidencePayload } from "../src/research/prompts/evidence-payload";
import { config, contextWithHistory } from "./support/research-context-helpers";
import { collectedSources, marketSnapshot, researchReport } from "./support/fixtures";

const AS_OF = "2026-06-22T00:00:00.000Z";
const command = { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" } as const;
const statements = deriveFinancialStatements(
  {
    facts: {
      "us-gaap": {
        CashAndCashEquivalentsAtCarryingValue: {
          units: {
            USD: [
              { val: 60, end: "2026-03-31", filed: "2026-05-01", form: "10-Q", fy: 2026, fp: "Q1" },
            ],
          },
        },
        Revenues: {
          units: {
            USD: [
              {
                val: 100,
                start: "2025-01-01",
                end: "2025-12-31",
                filed: "2026-02-15",
                form: "10-K",
                fy: 2025,
                fp: "FY",
              },
            ],
          },
        },
        GrossProfit: {
          units: {
            USD: [
              {
                val: 40,
                start: "2025-01-01",
                end: "2025-12-31",
                filed: "2026-02-15",
                form: "10-K",
                fy: 2025,
                fp: "FY",
              },
            ],
          },
        },
      },
    },
  },
  { symbol: "AAPL", generatedAt: AS_OF, analysisAsOf: AS_OF, sourceId: "sec-aapl" },
);

function instantReport() {
  const fact = statements.statements.balanceSheet.cash.interim[0]!;
  const { section } = evaluateMetricSection(
    "test",
    "Balances",
    [
      {
        id: "cash",
        label: "Cash",
        unit: "currency",
        basis: "reported instant",
        compute: () => ({
          status: "value",
          value: fact.value,
          periodEnd: fact.periodEnd,
          inputs: [statementInput(fact, "cash", "cash")],
        }),
      },
    ],
    { symbol: "AAPL" },
  );
  return researchReport({ extras: { metricSections: [section] } });
}

test("markdown labels a balance-sheet instant as of its date", () => {
  expect(renderMetricSections(instantReport())).toContain("As of 2026-03-31");
  expect(renderMetricSections(instantReport())).not.toContain("FY ending");
});

test("period labels name the date of a provider observation timestamp", () => {
  expect(metricPeriodLabel("2026-10-16T16:25:17.700Z")).toBe("As of 2026-10-16");
  expect(metricPeriodLabel("2026-03-31")).toBe("As of 2026-03-31");
});

test("console labels a balance-sheet instant as of its date", () => {
  expect(
    metricSectionsView(instantReport() as unknown as Record<string, unknown>)?.[0]?.sourceLabel,
  ).toBe("sourced inputs");
  expect(
    metricSectionsView(instantReport() as unknown as Record<string, unknown>)?.[0]?.metrics[0]
      ?.period,
  ).toBe("As of 2026-03-31");
});

test("canonical SEC evidence reaches model payloads without selected metric flattening", () => {
  const evidence = withCanonicalFinancialLensInputs(undefined, statements);
  const payload = buildEvidencePayload(
    { includePriorCalibration: false, sourceGapView: "all", webSourceText: "metadata" },
    command,
    collectedSources({ extendedEvidence: evidence }),
    config,
    { ...contextWithHistory(command), analysisAsOf: AS_OF },
  );
  expect(evidence.items[0]?.metrics?.grossProfit).toBe(40);
  expect(JSON.stringify(payload)).not.toContain("Selected");
  expect(
    Object.keys(evidence.items[0]?.metrics ?? {}).some((key) =>
      /Selected|payoutRatioNonPositive/u.test(key),
    ),
  ).toBe(false);
});

test("derived gross profit discloses its formula in metric basis, markdown, and console", () => {
  const filed = { filed: "2026-02-15", form: "10-K", fy: 2025, fp: "FY", accn: "0001-26-000001" };
  const span = { start: "2025-01-01", end: "2025-12-31" };
  const derived = deriveFinancialStatements(
    {
      facts: {
        "us-gaap": {
          Revenues: { units: { USD: [{ val: 100, ...span, ...filed }] } },
          CostOfRevenue: { units: { USD: [{ val: 40, ...span, ...filed }] } },
        },
      },
    },
    { symbol: "AAPL", generatedAt: AS_OF, analysisAsOf: AS_OF, sourceId: "sec-aapl" },
  );
  const grossProfit = derived.statements.incomeStatement.grossProfit.annual[0]!;
  const revenue = derived.statements.incomeStatement.revenue.annual[0]!;
  const { section } = evaluateMetricSection(
    "financial-lens-quality",
    "Quality",
    [
      {
        id: "grossMargin",
        label: "Gross margin",
        unit: "ratio-percent",
        basis: "FY gross profit / revenue",
        compute: () => ({
          status: "value",
          value: grossProfit.value / revenue.value,
          periodEnd: grossProfit.periodEnd,
          inputs: [
            statementInput(grossProfit, "grossProfit", "gross profit"),
            statementInput(revenue, "revenue", "revenue"),
          ],
        }),
      },
    ],
    { symbol: "AAPL" },
  );
  const disclosure =
    "gross profit derived as Revenues − CostOfRevenue; tagged cost of revenue may exclude amortization or D&A";
  const report = researchReport({ extras: { metricSections: [section] } });

  expect(section.metrics[0]?.basis).toBe(`FY gross profit / revenue; ${disclosure}`);
  expect(renderMetricSections(report)).toContain(disclosure);
  expect(
    metricSectionsView(report as unknown as Record<string, unknown>)?.[0]?.metrics[0],
  ).toMatchObject({ basis: expect.stringContaining(disclosure) });
  expect(
    financialLensSectionTiles(report as unknown as Record<string, unknown>)[0]?.caption,
  ).toContain(disclosure);
});

function orclMarketLeverage(snapshot: boolean, quoteTimeUtc?: string) {
  const debt = {
    label: "debt",
    value: 125_337_000_000,
    artifact: "statements",
    series: "debt",
    periodType: "instant",
    periodEnd: "2026-08-31",
    unit: "USD",
    sourceIds: ["extended-sec-edgar-orcl-fundamentals"],
  } as const;
  const marketCap = {
    label: "market cap",
    value: 396_126_224_384,
    artifact: "quote",
    unit: "currency",
    sourceIds: ["market-yahoo-equity-orcl"],
  } as const;
  const { section } = evaluateMetricSection(
    "financial-lens-financial-strength",
    "Financial strength",
    [
      {
        id: "debtToMarketCap",
        label: "Debt/market cap",
        unit: "ratio-percent",
        basis: "debt / quote market cap",
        compute: () => ({
          status: "value",
          value: debt.value / marketCap.value,
          periodEnd: "2026-08-31",
          inputs: [marketCap, debt],
        }),
      },
      {
        id: "peRatio",
        label: "PE",
        unit: "ratio",
        basis: "Yahoo Finance trailing price/earnings",
        compute: () => ({
          status: "value",
          value: 20.48,
          periodEnd: "2026-11-01T09:33:28.645Z",
          inputs: [
            {
              label: "trailing PE",
              value: 20.48,
              artifact: "evidence",
              key: "trailingPE",
              unit: "ratio",
              sourceIds: ["market-yahoo-equity-orcl"],
            },
          ],
        }),
      },
      {
        id: "valuationSupportability",
        label: "Peer supportability",
        unit: "text",
        basis: "valuation evidence peer supportability",
        compute: () => ({
          status: "value",
          value: "supported",
          periodEnd: "2026-08-31",
          inputs: [
            {
              label: "valuation supportability",
              value: "supported",
              artifact: "evidence",
              key: "valuationSupportability",
              unit: "text",
              sourceIds: ["market-yahoo-equity-orcl", "extended-sec-edgar-orcl-fundamentals"],
            },
          ],
        }),
      },
    ],
    {
      symbol: "ORCL",
      ...(snapshot
        ? {
            snapshot: marketSnapshot({
              sourceId: "market-yahoo-equity-orcl",
              observedAt: "2026-11-01T09:33:28.645Z",
              ...(quoteTimeUtc === undefined ? {} : { quoteTimeUtc }),
            }),
          }
        : {}),
    },
  );
  return section;
}

test("a price-relative ratio names its quote date beside the fundamentals date (ORCL 2026-08-31 10-Q)", () => {
  const section = orclMarketLeverage(true, "2026-10-30T20:03:42.000Z");
  expect(section.metrics[0]?.priceAsOf).toBe("2026-10-30");
  const report = researchReport({ extras: { metricSections: [section] } });
  expect(renderMetricSections(report)).toContain(
    "Price as of 2026-10-30; fundamentals as of 2026-08-31",
  );
  expect(
    metricSectionsView(report as unknown as Record<string, unknown>)?.[0]?.metrics[0]?.period,
  ).toBe("Price as of 2026-10-30; fundamentals as of 2026-08-31");
});

test("a ratio without a quote snapshot keeps its fundamentals date only", () => {
  const section = orclMarketLeverage(false);
  expect(section.metrics[0]?.priceAsOf).toBeUndefined();
  expect(metricPeriodLabel("2026-05-31", undefined, undefined, [], "2026-10-30")).toBe(
    "Price as of 2026-10-30; fundamentals as of 2026-05-31",
  );
});

test("a price-relative ratio without a quote time labels the fetch date as fetch time", () => {
  expect(orclMarketLeverage(true).metrics[0]?.priceAsOf).toBe("2026-11-01 (fetch time)");
});

test("a valuation text metric that only cites the quote carries no price date", () => {
  const section = orclMarketLeverage(true, "2026-10-30T20:03:42.000Z");
  expect(section.metrics[2]?.priceAsOf).toBeUndefined();
});

test("a provider P/E observed at fetch time is labeled with the ORCL quote time", () => {
  const quoted = orclMarketLeverage(true, "2026-10-30T20:03:42.000Z").metrics[1]!;
  expect(metricPeriodLabel(quoted.periodEnd!, undefined, undefined, [], quoted.priceAsOf)).toBe(
    "Price as of 2026-10-30",
  );
  const fetched = orclMarketLeverage(true).metrics[1]!;
  expect(metricPeriodLabel(fetched.periodEnd!, undefined, undefined, [], fetched.priceAsOf)).toBe(
    "Price as of 2026-11-01 (fetch time)",
  );
});
