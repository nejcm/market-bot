import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence, ResearchReport } from "../src/domain/types";
import { validateResearchReport } from "../src/report/schema";
import {
  deriveEquityAnalysisCompleteness,
  operatingKpisDimension,
} from "../src/sources/extended-evidence/equity-analysis-completeness";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import type {
  FinancialStatementSeries,
  FinancialStatementsArtifact,
} from "../src/sources/extended-evidence/financial-statements-contract";
import type { CapitalOwnershipArtifact } from "../src/sources/extended-evidence/capital-ownership";
import type { OperatingKpiRegistryEntry } from "../src/sources/extended-evidence/operating-kpi-registry";

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

function instantFact(input: {
  readonly value: number;
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
  readonly analysisAsOf?: string;
  readonly currentSemiannual?: boolean;
  readonly fourQuarters?: boolean;
}) {
  const taxonomy = input.taxonomy ?? "us-gaap";
  const annualForm = input.annualForm ?? "10-K";
  const interimForm = input.interimForm ?? "10-Q";
  const concepts =
    taxonomy === "us-gaap"
      ? {
          revenue: "Revenues",
          operatingIncome: "OperatingIncomeLoss",
          netIncome: "NetIncomeLoss",
          operatingCashFlow: "NetCashProvidedByUsedInOperatingActivities",
          dilutedEps: "EarningsPerShareDiluted",
          cash: "CashAndCashEquivalentsAtCarryingValue",
          totalAssets: "Assets",
          totalLiabilities: "Liabilities",
          equity: "StockholdersEquity",
        }
      : {
          revenue: "Revenue",
          operatingIncome: "ProfitLossFromOperatingActivities",
          netIncome: "ProfitLoss",
          operatingCashFlow: "CashFlowsFromUsedInOperatingActivities",
          dilutedEps: "DilutedEarningsLossPerShare",
          cash: "CashAndCashEquivalents",
          totalAssets: "Assets",
          totalLiabilities: "Liabilities",
          equity: "Equity",
        };
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
      ...(input.currentSemiannual
        ? [
            fact({
              value: 1100,
              start: "2026-01-01",
              end: "2026-06-30",
              form: interimForm,
              fy: 2026,
              fp: "H1",
              filed: "2026-08-20",
            }),
          ]
        : []),
    ];
  } else if (input.cadence !== "annual-only") {
    interim = input.fourQuarters
      ? [
          ["2025-10-01", "2025-12-31", "Q4", "2026-02-10"],
          ["2026-01-01", "2026-03-31", "Q1", "2026-05-10"],
          ["2026-04-01", "2026-06-30", "Q2", "2026-08-10"],
          ["2026-07-01", "2026-09-30", "Q3", "2026-11-10"],
        ].map(([start, end, fp, filed], index) =>
          fact({
            value: 400 + index * 50,
            start: start as string,
            end: end as string,
            form: interimForm,
            fy: 2026,
            fp: fp as string,
            filed: filed as string,
          }),
        )
      : [
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
  const durations = [...annual, ...interim];
  let latestInstant: Record<string, unknown> | null = null;
  if (
    input.cadence !== "annual-only" &&
    (input.cadence !== "semiannual" || input.currentSemiannual)
  ) {
    let end = "2026-03-31";
    let fp = "Q1";
    let filed = "2026-05-10";
    if (input.cadence === "semiannual") {
      end = "2026-06-30";
      fp = "H1";
      filed = "2026-08-20";
    } else if (input.fourQuarters) {
      end = "2026-09-30";
      fp = "Q3";
      filed = "2026-11-10";
    }
    latestInstant = instantFact({
      value: 110,
      end,
      form: interimForm,
      fy: 2026,
      fp,
      filed,
    });
  }
  const instant = [
    instantFact({
      value: 100,
      end: "2025-12-31",
      form: annualForm,
      fy: 2025,
      fp: "FY",
      filed: "2026-03-15",
    }),
    ...(latestInstant === null ? [] : [latestInstant]),
  ];
  return deriveFinancialStatements(
    {
      facts: {
        [taxonomy]: {
          [concepts.revenue]: { units: { USD: durations } },
          [concepts.operatingIncome]: { units: { USD: durations } },
          [concepts.netIncome]: { units: { USD: durations } },
          [concepts.operatingCashFlow]: { units: { USD: durations } },
          [concepts.dilutedEps]: {
            units: {
              "USD/shares": durations.map((item) => ({ ...item, val: Number(item.val) / 100 })),
            },
          },
          [concepts.cash]: { units: { USD: instant } },
          [concepts.totalAssets]: { units: { USD: instant } },
          [concepts.totalLiabilities]: { units: { USD: instant } },
          [concepts.equity]: { units: { USD: instant } },
        },
      },
    },
    {
      symbol: "TEST",
      generatedAt: input.analysisAsOf ?? AS_OF,
      analysisAsOf: input.analysisAsOf ?? AS_OF,
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

function withRevenue(
  artifact: FinancialStatementsArtifact,
  revenue: FinancialStatementSeries,
): FinancialStatementsArtifact {
  return {
    ...artifact,
    statements: {
      ...artifact.statements,
      incomeStatement: { ...artifact.statements.incomeStatement, revenue },
    },
  };
}

function withDilutedEps(
  artifact: FinancialStatementsArtifact,
  dilutedEps: FinancialStatementSeries,
): FinancialStatementsArtifact {
  return {
    ...artifact,
    statements: {
      ...artifact.statements,
      perShare: { ...artifact.statements.perShare, dilutedEps },
    },
  };
}

function primaryReasons(artifact: FinancialStatementsArtifact, asOf = AS_OF): readonly string[] {
  return deriveEquityAnalysisCompleteness({
    asOf,
    assetClass: "equity",
    financialStatements: artifact,
  }).dimensions.primaryFinancials.reasonCodes;
}

function withoutTtm(series: FinancialStatementSeries): FinancialStatementSeries {
  const { ttm: _ttm, ...rest } = series;
  return rest;
}

function withoutReportingCurrency(
  artifact: FinancialStatementsArtifact,
): FinancialStatementsArtifact {
  const { reportingCurrency: _reportingCurrency, ...rest } = artifact;
  return rest;
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

function capitalOwnership(
  overrides: Partial<CapitalOwnershipArtifact> = {},
): CapitalOwnershipArtifact {
  const periods = [2023, 2024, 2025].map((year) => ({
    value: 100,
    periodStart: `${String(year)}-01-01`,
    periodEnd: `${String(year)}-12-31`,
    filedAt: `${String(year + 1)}-02-15`,
    form: "10-K",
    taxonomy: "us-gaap" as const,
    concept: "WeightedAverageNumberOfDilutedSharesOutstanding",
    unit: "shares",
    sourceIds: [SOURCE_ID],
  }));
  return {
    version: 1,
    generatedAt: AS_OF,
    symbol: "TEST",
    dilutedShares: periods,
    stockBasedCompensation: periods.map((period) => ({
      ...period,
      concept: "ShareBasedCompensation",
      unit: "USD",
    })),
    buybacks: periods.map((period) => ({
      ...period,
      concept: "PaymentsForRepurchaseOfCommonStock",
      unit: "USD",
    })),
    dividendsPaid: [],
    omissions: [],
    ...overrides,
  };
}

describe("equity analysis completeness", () => {
  test("completes domestic and foreign quarterly profiles", () => {
    const domestic = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      financialStatements: statements({ cadence: "quarterly" }),
    });
    const foreign = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
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
      assetClass: "equity",
      financialStatements: statements({
        taxonomy: "ifrs-full",
        annualForm: "20-F",
        interimForm: "6-K",
        cadence: "semiannual",
      }),
    });

    expect(result.financialCoreStatus).toBe("complete");
    expect(result.dimensions.primaryFinancials.reasonCodes).toEqual(["annual-as-current"]);
  });

  test("accepts 20-F annual evidence but keeps untagged interim evidence partial", () => {
    const result = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
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

  test("covers quarterly missing-period and unreconciled-TTM reasons", () => {
    const artifact = statements({ cadence: "quarterly" });
    const { revenue } = artifact.statements.incomeStatement;
    const reasons = primaryReasons(withRevenue(artifact, { ...withoutTtm(revenue), interim: [] }));

    expect(reasons).toEqual(
      expect.arrayContaining([
        "latest-due-interim-missing",
        "quarterly-periods-insufficient",
        "ttm-unreconciled",
      ]),
    );
  });

  test("accepts four retained quarter-only periods without a reconciled TTM", () => {
    const asOf = "2026-12-15T00:00:00.000Z";
    const artifact = statements({ cadence: "quarterly", fourQuarters: true, analysisAsOf: asOf });

    expect(artifact.statements.incomeStatement.revenue.ttm).toBeUndefined();
    expect(
      deriveEquityAnalysisCompleteness({
        asOf,
        assetClass: "equity",
        financialStatements: artifact,
      }),
    ).toMatchObject({
      financialCoreStatus: "complete",
      dimensions: { primaryFinancials: { reasonCodes: [] } },
    });
  });

  test("covers semiannual comparison gaps and the reconciled H1 complete path", () => {
    const asOf = "2026-12-15T00:00:00.000Z";
    const complete = statements({
      taxonomy: "ifrs-full",
      annualForm: "20-F",
      interimForm: "6-K",
      cadence: "semiannual",
      currentSemiannual: true,
      analysisAsOf: asOf,
    });
    const { revenue } = complete.statements.incomeStatement;
    const withoutComparison = withRevenue(complete, {
      ...withoutTtm(revenue),
      interim: revenue.interim.filter((item) => item.periodEnd > "2025-12-31"),
    });

    expect(primaryReasons(withoutComparison, asOf)).toEqual(
      expect.arrayContaining(["semiannual-comparison-missing", "ttm-unreconciled"]),
    );
    expect(
      deriveEquityAnalysisCompleteness({
        asOf,
        assetClass: "equity",
        financialStatements: complete,
      }),
    ).toMatchObject({
      financialCoreStatus: "complete",
      dimensions: { primaryFinancials: { reasonCodes: [] } },
    });
  });

  test("covers irregular comparison and TTM reasons", () => {
    const base = statements({ cadence: "quarterly" });
    const { revenue } = base.statements.incomeStatement;
    const artifact = withRevenue(
      { ...base, interimCadence: "irregular" },
      {
        ...withoutTtm(revenue),
        interim: revenue.interim.filter((item) => item.periodEnd > "2025-12-31"),
      },
    );

    expect(primaryReasons(artifact)).toEqual(
      expect.arrayContaining(["irregular-comparison-missing", "ttm-unreconciled"]),
    );
  });

  test("does not treat absent per-share evidence as non-issuance", () => {
    const artifact = statements({ cadence: "quarterly" });
    const { dilutedEps } = artifact.statements.perShare;

    expect(
      primaryReasons(
        withDilutedEps(artifact, { ...withoutTtm(dilutedEps), annual: [], interim: [] }),
      ),
    ).toContain("per-share-evidence-missing");
  });

  test("covers annual history and reporting-currency reasons", () => {
    const artifact = statements({ cadence: "quarterly" });
    const { revenue } = artifact.statements.incomeStatement;
    const shortHistory = withRevenue(artifact, { ...revenue, annual: revenue.annual.slice(-2) });

    expect(primaryReasons(shortHistory)).toContain("annual-history-insufficient");
    expect(primaryReasons(withoutReportingCurrency(artifact))).toContain(
      "reporting-currency-missing",
    );
    expect(primaryReasons({ ...artifact, reportingCurrency: "EUR" })).toContain(
      "reporting-currency-incompatible",
    );
  });

  test("consumes current incomplete-statement notes but ignores historical ones", () => {
    const artifact = statements({ cadence: "quarterly" });
    const currentInterim = artifact.statements.incomeStatement.revenue.interim.at(-1);
    if (currentInterim === undefined) {
      throw new Error("Expected a current interim revenue fact");
    }
    const currentNote = {
      code: "incomplete-statement" as const,
      periodKey: `interim|${currentInterim.periodKey}`,
      message: `balanceSheet interim period ${currentInterim.periodKey} is missing cash, totalAssets, totalLiabilities, stockholdersEquity`,
    };
    const historicalNote = {
      ...currentNote,
      periodKey: "annual|2023-01-01|2023-12-31",
    };

    expect(
      primaryReasons({ ...artifact, validationNotes: [...artifact.validationNotes, currentNote] }),
    ).toContain("current-primary-statements-incomplete");
    expect(
      primaryReasons({
        ...artifact,
        validationNotes: [...artifact.validationNotes, historicalNote],
      }),
    ).not.toContain("current-primary-statements-incomplete");
  });

  test("blocks a stale annual basis older than 550 days", () => {
    const result = deriveEquityAnalysisCompleteness({
      asOf: "2027-08-01T00:00:00.000Z",
      assetClass: "equity",
      financialStatements: statements({ cadence: "quarterly" }),
    });

    expect(result.financialCoreStatus).toBe("blocked");
    expect(result.dimensions.primaryFinancials.reasonCodes).toEqual([
      "current-annual-statement-missing",
    ]);
  });

  test("derives limited, substantial, and comprehensive coverage independently", () => {
    const financialStatements = statements({ cadence: "quarterly" });
    const comprehensive = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      symbol: "TEST",
      financialStatements,
      extendedEvidence: comprehensiveEvidence(),
      earningsSetup,
      capitalOwnership: capitalOwnership(),
    });
    const substantial = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      symbol: "TEST",
      financialStatements,
      extendedEvidence: {
        ...comprehensiveEvidence(),
        items: comprehensiveEvidence().items.slice(0, 2),
      },
      earningsSetup,
      capitalOwnership: capitalOwnership(),
    });
    const limited = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      symbol: "TEST",
      financialStatements,
    });
    const blocked = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      symbol: "TEST",
      extendedEvidence: comprehensiveEvidence(),
      earningsSetup,
    });

    expect(comprehensive.coverageLevel).toBe("substantial");
    expect(substantial.coverageLevel).toBe("substantial");
    expect(limited.coverageLevel).toBe("limited");
    expect(blocked.financialCoreStatus).toBe("blocked");
    expect(blocked.coverageLevel).toBe("limited");
  });

  test("preserves calendar estimates as a complete fallback across provider entitlement gaps", () => {
    const result = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      earningsSetup,
      analystExpectationsSignal: { status: "forbidden", sourceIds: [] },
    });

    expect(result.dimensions.expectations).toEqual({
      status: "complete",
      reasonCodes: [],
      asOf: AS_OF,
      sourceIds: [SOURCE_ID],
    });
  });

  test("keeps populated but incomplete estimate responses partial", () => {
    const result = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      analystExpectations: {
        version: 1,
        generatedAt: AS_OF,
        symbol: "TEST",
        estimates: {
          eps: {
            provider: "finnhub",
            consensus: [{ mean: 1 }],
            sourceIds: ["eps-source"],
            observedAt: AS_OF,
          },
          revenue: {
            provider: "finnhub",
            consensus: [],
            sourceIds: ["revenue-source"],
            observedAt: AS_OF,
          },
        },
      },
      analystExpectationsSignal: {
        status: "available",
        sourceIds: ["eps-source", "revenue-source"],
      },
    });

    expect(result.dimensions.expectations).toEqual({
      status: "partial",
      reasonCodes: ["expectations-inputs-incomplete"],
      asOf: AS_OF,
      sourceIds: ["eps-source", "revenue-source"],
    });
  });

  test("grades capital ownership from filed histories and precise reasons", () => {
    const complete = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      capitalOwnership: capitalOwnership(),
    });
    const partial = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      capitalOwnership: capitalOwnership({
        stockBasedCompensation: [],
        buybacks: [],
        omissions: [
          { code: "debt-maturity-untagged", message: "Debt maturity buckets are missing" },
        ],
        subsequentFinancing: {
          eventCount: 1,
          reconciled: false,
          sourceIds: [SOURCE_ID],
        },
      }),
    });

    expect(complete.dimensions.capitalOwnership.status).toBe("complete");
    expect(partial.dimensions.capitalOwnership).toMatchObject({
      status: "partial",
      reasonCodes: [
        "sbc-history-missing",
        "payout-evidence-missing",
        "debt-maturity-untagged",
        "subsequent-financing-unreconciled",
      ],
    });
    expect(partial.financialCoreStatus).toBe("blocked");
  });

  test("adds ownership context without changing the SEC-governed capital status", () => {
    const secComplete = capitalOwnership();
    const baseline = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      capitalOwnership: secComplete,
    });
    const available = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      capitalOwnership: secComplete,
      institutionalOwnershipSignal: {
        status: "available",
        sourceIds: ["ownership-source"],
      },
    });
    const forbidden = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      capitalOwnership: secComplete,
      institutionalOwnershipSignal: { status: "forbidden", sourceIds: [] },
    });

    expect(available.dimensions.capitalOwnership).toEqual({
      ...baseline.dimensions.capitalOwnership,
      reasonCodes: ["ownership-external-context-available"],
      sourceIds: [...baseline.dimensions.capitalOwnership.sourceIds, "ownership-source"],
    });
    expect(forbidden.dimensions.capitalOwnership).toEqual({
      ...baseline.dimensions.capitalOwnership,
      reasonCodes: ["ownership-provider-entitlement-blocked"],
    });
    expect(available.coverageLevel).toBe(baseline.coverageLevel);
    expect(forbidden.coverageLevel).toBe(baseline.coverageLevel);
  });

  test("keeps unconfigured issuer operating KPIs partial", () => {
    const result = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      symbol: "AAPL",
      extendedEvidence: comprehensiveEvidence(),
    });

    expect(result.dimensions.operatingKpis).toEqual({
      status: "partial",
      reasonCodes: ["operating-kpi-registry-unconfigured"],
      asOf: AS_OF,
      sourceIds: [],
    });
  });

  test("enumerates declared but unverified ASTS operating KPIs", () => {
    const result = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
      symbol: "asts",
    });

    expect(result.dimensions.operatingKpis).toEqual({
      status: "partial",
      reasonCodes: [
        "operating-kpi-unverified:asts-satellites-launched",
        "operating-kpi-unverified:asts-satellites-operational",
      ],
      asOf: AS_OF,
      sourceIds: [],
    });
  });

  test("requires run-present evidence for declared operating-KPI non-applicability", () => {
    const registry: readonly OperatingKpiRegistryEntry[] = [
      {
        symbol: "TEST",
        assetClass: "equity",
        applicability: "not-applicable",
        kpis: [],
        notApplicable: {
          reasonCode: "issuer-has-no-material-operating-kpis",
          evidenceCategories: ["sec-edgar"],
        },
      },
    ];
    const input = {
      asOf: AS_OF,
      assetClass: "equity" as const,
      symbol: "TEST",
    };

    expect(operatingKpisDimension(input, registry)).toMatchObject({
      status: "partial",
      reasonCodes: ["operating-kpi-not-applicable-evidence-missing"],
      sourceIds: [],
    });
    expect(
      operatingKpisDimension({ ...input, extendedEvidence: comprehensiveEvidence() }, registry),
    ).toEqual({
      status: "not-applicable",
      reasonCodes: ["issuer-has-no-material-operating-kpis"],
      asOf: AS_OF,
      sourceIds: [SOURCE_ID],
    });
  });

  test("validates the public contract and rejects credential-based non-applicability", () => {
    const completeness = deriveEquityAnalysisCompleteness({
      asOf: AS_OF,
      assetClass: "equity",
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
