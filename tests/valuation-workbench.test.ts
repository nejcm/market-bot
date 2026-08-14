import { describe, expect, test } from "bun:test";
import { violatesResearchOnly } from "../src/domain/research-language";
import { resolveMarketSnapshotPriceAsOf } from "../src/domain/types";
import type {
  FinancialStatementFact,
  FinancialStatementName,
  FinancialStatementSeries,
  FinancialStatementSeriesKey,
  FinancialStatementTtm,
  FinancialStatementsArtifact,
} from "../src/sources/extended-evidence/financial-statements-contract";
import {
  buildValuationWorkbench,
  collectValuationWorkbench,
} from "../src/sources/extended-evidence/valuation-workbench";
import {
  readValuationWorkbenchArtifact,
  type ValuationWorkbenchArtifact,
} from "../src/sources/extended-evidence/valuation-workbench-contract";
import { renderValuationWorkbenchMarkdown } from "../src/report/valuation-workbench-markdown";
import { reverseDcfWorkbench } from "./support/fixtures";

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
    periodKey: `${periodType}|${input.periodEnd}`,
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

  test("converts quote-currency prices into the reporting currency for multiples", async () => {
    const urls: string[] = [];
    const result = await collectValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: { ...statements(), reportingCurrency: "CAD" },
      priceHistory: [
        { date: "2024-02-15", close: 20 },
        { date: "2025-02-18", close: 24 },
        { date: "2025-05-01", close: 26 },
      ],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
      fetchImpl: async (input) => {
        urls.push(String(input));
        return Response.json({
          chart: {
            result: [
              {
                meta: { symbol: "USDCAD=X" },
                timestamp: [
                  Date.parse("2024-02-15T00:00:00.000Z") / 1000,
                  Date.parse("2025-02-17T00:00:00.000Z") / 1000,
                  Date.parse("2025-05-01T00:00:00.000Z") / 1000,
                ],
                indicators: { quote: [{ close: [1.35, 1.4, 1.42] }] },
              },
            ],
            error: null,
          },
        });
      },
    });
    const { artifact } = result;
    const observation = artifact.historicalMultiples.observations.find(
      (item) => item.periodEnd === "2024-12-31",
    );

    expect(urls).toHaveLength(1);
    expect({
      reportingCurrency: artifact.reportingCurrency,
      quoteCurrency: artifact.quoteCurrency,
    }).toEqual({ reportingCurrency: "CAD", quoteCurrency: "USD" });
    expect(observation?.price).toMatchObject({
      close: 24,
      currency: "USD",
      sessionDate: "2025-02-18",
    });
    expect(observation?.fxConversion).toEqual({
      rate: 1.4,
      rateDate: "2025-02-17",
      pair: "USDCAD=X",
      sourceId: "market-yahoo-fx-usdcad",
    });
    expect(observation?.metrics).toMatchObject({
      priceToEarnings: { status: "populated", display: "28.00x" },
      priceToSales: { status: "populated", display: "2.80x" },
      enterpriseValueToRevenue: { status: "populated", display: "2.84x" },
      priceToFreeCashFlow: { status: "populated", display: "28.00x" },
    });
    expect(observation?.metrics.priceToEarnings.sourceIds).toContain("market-yahoo-fx-usdcad");
    expect(renderValuationWorkbenchMarkdown(artifact)).toContain(
      "24.00 USD (2025-02-18; converted at USD/CAD 1.4000 on 2025-02-17)",
    );
    expect(result.sources).toEqual([
      expect.objectContaining({ id: "market-yahoo-fx-usdcad", provider: "yahoo" }),
    ]);
    expect(result.sourceGaps).toEqual([]);
    expect(readValuationWorkbenchArtifact(artifact)).toEqual(artifact);
  });

  test("reports a distinct reason and SourceGap when no FX rate is available", async () => {
    const result = await collectValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: { ...statements(), reportingCurrency: "CAD" },
      priceHistory: [{ date: "2025-02-18", close: 24 }],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
      fetchImpl: async () =>
        Response.json({
          chart: {
            result: null,
            error: { code: "Not Found", description: "No data found" },
          },
        }),
    });
    const observation = result.artifact.historicalMultiples.observations.find(
      (item) => item.periodEnd === "2024-12-31",
    );

    expect(observation?.fxConversion).toBeUndefined();
    expect(observation?.metrics).toMatchObject({
      priceToEarnings: { status: "suppressed", reason: "fx-rate-unavailable" },
      priceToSales: { status: "suppressed", reason: "fx-rate-unavailable" },
      enterpriseValueToRevenue: { status: "suppressed", reason: "fx-rate-unavailable" },
      priceToFreeCashFlow: { status: "suppressed", reason: "fx-rate-unavailable" },
    });
    expect(observation?.metrics.priceToEarnings).not.toMatchObject({
      reason: "quote-reporting-currency-mismatch",
    });
    expect(renderValuationWorkbenchMarkdown(result.artifact)).toContain("— (fx-rate-unavailable)");
    expect(result.sources).toEqual([]);
    expect(result.sourceGaps).toEqual([
      expect.objectContaining({
        source: "market-yahoo-fx-usdcad",
        message: "Yahoo FX close unavailable for USDCAD=X on or before 2025-02-18",
      }),
    ]);
  });

  test("leaves same-currency workbench output byte-identical", async () => {
    const input = {
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: statements(),
      priceHistory: [{ date: "2025-02-18", close: 24 }],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    } as const;
    let fetched = false;

    const result = await collectValuationWorkbench({
      ...input,
      fetchImpl: async () => {
        fetched = true;
        return Response.json({});
      },
    });

    expect(fetched).toBe(false);
    expect(JSON.stringify(result.artifact)).toBe(JSON.stringify(buildValuationWorkbench(input)));
    expect({ sources: result.sources, sourceGaps: result.sourceGaps }).toEqual({
      sources: [],
      sourceGaps: [],
    });
  });

  test("reads the retired currency-mismatch reason from pre-0008 artifacts", () => {
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: statements(),
      priceHistory: [],
      quoteCurrency: "USD",
    });
    const [first, ...rest] = artifact.historicalMultiples.observations;
    const legacyArtifact = {
      ...artifact,
      historicalMultiples: {
        ...artifact.historicalMultiples,
        observations: [
          {
            ...first!,
            metrics: {
              ...first!.metrics,
              priceToEarnings: {
                ...first!.metrics.priceToEarnings,
                reason: "quote-reporting-currency-mismatch",
              },
            },
          },
          ...rest,
        ],
      },
    };

    expect(readValuationWorkbenchArtifact(legacyArtifact)).not.toBeUndefined();
  });

  test("does not derive free cash flow across mismatched periods or units", () => {
    const input = statements();
    const latestCapex = input.statements.cashFlowStatement.capitalExpenditure.annual[1]!;
    const capexTtm = input.statements.cashFlowStatement.capitalExpenditure.ttm!;
    const mismatched = {
      ...input,
      statements: {
        ...input.statements,
        cashFlowStatement: {
          ...input.statements.cashFlowStatement,
          capitalExpenditure: {
            ...input.statements.cashFlowStatement.capitalExpenditure,
            annual: [
              input.statements.cashFlowStatement.capitalExpenditure.annual[0]!,
              { ...latestCapex, periodKey: "annual|2024-09-30" },
            ],
            ttm: { ...capexTtm, unit: "EUR" },
          },
        },
      },
    };

    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: mismatched,
      priceHistory: [
        { date: "2025-02-18", close: 24 },
        { date: "2025-05-01", close: 26 },
      ],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });

    for (const [basis, periodEnd] of [
      ["annual", "2024-12-31"],
      ["ttm", "2025-03-31"],
    ] as const) {
      expect(
        artifact.historicalMultiples.observations.find(
          (item) => item.basis === basis && item.periodEnd === periodEnd,
        )?.metrics.priceToFreeCashFlow,
      ).toMatchObject({ status: "suppressed", reason: "free-cash-flow-unavailable" });
    }
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

  test("renders public-date alignment, metrics, currencies, and peer suppression", () => {
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: statements(),
      priceHistory: [{ date: "2025-05-01", close: 26 }],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });

    const markdown = renderValuationWorkbenchMarkdown(artifact);

    expect(markdown).toContain("## Valuation Workbench");
    expect(markdown).toContain("first verified close within 7 calendar days on or after publicAt");
    expect(markdown).toContain("TTM | 2025-03-31 | 2025-05-01 | 26.00 USD (2025-05-01)");
    expect(markdown).not.toContain("converted at");
    expect(markdown).toContain("Reporting currency: USD. Quote currency: USD.");
    expect(markdown).toContain("Peer comparison data is unavailable for this run.");
    expect(violatesResearchOnly(markdown)).toBeNull();
    expect(readValuationWorkbenchArtifact(artifact)).toEqual(artifact);
  });

  test("omits a suppressed trailing-basis disclosure from markdown", () => {
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: withoutTtm(statements()),
      priceHistory: [{ date: "2025-05-01", close: 26 }],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });

    expect(artifact.historicalMultiples.trailingBasis.status).toBe("suppressed");
    expect(renderValuationWorkbenchMarkdown(artifact)).not.toContain("Trailing basis suppressed");
  });

  test("labels a provider quote timestamp as quote time", () => {
    const base = reverseDcfWorkbench();
    if (base.peerComparison.status !== "available") {
      throw new Error("valuation workbench fixture peer comparison missing");
    }
    const priceAsOf = resolveMarketSnapshotPriceAsOf({
      observedAt: "2026-05-19T14:31:00.000Z",
      quoteTimeUtc: "2026-05-19T14:29:07.000Z",
    });
    const artifact: ValuationWorkbenchArtifact = {
      ...base,
      peerComparison: {
        ...base.peerComparison,
        valuationComps: {
          ...base.peerComparison.valuationComps,
          target: { ...base.peerComparison.valuationComps.target, priceAsOf },
        },
      },
    };

    const markdown = renderValuationWorkbenchMarkdown(artifact);

    expect(markdown).toContain("quote time 2026-05-19T14:29:07.000Z");
    expect(markdown).not.toContain("quote time 2026-05-19T14:31:00.000Z");
  });

  test("labels a price without a quote timestamp as fetch time only", () => {
    const base = reverseDcfWorkbench();
    if (base.peerComparison.status !== "available") {
      throw new Error("valuation workbench fixture peer comparison missing");
    }
    const priceAsOf = resolveMarketSnapshotPriceAsOf({
      observedAt: "2026-05-19T14:31:00.000Z",
    });
    const artifact: ValuationWorkbenchArtifact = {
      ...base,
      peerComparison: {
        ...base.peerComparison,
        valuationComps: {
          ...base.peerComparison.valuationComps,
          target: { ...base.peerComparison.valuationComps.target, priceAsOf },
        },
      },
    };

    const markdown = renderValuationWorkbenchMarkdown(artifact);

    expect(markdown).toContain("fetch time 2026-05-19T14:31:00.000Z");
    expect(markdown).not.toContain("quote time 2026-05-19T14:31:00.000Z");
  });

  test("rejects an unproved not-applicable metric on read", () => {
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: statements(),
      priceHistory: [{ date: "2024-02-15", close: 20 }],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });
    const [first, ...rest] = artifact.historicalMultiples.observations;
    const malformed = {
      ...artifact,
      historicalMultiples: {
        ...artifact.historicalMultiples,
        observations: [
          {
            ...first!,
            metrics: {
              ...first!.metrics,
              priceToEarnings: {
                status: "not-applicable",
                display: "not applicable",
                rule: "fixture rule",
                inputs: { basis: "fixture" },
                rationale: "fixture rationale",
                sourceIds: [],
              },
            },
          },
          ...rest,
        ],
      },
    } as ValuationWorkbenchArtifact;

    expect(readValuationWorkbenchArtifact(malformed)).toBeUndefined();
  });
});
