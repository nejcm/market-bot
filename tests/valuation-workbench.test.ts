import { describe, expect, test } from "bun:test";
import type {
  FinancialStatementFact,
  FinancialStatementName,
  FinancialStatementSeries,
  FinancialStatementSeriesKey,
  FinancialStatementTtm,
  FinancialStatementsArtifact,
} from "../src/sources/extended-evidence/financial-statements-contract";
import { buildValuationWorkbench } from "../src/sources/extended-evidence/valuation-workbench";

const SOURCE_ID = "extended-sec-edgar-test-fundamentals";

function fact(input: {
  readonly key: FinancialStatementSeriesKey;
  readonly value: number;
  readonly periodEnd: string;
  readonly filedAt: string;
  readonly periodType?: "annual" | "interim";
  readonly unit?: string;
  readonly currency?: string | null;
}): FinancialStatementFact {
  const periodType = input.periodType ?? "annual";
  return {
    value: input.value,
    periodKey: `${periodType}|${input.periodEnd}|${input.key}`,
    periodType,
    form: periodType === "annual" ? "10-K" : "10-Q",
    canonicalForm: periodType === "annual" ? "10-K" : "10-Q",
    amendment: false,
    accessionNumber: `${input.periodEnd}-${input.key}`,
    filedAt: input.filedAt,
    periodStart: `${String(Number(input.periodEnd.slice(0, 4)) - 1)}-01-01`,
    periodEnd: input.periodEnd,
    fiscalYear: Number(input.periodEnd.slice(0, 4)),
    fiscalPeriod: periodType === "annual" ? "FY" : "Q1",
    taxonomy: "us-gaap",
    concept: input.key,
    currency: input.currency === undefined ? "USD" : input.currency,
    unit: input.unit ?? "USD",
    unitScale: 1,
    extractionMethod: "sec-companyfacts",
    sourceIds: [SOURCE_ID],
  };
}

function ttm(
  key: FinancialStatementSeriesKey,
  value: number,
  filedAt = "2025-05-01",
  unit = "USD",
): FinancialStatementTtm {
  const fiscalYear = fact({
    key,
    value: value - 10,
    periodEnd: "2024-12-31",
    filedAt: "2025-02-15",
    unit,
  });
  const latestYearToDate = fact({
    key,
    value: 20,
    periodEnd: "2025-03-31",
    filedAt,
    periodType: "interim",
    unit,
  });
  const priorYearToDate = fact({
    key,
    value: 10,
    periodEnd: "2024-03-31",
    filedAt: "2024-05-01",
    periodType: "interim",
    unit,
  });
  return {
    value,
    periodStart: "2024-04-01",
    periodEnd: "2025-03-31",
    currency: "USD",
    unit,
    unitScale: 1,
    extractionMethod: "derived-sec-companyfacts",
    formula: "FY + latest-YTD - prior-YTD",
    sourceIds: [SOURCE_ID],
    components: { fiscalYear, latestYearToDate, priorYearToDate },
  };
}

function series(
  key: FinancialStatementSeriesKey,
  statement: FinancialStatementName,
  annualValues: readonly number[] = [],
  ttmValue?: number,
  unit = "USD",
): FinancialStatementSeries {
  const periodEnds = ["2023-12-31", "2024-12-31"];
  const annual = annualValues.map((value, index) =>
    fact({
      key,
      value,
      periodEnd: periodEnds[index]!,
      filedAt: index === 0 ? "2024-02-15" : "2025-02-15",
      unit,
      ...(unit === "shares" ? { currency: null } : {}),
    }),
  );
  return {
    key,
    label: key,
    statement,
    annual,
    interim: [],
    ...(ttmValue === undefined ? {} : { ttm: ttm(key, ttmValue, "2025-05-01", unit) }),
  };
}

function statements(): FinancialStatementsArtifact {
  return {
    version: 1,
    generatedAt: "2025-06-01T00:00:00.000Z",
    analysisAsOf: "2025-06-01T00:00:00.000Z",
    symbol: "TEST",
    sourceId: SOURCE_ID,
    taxonomy: "us-gaap",
    reportingCurrency: "USD",
    interimCadence: "quarterly",
    extractionMethod: "sec-companyfacts",
    statements: {
      incomeStatement: {
        revenue: series("revenue", "incomeStatement", [100, 120], 130),
        grossProfit: series("grossProfit", "incomeStatement"),
        operatingIncome: series("operatingIncome", "incomeStatement"),
        netIncome: series("netIncome", "incomeStatement", [10, 12], 13),
      },
      balanceSheet: {
        cash: series("cash", "balanceSheet", [5, 6]),
        currentAssets: series("currentAssets", "balanceSheet"),
        currentLiabilities: series("currentLiabilities", "balanceSheet"),
        totalAssets: series("totalAssets", "balanceSheet"),
        totalLiabilities: series("totalLiabilities", "balanceSheet"),
        stockholdersEquity: series("stockholdersEquity", "balanceSheet"),
        debt: series("debt", "balanceSheet", [10, 11]),
      },
      cashFlowStatement: {
        operatingCashFlow: series("operatingCashFlow", "cashFlowStatement", [15, 18], 20),
        capitalExpenditure: series("capitalExpenditure", "cashFlowStatement", [5, 6], 7),
        dividendsPaid: series("dividendsPaid", "cashFlowStatement"),
        shareRepurchases: series("shareRepurchases", "cashFlowStatement"),
      },
      perShare: {
        dilutedEps: series("dilutedEps", "perShare", [1, 1.2], 1.3, "USD/shares"),
        dilutedShares: series("dilutedShares", "perShare", [10, 10], undefined, "shares"),
      },
    },
    validationNotes: [],
    omissionNotes: [],
    structuredFinancialGaps: [],
    shadowParity: {
      version: 1,
      status: "matched",
      matchedCount: 0,
      explainedCount: 0,
      unexplainedCount: 0,
      comparisons: [],
    },
  };
}

function stripTtm(value: FinancialStatementSeries): FinancialStatementSeries {
  const { ttm: _ttm, ...rest } = value;
  return rest;
}

function withoutTtm(artifact: FinancialStatementsArtifact): FinancialStatementsArtifact {
  return {
    ...artifact,
    statements: {
      ...artifact.statements,
      incomeStatement: {
        ...artifact.statements.incomeStatement,
        revenue: stripTtm(artifact.statements.incomeStatement.revenue),
        netIncome: stripTtm(artifact.statements.incomeStatement.netIncome),
      },
      cashFlowStatement: {
        ...artifact.statements.cashFlowStatement,
        operatingCashFlow: stripTtm(artifact.statements.cashFlowStatement.operatingCashFlow),
        capitalExpenditure: stripTtm(artifact.statements.cashFlowStatement.capitalExpenditure),
      },
      perShare: {
        ...artifact.statements.perShare,
        dilutedEps: stripTtm(artifact.statements.perShare.dilutedEps),
      },
    },
  };
}

describe("valuation workbench", () => {
  test("aligns each historical multiple to the first close on or after publication", () => {
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: statements(),
      priceHistory: [
        { date: "2024-02-14", close: 19 },
        { date: "2024-02-15", close: 20 },
        { date: "2025-02-14", close: 23 },
        { date: "2025-02-18", close: 24 },
        { date: "2025-05-01", close: 26 },
      ],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });

    expect(
      artifact.historicalMultiples.observations.map(({ basis, periodEnd, publicAt, price }) => ({
        basis,
        periodEnd,
        publicAt,
        priceDate: price?.sessionDate,
      })),
    ).toEqual([
      {
        basis: "annual",
        periodEnd: "2023-12-31",
        publicAt: "2024-02-15",
        priceDate: "2024-02-15",
      },
      {
        basis: "annual",
        periodEnd: "2024-12-31",
        publicAt: "2025-02-15",
        priceDate: "2025-02-18",
      },
      {
        basis: "ttm",
        periodEnd: "2025-03-31",
        publicAt: "2025-05-01",
        priceDate: "2025-05-01",
      },
    ]);
    expect(
      artifact.historicalMultiples.observations.every(
        (item) => item.price === null || item.price.sessionDate >= item.publicAt,
      ),
    ).toBe(true);
    expect(artifact.historicalMultiples.observations[0]?.metrics).toMatchObject({
      priceToEarnings: { status: "populated", value: 20 },
      priceToSales: { status: "populated", value: 2 },
      enterpriseValueToRevenue: { status: "populated", value: 2.05 },
      priceToFreeCashFlow: { status: "populated", value: 20 },
    });
  });

  test("uses N/M for negative denominators", () => {
    const input = statements();
    const latest = input.statements.incomeStatement.netIncome.annual[1]!;
    const latestEps = input.statements.perShare.dilutedEps.annual[1]!;
    const latestOperatingCashFlow = input.statements.cashFlowStatement.operatingCashFlow.annual[1]!;
    const negative = {
      ...input,
      statements: {
        ...input.statements,
        incomeStatement: {
          ...input.statements.incomeStatement,
          netIncome: {
            ...input.statements.incomeStatement.netIncome,
            annual: [
              input.statements.incomeStatement.netIncome.annual[0]!,
              { ...latest, value: -12 },
            ],
          },
        },
        cashFlowStatement: {
          ...input.statements.cashFlowStatement,
          operatingCashFlow: {
            ...input.statements.cashFlowStatement.operatingCashFlow,
            annual: [
              input.statements.cashFlowStatement.operatingCashFlow.annual[0]!,
              { ...latestOperatingCashFlow, value: 2 },
            ],
          },
        },
        perShare: {
          ...input.statements.perShare,
          dilutedEps: {
            ...input.statements.perShare.dilutedEps,
            annual: [
              input.statements.perShare.dilutedEps.annual[0]!,
              { ...latestEps, value: -1.2 },
            ],
          },
        },
      },
    };

    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: negative,
      priceHistory: [{ date: "2025-02-18", close: 24 }],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });
    const observation = artifact.historicalMultiples.observations.find(
      (item) => item.periodEnd === "2024-12-31",
    );

    expect(observation?.metrics.priceToEarnings).toMatchObject({
      status: "not-meaningful",
      display: "N/M",
      reason: "negative-denominator",
    });
    expect(observation?.metrics.priceToFreeCashFlow).toMatchObject({
      status: "not-meaningful",
      display: "N/M",
      reason: "negative-denominator",
    });
  });

  test("suppresses trailing multiples instead of combining retained quarters", () => {
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: withoutTtm(statements()),
      priceHistory: [{ date: "2025-02-18", close: 24 }],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });

    expect(artifact.historicalMultiples.trailingBasis).toEqual({
      status: "suppressed",
      reason: "canonical-ttm-unavailable",
      detail:
        "Canonical reconciled TTM is unavailable; retained quarter-only periods are not combined into an unreconciled TTM.",
      sourceIds: [SOURCE_ID],
    });
    expect(artifact.historicalMultiples.observations.some((item) => item.basis === "ttm")).toBe(
      false,
    );
  });

  test("records honest price and peer suppression without not-applicable claims", () => {
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: statements(),
      priceHistory: [],
      quoteCurrency: "USD",
    });

    expect(artifact.peerComparison).toMatchObject({
      status: "suppressed",
      reason: "peer-data-unavailable",
    });
    expect(
      artifact.historicalMultiples.observations.flatMap((item) =>
        Object.values(item.metrics).map((metric) => metric.status),
      ),
    ).not.toContain("not-applicable");
    expect(artifact.historicalMultiples.observations[0]?.metrics.priceToSales).toMatchObject({
      status: "suppressed",
      reason: "price-history-unavailable",
    });
  });
});
