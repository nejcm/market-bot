import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence, ResearchReport } from "../src/domain/types";
import { validateResearchReport } from "../src/report/schema";
import { deriveEquityAnalysisCompleteness } from "../src/sources/extended-evidence/equity-analysis-completeness";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";

const AS_OF = "2026-06-15T14:30:00.000Z";
const SOURCE_ID = "extended-sec-edgar-test-fundamentals";

function fact(input: {
  readonly value: number;
  readonly start: string;
  readonly end: string;
  readonly form: "10-K" | "10-Q" | "20-F" | "6-K";
  readonly fy: number;
  readonly fp: string;
  readonly filed: string;
}): Record<string, unknown> {
  return { ...input, val: input.value, accn: `${input.filed}-${input.form}-${input.fp}` };
}

function statements(input: {
  readonly taxonomy?: "us-gaap" | "ifrs-full";
  readonly annualForm?: "10-K" | "20-F";
  readonly interimForm?: "10-Q" | "6-K";
  readonly cadence?: "quarterly" | "semiannual" | "annual-only";
  readonly untaggedSixK?: boolean;
}) {
  const taxonomy = input.taxonomy ?? "us-gaap";
  const annualForm = input.annualForm ?? "10-K";
  const interimForm = input.interimForm ?? "10-Q";
  const concept = taxonomy === "us-gaap" ? "Revenues" : "Revenue";
  const annual = [2023, 2024, 2025].map((year) =>
    fact({
      value: year * 100,
      start: `${String(year)}-01-01`,
      end: `${String(year)}-12-31`,
      form: annualForm,
      fy: year,
      fp: "FY",
      filed: `${String(year + 1)}-03-15`,
    }),
  );
  let interim: readonly Record<string, unknown>[] = [];
  if (input.cadence === "semiannual") {
    interim = [
      fact({
        value: 900,
        start: "2025-01-01",
        end: "2025-06-30",
        form: interimForm,
        fy: 2025,
        fp: "H1",
        filed: "2025-08-20",
      }),
    ];
  } else if (input.cadence !== "annual-only") {
    interim = [
      fact({
        value: 500,
        start: "2025-01-01",
        end: "2025-03-31",
        form: interimForm,
        fy: 2025,
        fp: "Q1",
        filed: "2025-05-10",
      }),
      fact({
        value: 600,
        start: "2026-01-01",
        end: "2026-03-31",
        form: interimForm,
        fy: 2026,
        fp: "Q1",
        filed: "2026-05-10",
      }),
    ];
  }
  const submissionsPayload = input.untaggedSixK
    ? {
        filings: {
          recent: {
            form: ["20-F", "6-K"],
            filingDate: ["2026-03-15", "2026-05-10"],
            accessionNumber: ["annual", "untagged-interim"],
            reportDate: ["2025-12-31", "2026-03-31"],
          },
        },
      }
    : undefined;
  return deriveFinancialStatements(
    {
      facts: {
        [taxonomy]: {
          [concept]: { units: { USD: [...annual, ...interim] } },
        },
      },
    },
    {
      symbol: "TEST",
      generatedAt: AS_OF,
      analysisAsOf: AS_OF,
      sourceId: SOURCE_ID,
      ...(submissionsPayload !== undefined
        ? { submissionsPayload, submissionsSourceId: SOURCE_ID }
        : {}),
    },
  );
}

function comprehensiveEvidence(): ExtendedEvidence {
  return {
    items: [
      {
        category: "valuation",
        title: "Valuation",
        summary: "Valuation inputs",
        observedAt: AS_OF,
        sourceIds: [SOURCE_ID],
        metrics: { enterpriseValue: 100, annualizedRevenue: 50 },
      },
      {
        category: "yahoo-fundamentals",
        title: "Fundamentals",
        summary: "Share evidence",
        observedAt: AS_OF,
        sourceIds: [SOURCE_ID],
        metrics: { sharesOutstanding: 10 },
      },
      {
        category: "sec-edgar",
        title: "Operating evidence",
        summary: "Operating evidence",
        observedAt: AS_OF,
        sourceIds: [SOURCE_ID],
        metrics: { revenue: 10, grossProfit: 5, operatingIncome: 3, netIncome: 2 },
      },
    ],
    gaps: [],
  };
}

const earningsSetup = {
  event: {
    symbol: "TEST",
    date: "2026-07-10",
    timing: "amc" as const,
    epsEstimate: 1,
    revenueEstimate: 10,
    sourceIds: [SOURCE_ID],
    fetchedAt: AS_OF,
  },
  gaps: [],
};

describe("equity analysis completeness", () => {
  test("completes domestic and foreign quarterly profiles", () => {
    const domestic = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      financialStatements: statements({ cadence: "quarterly" }),
    });
    const foreign = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      financialStatements: statements({
        annualForm: "20-F",
        interimForm: "6-K",
        cadence: "quarterly",
      }),
    });

    expect(domestic.financialCoreStatus).toBe("complete");
    expect(foreign.financialCoreStatus).toBe("complete");
  });

  test("completes semiannual IFRS while the next half-year is not yet due", () => {
    const result = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      financialStatements: statements({
        taxonomy: "ifrs-full",
        annualForm: "20-F",
        interimForm: "6-K",
        cadence: "semiannual",
      }),
    });

    expect(result.financialCoreStatus).toBe("complete");
    expect(result.dimensions.primaryFinancials.reasonCodes).toEqual([]);
  });

  test("accepts 20-F annual evidence but keeps untagged interim evidence partial", () => {
    const result = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      financialStatements: statements({
        annualForm: "20-F",
        cadence: "annual-only",
        untaggedSixK: true,
      }),
    });

    expect(result.financialCoreStatus).toBe("partial");
    expect(result.dimensions.primaryFinancials.reasonCodes).toEqual(
      expect.arrayContaining(["cadence-unestablished", "untagged-interim-evidence"]),
    );
    expect(result.dimensions.primaryFinancials.reasonCodes).not.toContain(
      "current-annual-statement-missing",
    );
  });

  test("derives limited, substantial, and comprehensive coverage independently", () => {
    const financialStatements = statements({ cadence: "quarterly" });
    const comprehensive = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      financialStatements,
      extendedEvidence: comprehensiveEvidence(),
      earningsSetup,
    });
    const substantial = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      financialStatements,
      extendedEvidence: {
        ...comprehensiveEvidence(),
        items: comprehensiveEvidence().items.slice(0, 2),
      },
      earningsSetup,
    });
    const limited = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      financialStatements,
    });
    const blocked = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      extendedEvidence: comprehensiveEvidence(),
      earningsSetup,
    });

    expect(comprehensive.coverageLevel).toBe("comprehensive");
    expect(substantial.coverageLevel).toBe("substantial");
    expect(limited.coverageLevel).toBe("limited");
    expect(blocked.financialCoreStatus).toBe("blocked");
    expect(blocked.coverageLevel).toBe("limited");
  });

  test("validates the public contract and rejects credential-based non-applicability", () => {
    const completeness = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      financialStatements: statements({ cadence: "quarterly" }),
    });
    const report: ResearchReport = {
      runId: "run-1",
      jobType: "equity",
      assetClass: "equity",
      symbol: "TEST",
      generatedAt: AS_OF,
      summary: "Research summary.",
      keyFindings: [],
      bullCase: [],
      bearCase: [],
      risks: [],
      catalysts: [],
      scenarios: [],
      evidenceQuality: "medium",
      dataGaps: [],
      predictions: [],
      sources: [
        {
          id: SOURCE_ID,
          title: "SEC evidence",
          fetchedAt: AS_OF,
          kind: "extended-evidence",
          assetClass: "equity",
          symbol: "TEST",
        },
      ],
      equityAnalysisCompleteness: completeness,
      notFinancialAdvice: true,
    };
    expect(validateResearchReport(report).equityAnalysisCompleteness).toEqual(completeness);

    const invalid = {
      ...report,
      equityAnalysisCompleteness: {
        ...completeness,
        dimensions: {
          ...completeness.dimensions,
          operatingKpis: {
            status: "not-applicable" as const,
            reasonCodes: ["missing-credential"],
            asOf: AS_OF,
            sourceIds: [SOURCE_ID],
          },
        },
      },
    };
    expect(() => validateResearchReport(invalid)).toThrow("requires affirmative evidence");
  });
});
