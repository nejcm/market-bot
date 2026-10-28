import { buildEvidencePayload } from "../src/research/prompts/evidence-payload";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { config, contextWithHistory } from "./support/research-context-helpers";
import { sourceGapScopedReportText } from "../src/domain/source-gaps";
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
  type BuildValuationWorkbenchInput,
} from "../src/sources/extended-evidence/valuation-workbench";
import {
  readValuationWorkbenchArtifact,
  type ValuationWorkbenchArtifact,
} from "../src/sources/extended-evidence/valuation-workbench-contract";
import {
  hasNoPriceHistory,
  renderValuationWorkbenchMarkdown,
} from "../src/report/valuation-workbench-markdown";
import { validateResearchReport } from "../src/report/schema";
import { buildReverseDcf } from "../src/sources/extended-evidence/reverse-dcf";
import { collectPriceHistory } from "../src/sources/yahoo-price-history";
import { renderMarkdownReport } from "../src/report/markdown";
import {
  EMPTY_EV_BRIDGE_FACTS,
  collectedSources,
  researchReport,
  reverseDcfWorkbench,
} from "./support/fixtures";

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
    concept: input.key === "netIncome" ? "NetIncomeLoss" : input.key,
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
    value,
    periodEnd: "2024-12-31",
    filedAt: "2025-02-15",
    unit,
  });
  const latestYearToDate = fact({
    key,
    value: value / 2,
    periodEnd: "2025-03-31",
    filedAt,
    periodType: "interim",
    unit,
  });
  const priorYearToDate = fact({
    key,
    value: value / 2,
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
        consolidatedContinuingIncome: series("consolidatedContinuingIncome", "incomeStatement"),
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
    enterpriseValueBridge: EMPTY_EV_BRIDGE_FACTS,
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

  test("bridges EV/revenue through short-term investments and NCI known at each publicAt", () => {
    const bridgeFact = (value: number, concept: string, periodEnd: string, filedAt: string) => {
      const { periodStart: _instant, ...base } = fact({ key: "cash", value, periodEnd, filedAt });
      return {
        ...base,
        key: "stockholdersEquity" as const,
        periodKey: `instant|${periodEnd}`,
        concept,
      };
    };
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: {
        ...statements(),
        enterpriseValueBridge: {
          ...EMPTY_EV_BRIDGE_FACTS,
          shortTermInvestments: [
            bridgeFact(20, "ShortTermInvestments", "2023-12-31", "2024-02-15"),
            // Filed after the FY2024 publicAt, so that observation sees a dropped nonzero line.
            bridgeFact(25, "ShortTermInvestments", "2024-12-31", "2025-03-01"),
          ],
          noncontrollingInterest: [bridgeFact(3, "MinorityInterest", "2023-12-31", "2024-02-15")],
        },
      },
      priceHistory: [
        { date: "2024-02-15", close: 20 },
        { date: "2025-02-18", close: 24 },
      ],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });
    const [fy2023, fy2024] = artifact.historicalMultiples.observations;

    // (20 × 10 + debt 10 − cash 5 − STI 20 + NCI 3) / revenue 100
    expect(fy2023?.metrics.enterpriseValueToRevenue).toMatchObject({
      status: "value",
      value: 1.88,
    });
    expect(fy2023?.inputs.enterpriseValueBridge).toMatchObject({
      value: -17,
      periodEnd: "2023-12-31",
    });
    expect(fy2024?.metrics.enterpriseValueToRevenue).toMatchObject({
      status: "missing",
      reason: "ev-bridge-incomplete",
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

  test("withholds TTM free cash flow when a capex TTM component is filed negative", () => {
    const input = statements();
    const capex = input.statements.cashFlowStatement.capitalExpenditure;
    const latestYearToDate = { ...capex.ttm!.components.latestYearToDate, value: -5 };
    const negativeComponent = {
      ...input,
      statements: {
        ...input.statements,
        cashFlowStatement: {
          ...input.statements.cashFlowStatement,
          capitalExpenditure: {
            ...capex,
            ttm: { ...capex.ttm!, components: { ...capex.ttm!.components, latestYearToDate } },
          },
        },
      },
    };
    const artifact = buildValuationWorkbench({
      generatedAt: "2025-06-01T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: negativeComponent,
      priceHistory: [
        { date: "2025-02-18", close: 24 },
        { date: "2025-05-01", close: 26 },
      ],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });
    const ttmObservation = artifact.historicalMultiples.observations.find(
      (item) => item.basis === "ttm",
    )!;

    expect(ttmObservation.inputs.freeCashFlow).toBeUndefined();
    expect(ttmObservation.metrics.priceToFreeCashFlow).toMatchObject({
      status: "missing",
      reason: "free-cash-flow-unavailable",
    });
    expect(
      ttmObservation.metrics.priceToFreeCashFlow.inputs.some(
        (row) => row.series === "capitalExpenditure" && row.value === -5,
      ),
    ).toBe(true);
    expect(
      artifact.historicalMultiples.observations.find(
        (item) => item.basis === "annual" && item.periodEnd === "2024-12-31",
      )?.metrics.priceToFreeCashFlow.status,
    ).toBe("value");
    expect(
      buildReverseDcf({
        generatedAt: "2025-06-01T00:00:00.000Z",
        symbol: "TEST",
        valuationWorkbench: artifact,
      }),
    ).toMatchObject({ status: "suppressed", reason: "reconciled-ttm-fcf-unavailable" });
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
            peers: [
              {
                ...target,
                symbol: "PEER",
                debtBasis: "gross-principal",
                shortTermInvestmentsIncludeEquity: true,
              },
            ],
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

    expect(markdown).toContain(
      "cash 2025-03-31 (short-term investments include current equity securities that may be sale-restricted); debt 2025-03-31 (gross principal)",
    );
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

const filedFact = (value: number, unit: string, instant = false) => ({
  units: {
    [unit]: [
      {
        val: value,
        start: instant ? undefined : "2024-01-01",
        end: "2024-12-31",
        filed: "2025-02-15",
        form: "10-K",
        fy: 2024,
        fp: "FY",
        accn: "test-2024",
      },
    ],
  },
});

function workbenchInput(): BuildValuationWorkbenchInput {
  const filedStatements = deriveFinancialStatements(
    {
      facts: {
        "us-gaap": {
          Revenues: filedFact(1000, "USD"),
          NetIncomeLoss: filedFact(100, "USD"),
          EarningsPerShareDiluted: filedFact(10, "USD/shares"),
          WeightedAverageNumberOfDilutedSharesOutstanding: filedFact(10, "shares"),
          NetCashProvidedByUsedInOperatingActivities: filedFact(300, "USD"),
          PaymentsToAcquirePropertyPlantAndEquipment: filedFact(100, "USD"),
          CashAndCashEquivalentsAtCarryingValue: filedFact(50, "USD", true),
          LongTermDebt: filedFact(100, "USD", true),
        },
      },
    },
    {
      symbol: "TEST",
      generatedAt: "2025-06-01T00:00:00.000Z",
      analysisAsOf: "2025-06-01T00:00:00.000Z",
      sourceId: "filed",
    },
  );
  return {
    symbol: "TEST",
    generatedAt: filedStatements.generatedAt,
    financialStatements: filedStatements,
    priceHistory: [{ date: "2025-02-18", close: 20 }],
    priceSourceId: "price",
    quoteCurrency: "USD",
  };
}
async function evaluateWorkbench(value: BuildValuationWorkbenchInput) {
  return collectValuationWorkbench({
    ...value,
    fetchImpl: async () => {
      throw new Error("network forbidden");
    },
  });
}

test.each([
  {
    name: "before the requested window",
    from: "2025-02-23",
    bars: ["2025-03-01"],
    structural: true,
  },
  {
    name: "alignment window overlapping the requested start",
    from: "2025-02-22",
    bars: ["2025-03-01"],
    structural: false,
  },
  {
    name: "at the requested boundary without a bar",
    from: "2025-02-15",
    bars: ["2025-03-01"],
    structural: false,
  },
  {
    name: "inside the window before the first returned bar",
    from: "2025-02-01",
    bars: ["2025-03-01"],
    structural: false,
  },
  {
    name: "inside a history hole",
    from: "2025-02-01",
    bars: ["2025-02-01", "2025-03-01"],
    structural: false,
  },
  { name: "history fetch failure", from: "2025-02-16", bars: [], structural: false },
  { name: "unknown requested window", from: undefined, bars: ["2025-03-01"], structural: false },
])("workbench price gaps: $name", async ({ from, bars, structural }) => {
  const result = await evaluateWorkbench({
    ...workbenchInput(),
    ...(from === undefined ? {} : { priceHistoryRequestedFrom: from }),
    priceHistory: bars.map((date) => ({ date, close: 20 })),
  });
  expect(result.artifact.historicalMultiples.observations).toHaveLength(1);
  const observation = result.artifact.historicalMultiples.observations[0]!;
  expect(observation.price).toBeNull();
  for (const metric of Object.values(observation.metrics)) {
    expect(metric).toMatchObject({ status: "missing", reason: "price-history-unavailable" });
    expect(metric.cause).toBe(structural ? "outside-price-history-window" : undefined);
    expect(metric.inputs.length).toBeGreaterThan(0);
  }
  expect(result.metricSections[0]?.metrics).toEqual(Object.values(observation.metrics));
  expect(result.sourceGaps).toHaveLength(1);
  expect(result.sourceGaps[0]?.triage).toBe(structural ? "diagnostic" : "material");
  expect(result.sourceGaps[0]?.source).toBe(
    structural ? "valuation-workbench-outside-price-history-window" : result.metricSections[0]?.id,
  );
  expect(hasNoPriceHistory(observation)).toBe(true);
  expect(readValuationWorkbenchArtifact(result.artifact)?.historicalMultiples).toEqual(
    result.artifact.historicalMultiples,
  );
  const report = researchReport({
    predictions: [],
    extras: { metricSections: result.metricSections },
    sources: [
      {
        id: "filed",
        title: "Filed inputs",
        url: "https://example.com",
        provider: "sec",
        fetchedAt: result.artifact.generatedAt,
        kind: "extended-evidence",
      },
    ],
  });
  expect(() => validateResearchReport(report)).not.toThrow();
});

const yearlyFact = (value: number, unit: string, instant = false) => ({
  units: {
    [unit]: [2022, 2023, 2024].map((fy) => ({
      val: value,
      start: instant ? undefined : `${String(fy)}-01-01`,
      end: `${String(fy)}-12-31`,
      filed: `${String(fy + 1)}-02-15`,
      form: "10-K",
      fy,
      fp: "FY",
      accn: `test-${String(fy)}`,
    })),
  },
});

test("periods before the price-history window share one Source Gap", async () => {
  const yearlyStatements = deriveFinancialStatements(
    {
      facts: {
        "us-gaap": {
          Revenues: yearlyFact(1000, "USD"),
          NetIncomeLoss: yearlyFact(100, "USD"),
          EarningsPerShareDiluted: yearlyFact(10, "USD/shares"),
          WeightedAverageNumberOfDilutedSharesOutstanding: yearlyFact(10, "shares"),
          NetCashProvidedByUsedInOperatingActivities: yearlyFact(300, "USD"),
          PaymentsToAcquirePropertyPlantAndEquipment: yearlyFact(100, "USD"),
          CashAndCashEquivalentsAtCarryingValue: yearlyFact(50, "USD", true),
          LongTermDebt: yearlyFact(100, "USD", true),
        },
      },
    },
    {
      symbol: "TEST",
      generatedAt: "2025-06-01T00:00:00.000Z",
      analysisAsOf: "2025-06-01T00:00:00.000Z",
      sourceId: "filed",
    },
  );
  const result = await evaluateWorkbench({
    ...workbenchInput(),
    financialStatements: yearlyStatements,
    priceHistoryRequestedFrom: "2024-03-01",
    priceHistory: [{ date: "2025-02-18", close: 20 }],
  });
  const ids = result.metricSections.map(({ id }) => id);
  expect(ids).toHaveLength(3);
  expect(result.sourceGaps.map(({ source }) => source)).toEqual([
    "valuation-workbench-outside-price-history-window",
  ]);
  expect(result.sourceGaps[0]).toMatchObject({
    cause: "suppressed-by-design",
    triage: "diagnostic",
    evidenceQualityImpact: "no-cap",
  });
  expect(result.sourceGaps[0]?.message).toContain("2 periods");
  expect(result.sourceGaps[0]?.message).toContain("ANNUAL 2022-12-31 public 2023-02-15");
  expect(result.sourceGaps[0]?.message).toContain("ANNUAL 2023-12-31 public 2024-02-15");
  expect(result.sourceGaps[0]?.message).not.toContain("2024-12-31");
});

test("failed price-history requests keep workbench gaps material", async () => {
  const value = workbenchInput();
  const { priceHistory } = await collectPriceHistory(
    {
      command: { jobType: "equity", assetClass: "equity", depth: "deep", symbol: "TEST" },
      fetchedAt: "2031-06-01T00:00:00.000Z",
      newsLimit: 0,
      cryptoMoverLimit: 0,
      request: {
        json: async () => ({ source: "yahoo-price-history", message: "fetch failed" }),
        text: async () => {
          throw new Error("unexpected text request");
        },
      },
    },
    "TEST",
  );
  const history = priceHistory[0]!;
  expect(history.reason).toBe("fetch failed");
  const result = await evaluateWorkbench({
    ...value,
    priceHistory: history.bars,
    priceSourceId: history.sourceId,
    ...(history.requestedFrom === undefined
      ? {}
      : { priceHistoryRequestedFrom: history.requestedFrom }),
  });
  expect(result.sourceGaps[0]?.triage).toBe("material");
  for (const metric of result.metricSections[0]!.metrics) {
    expect(metric).toMatchObject({ status: "missing", reason: "price-history-unavailable" });
    expect(metric.cause).toBeUndefined();
  }
});

test("independent missing workbench inputs stay material outside the price window", async () => {
  const value = workbenchInput();
  const filedStatements = structuredClone(value.financialStatements!);
  Object.assign(filedStatements.statements.balanceSheet.cash, { annual: [], interim: [] });
  const result = await evaluateWorkbench({
    ...value,
    financialStatements: filedStatements,
    priceHistoryRequestedFrom: "2025-03-01",
    priceHistory: [{ date: "2025-03-01", close: 20 }],
  });
  expect(result.metricSections[0]?.metrics[0]?.cause).toBe("outside-price-history-window");
  expect(
    result.artifact.historicalMultiples.observations[0]?.metrics.enterpriseValueToRevenue,
  ).toMatchObject({ status: "missing", reason: "cash-unavailable" });
  expect(result.sourceGaps[0]?.triage).toBe("material");
});

test("valuation rows retain R5 basis, filed fundamentals and metric-local citations", async () => {
  const value = workbenchInput();
  const filedStatements = structuredClone(value.financialStatements!);
  Object.assign(filedStatements.statements.balanceSheet.cash.annual[0]!, {
    sourceIds: ["cash-only"],
  });
  const result = await evaluateWorkbench({ ...value, financialStatements: filedStatements });
  const observation = result.artifact.historicalMultiples.observations[0]!;
  expect(observation.inputs).toMatchObject({
    revenue: {
      value: 1000,
      periodEnd: "2024-12-31",
      publicAt: "2025-02-15",
      currency: "USD",
      unit: "USD",
      sourceIds: ["filed"],
    },
    dilutedEps: { value: 10, sourceIds: ["filed"] },
    dilutedShares: { value: 10, sourceIds: ["filed"] },
    cash: { value: 50, sourceIds: ["cash-only"] },
    debt: { value: 100, sourceIds: ["filed"] },
    freeCashFlow: {
      value: 200,
      sourceIds: ["filed"],
      derivation: "operating cash flow - capital expenditure",
    },
  });
  expect(observation.sourceIds.toSorted()).toEqual(["cash-only", "filed", "price"]);
  expect(result.artifact.sourceIds.toSorted()).toEqual(["cash-only", "filed", "price"]);
  for (const [key, expected] of Object.entries({
    priceToEarnings: 2,
    priceToSales: 0.2,
    enterpriseValueToRevenue: 0.25,
    priceToFreeCashFlow: 1,
  })) {
    const metric = observation.metrics[key as keyof typeof observation.metrics];
    expect(metric).toMatchObject({ status: "value", value: expected, periodEnd: "2024-12-31" });
    expect(metric.basis).toContain(
      "first verified close within 7 calendar days on or after publicAt 2025-02-15; close 2025-02-18 USD",
    );
    expect(metric.sourceIds.toSorted()).toEqual(
      key === "enterpriseValueToRevenue" ? ["cash-only", "filed", "price"] : ["filed", "price"],
    );
  }
  expect(
    observation.metrics.priceToFreeCashFlow.inputs.map(
      ({ series: seriesKey, artifact }) => seriesKey ?? artifact,
    ),
  ).toEqual(["operatingCashFlow", "capitalExpenditure", "dilutedShares", "priceHistory"]);
  expect(result.metricSections[0]?.metrics).toEqual(Object.values(observation.metrics));
  expect(result.sourceGaps).toEqual([]);
});

test("annual valuation rejects the selected 13-month input without rejecting an unrelated fact", async () => {
  const value = workbenchInput();
  const filedStatements = structuredClone(value.financialStatements!);
  const selected = filedStatements.statements.perShare.dilutedEps.annual[0]!;
  Object.assign(selected, { periodStart: "2023-12-01" });
  const rejected = await evaluateWorkbench({ ...value, financialStatements: filedStatements });
  expect(rejected.artifact.historicalMultiples.observations[0]?.metrics).toMatchObject({
    priceToEarnings: { status: "missing", reason: "annual input outside 350–380 days" },
    priceToSales: { status: "value", value: 0.2 },
    enterpriseValueToRevenue: { status: "value", value: 0.25 },
    priceToFreeCashFlow: { status: "value", value: 1 },
  });
  Object.assign(selected, { periodStart: "2024-01-01" });
  Object.assign(filedStatements.statements.perShare.dilutedEps, {
    annual: [
      selected,
      { ...selected, value: 999, periodStart: "2023-12-01", periodKey: "duration:13|2024-12-31" },
    ],
  });
  const accepted = await evaluateWorkbench({ ...value, financialStatements: filedStatements });
  expect(accepted.artifact.historicalMultiples.observations[0]?.metrics).toMatchObject({
    priceToEarnings: { status: "value", value: 2 },
    priceToSales: { status: "value", value: 0.2 },
    enterpriseValueToRevenue: { status: "value", value: 0.25 },
    priceToFreeCashFlow: { status: "value", value: 1 },
  });
});

test("known incompatible filed currency withholds valuation while unknown currency permits it", async () => {
  const value = workbenchInput();
  const filedStatements = structuredClone(value.financialStatements!);
  const cash = filedStatements.statements.balanceSheet.cash.annual[0]!;
  Object.assign(cash, { currency: "CAD", unit: "CAD" });
  const changed = { ...value, financialStatements: filedStatements };
  const result = await evaluateWorkbench(changed);
  expect(result.artifact.historicalMultiples.observations[0]?.metrics).toMatchObject({
    enterpriseValueToRevenue: { status: "missing", reason: "incompatible currency" },
    priceToEarnings: { status: "value", value: 2 },
    priceToSales: { status: "value", value: 0.2 },
    priceToFreeCashFlow: { status: "value", value: 1 },
  });
  expect(result.sourceGaps[0]?.triage).toBe("material");
  Object.assign(cash, { currency: null, unit: "USD" });
  const accepted = await evaluateWorkbench(changed);
  expect(accepted.artifact.historicalMultiples.observations[0]?.metrics).toMatchObject({
    enterpriseValueToRevenue: { status: "value", value: 0.25 },
    priceToEarnings: { status: "value", value: 2 },
    priceToSales: { status: "value", value: 0.2 },
    priceToFreeCashFlow: { status: "value", value: 1 },
  });
});

test("absent valuation statements emit one missing section and material Source Gap", async () => {
  const result = await evaluateWorkbench({
    symbol: "TEST",
    generatedAt: "2025-06-01T00:00:00.000Z",
    priceHistory: [],
  });
  expect(result.artifact.historicalMultiples.observations).toEqual([]);
  expect(result.metricSections).toHaveLength(1);
  expect(result.metricSections[0]).toMatchObject({
    id: "valuation-workbench-unavailable",
    metrics: [{ id: "priceToFreeCashFlow", status: "missing" }],
  });
  expect(result.sourceGaps).toHaveLength(1);
  expect(result.sourceGaps[0]).toMatchObject({
    source: "valuation-workbench-unavailable",
    triage: "material",
  });
});
test("missing FCF partners propagate independently filed absence and keep available lineage", async () => {
  const value = workbenchInput();
  const filedStatements = structuredClone(value.financialStatements!);
  Object.assign(filedStatements.statements.cashFlowStatement.capitalExpenditure, {
    annual: [],
    interim: [],
  });
  Object.assign(filedStatements, { unfiledSeries: ["capitalExpenditure"] });
  const result = await evaluateWorkbench({ ...value, financialStatements: filedStatements });
  const metric = result.artifact.historicalMultiples.observations[0]!.metrics.priceToFreeCashFlow;
  expect(metric).toMatchObject({ status: "missing", cause: "not-filed" });
  expect(metric.inputs.some(({ series: seriesKey }) => seriesKey === "operatingCashFlow")).toBe(
    true,
  );
  expect(result.sourceGaps[0]?.triage).toBe("diagnostic");
  Object.assign(filedStatements, { unfiledSeries: [] });
  const filed = await evaluateWorkbench({ ...value, financialStatements: filedStatements });
  expect(filed.sourceGaps[0]?.triage).toBe("material");
});

test("P/FCF keeps zero and negative denominators not meaningful and discloses its price basis", async () => {
  for (const cashFlow of [100, 90]) {
    const value = workbenchInput();
    const filedStatements = structuredClone(value.financialStatements!);
    Object.assign(filedStatements.statements.cashFlowStatement.operatingCashFlow.annual[0]!, {
      value: cashFlow,
    });
    const result = await evaluateWorkbench({ ...value, financialStatements: filedStatements });
    const metric = result.artifact.historicalMultiples.observations[0]!.metrics.priceToFreeCashFlow;
    expect(metric).toMatchObject({
      status: "not-meaningful",
      reason: cashFlow === 100 ? "zero-denominator" : "negative-denominator",
    });
    expect(metric.basis).toContain("close 2025-02-18 USD");
    expect(result.sourceGaps[0]?.triage).toBe("diagnostic");
  }
});

test("non-positive denominators remain diagnostic despite incompatible filed currency", async () => {
  for (const denominator of [0, -10]) {
    const value = workbenchInput();
    const filedStatements = structuredClone(value.financialStatements!);
    Object.assign(filedStatements.statements.perShare.dilutedEps.annual[0]!, {
      value: denominator,
      currency: "CAD",
      unit: "CAD/shares",
    });
    Object.assign(filedStatements.statements.incomeStatement.revenue.annual[0]!, {
      value: denominator,
    });
    Object.assign(filedStatements.statements.balanceSheet.cash.annual[0]!, {
      currency: "CAD",
      unit: "CAD",
    });
    Object.assign(filedStatements.statements.cashFlowStatement.operatingCashFlow.annual[0]!, {
      value: 100 + denominator,
    });
    Object.assign(filedStatements.statements.perShare.dilutedShares.annual[0]!, {
      currency: "CAD",
    });
    const changed = { ...value, financialStatements: filedStatements };
    const result = await evaluateWorkbench(changed);
    for (const metric of Object.values(
      result.artifact.historicalMultiples.observations[0]!.metrics,
    )) {
      expect(metric).toMatchObject({
        status: "not-meaningful",
        reason: denominator === 0 ? "zero-denominator" : "negative-denominator",
      });
    }
    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]?.triage).toBe("diagnostic");
  }
});

test("model payloads gain declared gaps while workbench metric values stay outside prompts", async () => {
  const value = workbenchInput();
  const result = await evaluateWorkbench({ ...value, priceHistory: [] });
  const command = {
    jobType: "equity",
    assetClass: "equity",
    depth: "deep",
    symbol: "TEST",
  } as const;
  const sources = collectedSources({
    valuationWorkbench: result.artifact,
    metricSections: result.metricSections,
    sourceGaps: result.sourceGaps,
  });
  for (const webSourceText of ["metadata", "profile"] as const) {
    for (const sourceGapView of ["all", "web-gather"] as const) {
      const payload = buildEvidencePayload(
        { includePriorCalibration: false, sourceGapView, webSourceText },
        command,
        sources,
        config,
        contextWithHistory(command),
      );
      expect(payload.sourceGaps).toEqual(
        expect.arrayContaining(result.sourceGaps.map(sourceGapScopedReportText)),
      );
      expect(payload).not.toHaveProperty("metricSections");
      expect(payload).not.toHaveProperty("valuationWorkbench");
    }
  }
});

test.each([
  [100, { status: "value", value: 1 }],
  [0, { status: "value", value: 200 / 300 }],
  [-100, { status: "missing", reason: "free-cash-flow-unavailable" }],
])("P/FCF with capex %d withholds a negative-filed outflow", async (capex, expected) => {
  const value = workbenchInput();
  const filedStatements = structuredClone(value.financialStatements!);
  Object.assign(filedStatements.statements.cashFlowStatement.capitalExpenditure.annual[0]!, {
    value: capex,
  });
  const result = await evaluateWorkbench({ ...value, financialStatements: filedStatements });
  const observation = result.artifact.historicalMultiples.observations[0]!;
  expect(observation.metrics.priceToFreeCashFlow).toMatchObject(expected);
  expect(
    observation.metrics.priceToFreeCashFlow.inputs.map(({ series: seriesKey }) => seriesKey),
  ).toContain("capitalExpenditure");
  expect(observation.inputs.freeCashFlow === undefined).toBe(capex < 0);
});
