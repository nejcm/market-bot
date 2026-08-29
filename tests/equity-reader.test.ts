import { describe, expect, test } from "bun:test";
import type { SourceGap } from "../src/domain/types";
import { projectEquityReader } from "../src/report/equity-reader";
import { classifyGap } from "../src/report/gap-triage";
import { renderBalanceSheetAndShareCount } from "../src/report/markdown-equity-sections";
import { researchReport } from "./support/fixtures";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementsArtifact,
} from "../src/sources/extended-evidence/financial-statements-contract";
import type {
  FundamentalHistoryArtifact,
  FundamentalHistoryPoint,
  FundamentalHistorySeries,
  FundamentalHistorySeriesKey,
} from "../src/sources/extended-evidence/fundamental-history";

function statementFact(
  key: "cash" | "debt" | "dilutedShares",
  value: number,
  filedAt: string,
  periodEnd = "2024-12-31",
): FinancialStatementFact {
  return {
    value,
    periodKey: `annual:${periodEnd}`,
    periodType: "annual",
    form: filedAt === "2025-03-01" ? "10-K/A" : "10-K",
    canonicalForm: "10-K",
    amendment: filedAt === "2025-03-01",
    accessionNumber: `accession-${key}-${filedAt}`,
    filedAt,
    periodEnd,
    fiscalYear: Number(periodEnd.slice(0, 4)),
    fiscalPeriod: "FY",
    taxonomy: "us-gaap",
    concept: key,
    currency: key === "dilutedShares" ? null : "USD",
    unit: key === "dilutedShares" ? "shares" : "USD",
    unitScale: 1,
    extractionMethod: "sec-companyfacts",
    sourceIds: [`sec-${filedAt}`],
  };
}

function statementSeries(
  key: "cash" | "debt" | "dilutedShares",
  values: readonly FinancialStatementFact[],
): FinancialStatementSeries {
  return {
    key,
    label: key,
    statement: key === "dilutedShares" ? "perShare" : "balanceSheet",
    annual: values.filter((value) => value.periodType === "annual"),
    interim: values.filter((value) => value.periodType === "interim"),
  };
}

function amendedFilingArtifact(): FinancialStatementsArtifact {
  const filingDates = ["2025-02-01", "2025-03-01"] as const;
  const cash = statementSeries("cash", [
    statementFact("cash", 100, filingDates[0]),
    statementFact("cash", 120, filingDates[1]),
    statementFact("cash", 140, "2025-05-01"),
  ]);
  const debt = statementSeries("debt", [
    statementFact("debt", 80, filingDates[0]),
    statementFact("debt", 70, filingDates[1]),
  ]);
  const dilutedShares = statementSeries("dilutedShares", [
    statementFact("dilutedShares", 10, filingDates[0]),
    statementFact("dilutedShares", 9, filingDates[1]),
  ]);
  return {
    analysisAsOf: "2025-04-01T12:00:00.000Z",
    sourceId: "sec-statements",
    reportingCurrency: "USD",
    statements: {
      incomeStatement: {},
      balanceSheet: { cash, debt },
      cashFlowStatement: {},
      perShare: { dilutedShares },
    },
  } as unknown as FinancialStatementsArtifact;
}

function divergentFilingArtifact(): FinancialStatementsArtifact {
  const cash = statementSeries("cash", [statementFact("cash", 100, "2025-02-01")]);
  const debt = statementSeries("debt", [statementFact("debt", 80, "2025-02-01")]);
  const dilutedShares = statementSeries("dilutedShares", [
    statementFact("dilutedShares", 10, "2025-02-01"),
    statementFact("dilutedShares", 9, "2025-03-01"),
  ]);
  return {
    analysisAsOf: "2025-04-01T12:00:00.000Z",
    sourceId: "sec-statements",
    reportingCurrency: "USD",
    statements: {
      incomeStatement: {},
      balanceSheet: { cash, debt },
      cashFlowStatement: {},
      perShare: { dilutedShares },
    },
  } as unknown as FinancialStatementsArtifact;
}

function completenessDimension(status: string) {
  return { status, reasonCodes: [] as string[], asOf: "2026-07-04", sourceIds: [] as string[] };
}

function historyPoint(year: number, value: number): FundamentalHistoryPoint {
  return {
    value,
    form: "10-K",
    fy: year,
    fp: "FY",
    periodStart: `${String(year)}-01-01`,
    periodEnd: `${String(year)}-12-31`,
    periodMonths: 12,
    filedAt: `${String(year + 1)}-02-01`,
    currency: "USD",
  };
}

function historySeries(
  key: FundamentalHistorySeriesKey,
  annual: readonly FundamentalHistoryPoint[],
  ttm?: FundamentalHistoryPoint,
): FundamentalHistorySeries {
  return {
    key,
    label: key,
    unit: key === "operatingMargin" ? "ratio" : "currency",
    annual,
    ...(ttm === undefined ? {} : { ttm }),
    notes: [],
  };
}

function annualAndTtmHistory(): FundamentalHistoryArtifact {
  const annual = [2019, 2020, 2021, 2022, 2023, 2024].map((year, index) =>
    historyPoint(year, (index + 1) * 1_000_000),
  );
  const revenueTtm = {
    ...historyPoint(2025, 7_000_000),
    form: "TTM" as const,
    periodStart: "2024-10-01",
    periodEnd: "2025-09-30",
    periodMonths: 12,
    filedAt: "2025-11-01",
    currency: "EUR",
  };
  const netIncomeTtm = {
    ...historyPoint(2025, 700_000),
    form: "TTM" as const,
    periodEnd: "2025-12-31",
    filedAt: "2026-02-01",
  };
  const series = {
    revenue: historySeries("revenue", annual, revenueTtm),
    netIncome: historySeries("netIncome", annual, netIncomeTtm),
    operatingMargin: historySeries(
      "operatingMargin",
      annual.map((point) => ({ ...point, value: 0.2 })),
    ),
    freeCashFlowProxy: historySeries("freeCashFlowProxy", annual),
  };
  return {
    version: 1,
    generatedAt: "2026-02-02T00:00:00.000Z",
    symbol: "TEST",
    sourceId: "sec-history",
    series,
  } as unknown as FundamentalHistoryArtifact;
}

describe("equity reader projection", () => {
  test("projects each latest available financial-position metric independently", () => {
    const cash = statementSeries("cash", [
      statementFact("cash", 100, "2025-02-01"),
      statementFact("cash", 120, "2026-02-01", "2025-12-31"),
    ]);
    const dilutedShares = statementSeries("dilutedShares", [
      statementFact("dilutedShares", 9, "2025-03-01"),
    ]);
    const financialStatements = {
      analysisAsOf: "2026-04-01T12:00:00.000Z",
      sourceId: "sec-statements",
      reportingCurrency: "USD",
      statements: {
        incomeStatement: {},
        balanceSheet: { cash },
        cashFlowStatement: {},
        perShare: { dilutedShares },
      },
    } as unknown as FinancialStatementsArtifact;

    const projection = projectEquityReader({
      report: { generatedAt: "2026-04-01T12:00:00.000Z" },
      financialStatements,
    });

    expect(projection.defaultView.financialPosition).toMatchObject({
      reportingCurrency: "USD",
      cash: { value: 120, periodEnd: "2025-12-31", filedAt: "2026-02-01" },
      dilutedShares: { value: 9, periodEnd: "2024-12-31", filedAt: "2025-03-01" },
    });
    expect(projection.defaultView.financialPosition?.debt).toBeUndefined();
    expect(projection.defaultView.financialPosition?.notes).toBeUndefined();
    expect(projection.appendix.balanceSheetHistory).toBeUndefined();
  });

  test("keeps statement notes undefined versus an empty checked list", () => {
    const base = amendedFilingArtifact();
    const checked = projectEquityReader({
      report: { generatedAt: "2025-04-01T12:00:00.000Z" },
      financialStatements: { ...base, omissionNotes: [], validationNotes: [] },
    });
    const explained = projectEquityReader({
      report: { generatedAt: "2025-04-01T12:00:00.000Z" },
      financialStatements: {
        ...base,
        omissionNotes: [
          {
            code: "untagged-balance-sheet-series",
            seriesKey: "debt",
            message: "Debt is untagged in companyfacts.",
          },
        ],
        validationNotes: [],
      },
    });

    expect(
      projectEquityReader({
        report: { generatedAt: "2025-04-01T12:00:00.000Z" },
        financialStatements: base,
      }).appendix.balanceSheetHistory?.notes,
    ).toBeUndefined();
    expect(checked.appendix.balanceSheetHistory?.notes).toEqual([]);
    expect(explained.appendix.balanceSheetHistory?.notes).toEqual([
      expect.objectContaining({ code: "untagged-balance-sheet-series" }),
    ]);
    expect(explained.defaultView.financialPosition?.notes).toEqual([
      expect.objectContaining({ code: "untagged-balance-sheet-series" }),
    ]);
  });

  test("renders stale-instant-series notes below the table when the series cell still has a value", () => {
    const cashNote = {
      code: "stale-instant-series" as const,
      seriesKey: "cash" as const,
      message:
        "Cash latest period end 2024-12-31 lags the newest balance-sheet period end 2025-03-31 by more than one reporting period.",
    };
    const currentAssetsNote = {
      code: "stale-instant-series" as const,
      seriesKey: "currentAssets" as const,
      message:
        "Current assets latest period end 2024-12-31 lags the newest balance-sheet period end 2025-03-31 by more than one reporting period.",
    };
    const explained = projectEquityReader({
      report: { generatedAt: "2025-04-01T12:00:00.000Z" },
      financialStatements: {
        ...amendedFilingArtifact(),
        omissionNotes: [cashNote, currentAssetsNote],
        validationNotes: [],
      },
    });
    const history = explained.appendix.balanceSheetHistory;
    const markdown = renderBalanceSheetAndShareCount(researchReport(), history);

    expect(history?.rows.some((row) => row.cash !== undefined)).toBe(true);
    expect(history?.notes).toEqual([
      expect.objectContaining({ code: "stale-instant-series", seriesKey: "cash" }),
      expect.objectContaining({ code: "stale-instant-series", seriesKey: "currentAssets" }),
    ]);
    expect(markdown).toContain(cashNote.message);
    expect(markdown).toContain(currentAssetsNote.message);
    expect(markdown).toMatch(/\| 120 \|/u);
  });

  test("selects the latest five annual periods and appends the latest available TTM period", () => {
    const projection = projectEquityReader({
      report: { generatedAt: "2026-02-02T00:00:00.000Z" },
      fundamentalHistory: annualAndTtmHistory(),
    });

    expect(projection.defaultView.financialTrends?.rows.map((row) => row.period)).toEqual([
      "FY ending 2020-12-31 (filed 2021-02-01)",
      "FY ending 2021-12-31 (filed 2022-02-01)",
      "FY ending 2022-12-31 (filed 2023-02-01)",
      "FY ending 2023-12-31 (filed 2024-02-01)",
      "FY ending 2024-12-31 (filed 2025-02-01)",
      "TTM (2025-12-31; filed 2026-02-01)",
    ]);
    expect(projection.defaultView.financialTrends?.rows.at(-1)).toEqual({
      period: "TTM (2025-12-31; filed 2026-02-01)",
      revenue: "— (revenue-unavailable)",
      netIncome: "700,000",
      operatingMargin: "— (revenue-unavailable)",
      freeCashFlow: "— (free-cash-flow-unavailable)",
    });
    expect(projection.defaultView.financialTrends?.reportingCurrency).toBe("EUR");
    expect(projection.defaultView.materialGaps).toEqual([
      "fundamental-history-revenue: SEC revenue history is unavailable for 1 rendered period(s); affected revenue and derived operating-margin values are shown as unavailable",
    ]);
  });

  test("suppresses the whole inapplicable trend column for a depository issuer, tagged periods included", () => {
    const history = annualAndTtmHistory();
    // Capex is tagged for the first three years and untagged after: a per-cell decision would
    // Print a number in one row and "not applicable" in the next row of the same column.
    const partialFreeCashFlow = {
      ...history,
      series: {
        ...history.series,
        freeCashFlowProxy: {
          ...history.series.freeCashFlowProxy,
          annual: history.series.freeCashFlowProxy.annual.slice(0, 3),
        },
      },
    } as FundamentalHistoryArtifact;
    const report = {
      generatedAt: "2026-02-02T00:00:00.000Z",
      extendedEvidence: {
        items: [{ category: "sec-edgar", metrics: { sic: "6022", operatingMargin: 0.2 } }],
      },
    };

    const industrial = projectEquityReader({
      report: { generatedAt: "2026-02-02T00:00:00.000Z" },
      fundamentalHistory: partialFreeCashFlow,
    });
    const depository = projectEquityReader({ report, fundamentalHistory: partialFreeCashFlow });

    // The industrial projection proves the same input yields real numbers in both columns.
    const industrialRows = industrial.defaultView.financialTrends?.rows ?? [];
    expect(industrialRows.filter((row) => row.operatingMargin === "20.0%").length).toBe(5);
    expect(industrialRows.filter((row) => /^[\d,.]/u.test(row.freeCashFlow)).length).toBe(2);

    const rows = depository.defaultView.financialTrends?.rows ?? [];
    expect(rows.length).toBe(6);
    expect(rows.map((row) => row.operatingMargin)).toEqual(
      rows.map(
        () => "not applicable (depository issuer; no operating income in the industrial sense)",
      ),
    );
    expect(rows.map((row) => row.freeCashFlow)).toEqual(
      rows.map(
        () => "not applicable (depository issuer; capex-based free cash flow is not defined)",
      ),
    );
    // Revenue and net income stay computed for a bank.
    expect(rows.map((row) => row.netIncome)).toEqual(
      industrial.defaultView.financialTrends?.rows.map((row) => row.netIncome) ?? [],
    );
  });

  test("selects amended values and filing dates jointly before the analysis cutoff", () => {
    const projection = projectEquityReader({
      report: { generatedAt: "2025-04-01T12:00:00.000Z" },
      financialStatements: amendedFilingArtifact(),
    });

    expect(projection.appendix.balanceSheetHistory?.rows).toEqual([
      {
        period: "FY ending 2024-12-31 (filed 2025-03-01)",
        cash: {
          value: 120,
          filedAt: "2025-03-01",
          unit: "USD",
          unitScale: 1,
          sourceIds: ["sec-2025-03-01"],
        },
        debt: {
          value: 70,
          filedAt: "2025-03-01",
          unit: "USD",
          unitScale: 1,
          sourceIds: ["sec-2025-03-01"],
        },
        dilutedShares: {
          value: 9,
          filedAt: "2025-03-01",
          unit: "shares",
          unitScale: 1,
          sourceIds: ["sec-2025-03-01"],
        },
      },
    ]);
  });

  test("preserves independently filed metrics for the same statement period", () => {
    const projection = projectEquityReader({
      report: { generatedAt: "2025-04-01T12:00:00.000Z" },
      financialStatements: divergentFilingArtifact(),
    });

    expect(projection.appendix.balanceSheetHistory?.rows).toEqual([
      {
        period: "FY ending 2024-12-31 (filed 2025-03-01)",
        cash: {
          value: 100,
          filedAt: "2025-02-01",
          unit: "USD",
          unitScale: 1,
          sourceIds: ["sec-2025-02-01"],
        },
        debt: {
          value: 80,
          filedAt: "2025-02-01",
          unit: "USD",
          unitScale: 1,
          sourceIds: ["sec-2025-02-01"],
        },
        dilutedShares: {
          value: 9,
          filedAt: "2025-03-01",
          unit: "shares",
          unitScale: 1,
          sourceIds: ["sec-2025-03-01"],
        },
      },
    ]);
  });

  test("prefers annual duration over a later-filed interim fact at the same period end", () => {
    const annual = {
      ...statementFact("cash", 100, "2025-02-01"),
      periodKey: "2024-01-01|2024-12-31",
      periodStart: "2024-01-01",
    };
    const interim = {
      ...statementFact("cash", 200, "2025-05-01"),
      periodKey: "2024-10-01|2024-12-31",
      periodType: "interim" as const,
      form: "10-Q" as const,
      canonicalForm: "10-Q" as const,
      periodStart: "2024-10-01",
    };
    const artifact = amendedFilingArtifact();
    const financialStatements = {
      ...artifact,
      statements: {
        ...artifact.statements,
        balanceSheet: {
          ...artifact.statements.balanceSheet,
          cash: statementSeries("cash", [annual, interim]),
        },
      },
    };

    const projection = projectEquityReader({
      report: { generatedAt: "2025-06-01T12:00:00.000Z" },
      financialStatements,
    });

    expect(projection.appendix.balanceSheetHistory?.rows[0]).toMatchObject({
      period: "FY ending 2024-12-31 (filed 2025-02-01)",
      cash: {
        value: 100,
        filedAt: "2025-02-01",
        sourceIds: ["sec-2025-02-01"],
      },
    });
  });

  test("projects analyst distributions and prediction shortfalls by gap triage", () => {
    const projection = projectEquityReader({
      report: {
        symbol: "AAPL",
        predictionShortfall: { emittedCount: 1, targetCount: 3, missingCount: 2 },
        dataGaps: ["Primary revenue evidence missing.", "tradier: API token missing"],
        extendedEvidence: {
          items: ["EPS", "Revenue", "EBITDA"].map((metric, index) => ({
            category: "analyst-estimates",
            title: `${metric} estimates`,
            metrics: {
              period: "FY 2027",
              mean: index + 1,
              median: index + 2,
              high: index + 3,
              low: index,
              count: index + 10,
            },
            sourceIds: [`finnhub-${metric.toLowerCase()}`],
          })),
        },
      },
    });

    expect(projection.defaultView.materialGaps).toEqual([
      "Primary revenue evidence missing.",
      "emitted 1 of 3 target predictions; evidence did not support more",
    ]);
    expect(projection.appendix.diagnosticGaps).toEqual(["tradier: API token missing"]);
    expect(projection.appendix.analystEstimateDistributions).toHaveLength(3);
    expect(projection.appendix.analystEstimateDistributions[0]).toEqual({
      title: "EPS estimates",
      period: "FY 2027",
      mean: 1,
      median: 2,
      high: 3,
      low: 0,
      count: 10,
      sourceIds: ["finnhub-eps"],
    });
  });

  test("places financial core in the default view and coverage plus dimensions in the appendix", () => {
    const projection = projectEquityReader({
      report: {
        symbol: "AAPL",
        equityAnalysisCompleteness: {
          version: 1,
          financialCoreStatus: "partial",
          coverageLevel: "substantial",
          asOf: "2026-07-04",
          dimensions: {
            primaryFinancials: completenessDimension("partial"),
            valuation: completenessDimension("complete"),
            expectations: completenessDimension("not-assessed"),
            capitalOwnership: completenessDimension("blocked"),
            operatingKpis: completenessDimension("not-applicable"),
          },
        },
      },
    });

    expect(projection.defaultView.financialCoreStatus).toBe("partial");
    expect(projection.appendix.completeness?.coverageLevel).toBe("substantial");
    expect(projection.appendix.completeness?.asOf).toBe("2026-07-04");
    expect(projection.appendix.completeness?.dimensions.map((item) => item.key)).toEqual([
      "primaryFinancials",
      "valuation",
      "expectations",
      "capitalOwnership",
      "operatingKpis",
    ]);
    expect(projection.appendix.completeness?.dimensions[0]).toMatchObject({
      label: "Primary financials",
      status: "partial",
    });
  });

  test("omits completeness placement when the report has no completeness contract", () => {
    const projection = projectEquityReader({ report: { symbol: "AAPL" } });
    expect(projection.defaultView.financialCoreStatus).toBeUndefined();
    expect(projection.appendix.completeness).toBeUndefined();
  });

  test("prefers persisted triage and falls back for legacy structured gaps", () => {
    const persisted = {
      source: "tradier-options",
      provider: "tradier",
      message: "Persisted override",
      cause: "missing-credential",
      triage: "material",
    } satisfies SourceGap;
    const legacy = {
      source: "tradier-options",
      provider: "tradier",
      message: "MARKET_BOT_TRADIER_API_TOKEN is not set",
      cause: "missing-credential",
    } satisfies SourceGap;

    const projection = projectEquityReader({
      report: {
        symbol: "AAPL",
        dataGaps: [
          "tradier-options: Persisted override",
          "tradier-options: MARKET_BOT_TRADIER_API_TOKEN is not set",
        ],
      },
      sourceGaps: [persisted, legacy],
    });

    expect(classifyGap(persisted)).toBe("diagnostic");
    expect(projection.defaultView.materialGaps).toEqual(["tradier-options: Persisted override"]);
    expect(projection.appendix.diagnosticGaps).toEqual([
      "tradier-options: MARKET_BOT_TRADIER_API_TOKEN is not set",
    ]);
  });
});

describe("equity reader company description", () => {
  test("prioritizes the profile summary and filters citations to known report sources", () => {
    const description = projectEquityReader({
      report: {
        sources: [{ id: "known-source" }],
        extras: {
          webSubjectProfile: {
            subjectSummary: {
              answer: "Profile summary wins.",
              sourceIds: ["unknown-source", "known-source"],
            },
            questions: {
              whatItDoes: { answer: "Question fallback.", sourceIds: ["known-source"] },
            },
          },
          businessFramework: {
            sections: [
              { name: "Business", summary: "Framework fallback.", sourceIds: ["known-source"] },
            ],
          },
        },
      },
    }).defaultView.companyDescription;

    expect(description).toEqual({
      status: "available",
      text: "Profile summary wins.",
      sourceIds: ["known-source"],
    });
  });

  test("falls through from an empty profile answer to what-it-does, then to the framework", () => {
    const questionDescription = projectEquityReader({
      report: {
        sources: [{ id: "question-source" }],
        extras: {
          webSubjectProfile: {
            subjectSummary: { answer: "", sourceIds: [] },
            questions: {
              whatItDoes: {
                answer: "Makes industrial sensors.",
                sourceIds: ["question-source"],
              },
            },
          },
          businessFramework: {
            sections: [{ name: "Business", summary: "Framework description." }],
          },
        },
      },
    }).defaultView.companyDescription;
    const frameworkDescription = projectEquityReader({
      report: {
        sources: [{ id: "framework-source" }],
        extras: {
          businessFramework: {
            sections: [
              {
                name: "Business",
                posture: "supported",
                text: "Business supported Builds satellite communications networks.",
                sourceIds: ["framework-source", "unknown-source"],
              },
            ],
          },
        },
      },
    }).defaultView.companyDescription;

    expect(questionDescription).toEqual({
      status: "available",
      text: "Makes industrial sensors.",
      sourceIds: ["question-source"],
    });
    expect(frameworkDescription).toEqual({
      status: "available",
      text: "Builds satellite communications networks.",
      sourceIds: ["framework-source"],
    });
  });

  test("returns the deterministic unavailable description when no candidate is usable", () => {
    expect(
      projectEquityReader({
        report: {
          sources: [{ id: "known-source" }],
          extras: {
            businessFramework: {
              sections: [
                {
                  name: "Business",
                  text: "Business insufficient data",
                  sourceIds: ["unknown-source"],
                },
              ],
            },
          },
        },
      }).defaultView.companyDescription,
    ).toEqual({
      status: "unavailable",
      text: "No cited plain-language company description is available.",
      sourceIds: [],
    });
  });
});
