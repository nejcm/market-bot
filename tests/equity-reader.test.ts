import { describe, expect, test } from "bun:test";
import type { SourceGap } from "../src/domain/types";
import { projectEquityReader } from "../src/report/equity-reader";
import { classifyGap } from "../src/report/gap-triage";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementsArtifact,
} from "../src/sources/extended-evidence/financial-statements-contract";

function statementFact(
  key: "cash" | "debt" | "dilutedShares",
  value: number,
  filedAt: string,
): FinancialStatementFact {
  return {
    value,
    periodKey: "annual:2024-12-31",
    periodType: "annual",
    form: filedAt === "2025-03-01" ? "10-K/A" : "10-K",
    canonicalForm: "10-K",
    amendment: filedAt === "2025-03-01",
    accessionNumber: `accession-${key}-${filedAt}`,
    filedAt,
    periodEnd: "2024-12-31",
    fiscalYear: 2024,
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
    annual: values,
    interim: [],
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
      balanceSheet: { cash, debt },
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
      balanceSheet: { cash, debt },
      perShare: { dilutedShares },
    },
  } as unknown as FinancialStatementsArtifact;
}

describe("equity reader projection", () => {
  test("selects amended values and filing dates jointly before the analysis cutoff", () => {
    const projection = projectEquityReader({
      report: { generatedAt: "2025-04-01T12:00:00.000Z" },
      financialStatements: amendedFilingArtifact(),
    });

    expect(projection.appendix.balanceSheetHistory?.rows).toEqual([
      {
        kind: "annual",
        periodEnd: "2024-12-31",
        filedAt: "2025-03-01",
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
        kind: "annual",
        periodEnd: "2024-12-31",
        filedAt: "2025-03-01",
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

  test("projects analyst distributions and prediction shortfalls into appendix groups", () => {
    const projection = projectEquityReader({
      report: {
        symbol: "AAPL",
        dataGaps: [
          "predictionShortfall: emitted 1 of 3",
          "Primary revenue evidence missing.",
          "tradier: API token missing",
        ],
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

    expect(projection.defaultView.materialGaps).toEqual(["Primary revenue evidence missing."]);
    expect(projection.appendix.diagnosticGaps).toEqual(["tradier: API token missing"]);
    expect(projection.appendix.predictionShortfalls).toEqual([
      "predictionShortfall: emitted 1 of 3",
    ]);
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
      message: "Legacy fallback",
      cause: "missing-credential",
    } satisfies SourceGap;

    const projection = projectEquityReader({
      report: {
        symbol: "AAPL",
        dataGaps: ["tradier-options: Persisted override", "tradier-options: Legacy fallback"],
      },
      sourceGaps: [persisted, legacy],
    });

    expect(classifyGap(persisted)).toBe("diagnostic");
    expect(projection.defaultView.materialGaps).toEqual(["tradier-options: Persisted override"]);
    expect(projection.appendix.diagnosticGaps).toEqual(["tradier-options: Legacy fallback"]);
  });
});
