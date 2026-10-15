import { describe, expect, test } from "bun:test";
import { violatesResearchOnly } from "../src/domain/research-language";
import { resolveMarketSnapshotPriceAsOf } from "../src/domain/market-data";
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
import { renderMarkdownReport } from "../src/report/markdown";
import { researchReport, reverseDcfWorkbench } from "./support/fixtures";

const SOURCE_ID = "extended-sec-edgar-test-fundamentals";

function fact(input: {
  readonly key: FinancialStatementSeriesKey;
  readonly value: number;
  readonly periodEnd: string;
  readonly filedAt: string;
  readonly firstPublicAt?: string;
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
    firstPublicAt: input.firstPublicAt ?? input.filedAt,
    periodStart: `${input.periodEnd.slice(0, 4)}-01-01`,
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
        consolidatedNetIncome: series("consolidatedNetIncome", "incomeStatement"),
        continuingIncome: series("continuingIncome", "incomeStatement"),
        interestExpense: series("interestExpense", "incomeStatement"),
        incomeTaxExpense: series("incomeTaxExpense", "incomeStatement"),
        pretaxIncome: series("pretaxIncome", "incomeStatement"),
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
        depreciationAndAmortization: series("depreciationAndAmortization", "cashFlowStatement"),
        dividendsPaid: series("dividendsPaid", "cashFlowStatement"),
        shareRepurchases: series("shareRepurchases", "cashFlowStatement"),
      },
      perShare: {
        dilutedEps: series("dilutedEps", "perShare", [1, 1.2], 1.3, "USD/shares"),
        continuingDilutedEps: series("continuingDilutedEps", "perShare"),
        dilutedShares: series("dilutedShares", "perShare", [10, 10], undefined, "shares"),
        dividendsPerShare: series("dividendsPerShare", "perShare"),
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

function refile(item: FinancialStatementFact): FinancialStatementFact {
  return { ...item, filedAt: "2025-05-20" };
}

function refiledWithUnchangedValues(
  artifact: FinancialStatementsArtifact,
): FinancialStatementsArtifact {
  const refileSeries = (item: FinancialStatementSeries): FinancialStatementSeries => ({
    ...item,
    annual: item.annual.map(refile),
    interim: item.interim.map(refile),
    ...(item.ttm === undefined
      ? {}
      : {
          ttm: {
            ...item.ttm,
            components: {
              fiscalYear: refile(item.ttm.components.fiscalYear),
              latestYearToDate: refile(item.ttm.components.latestYearToDate),
              priorYearToDate: refile(item.ttm.components.priorYearToDate),
            },
          },
        }),
  });
  const refileGroup = <T extends Readonly<Record<string, FinancialStatementSeries>>>(group: T) =>
    Object.fromEntries(
      Object.entries(group).map(([key, item]) => [key, refileSeries(item)]),
    ) as unknown as T;
  const { incomeStatement, balanceSheet, cashFlowStatement, perShare } = artifact.statements;
  return {
    ...artifact,
    statements: {
      incomeStatement: refileGroup(incomeStatement),
      balanceSheet: refileGroup(balanceSheet),
      cashFlowStatement: refileGroup(cashFlowStatement),
      perShare: refileGroup(perShare),
    },
  };
}

describe("valuation workbench", () => {
  test("dates rows and balance-sheet joins to the first filing of each selected value", () => {
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: refiledWithUnchangedValues(statements()),
      priceHistory: [
        { date: "2024-02-15", close: 20 },
        { date: "2025-02-18", close: 24 },
        { date: "2025-05-01", close: 26 },
        { date: "2025-05-20", close: 30 },
      ],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });

    expect(
      artifact.historicalMultiples.observations.map(({ basis, publicAt }) => ({ basis, publicAt })),
    ).toEqual([
      { basis: "annual", publicAt: "2024-02-15" },
      { basis: "annual", publicAt: "2025-02-15" },
      { basis: "ttm", publicAt: "2025-05-01" },
    ]);
    expect(artifact.historicalMultiples.observations[0]?.metrics).toMatchObject({
      enterpriseValueToRevenue: { status: "value", value: 2.05 },
    });
  });

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
      priceToEarnings: { status: "value", value: 20 },
      priceToSales: { status: "value", value: 2 },
      enterpriseValueToRevenue: { status: "value", value: 2.05 },
      priceToFreeCashFlow: { status: "value", value: 20 },
    });
  });

  test("converts quote-currency prices into the reporting currency for multiples", async () => {
    const urls: string[] = [];
    const result = await collectValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: JSON.parse(
        JSON.stringify({ ...statements(), reportingCurrency: "CAD" }, (key, value: unknown) =>
          (key === "currency" || key === "unit") && typeof value === "string"
            ? value.replace("USD", "CAD")
            : value,
        ),
      ) as FinancialStatementsArtifact,
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
    for (const [key, expected] of Object.entries({
      priceToEarnings: 28,
      priceToSales: 2.8,
      enterpriseValueToRevenue: 2.841_666_666_666_666_3,
      priceToFreeCashFlow: 28,
    })) {
      const metric = observation!.metrics[key as keyof NonNullable<typeof observation>["metrics"]];
      expect(metric.status).toBe("value");
      expect(metric.value).toBeCloseTo(expected, 10);
    }
    expect(observation?.metrics.priceToEarnings.sourceIds).toContain("market-yahoo-fx-usdcad");
    expect(renderValuationWorkbenchMarkdown(artifact, researchReport())).toContain(
      "24.00 USD (2025-02-18; converted at USD/CAD 1.4000 on 2025-02-17)",
    );
    expect(result.sources).toEqual([
      expect.objectContaining({ id: "market-yahoo-fx-usdcad", provider: "yahoo" }),
    ]);
    expect(result.sourceGaps.every((gap) => gap.source.startsWith("valuation-workbench-"))).toBe(
      true,
    );
    expect(readValuationWorkbenchArtifact(artifact)).toEqual({
      ...artifact,
      readDiagnostics: { droppedObservationCount: 0, drops: [] },
    });
  });

  test("reports a distinct reason and SourceGap when no FX rate is available", async () => {
    const result = await collectValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: JSON.parse(
        JSON.stringify({ ...statements(), reportingCurrency: "CAD" }, (key, value: unknown) =>
          (key === "currency" || key === "unit") && typeof value === "string"
            ? value.replace("USD", "CAD")
            : value,
        ),
      ) as FinancialStatementsArtifact,
      priceHistory: [{ date: "2025-02-18", close: 24 }],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
      fetchImpl: async () =>
        Response.json({
          chart: {
            result: null,
            error: { code: "Not Found", description: "No data found, symbol may be delisted" },
          },
        }),
    });
    const observation = result.artifact.historicalMultiples.observations.find(
      (item) => item.periodEnd === "2024-12-31",
    );

    expect(observation?.fxConversion).toBeUndefined();
    expect(observation?.metrics).toMatchObject({
      priceToEarnings: { status: "missing", reason: "fx-rate-unavailable" },
      priceToSales: { status: "missing", reason: "fx-rate-unavailable" },
      enterpriseValueToRevenue: { status: "missing", reason: "fx-rate-unavailable" },
      priceToFreeCashFlow: { status: "missing", reason: "fx-rate-unavailable" },
    });
    expect(observation?.metrics.priceToEarnings).not.toMatchObject({
      reason: "quote-reporting-currency-mismatch",
    });
    expect(renderValuationWorkbenchMarkdown(result.artifact, researchReport())).toContain(
      "— (fx-rate-unavailable)",
    );
    expect(result.sources).toEqual([]);
    expect(result.sourceGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "market-yahoo-fx-usdcad",
          message: "Yahoo FX close unavailable for USDCAD=X on or before 2025-02-18",
        }),
      ]),
    );
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
    expect(result.sources).toEqual([]);
    expect(result.sourceGaps.every((gap) => gap.source.startsWith("valuation-workbench-"))).toBe(
      true,
    );
  });

  test("declares EV/revenue inapplicable for a depository issuer while leaving other multiples computed", () => {
    const input = {
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: statements(),
      priceHistory: [
        { date: "2024-02-15", close: 20 },
        { date: "2025-02-18", close: 24 },
        { date: "2025-05-01", close: 26 },
      ],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    };
    const industrial = buildValuationWorkbench(input);
    const depository = buildValuationWorkbench({
      ...input,
      extendedEvidence: {
        items: [
          {
            category: "sec-edgar",
            title: "TEST fundamentals",
            summary: "",
            sourceIds: [SOURCE_ID],
            observedAt: "2025-06-01T00:00:00.000Z",
            metrics: { sic: "6022", sicDescription: "State Commercial Banks" },
          },
        ],
        gaps: [],
      },
    });

    // Every EV input is present here — the industrial run computes a real multiple — so the
    // Depository verdict must override a computable number, not merely a missing one.
    expect(
      industrial.historicalMultiples.observations[0]?.metrics.enterpriseValueToRevenue,
    ).toMatchObject({ status: "value", value: 2.05 });
    expect(
      depository.historicalMultiples.observations.map(
        (item) => item.metrics.enterpriseValueToRevenue,
      ),
    ).toMatchObject(
      depository.historicalMultiples.observations.map(() => ({
        status: "not-applicable",
        inputs: [],
        sourceIds: [],
        reason: "deposit-funded issuer; enterprise value is not defined (SIC 6022)",
      })),
    );
    // No EV cell renders a number, on any rendered row.
    const evCells = renderValuationWorkbenchMarkdown(depository, researchReport())
      .split("\n")
      .filter((line) => line.startsWith("ANNUAL |") || line.startsWith("TTM |"))
      .map((line) => line.split(" | ")[6]);
    expect(evCells.length).toBeGreaterThan(0);
    expect(evCells).toEqual(
      evCells.map(() => "not applicable (deposit-funded issuer; enterprise value is not defined)"),
    );
    // P/FCF follows the same capex verdict Financial Trends gives, so it must NOT stay computed.
    expect(
      industrial.historicalMultiples.observations[0]?.metrics.priceToFreeCashFlow,
    ).toMatchObject({ status: "value" });
    expect(
      depository.historicalMultiples.observations.map(
        (item) => item.metrics.priceToFreeCashFlow.status,
      ),
    ).toEqual(depository.historicalMultiples.observations.map(() => "not-applicable"));
    expect(
      depository.historicalMultiples.observations[0]?.metrics.priceToFreeCashFlow,
    ).toMatchObject({
      reason: "depository issuer; capex-based free cash flow is not defined (SIC 6022)",
    });
    // Only the price-based multiples are untouched.
    for (const key of ["priceToEarnings", "priceToSales"] as const) {
      expect(depository.historicalMultiples.observations.map((item) => item.metrics[key])).toEqual(
        industrial.historicalMultiples.observations.map((item) => item.metrics[key]),
      );
    }
    // The EV-based peer comparison is inapplicable, not "unavailable".
    expect(depository.peerComparison).toMatchObject({
      status: "suppressed",
      reason: "enterprise-value-not-applicable",
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
      ).toMatchObject({ status: "missing", reason: "free-cash-flow-unavailable" });
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
      reason: "negative-denominator",
    });
    expect(observation?.metrics.priceToFreeCashFlow).toMatchObject({
      status: "not-meaningful",
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
      status: "missing",
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

    const markdown = renderValuationWorkbenchMarkdown(
      artifact,
      researchReport({
        sources: [SOURCE_ID, "verified-snapshot-TEST"].map((id) => ({
          id,
          title: id,
          kind: "extended-evidence",
          fetchedAt: artifact.generatedAt,
        })),
      }),
    );

    expect(markdown).toContain("## Valuation Workbench");
    expect(markdown).toContain("first verified close within 7 calendar days on or after publicAt");
    expect(markdown).toContain("TTM | 2025-03-31 | 2025-05-01 | 26.00 USD (2025-05-01)");
    expect(markdown).not.toContain("converted at");
    expect(markdown).toContain("Reporting currency: USD. Quote currency: USD.");
    expect(markdown).toContain("Peer comparison data is unavailable for this run.");
    expect(markdown).toContain("| P/FCF proxy | Sources");
    expect(markdown).toContain(`| 20.00x | [${SOURCE_ID}] [verified-snapshot-TEST]`);
    expect(violatesResearchOnly(markdown)).toBeNull();
    expect(readValuationWorkbenchArtifact(artifact)).toEqual({
      ...artifact,
      readDiagnostics: { droppedObservationCount: 0, drops: [] },
    });
  });

  test("collapses periods without price history into one line, keeping the rows in the artifact", () => {
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: statements(),
      priceHistory: [{ date: "2025-05-01", close: 26 }],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });

    const unpriced = artifact.historicalMultiples.observations.filter(
      (item) => item.price === null,
    );
    const markdown = renderValuationWorkbenchMarkdown(artifact, researchReport());

    expect(unpriced.length).toBeGreaterThan(0);
    expect(markdown).toContain(
      `${String(unpriced.length)} periods without price history: ${unpriced
        .map((item) => `${item.basis.toUpperCase()} ${item.periodEnd}`)
        .join(", ")}.`,
    );
    expect(markdown).toContain("TTM | 2025-03-31 | 2025-05-01 | 26.00 USD (2025-05-01)");
    expect(markdown).not.toMatch(/^ANNUAL \| /mu);
    expect(artifact.historicalMultiples.observations.some((item) => item.price === null)).toBe(
      true,
    );
  });

  test("renders only the collapsed line when every period lacks price history", () => {
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: statements(),
      priceHistory: [],
      quoteCurrency: "USD",
    });

    const markdown = renderValuationWorkbenchMarkdown(artifact, researchReport());

    expect(markdown).toContain(
      `${String(artifact.historicalMultiples.observations.length)} periods without price history:`,
    );
    expect(markdown).not.toContain("First eligible close");
    expect(markdown).not.toContain("no historical basis available");
  });

  test("keeps rows when the quote currency is missing instead of claiming no price history", () => {
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: statements(),
      priceHistory: [
        { date: "2024-02-15", close: 20 },
        { date: "2025-02-18", close: 24 },
        { date: "2025-05-01", close: 26 },
      ],
      priceSourceId: "verified-snapshot-TEST",
    });

    const markdown = renderValuationWorkbenchMarkdown(artifact, researchReport());

    expect(markdown).not.toContain("periods without price history");
    expect(markdown).toContain("— (quote-currency-unavailable)");
    expect(artifact.historicalMultiples.observations.every((item) => item.price === null)).toBe(
      true,
    );
  });

  test("marks a gross-principal debt basis in the peer table only on that row", () => {
    const base = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: statements(),
      priceHistory: [{ date: "2025-05-01", close: 26 }],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });
    const target = {
      symbol: "TEST",
      cashPeriodEnd: "2025-03-31",
      debtPeriodEnd: "2025-03-31",
      sourceIds: ["sec-TEST"],
      usable: true,
    };

    const markdown = renderValuationWorkbenchMarkdown(
      {
        ...base,
        peerComparison: {
          status: "available",
          valuationComps: {
            version: 1,
            generatedAt: "2025-06-01T00:00:00.000Z",
            target,
            peers: [{ ...target, symbol: "PEER", debtBasis: "gross-principal" }],
            excludedPeers: [],
            peerUniverseSourceIds: [],
            summary: {
              corePeerCount: 1,
              secondaryPeerCount: 0,
              usablePeerCount: 1,
              valuationSupportability: "screening-only",
            },
            sourceIds: [],
            freshnessFlags: {
              targetQuoteFresh: true,
              targetSecFresh: true,
              peerQuoteFresh: true,
              peerSecFresh: true,
            },
          },
        },
      },
      researchReport(),
    );

    expect(markdown).toContain("cash 2025-03-31; debt 2025-03-31 (gross principal)");
    expect(markdown.match(/\(gross principal\)/gu)).toHaveLength(1);
    expect(violatesResearchOnly(markdown)).toBeNull();
  });

  test("cites resolvable peer-row sources and closes every rendered reference in Sources", () => {
    const base = reverseDcfWorkbench();
    if (base.peerComparison.status !== "available") {
      throw new Error("valuation workbench fixture peer comparison missing");
    }
    const { valuationComps } = base.peerComparison;
    const json = JSON.stringify({
      ...base,
      peerComparison: {
        ...base.peerComparison,
        valuationComps: {
          ...valuationComps,
          target: { ...valuationComps.target, sourceIds: ["market-test", "sec-test"] },
          peers: [
            { symbol: "USE", sourceIds: ["market-use"], usable: true },
            { symbol: "EXC", sourceIds: ["sec-exc", "missing-row-source"], usable: false },
            { symbol: "NONE", sourceIds: [], usable: false },
            { symbol: "BAD", usable: false },
          ],
        },
      },
    });
    const persisted: unknown = JSON.parse(json);
    const workbench = readValuationWorkbenchArtifact(persisted);
    if (workbench === undefined) {
      throw new Error("persisted workbench did not read back");
    }
    const report = researchReport({
      jobType: "equity",
      assetClass: "equity",
      symbol: "TEST",
      sources: ["market-test", "sec-test", "market-use", "sec-exc"].map((id) => ({
        id,
        title: id,
        fetchedAt: "2025-06-01T00:00:00.000Z",
        kind: "market-data" as const,
      })),
    });

    const markdown = renderMarkdownReport(report, undefined, { valuationWorkbench: workbench });
    const table = markdown.slice(markdown.indexOf("Symbol | Role | Screen status"));

    expect(table).toContain("| Input dates | Sources\n--- | --- | --- | ---: | --- | --- | ---\n");
    expect(table).toMatch(/\n[A-Z]+ \| target \| .* \| \[market-test\] \[sec-test\]\n/u);
    expect(table).toContain("USE | peer | usable | N/M | — | — | [market-use]\n");
    expect(table).toContain("EXC | peer | excluded | N/M | — | — | [sec-exc]\n");
    expect(table).toContain("NONE | peer | excluded | N/M | — | — | —\n");
    expect(table).toContain("BAD | peer | excluded | N/M | — | — | —\n");
    const sources = markdown.slice(markdown.indexOf("### Sources"), markdown.indexOf(table));
    const renderedRefs = [...table.matchAll(/\[([^\]]+)\]/gu)].map((match) => match[1]);
    expect(renderedRefs.length).toBeGreaterThan(0);
    for (const sourceId of renderedRefs) {
      expect(sources).toContain(`- [${sourceId ?? ""}] `);
    }
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
    expect(renderValuationWorkbenchMarkdown(artifact, researchReport())).not.toContain(
      "Trailing basis suppressed",
    );
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

    const markdown = renderValuationWorkbenchMarkdown(artifact, researchReport());

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

    const markdown = renderValuationWorkbenchMarkdown(artifact, researchReport());

    expect(markdown).toContain("fetch time 2026-05-19T14:31:00.000Z");
    expect(markdown).not.toContain("quote time 2026-05-19T14:31:00.000Z");
  });

  test("drops an unreadable observation, records it, and preserves the record on re-read", () => {
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

    const read = readValuationWorkbenchArtifact(malformed);

    expect(read?.historicalMultiples.observations).toEqual(rest);
    expect(read?.readDiagnostics).toEqual({
      droppedObservationCount: 1,
      drops: [
        {
          reason: "valuationWorkbench.historicalMultiples.observations.invalid",
          count: 1,
        },
      ],
    });
    expect(readValuationWorkbenchArtifact(structuredClone(read))).toEqual(read);
  });

  test("returns an artifact and records every observation when none are readable", () => {
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: statements(),
      priceHistory: [{ date: "2024-02-15", close: 20 }],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });
    const read = readValuationWorkbenchArtifact({
      ...artifact,
      historicalMultiples: {
        ...artifact.historicalMultiples,
        observations: artifact.historicalMultiples.observations.map((observation) => ({
          ...observation,
          basis: "retired",
        })),
      },
    });

    expect(read?.historicalMultiples.observations).toEqual([]);
    expect(read?.readDiagnostics).toEqual({
      droppedObservationCount: artifact.historicalMultiples.observations.length,
      drops: [
        {
          reason: "valuationWorkbench.historicalMultiples.observations.invalid",
          count: artifact.historicalMultiples.observations.length,
        },
      ],
    });
  });
});
