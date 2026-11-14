import { describe, expect, test } from "bun:test";
import {
  deriveFinancialStatements,
  financialStatementsHistoryGaps,
  withinRetainedWindow,
} from "../src/sources/extended-evidence/financial-statements";
import {
  grossPrincipalWithholdsDebt,
  unprovenRestatements,
} from "../src/sources/extended-evidence/financial-statement-period-identity";
import { valuationPeriodInputs } from "../src/sources/extended-evidence/valuation-workbench-inputs";
import { balanceSheetHistory, operatingRatioNotes } from "../src/report/equity-reader-statements";
import { fundamentalHistoryView } from "../app/client/run-workspace-financials";
import { financialTrends } from "../src/report/equity-reader-trends";
import {
  financialStatementFacts,
  latestFinancialStatementFact,
} from "../src/sources/extended-evidence/financial-statement-selection";
import {
  canonicalizeSecForm,
  derivedFactDisclosure,
  type FinancialStatementFact,
  type FinancialStatementNote,
  type FinancialStatementSeriesKey,
  type FinancialStatementSeries,
} from "../src/sources/extended-evidence/financial-statements-contract";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import { deriveFundamentalHistoryFromFinancialStatements } from "../src/sources/extended-evidence/fundamental-history-canonical";
import type { RunSummary } from "../src/run-artifact-index-types";
import { summarizeSecFundamentals } from "../src/sources/extended-evidence/sec-edgar";
import { addValuationEvidence } from "../src/sources/extended-evidence/valuation";
import {
  collectValuationComps,
  MIXED_PERIOD_METRIC,
} from "../src/sources/extended-evidence/valuation-comps";
import { buildValuationWorkbench } from "../src/sources/extended-evidence/valuation-workbench";
import { marketSnapshot } from "./support/fixtures";
import { financialStatementsDebtBasisGaps } from "../src/sources/extended-evidence/sec-debt";
import { withoutTranslationFilings } from "../src/sources/extended-evidence/financial-statement-taxonomy";

interface FactInput {
  readonly value: number;
  readonly form: string;
  readonly fiscalYear?: number;
  readonly fiscalPeriod: string;
  readonly filedAt: string;
  readonly periodEnd: string;
  readonly periodStart?: string;
  readonly accessionNumber?: string;
}

function fact(input: FactInput): Record<string, unknown> {
  return {
    val: input.value,
    form: input.form,
    ...(input.fiscalYear !== undefined ? { fy: input.fiscalYear } : {}),
    fp: input.fiscalPeriod,
    filed: input.filedAt,
    end: input.periodEnd,
    accn:
      input.accessionNumber ??
      `${input.filedAt.replaceAll("-", "")}-${input.form.replaceAll("/", "-")}`,
    ...(input.periodStart !== undefined ? { start: input.periodStart } : {}),
  };
}

function annualAccessions(series: FinancialStatementSeries): readonly string[] {
  return series.annual.map(
    ({ periodEnd, accessionNumber }) => `${periodEnd} ${String(accessionNumber)}`,
  );
}

function withoutStart(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([field]) => field !== "start"));
}

function withoutAccession(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([field]) => field !== "accn"));
}

function payload(
  taxonomies: Readonly<
    Record<
      string,
      Readonly<Record<string, Readonly<Record<string, readonly Record<string, unknown>[]>>>>
    >
  >,
): unknown {
  return {
    facts: Object.fromEntries(
      Object.entries(taxonomies).map(([taxonomy, concepts]) => [
        taxonomy,
        Object.fromEntries(
          Object.entries(concepts).map(([concept, units]) => [concept, { units }]),
        ),
      ]),
    ),
  };
}

function derive(
  companyFacts: unknown,
  overrides: Partial<Parameters<typeof deriveFinancialStatements>[1]> = {},
) {
  return deriveFinancialStatements(companyFacts, {
    symbol: "TEST",
    generatedAt: "2026-06-15T00:00:00.000Z",
    analysisAsOf: "2026-06-15T00:00:00.000Z",
    sourceId: "extended-sec-edgar-test-fundamentals",
    ...overrides,
  });
}

function windowFact(key: string, end: string): FinancialStatementFact {
  return {
    periodKey: `${key}|${end}`,
    periodStart: "2000-01-01",
    periodEnd: end,
  } as FinancialStatementFact;
}

function windowSeries(
  key: string,
  facts: readonly FinancialStatementFact[],
): FinancialStatementSeries {
  return { key, annual: facts, interim: [] } as unknown as FinancialStatementSeries;
}

function windowCap(end: string): FinancialStatementNote {
  return { code: "history-cap", periodKey: `annual|duration:12|${end}`, message: "cap" };
}

function windowNote(
  code: FinancialStatementNote["code"],
  seriesKey: FinancialStatementSeriesKey,
  periodKey: string,
): FinancialStatementNote {
  return { code, seriesKey, periodKey, message: code };
}

function historyGapMessages(artifact: ReturnType<typeof derive>): readonly string[] {
  return financialStatementsHistoryGaps(artifact).map((gap) => gap.message);
}

function annualFormMetadata(series: FinancialStatementSeries) {
  return series.annual.map(
    ({ value, form, canonicalForm, periodType, amendment, periodEnd, fiscalYear, currency }) => ({
      value,
      form,
      canonicalForm,
      periodType,
      amendment,
      periodEnd,
      fiscalYear,
      currency,
    }),
  );
}

function annual(value: number, year: number, form = "10-K"): Record<string, unknown> {
  return fact({
    value,
    form,
    fiscalYear: year,
    fiscalPeriod: "FY",
    filedAt: `${String(year + 1)}-02-15`,
    periodStart: `${String(year)}-01-01`,
    periodEnd: `${String(year)}-12-31`,
  });
}

function instant(value: number, year: number, form = "10-K"): Record<string, unknown> {
  return fact({
    value,
    form,
    fiscalYear: year,
    fiscalPeriod: "FY",
    filedAt: `${String(year + 1)}-02-15`,
    periodEnd: `${String(year)}-12-31`,
  });
}

function interim(input: {
  readonly value: number;
  readonly year: number;
  readonly endMonthDay: string;
  readonly form: "10-Q" | "6-K";
  readonly fiscalPeriod: string;
}): Record<string, unknown> {
  return fact({
    value: input.value,
    form: input.form,
    fiscalYear: input.year,
    fiscalPeriod: input.fiscalPeriod,
    filedAt: `${String(input.year)}-08-15`,
    periodStart: `${String(input.year)}-01-01`,
    periodEnd: `${String(input.year)}-${input.endMonthDay}`,
  });
}

describe("canonical financial statements", () => {
  test("canonicalizes supported periodic forms and amendments", () => {
    for (const canonicalForm of ["10-K", "10-Q", "20-F", "6-K"] as const) {
      expect(canonicalizeSecForm(canonicalForm)).toEqual({
        form: canonicalForm,
        canonicalForm,
        amendment: false,
      });
      expect(canonicalizeSecForm(`${canonicalForm}/A`)).toEqual({
        form: `${canonicalForm}/A`,
        canonicalForm,
        amendment: true,
      });
    }
    expect(canonicalizeSecForm("40-F")).toEqual({
      form: "40-F",
      canonicalForm: "40-F",
      amendment: false,
    });
  });

  test("derives pure-MJDS 40-F annual facts", () => {
    const artifact = derive(
      payload({
        "ifrs-full": {
          Revenue: {
            CAD: [
              annual(100, 2024, "40-F"),
              interim({
                value: 60,
                year: 2025,
                endMonthDay: "06-30",
                form: "6-K",
                fiscalPeriod: "H1",
              }),
            ],
          },
          ProfitLoss: {
            CAD: [
              annual(10, 2024, "40-F/A"),
              interim({
                value: 6,
                year: 2025,
                endMonthDay: "06-30",
                form: "6-K",
                fiscalPeriod: "H1",
              }),
            ],
          },
          Assets: {
            CAD: [
              instant(200, 2024, "40-F"),
              fact({
                value: 210,
                form: "6-K",
                fiscalYear: 2025,
                fiscalPeriod: "H1",
                filedAt: "2025-08-15",
                periodEnd: "2025-06-30",
              }),
            ],
          },
        },
      }),
    );

    const { revenue, netIncome } = artifact.statements.incomeStatement;
    const { totalAssets } = artifact.statements.balanceSheet;
    expect(artifact).toMatchObject({
      taxonomy: "ifrs-full",
      reportingCurrency: "CAD",
      structuredFinancialGaps: [],
    });
    // Pins 40-F and 40-F/A as canonical annual facts, including amendment metadata.
    expect({
      revenue: annualFormMetadata(revenue),
      netIncome: annualFormMetadata(netIncome),
      totalAssets: annualFormMetadata(totalAssets),
    }).toEqual({
      revenue: [
        {
          value: 100,
          form: "40-F",
          canonicalForm: "40-F",
          periodType: "annual",
          amendment: false,
          periodEnd: "2024-12-31",
          fiscalYear: 2024,
          currency: "CAD",
        },
      ],
      netIncome: [
        {
          value: 10,
          form: "40-F/A",
          canonicalForm: "40-F",
          periodType: "annual",
          amendment: true,
          periodEnd: "2024-12-31",
          fiscalYear: 2024,
          currency: "CAD",
        },
      ],
      totalAssets: [
        {
          value: 200,
          form: "40-F",
          canonicalForm: "40-F",
          periodType: "annual",
          amendment: false,
          periodEnd: "2024-12-31",
          fiscalYear: 2024,
          currency: "CAD",
        },
      ],
    });
    expect({
      revenue: revenue.interim.map((item) => item.value),
      netIncome: netIncome.interim.map((item) => item.value),
      totalAssets: totalAssets.interim.map((item) => item.value),
    }).toEqual({ revenue: [60], netIncome: [6], totalAssets: [210] });
  });

  test("surfaces standard noncontrolling and temporary-equity facts", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2024)] },
          Assets: { USD: [instant(100, 2024)] },
          Liabilities: { USD: [instant(30, 2024)] },
          StockholdersEquity: { USD: [instant(55, 2024)] },
          StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: {
            USD: [instant(60, 2024)],
          },
          MinorityInterest: { USD: [instant(5, 2024)] },
          RedeemableNoncontrollingInterestEquityCarryingAmount: {
            USD: [instant(10, 2024)],
          },
        },
      }),
    );

    expect(artifact.equityStack).toMatchObject({
      minorityInterest: [{ value: 5, concept: "MinorityInterest" }],
      stockholdersEquityIncludingNoncontrollingInterest: [
        {
          value: 60,
          concept: "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
        },
      ],
      temporaryEquity: [
        {
          value: 10,
          concept: "RedeemableNoncontrollingInterestEquityCarryingAmount",
        },
      ],
    });
  });

  test("keeps equity-stack components compatible with the identity accession", () => {
    const identityFact = (value: number, accessionNumber: string, filedAt: string) =>
      fact({
        value,
        form: "20-F",
        fiscalYear: 2021,
        fiscalPeriod: "FY",
        filedAt,
        periodEnd: "2021-12-31",
        accessionNumber,
      });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2024)] },
          Assets: { USD: [identityFact(100, "identity-accession", "2022-04-20")] },
          Liabilities: { USD: [identityFact(30, "identity-accession", "2022-04-20")] },
          StockholdersEquity: {
            USD: [identityFact(55, "identity-accession", "2022-04-20")],
          },
          StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: {
            USD: [
              identityFact(60, "identity-accession", "2022-04-20"),
              identityFact(52, "later-incompatible-accession", "2025-04-30"),
            ],
          },
          RedeemableNoncontrollingInterestEquityCarryingAmount: {
            USD: [identityFact(10, "identity-accession", "2022-04-20")],
          },
        },
      }),
    );

    expect(
      artifact.equityStack?.stockholdersEquityIncludingNoncontrollingInterest[0],
    ).toMatchObject({ value: 60, accessionNumber: "identity-accession" });
  });

  test("reports equity-stack selection when identity facts share no accession", () => {
    const identityFact = (value: number, accessionNumber: string) =>
      fact({
        value,
        form: "10-K",
        fiscalYear: 2025,
        fiscalPeriod: "FY",
        filedAt: "2026-02-15",
        periodEnd: "2025-12-31",
        accessionNumber,
      });
    const artifact = derive(
      payload({
        "us-gaap": {
          Assets: { USD: [identityFact(100, "assets-accession")] },
          Liabilities: { USD: [identityFact(30, "liabilities-accession")] },
          StockholdersEquity: { USD: [identityFact(60, "equity-accession")] },
          TemporaryEquityCarryingAmount: { USD: [identityFact(10, "equity-accession")] },
        },
      }),
    );

    expect(artifact.validationNotes).toContainEqual({
      code: "mixed-accessions",
      message:
        "Total assets and total liabilities for 2025-12-31 do not share an SEC accession; equity-stack component selection uses standard precedence",
      periodKey: "instant|2025-12-31",
    });
  });

  test("applies cutoff before period-key restatement precedence", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: {
            USD: [
              fact({
                value: 100,
                form: "10-K",
                fiscalYear: 2024,
                fiscalPeriod: "FY",
                filedAt: "2025-03-01",
                periodStart: "2024-01-01",
                periodEnd: "2024-12-31",
                accessionNumber: "0001-original",
              }),
              fact({
                value: 110,
                form: "10-K/A",
                fiscalYear: 2024,
                fiscalPeriod: "FY",
                filedAt: "2025-03-01",
                periodStart: "2024-01-01",
                periodEnd: "2024-12-31",
                accessionNumber: "0001-amendment",
              }),
              fact({
                value: 111,
                form: "10-K/A",
                fiscalYear: 2024,
                fiscalPeriod: "FY",
                filedAt: "2025-03-01",
                periodStart: "2024-01-01",
                periodEnd: "2024-12-31",
                accessionNumber: "0002-amendment",
              }),
              fact({
                value: 999,
                form: "10-K/A",
                fiscalYear: 2024,
                fiscalPeriod: "FY",
                filedAt: "2026-07-01",
                periodStart: "2024-01-01",
                periodEnd: "2024-12-31",
                accessionNumber: "0001-future",
              }),
            ],
          },
        },
      }),
    );

    expect(artifact.statements.incomeStatement.revenue.annual).toHaveLength(1);
    expect(artifact.statements.incomeStatement.revenue.annual[0]).toMatchObject({
      value: 111,
      form: "10-K/A",
      canonicalForm: "10-K",
      amendment: true,
      accessionNumber: "0002-amendment",
    });
    expect(artifact.omissionNotes.some((note) => note.code === "cutoff-exclusion")).toBe(true);
    expect(artifact.validationNotes.some((note) => note.code === "duplicate-superseded")).toBe(
      true,
    );
  });

  test("collapses one-day annual period-start drift and keeps the later filing", () => {
    const artifact = derive(
      payload({
        "ifrs-full": {
          Revenue: {
            CAD: [
              fact({
                value: 38_892_000_000,
                form: "40-F",
                fiscalYear: 2019,
                fiscalPeriod: "FY",
                filedAt: "2019-01-04",
                periodStart: "2017-11-01",
                periodEnd: "2018-10-31",
                accessionNumber: "0000947263-19-000001",
              }),
              fact({
                value: 38_892_000_000,
                form: "40-F",
                fiscalYear: 2020,
                fiscalPeriod: "FY",
                filedAt: "2020-01-03",
                periodStart: "2017-11-02",
                periodEnd: "2018-10-31",
                accessionNumber: "0000947263-20-000001",
              }),
            ],
          },
        },
      }),
    );

    // Bucket-equivalent durations are the same period, so filing recency selects the winner.
    expect(
      artifact.statements.incomeStatement.revenue.annual.map(
        ({ value, periodStart, periodEnd, fiscalYear, accessionNumber }) => ({
          value,
          periodStart,
          periodEnd,
          fiscalYear,
          accessionNumber,
        }),
      ),
    ).toEqual([
      {
        value: 38_892_000_000,
        periodStart: "2017-11-02",
        periodEnd: "2018-10-31",
        fiscalYear: 2018,
        accessionNumber: "0000947263-20-000001",
      },
    ]);
    expect(
      artifact.validationNotes.filter(
        ({ code, seriesKey }) => code === "duplicate-superseded" && seriesKey === "revenue",
      ),
    ).toEqual([
      {
        code: "duplicate-superseded",
        seriesKey: "revenue",
        periodKey: "duration:12|2018-10-31",
        message: "1 duplicate/restated fact(s) superseded by 0000947263-20-000001 filed 2020-01-03",
      },
    ]);
  });

  test("derives fiscal year when the companyfacts filing frame is omitted", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: {
            USD: [
              fact({
                value: 100,
                form: "10-K",
                fiscalPeriod: "FY",
                filedAt: "2026-02-15",
                periodStart: "2025-01-01",
                periodEnd: "2025-12-31",
              }),
            ],
          },
        },
      }),
    );

    expect(artifact.statements.incomeStatement.revenue.annual).toEqual([
      expect.objectContaining({ periodEnd: "2025-12-31", fiscalYear: 2025 }),
    ]);
  });

  test("pins the calendar-year label for a January 31 year end", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: {
            USD: [
              fact({
                value: 100,
                form: "10-K",
                fiscalYear: 2018,
                fiscalPeriod: "FY",
                filedAt: "2018-03-01",
                periodStart: "2017-02-01",
                periodEnd: "2018-01-31",
              }),
            ],
          },
        },
      }),
    );

    // A Jan-31 retailer conventionally calls this FY2017; current behavior uses 2018.
    expect(artifact.statements.incomeStatement.revenue.annual).toEqual([
      expect.objectContaining({ periodEnd: "2018-01-31", fiscalYear: 2018 }),
    ]);
  });

  test("keeps sub-annual 10-K flows out of annual consumers while preserving instants", () => {
    const flowFacts = (values: readonly [number, number, number, number]) => [
      fact({
        value: values[0],
        form: "10-K",
        fiscalYear: 2023,
        fiscalPeriod: "FY",
        filedAt: "2024-05-24",
        periodStart: "2023-01-01",
        periodEnd: "2023-12-31",
        accessionNumber: "fy-2023",
      }),
      fact({
        value: values[1],
        form: "10-K",
        fiscalYear: 2023,
        fiscalPeriod: "FY",
        filedAt: "2024-05-24",
        periodStart: "2023-01-01",
        periodEnd: "2023-06-30",
        accessionNumber: "h1-comparative",
      }),
      fact({
        value: values[2],
        form: "10-K",
        fiscalYear: 2023,
        fiscalPeriod: "FY",
        filedAt: "2024-05-24",
        periodStart: "2023-04-01",
        periodEnd: "2023-06-30",
        accessionNumber: "q2-comparative",
      }),
      fact({
        value: values[3],
        form: "10-K",
        fiscalYear: 2023,
        fiscalPeriod: "FY",
        filedAt: "2024-05-24",
        periodStart: "2023-01-01",
        periodEnd: "2023-09-30",
        accessionNumber: "ytd-comparative",
      }),
    ];
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: flowFacts([100, 45, 25, 72]) },
        NetCashProvidedByUsedInOperatingActivities: { USD: flowFacts([30, 12, 7, 20]) },
        CashAndCashEquivalentsAtCarryingValue: {
          USD: [
            fact({
              value: 18,
              form: "10-K",
              fiscalYear: 2023,
              fiscalPeriod: "FY",
              filedAt: "2024-05-24",
              periodEnd: "2023-12-31",
              accessionNumber: "fy-2023-instant",
            }),
          ],
        },
      },
    });
    const artifact = derive(companyFacts);
    const workbench = buildValuationWorkbench({
      generatedAt: "2026-06-15T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: artifact,
      priceHistory: [],
      quoteCurrency: "USD",
    });

    expect({
      revenueAnnualPeriods: artifact.statements.incomeStatement.revenue.annual.map(
        (item) => item.periodKey,
      ),
      cashFlowAnnualPeriods: artifact.statements.cashFlowStatement.operatingCashFlow.annual.map(
        (item) => item.periodKey,
      ),
      balanceSheetAnnualPeriods: artifact.statements.balanceSheet.cash.annual.map(
        (item) => item.periodKey,
      ),
      workbenchPeriodEnds: workbench.historicalMultiples.observations.map((item) => item.periodEnd),
    }).toEqual({
      revenueAnnualPeriods: ["duration:12|2023-12-31"],
      cashFlowAnnualPeriods: ["duration:12|2023-12-31"],
      balanceSheetAnnualPeriods: ["instant|2023-12-31"],
      workbenchPeriodEnds: ["2023-12-31"],
    });
  });

  test("isolates the most recent standard taxonomy and reporting currency", () => {
    const artifact = derive(
      payload({
        "us-gaap": { Revenues: { EUR: [annual(90, 2023, "20-F")] } },
        "ifrs-full": {
          Revenue: {
            EUR: [annual(95, 2024, "20-F")],
            USD: [annual(120, 2025, "20-F")],
          },
        },
        issuer: { CustomRevenue: { USD: [annual(500, 2026, "20-F")] } },
      }),
    );

    expect(artifact.taxonomy).toBe("ifrs-full");
    expect(artifact.reportingCurrency).toBe("USD");
    expect(artifact.statements.incomeStatement.revenue.annual.map((item) => item.value)).toEqual([
      120,
    ]);
    expect(artifact.omissionNotes).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "mixed-currencies" })]),
    );
    expect(artifact.validationNotes).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "mixed-taxonomies" })]),
    );
  });

  test("ratio-input series never sway the taxonomy election", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          NetIncomeLoss: { USD: [annual(100, 2025)] },
          NetCashProvidedByUsedInOperatingActivities: { USD: [annual(200, 2025)] },
        },
        "ifrs-full": {
          Revenue: { USD: [annual(1000, 2025, "20-F")] },
          ProfitLoss: { USD: [annual(100, 2025, "20-F")] },
          InterestExpense: { USD: [annual(40, 2025, "20-F")] },
          IncomeTaxExpenseContinuingOperations: { USD: [annual(32, 2025, "20-F")] },
          ProfitLossBeforeTax: { USD: [annual(160, 2025, "20-F")] },
        },
      }),
    );

    expect(artifact.taxonomy).toBe("us-gaap");
  });

  test("ratio-input series never sway the revenue-absent currency election", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          NetIncomeLoss: { USD: [annual(100, 2024)] },
          InterestExpense: { EUR: [annual(40, 2025)] },
          DepreciationDepletionAndAmortization: { EUR: [annual(50, 2025)] },
        },
      }),
    );

    expect(artifact.reportingCurrency).toBe("USD");
    expect(artifact.statements.incomeStatement.netIncome.annual).toEqual([
      expect.objectContaining({ value: 100 }),
    ]);
  });

  test("chooses the first standard concept eligible at the cutoff and reporting currency", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { EUR: [annual(90, 2024)], USD: [annual(999, 2027)] },
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            USD: [annual(120, 2025)],
          },
        },
      }),
    );

    expect(artifact.reportingCurrency).toBe("USD");
    expect(artifact.statements.incomeStatement.revenue.annual).toEqual([
      expect.objectContaining({
        value: 120,
        concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
      }),
    ]);
  });

  describe("convenience-translation filings (NBIS: Yandex 20-Fs report RUB, translate the latest year)", () => {
    const filed = (accessionNumber: string, filedAt: string, value: number, year: number) =>
      fact({
        value,
        accessionNumber,
        form: "20-F",
        fiscalYear: year,
        fiscalPeriod: "FY",
        filedAt,
        periodStart: `${String(year)}-01-01`,
        periodEnd: `${String(year)}-12-31`,
      });
    const balance = (accessionNumber: string, filedAt: string, value: number, year: number) =>
      withoutStart(filed(accessionNumber, filedAt, value, year));
    const rubFiling = "0001558370-22-005654";
    const usdFiling = "0001558370-25-005991";
    const nbisShape = payload({
      "us-gaap": {
        Revenues: {
          RUB: [2019, 2020, 2021].map((year) => filed(rubFiling, "2022-04-20", year * 100, year)),
          USD: [
            filed(rubFiling, "2022-04-20", 4794, 2021),
            filed(usdFiling, "2025-04-30", 13, 2022),
            filed(usdFiling, "2025-04-30", 21, 2023),
          ],
        },
        CashAndCashEquivalentsAtCarryingValue: {
          USD: [
            balance(rubFiling, "2022-04-20", 1127, 2021),
            balance(usdFiling, "2025-04-30", 110, 2023),
          ],
        },
        EarningsPerShareDiluted: {
          "USD/shares": [
            filed(rubFiling, "2022-04-20", -0.5, 2021),
            filed(usdFiling, "2025-04-30", 0.6, 2023),
          ],
        },
        WeightedAverageNumberOfDilutedSharesOutstanding: {
          shares: [
            filed(rubFiling, "2022-04-20", 362, 2021),
            filed(usdFiling, "2025-04-30", 370, 2023),
          ],
        },
      },
    });

    test("drops the translated filing's monetary facts and keeps its share counts", () => {
      const artifact = derive(nbisShape);

      expect(artifact.reportingCurrency).toBe("USD");
      expect(annualAccessions(artifact.statements.incomeStatement.revenue)).toEqual([
        `2022-12-31 ${usdFiling}`,
        `2023-12-31 ${usdFiling}`,
      ]);
      expect(annualAccessions(artifact.statements.balanceSheet.cash)).toEqual([
        `2023-12-31 ${usdFiling}`,
      ]);
      expect(annualAccessions(artifact.statements.perShare.dilutedEps)).toEqual([
        `2023-12-31 ${usdFiling}`,
      ]);
      expect(annualAccessions(artifact.statements.perShare.dilutedShares)).toEqual([
        `2021-12-31 ${rubFiling}`,
        `2023-12-31 ${usdFiling}`,
      ]);
      const message = `Excluded USD convenience translations from 1 filing whose revenue is reported in RUB (${rubFiling}); annual revenue reported in USD starts with the period ended 2022-12-31`;
      expect(artifact.omissionNotes.filter(({ code }) => code === "translation-filing")).toEqual([
        { code: "translation-filing", message },
      ]);
      expect(historyGapMessages(artifact)).toContain(message);
    });

    test("dates each period by its first elected-currency annual report, not a RUB-only or translation filing", () => {
      const rub2023 = "0001558370-23-006319";
      const rub2024 = "0001558370-24-005891";
      const artifact = derive(
        payload({
          "us-gaap": {
            Revenues: {
              RUB: [2021, 2022].flatMap((year) => [
                filed(rub2023, "2023-04-20", year, year),
                filed(rub2024, "2024-04-26", year + 1, year + 1),
              ]),
              USD: [
                filed(rub2024, "2024-04-26", 8, 2023),
                filed(usdFiling, "2025-04-30", 13, 2022),
                filed(usdFiling, "2025-04-30", 21, 2023),
                filed(usdFiling, "2025-04-30", 34, 2024),
              ],
            },
          },
        }),
      );

      expect(
        artifact.firstAnnualReports?.map((report) => [
          report.periodEnd,
          report.filedAt,
          report.accessionNumber,
        ]),
      ).toEqual([
        ["2022-12-31", "2025-04-30", usdFiling],
        ["2023-12-31", "2025-04-30", usdFiling],
        ["2024-12-31", "2025-04-30", usdFiling],
      ]);
    });

    test("a single-currency filer passes through unpruned", () => {
      const companyFacts = payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2023), annual(120, 2024)] },
          CashAndCashEquivalentsAtCarryingValue: { USD: [instant(50, 2024)] },
        },
      });
      const pruned = withoutTranslationFilings(companyFacts, "us-gaap", "USD", "2026-06-15");

      expect(pruned).toEqual({
        payload: companyFacts,
        excluded: new Map(),
        translations: new Map(),
      });
      expect(pruned.payload).toBe(companyFacts);
      expect(derive(companyFacts).omissionNotes.map(({ code }) => code)).not.toContain(
        "translation-filing",
      );
    });

    test("a stray foreign-currency fact inside a USD filing's periods prunes nothing (CECO Pillar Two shape)", () => {
      const tenK = "0000003197-26-000010";
      const companyFacts = payload({
        "us-gaap": {
          Revenues: {
            USD: [2023, 2024, 2025].map((year) => filed(tenK, "2026-02-20", year, year)),
            EUR: [filed(tenK, "2026-02-20", 750_000_000, 2025)],
          },
        },
      });
      const pruned = withoutTranslationFilings(companyFacts, "us-gaap", "USD", "2026-06-15");

      expect(pruned.payload).toBe(companyFacts);
      expect(pruned.excluded.size).toBe(0);
      expect(derive(companyFacts).statements.incomeStatement.revenue.annual).toHaveLength(3);
    });
  });

  describe("revenue concept switch on a same-filing dual tag (ORCL FY26 10-K 0001193125-26-277521)", () => {
    const asc606 = "RevenueFromContractWithCustomerExcludingAssessedTax";
    const tenK = "0001193125-26-277521";
    const fy = (year: number, value: number, accessionNumber = tenK, filedAt = "2026-06-20") =>
      fact({
        value,
        accessionNumber,
        filedAt,
        form: "10-K",
        fiscalPeriod: "FY",
        periodStart: `${String(year - 1)}-06-01`,
        periodEnd: `${String(year)}-05-31`,
      });
    const quarters = [
      fact({
        value: 14_926_000_000,
        form: "10-Q",
        fiscalPeriod: "Q1",
        filedAt: "2025-09-10",
        accessionNumber: "0001193125-25-200095",
        periodStart: "2025-06-01",
        periodEnd: "2025-08-31",
      }),
      fact({
        value: 19_345_000_000,
        form: "10-Q",
        fiscalPeriod: "Q1",
        filedAt: "2026-09-10",
        accessionNumber: "0001193125-26-389274",
        periodStart: "2026-06-01",
        periodEnd: "2026-08-31",
      }),
    ];
    const orclAsc606 = [
      fy(2024, 52_961_000_000),
      fy(2025, 57_399_000_000),
      fy(2026, 67_357_000_000),
    ];
    const revenue = (revenues: readonly Record<string, unknown>[], other = orclAsc606) =>
      derive(
        payload({
          "us-gaap": { Revenues: { USD: revenues }, [asc606]: { USD: [...other, ...quarters] } },
        }),
        { analysisAsOf: "2026-10-01T00:00:00.000Z" },
      ).statements.incomeStatement.revenue;

    test("switches when every annual period matches and derives TTM from one concept", () => {
      const series = revenue(orclAsc606);
      expect(series.annual.map((row) => [row.concept, row.value])).toEqual(
        [52_961_000_000, 57_399_000_000, 67_357_000_000].map((value) => [asc606, value]),
      );
      expect(series.ttm).toMatchObject({ value: 71_776_000_000, periodEnd: "2026-08-31" });
    });

    test.each([
      [
        "an older overlap contradicts",
        [fy(2025, 90), fy(2026, 100)],
        [fy(2025, 50), fy(2026, 100)],
      ],
      ["the latest values differ", [fy(2025, 90), fy(2026, 100)], [fy(2025, 90), fy(2026, 101)]],
      [
        "the anchor is from another filing",
        [fy(2025, 90), fy(2026, 100, "0001193125-26-999999")],
        [fy(2025, 90), fy(2026, 100)],
      ],
      [
        "a later filing supersedes the anchor",
        [fy(2025, 90), fy(2026, 100), fy(2026, 105, "0001193125-26-500000", "2026-08-01")],
        [fy(2025, 90), fy(2026, 100)],
      ],
      [
        "the candidate misses an annual period",
        [fy(2022, 70), fy(2023, 80), fy(2024, 90), fy(2025, 95), fy(2026, 100)],
        [fy(2026, 100)],
      ],
      [
        "a later candidate revision of the anchor period differs",
        [fy(2025, 90), fy(2026, 100)],
        [
          fy(2025, 90),
          fy(2026, 100),
          { ...fy(2026, 999, "0001193125-26-500000", "2026-08-01"), start: "2025-06-02" },
        ],
      ],
      [
        "the candidate misses the oldest capped period",
        [2016, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map((year) => fy(year, year)),
        [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map((year) => fy(year, year)),
      ],
      [
        "only the older-ended period shares a filing",
        [
          { ...fy(2026, 90, "0001193125-26-100000"), start: "2025-06-01", end: "2026-03-31" },
          { ...fy(2026, 100, "0001193125-26-200000"), start: "2025-04-01", end: "2026-05-31" },
        ],
        [
          { ...fy(2026, 90, "0001193125-26-100000"), start: "2025-06-01", end: "2026-03-31" },
          { ...fy(2026, 100, "0001193125-26-300000"), start: "2025-04-01", end: "2026-05-31" },
        ],
      ],
    ])("keeps Revenues without TTM when %s", (_, revenues, other) => {
      const series = revenue(revenues, other);
      expect(new Set(series.annual.map((row) => row.concept))).toEqual(new Set(["Revenues"]));
      expect(series.ttm).toBeUndefined();
    });

    test("notes a preferred annual period the switch pushes past the cap", () => {
      const calendarYear = (year: number) =>
        fact({
          value: year,
          form: "10-K",
          fiscalPeriod: "FY",
          filedAt: `${String(year + 1)}-02-15`,
          accessionNumber: `0000000001-${String(year + 1).slice(-2)}-000001`,
          periodStart: `${String(year)}-01-01`,
          periodEnd: `${String(year)}-12-31`,
        });
      const years = (from: number) =>
        Array.from({ length: 10 }, (_, index) => calendarYear(from + index));
      const artifact = derive(
        payload({
          "us-gaap": {
            Revenues: {
              USD: [
                ...years(2015),
                fact({
                  value: 2025,
                  form: "10-Q",
                  fiscalPeriod: "Q3",
                  filedAt: "2025-11-01",
                  periodStart: "2025-07-01",
                  periodEnd: "2025-09-30",
                }),
              ],
            },
            [asc606]: { USD: years(2016) },
          },
        }),
        { analysisAsOf: "2026-06-15T00:00:00.000Z" },
      );
      expect(
        artifact.statements.incomeStatement.revenue.annual.map((row) => row.periodEnd)[0],
      ).toBe("2016-12-31");
      expect(artifact.omissionNotes).toContainEqual(
        expect.objectContaining({
          code: "history-cap",
          seriesKey: "revenue",
          periodKey: "annual|duration:12|2015-12-31",
        }),
      );
      expect(
        artifact.omissionNotes
          .filter(({ periodKey }) => periodKey?.startsWith("interim|"))
          .map(({ code, seriesKey, periodKey, message }) => [code, seriesKey, periodKey, message]),
      ).toEqual([
        [
          "history-cap",
          "revenue",
          "interim|duration:3|2025-09-30",
          `Interim period duration:3|2025-09-30 under Revenues omitted: revenue switched to ${asc606} on same-filing proof, which does not tag that period`,
        ],
      ]);
    });

    test("derives TTM when only one concept is tagged", () => {
      const series = derive(
        payload({ "us-gaap": { [asc606]: { USD: [...orclAsc606, ...quarters] } } }),
        { analysisAsOf: "2026-10-01T00:00:00.000Z" },
      ).statements.incomeStatement.revenue;
      expect(series.ttm?.value).toBe(71_776_000_000);
    });
  });

  test.each([
    "PaymentsOfDividends",
    "PaymentsOfDividendsCommonStock",
    "PaymentsOfOrdinaryDividends",
  ])("selects %s as dividends paid", (concept) => {
    const artifact = derive(payload({ "us-gaap": { [concept]: { USD: [annual(40, 2025)] } } }));

    expect(artifact.statements.cashFlowStatement.dividendsPaid.annual).toEqual([
      expect.objectContaining({ value: 40, concept }),
    ]);
  });

  test("prefers the cash-flow dividend total over the common-only concept on the same period", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          PaymentsOfDividendsCommonStock: { USD: [annual(30, 2025)] },
          PaymentsOfDividends: { USD: [annual(40, 2025)] },
        },
      }),
    );

    expect(artifact.statements.cashFlowStatement.dividendsPaid.annual).toEqual([
      expect.objectContaining({ value: 40, concept: "PaymentsOfDividends" }),
    ]);
  });

  test("prefers declared over cash-paid dividends per share on the same period", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          CommonStockDividendsPerShareCashPaid: { "USD/shares": [annual(0.98, 2025)] },
          CommonStockDividendsPerShareDeclared: { "USD/shares": [annual(1.04, 2025)] },
        },
      }),
    );

    expect(artifact.statements.perShare.dividendsPerShare).toMatchObject({
      label: "Dividends per share",
      statement: "perShare",
      annual: [
        {
          value: 1.04,
          concept: "CommonStockDividendsPerShareDeclared",
          unit: "USD/shares",
          currency: "USD",
        },
      ],
    });
  });

  test("falls back to cash-paid dividends per share when nothing is declared", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          CommonStockDividendsPerShareCashPaid: { "USD/shares": [annual(0.98, 2025)] },
        },
      }),
    );

    expect(artifact.statements.perShare.dividendsPerShare.annual).toEqual([
      expect.objectContaining({ value: 0.98, concept: "CommonStockDividendsPerShareCashPaid" }),
    ]);
  });

  describe("dividends per share reconciliation with dividends paid", () => {
    const dividendFacts = (
      perShare: Readonly<Record<string, number>>,
      { paid, shares }: { paid?: number; shares: number },
      year = 2025,
      laterShares: readonly Record<string, unknown>[] = [],
    ) =>
      derive(
        payload({
          "us-gaap": {
            Revenues: { USD: [annual(1000, year)] },
            WeightedAverageNumberOfDilutedSharesOutstanding: {
              shares: [annual(shares, year), ...laterShares],
            },
            ...(paid === undefined ? {} : { PaymentsOfDividends: { USD: [annual(paid, year)] } }),
            ...Object.fromEntries(
              Object.entries(perShare).map(([concept, value]) => [
                concept,
                { "USD/shares": [annual(value, year)] },
              ]),
            ),
          },
        }),
        { analysisAsOf: `${String(year + 1)}-06-15T00:00:00.000Z` },
      );

    // Prologis FY2025, 10-K 0001193125-26-051453 (R7: $4.04 per common share; $3,764.7M dividends paid).
    test("uses the cash-paid concept when the declared one does not reconcile", () => {
      const artifact = dividendFacts(
        {
          CommonStockDividendsPerShareDeclared: 0.03,
          CommonStockDividendsPerShareCashPaid: 4.04,
        },
        { paid: 3_764_745_000, shares: 956_832_000 },
      );

      expect(artifact.statements.perShare.dividendsPerShare.annual).toEqual([
        expect.objectContaining({ value: 4.04, concept: "CommonStockDividendsPerShareCashPaid" }),
      ]);
      expect(artifact.omissionNotes.map(({ code }) => code)).not.toContain("dps-unreconciled");
    });

    // Prologis run 2026-11-14T18-11-33-016Z-4e03119d: Declared ends 2025-12-31, CashPaid has Q1 2026 at $1.07.
    test("a cash-paid newest year brings its interim rows and drops the declared staleness note", () => {
      const quarter = (value: number) =>
        fact({
          value,
          form: "10-Q",
          fiscalYear: 2026,
          fiscalPeriod: "Q1",
          filedAt: "2026-04-30",
          periodStart: "2026-01-01",
          periodEnd: "2026-03-31",
        });
      const artifact = derive(
        payload({
          "us-gaap": {
            Revenues: { USD: [annual(1000, 2025)] },
            WeightedAverageNumberOfDilutedSharesOutstanding: {
              shares: [annual(950_000_000, 2024), annual(956_832_000, 2025)],
            },
            PaymentsOfDividends: {
              USD: [annual(3_650_000_000, 2024), annual(3_764_745_000, 2025)],
            },
            CommonStockDividendsPerShareDeclared: {
              "USD/shares": [annual(3.84, 2024), annual(0.03, 2025)],
            },
            CommonStockDividendsPerShareCashPaid: {
              "USD/shares": [annual(4.04, 2025), quarter(1.07)],
            },
          },
        }),
        { analysisAsOf: "2026-06-15T00:00:00.000Z" },
      );
      const dps = artifact.statements.perShare.dividendsPerShare;

      expect(dps.annual.map(({ concept }) => concept)).toEqual([
        "CommonStockDividendsPerShareDeclared",
        "CommonStockDividendsPerShareCashPaid",
      ]);
      expect(dps.interim).toEqual([
        expect.objectContaining({ value: 1.07, concept: "CommonStockDividendsPerShareCashPaid" }),
      ]);
      expect(
        artifact.omissionNotes.filter(
          (note) => note.seriesKey === "dividendsPerShare" && note.code === "stale-concept-history",
        ),
      ).toEqual([]);
    });

    // ADTRAN FY2023: $0.09 is the quarterly rate; $21.2M dividends paid on 78.4M diluted shares.
    // Belden FY2017 lands here too: its $43.4M common-dividend payments carry $34.9M of preferred.
    test.each([
      ["ADTRAN FY2023", 0.09, 21_237_000, 78_416_000, 2023, "is 0.33x dividends paid of 21237000"],
      ["Belden FY2017", 0.2, 43_376_000, 42_643_000, 2017, "is 0.20x dividends paid of 43376000"],
    ])(
      "withholds %s, which neither concept reconciles, and declares it",
      (_case, dps, paid, shares, year, reason) => {
        const artifact = dividendFacts(
          { CommonStockDividendsPerShareCashPaid: dps },
          { paid, shares },
          year,
        );
        const periodKey = `duration:12|${String(year)}-12-31`;

        expect(artifact.statements.perShare.dividendsPerShare.annual).toEqual([]);
        expect(artifact.omissionNotes).toContainEqual(
          expect.objectContaining({
            code: "dps-unreconciled",
            seriesKey: "dividendsPerShare",
            periodKey,
            reason: expect.stringContaining(reason),
          }),
        );
        expect(historyGapMessages(artifact)).toContainEqual(
          expect.stringContaining(`SEC dividends per share is withheld for ${periodKey}`),
        );
      },
    );

    // A later 1-for-10 restatement of shares must not judge DPS filed on the earlier basis.
    test("reconciles against the shares in the DPS filing, not a later restatement", () => {
      const restated = {
        ...annual(95_683_200, 2025),
        form: "10-K/A",
        filed: "2026-05-15",
        accn: "20260515-10-K-A",
      };
      const artifact = dividendFacts(
        { CommonStockDividendsPerShareCashPaid: 4.04 },
        { paid: 3_764_745_000, shares: 956_832_000 },
        2025,
        [restated],
      );

      expect(artifact.statements.perShare.dividendsPerShare.annual).toEqual([
        expect.objectContaining({
          value: 4.04,
          dividendsPaidProof: expect.stringContaining("later restated figures give 0.10x"),
        }),
      ]);
    });

    // ADTRAN FY2019: the quarterly $0.09 is re-tagged as cash paid in 10-K/A 0000950170-23-042432,
    // Which carries no FY2019 dividends paid or shares; the true annual rate is $0.36.
    test.each([
      ["declared is primary", {}],
      ["the amendment's cash paid is primary", { CommonStockDividendsPerShareCashPaid: 0.09 }],
    ])(
      "withholds a year whose fallback sits in a filing without operands when %s",
      (_case, later) => {
        const fy2019 = (value: number, accessionNumber: string, form: string, filedAt: string) =>
          fact({
            value,
            form,
            fiscalYear: 2019,
            fiscalPeriod: "FY",
            filedAt,
            periodStart: "2019-01-01",
            periodEnd: "2019-12-31",
            accessionNumber,
          });
        const tenK = (value: number) => fy2019(value, "0001564590-20-006425", "10-K", "2020-02-25");
        const artifact = derive(
          payload({
            "us-gaap": {
              Revenues: { USD: [tenK(530_062_000)] },
              PaymentsOfDividends: { USD: [tenK(17_212_000)] },
              WeightedAverageNumberOfDilutedSharesOutstanding: { shares: [tenK(47_836_000)] },
              CommonStockDividendsPerShareDeclared: { "USD/shares": [tenK(0.09)] },
              CommonStockDividendsPerShareCashPaid: {
                "USD/shares": [
                  fy2019(0.09, "0000950170-23-042432", "10-K/A", "2023-08-14"),
                  ...Object.values(later).map((value) => annual(value, 2020)),
                ],
              },
            },
          }),
          { analysisAsOf: "2023-09-15T00:00:00.000Z" },
        );

        expect(
          artifact.statements.perShare.dividendsPerShare.annual.map(({ periodKey }) => periodKey),
        ).not.toContain("duration:12|2019-12-31");
        expect(artifact.omissionNotes).toContainEqual(
          expect.objectContaining({
            code: "dps-unreconciled",
            periodKey: "duration:12|2019-12-31",
            reason: expect.stringContaining("is 0.25x dividends paid of 17212000"),
          }),
        );
      },
    );

    test("does not swap in a fallback that overshoots dividends paid", () => {
      const artifact = dividendFacts(
        {
          CommonStockDividendsPerShareDeclared: 0.03,
          CommonStockDividendsPerShareCashPaid: 12,
        },
        { paid: 3_764_745_000, shares: 956_832_000 },
      );

      expect(artifact.statements.perShare.dividendsPerShare.annual).toEqual([]);
      expect(artifact.omissionNotes).toContainEqual(
        expect.objectContaining({
          code: "dps-unreconciled",
          reason: expect.stringContaining("CommonStockDividendsPerShareDeclared 0.03"),
        }),
      );
    });

    test.each([
      ["dividends paid is not tagged", { shares: 956_832_000 }, 0.03],
      ["a non-payer tags zero", { paid: 0, shares: 956_832_000 }, 0],
      ["dividends paid is negative", { paid: -2_720_000_000, shares: 434_000_000 }, 6.26],
      // Generac FY2014, 10-K 0001437749-15-003654: no 2014 declarations; $902k settles earlier ones.
      [
        "a declared zero meets earlier declarations paid this year",
        { paid: 902_000, shares: 70_171_044 },
        0,
      ],
    ])("keeps the declared figure when %s", (_case, totals, value) => {
      const artifact = dividendFacts({ CommonStockDividendsPerShareDeclared: value }, totals);

      expect(artifact.statements.perShare.dividendsPerShare.annual).toEqual([
        expect.objectContaining({ value, concept: "CommonStockDividendsPerShareDeclared" }),
      ]);
    });
  });

  test("drops dividend-per-share declaration spans that are not statement periods", () => {
    const declared = (periodStart: string, value: number) =>
      fact({
        value,
        form: "10-K",
        fiscalYear: 2025,
        fiscalPeriod: "FY",
        filedAt: "2026-02-15",
        periodStart,
        periodEnd: "2025-12-31",
      });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          CommonStockDividendsPerShareDeclared: {
            "USD/shares": [
              declared("2025-01-01", 9.66),
              declared("2025-10-01", 2.38),
              declared("2025-12-01", 2.52),
              fact({
                value: 2.52,
                form: "10-K",
                fiscalYear: 2025,
                fiscalPeriod: "FY",
                filedAt: "2026-02-15",
                periodEnd: "2025-12-15",
              }),
            ],
          },
        },
      }),
      { analysisAsOf: "2026-03-01" },
    );

    const dividends = artifact.statements.perShare.dividendsPerShare;
    expect(dividends.annual.map((item) => item.value)).toEqual([9.66]);
    expect(dividends.interim.map((item) => [item.periodStart, item.value])).toEqual([
      ["2025-10-01", 2.38],
    ]);
    expect(artifact.omissionNotes.filter((note) => note.code === "declaration-span")).toEqual([
      expect.objectContaining({
        seriesKey: "dividendsPerShare",
        periodKey: "duration:1|2025-12-31",
      }),
    ]);

    const spansOnly = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          CommonStockDividendsPerShareDeclared: { "USD/shares": [declared("2025-12-01", 2.52)] },
        },
      }),
      { analysisAsOf: "2026-03-01" },
    );
    expect(financialStatementFacts(spansOnly.statements.perShare.dividendsPerShare)).toEqual([]);
    expect(spansOnly.omissionNotes).toContainEqual(
      expect.objectContaining({ code: "declaration-span", seriesKey: "dividendsPerShare" }),
    );
    expect(historyGapMessages(spansOnly)).toEqual([
      expect.stringContaining(
        "dividends per share has 1 non-zero facts (latest duration:1|2025-12-31) omitted because they are declaration dates or spans shorter than a fiscal quarter",
      ),
    ]);
  });

  test("keeps a 52/53-week issuer's 16-week first-quarter dividends per share", () => {
    // Kroger Q2 FY2026 10-Q 0001104659-26-108926: 16-week Q1 (112 days) and 12-week Q2 declarations.
    const quarter = (periodStart: string, periodEnd: string, value: number) =>
      fact({
        value,
        form: "10-Q",
        fiscalYear: 2026,
        fiscalPeriod: "Q2",
        filedAt: "2026-09-18",
        periodStart,
        periodEnd,
        accessionNumber: "0001104659-26-108926",
      });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          CommonStockDividendsPerShareDeclared: {
            "USD/shares": [
              fact({
                value: 1.37,
                form: "10-K",
                fiscalYear: 2025,
                fiscalPeriod: "FY",
                filedAt: "2026-03-31",
                periodStart: "2025-02-02",
                periodEnd: "2026-01-31",
              }),
              quarter("2025-02-02", "2025-05-24", 0.32),
              quarter("2026-02-01", "2026-05-23", 0.35),
              quarter("2026-05-24", "2026-08-15", 0.39),
            ],
          },
        },
      }),
      { analysisAsOf: "2026-10-01" },
    );

    const dividends = artifact.statements.perShare.dividendsPerShare;
    expect(dividends.interim.map((item) => [item.periodStart, item.periodEnd, item.value])).toEqual(
      expect.arrayContaining([
        ["2025-02-02", "2025-05-24", 0.32],
        ["2026-02-01", "2026-05-23", 0.35],
        ["2026-05-24", "2026-08-15", 0.39],
      ]),
    );
    expect(artifact.omissionNotes.filter((note) => note.code === "declaration-span")).toEqual([]);
  });

  test("drops one-month spans from every duration series, not only dividends per share", () => {
    // Realty Income Q3 2026 10-Q 0000726728-26-000059 tags January and August 2026 repurchases as one-month spans.
    const repurchase = (periodStart: string, periodEnd: string, value: number) =>
      fact({
        value,
        form: "10-Q",
        fiscalYear: 2026,
        fiscalPeriod: "Q3",
        filedAt: "2026-11-03",
        accessionNumber: "0000726728-26-000059",
        periodStart,
        periodEnd,
      });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          PaymentsForRepurchaseOfCommonStock: {
            USD: [
              repurchase("2026-01-01", "2026-01-31", 101_900_000),
              repurchase("2026-08-01", "2026-08-31", 188_700_000),
              repurchase("2026-01-01", "2026-09-30", 290_631_000),
            ],
          },
        },
      }),
      { analysisAsOf: "2026-11-12" },
    );

    expect(
      artifact.statements.cashFlowStatement.shareRepurchases.interim.map(
        ({ periodKey }) => periodKey,
      ),
    ).toEqual(["duration:9|2026-09-30"]);
    expect(historyGapMessages(artifact)).toContainEqual(
      expect.stringContaining(
        "share repurchases has 2 non-zero off-period facts (latest duration:1|2026-08-31)",
      ),
    );
  });

  test("keeps 52-53-week calendar quarters whose spans round to 4, 5 or 8 months", () => {
    const interimEnds = (periods: readonly (readonly [string, string])[]) =>
      derive(
        payload({
          "us-gaap": {
            Revenues: {
              USD: periods.map(([periodStart, periodEnd], index) =>
                fact({
                  value: 100 * (index + 1),
                  form: "10-Q",
                  fiscalYear: 2024,
                  fiscalPeriod: `Q${String(index + 1)}`,
                  filedAt: "2024-10-15",
                  periodStart,
                  periodEnd,
                }),
              ),
            },
          },
        }),
        { analysisAsOf: "2024-11-01" },
      ).statements.incomeStatement.revenue.interim.map(({ periodEnd }) => periodEnd);

    // PepsiCo-style 12-week Q1 with 24- and 36-week YTDs.
    expect(
      interimEnds([
        ["2023-12-31", "2024-03-23"],
        ["2023-12-31", "2024-06-15"],
        ["2023-12-31", "2024-09-07"],
      ]),
    ).toEqual(["2024-03-23", "2024-06-15", "2024-09-07"]);
    // Kroger-style 16-week Q1.
    expect(interimEnds([["2024-02-04", "2024-05-25"]])).toEqual(["2024-05-25"]);
  });

  test("ranks only year-length annual dividend-per-share bases, so a declared stub cannot win", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          CommonStockDividendsPerShareDeclared: {
            "USD/shares": [
              fact({
                value: 0.8,
                form: "10-K",
                fiscalYear: 2025,
                fiscalPeriod: "FY",
                filedAt: "2026-02-15",
                periodStart: "2025-03-01",
                periodEnd: "2025-12-31",
              }),
            ],
          },
          CommonStockDividendsPerShareCashPaid: { "USD/shares": [annual(0.98, 2025)] },
        },
      }),
    );

    expect(artifact.statements.perShare.dividendsPerShare.annual).toEqual([
      expect.objectContaining({ value: 0.98, concept: "CommonStockDividendsPerShareCashPaid" }),
    ]);
  });

  test("keeps declared annual dividends per share over a newer interim-only cash-paid tag", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          CommonStockDividendsPerShareDeclared: { "USD/shares": [annual(1.04, 2025)] },
          CommonStockDividendsPerShareCashPaid: {
            "USD/shares": [
              interim({
                value: 0.26,
                year: 2026,
                endMonthDay: "03-31",
                form: "10-Q",
                fiscalPeriod: "Q1",
              }),
            ],
          },
        },
      }),
      { analysisAsOf: "2026-09-01" },
    );

    expect(artifact.statements.perShare.dividendsPerShare.annual).toEqual([
      expect.objectContaining({ value: 1.04, concept: "CommonStockDividendsPerShareDeclared" }),
    ]);
  });

  test("selects IFRS dividends per share in the reporting currency only", () => {
    const artifact = derive(
      payload({
        "ifrs-full": {
          Revenue: { EUR: [annual(1000, 2025, "20-F")] },
          DividendsRecognisedAsDistributionsToOwnersPerShare: {
            "EUR/shares": [annual(1.05, 2025, "20-F")],
            "USD/shares": [annual(1.2, 2025, "20-F")],
          },
        },
      }),
    );

    expect(artifact.statements.perShare.dividendsPerShare.annual).toEqual([
      expect.objectContaining({ value: 1.05, unit: "EUR/shares", currency: "EUR" }),
    ]);
  });

  test("leaves dividends per share empty when the issuer files no per-share dividend tag", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          PaymentsOfDividends: { USD: [annual(40, 2025)] },
        },
      }),
    );

    expect(artifact.statements.perShare.dividendsPerShare).toMatchObject({
      annual: [],
      interim: [],
    });
  });

  test("selects ratio-input series by us-gaap priority into their own statements", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          InterestExpense: { USD: [annual(40, 2025)] },
          InterestExpenseNonoperating: { USD: [annual(41, 2025)] },
          IncomeTaxExpenseBenefit: { USD: [annual(32, 2025)] },
          IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
            {
              USD: [annual(160, 2025)],
            },
          IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments:
            { USD: [annual(161, 2025)] },
          DepreciationDepletionAndAmortization: { USD: [annual(50, 2025)] },
          DepreciationAndAmortization: { USD: [annual(50.4, 2025)] },
        },
      }),
    );
    const { incomeStatement, cashFlowStatement } = artifact.statements;

    expect(incomeStatement.interestExpense.annual).toEqual([
      expect.objectContaining({ value: 40, concept: "InterestExpense" }),
    ]);
    expect(incomeStatement.incomeTaxExpense.annual).toEqual([
      expect.objectContaining({ value: 32, concept: "IncomeTaxExpenseBenefit" }),
    ]);
    expect(incomeStatement.pretaxIncome).toMatchObject({
      label: "Pretax income from continuing operations",
      statement: "incomeStatement",
      annual: [{ value: 160 }],
    });
    expect(cashFlowStatement.depreciationAndAmortization).toMatchObject({
      statement: "cashFlowStatement",
      annual: [{ value: 50, concept: "DepreciationDepletionAndAmortization" }],
    });
  });

  test("falls back to the later ratio-input aliases when the first is not filed", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          InterestExpenseDebt: { USD: [annual(39, 2025)] },
          IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments:
            { USD: [annual(161, 2025)] },
          DepreciationAndAmortization: { USD: [annual(51, 2025)] },
        },
      }),
    );
    const { incomeStatement, cashFlowStatement } = artifact.statements;

    expect(incomeStatement.interestExpense.annual).toEqual([
      expect.objectContaining({ value: 39, concept: "InterestExpenseDebt" }),
    ]);
    expect(incomeStatement.pretaxIncome.annual).toEqual([expect.objectContaining({ value: 161 })]);
    expect(cashFlowStatement.depreciationAndAmortization.annual).toEqual([
      expect.objectContaining({ value: 51, concept: "DepreciationAndAmortization" }),
    ]);
    expect(incomeStatement.incomeTaxExpense).toMatchObject({ annual: [], interim: [] });
  });

  test("selects IFRS ratio-input series in the reporting currency only", () => {
    const both = (eur: number, usd: number) => ({
      EUR: [annual(eur, 2025, "20-F")],
      USD: [annual(usd, 2025, "20-F")],
    });
    const artifact = derive(
      payload({
        "ifrs-full": {
          Revenue: { EUR: [annual(1000, 2025, "20-F")] },
          InterestExpense: both(40, 44),
          IncomeTaxExpenseContinuingOperations: both(32, 35),
          ProfitLossBeforeTax: both(160, 176),
          DepreciationAndAmortisationExpense: both(50, 55),
        },
      }),
    );
    const { incomeStatement, cashFlowStatement } = artifact.statements;

    for (const series of [
      incomeStatement.interestExpense,
      incomeStatement.incomeTaxExpense,
      incomeStatement.pretaxIncome,
      cashFlowStatement.depreciationAndAmortization,
    ]) {
      expect(series.annual).toEqual([expect.objectContaining({ currency: "EUR" })]);
    }
    expect(incomeStatement.pretaxIncome.annual[0]?.value).toBe(160);
  });

  describe("derived gross profit", () => {
    const deriveAt = (concepts: Readonly<Record<string, readonly Record<string, unknown>[]>>) =>
      derive(
        payload({
          "us-gaap": Object.fromEntries(
            Object.entries(concepts).map(([concept, rows]) => [concept, { USD: rows }]),
          ),
        }),
        { analysisAsOf: "2026-09-01" },
      );

    test("derives revenue minus cost of revenue per shared filing, marked derived", () => {
      const artifact = deriveAt({
        Revenues: [annual(100, 2024), annual(120, 2025)],
        CostOfRevenue: [annual(40, 2024), annual(50, 2025)],
      });
      const { grossProfit } = artifact.statements.incomeStatement;

      expect(grossProfit.annual.map((item) => item.value)).toEqual([60, 70]);
      expect(grossProfit.annual[1]).toMatchObject({
        concept: "Revenues-CostOfRevenue",
        extractionMethod: "derived-sec-companyfacts",
        sourceIds: ["extended-sec-edgar-test-fundamentals"],
        composite: {
          formula: "sum",
          components: [
            {
              concept: "Revenues",
              value: 120,
              sourceIds: ["extended-sec-edgar-test-fundamentals"],
            },
            {
              concept: "CostOfRevenue",
              value: -50,
              sourceIds: ["extended-sec-edgar-test-fundamentals"],
            },
          ],
        },
      });
      expect(historyGapMessages(artifact)).toEqual([]);
    });

    test("withholds a pair whose facts carry no accession number", () => {
      const artifact = deriveAt({
        Revenues: [withoutAccession(annual(100, 2025))],
        CostOfRevenue: [
          withoutAccession(
            fact({
              value: 40,
              form: "10-K/A",
              fiscalYear: 2025,
              fiscalPeriod: "FY",
              filedAt: "2026-03-01",
              periodStart: "2025-01-01",
              periodEnd: "2025-12-31",
            }),
          ),
        ],
      });

      expect(artifact.statements.incomeStatement.grossProfit.annual).toEqual([]);
      expect(historyGapMessages(artifact)).toContain(
        "SEC gross profit is not derived for 2025-01-01 to 2025-12-31: the current revenue and CostOfRevenue revisions do not share one filing, form, span, and unit",
      );
    });

    test("discloses the derivation on the gross margin history card", () => {
      const history = deriveFundamentalHistoryFromFinancialStatements(
        deriveAt({
          Revenues: [annual(100, 2024), annual(120, 2025)],
          CostOfRevenue: [annual(40, 2024), annual(50, 2025)],
        }),
      );
      const note =
        "derived: gross profit derived as Revenues − CostOfRevenue; tagged cost of revenue may exclude amortization or D&A";

      expect(history.series.grossProfit.notes).toContain(note);
      expect(history.series.grossMargin.notes).toContain(note);
      expect(history.series.revenue.notes).not.toContain(note);
      expect(
        fundamentalHistoryView({
          summary: {} as RunSummary,
          fundamentalHistory: history,
        })?.cards.find((card) => card.key === "grossMargin")?.disclosure,
      ).toBe(
        "Derived input: gross profit derived as Revenues − CostOfRevenue; tagged cost of revenue may exclude amortization or D&A.",
      );
    });

    test("shows a TTM equal to the latest FY once, labelled with its accession", () => {
      const history = deriveFundamentalHistoryFromFinancialStatements(
        deriveAt({
          Revenues: [annual(100, 2024), annual(120, 2025)],
          CostOfRevenue: [annual(40, 2024), annual(50, 2025)],
        }),
      );
      const cards = fundamentalHistoryView({
        summary: {} as RunSummary,
        fundamentalHistory: history,
      })?.cards;
      const revenue = cards?.find((card) => card.key === "revenue");

      expect(history.series.revenue.ttm).toMatchObject({ value: 120, periodEnd: "2025-12-31" });
      expect(revenue).toMatchObject({ basis: "ttm", pointCount: 2 });
      expect(revenue?.valuePeriod).toStartWith("TTM = FY2025, 10-K accession ");
      expect(financialTrends(history, undefined)?.rows.map((row) => row.period)).toEqual([
        "FY ending 2024-12-31 (latest filed 2025-02-15)",
        "FY ending 2025-12-31 (latest filed 2026-02-15)",
      ]);
    });

    test("keeps tagged gross profit and never derives alongside it", () => {
      const { grossProfit } = deriveAt({
        Revenues: [annual(100, 2025)],
        CostOfRevenue: [annual(40, 2025)],
        GrossProfit: [annual(61, 2025)],
      }).statements.incomeStatement;

      expect(grossProfit.annual.map(({ value, concept }) => ({ value, concept }))).toEqual([
        { value: 61, concept: "GrossProfit" },
      ]);
    });

    test("withholds a period whose cost fact spans a different duration and declares it", () => {
      const artifact = deriveAt({
        Revenues: [annual(100, 2024), annual(120, 2025)],
        CostOfRevenue: [
          annual(40, 2024),
          fact({
            value: 50,
            form: "10-K",
            fiscalPeriod: "FY",
            filedAt: "2026-02-15",
            periodStart: "2025-04-01",
            periodEnd: "2025-12-31",
          }),
        ],
      });

      expect(
        artifact.statements.incomeStatement.grossProfit.annual.map((item) => item.value),
      ).toEqual([60]);
      expect(historyGapMessages(artifact)).toEqual([
        "SEC gross profit is not derived for 2025-01-01 to 2025-12-31: no CostOfRevenue fact is tagged for the period",
      ]);
    });

    test("withholds a period whose current revenue revision has no cost in the same filing", () => {
      const artifact = deriveAt({
        Revenues: [
          annual(100, 2025),
          { ...annual(120, 2025), form: "10-K/A", filed: "2026-04-01", accn: "20260401-10-K-A" },
        ],
        CostOfRevenue: [annual(40, 2025)],
      });

      expect(artifact.statements.incomeStatement.revenue.annual.map((item) => item.value)).toEqual([
        120,
      ]);
      expect(artifact.statements.incomeStatement.grossProfit.annual).toEqual([]);
      expect(historyGapMessages(artifact)).toEqual([
        "SEC gross profit is not derived for 2025-01-01 to 2025-12-31: the current revenue and CostOfRevenue revisions do not share one filing, form, span, and unit",
      ]);
    });

    test("declares an unmatched quarter even when a same-end year-to-date pair derives", () => {
      const quarter = (value: number) =>
        fact({
          value,
          form: "10-Q",
          fiscalPeriod: "Q2",
          filedAt: "2026-08-10",
          periodStart: "2026-04-01",
          periodEnd: "2026-06-30",
        });
      const halfYear = (value: number) =>
        fact({
          value,
          form: "10-Q",
          fiscalPeriod: "Q2",
          filedAt: "2026-08-10",
          periodStart: "2026-01-01",
          periodEnd: "2026-06-30",
        });
      const artifact = deriveAt({
        Revenues: [annual(100, 2025), quarter(30), halfYear(55)],
        CostOfRevenue: [annual(40, 2025), halfYear(20)],
      });

      expect(
        artifact.statements.incomeStatement.grossProfit.interim.map((item) => item.value),
      ).toEqual([35]);
      expect(historyGapMessages(artifact)).toEqual([
        "SEC gross profit is not derived for 2026-04-01 to 2026-06-30: no CostOfRevenue fact is tagged for the period",
      ]);
    });

    test("withholds a pair from different filings", () => {
      const { grossProfit } = deriveAt({
        Revenues: [annual(120, 2025)],
        CostOfRevenue: [{ ...annual(50, 2025), accn: "0000000000-26-000009" }],
      }).statements.incomeStatement;

      expect(grossProfit.annual).toEqual([]);
    });

    test("leaves gross profit missing without a derivation gap when cost of revenue is untagged", () => {
      const artifact = deriveAt({ Revenues: [annual(120, 2025)] });

      expect(artifact.statements.incomeStatement.grossProfit.annual).toEqual([]);
      expect(historyGapMessages(artifact)).toEqual([]);
    });
  });

  describe("pretax income from domestic + foreign components (ORCL FY26 10-K 0001193125-26-277521)", () => {
    const DOMESTIC = "IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic";
    const FOREIGN = "IncomeLossFromContinuingOperationsBeforeIncomeTaxesForeign";
    const TOTAL =
      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest";
    const EQUITY_METHOD_TOTAL =
      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments";
    const orclFy26 = (value: number) =>
      fact({
        value,
        form: "10-K",
        fiscalYear: 2026,
        fiscalPeriod: "FY",
        filedAt: "2026-06-22",
        periodStart: "2025-06-01",
        periodEnd: "2026-05-31",
        accessionNumber: "0001193125-26-277521",
      });
    const deriveAt = (concepts: Readonly<Record<string, readonly Record<string, unknown>[]>>) =>
      derive(
        payload({
          "us-gaap": Object.fromEntries(
            Object.entries(concepts).map(([concept, rows]) => [concept, { USD: rows }]),
          ),
        }),
        { analysisAsOf: "2026-09-01" },
      );

    test("sums same-filing components when no total is tagged, disclosed as derived", () => {
      const artifact = deriveAt({
        Revenues: [orclFy26(67_000_000_000)],
        IncomeTaxExpenseBenefit: [orclFy26(2_467_000_000)],
        [DOMESTIC]: [orclFy26(8_693_000_000)],
        [FOREIGN]: [orclFy26(10_861_000_000)],
      });
      const { pretaxIncome, incomeTaxExpense } = artifact.statements.incomeStatement;
      const [pretax] = pretaxIncome.annual;

      expect(pretax).toMatchObject({
        value: 19_554_000_000,
        accessionNumber: "0001193125-26-277521",
        periodEnd: "2026-05-31",
        concept: `${DOMESTIC}+${FOREIGN}`,
      });
      expect(incomeTaxExpense.annual[0]!.value / pretax!.value).toBeCloseTo(0.126_16, 5);
      expect(derivedFactDisclosure("pretaxIncome", pretax!)).toBe(
        `pretax income derived as ${DOMESTIC} + ${FOREIGN}; the components' filing tags no total pretax income`,
      );
      expect(historyGapMessages(artifact)).toEqual([]);
    });

    test("prefers a tagged total over disagreeing components", () => {
      const artifact = deriveAt({
        Revenues: [orclFy26(67_000_000_000)],
        [TOTAL]: [orclFy26(19_000_000_000)],
        [DOMESTIC]: [orclFy26(8_693_000_000)],
        [FOREIGN]: [orclFy26(10_861_000_000)],
      });

      expect(artifact.statements.incomeStatement.pretaxIncome.annual).toMatchObject([
        { value: 19_000_000_000, concept: TOTAL },
      ]);
    });

    test("never derives a period whose total is tagged under a non-selected alias", () => {
      const ALIAS =
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments";
      const artifact = deriveAt({
        Revenues: [annual(100, 2024), annual(120, 2025)],
        [TOTAL]: [annual(30, 2025)],
        [ALIAS]: [annual(25, 2024)],
        [DOMESTIC]: [annual(10, 2024), annual(12, 2025)],
        [FOREIGN]: [annual(14, 2024), annual(18, 2025)],
      });

      expect(
        artifact.statements.incomeStatement.pretaxIncome.annual.some(
          (row) => row.composite !== undefined,
        ),
      ).toBe(false);
    });

    test("leaves pretax income missing with a gap when only one component is tagged", () => {
      const artifact = deriveAt({
        Revenues: [orclFy26(67_000_000_000)],
        [DOMESTIC]: [orclFy26(8_693_000_000)],
      });

      expect(artifact.statements.incomeStatement.pretaxIncome.annual).toEqual([]);
      expect(historyGapMessages(artifact)).toContain(
        `SEC pretax income from continuing operations is not derived for 2025-06-01 to 2026-05-31: no ${FOREIGN} fact is tagged for the period`,
      );
    });

    test("withholds components from different filings", () => {
      const artifact = deriveAt({
        Revenues: [orclFy26(67_000_000_000)],
        [DOMESTIC]: [orclFy26(8_693_000_000)],
        [FOREIGN]: [{ ...orclFy26(10_861_000_000), accn: "0001193125-26-999999" }],
      });

      expect(artifact.statements.incomeStatement.pretaxIncome.annual).toEqual([]);
    });

    test("never pairs an annual component with a quarterly one ending the same day", () => {
      const artifact = deriveAt({
        Revenues: [orclFy26(67_000_000_000)],
        [DOMESTIC]: [orclFy26(8_693_000_000)],
        [FOREIGN]: [{ ...orclFy26(2_900_000_000), start: "2026-03-01", fp: "Q4" }],
      });

      expect(artifact.statements.incomeStatement.pretaxIncome.annual).toEqual([]);
      expect(historyGapMessages(artifact)).toContain(
        `SEC pretax income from continuing operations is not derived for 2025-06-01 to 2026-05-31: no ${FOREIGN} fact is tagged for the period`,
      );
    });

    test("withholds components whose spans start on different days", () => {
      const artifact = deriveAt({
        Revenues: [orclFy26(67_000_000_000)],
        [DOMESTIC]: [orclFy26(8_693_000_000)],
        [FOREIGN]: [{ ...orclFy26(10_861_000_000), start: "2025-06-02" }],
      });

      expect(artifact.statements.incomeStatement.pretaxIncome.annual).toEqual([]);
    });

    test("withholds components tagged in different units", () => {
      const artifact = derive(
        payload({
          "us-gaap": {
            Revenues: { USD: [orclFy26(67_000_000_000)] },
            [DOMESTIC]: { USD: [orclFy26(8_693_000_000)] },
            [FOREIGN]: { EUR: [orclFy26(10_861_000_000)] },
          },
        }),
        { analysisAsOf: "2026-09-01" },
      );

      expect(artifact.statements.incomeStatement.pretaxIncome.annual).toEqual([]);
    });

    describe("restated components", () => {
      const original = (value: number) => ({
        ...annual(value, 2024),
        accn: "0000000000-25-000001",
      });
      const restated = (value: number) => ({
        ...annual(value, 2024),
        filed: "2026-02-15",
        accn: "0000000000-26-000001",
      });

      test("sums the later filing's pair when it restates both components", () => {
        const artifact = deriveAt({
          Revenues: [annual(100, 2024)],
          [DOMESTIC]: [original(10), restated(11)],
          [FOREIGN]: [original(14), restated(15)],
        });

        expect(artifact.statements.incomeStatement.pretaxIncome.annual).toMatchObject([
          { value: 26, accessionNumber: "0000000000-26-000001" },
        ]);
      });

      test("withholds rather than mixing a restated component with an original one", () => {
        const artifact = deriveAt({
          Revenues: [annual(100, 2024)],
          [DOMESTIC]: [original(10), restated(11)],
          [FOREIGN]: [original(14)],
        });

        expect(artifact.statements.incomeStatement.pretaxIncome.annual).toEqual([]);
      });

      // ORCL FY2018 total 12,891M (10-K filed 2018-06-22) vs FY2020 10-K Domestic + Foreign 12,424M.
      test("a later component pair restates an older tagged total", () => {
        const artifact = deriveAt({
          Revenues: [annual(100, 2024)],
          [TOTAL]: [original(30)],
          [DOMESTIC]: [original(10), restated(11)],
          [FOREIGN]: [original(14), restated(15)],
        });

        const [pretax] = artifact.statements.incomeStatement.pretaxIncome.annual;

        expect(pretax).toMatchObject({
          value: 26,
          accessionNumber: "0000000000-26-000001",
          concept: `${DOMESTIC}+${FOREIGN}`,
          restatedFrom: { value: 30, filedAt: "2025-02-15" },
        });
        expect(derivedFactDisclosure("pretaxIncome", pretax!)).toBe(
          `pretax income derived as ${DOMESTIC} + ${FOREIGN}; the components' filing tags no total pretax income and restates the 30 total filed 2025-02-15`,
        );
      });

      test("withholds a superseded total when a later revision leaves the pair unpaired", () => {
        const revised = { ...restated(12), filed: "2026-05-01", accn: "0000000000-26-000002" };
        const artifact = deriveAt({
          Revenues: [annual(100, 2024)],
          [TOTAL]: [original(30)],
          [DOMESTIC]: [original(10), restated(11), revised],
          [FOREIGN]: [original(14), restated(15)],
        });

        expect(artifact.statements.incomeStatement.pretaxIncome.annual).toEqual([]);
        expect(historyGapMessages(artifact)).toContain(
          "SEC pretax income from continuing operations is not derived for 2024-01-01 to 2024-12-31: the current domestic and foreign pretax revisions do not share one filing, form, span, and unit",
        );
      });

      test("a same-day amended pair restates that day's original total", () => {
        const amended = (value: number) => ({
          ...annual(value, 2024, "10-K/A"),
          accn: "0000000000-25-000002",
        });
        const artifact = deriveAt({
          Revenues: [annual(100, 2024)],
          [TOTAL]: [original(30)],
          [DOMESTIC]: [amended(11)],
          [FOREIGN]: [amended(15)],
        });

        expect(artifact.statements.incomeStatement.pretaxIncome.annual).toMatchObject([
          { value: 26, accessionNumber: "0000000000-25-000002" },
        ]);
      });

      test("dates a restoring total from its own filing when a pair intervened", () => {
        const midYear = (value: number) => ({
          ...annual(value, 2024),
          filed: "2025-08-01",
          accn: "0000000000-25-000003",
        });
        const artifact = deriveAt({
          Revenues: [annual(100, 2024)],
          [TOTAL]: [original(26), restated(26)],
          [DOMESTIC]: [midYear(12)],
          [FOREIGN]: [midYear(18)],
        });

        expect(artifact.statements.incomeStatement.pretaxIncome.annual).toMatchObject([
          { value: 26, concept: TOTAL, firstPublicAt: "2026-02-15" },
        ]);
      });

      test("a total filed after the cutoff never displaces the standing total", () => {
        const midYear = (value: number) => ({
          ...annual(value, 2024),
          filed: "2025-08-01",
          accn: "0000000000-25-000003",
        });
        const artifact = deriveAt({
          Revenues: [annual(100, 2024)],
          [TOTAL]: [
            original(26),
            restated(26),
            { ...annual(31, 2024), filed: "2026-10-01", accn: "0000000000-26-000009" },
          ],
          [DOMESTIC]: [midYear(12)],
          [FOREIGN]: [midYear(18)],
        });

        expect(artifact.statements.incomeStatement.pretaxIncome.annual).toMatchObject([
          { value: 26, concept: TOTAL, firstPublicAt: "2026-02-15" },
        ]);
      });

      test("restatedFrom names the replaced tagged total, never an earlier derived pair", () => {
        const midYear = { ...annual(30, 2024), filed: "2025-08-01", accn: "0000000000-25-000003" };
        const artifact = deriveAt({
          Revenues: [annual(100, 2024)],
          [TOTAL]: [midYear],
          [DOMESTIC]: [original(10), restated(11)],
          [FOREIGN]: [original(14), restated(15)],
        });

        expect(artifact.statements.incomeStatement.pretaxIncome.annual).toMatchObject([
          { value: 26, restatedFrom: { value: 30, filedAt: "2025-08-01" } },
        ]);
      });

      test("dates a restoring pair from its own filing, not the first total with that value", () => {
        const artifact = deriveAt({
          Revenues: [annual(100, 2024)],
          [TOTAL]: [
            original(26),
            { ...annual(30, 2024), filed: "2025-08-01", accn: "0000000000-25-000003" },
          ],
          [DOMESTIC]: [restated(11)],
          [FOREIGN]: [restated(15)],
        });

        expect(artifact.statements.incomeStatement.pretaxIncome.annual).toMatchObject([
          { value: 26, firstPublicAt: "2026-02-15" },
        ]);
      });

      test("keeps the tagged total when the later pair is filed after the cutoff", () => {
        const artifact = deriveAt({
          Revenues: [annual(100, 2024)],
          [TOTAL]: [original(30)],
          [DOMESTIC]: [{ ...restated(11), filed: "2026-10-01" }],
          [FOREIGN]: [{ ...restated(15), filed: "2026-10-01" }],
        });

        expect(artifact.statements.incomeStatement.pretaxIncome.annual).toMatchObject([
          { value: 30, concept: TOTAL },
        ]);
      });

      test("keeps the tagged total without a gap when only one component is restated", () => {
        const artifact = deriveAt({
          Revenues: [annual(100, 2024)],
          [TOTAL]: [original(30)],
          [DOMESTIC]: [original(10), restated(11)],
          [FOREIGN]: [original(14)],
        });

        expect(artifact.statements.incomeStatement.pretaxIncome.annual).toMatchObject([
          { value: 30, concept: TOTAL },
        ]);
        expect(historyGapMessages(artifact)).toEqual([]);
      });

      test("a later pair never restates an equity-method-scoped total", () => {
        const artifact = deriveAt({
          Revenues: [annual(100, 2024)],
          [EQUITY_METHOD_TOTAL]: [original(28)],
          [DOMESTIC]: [restated(11)],
          [FOREIGN]: [restated(15)],
        });

        const [pretax] = artifact.statements.incomeStatement.pretaxIncome.annual;
        expect(pretax).toMatchObject({ value: 28, concept: EQUITY_METHOD_TOTAL });
        expect(pretax?.restatedFrom).toBeUndefined();
      });

      test("a pair filling a period tagged only with the equity-method total discloses no restatement", () => {
        const artifact = deriveAt({
          Revenues: [annual(100, 2024), annual(120, 2025)],
          [TOTAL]: [{ ...annual(40, 2025), filed: "2026-02-15", accn: "0000000000-26-000001" }],
          [EQUITY_METHOD_TOTAL]: [original(28)],
          [DOMESTIC]: [restated(11)],
          [FOREIGN]: [restated(15)],
        });

        const pretax = artifact.statements.incomeStatement.pretaxIncome.annual.find(
          (candidate) => candidate.periodEnd === "2024-12-31",
        );
        expect(pretax).toMatchObject({ value: 26, concept: `${DOMESTIC}+${FOREIGN}` });
        expect(derivedFactDisclosure("pretaxIncome", pretax!)).toBe(
          `pretax income derived as ${DOMESTIC} + ${FOREIGN}; the components' filing tags no total pretax income`,
        );
      });

      test("withholds a pair under an equity-method series instead of mixing scopes", () => {
        const artifact = deriveAt({
          Revenues: [annual(100, 2023), annual(100, 2024)],
          [EQUITY_METHOD_TOTAL]: [annual(28, 2024)],
          [DOMESTIC]: [annual(5, 2023)],
          [FOREIGN]: [annual(6, 2023)],
        });

        expect(artifact.statements.incomeStatement.pretaxIncome.annual).toMatchObject([
          { value: 28, concept: EQUITY_METHOD_TOTAL },
        ]);
        expect(historyGapMessages(artifact)).toContain(
          `SEC pretax income from continuing operations is not derived for 2023-01-01 to 2023-12-31: the series reports ${EQUITY_METHOD_TOTAL}, and domestic + foreign components are not proven to share its scope`,
        );
      });

      test("declares a period whose filing tags only the equity-method total beside its components", () => {
        const artifact = deriveAt({
          Revenues: [annual(100, 2023), annual(100, 2024)],
          [TOTAL]: [annual(40, 2024)],
          [EQUITY_METHOD_TOTAL]: [annual(11, 2023)],
          [DOMESTIC]: [annual(5, 2023)],
          [FOREIGN]: [annual(6, 2023)],
        });

        expect(artifact.statements.incomeStatement.pretaxIncome.annual).toMatchObject([
          { value: 40, concept: TOTAL },
        ]);
        expect(historyGapMessages(artifact)).toContain(
          `SEC pretax income from continuing operations is not derived for 2023-01-01 to 2023-12-31: no ${TOTAL} fact is tagged for the period, and its other pretax total differs in scope`,
        );
      });

      test("declares a period tagged only with the equity-method total even without components", () => {
        const artifact = deriveAt({
          Revenues: [annual(100, 2022), annual(100, 2023), annual(100, 2024)],
          [TOTAL]: [annual(30, 2022), annual(40, 2024)],
          [EQUITY_METHOD_TOTAL]: [annual(11, 2023)],
        });

        expect(historyGapMessages(artifact)).toContain(
          `SEC pretax income from continuing operations is not derived for 2023-01-01 to 2023-12-31: no ${TOTAL} fact is tagged for the period, and its other pretax total differs in scope`,
        );
      });

      test("leaves alias periods past the series' annual history to the stale-concept note", () => {
        const quarter = (value: number) =>
          fact({
            value,
            form: "10-Q",
            fiscalYear: 2025,
            fiscalPeriod: "Q1",
            filedAt: "2025-05-01",
            periodStart: "2025-01-01",
            periodEnd: "2025-03-31",
          });
        const artifact = deriveAt({
          Revenues: [annual(100, 2024), quarter(25)],
          [TOTAL]: [quarter(9)],
          [EQUITY_METHOD_TOTAL]: [annual(11, 2024)],
          [DOMESTIC]: [annual(5, 2024)],
          [FOREIGN]: [annual(6, 2024)],
        });

        const gaps = historyGapMessages(artifact);
        expect(gaps.filter((gap) => gap.includes("differs in scope"))).toEqual([]);
        expect(
          gaps.some((gap) => gap.includes(`annual history under ${TOTAL} has no annual period`)),
        ).toBe(true);
      });
    });
  });

  describe("consolidated net income fallback", () => {
    const deriveAt = (concepts: Readonly<Record<string, readonly Record<string, unknown>[]>>) =>
      derive(
        payload({
          "us-gaap": Object.fromEntries(
            Object.entries(concepts).map(([concept, rows]) => [concept, { USD: rows }]),
          ),
        }),
        { analysisAsOf: "2026-09-01" },
      );

    test("fills parent-uncovered periods from ProfitLoss when no NCI is tagged, marked derived", () => {
      const artifact = deriveAt({
        NetIncomeLoss: [annual(10, 2023)],
        ProfitLoss: [annual(10, 2023), annual(12, 2024), annual(15, 2025)],
      });
      const { netIncome } = artifact.statements.incomeStatement;

      expect(netIncome.annual.map(({ value, concept }) => ({ value, concept }))).toEqual([
        { value: 10, concept: "NetIncomeLoss" },
        { value: 12, concept: "ProfitLoss" },
        { value: 15, concept: "ProfitLoss" },
      ]);
      expect(netIncome.annual[0]?.extractionMethod).toBe("sec-companyfacts");
      expect(netIncome.annual[2]).toMatchObject({
        extractionMethod: "derived-sec-companyfacts",
        composite: {
          formula: "sum",
          components: [
            {
              concept: "ProfitLoss",
              value: 15,
              sourceIds: ["extended-sec-edgar-test-fundamentals"],
            },
          ],
        },
      });
      expect(historyGapMessages(artifact)).toEqual([]);
    });

    test("withholds a period with a tagged noncontrolling interest and declares it", () => {
      const artifact = deriveAt({
        NetIncomeLoss: [annual(10, 2023)],
        ProfitLoss: [annual(10, 2023), annual(12, 2024), annual(15, 2025)],
        NetIncomeLossAttributableToNoncontrollingInterest: [annual(1, 2025)],
      });

      expect(
        artifact.statements.incomeStatement.netIncome.annual.map((item) => item.value),
      ).toEqual([10, 12]);
      expect(historyGapMessages(artifact)).toEqual([
        "SEC net income is not derived for 2025-01-01 to 2025-12-31: a nonzero noncontrolling-interest income fact is tagged for the period",
      ]);
    });

    test("a zero noncontrolling-interest fact in the current ProfitLoss filing allows the fallback", () => {
      const artifact = deriveAt({
        NetIncomeLoss: [annual(10, 2023)],
        ProfitLoss: [annual(10, 2023), annual(15, 2025)],
        NetIncomeLossAttributableToNoncontrollingInterest: [annual(0, 2025)],
      });

      expect(
        artifact.statements.incomeStatement.netIncome.annual.map((item) => item.value),
      ).toEqual([10, 15]);
      expect(historyGapMessages(artifact)).toEqual([]);
    });

    for (const concept of [
      "IncomeLossFromContinuingOperationsAttributableToNoncontrollingEntity",
      "NetIncomeLossAttributableToRedeemableNoncontrollingInterest",
      "NetIncomeLossAttributableToNonredeemableNoncontrollingInterest",
    ]) {
      test(`a zero ${concept} fact withholds the fallback`, () => {
        const artifact = deriveAt({
          NetIncomeLoss: [annual(10, 2023)],
          ProfitLoss: [annual(10, 2023), annual(15, 2025)],
          [concept]: [annual(0, 2025)],
        });

        expect(
          artifact.statements.incomeStatement.netIncome.annual.map((item) => item.value),
        ).toEqual([10]);
        expect(historyGapMessages(artifact)).toEqual([
          "SEC net income is not derived for 2025-01-01 to 2025-12-31: a noncontrolling-interest income fact other than total net income attribution is tagged for the period",
        ]);
      });
    }

    test("a same-filing total zero NCI admits partial-scope zeros, as AVGO files them", () => {
      const artifact = deriveAt({
        NetIncomeLoss: [annual(10, 2023)],
        ProfitLoss: [annual(10, 2023), annual(15, 2025)],
        NetIncomeLossAttributableToNoncontrollingInterest: [annual(0, 2025)],
        ComprehensiveIncomeNetOfTaxAttributableToNoncontrollingInterest: [annual(0, 2025)],
        IncomeLossFromContinuingOperationsAttributableToNoncontrollingEntity: [annual(0, 2025)],
      });

      expect(
        artifact.statements.incomeStatement.netIncome.annual.map((item) => item.value),
      ).toEqual([10, 15]);
      expect(historyGapMessages(artifact)).toEqual([]);
    });

    test("a zero comprehensive-income NCI fact never accepts the fallback", () => {
      const artifact = deriveAt({
        NetIncomeLoss: [annual(10, 2023)],
        ProfitLoss: [annual(10, 2023), annual(15, 2025)],
        ComprehensiveIncomeNetOfTaxAttributableToNoncontrollingInterest: [annual(0, 2025)],
        OtherComprehensiveIncomeLossNetOfTaxAttributableToNoncontrollingInterest: [
          annual(-3, 2025),
        ],
      });

      expect(
        artifact.statements.incomeStatement.netIncome.annual.map((item) => item.value),
      ).toEqual([10]);
      expect(historyGapMessages(artifact)).toEqual([
        "SEC net income is not derived for 2025-01-01 to 2025-12-31: a noncontrolling-interest income fact other than total net income attribution is tagged for the period",
      ]);
    });

    test("a zero noncontrolling-interest fact beside a superseded ProfitLoss value withholds", () => {
      const artifact = deriveAt({
        NetIncomeLoss: [annual(10, 2023)],
        ProfitLoss: [
          annual(10, 2023),
          annual(15, 2025),
          fact({
            value: 16,
            form: "10-K/A",
            fiscalYear: 2025,
            fiscalPeriod: "FY",
            filedAt: "2026-05-01",
            periodStart: "2025-01-01",
            periodEnd: "2025-12-31",
          }),
        ],
        NetIncomeLossAttributableToNoncontrollingInterest: [annual(0, 2025)],
      });

      expect(
        artifact.statements.incomeStatement.netIncome.annual.map((item) => item.value),
      ).toEqual([10]);
      expect(historyGapMessages(artifact)).toEqual([
        "SEC net income is not derived for 2025-01-01 to 2025-12-31: a zero noncontrolling-interest income fact is tagged without a same-filing ProfitLoss of the current value",
      ]);
    });

    test("tests only the newest same-filing pair, skipping a difference explained by tagged NCI", () => {
      const artifact = deriveAt({
        NetIncomeLoss: [annual(8, 2022), annual(10, 2023)],
        ProfitLoss: [annual(9, 2022), annual(10, 2023), annual(15, 2025)],
        NetIncomeLossAttributableToNoncontrollingInterest: [annual(1, 2022)],
      });

      expect(
        artifact.statements.incomeStatement.netIncome.annual.map((item) => item.value),
      ).toEqual([8, 10, 15]);
      expect(historyGapMessages(artifact)).toEqual([]);
    });

    test("withholds every period when ProfitLoss differs from parent income on a shared period", () => {
      const artifact = deriveAt({
        NetIncomeLoss: [annual(10, 2023)],
        ProfitLoss: [annual(11, 2023), annual(15, 2025)],
      });

      expect(
        artifact.statements.incomeStatement.netIncome.annual.map((item) => item.value),
      ).toEqual([10]);
      expect(historyGapMessages(artifact)).toEqual([
        "SEC net income is not derived for 2025-01-01 to 2025-12-31: ProfitLoss differs from NetIncomeLoss in the same filing for the period ending 2023-12-31",
      ]);
    });

    test("ignores a noncontrolling-interest fact filed after the analysis cutoff", () => {
      const artifact = deriveAt({
        NetIncomeLoss: [annual(10, 2023)],
        ProfitLoss: [annual(10, 2023), annual(15, 2025)],
        NetIncomeLossAttributableToNoncontrollingInterest: [
          { ...annual(1, 2025), filed: "2026-10-01" },
        ],
      });

      expect(
        artifact.statements.incomeStatement.netIncome.annual.map((item) => item.value),
      ).toEqual([10, 15]);
      expect(historyGapMessages(artifact)).toEqual([]);
    });

    test("compares parent and consolidated income only within one filing context", () => {
      const artifact = deriveAt({
        NetIncomeLoss: [
          annual(10, 2023),
          { ...annual(12, 2023), form: "10-K/A", filed: "2024-05-01", accn: "20240501-10-K-A" },
        ],
        ProfitLoss: [annual(10, 2023), annual(15, 2024)],
      });

      expect(
        artifact.statements.incomeStatement.netIncome.annual.map((item) => item.value),
      ).toEqual([12, 15]);
      expect(historyGapMessages(artifact)).toEqual([]);
    });

    test("keeps parent net income unchanged when ProfitLoss is untagged", () => {
      const artifact = deriveAt({ NetIncomeLoss: [annual(10, 2023)] });

      expect(
        artifact.statements.incomeStatement.netIncome.annual.map(({ value, extractionMethod }) => ({
          value,
          extractionMethod,
        })),
      ).toEqual([{ value: 10, extractionMethod: "sec-companyfacts" }]);
      expect(historyGapMessages(artifact)).toEqual([]);
    });
  });

  describe("retained window", () => {
    test("judges dividends per share against its own cap, not the core cap", () => {
      const series = [
        windowSeries("revenue", [windowFact("duration:12", "2020-12-31")]),
        windowSeries("dividendsPerShare", [windowFact("duration:12", "2012-12-31")]),
      ];
      const marker = windowNote(
        "earlier-share-basis",
        "dividendsPerShare",
        "duration:12|2012-12-31",
      );
      const older = windowNote("declaration-span", "dividendsPerShare", "duration:12|2013-06-30");
      expect(withinRetainedWindow(series, [windowCap("2019-12-31"), marker, older])).toEqual([
        windowCap("2019-12-31"),
        marker,
        older,
      ]);
    });

    test("drops an odd-span dividend note older than its capped annual window when interim is uncapped", () => {
      const dividends = {
        ...windowSeries("dividendsPerShare", [windowFact("duration:12", "2016-12-31")]),
        interim: [windowFact("duration:3", "2023-03-31")],
      } as FinancialStatementSeries;
      const dividendCap = { ...windowCap("2015-12-31"), seriesKey: "dividendsPerShare" as const };
      const stale = windowNote("declaration-span", "dividendsPerShare", "duration:0|2012-06-28");
      const recent = windowNote("declaration-span", "dividendsPerShare", "duration:0|2023-06-28");
      expect(withinRetainedWindow([dividends], [dividendCap, stale, recent])).toEqual([
        dividendCap,
        recent,
      ]);
    });

    test("keeps a note on a retained period that shares its end with a dropped one", () => {
      const series = [
        windowSeries("revenue", [
          windowFact("duration:10", "2015-12-31"),
          windowFact("duration:12", "2016-12-31"),
        ]),
        windowSeries("depreciationAndAmortization", [windowFact("duration:12", "2016-12-31")]),
      ];
      const sameEnd = windowNote(
        "incomplete-composite-series",
        "depreciationAndAmortization",
        "duration:10|2015-12-31",
      );
      const dropped = windowNote(
        "incomplete-composite-series",
        "depreciationAndAmortization",
        "duration:12|2015-12-31",
      );
      expect(withinRetainedWindow(series, [windowCap("2015-12-31"), sameEnd, dropped])).toEqual([
        windowCap("2015-12-31"),
        sameEnd,
      ]);
    });

    test("keeps every note of a series with no retained period", () => {
      const series = [
        windowSeries("revenue", [windowFact("duration:12", "2020-12-31")]),
        windowSeries("depreciationAndAmortization", []),
      ];
      const only = windowNote(
        "incomplete-composite-series",
        "depreciationAndAmortization",
        "duration:12|2007-12-31",
      );
      expect(withinRetainedWindow(series, [windowCap("2015-12-31"), only])).toContainEqual(only);
    });

    // GILD shape: D&A notes back to 2007 while the 10-period cap keeps 2016 onward.
    const dna = (years: readonly number[]) => ({
      Depreciation: { USD: years.map((year) => annual(5, year)) },
      OtherDepreciationAndAmortization: { USD: years.map((year) => annual(7, year)) },
    });

    test("drops period notes older than every retained period and keeps in-window ones", () => {
      const years = Array.from({ length: 21 }, (_, index) => 2005 + index);
      const artifact = derive(
        payload({
          "us-gaap": {
            Revenues: { USD: years.map((year) => annual(100, year)) },
            ...dna([2007, 2020]),
            DepreciationDepletionAndAmortization: { USD: [annual(12, 2024)] },
          },
        }),
      );

      expect(artifact.statements.incomeStatement.revenue.annual[0]?.periodEnd).toBe("2016-12-31");
      expect(
        artifact.omissionNotes
          .filter((note) => note.seriesKey === "depreciationAndAmortization")
          .map((note) => note.periodKey),
      ).toEqual(["duration:12|2020-12-31"]);
      expect(historyGapMessages(artifact).filter((message) => message.includes("2007"))).toEqual(
        [],
      );
      expect(
        historyGapMessages(artifact).filter((message) => message.includes("2020-12-31")),
      ).toHaveLength(1);
      expect(artifact.omissionNotes.filter((note) => note.code === "history-cap")).not.toEqual([]);
    });
  });

  describe("stale concept history", () => {
    const ytd = (value: number, year: number) =>
      interim({ value, year, endMonthDay: "06-30", form: "10-Q", fiscalPeriod: "Q2" });
    const staleGapMessages = (companyFacts: unknown) =>
      financialStatementsHistoryGaps(derive(companyFacts, { analysisAsOf: "2026-09-01" })).map(
        (gap) => gap.message,
      );

    test("declares an alias whose annual history runs past the selected concept, unchanged", () => {
      const companyFacts = payload({
        "us-gaap": {
          PaymentsToAcquirePropertyPlantAndEquipment: {
            USD: [annual(10, 2018), annual(12, 2019), ytd(3, 2025), ytd(5, 2026)],
          },
          PaymentsToAcquireProductiveAssets: {
            USD: [annual(10, 2018), annual(12, 2019), annual(15, 2020), annual(20, 2025)],
          },
        },
      });
      const { capitalExpenditure } = derive(companyFacts, {
        analysisAsOf: "2026-09-01",
      }).statements.cashFlowStatement;

      expect(capitalExpenditure.annual.map((item) => item.value)).toEqual([10, 12]);
      expect(capitalExpenditure.interim.map((item) => item.value)).toEqual([3, 5]);
      expect(
        new Set(
          [...capitalExpenditure.annual, ...capitalExpenditure.interim].map((item) => item.concept),
        ),
      ).toEqual(new Set(["PaymentsToAcquirePropertyPlantAndEquipment"]));
      expect(staleGapMessages(companyFacts)).toEqual([
        "SEC capital expenditure annual history under PaymentsToAcquirePropertyPlantAndEquipment ends 2019-12-31, while PaymentsToAcquireProductiveAssets reports annual periods to 2025-12-31; the tags are not combined because their scope may differ",
      ]);
    });

    test("keeps still-current total revenue and declares the newer contract-revenue year", () => {
      const companyFacts = payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2023), ytd(500, 2024), ytd(600, 2025)] },
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            USD: [annual(100, 2024), ytd(50, 2024), ytd(60, 2025)],
          },
        },
      });
      const { revenue } = derive(companyFacts, {
        analysisAsOf: "2026-09-01",
      }).statements.incomeStatement;

      expect(revenue.interim.at(-1)).toMatchObject({ concept: "Revenues", value: 600 });
      expect(staleGapMessages(companyFacts)).toHaveLength(1);
    });

    test("keeps current cash rather than older restricted-inclusive cash", () => {
      const companyFacts = payload({
        "us-gaap": {
          CashAndCashEquivalentsAtCarryingValue: {
            USD: [
              instant(100, 2023),
              fact({
                value: 120,
                form: "10-Q",
                fiscalYear: 2025,
                fiscalPeriod: "Q2",
                filedAt: "2025-08-15",
                periodEnd: "2025-06-30",
              }),
            ],
          },
          CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents: {
            USD: [instant(1000, 2024)],
          },
        },
      });
      const { cash } = derive(companyFacts, { analysisAsOf: "2026-09-01" }).statements.balanceSheet;

      expect(cash.interim.at(-1)).toMatchObject({
        concept: "CashAndCashEquivalentsAtCarryingValue",
        value: 120,
      });
      expect(staleGapMessages(companyFacts)).toHaveLength(1);
    });

    test("leaves an alias holding only older annual periods to the history cap", () => {
      const companyFacts = payload({
        "us-gaap": {
          PaymentsToAcquirePropertyPlantAndEquipment: {
            USD: [annual(10, 2019), annual(12, 2020), ytd(3, 2020), ytd(5, 2021)],
          },
          PaymentsToAcquireProductiveAssets: { USD: [annual(8, 2017), annual(9, 2018)] },
        },
      });

      expect(staleGapMessages(companyFacts)).toEqual([]);
    });

    test("declares an alias whose only newer period is an interim, unchanged (KEEL Q2 2026)", () => {
      const q1 = (value: number, year: number) =>
        interim({ value, year, endMonthDay: "03-31", form: "10-Q", fiscalPeriod: "Q1" });
      const companyFacts = payload({
        "us-gaap": {
          Revenues: { USD: [annual(229_276, 2025), q1(47_651, 2025), q1(36_992, 2026)] },
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            USD: [ytd(108_559, 2025), ytd(67_422, 2026)],
          },
        },
      });
      const { revenue } = derive(companyFacts, {
        analysisAsOf: "2026-09-01",
      }).statements.incomeStatement;

      expect(revenue.interim.map((item) => [item.concept, item.value])).toEqual([
        ["Revenues", 47_651],
        ["Revenues", 36_992],
      ]);
      expect(staleGapMessages(companyFacts)).toEqual([
        "SEC revenue history under Revenues ends 2026-03-31, while RevenueFromContractWithCustomerExcludingAssessedTax reports periods to 2026-06-30; the tags are not combined because their scope may differ",
      ]);
    });

    test("leaves an alias whose interims end with the selected series undeclared", () => {
      const companyFacts = payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025), ytd(600, 2026)] },
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            USD: [ytd(500, 2025), ytd(550, 2026)],
          },
        },
      });

      expect(staleGapMessages(companyFacts)).toEqual([]);
    });

    test("does not count an alias's newer declaration-date span as a period", () => {
      const companyFacts = payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          CommonStockDividendsPerShareCashPaid: { "USD/shares": [annual(1, 2025)] },
          CommonStockDividendsPerShareDeclared: {
            "USD/shares": [
              fact({
                value: 0.25,
                form: "10-Q",
                fiscalYear: 2026,
                fiscalPeriod: "Q2",
                filedAt: "2026-08-15",
                periodStart: "2026-08-01",
                periodEnd: "2026-08-01",
              }),
            ],
          },
        },
      });

      expect(
        staleGapMessages(companyFacts).filter((message) => message.includes("dividends")),
      ).toEqual([]);
    });
  });

  describe("mixed share basis", () => {
    const fy = (value: number, year: number, filedAt: string) =>
      fact({
        value,
        form: "10-K",
        fiscalYear: year,
        fiscalPeriod: "FY",
        filedAt,
        periodStart: `${String(year)}-01-01`,
        periodEnd: `${String(year)}-12-31`,
      });
    const halfYear = (value: number, year: number, filedAt: string) =>
      fact({
        value,
        form: "10-Q",
        fiscalYear: year,
        fiscalPeriod: "Q2",
        filedAt,
        periodStart: `${String(year)}-01-01`,
        periodEnd: `${String(year)}-06-30`,
      });
    const revenue = {
      USD: [
        fy(100, 2023, "2024-02-15"),
        fy(120, 2024, "2025-02-15"),
        fy(150, 2025, "2026-02-15"),
        halfYear(70, 2025, "2025-08-15"),
        halfYear(80, 2026, "2026-08-15"),
        fact({
          value: 90,
          form: "10-Q",
          fiscalPeriod: "Q3",
          filedAt: "2025-11-15",
          periodStart: "2025-01-01",
          periodEnd: "2025-09-30",
        }),
        fact({
          value: 110,
          form: "10-Q",
          fiscalPeriod: "Q3",
          filedAt: "2026-11-15",
          periodStart: "2026-01-01",
          periodEnd: "2026-09-30",
        }),
      ],
    };
    const perShare = (
      eps: readonly Record<string, unknown>[],
      shares: readonly Record<string, unknown>[],
      analysisAsOf = "2026-09-01",
    ) =>
      derive(
        payload({
          "us-gaap": {
            Revenues: revenue,
            EarningsPerShareDiluted: { "USD/shares": eps },
            WeightedAverageNumberOfDilutedSharesOutstanding: { shares },
          },
        }),
        { analysisAsOf },
      );

    test("declares never-refiled pre-split ServiceNow-shaped periods and withholds spanning comparisons", () => {
      const artifact = perShare(
        [
          fy(3, 2020, "2021-02-15"),
          fy(4, 2021, "2022-02-15"),
          fy(5, 2022, "2023-02-15"),
          fy(8.42, 2023, "2024-02-15"),
          fy(1.68, 2023, "2026-01-29"),
          fy(6.84, 2024, "2025-02-15"),
          fy(1.37, 2024, "2026-01-29"),
          fy(2, 2025, "2026-01-29"),
          halfYear(4.04, 2025, "2025-08-15"),
          halfYear(0.5, 2026, "2026-08-15"),
        ],
        [
          fy(203_500_000, 2022, "2023-02-15"),
          fy(205_591_000, 2023, "2024-02-15"),
          fy(1_027_953_000, 2023, "2026-01-29"),
          fy(208_423_000, 2024, "2025-02-15"),
          fy(1_042_113_000, 2024, "2026-01-29"),
          fy(1_050_000_000, 2025, "2026-01-29"),
          halfYear(209_343_000, 2025, "2025-08-15"),
          halfYear(1_055_000_000, 2026, "2026-08-15"),
        ],
        "2026-12-01",
      );
      const { dilutedEps } = artifact.statements.perShare;

      expect(dilutedEps.annual.map((item) => item.value)).toEqual([3, 4, 5, 1.68, 1.37, 2]);
      expect(dilutedEps.interim.map((item) => item.value)).toEqual([4.04, 0.5]);
      expect(historyGapMessages(artifact)).toEqual([
        "SEC diluted EPS periods ending 2020-12-31 to 2025-06-30 (4 retained) were last filed before 2026-01-29, the latest filing to restate share-based history; filings restate diluted EPS for periods ending 2023-12-31 to 2024-12-31 by ~1/5, so those periods are on an earlier or unconfirmed share basis and are not adjusted",
        "SEC diluted weighted-average shares periods ending 2022-12-31 to 2025-06-30 (2 retained) were last filed before 2026-01-29, the latest filing to restate share-based history; filings restate diluted weighted-average shares for periods ending 2023-12-31 to 2024-12-31 by ~5x, so those periods are on an earlier or unconfirmed share basis and are not adjusted",
      ]);
      expect(dilutedEps.ttm).toBeUndefined();
      expect(artifact.validationNotes).toContainEqual(
        expect.objectContaining({ code: "unreconciled-ttm", seriesKey: "dilutedEps" }),
      );
      expect(
        valuationPeriodInputs(artifact)
          .periods.filter((period) => period.basis === "ttm")
          .map((period) => [period.periodEnd, period.dilutedEps]),
      ).toEqual([
        ["2026-06-30", undefined],
        ["2026-09-30", undefined],
      ]);
      const history = deriveFundamentalHistoryFromFinancialStatements(artifact);
      expect(history.series.dilutedEps.cagr).toBeUndefined();
      expect(history.series.dilutedEps.notes).toContain(
        "cagr:mixed-share-basis: an annual endpoint is on an earlier or unconfirmed share basis",
      );
      expect(
        fundamentalHistoryView({
          summary: {} as RunSummary,
          fundamentalHistory: history,
        })?.cards.find((card) => card.key === "dilutedEps")?.disclosure,
      ).toBe(
        "Earlier EPS points are on an earlier or unconfirmed share basis and are not adjusted.",
      );
      expect(balanceSheetHistory(artifact, undefined)?.notes).toContainEqual(
        expect.objectContaining({ code: "mixed-share-basis", seriesKey: "dilutedShares" }),
      );
      const lens = withCanonicalFinancialLensInputs(undefined, artifact).items[0]?.metrics;
      expect(lens).toMatchObject({ dilutedEps: 0.5 });
      expect(lens?.dilutedEpsDeltaPercent).toBeUndefined();
    });

    test("keeps a post-split period filed before the latest restating filing on the new basis", () => {
      const artifact = perShare(
        [
          fy(4, 2022, "2023-02-15"),
          fy(4.5, 2023, "2024-02-15"),
          fy(0.9, 2023, "2026-02-15"),
          fy(5, 2024, "2025-02-15"),
          fy(1, 2024, "2026-02-15"),
          fy(1.2, 2025, "2026-02-15"),
          halfYear(1, 2025, "2025-08-15"),
          halfYear(1.1, 2026, "2026-08-15"),
        ],
        [
          fy(100, 2022, "2023-02-15"),
          fy(100, 2023, "2024-02-15"),
          fy(500, 2023, "2026-02-15"),
          fy(100, 2024, "2025-02-15"),
          fy(500, 2024, "2026-02-15"),
          fy(505, 2025, "2026-02-15"),
          halfYear(502, 2025, "2025-08-15"),
          halfYear(510, 2026, "2026-08-15"),
        ],
      );

      expect(historyGapMessages(artifact)).toEqual([
        expect.stringContaining(
          "SEC diluted EPS periods ending 2022-12-31 to 2022-12-31 (1 retained)",
        ),
        expect.stringContaining(
          "SEC diluted weighted-average shares periods ending 2022-12-31 to 2022-12-31 (1 retained)",
        ),
      ]);
      expect(artifact.statements.perShare.dilutedEps.ttm?.value).toBeCloseTo(1.3);
      expect(
        withCanonicalFinancialLensInputs(undefined, artifact).items[0]?.metrics
          ?.dilutedEpsDeltaPercent,
      ).toBeCloseTo(10);
    });

    test("declares never-refiled pre-split dividends per share on the earlier share basis", () => {
      const artifact = derive(
        payload({
          "us-gaap": {
            Revenues: revenue,
            EarningsPerShareDiluted: {
              "USD/shares": [
                fy(4, 2022, "2023-02-15"),
                fy(4.5, 2023, "2024-02-15"),
                fy(0.9, 2023, "2026-02-15"),
                fy(5, 2024, "2025-02-15"),
                fy(1, 2024, "2026-02-15"),
                fy(1.2, 2025, "2026-02-15"),
              ],
            },
            WeightedAverageNumberOfDilutedSharesOutstanding: {
              shares: [
                fy(100, 2022, "2023-02-15"),
                fy(100, 2023, "2024-02-15"),
                fy(500, 2023, "2026-02-15"),
                fy(100, 2024, "2025-02-15"),
                fy(500, 2024, "2026-02-15"),
                fy(505, 2025, "2026-02-15"),
              ],
            },
            CommonStockDividendsPerShareDeclared: {
              "USD/shares": [
                fy(2, 2022, "2023-02-15"),
                fy(2, 2023, "2024-02-15"),
                fy(0.4, 2023, "2026-02-15"),
                fy(2.5, 2024, "2025-02-15"),
                fy(0.5, 2024, "2026-02-15"),
                fy(0.6, 2025, "2026-02-15"),
              ],
            },
          },
        }),
        { analysisAsOf: "2026-09-01" },
      );

      expect(
        artifact.omissionNotes
          .filter((note) => note.code === "earlier-share-basis")
          .map((note) => [note.seriesKey, note.periodKey]),
      ).toEqual([
        ["dilutedEps", "duration:12|2022-12-31"],
        ["dilutedShares", "duration:12|2022-12-31"],
        ["dividendsPerShare", "duration:12|2022-12-31"],
      ]);
      expect(
        artifact.statements.perShare.dividendsPerShare.annual.map((item) => item.value),
      ).toEqual([2, 0.4, 0.5, 0.6]);
    });

    test("keeps split protection when the restating filing also corrects dividends per share", () => {
      const artifact = derive(
        payload({
          "us-gaap": {
            Revenues: revenue,
            EarningsPerShareDiluted: {
              "USD/shares": [
                fy(4, 2022, "2023-02-15"),
                fy(5, 2024, "2025-02-15"),
                fy(1, 2024, "2026-02-15"),
                fy(1.2, 2025, "2026-02-15"),
              ],
            },
            WeightedAverageNumberOfDilutedSharesOutstanding: {
              shares: [
                fy(100, 2022, "2023-02-15"),
                fy(100, 2024, "2025-02-15"),
                fy(500, 2024, "2026-02-15"),
                fy(505, 2025, "2026-02-15"),
              ],
            },
            CommonStockDividendsPerShareDeclared: {
              "USD/shares": [
                fy(2, 2022, "2023-02-15"),
                fy(2.5, 2024, "2025-02-15"),
                fy(0.6, 2024, "2026-02-15"),
                fy(0.65, 2025, "2026-02-15"),
              ],
            },
          },
        }),
        { analysisAsOf: "2026-09-01" },
      );

      expect(
        artifact.omissionNotes
          .filter((note) => note.code === "earlier-share-basis")
          .map((note) => [note.seriesKey, note.periodKey]),
      ).toEqual([
        ["dilutedEps", "duration:12|2022-12-31"],
        ["dilutedShares", "duration:12|2022-12-31"],
        ["dividendsPerShare", "duration:12|2022-12-31"],
      ]);
    });

    test("reads a per-share fact against the share count filed with it", () => {
      const artifact = perShare(
        [
          fy(5, 2022, "2023-02-15"),
          fy(8.42, 2023, "2024-02-15"),
          fy(6.84, 2024, "2025-02-15"),
          fy(1.37, 2024, "2026-01-29"),
        ],
        [
          fy(200, 2022, "2023-02-15"),
          fy(205, 2023, "2024-02-15"),
          fy(1025, 2023, "2026-01-29"),
          fy(208, 2024, "2025-02-15"),
          fy(1040, 2024, "2026-01-29"),
        ],
      );

      expect(historyGapMessages(artifact)[0]).toStartWith(
        "SEC diluted EPS periods ending 2022-12-31 to 2023-12-31 (2 retained)",
      );
    });

    test("separates two same-factor splits filed within a year", () => {
      const artifact = perShare(
        [
          fy(2, 2022, "2023-02-15"),
          fy(2, 2023, "2024-02-15"),
          fy(1, 2023, "2025-02-15"),
          fy(1.5, 2024, "2025-02-15"),
          fy(0.75, 2024, "2026-01-15"),
          fy(1, 2025, "2026-01-15"),
        ],
        [
          fy(100, 2022, "2023-02-15"),
          fy(100, 2023, "2024-02-15"),
          fy(200, 2023, "2025-02-15"),
          fy(200, 2024, "2025-02-15"),
          fy(400, 2024, "2026-01-15"),
          fy(400, 2025, "2026-01-15"),
        ],
      );

      expect(historyGapMessages(artifact)).toEqual([
        expect.stringContaining(
          "SEC diluted EPS periods ending 2022-12-31 to 2023-12-31 (2 retained)",
        ),
        expect.stringContaining(
          "SEC diluted weighted-average shares periods ending 2022-12-31 to 2023-12-31 (2 retained)",
        ),
      ]);
      expect(
        deriveFundamentalHistoryFromFinancialStatements(artifact).series.dilutedEps.cagr,
      ).toBeUndefined();
    });

    test("withholds comparisons among periods on two earlier share bases", () => {
      const artifact = perShare(
        [
          fy(4, 2022, "2023-02-15"),
          fy(4, 2023, "2024-02-15"),
          fy(2, 2023, "2025-02-15"),
          fy(2, 2024, "2025-02-15"),
          halfYear(2, 2024, "2024-08-15"),
          halfYear(1, 2025, "2025-08-15"),
        ],
        [
          fy(100, 2022, "2023-02-15"),
          fy(100, 2023, "2024-02-15"),
          fy(200, 2023, "2025-02-15"),
          fy(200, 2024, "2025-02-15"),
          fy(400, 2024, "2026-11-15"),
          halfYear(100, 2024, "2024-08-15"),
          halfYear(200, 2025, "2025-08-15"),
          fy(200, 2025, "2026-02-15"),
          fy(400, 2025, "2026-11-15"),
        ],
        "2026-12-01",
      );

      expect(historyGapMessages(artifact)[0]).toStartWith(
        "SEC diluted EPS periods ending 2022-12-31 to 2025-06-30 (5 retained)",
      );
      expect(artifact.statements.perShare.dilutedEps.ttm).toBeUndefined();
      expect(
        deriveFundamentalHistoryFromFinancialStatements(artifact).series.dilutedEps.cagr,
      ).toBeUndefined();
      expect(
        withCanonicalFinancialLensInputs(undefined, artifact).items[0]?.metrics
          ?.dilutedEpsDeltaPercent,
      ).toBeUndefined();
      expect(
        valuationPeriodInputs(artifact)
          .periods.filter((period) => period.basis === "ttm")
          .map((period) => period.dilutedEps),
      ).toEqual([undefined, undefined]);
    });

    test("dates the change by first publication, not by a later unchanged re-filing", () => {
      const artifact = perShare(
        [
          fy(5, 2022, "2023-02-15"),
          fy(8.42, 2023, "2024-02-15"),
          fy(1.68, 2023, "2026-01-29"),
          fy(1.68, 2023, "2027-01-29"),
          fy(2, 2025, "2026-01-29"),
        ],
        [
          fy(200, 2022, "2023-02-15"),
          fy(205, 2023, "2024-02-15"),
          fy(1025, 2023, "2026-01-29"),
          fy(1025, 2023, "2027-01-29"),
          fy(1050, 2025, "2026-01-29"),
        ],
        "2027-03-01",
      );

      expect(historyGapMessages(artifact)[0]).toStartWith(
        "SEC diluted EPS periods ending 2022-12-31 to 2022-12-31 (1 retained) were last filed before 2026-01-29,",
      );
    });

    test("detects a change whose restated periods fall outside the retained window", () => {
      const halfYears = Array.from({ length: 12 }, (_, index) => 2015 + index);
      const artifact = perShare(
        [
          fy(4, 2013, "2014-02-15"),
          halfYear(2, 2014, "2014-08-15"),
          halfYear(1, 2014, "2015-08-15"),
          ...halfYears.map((year) => halfYear(1, year, `${String(year)}-08-15`)),
        ],
        [
          fy(100, 2013, "2014-02-15"),
          halfYear(100, 2014, "2014-08-15"),
          halfYear(200, 2014, "2015-08-15"),
          ...halfYears.map((year) => halfYear(200, year, `${String(year)}-08-15`)),
        ],
      );

      expect(
        artifact.statements.perShare.dilutedShares.interim.some(
          (item) => item.periodEnd === "2014-06-30",
        ),
      ).toBe(false);
      expect(historyGapMessages(artifact)).toEqual([
        expect.stringContaining(
          "SEC diluted EPS periods ending 2013-12-31 to 2013-12-31 (1 retained)",
        ),
        expect.stringContaining(
          "SEC diluted weighted-average shares periods ending 2013-12-31 to 2013-12-31 (1 retained)",
        ),
      ]);
    });

    test("declares a reverse split from per-share and share-count restatements", () => {
      const artifact = perShare(
        [
          fy(-0.3, 2022, "2023-02-15"),
          fy(-0.37, 2023, "2024-02-15"),
          fy(-5.61, 2023, "2025-02-15"),
          fy(-4, 2024, "2025-02-15"),
        ],
        [
          fy(24_000_000, 2022, "2023-02-15"),
          fy(23_992_995, 2023, "2024-02-15"),
          fy(1_598_756, 2023, "2025-02-15"),
          fy(1_650_000, 2024, "2025-02-15"),
        ],
      );

      expect(artifact.statements.perShare.dilutedEps.annual.map((item) => item.value)).toEqual([
        -0.3, -5.61, -4,
      ]);
      expect(historyGapMessages(artifact)).toEqual([
        "SEC diluted EPS periods ending 2022-12-31 to 2022-12-31 (1 retained) were last filed before 2025-02-15, the latest filing to restate share-based history; filings restate diluted EPS for periods ending 2023-12-31 to 2023-12-31 by ~15x, so those periods are on an earlier or unconfirmed share basis and are not adjusted",
        "SEC diluted weighted-average shares periods ending 2022-12-31 to 2022-12-31 (1 retained) were last filed before 2025-02-15, the latest filing to restate share-based history; filings restate diluted weighted-average shares for periods ending 2023-12-31 to 2023-12-31 by ~1/15, so those periods are on an earlier or unconfirmed share basis and are not adjusted",
      ]);
    });

    test("ignores earnings corrections, unit-scale corrections, and lone restatements", () => {
      const salesforce = perShare(
        [
          fy(0.3, 2015, "2016-03-01"),
          fy(0.26, 2016, "2017-03-06"),
          fy(0.46, 2016, "2019-03-08"),
          fy(0.17, 2017, "2018-03-09"),
          fy(0.49, 2017, "2019-03-08"),
        ],
        [],
      );
      const doubledEarnings = perShare(
        [
          fy(1, 2022, "2023-02-15"),
          fy(2, 2023, "2024-02-15"),
          fy(4, 2023, "2026-02-15"),
          fy(3, 2024, "2025-02-15"),
          fy(6, 2024, "2026-02-15"),
        ],
        [
          fy(100, 2022, "2023-02-15"),
          fy(100, 2023, "2024-02-15"),
          fy(100, 2023, "2026-02-15"),
          fy(100, 2024, "2025-02-15"),
          fy(100, 2024, "2026-02-15"),
        ],
      );
      const rescaled = perShare(
        [fy(1, 2021, "2022-02-15")],
        [
          fy(200, 2021, "2022-02-15"),
          fy(210, 2022, "2023-02-15"),
          fy(210_000_000, 2022, "2025-02-15"),
          fy(220, 2023, "2024-02-15"),
          fy(220_000_000, 2023, "2025-02-15"),
        ],
      );
      const singlePeriod = perShare(
        [fy(2, 2016, "2017-03-06"), fy(1, 2017, "2018-03-09")],
        [fy(100, 2016, "2017-03-06"), fy(100, 2017, "2018-03-09"), fy(200, 2017, "2019-03-08")],
      );

      for (const artifact of [salesforce, doubledEarnings, rescaled, singlePeriod]) {
        expect(historyGapMessages(artifact)).toEqual([]);
      }
    });
  });

  test("keeps total revenue for MARA/TeraWulf-class competing concepts", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(90, 2018)] },
          SalesRevenueNet: { USD: [annual(150, 2024), annual(175, 2025)] },
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            USD: [
              fact({
                value: 17,
                form: "10-K",
                fiscalYear: 2026,
                fiscalPeriod: "FY",
                filedAt: "2026-05-01",
                periodStart: "2025-04-01",
                periodEnd: "2026-03-31",
              }),
            ],
          },
        },
      }),
    );

    const { revenue } = artifact.statements.incomeStatement;
    expect(revenue.annual.map((item) => item.value)).toEqual([150, 175]);
    expect(new Set([...revenue.annual, ...revenue.interim].map((item) => item.concept))).toEqual(
      new Set(["SalesRevenueNet"]),
    );
  });

  test.each([
    { cadence: "quarterly", form: "10-Q" as const, endMonthDay: "03-31", fp: "Q1" },
    { cadence: "semiannual", form: "6-K" as const, endMonthDay: "06-30", fp: "H1" },
  ])("derives exact $cadence TTM components", ({ cadence, form, endMonthDay, fp }) => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: {
            USD: [
              annual(80, 2023, form === "6-K" ? "20-F" : "10-K"),
              annual(100, 2024, form === "6-K" ? "20-F" : "10-K"),
              interim({ value: 20, year: 2024, endMonthDay, form, fiscalPeriod: fp }),
              interim({ value: 30, year: 2025, endMonthDay, form, fiscalPeriod: fp }),
            ],
          },
        },
      }),
    );

    expect(artifact.interimCadence).toBe(cadence);
    expect(artifact.statements.incomeStatement.revenue.ttm).toMatchObject({
      value: 110,
      formula: "FY + latest-YTD - prior-YTD",
      components: {
        fiscalYear: { value: 100 },
        latestYearToDate: { value: 30 },
        priorYearToDate: { value: 20 },
      },
    });
  });

  test.each([{ hasLatestYtd: true }, { hasLatestYtd: false }])(
    "selects YTD beside rolling-year facts without falling back to an older end, latest YTD: $hasLatestYtd",
    ({ hasLatestYtd }) => {
      const artifact = derive(
        payload({
          "us-gaap": {
            Revenues: {
              USD: [
                annual(100, 2024),
                interim({
                  value: 9,
                  year: 2024,
                  endMonthDay: "03-31",
                  form: "10-Q",
                  fiscalPeriod: "Q1",
                }),
                interim({
                  value: 20,
                  year: 2024,
                  endMonthDay: "06-30",
                  form: "10-Q",
                  fiscalPeriod: "Q2",
                }),
                interim({
                  value: 14,
                  year: 2025,
                  endMonthDay: "03-31",
                  form: "10-Q",
                  fiscalPeriod: "Q1",
                }),
                ...(hasLatestYtd
                  ? [
                      interim({
                        value: 30,
                        year: 2025,
                        endMonthDay: "06-30",
                        form: "10-Q",
                        fiscalPeriod: "Q2",
                      }),
                    ]
                  : []),
                ...["2024-07-01", "2025-04-01"].map((periodStart) =>
                  fact({
                    value: 110,
                    form: "10-Q",
                    fiscalYear: 2025,
                    fiscalPeriod: "Q2",
                    filedAt: "2025-08-15",
                    periodStart,
                    periodEnd: "2025-06-30",
                  }),
                ),
              ],
            },
          },
        }),
      );
      const { ttm } = artifact.statements.incomeStatement.revenue;
      if (hasLatestYtd) {
        expect(ttm).toMatchObject({
          value: 110,
          periodStart: "2024-07-01",
          periodEnd: "2025-06-30",
          components: {
            fiscalYear: { value: 100 },
            latestYearToDate: { value: 30, periodStart: "2025-01-01" },
            priorYearToDate: { value: 20 },
          },
        });
      } else {
        expect(ttm).toBeUndefined();
        expect(artifact.validationNotes).toContainEqual(
          expect.objectContaining({
            code: "unreconciled-ttm",
            seriesKey: "revenue",
            message: "No latest-end interim duration fact starts at the fiscal-year boundary",
          }),
        );
      }
    },
  );

  test("withholds FY-as-TTM when a later quarter is filed under another revenue concept", () => {
    const fiscalYear = fact({
      value: 57_399,
      form: "10-K",
      fiscalYear: 2025,
      fiscalPeriod: "FY",
      filedAt: "2025-06-20",
      periodStart: "2024-06-01",
      periodEnd: "2025-05-31",
    });
    const laterQuarter = fact({
      value: 14_926,
      form: "10-Q",
      fiscalYear: 2026,
      fiscalPeriod: "Q1",
      filedAt: "2025-09-10",
      periodStart: "2025-06-01",
      periodEnd: "2025-08-31",
    });
    const withLater = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [fiscalYear] },
          RevenueFromContractWithCustomerExcludingAssessedTax: { USD: [laterQuarter] },
        },
      }),
    );
    expect(withLater.statements.incomeStatement.revenue.ttm).toBeUndefined();
    expect(withLater.validationNotes).toContainEqual(
      expect.objectContaining({
        code: "unreconciled-ttm",
        seriesKey: "revenue",
        message: expect.stringContaining(
          "RevenueFromContractWithCustomerExcludingAssessedTax for 2025-06-01 to 2025-08-31 is filed outside this series (10-Q accession 20250910-10-Q)",
        ),
      }),
    );

    expect(withLater.statements.incomeStatement.revenue.supersedingFacts).toEqual([
      {
        concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
        periodStart: "2025-06-01",
        periodEnd: "2025-08-31",
        firstPublicAt: "2025-09-10",
        form: "10-Q",
        accessionNumber: "20250910-10-Q",
      },
    ]);

    const fyOnly = derive(payload({ "us-gaap": { Revenues: { USD: [fiscalYear] } } }));
    expect(fyOnly.statements.incomeStatement.revenue.supersedingFacts).toEqual([]);
    expect(fyOnly.statements.incomeStatement.revenue.ttm?.formula).toBe("FY");
    expect(fyOnly.validationNotes.map((note) => note.code)).not.toContain("unreconciled-ttm");
  });

  test("keeps FY-as-TTM when the only later duration fact is a subsequent event in the FY's own 10-K", () => {
    const fiscalYear = fact({
      value: 4500,
      form: "10-K",
      fiscalYear: 2026,
      fiscalPeriod: "FY",
      filedAt: "2026-05-20",
      periodStart: "2025-04-01",
      periodEnd: "2026-03-31",
    });
    const subsequentEvent = fact({
      value: 30,
      form: "10-K",
      fiscalYear: 2026,
      fiscalPeriod: "FY",
      filedAt: "2026-05-20",
      periodStart: "2026-04-20",
      periodEnd: "2026-05-15",
    });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [fiscalYear] },
          PaymentsForRepurchaseOfCommonStock: { USD: [subsequentEvent] },
        },
      }),
    );
    expect(artifact.statements.incomeStatement.revenue.ttm?.formula).toBe("FY");
    expect(artifact.statements.incomeStatement.revenue.supersedingFacts).toEqual([]);
    expect(artifact.validationNotes.map((note) => note.code)).not.toContain("unreconciled-ttm");
  });

  // CLSK FY2023 10-K 0000950170-23-067339 (filed 2023-12-01) tags amortization for FY2026.
  test("a forward period tagged in an older 10-K does not supersede a later FY-as-TTM", () => {
    const fiscalYear = fact({
      value: 766,
      form: "10-K",
      fiscalYear: 2025,
      fiscalPeriod: "FY",
      filedAt: "2025-11-25",
      periodStart: "2024-10-01",
      periodEnd: "2025-09-30",
    });
    const forwardPeriod = fact({
      value: 1,
      form: "10-K",
      fiscalYear: 2023,
      fiscalPeriod: "FY",
      filedAt: "2023-12-01",
      periodStart: "2025-10-01",
      periodEnd: "2026-09-30",
      accessionNumber: "0000950170-23-067339",
    });
    const laterQuarter = fact({
      value: 181,
      form: "10-Q",
      fiscalYear: 2026,
      fiscalPeriod: "Q1",
      filedAt: "2026-02-05",
      periodStart: "2025-10-01",
      periodEnd: "2025-12-31",
    });
    const derivedWith = (...revenue: Record<string, unknown>[]) =>
      derive(
        payload({
          "us-gaap": {
            Revenues: { USD: revenue },
            AmortizationOfIntangibleAssets: { USD: [forwardPeriod] },
          },
        }),
        { analysisAsOf: "2026-10-01T00:00:00.000Z" },
      ).statements.incomeStatement.revenue;

    const fyOnly = derivedWith(fiscalYear);
    expect(fyOnly.ttm?.formula).toBe("FY");
    expect(fyOnly.supersedingFacts).toEqual([]);

    const withQuarter = derivedWith(fiscalYear, laterQuarter);
    expect(withQuarter.ttm?.formula).not.toBe("FY");
    expect(withQuarter.supersedingFacts).toEqual([
      expect.objectContaining({
        form: "10-Q",
        periodEnd: "2025-12-31",
        firstPublicAt: "2026-02-05",
      }),
    ]);
  });

  test("withholds FY-as-TTM when a 10-K/A also tags the completed next quarter", () => {
    const accessionNumber = "0000000000-25-000077";
    const restatedFiscalYear = fact({
      value: 57_399,
      form: "10-K/A",
      fiscalYear: 2025,
      fiscalPeriod: "FY",
      filedAt: "2025-09-10",
      periodStart: "2024-06-01",
      periodEnd: "2025-05-31",
      accessionNumber,
    });
    const quarter = fact({
      value: 14_926,
      form: "10-K/A",
      fiscalYear: 2025,
      fiscalPeriod: "FY",
      filedAt: "2025-09-10",
      periodStart: "2025-06-01",
      periodEnd: "2025-08-31",
      accessionNumber,
    });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [restatedFiscalYear] },
          RevenueFromContractWithCustomerExcludingAssessedTax: { USD: [quarter] },
        },
      }),
    );
    expect(artifact.statements.incomeStatement.revenue.ttm).toBeUndefined();
    expect(artifact.validationNotes).toContainEqual(
      expect.objectContaining({
        code: "unreconciled-ttm",
        seriesKey: "revenue",
        message: expect.stringContaining(`(10-K/A accession ${accessionNumber})`),
      }),
    );
  });

  test("detects quarterly 6-K cadence across quarter-only and year-to-date contexts", () => {
    const artifact = derive(
      payload({
        "ifrs-full": {
          Revenue: {
            USD: [
              annual(100, 2024, "20-F"),
              fact({
                value: 20,
                form: "6-K",
                fiscalYear: 2025,
                fiscalPeriod: "Q2",
                filedAt: "2025-08-15",
                periodStart: "2025-04-01",
                periodEnd: "2025-06-30",
              }),
              fact({
                value: 45,
                form: "6-K",
                fiscalYear: 2025,
                fiscalPeriod: "Q2",
                filedAt: "2025-08-15",
                periodStart: "2025-01-01",
                periodEnd: "2025-06-30",
              }),
              fact({
                value: 72,
                form: "6-K",
                fiscalYear: 2025,
                fiscalPeriod: "Q3",
                filedAt: "2025-11-15",
                periodStart: "2025-01-01",
                periodEnd: "2025-09-30",
              }),
            ],
          },
        },
      }),
    );

    expect(artifact.interimCadence).toBe("quarterly");
  });

  test("applies annual history caps across the artifact, not per series", () => {
    const years = Array.from({ length: 12 }, (_, index) => 2009 + index);
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: years.slice(1).map((year) => annual(year, year)) },
          NetCashProvidedByUsedInOperatingActivities: {
            USD: years.slice(0, -1).map((year) => annual(year, year)),
          },
        },
      }),
      { analysisAsOf: "2022-06-15T00:00:00.000Z" },
    );
    const annualPeriods = new Set(
      Object.values(artifact.statements)
        .flatMap((statement) => Object.values(statement))
        .flatMap((series) => series.annual.map((item) => item.periodKey)),
    );

    expect(annualPeriods.size).toBe(10);
    expect(annualPeriods.has("2009-01-01|2009-12-31")).toBe(false);
    expect(annualPeriods.has("2010-01-01|2010-12-31")).toBe(false);
    expect(artifact.omissionNotes).toContainEqual(expect.objectContaining({ code: "history-cap" }));
  });

  test("caps per-share dividend periods apart from the statements' interim window", () => {
    const quarter = (value: number, year: number, endMonth: number, startMonth = endMonth - 2) =>
      fact({
        value,
        form: "10-Q",
        fiscalYear: year,
        fiscalPeriod: `Q${String(endMonth / 3)}`,
        filedAt: `${String(year)}-${String(endMonth + 1).padStart(2, "0")}-20`,
        periodStart: `${String(year)}-${String(startMonth).padStart(2, "0")}-01`,
        periodEnd: `${String(year)}-${String(endMonth).padStart(2, "0")}-${endMonth === 6 || endMonth === 9 ? "30" : "31"}`,
      });
    const quarters = [2022, 2023, 2024, 2025].flatMap((year) =>
      [3, 6, 9].map((month) => quarter(100, year, month)),
    );
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(400, 2024), ...quarters] },
          CommonStockDividendsPerShareDeclared: {
            "USD/shares": [
              ...quarters.map((item) => ({ ...item, val: 0.25 })),
              quarter(0.5, 2025, 6, 1),
              quarter(0.75, 2025, 9, 1),
            ],
          },
        },
      }),
      { analysisAsOf: "2025-12-01T00:00:00.000Z" },
    );
    const { revenue } = artifact.statements.incomeStatement;
    const { dividendsPerShare } = artifact.statements.perShare;

    expect(revenue.interim).toHaveLength(12);
    expect(dividendsPerShare.interim).toHaveLength(12);
    expect(dividendsPerShare.interim.map((item) => item.value)).toEqual(
      expect.arrayContaining([0.5, 0.75]),
    );
    expect(artifact.omissionNotes.filter((note) => note.code === "history-cap")).toEqual([
      expect.objectContaining({ seriesKey: "dividendsPerShare" }),
      expect.objectContaining({ seriesKey: "dividendsPerShare" }),
    ]);
  });

  test("keeps ratio-input periods inside the statements' window without displacing one", () => {
    const quarter = (value: number, year: number, endMonth: number, startMonth = endMonth - 2) =>
      fact({
        value,
        form: "10-Q",
        fiscalYear: year,
        fiscalPeriod: `Q${String(endMonth / 3)}`,
        filedAt: `${String(year)}-${String(endMonth + 1).padStart(2, "0")}-20`,
        periodStart: `${String(year)}-${String(startMonth).padStart(2, "0")}-01`,
        periodEnd: `${String(year)}-${String(endMonth).padStart(2, "0")}-${endMonth === 6 || endMonth === 9 ? "30" : "31"}`,
      });
    const quarters = [2022, 2023, 2024, 2025].flatMap((year) =>
      [3, 6, 9].map((month) => quarter(100, year, month)),
    );
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(400, 2024), ...quarters] },
          InterestExpense: {
            USD: [
              annual(9, 2020),
              annual(10, 2024),
              ...quarters.map((item) => ({ ...item, val: 5 })),
              quarter(10, 2025, 6, 1),
              quarter(15, 2025, 9, 1),
            ],
          },
        },
      }),
      { analysisAsOf: "2025-12-01T00:00:00.000Z" },
    );
    const { revenue, interestExpense } = artifact.statements.incomeStatement;

    expect(revenue.interim).toHaveLength(12);
    expect(interestExpense.interim.map((item) => item.periodKey)).toEqual(
      revenue.interim.map((item) => item.periodKey),
    );
    expect(interestExpense.annual.map((item) => item.periodEnd)).toEqual(["2024-12-31"]);
    expect(
      artifact.omissionNotes
        .filter((note) => note.seriesKey === "interestExpense")
        .map(({ code, periodKey }) => [code, periodKey]),
    ).toEqual([
      ["history-cap", "annual|duration:12|2020-12-31"],
      ["history-cap", "interim|duration:6|2025-06-30"],
      ["history-cap", "interim|duration:9|2025-09-30"],
    ]);
  });

  test("keeps dividends-per-share annual periods the statements do not carry", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(400, 2025)] },
          CommonStockDividendsPerShareDeclared: {
            "USD/shares": [annual(0.4, 2020), annual(0.6, 2025)],
          },
        },
      }),
    );

    expect(
      artifact.statements.perShare.dividendsPerShare.annual.map((item) => item.periodEnd),
    ).toEqual(["2020-12-31", "2025-12-31"]);
  });

  test("does not treat different duration keys with the same end date as complete", () => {
    const shortPeriod = (value: number) =>
      fact({
        value,
        form: "10-K",
        fiscalYear: 2025,
        fiscalPeriod: "FY",
        filedAt: "2026-02-15",
        periodStart: "2025-04-01",
        periodEnd: "2025-12-31",
      });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          OperatingIncomeLoss: { USD: [shortPeriod(20)] },
          NetIncomeLoss: { USD: [shortPeriod(10)] },
        },
      }),
    );

    expect(artifact.validationNotes).toContainEqual(
      expect.objectContaining({
        code: "incomplete-statement",
        periodKey: "annual|duration:12|2025-12-31",
        message: expect.stringContaining("operatingIncome, netIncome"),
      }),
    );
  });

  test("records an explicit gap for untagged 6-K filing evidence", () => {
    const artifact = derive(
      payload({ "us-gaap": { Revenues: { USD: [annual(100, 2025, "20-F")] } } }),
      {
        submissionsSourceId: "extended-sec-edgar-test-filings",
        submissionsPayload: {
          filings: { recent: { form: ["6-K", "20-F"], filingDate: ["2026-05-01", "2026-03-01"] } },
        },
      },
    );

    expect(artifact.interimCadence).toBe("annual-only");
    expect(artifact.structuredFinancialGaps).toContainEqual({
      code: "untagged-6-k",
      message:
        "SEC submissions include 6-K filing evidence without supported structured companyfacts; table extraction is deferred",
      forms: ["6-K"],
      sourceIds: ["extended-sec-edgar-test-filings"],
    });
  });

  test("ignores untagged 6-K filings covered by the current annual period", () => {
    const companyFacts = payload({ "us-gaap": { Revenues: { USD: [annual(100, 2025)] } } });
    const filings = (filingDates: readonly string[]) =>
      derive(companyFacts, {
        submissionsPayload: {
          filings: {
            recent: { form: filingDates.map(() => "6-K"), filingDate: filingDates },
          },
        },
      }).structuredFinancialGaps;

    expect(filings(["2025-06-30"])).toEqual([]);
    expect(filings(["2025-06-30", "2026-03-31"])).toContainEqual(
      expect.objectContaining({ code: "untagged-6-k" }),
    );
  });

  test("uses 6-K report dates and the annual filing date to decide coverage", () => {
    const companyFacts = payload({
      "us-gaap": {
        Revenues: {
          USD: [
            fact({
              value: 100,
              form: "10-K",
              fiscalYear: 2026,
              fiscalPeriod: "FY",
              filedAt: "2026-08-27",
              periodStart: "2025-07-01",
              periodEnd: "2026-06-30",
            }),
          ],
        },
      },
    });
    const gaps = (filingDate: string, reportDate?: string) =>
      derive(companyFacts, {
        analysisAsOf: "2026-09-29T00:00:00.000Z",
        submissionsPayload: {
          filings: {
            recent: { form: ["6-K"], filingDate: [filingDate], reportDate: [reportDate] },
          },
        },
      }).structuredFinancialGaps;

    expect(gaps("2026-08-01", "2026-06-30")).toEqual([]);
    expect(gaps("2026-08-01", "2026-07-31")).toContainEqual(
      expect.objectContaining({ code: "untagged-6-k" }),
    );
    expect(gaps("2026-08-01")).toContainEqual(expect.objectContaining({ code: "untagged-6-k" }));
    expect(gaps("2026-09-01", "2026-06-30")).toContainEqual(
      expect.objectContaining({ code: "untagged-6-k" }),
    );
  });

  test("keeps untagged 6-K and 6-K/A gaps when annual revenue is missing", () => {
    const artifact = derive(payload({ "us-gaap": { Revenues: { USD: [] } } }), {
      submissionsPayload: {
        filings: {
          recent: {
            form: ["6-K", "6-K/A"],
            filingDate: ["2026-05-01", "2026-05-02"],
            reportDate: ["2025-12-31", "2025-12-31"],
          },
        },
      },
    });

    expect(artifact.structuredFinancialGaps).toContainEqual(
      expect.objectContaining({ code: "untagged-6-k", forms: ["6-K", "6-K/A"] }),
    );
  });

  test("does not let one tagged 6-K hide another untagged filing", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: {
            USD: [
              annual(100, 2025, "20-F"),
              fact({
                value: 30,
                form: "6-K",
                fiscalYear: 2026,
                fiscalPeriod: "Q1",
                filedAt: "2026-05-01",
                periodStart: "2026-01-01",
                periodEnd: "2026-03-31",
                accessionNumber: "tagged-6-k",
              }),
            ],
          },
        },
      }),
      {
        submissionsPayload: {
          filings: {
            recent: {
              form: ["6-K", "6-K"],
              filingDate: ["2026-05-01", "2026-05-15"],
              reportDate: ["2026-03-31", "2026-04-30"],
              accessionNumber: ["tagged-6-k", "untagged-6-k"],
            },
          },
        },
      },
    );

    expect(artifact.structuredFinancialGaps).toEqual([
      expect.objectContaining({ code: "untagged-6-k", forms: ["6-K"] }),
    ]);
  });

  test("recognizes tagged 6-K facts before currency isolation and history caps", () => {
    const taggedFacts = Array.from({ length: 13 }, (_, index) =>
      fact({
        value: index + 1,
        form: "6-K",
        fiscalYear: 2024 + Math.floor(index / 4),
        fiscalPeriod: `Q${String((index % 4) + 1)}`,
        filedAt: `${String(2024 + Math.floor(index / 4))}-${String((index % 4) * 3 + 2).padStart(2, "0")}-15`,
        periodStart: `${String(2024 + Math.floor(index / 4))}-01-01`,
        periodEnd: `${String(2024 + Math.floor(index / 4))}-${String((index % 4) * 3 + 3).padStart(2, "0")}-28`,
        accessionNumber: `tagged-${String(index)}`,
      }),
    );
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: {
            USD: [annual(100, 2023, "20-F"), ...taggedFacts],
            EUR: [
              fact({
                value: 50,
                form: "6-K",
                fiscalYear: 2025,
                fiscalPeriod: "H1",
                filedAt: "2025-08-20",
                periodStart: "2025-01-01",
                periodEnd: "2025-06-30",
                accessionNumber: "tagged-eur",
              }),
            ],
          },
        },
      }),
      {
        analysisAsOf: "2027-06-15T00:00:00.000Z",
        submissionsPayload: {
          filings: {
            recent: {
              form: ["6-K", "6-K"],
              filingDate: ["2024-02-15", "2025-08-20"],
              accessionNumber: ["tagged-0", "tagged-eur"],
            },
          },
        },
      },
    );

    expect(artifact.statements.incomeStatement.revenue.interim).toHaveLength(12);
    expect(artifact.structuredFinancialGaps.some((gap) => gap.code === "untagged-6-k")).toBe(false);
  });

  test("does not treat current maturities as total long-term debt", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          LongTermDebtAndFinanceLeaseObligationsCurrent: {
            USD: [
              fact({
                value: 10,
                form: "10-K",
                fiscalYear: 2025,
                fiscalPeriod: "FY",
                filedAt: "2026-02-15",
                periodEnd: "2025-12-31",
              }),
            ],
          },
        },
      }),
    );

    expect(artifact.statements.balanceSheet.debt.annual).toEqual([]);
  });

  describe("newer-filer debt aliases", () => {
    const fy2026AsOf = { analysisAsOf: "2026-08-28T00:00:00.000Z" };
    const fy2026 = (value: number, accessionNumber?: string, filedAt = "2026-07-20") =>
      amdInstant({
        value,
        form: "10-K",
        fiscalPeriod: "FY",
        filedAt,
        periodEnd: "2026-05-31",
        ...(accessionNumber !== undefined ? { accessionNumber } : {}),
      });
    const fy2022 = (value: number) =>
      amdInstant({
        value,
        form: "10-K",
        fiscalPeriod: "FY",
        filedAt: "2022-07-20",
        periodEnd: "2022-05-31",
      });
    const selectBoth = (gaap: Parameters<typeof payload>[0][string]) => {
      const companyFacts = payload({
        "us-gaap": { Revenues: { USD: [annual(100, 2025)] }, ...gaap },
      });
      const artifact = derive(companyFacts, fy2026AsOf);
      const debt = latestFinancialStatementFact([
        ...artifact.statements.balanceSheet.debt.annual,
        ...artifact.statements.balanceSheet.debt.interim,
      ]);
      const legacy = summarizeSecFundamentals(companyFacts, fy2026AsOf.analysisAsOf);
      expect(legacy?.metrics.debt).toBe(debt?.value);
      expect(legacy?.metrics.debtPeriodEnd).toBe(debt?.periodEnd);
      return { artifact, debt };
    };

    test("selects a fresher notes-payable composite over a stale LongTermDebt (APLD shape)", () => {
      const { debt } = selectBoth({
        LongTermDebt: { USD: [fy2022(50_000_000)] },
        NotesPayableCurrent: { USD: [fy2026(1_000_000_000, "apld-fy26")] },
        LongTermNotesPayable: { USD: [fy2026(3_976_000_000, "apld-fy26")] },
      });

      expect(debt).toMatchObject({
        value: 4_976_000_000,
        periodEnd: "2026-05-31",
        extractionMethod: "derived-sec-companyfacts",
        concept: "NotesPayableCurrent+LongTermNotesPayable",
      });
      expect(debt?.composite?.components).toHaveLength(2);
    });

    test("selects a fresher combined total over a stale zero LongTermDebt (ORCL shape)", () => {
      const { debt } = selectBoth({
        LongTermDebt: { USD: [fy2022(0)] },
        DebtLongtermAndShorttermCombinedAmount: { USD: [fy2026(129_541_000_000)] },
      });

      expect(debt).toMatchObject({
        value: 129_541_000_000,
        periodEnd: "2026-05-31",
        extractionMethod: "sec-companyfacts",
        concept: "DebtLongtermAndShorttermCombinedAmount",
      });
      expect(debt).not.toHaveProperty("composite");
    });

    test("prefers a later-filed combined total over LongTermDebt for the same period", () => {
      const { debt } = selectBoth({
        LongTermDebt: { USD: [fy2026(120_000_000_000)] },
        DebtLongtermAndShorttermCombinedAmount: {
          USD: [fy2026(129_541_000_000, undefined, "2026-07-21")],
        },
      });

      expect(debt).toMatchObject({
        value: 129_541_000_000,
        concept: "DebtLongtermAndShorttermCombinedAmount",
      });
    });

    test("accepts a one-sided notes-payable set once the prior total is over a year old", () => {
      const { debt } = selectBoth({
        CashAndCashEquivalentsAtCarryingValue: { USD: [fy2026(800_000_000)] },
        LongTermDebt: { USD: [fy2022(50_000_000)] },
        LongTermNotesPayable: { USD: [fy2026(3_976_000_000)] },
      });

      expect(debt).toMatchObject({
        value: 3_976_000_000,
        periodEnd: "2026-05-31",
        concept: "LongTermNotesPayable",
      });
    });

    test("does not establish a debt basis from gross principal facts alone", () => {
      const { artifact, debt } = selectBoth({
        DebtInstrumentFaceAmount: { USD: [fy2026(5_000_000_000)] },
      });

      expect(debt).toBeUndefined();
      expect(artifact.omissionNotes).toContainEqual(
        expect.objectContaining({ code: "untagged-balance-sheet-series", seriesKey: "debt" }),
      );
    });
  });
});

describe("first-public dating of selected facts", () => {
  const fy2023Revenue = (filings: readonly (readonly [number, string, string?, null?])[]) =>
    derive(
      payload({
        "us-gaap": {
          Revenues: {
            USD: filings.map(([value, filedAt, form = "10-K", accession]) => ({
              ...fact({
                value,
                form,
                fiscalYear: Number(filedAt.slice(0, 4)),
                fiscalPeriod: "FY",
                filedAt,
                periodStart: "2023-01-01",
                periodEnd: "2023-12-31",
              }),
              ...(accession === null ? { accn: undefined } : {}),
            })),
          },
        },
      }),
    ).statements.incomeStatement.revenue.annual.map(({ value, filedAt, firstPublicAt }) => ({
      value,
      filedAt,
      firstPublicAt,
    }));

  test("dates an unchanged value repeated in later filings to its first filing", () => {
    expect(
      fy2023Revenue([
        [383_285_000_000, "2024-11-03"],
        [383_285_000_000, "2025-11-01"],
        [383_285_000_000, "2026-03-31"],
      ]),
    ).toEqual([{ value: 383_285_000_000, filedAt: "2026-03-31", firstPublicAt: "2024-11-03" }]);
  });

  test("never backdates a restated value to an earlier filing of a different value", () => {
    expect(
      fy2023Revenue([
        [8_921_200_000, "2024-04-26"],
        [20_900_000, "2025-04-30"],
        [9_800_000, "2026-04-30"],
      ]),
    ).toEqual([{ value: 9_800_000, filedAt: "2026-04-30", firstPublicAt: "2026-04-30" }]);
  });

  test("dates A -> B -> A to the filing that restored A", () => {
    expect(
      fy2023Revenue([
        [100, "2024-02-15"],
        [110, "2025-02-15"],
        [100, "2026-02-15"],
      ]),
    ).toEqual([{ value: 100, filedAt: "2026-02-15", firstPublicAt: "2026-02-15" }]);
  });

  describe("across a revenue tag switch (HLIT companyfacts, CIK 851310)", () => {
    const hlitRevenue = (
      periodStart: string,
      periodEnd: string,
      tags: Readonly<Record<string, readonly (readonly [number, string, string])[]>>,
    ) =>
      derive(
        payload({
          "us-gaap": Object.fromEntries(
            Object.entries(tags).map(([concept, filings]) => [
              concept,
              {
                USD: [
                  ...filings.map(([value, filedAt, accessionNumber]) =>
                    fact({
                      value,
                      form: "10-K",
                      fiscalPeriod: "FY",
                      filedAt,
                      periodStart,
                      periodEnd,
                      accessionNumber,
                    }),
                  ),
                  // HLIT's FY2025 10-K files only the ASC 606 tag, which makes it the selected concept.
                  ...(concept === "RevenueFromContractWithCustomerExcludingAssessedTax"
                    ? [
                        fact({
                          value: 400_000_000,
                          form: "10-K",
                          fiscalPeriod: "FY",
                          filedAt: "2026-02-24",
                          periodStart: "2025-01-01",
                          periodEnd: "2025-12-31",
                        }),
                      ]
                    : []),
                ],
              },
            ]),
          ),
        }),
      )
        .statements.incomeStatement.revenue.annual.filter((row) => row.periodEnd === periodEnd)
        .map(({ concept, value, filedAt, firstPublicAt }) => ({
          concept,
          value,
          filedAt,
          firstPublicAt,
        }));

    test("dates an unchanged FY2016 value to the original SalesRevenueNet 10-K", () => {
      expect(
        hlitRevenue("2016-01-01", "2016-12-31", {
          SalesRevenueNet: [
            [405_911_000, "2017-03-03", "0000851310-17-000011"],
            [405_911_000, "2018-03-05", "0000851310-18-000017"],
          ],
          RevenueFromContractWithCustomerExcludingAssessedTax: [
            [405_911_000, "2019-03-01", "0000851310-19-000008"],
          ],
        }),
      ).toEqual([
        {
          concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
          value: 405_911_000,
          filedAt: "2019-03-01",
          firstPublicAt: "2017-03-03",
        },
      ]);
    });

    test("an alias that never filed the same figure does not date it", () => {
      expect(
        hlitRevenue("2020-01-01", "2020-12-31", {
          Revenues: [[39_789_000_000, "2021-03-02", "a-2021"]],
          RevenueFromContractWithCustomerExcludingAssessedTax: [
            [38_016_000_000, "2022-02-28", "a-2022"],
          ],
        }),
      ).toEqual([
        {
          concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
          value: 38_016_000_000,
          filedAt: "2022-02-28",
          firstPublicAt: "2022-02-28",
        },
      ]);
    });

    test("applies A -> B -> A across an alias tag's own history", () => {
      expect(
        hlitRevenue("2016-01-01", "2016-12-31", {
          SalesRevenueNet: [
            [100, "2017-03-03", "a-2017"],
            [105, "2018-03-05", "a-2018"],
          ],
          RevenueFromContractWithCustomerExcludingAssessedTax: [[100, "2019-03-01", "a-2019"]],
        }),
      ).toEqual([
        {
          concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
          value: 100,
          filedAt: "2019-03-01",
          firstPublicAt: "2019-03-01",
        },
      ]);
    });

    test("keeps a recast FY2023 value dated to the recasting 10-K", () => {
      expect(
        hlitRevenue("2023-01-01", "2023-12-31", {
          Revenues: [[607_907_000, "2024-02-16", "0000851310-24-000024"]],
          RevenueFromContractWithCustomerExcludingAssessedTax: [
            [607_907_000, "2025-02-14", "0000851310-25-000021"],
            [388_482_000, "2026-02-24", "0001193125-26-067506"],
          ],
        }),
      ).toEqual([
        {
          concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
          value: 388_482_000,
          filedAt: "2026-02-24",
          firstPublicAt: "2026-02-24",
        },
      ]);
    });
  });

  test("a same-day amendment supersedes the original filing's value", () => {
    expect(
      fy2023Revenue([
        [100, "2024-02-15"],
        [100, "2025-02-15"],
        [110, "2025-02-15", "10-K/A"],
        [100, "2026-02-15"],
      ]),
    ).toEqual([{ value: 100, filedAt: "2026-02-15", firstPublicAt: "2026-02-15" }]);
  });

  test("a same-day amendment supersedes the original when both lack accessions", () => {
    expect(
      fy2023Revenue([
        [100, "2024-02-15"],
        [100, "2025-02-15", "10-K", null],
        [110, "2025-02-15", "10-K/A", null],
        [100, "2026-02-15"],
      ]),
    ).toEqual([{ value: 100, filedAt: "2026-02-15", firstPublicAt: "2026-02-15" }]);
  });

  test("records the original filing's value when a later filing restates a fact", () => {
    const revenue = (filings: readonly (readonly [number, string, string?])[]) =>
      derive(
        payload({
          "us-gaap": {
            Revenues: {
              USD: filings.map(([value, filedAt, form = "10-K"]) =>
                fact({
                  value,
                  form,
                  fiscalYear: Number(filedAt.slice(0, 4)),
                  fiscalPeriod: "FY",
                  filedAt,
                  periodStart: "2023-01-01",
                  periodEnd: "2023-12-31",
                }),
              ),
            },
          },
        }),
      ).statements.incomeStatement.revenue.annual.map((selected) => selected.restatedFrom);

    expect(
      revenue([
        [268, "2024-02-15"],
        [268, "2025-02-15"],
        [225, "2026-02-15"],
      ]),
    ).toEqual([{ value: 268, filedAt: "2024-02-15" }]);
    expect(
      revenue([
        [268, "2024-02-15"],
        [268, "2025-02-15"],
      ]),
    ).toEqual([undefined]);
    expect(
      revenue([
        [100, "2024-02-15"],
        [80, "2024-02-15", "10-K/A"],
        [80, "2025-02-15"],
      ]),
    ).toEqual([{ value: 100, filedAt: "2024-02-15" }]);
  });

  const compositeDebt = (filings: readonly (readonly [number, number, string, string?])[]) => {
    const filing = (value: number, filedAt: string, form: string) => ({
      ...instant(value, 2024, form),
      filed: filedAt,
      accn: `${filedAt}-${form}`,
    });
    return derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2024)] },
          LongTermDebtCurrent: {
            USD: filings.map(([current, , filedAt, form = "10-K"]) =>
              filing(current, filedAt, form),
            ),
          },
          LongTermDebtNoncurrent: {
            USD: filings.map(([, noncurrent, filedAt, form = "10-K"]) =>
              filing(noncurrent, filedAt, form),
            ),
          },
        },
      }),
    ).statements.balanceSheet.debt.annual.map(({ value, filedAt, firstPublicAt }) => ({
      value,
      filedAt,
      firstPublicAt,
    }));
  };

  test("dates a composite refiled unchanged to its components' first filing", () => {
    expect(
      compositeDebt([
        [10, 90, "2025-02-15"],
        [10, 90, "2026-02-15"],
      ]),
    ).toEqual([{ value: 100, filedAt: "2026-02-15", firstPublicAt: "2025-02-15" }]);
  });

  test("refuses a composite whose later filing restates a component without a debt total", () => {
    expect(
      compositeDebt([
        [10, 90, "2025-02-15"],
        [10, 95, "2026-02-15"],
      ]),
    ).toEqual([]);
  });

  test("dates a composite restored after an amended composite to the restoration", () => {
    expect(
      compositeDebt([
        [10, 90, "2024-02-15"],
        [10, 95, "2025-02-15", "10-K/A"],
        [10, 90, "2026-02-15"],
      ]),
    ).toEqual([{ value: 100, filedAt: "2026-02-15", firstPublicAt: "2026-02-15" }]);
  });
});

function amdInstant(input: {
  readonly value: number;
  readonly form: "10-K" | "10-Q";
  readonly fiscalPeriod: string;
  readonly filedAt: string;
  readonly periodEnd: string;
  readonly accessionNumber?: string;
}): Record<string, unknown> {
  return fact({
    value: input.value,
    form: input.form,
    fiscalYear: Number.parseInt(input.periodEnd.slice(0, 4), 10),
    fiscalPeriod: input.fiscalPeriod,
    filedAt: input.filedAt,
    periodEnd: input.periodEnd,
    ...(input.accessionNumber !== undefined ? { accessionNumber: input.accessionNumber } : {}),
  });
}

describe("canonical debt basis selection", () => {
  const amdAsOf = { analysisAsOf: "2026-08-28T00:00:00.000Z" };
  const cashCurrent = amdInstant({
    value: 5_000_000_000,
    form: "10-Q",
    fiscalPeriod: "Q2",
    filedAt: "2026-08-06",
    periodEnd: "2026-06-27",
  });
  const staleDirect = amdInstant({
    value: 1_000_000,
    form: "10-K",
    fiscalPeriod: "FY",
    filedAt: "2022-02-03",
    periodEnd: "2021-12-25",
  });
  const currentDebt = amdInstant({
    value: 875_000_000,
    form: "10-Q",
    fiscalPeriod: "Q2",
    filedAt: "2026-08-06",
    periodEnd: "2026-06-27",
    accessionNumber: "0000000000-26-000001",
  });
  const noncurrentDebt = amdInstant({
    value: 2_351_000_000,
    form: "10-Q",
    fiscalPeriod: "Q2",
    filedAt: "2026-08-06",
    periodEnd: "2026-06-27",
    accessionNumber: "0000000000-26-000001",
  });

  test("selects a composite when component instants are fresher than LongTermDebt", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          CashAndCashEquivalentsAtCarryingValue: { USD: [cashCurrent] },
          LongTermDebt: { USD: [staleDirect] },
          LongTermDebtCurrent: { USD: [currentDebt] },
          LongTermDebtNoncurrent: { USD: [noncurrentDebt] },
        },
      }),
      amdAsOf,
    );
    const debt = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const cash = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.cash.annual,
      ...artifact.statements.balanceSheet.cash.interim,
    ]);

    expect(debt).toMatchObject({
      value: 3_226_000_000,
      periodEnd: "2026-06-27",
      extractionMethod: "derived-sec-companyfacts",
      concept: "LongTermDebtCurrent+LongTermDebtNoncurrent",
      sourceIds: ["extended-sec-edgar-test-fundamentals"],
    });
    expect(debt?.composite?.components.map((component) => component.concept)).toEqual([
      "LongTermDebtCurrent",
      "LongTermDebtNoncurrent",
    ]);
    expect(debt?.composite?.components.map((component) => component.sourceIds)).toEqual([
      ["extended-sec-edgar-test-fundamentals"],
      ["extended-sec-edgar-test-fundamentals"],
    ]);
    expect(debt?.periodEnd).toBe(cash?.periodEnd);
    expect(artifact.statements.balanceSheet.debt.interim).toHaveLength(1);
  });

  test("keeps a fresher direct LongTermDebt series unchanged", () => {
    const freshDirect = amdInstant({
      value: 4_000_000_000,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-06",
      periodEnd: "2026-06-27",
    });
    const staleCurrent = amdInstant({
      value: 875_000_000,
      form: "10-K",
      fiscalPeriod: "FY",
      filedAt: "2022-02-03",
      periodEnd: "2021-12-25",
    });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          LongTermDebt: { USD: [freshDirect] },
          LongTermDebtCurrent: { USD: [staleCurrent] },
          LongTermDebtNoncurrent: { USD: [staleDirect] },
        },
      }),
      amdAsOf,
    );
    const debt = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);

    expect(debt).toMatchObject({
      value: 4_000_000_000,
      periodEnd: "2026-06-27",
      extractionMethod: "sec-companyfacts",
      concept: "LongTermDebt",
    });
    expect(debt).not.toHaveProperty("composite");
  });

  test("breaks equal periodEnd ties in favor of the direct alias", () => {
    const direct = amdInstant({
      value: 3_226_000_000,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-06",
      periodEnd: "2026-06-27",
      accessionNumber: "0000000000-26-000001",
    });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          LongTermDebt: { USD: [direct] },
          LongTermDebtCurrent: { USD: [currentDebt] },
          LongTermDebtNoncurrent: { USD: [noncurrentDebt] },
        },
      }),
      amdAsOf,
    );
    const debt = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);

    expect(debt).toMatchObject({
      value: 3_226_000_000,
      extractionMethod: "sec-companyfacts",
      concept: "LongTermDebt",
    });
  });

  test("accepts a one-sided generic line once the prior total is over a year old", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          LongTermDebt: { USD: [staleDirect] },
          LongTermDebtCurrent: { USD: [currentDebt] },
        },
      }),
      amdAsOf,
    );
    const debt = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);

    expect(debt).toMatchObject({
      value: 875_000_000,
      periodEnd: "2026-06-27",
      concept: "LongTermDebtCurrent",
    });
  });

  test("keeps an earlier one-sided instant that passes continuity in the composite history", () => {
    const priorCurrent = amdInstant({
      value: 700_000_000,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2025-08-06",
      periodEnd: "2025-06-28",
    });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          LongTermDebt: { USD: [staleDirect] },
          LongTermDebtCurrent: { USD: [priorCurrent, currentDebt] },
          LongTermDebtNoncurrent: { USD: [noncurrentDebt] },
        },
      }),
      amdAsOf,
    );
    const debt = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);

    expect(debt).toMatchObject({
      value: 3_226_000_000,
      periodEnd: "2026-06-27",
      extractionMethod: "derived-sec-companyfacts",
      concept: "LongTermDebtCurrent+LongTermDebtNoncurrent",
    });
    expect(
      artifact.statements.balanceSheet.debt.interim.map((selected) => selected.periodEnd),
    ).toEqual(["2025-06-28", "2026-06-27"]);
  });

  test("selects IFRS current plus noncurrent borrowings over stale Borrowings", () => {
    const artifact = derive(
      payload({
        "ifrs-full": {
          Revenue: { USD: [annual(100, 2025, "20-F")] },
          Borrowings: {
            USD: [
              amdInstant({
                value: 1_000_000,
                form: "10-K",
                fiscalPeriod: "FY",
                filedAt: "2022-02-03",
                periodEnd: "2021-12-25",
              }),
            ],
          },
          CurrentBorrowings: {
            USD: [
              amdInstant({
                value: 100,
                form: "10-Q",
                fiscalPeriod: "Q2",
                filedAt: "2026-08-06",
                periodEnd: "2026-06-27",
              }),
            ],
          },
          NoncurrentBorrowings: {
            USD: [
              amdInstant({
                value: 200,
                form: "10-Q",
                fiscalPeriod: "Q2",
                filedAt: "2026-08-06",
                periodEnd: "2026-06-27",
              }),
            ],
          },
        },
      }),
      amdAsOf,
    );
    const debt = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);

    expect(debt).toMatchObject({
      value: 300,
      periodEnd: "2026-06-27",
      extractionMethod: "derived-sec-companyfacts",
      concept: "CurrentBorrowings+NoncurrentBorrowings",
    });
  });

  test("accepts a one-sided generic line with no other-side history (Regeneron shape)", () => {
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebtNoncurrent: { USD: [noncurrentDebt] },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const legacy = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(
      latestFinancialStatementFact(financialStatementFacts(artifact.statements.balanceSheet.debt)),
    ).toMatchObject({ value: 2_351_000_000, periodEnd: "2026-06-27" });
    expect(legacy?.metrics.debt).toBe(2_351_000_000);
    expect(legacy?.metrics.debtIncompleteReason).toBeUndefined();
  });

  test("refuses a one-sided generic line when the other side was nonzero within the prior year", () => {
    const priorCurrent = amdInstant({
      value: 700_000_000,
      form: "10-Q",
      fiscalPeriod: "Q1",
      filedAt: "2026-05-06",
      periodEnd: "2026-03-28",
    });
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebtCurrent: { USD: [priorCurrent] },
        LongTermDebtNoncurrent: { USD: [noncurrentDebt] },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const legacy = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(
      latestFinancialStatementFact(financialStatementFacts(artifact.statements.balanceSheet.debt))
        ?.periodEnd,
    ).not.toBe("2026-06-27");
    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({
        code: "incomplete-composite-series",
        message: expect.stringContaining("omits LongTermDebtCurrent"),
      }),
    );
    expect(legacy?.metrics).toMatchObject({
      debtIncompletePeriodEnd: "2026-06-27",
      debtIncompleteReason: expect.stringContaining("omits LongTermDebtCurrent"),
    });
  });

  test("records untagged-balance-sheet-series only for an empty debt series", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          CashAndCashEquivalentsAtCarryingValue: { USD: [cashCurrent] },
        },
      }),
      amdAsOf,
    );

    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({ code: "untagged-balance-sheet-series", seriesKey: "debt" }),
    );
    expect(
      artifact.omissionNotes.some((note) => note.code === "untagged-balance-sheet-series"),
    ).toBe(true);
    expect(artifact.omissionNotes.filter((note) => note.seriesKey === "currentAssets")).toEqual([]);
  });

  test("records untagged debt when debt aliases are absent even if no other balance-sheet series is tagged", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
        },
      }),
    );

    expect(
      artifact.omissionNotes.some((note) => note.code === "untagged-balance-sheet-series"),
    ).toBe(true);
  });

  test("does not record untagged debt when a LongTermDebt tag exists but is past the analysis cutoff", () => {
    const futureDirect = amdInstant({
      value: 9_000_000_000,
      form: "10-Q",
      fiscalPeriod: "Q4",
      filedAt: "2027-02-03",
      periodEnd: "2026-12-26",
    });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          CashAndCashEquivalentsAtCarryingValue: { USD: [cashCurrent] },
          LongTermDebt: { USD: [futureDirect] },
        },
      }),
      amdAsOf,
    );

    expect(
      artifact.omissionNotes.some((note) => note.code === "untagged-balance-sheet-series"),
    ).toBe(false);
    expect([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]).toEqual([]);
  });

  test("does not record untagged debt when a LongTermDebt tag exists in a non-reporting currency", () => {
    const eurDebt = amdInstant({
      value: 1_000_000,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-06",
      periodEnd: "2026-06-27",
    });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          CashAndCashEquivalentsAtCarryingValue: { USD: [cashCurrent] },
          LongTermDebt: { EUR: [eurDebt] },
        },
      }),
      amdAsOf,
    );

    expect(
      artifact.omissionNotes.some((note) => note.code === "untagged-balance-sheet-series"),
    ).toBe(false);
    expect([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]).toEqual([]);
  });

  test("sums 10-K FY and Q4 current/noncurrent components that share period end, form, and fiscal year", () => {
    const fyCurrent = amdInstant({
      value: 40,
      form: "10-K",
      fiscalPeriod: "FY",
      filedAt: "2026-02-15",
      periodEnd: "2025-12-31",
    });
    const q4Noncurrent = amdInstant({
      value: 60,
      form: "10-K",
      fiscalPeriod: "Q4",
      filedAt: "2026-02-15",
      periodEnd: "2025-12-31",
    });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          LongTermDebtCurrent: { USD: [fyCurrent] },
          LongTermDebtNoncurrent: { USD: [q4Noncurrent] },
        },
      }),
      amdAsOf,
    );
    const debt = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);

    expect(debt).toMatchObject({
      value: 100,
      periodEnd: "2025-12-31",
      extractionMethod: "derived-sec-companyfacts",
      concept: "LongTermDebtCurrent+LongTermDebtNoncurrent",
    });
    expect(debt?.composite?.components).toHaveLength(2);
  });

  test("records stale-instant-series when tagged debt lags cash by more than one period", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          CashAndCashEquivalentsAtCarryingValue: { USD: [cashCurrent] },
          LongTermDebt: { USD: [staleDirect] },
        },
      }),
      amdAsOf,
    );

    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({
        code: "stale-instant-series",
        seriesKey: "debt",
      }),
    );
    expect(
      artifact.omissionNotes.some((note) => note.code === "untagged-balance-sheet-series"),
    ).toBe(false);
  });

  test("agrees with summarizeSecFundamentals on composite debt value and period end", async () => {
    const q2Revenue = fact({
      value: 7_685_000_000,
      form: "10-Q",
      fiscalYear: 2026,
      fiscalPeriod: "Q2",
      filedAt: "2026-08-06",
      periodStart: "2026-03-29",
      periodEnd: "2026-06-27",
    });
    const companyFacts = payload({
      "us-gaap": {
        Revenues: {
          USD: [
            annual(30_000_000_000, 2025),
            fact({
              value: 14_000_000_000,
              form: "10-Q",
              fiscalYear: 2025,
              fiscalPeriod: "Q2",
              filedAt: "2025-08-06",
              periodStart: "2025-01-01",
              periodEnd: "2025-06-28",
            }),
            fact({
              value: 15_000_000_000,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-06",
              periodStart: "2026-01-01",
              periodEnd: "2026-06-27",
            }),
            q2Revenue,
          ],
        },
        CashAndCashEquivalentsAtCarryingValue: { USD: [cashCurrent] },
        LongTermDebt: { USD: [staleDirect] },
        LongTermDebtCurrent: { USD: [currentDebt] },
        LongTermDebtNoncurrent: { USD: [noncurrentDebt] },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const summary = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);
    const canonical = withCanonicalFinancialLensInputs(undefined, artifact);
    const metrics = canonical.items.find((item) => item.category === "sec-edgar")?.metrics;
    const command = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "TEST",
      depth: "brief",
    } as const;
    const snapshots = [
      marketSnapshot({
        symbol: "TEST",
        marketCap: 200_000_000_000,
        observedAt: amdAsOf.analysisAsOf,
      }),
    ];
    const valuation = addValuationEvidence(command, snapshots, canonical, amdAsOf.analysisAsOf);
    const comps = await collectValuationComps(
      {
        command,
        fetchedAt: amdAsOf.analysisAsOf,
        newsLimit: 10,
        cryptoMoverLimit: 10,
        request: {
          fetch: () => Promise.reject(new Error("unexpected base fetch")),
          json: async () => {
            throw new Error("AMD-shaped valuation comps must not fetch");
          },
          text: async () => {
            throw new Error("AMD-shaped valuation comps must not fetch");
          },
        },
      },
      command,
      snapshots,
      valuation.extendedEvidence ?? canonical,
      { peerUniverseMappings: {} },
    );

    expect(summary?.metrics.debt).toBe(3_226_000_000);
    expect(summary?.metrics.debtPeriodEnd).toBe("2026-06-27");
    expect(metrics?.debt).toBe(summary?.metrics.debt);
    expect(metrics?.debtPeriodEnd).toBe(summary?.metrics.debtPeriodEnd);
    expect(comps.gaps.some((gap) => gap.message.includes("Mixed-period valuation inputs"))).toBe(
      false,
    );
    expect(comps.artifact.target.netDebt).not.toBe(MIXED_PERIOD_METRIC);
    expect(comps.artifact.target.usable).toBe(true);
    expect(comps.artifact.summary.valuationSupportability).not.toBe("not-supportable");
  });

  test("accepts DebtCurrent alone with no noncurrent history", () => {
    const onlyCurrent = amdInstant({
      value: 7_050_000_000,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-05",
      periodEnd: "2026-06-30",
    });
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        DebtCurrent: { USD: [onlyCurrent] },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const debt = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const summary = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(debt).toMatchObject({ value: 7_050_000_000, periodEnd: "2026-06-30" });
    expect(summary?.metrics.debt).toBe(7_050_000_000);
  });

  test("accepts LongTermDebtAndCapitalLeaseObligations alone with no current history", () => {
    const onlyLease = amdInstant({
      value: 62_481_000_000,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-05",
      periodEnd: "2026-06-30",
    });
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebtAndCapitalLeaseObligations: { USD: [onlyLease] },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const debt = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const summary = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(debt).toMatchObject({ value: 62_481_000_000, periodEnd: "2026-06-30" });
    expect(summary?.metrics.debt).toBe(62_481_000_000);
  });

  test("prefers a fresh DebtCurrent over a stale LongTermDebtCurrent in the LLY 2013-vs-2026 shape", () => {
    const staleCurrent = amdInstant({
      value: 1_012_600_000,
      form: "10-K",
      fiscalPeriod: "FY",
      filedAt: "2014-02-19",
      periodEnd: "2013-12-31",
    });
    const freshCurrent = amdInstant({
      value: 7_050_000_000,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-05",
      periodEnd: "2026-06-30",
    });
    const freshNoncurrent = amdInstant({
      value: 47_858_000_000,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-05",
      periodEnd: "2026-06-30",
    });
    const olderDirect = amdInstant({
      value: 29_474_000_000,
      form: "10-K",
      fiscalPeriod: "FY",
      filedAt: "2025-02-19",
      periodEnd: "2024-12-31",
    });
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebt: { USD: [olderDirect] },
        LongTermDebtCurrent: { USD: [staleCurrent] },
        DebtCurrent: { USD: [freshCurrent] },
        LongTermDebtNoncurrent: { USD: [freshNoncurrent] },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const debt = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const summary = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(debt).toMatchObject({
      value: 54_908_000_000,
      periodEnd: "2026-06-30",
      extractionMethod: "derived-sec-companyfacts",
      concept: "DebtCurrent+LongTermDebtNoncurrent",
    });
    expect(summary?.metrics.debt).toBe(54_908_000_000);
    expect(summary?.metrics.debtPeriodEnd).toBe("2026-06-30");
  });

  test("prefers same-period DebtCurrent over narrower LongTermDebtCurrent maturities", () => {
    const narrowCurrent = amdInstant({
      value: 100,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-05",
      periodEnd: "2026-06-30",
    });
    const broaderCurrent = amdInstant({
      value: 200,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-05",
      periodEnd: "2026-06-30",
    });
    const noncurrent = amdInstant({
      value: 300,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-05",
      periodEnd: "2026-06-30",
    });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          LongTermDebtCurrent: { USD: [narrowCurrent] },
          DebtCurrent: { USD: [broaderCurrent] },
          LongTermDebtNoncurrent: { USD: [noncurrent] },
        },
      }),
      amdAsOf,
    );
    const debt = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);

    expect(debt).toMatchObject({
      value: 500,
      periodEnd: "2026-06-30",
      concept: "DebtCurrent+LongTermDebtNoncurrent",
    });
  });

  test("sums the ABBV lease pair at 2026-06-30 instead of a zero ShortTermBorrowings tag", () => {
    const zeroBorrowings = amdInstant({
      value: 0,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-05",
      periodEnd: "2026-06-30",
    });
    const leaseCurrent = amdInstant({
      value: 8_341_000_000,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-05",
      periodEnd: "2026-06-30",
    });
    const leaseNoncurrent = amdInstant({
      value: 62_481_000_000,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-05",
      periodEnd: "2026-06-30",
    });
    const olderDirect = amdInstant({
      value: 64_503_000_000,
      form: "10-K",
      fiscalPeriod: "FY",
      filedAt: "2026-02-20",
      periodEnd: "2025-12-31",
    });
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebt: { USD: [olderDirect] },
        ShortTermBorrowings: { USD: [zeroBorrowings] },
        LongTermDebtAndCapitalLeaseObligationsCurrent: { USD: [leaseCurrent] },
        LongTermDebtAndCapitalLeaseObligations: { USD: [leaseNoncurrent] },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const debt = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const summary = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(debt).toMatchObject({
      value: 70_822_000_000,
      periodEnd: "2026-06-30",
      extractionMethod: "derived-sec-companyfacts",
      concept:
        "LongTermDebtAndCapitalLeaseObligationsCurrent+LongTermDebtAndCapitalLeaseObligations",
    });
    expect(summary?.metrics.debt).toBe(70_822_000_000);
    expect(summary?.metrics.debtPeriodEnd).toBe("2026-06-30");
  });

  test("does not let a newer one-legged zero ShortTermBorrowings beat an older complete LongTermDebt", () => {
    const zeroBorrowings = amdInstant({
      value: 0,
      form: "10-Q",
      fiscalPeriod: "Q2",
      filedAt: "2026-08-05",
      periodEnd: "2026-06-30",
    });
    const olderDirect = amdInstant({
      value: 64_503_000_000,
      form: "10-K",
      fiscalPeriod: "FY",
      filedAt: "2026-02-20",
      periodEnd: "2025-12-31",
    });
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebt: { USD: [olderDirect] },
        ShortTermBorrowings: { USD: [zeroBorrowings] },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const debt = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const summary = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(debt).toMatchObject({
      value: 64_503_000_000,
      periodEnd: "2025-12-31",
      extractionMethod: "sec-companyfacts",
      concept: "LongTermDebt",
    });
    expect(summary?.metrics.debt).toBeUndefined();
    expect(summary?.metrics.debtIncompletePeriodEnd).toBe("2026-06-30");
  });

  test("still refuses a debt series when nothing is tagged and accepts a lone generic line", () => {
    const untagged = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
        },
      }),
      amdAsOf,
    );
    const oneLegged = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          LongTermDebtNoncurrent: { USD: [noncurrentDebt] },
        },
      }),
      amdAsOf,
    );
    const untaggedDebt = latestFinancialStatementFact([
      ...untagged.statements.balanceSheet.debt.annual,
      ...untagged.statements.balanceSheet.debt.interim,
    ]);
    const untaggedSummary = summarizeSecFundamentals(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
        },
      }),
      amdAsOf.analysisAsOf,
    );

    expect(untaggedDebt).toBeUndefined();
    expect(untagged.omissionNotes).toContainEqual(
      expect.objectContaining({ code: "untagged-balance-sheet-series", seriesKey: "debt" }),
    );
    expect(untagged.omissionNotes).not.toContainEqual(
      expect.objectContaining({ code: "incomplete-composite-series", seriesKey: "debt" }),
    );
    expect(untaggedSummary?.metrics.debt).toBeUndefined();
    expect(oneLegged.omissionNotes).not.toContainEqual(
      expect.objectContaining({ code: "incomplete-composite-series", seriesKey: "debt" }),
    );
  });

  test("a newer filing's complete debt resolution drops older withhold notes for that instant", () => {
    const debtFact = (value: number, periodEnd: string, form: string, filedAt: string) =>
      fact({ value, form, fiscalPeriod: form === "10-K" ? "FY" : "Q1", filedAt, periodEnd });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
          LongTermDebtCurrent: {
            USD: [
              debtFact(10, "2025-05-31", "10-K", "2025-06-20"),
              debtFact(10, "2025-05-31", "10-Q", "2025-09-10"),
              debtFact(10, "2025-05-31", "10-K", "2026-06-20"),
              debtFact(12, "2026-05-31", "10-K", "2026-06-20"),
            ],
          },
          LongTermDebtNoncurrent: {
            USD: [
              debtFact(90, "2025-05-31", "10-K", "2025-06-20"),
              debtFact(90, "2025-05-31", "10-K", "2026-06-20"),
              debtFact(95, "2026-05-31", "10-K", "2026-06-20"),
            ],
          },
        },
      }),
      { generatedAt: "2026-07-01T00:00:00.000Z", analysisAsOf: "2026-07-01T00:00:00.000Z" },
    );
    const debt = [
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ];

    expect(debt.find((row) => row.periodEnd === "2025-05-31")?.value).toBe(100);
    expect(artifact.omissionNotes).not.toContainEqual(
      expect.objectContaining({ seriesKey: "debt", periodKey: "instant|2025-05-31" }),
    );
  });

  test("canonical and legacy writers agree on a same-period direct-vs-complete-composite tie", () => {
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebt: {
          USD: [
            fact({
              value: 100,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-06",
              periodEnd: "2026-06-30",
            }),
          ],
        },
        LongTermDebtCurrent: {
          USD: [
            fact({
              value: 20,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-06",
              periodEnd: "2026-06-30",
            }),
          ],
        },
        LongTermDebtNoncurrent: {
          USD: [
            fact({
              value: 80,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-06",
              periodEnd: "2026-06-30",
            }),
          ],
        },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const canonical = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const legacy = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(canonical).toMatchObject({
      value: 100,
      periodEnd: "2026-06-30",
      extractionMethod: "sec-companyfacts",
      concept: "LongTermDebt",
    });
    expect(legacy?.metrics.debt).toBe(canonical?.value);
    expect(legacy?.metrics.debtPeriodEnd).toBe(canonical?.periodEnd);
  });

  test("canonical and legacy writers agree when component fiscal years disagree at one period end", () => {
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebtCurrent: {
          USD: [
            fact({
              value: 20,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-06",
              periodEnd: "2026-06-30",
            }),
          ],
        },
        LongTermDebtNoncurrent: {
          USD: [
            fact({
              value: 70,
              form: "10-Q",
              fiscalYear: 2025,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-06",
              periodEnd: "2026-06-30",
            }),
          ],
        },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const canonical = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const legacy = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(canonical).toMatchObject({
      value: 90,
      periodEnd: "2026-06-30",
      extractionMethod: "derived-sec-companyfacts",
      concept: "LongTermDebtCurrent+LongTermDebtNoncurrent",
    });
    expect(legacy?.metrics.debt).toBe(canonical?.value);
    expect(legacy?.metrics.debtPeriodEnd).toBe(canonical?.periodEnd);
  });

  test("canonical and legacy writers agree when a later amendment restates a direct series", () => {
    const companyFacts = payload({
      "us-gaap": {
        LongTermDebt: {
          USD: [
            fact({
              value: 100,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-07-23",
              periodEnd: "2026-06-30",
            }),
            fact({
              value: 110,
              form: "10-Q/A",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-06",
              periodEnd: "2026-06-30",
            }),
          ],
        },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const canonical = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const legacy = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(canonical).toMatchObject({
      value: 110,
      periodEnd: "2026-06-30",
      form: "10-Q/A",
      amendment: true,
      extractionMethod: "sec-companyfacts",
      concept: "LongTermDebt",
    });
    expect(legacy?.metrics.debt).toBe(canonical?.value);
    expect(legacy?.metrics.debtPeriodEnd).toBe(canonical?.periodEnd);
  });

  test("canonical and legacy writers agree when only amended components exist", () => {
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebtCurrent: {
          USD: [
            fact({
              value: 20,
              form: "10-Q/A",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-06",
              periodEnd: "2026-06-30",
            }),
          ],
        },
        LongTermDebtNoncurrent: {
          USD: [
            fact({
              value: 70,
              form: "10-Q/A",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-06",
              periodEnd: "2026-06-30",
            }),
          ],
        },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const canonical = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const legacy = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(canonical).toMatchObject({
      value: 90,
      periodEnd: "2026-06-30",
      form: "10-Q/A",
      amendment: true,
      extractionMethod: "derived-sec-companyfacts",
      concept: "LongTermDebtCurrent+LongTermDebtNoncurrent",
    });
    expect(legacy?.metrics.debt).toBe(canonical?.value);
    expect(legacy?.metrics.debtPeriodEnd).toBe(canonical?.periodEnd);
  });

  test("canonical and legacy writers both refuse debt on mixed original and amended components", () => {
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebtCurrent: {
          USD: [
            fact({
              value: 20,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-07-23",
              periodEnd: "2026-06-30",
            }),
          ],
        },
        LongTermDebtNoncurrent: {
          USD: [
            fact({
              value: 70,
              form: "10-Q/A",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-06",
              periodEnd: "2026-06-30",
            }),
          ],
        },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const canonical = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const legacy = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(canonical).toBeUndefined();
    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({ code: "incomplete-composite-series", seriesKey: "debt" }),
    );
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.metrics).toMatchObject({
      debtIncompletePeriodEnd: "2026-06-30",
      debtIncompleteReason: expect.stringContaining("omits LongTermDebtCurrent"),
    });
  });

  test("canonical and legacy writers both refuse debt when a later amendment restates only one debt component", () => {
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebtCurrent: {
          USD: [
            fact({
              value: 20,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-07-23",
              periodEnd: "2026-06-30",
            }),
            fact({
              value: 30,
              form: "10-Q/A",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-06",
              periodEnd: "2026-06-30",
            }),
          ],
        },
        LongTermDebtNoncurrent: {
          USD: [
            fact({
              value: 70,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-07-23",
              periodEnd: "2026-06-30",
            }),
          ],
        },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const canonical = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const legacy = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(canonical).toBeUndefined();
    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({ code: "incomplete-composite-series", seriesKey: "debt" }),
    );
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.metrics).toMatchObject({
      debtIncompletePeriodEnd: "2026-06-30",
      debtIncompleteReason: expect.stringContaining("omits LongTermDebtNoncurrent"),
    });
  });

  test("canonical and legacy writers both withhold when same-day composites disagree on a line", () => {
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebtCurrent: {
          USD: [
            fact({
              value: 20,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-01",
              periodEnd: "2026-06-30",
              accessionNumber: "001",
            }),
            fact({
              value: 30,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q3",
              filedAt: "2026-08-01",
              periodEnd: "2026-06-30",
              accessionNumber: "050",
            }),
          ],
        },
        LongTermDebtNoncurrent: {
          USD: [
            fact({
              value: 70,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-01",
              periodEnd: "2026-06-30",
              accessionNumber: "099",
            }),
            fact({
              value: 70,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q3",
              filedAt: "2026-08-01",
              periodEnd: "2026-06-30",
              accessionNumber: "050",
            }),
          ],
        },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const canonical = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const legacy = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(canonical).toBeUndefined();
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({
        code: "incomplete-composite-series",
        seriesKey: "debt",
        message: expect.stringContaining(
          "filings 001, 050, 099, all filed 2026-08-01, present it differently",
        ),
      }),
    );
  });

  test("history keeps the prior quarter and legacy withholds it when a current-debt alias omits fiscal period", () => {
    const malformedCurrent = fact({
      value: 40,
      form: "10-Q",
      fiscalYear: 2026,
      fiscalPeriod: "Q2",
      filedAt: "2026-08-01",
      periodEnd: "2026-06-30",
    });
    const { fp: _omitted, ...debtCurrentWithoutFp } = malformedCurrent;
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebtCurrent: {
          USD: [
            fact({
              value: 20,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q1",
              filedAt: "2026-05-08",
              periodEnd: "2026-03-31",
            }),
          ],
        },
        DebtCurrent: { USD: [debtCurrentWithoutFp] },
        LongTermDebtNoncurrent: {
          USD: [
            fact({
              value: 70,
              form: "10-Q",
              fiscalYear: 2026,
              fiscalPeriod: "Q2",
              filedAt: "2026-08-01",
              periodEnd: "2026-06-30",
            }),
          ],
        },
      },
    });
    const artifact = derive(companyFacts, amdAsOf);
    const canonical = latestFinancialStatementFact([
      ...artifact.statements.balanceSheet.debt.annual,
      ...artifact.statements.balanceSheet.debt.interim,
    ]);
    const legacy = summarizeSecFundamentals(companyFacts, amdAsOf.analysisAsOf);

    expect(canonical).toMatchObject({ value: 20, periodEnd: "2026-03-31" });
    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({ code: "incomplete-composite-series", seriesKey: "debt" }),
    );
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.metrics).toMatchObject({
      debtIncompletePeriodEnd: "2026-06-30",
      debtIncompleteReason: expect.stringContaining("omits LongTermDebtCurrent"),
    });
  });
});

function grossWithholds(net: number, gross: number): boolean {
  return grossPrincipalWithholdsDebt(
    { periodEnd: "2026-03-31", value: net },
    "2026-06-30",
    gross,
    [],
  );
}
describe("gross-principal debt withholding", () => {
  const asOf = { analysisAsOf: "2026-10-04T00:00:00.000Z" };
  const q = (value: number, periodEnd: string, fiscalPeriod: string, filedAt: string) =>
    amdInstant({
      value,
      form: fiscalPeriod === "FY" ? "10-K" : "10-Q",
      fiscalPeriod,
      filedAt,
      periodEnd,
    });
  const crwvNet = [
    q(11_051_501_000, "2025-06-30", "Q2", "2025-08-13"),
    q(21_373_000_000, "2025-12-31", "FY", "2026-03-02"),
    q(24_859_000_000, "2026-03-31", "Q1", "2026-05-08"),
  ];
  const crwvGross = [
    q(11_171_485_000, "2025-06-30", "Q2", "2025-08-13"),
    q(21_615_000_000, "2025-12-31", "FY", "2026-03-02"),
    q(25_149_000_000, "2026-03-31", "Q1", "2026-05-08"),
    q(35_551_000_000, "2026-06-30", "Q2", "2026-08-12"),
  ];
  const facts = (concepts: Readonly<Record<string, readonly Record<string, unknown>[]>>) =>
    payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        ...Object.fromEntries(
          Object.entries(concepts).map(([concept, usd]) => [concept, { USD: usd }]),
        ),
      },
    });
  const selections = (companyFacts: unknown) => {
    const artifact = derive(companyFacts, asOf);
    return {
      artifact,
      canonical: latestFinancialStatementFact([
        ...artifact.statements.balanceSheet.debt.annual,
        ...artifact.statements.balanceSheet.debt.interim,
      ]),
      legacy: summarizeSecFundamentals(companyFacts, asOf.analysisAsOf),
    };
  };

  // Hut 8 10-Q 0001104659-26-090025, 2026-06-30: principal 7,735.1M; balance-sheet carrying 234.7M + 7,403.7M = 7,638.4M.
  test("HUT 2026-06-30 principal-only instant withholds debt instead of publishing 7.735B", () => {
    const { artifact, canonical, legacy } = selections(
      facts({
        LongTermDebt: [q(300_585_000, "2024-12-31", "FY", "2025-03-03")],
        LongTermDebtCurrent: [q(64_965_000, "2024-12-31", "FY", "2025-03-03")],
        LongTermDebtNoncurrent: [q(235_620_000, "2024-12-31", "FY", "2025-03-03")],
        DebtInstrumentCarryingAmount: [
          q(302_311_000, "2024-12-31", "FY", "2025-03-03"),
          q(408_874_000, "2025-12-31", "FY", "2026-02-25"),
          q(7_735_104_000, "2026-06-30", "Q2", "2026-08-04"),
        ],
      }),
    );
    const reason =
      "only gross principal (DebtInstrumentCarryingAmount) is tagged after 2024-12-31, not the carrying amount";

    expect(canonical?.value).not.toBe(7_735_104_000);
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.metrics).toMatchObject({
      debtIncompletePeriodEnd: "2026-06-30",
      debtIncompleteReason: reason,
    });
    expect(financialStatementsDebtBasisGaps(artifact).map((gap) => gap.message)).toEqual([
      `SEC debt withheld: the newest debt instant 2026-06-30 is incomplete (${reason}), and no older amount stands in as current debt`,
    ]);
    expect(withCanonicalFinancialLensInputs(undefined, artifact).items[0]?.metrics).toMatchObject({
      debtIncompletePeriodEnd: "2026-06-30",
    });
    expect(
      withCanonicalFinancialLensInputs(undefined, artifact).items[0]?.metrics?.debt,
    ).toBeUndefined();
  });

  // Belden 10-Q 0000913142-26-000034, 2026-06-28: principal 1,248.5M − 17.9M issuance costs = balance-sheet carrying 1,230.6M.
  test("BLDN 2026-06-28 withholds 1.2485B principal calibrated against 2016-10-02", () => {
    const { artifact, canonical, legacy } = selections(
      facts({
        LongTermDebt: [q(1_693_432_000, "2016-10-02", "Q3", "2016-11-07")],
        LongTermDebtCurrent: [q(2_500_000, "2016-10-02", "Q3", "2016-11-07")],
        LongTermDebtNoncurrent: [
          q(1_690_932_000, "2016-10-02", "Q3", "2016-11-07"),
          q(1_230_566_000, "2026-06-28", "Q2", "2026-07-30"),
        ],
        SubordinatedLongTermDebt: [q(1_248_500_000, "2026-06-28", "Q2", "2026-07-30")],
        DebtInstrumentCarryingAmount: [
          q(1_715_822_000, "2016-10-02", "Q3", "2016-11-07"),
          q(1_248_500_000, "2026-06-28", "Q2", "2026-07-30"),
        ],
      }),
    );

    expect(canonical?.value).not.toBe(1_248_500_000);
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.metrics.debtIncompletePeriodEnd).toBe("2026-06-28");
    expect(financialStatementsDebtBasisGaps(artifact)).toHaveLength(1);
    expect(artifact.omissionNotes?.map((note) => note.message)).toContain(
      "Debt composite for 2026-06-28 is incomplete: only gross principal (DebtInstrumentCarryingAmount) is tagged after 2016-10-02, not the carrying amount.",
    );
  });

  test("CRWV-shaped principal-only instant withholds in both writers", () => {
    const { artifact, legacy } = selections(
      facts({ LongTermDebt: crwvNet, DebtInstrumentCarryingAmount: crwvGross }),
    );

    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.metrics.debtIncompletePeriodEnd).toBe("2026-06-30");
    expect(financialStatementsDebtBasisGaps(artifact)).toHaveLength(1);
    expect(legacy?.summary).not.toContain("35551000000");
  });

  test.each([
    [
      "no shared calibration period",
      { LongTermDebt: crwvNet, DebtInstrumentCarryingAmount: crwvGross.slice(3) },
      24_859_000_000,
    ],
    [
      "calibration miss above 5%",
      {
        LongTermDebt: crwvNet,
        DebtInstrumentCarryingAmount: [
          q(26_200_000_000, "2026-03-31", "Q1", "2026-05-08"),
          ...crwvGross.slice(3),
        ],
      },
      24_859_000_000,
    ],
    [
      "equal-period net present",
      {
        LongTermDebt: [...crwvNet, q(35_068_000_000, "2026-06-30", "Q2", "2026-08-12")],
        DebtInstrumentCarryingAmount: crwvGross,
      },
      35_068_000_000,
    ],
    [
      "gross concept absent (dimensional-only facts are not in companyfacts)",
      { LongTermDebt: crwvNet },
      24_859_000_000,
    ],
    [
      "gross filed after the analysis cutoff",
      {
        LongTermDebt: crwvNet,
        DebtInstrumentCarryingAmount: [
          ...crwvGross.slice(0, 3),
          q(35_551_000_000, "2026-06-30", "Q2", "2026-10-05"),
        ],
      },
      24_859_000_000,
    ],
  ] as const)("keeps net debt when %s", (_label, concepts, expected) => {
    const { canonical, legacy } = selections(facts(concepts));

    expect(canonical?.value).toBe(expected);
    expect(legacy?.metrics.debt).toBe(expected);
    expect(legacy?.metrics.debtPeriodEnd).toBe(canonical?.periodEnd);
    expect(legacy?.metrics.debtIncompletePeriodEnd).toBeUndefined();
  });

  test.each([
    ["only a noncurrent-slot prior exists", {}],
    [
      "a complete prior composite exists in other concepts",
      { LongTermDebtCurrent: [q(50_000_000, "2025-06-30", "Q2", "2025-08-06")] },
    ],
  ] as const)("CORZ-shaped: keeps the debt YoY gap when %s", (_label, extra) => {
    const { artifact, legacy } = selections(
      facts({
        LongTermDebt: [
          q(4_000_000_000, "2025-12-31", "FY", "2026-02-27"),
          q(4_297_967_000, "2026-06-30", "Q2", "2026-07-28"),
        ],
        LongTermNotesPayable: [q(1_058_000_000, "2025-06-30", "Q2", "2025-08-06")],
        ...extra,
      }),
    );

    expect(legacy?.metrics).toMatchObject({ debt: 4_297_967_000, debtPeriodEnd: "2026-06-30" });
    expect(legacy?.metrics.debtPrior).toBeUndefined();
    expect(legacy?.gaps.map((gap) => gap.message)).toContainEqual(
      expect.stringMatching(/^Missing comparable SEC company facts for YoY deltas: .*\bdebt$/u),
    );
    expect(
      withCanonicalFinancialLensInputs(undefined, artifact).items[0]?.metrics?.debtPrior,
    ).toBeUndefined();
  });

  test("legacy and canonical both take the same-concept year-ago debt prior", () => {
    const { artifact, legacy } = selections(
      facts({
        LongTermDebt: [
          q(1_000_000_000, "2025-06-30", "Q2", "2025-08-06"),
          q(4_297_967_000, "2026-06-30", "Q2", "2026-07-28"),
        ],
      }),
    );

    expect(legacy?.metrics.debtPrior).toBe(1_000_000_000);
    expect(withCanonicalFinancialLensInputs(undefined, artifact).items[0]?.metrics?.debtPrior).toBe(
      1_000_000_000,
    );
  });

  test("ignores duration-shaped gross rows across latest and calibration candidates", () => {
    const duration = (value: number, periodEnd: string, periodStart: string) =>
      fact({
        value,
        form: "10-Q",
        fiscalPeriod: "Q2",
        filedAt: "2026-08-12",
        periodStart,
        periodEnd,
      });
    const competing = selections(
      facts({
        LongTermDebt: [q(100, "2025-12-31", "FY", "2026-03-02")],
        DebtInstrumentCarryingAmount: [
          q(101, "2025-12-31", "FY", "2026-03-02"),
          q(200, "2026-06-30", "Q2", "2026-08-12"),
          duration(999, "2026-06-30", "2026-01-01"),
        ],
      }),
    );
    const durationOnly = selections(
      facts({
        LongTermDebt: [q(100, "2025-12-31", "FY", "2026-03-02")],
        DebtInstrumentCarryingAmount: [
          duration(101, "2025-12-31", "2025-07-01"),
          duration(200, "2026-06-30", "2026-01-01"),
        ],
      }),
    );

    expect(competing.canonical?.value).toBe(100);
    expect(competing.legacy?.metrics.debtIncompletePeriodEnd).toBe("2026-06-30");
    expect(durationOnly.canonical).toMatchObject({ value: 100 });
    expect(durationOnly.legacy?.metrics.debt).toBe(100);
  });

  test("calibration tolerance is inclusive at ±5% and sign-aware", () => {
    expect([grossWithholds(100, 105), grossWithholds(100, 95), grossWithholds(-100, -105)]).toEqual(
      [true, true, true],
    );
    expect([
      grossWithholds(100, 105.01),
      grossWithholds(100, 94.99),
      grossWithholds(100, -100),
    ]).toEqual([false, false, false]);
    expect(
      grossPrincipalWithholdsDebt({ periodEnd: "2026-06-30", value: 100 }, "2026-06-30", 100, []),
    ).toBe(false);
    expect(
      grossPrincipalWithholdsDebt(
        { periodEnd: "2026-03-31", value: 100 },
        "2026-06-30",
        100,
        [0, 3655],
      ),
    ).toBe(false);
  });
});

describe("SEC summary canonical merge eligibility", () => {
  const asOf = "2026-10-04T00:00:00.000Z";

  test("withholds USD-unit revenue, canonical debt and TTM of a non-USD reporter", () => {
    const summary = summarizeSecFundamentals(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(200, 2025)], EUR: [annual(100, 2025), annual(90, 2024)] },
          LongTermDebt: { EUR: [instant(50, 2025), instant(40, 2024)] },
        },
      }),
      asOf,
    );
    expect(summary?.metrics.revenue).toBeUndefined();
    expect(summary?.metrics.revenueTtm).toBeUndefined();
    expect(summary?.metrics.debt).toBeUndefined();
  });

  test("keeps 20-F debt out of a summary that also has an older 10-K", () => {
    const summary = summarizeSecFundamentals(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(200, 2024), annual(180, 2023)] },
          LongTermDebt: { USD: [instant(70, 2025, "20-F"), instant(60, 2024, "20-F")] },
        },
      }),
      asOf,
    );
    expect(summary?.metrics.revenue).toBe(200);
    expect(summary?.metrics.debt).toBeUndefined();
    expect(summary?.gaps.map((gap) => gap.message)).toContain(
      "SEC summary withheld canonical debt for 2025-12-31 comes from a 20-F, not a 10-K/10-Q",
    );
  });

  test("withholds gross principal when a same-instant borrowing line exceeds it", () => {
    const q = (value: number, periodEnd: string, fp: string, filedAt: string) =>
      amdInstant({
        value,
        form: fp === "FY" ? "10-K" : "10-Q",
        fiscalPeriod: fp,
        filedAt,
        periodEnd,
      });
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        LongTermDebt: { USD: [q(190, "2025-12-31", "FY", "2026-03-02")] },
        DebtInstrumentCarryingAmount: {
          USD: [q(195, "2025-12-31", "FY", "2026-03-02"), q(200, "2026-06-30", "Q2", "2026-08-12")],
        },
        SubordinatedLongTermDebt: { USD: [q(999, "2026-06-30", "Q2", "2026-08-12")] },
      },
    });
    const artifact = derive(companyFacts, { analysisAsOf: asOf });
    expect(
      [
        ...artifact.statements.balanceSheet.debt.annual,
        ...artifact.statements.balanceSheet.debt.interim,
      ].some((item) => item.value === 200),
    ).toBe(false);
    expect(summarizeSecFundamentals(companyFacts, asOf)?.metrics.debt).not.toBe(200);
  });
});

test("notes held-for-sale debt only when no debt is tagged in the recast filing or later", () => {
  const heldNotes = (debtFiledAt: string) =>
    derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(1000, 2025)] },
          LongTermDebtNoncurrent: {
            USD: [
              fact({
                value: 20,
                form: "10-K",
                fiscalYear: 2024,
                fiscalPeriod: "FY",
                filedAt: debtFiledAt,
                periodEnd: "2024-12-31",
              }),
            ],
          },
          LiabilitiesOfDisposalGroupIncludingDiscontinuedOperationCurrent: {
            USD: [
              fact({
                value: 50,
                form: "10-K",
                fiscalYear: 2025,
                fiscalPeriod: "FY",
                filedAt: "2026-02-15",
                periodEnd: "2024-12-31",
              }),
            ],
          },
        },
      }),
    )
      .omissionNotes.filter(({ code }) => code === "debt-held-for-sale")
      .map(({ periodKey, publicAt }) => [periodKey, publicAt]);
  expect(heldNotes("2025-02-15")).toEqual([["instant|2024-12-31", "2026-02-15"]]);
  expect(heldNotes("2026-02-15")).toEqual([]);
});

describe("valuation debt never pairs past a newer incomplete debt instant", () => {
  const row = (input: {
    readonly taxonomy: "us-gaap" | "ifrs-full";
    readonly unit: string;
    readonly debtEnd: string;
    readonly debtFiledAt: string;
    readonly heldEnd: string;
    readonly yearEnd: string;
  }) => {
    const filed = "2025-11-20";
    const at = (value: number, periodEnd: string, filedAt: string, periodStart?: string) =>
      fact({
        value,
        form: input.taxonomy === "us-gaap" ? "10-K" : "20-F",
        fiscalYear: 2025,
        fiscalPeriod: "FY",
        filedAt,
        periodEnd,
        ...(periodStart === undefined ? {} : { periodStart }),
      });
    const concepts =
      input.taxonomy === "us-gaap"
        ? {
            Revenues: [at(1000, input.yearEnd, filed, "2024-09-29")],
            CashAndCashEquivalentsAtCarryingValue: [at(40, input.yearEnd, filed)],
            LongTermDebtNoncurrent: [at(20, input.debtEnd, input.debtFiledAt)],
            LiabilitiesOfDisposalGroupIncludingDiscontinuedOperationCurrent: [
              at(50, input.heldEnd, filed),
            ],
          }
        : {
            Revenue: [at(1000, input.yearEnd, filed, "2024-09-29")],
            CashAndCashEquivalents: [at(40, input.yearEnd, filed)],
            Borrowings: [at(20, input.debtEnd, input.debtFiledAt)],
            LiabilitiesIncludedInDisposalGroupsClassifiedAsHeldForSale: [
              at(50, input.heldEnd, filed),
            ],
          };
    const artifact = derive(
      payload({
        [input.taxonomy]: Object.fromEntries(
          Object.entries(concepts).map(([concept, facts]) => [concept, { [input.unit]: facts }]),
        ),
      }),
    );
    const period = valuationPeriodInputs(artifact).periods.find(
      ({ periodEnd }) => periodEnd === input.yearEnd,
    );
    return {
      debt: period?.debt?.periodEnd,
      scope: period?.debtScopeMismatch,
      behind: period?.debtBehindIncompleteInstant,
    };
  };
  const usGaap = { taxonomy: "us-gaap", unit: "USD", debtFiledAt: "2025-08-01" } as const;

  test("52/53-week: a held-for-sale note at the cash instant withholds the prior-quarter debt", () => {
    expect(
      row({ ...usGaap, debtEnd: "2025-06-28", heldEnd: "2025-09-27", yearEnd: "2025-09-27" }),
    ).toEqual({ debt: undefined, scope: undefined, behind: undefined });
  });

  test("debt 91 days before cash never pairs past a note between them, though within 92 days", () => {
    expect(
      row({ ...usGaap, debtEnd: "2025-07-02", heldEnd: "2025-09-27", yearEnd: "2025-10-01" }),
    ).toEqual({ debt: "2025-07-02", scope: undefined, behind: true });
  });

  test("off-path: no note between debt and cash pairs them normally", () => {
    expect(
      row({ ...usGaap, debtEnd: "2025-07-02", heldEnd: "2025-06-28", yearEnd: "2025-10-01" }),
    ).toEqual({ debt: "2025-07-02", scope: undefined, behind: undefined });
  });

  test("IFRS: pre-recast borrowings at a held-for-sale instant are mixed scope", () => {
    expect(
      row({
        taxonomy: "ifrs-full",
        unit: "EUR",
        debtEnd: "2025-09-27",
        debtFiledAt: "2024-12-01",
        heldEnd: "2025-09-27",
        yearEnd: "2025-09-27",
      }),
    ).toEqual({ debt: undefined, scope: true, behind: undefined });
  });
});

test("notes IFRS liabilities held for sale with no tagged debt as unproven debt", () => {
  const artifact = derive(
    payload({
      "ifrs-full": {
        Revenue: { EUR: [annual(1000, 2025, "20-F")] },
        LiabilitiesIncludedInDisposalGroupsClassifiedAsHeldForSale: {
          EUR: [instant(50, 2025, "20-F")],
        },
      },
    }),
  );
  expect(
    artifact.omissionNotes
      .filter(({ code }) => code === "debt-held-for-sale")
      .map(({ periodKey, message }) => [periodKey, message]),
  ).toEqual([
    [
      "instant|2025-12-31",
      "Debt for 2025-12-31 is incomplete: LiabilitiesIncludedInDisposalGroupsClassifiedAsHeldForSale (20260215-20-F) files liabilities held for sale and no standard ifrs-full debt concept is tagged for that date in that filing or later, so continuing-operations debt is unproven.",
    ],
  ]);
});

describe("annual Workbench rows anchor at the period's first annual report", () => {
  const usGaap10K = (value: number, year: number) =>
    fact({
      value,
      form: "10-K",
      fiscalYear: 2024,
      fiscalPeriod: "FY",
      filedAt: "2025-02-15",
      periodStart: `${String(year)}-01-01`,
      periodEnd: `${String(year)}-12-31`,
    });

  test("a taxonomy switch keeps the original 20-F date and withholds the re-filed inputs", () => {
    const artifact = derive(
      payload({
        "ifrs-full": { Revenue: { USD: [annual(100, 2023, "20-F")] } },
        "us-gaap": {
          Revenues: { USD: [usGaap10K(90, 2023), usGaap10K(120, 2024)] },
          NetIncomeLoss: { USD: [usGaap10K(9, 2023), usGaap10K(12, 2024)] },
          // A forward-looking duration ends after its filing, so it reports no period.
          OperatingLeasePayments: {
            USD: [
              fact({
                value: 5,
                form: "10-K",
                fiscalPeriod: "FY",
                filedAt: "2025-02-15",
                periodStart: "2027-01-01",
                periodEnd: "2027-12-31",
              }),
            ],
          },
        },
      }),
    );
    expect(artifact.firstAnnualReports).toEqual([
      {
        periodStart: "2023-01-01",
        periodEnd: "2023-12-31",
        filedAt: "2024-02-15",
        accessionNumber: "20240215-20-F",
        form: "20-F",
      },
      {
        periodStart: "2024-01-01",
        periodEnd: "2024-12-31",
        filedAt: "2025-02-15",
        accessionNumber: "20250215-10-K",
        form: "10-K",
      },
    ]);
    const { periods, ttm } = valuationPeriodInputs(artifact);
    const [fy2023] = periods;
    expect(periods.map(({ basis }) => basis)).toEqual(["annual", "ttm"]);
    expect(fy2023).toMatchObject({
      rowPublicAt: "2024-02-15",
      restatedAfterFirstFiling: ["revenue", "netIncome"],
    });
    expect(fy2023?.revenue).toBeUndefined();
    expect(ttm).toMatchObject({ basis: "ttm", revenue: { value: 120, publicAt: "2025-02-15" } });
    expect(ttm?.rowPublicAt).toBeUndefined();
  });

  test("an equal 10-Q alias filed before the 10-K neither dates the row nor withholds the 10-K inputs", () => {
    const tenQAlias = fact({
      value: 90,
      form: "10-Q",
      fiscalPeriod: "Q3",
      filedAt: "2024-01-15",
      periodStart: "2023-01-01",
      periodEnd: "2023-12-31",
    });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(90, 2023), annual(120, 2024)] },
          RevenueFromContractWithCustomerExcludingAssessedTax: { USD: [tenQAlias] },
          NetIncomeLoss: { USD: [annual(9, 2023), annual(12, 2024)] },
        },
      }),
    );
    const [fy2023] = valuationPeriodInputs(artifact).periods;
    expect(fy2023?.rowPublicAt).toBe("2024-02-15");
    expect(fy2023?.restatedAfterFirstFiling).toBeUndefined();
    expect(fy2023?.revenue?.value).toBe(90);
    expect(fy2023?.netIncome?.value).toBe(9);
  });

  test("a span with no first annual report withholds every flow input instead of guessing a date", () => {
    const misdated = (value: number) =>
      fact({
        value,
        form: "10-K",
        fiscalPeriod: "FY",
        filedAt: "2012-03-01",
        periodStart: "2023-01-01",
        periodEnd: "2023-12-31",
      });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [misdated(90), annual(120, 2024)] },
          NetIncomeLoss: { USD: [misdated(9), annual(12, 2024)] },
        },
      }),
    );
    const workbench = buildValuationWorkbench({
      generatedAt: "2026-06-15T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: artifact,
      priceHistory: [{ date: "2012-03-01", close: 180 }],
      priceSourceId: "verified-snapshot-TEST",
      quoteCurrency: "USD",
    });
    const [fy2023] = workbench.historicalMultiples.observations;

    expect(artifact.firstAnnualReports?.map(({ periodEnd }) => periodEnd)).toEqual(["2024-12-31"]);
    expect(fy2023).toMatchObject({ basis: "annual", periodEnd: "2023-12-31" });
    expect(fy2023?.inputs.revenue).toBeUndefined();
    expect(fy2023?.metrics.priceToEarnings).toMatchObject({
      status: "missing",
      reason: "first-annual-report-unavailable",
    });
  });

  test("a fiscal-year transition keeps the 10-month and 12-month spans apart", () => {
    const span = (value: number, filedAt: string, periodStart: string) =>
      fact({
        value,
        form: "10-K",
        fiscalPeriod: "FY",
        filedAt,
        periodStart,
        periodEnd: "2023-12-31",
      });
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: {
            USD: [
              span(80, "2024-02-15", "2023-03-01"),
              span(95, "2024-03-15", "2023-01-01"),
              annual(120, 2024),
            ],
          },
          NetIncomeLoss: {
            USD: [
              span(8, "2024-02-15", "2023-03-01"),
              span(9, "2024-03-15", "2023-01-01"),
              annual(12, 2024),
            ],
          },
        },
      }),
    );
    const annualRows = valuationPeriodInputs(artifact).periods.filter(
      ({ basis }) => basis === "annual",
    );

    expect(
      annualRows.map(({ periodKey, rowPublicAt, revenue }) => [
        periodKey,
        rowPublicAt,
        revenue?.value,
      ]),
    ).toEqual([
      ["duration:10|2023-12-31", "2024-02-15", 80],
      ["duration:12|2023-12-31", "2024-03-15", 95],
    ]);
    const workbench = buildValuationWorkbench({
      generatedAt: "2026-06-15T00:00:00.000Z",
      symbol: "TEST",
      financialStatements: artifact,
      priceHistory: [],
      quoteCurrency: "USD",
    });
    expect(
      workbench.historicalMultiples.observations
        .filter(({ basis }) => basis === "annual")
        .map(({ publicAt }) => publicAt),
    ).toEqual(["2024-02-15", "2024-03-15"]);
  });
});

describe("forward revenue concept splice", () => {
  const asc606 = "RevenueFromContractWithCustomerExcludingAssessedTax";
  const keelQ2 = "0001812477-26-000023";
  const sec = (
    value: number,
    form: string,
    fiscalPeriod: string,
    periodStart: string,
    periodEnd: string,
    accessionNumber: string,
    filedAt: string,
  ) => fact({ value, form, fiscalPeriod, periodStart, periodEnd, accessionNumber, filedAt });
  // KEEL companyfacts (CIK 1812477): Revenues stops at Q1 2026; the Q2 2026 10-Q tags only ASC 606 revenue.
  const keelRevenues = [
    sec(
      133_274_000,
      "10-K",
      "FY",
      "2024-01-01",
      "2024-12-31",
      "0001213900-26-037514",
      "2026-03-31",
    ),
    sec(
      229_276_000,
      "10-K",
      "FY",
      "2025-01-01",
      "2025-12-31",
      "0001213900-26-037514",
      "2026-03-31",
    ),
    sec(47_651_000, "10-Q", "Q1", "2025-01-01", "2025-03-31", "0001213900-26-054166", "2026-05-11"),
    sec(36_992_000, "10-Q", "Q1", "2026-01-01", "2026-03-31", "0001213900-26-054166", "2026-05-11"),
  ];
  const keelAsc606 = [
    sec(108_559_000, "10-Q", "Q2", "2025-01-01", "2025-06-30", keelQ2, "2026-08-10"),
    sec(60_908_000, "10-Q", "Q2", "2025-04-01", "2025-06-30", keelQ2, "2026-08-10"),
    sec(67_422_000, "10-Q", "Q2", "2026-01-01", "2026-06-30", keelQ2, "2026-08-10"),
    sec(30_430_000, "10-Q", "Q2", "2026-04-01", "2026-06-30", keelQ2, "2026-08-10"),
  ];
  const keelNetIncome = [
    sec(
      -284_544_000,
      "10-K",
      "FY",
      "2025-01-01",
      "2025-12-31",
      "0001213900-26-037514",
      "2026-03-31",
    ),
    sec(
      -55_553_000,
      "10-Q",
      "Q1",
      "2025-01-01",
      "2025-03-31",
      "0001213900-26-054166",
      "2026-05-11",
    ),
    sec(
      -145_353_000,
      "10-Q",
      "Q1",
      "2026-01-01",
      "2026-03-31",
      "0001213900-26-054166",
      "2026-05-11",
    ),
    sec(-61_054_000, "10-Q", "Q2", "2025-01-01", "2025-06-30", keelQ2, "2026-08-10"),
    sec(-210_348_000, "10-Q", "Q2", "2026-01-01", "2026-06-30", keelQ2, "2026-08-10"),
  ];
  const keel = (
    alias: readonly Record<string, unknown>[] = [],
    unit = "USD",
    { aliasBase = keelAsc606, revenues = [], others = {} } = {} as {
      aliasBase?: readonly Record<string, unknown>[];
      revenues?: readonly Record<string, unknown>[];
      others?: Record<string, { USD: readonly Record<string, unknown>[] }>;
    },
  ) =>
    derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [...keelRevenues, ...revenues] },
          NetIncomeLoss: { USD: keelNetIncome },
          [asc606]: unit === "USD" ? { USD: [...aliasBase, ...alias] } : { [unit]: aliasBase },
          ...others,
        },
      }),
      { analysisAsOf: "2026-11-05T00:00:00.000Z" },
    );
  const spliced = (artifact: ReturnType<typeof derive>) =>
    financialStatementFacts(artifact.statements.incomeStatement.revenue).some(
      (item) => item.concept === asc606,
    );

  test("extends KEEL revenue forward to Q2 2026 only, on its 6M less Q2 proof in 10-Q 0001812477-26-000023", () => {
    const artifact = keel();
    const { revenue } = artifact.statements.incomeStatement;

    expect(
      revenue.interim
        .filter((item) => item.periodEnd === "2026-06-30")
        .map((item) => [item.concept, item.periodStart, item.value]),
    ).toEqual([
      [asc606, "2026-01-01", 67_422_000],
      [asc606, "2026-04-01", 30_430_000],
    ]);
    expect(revenue.annual.map((item) => [item.concept, item.value])).toEqual([
      ["Revenues", 133_274_000],
      ["Revenues", 229_276_000],
    ]);
    expect(
      financialStatementFacts(revenue).filter((item) => item.periodEnd <= "2026-03-31"),
    ).not.toContainEqual(expect.objectContaining({ concept: asc606 }));
    expect(revenue.ttm).toBeUndefined();
    const note = artifact.omissionNotes.find((item) => item.code === "revenue-concept-splice");
    expect(note?.message).toBe(
      `SEC revenue under Revenues ends 2026-03-31; 2026-01-01 to 2026-06-30, 2026-04-01 to 2026-06-30 come from ${asc606} in ${keelQ2}, proven by ${asc606} in ${keelQ2} matching Revenues 2025-01-01 to 2025-03-31 at 47651000`,
    );
    expect(note?.revenueSplice).toEqual({
      selectedConcept: "Revenues",
      selectedEnd: "2026-03-31",
      aliasConcept: asc606,
      proofStart: "2025-01-01",
      proofEnd: "2025-03-31",
      proofAccession: keelQ2,
      periodEnds: ["2026-06-30"],
    });
    const { ttm, periods } = valuationPeriodInputs(artifact);
    expect(ttm).toBeUndefined();
    const q1Row = periods.find((row) => row.basis === "ttm" && row.periodEnd === "2026-03-31");
    expect([q1Row?.revenue?.value, q1Row?.netIncome?.value]).toEqual([218_617_000, -374_344_000]);
    expect(historyGapMessages(artifact)).toEqual([]);
    expect(operatingRatioNotes(artifact)).toContainEqual(note!);
    expect(withCanonicalFinancialLensInputs(undefined, artifact).items[0]?.summary).toContain(
      note!.message,
    );
  });

  test("extends TAYD revenue to Q1 FY2027 on the Q1 FY2026 value both tags carry in 10-Q 0001376474-26-000624", () => {
    const tayd = "0001376474-26-000624";
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: {
            USD: [
              sec(
                46_292_725,
                "10-K",
                "FY",
                "2024-06-01",
                "2025-05-31",
                "0001376474-25-000751",
                "2025-08-15",
              ),
              sec(
                9_918_350,
                "10-Q",
                "Q1",
                "2025-06-01",
                "2025-08-31",
                "0001376474-25-000835",
                "2025-10-01",
              ),
              sec(
                41_649_673,
                "10-K",
                "FY",
                "2025-06-01",
                "2026-05-31",
                "0001376474-26-000567",
                "2026-08-18",
              ),
            ],
          },
          [asc606]: {
            USD: [
              sec(9_918_350, "10-Q", "Q1", "2025-06-01", "2025-08-31", tayd, "2026-10-02"),
              sec(7_300_239, "10-Q", "Q1", "2026-06-01", "2026-08-31", tayd, "2026-10-02"),
            ],
          },
        },
      }),
      { analysisAsOf: "2026-11-05T00:00:00.000Z" },
    );
    const { revenue } = artifact.statements.incomeStatement;

    expect(revenue.interim.map((item) => [item.concept, item.periodEnd, item.value])).toEqual([
      ["Revenues", "2025-08-31", 9_918_350],
      [asc606, "2026-08-31", 7_300_239],
    ]);
    expect(revenue.ttm).toMatchObject({ value: 39_031_562, periodEnd: "2026-08-31" });
    expect(artifact.validationNotes).toContainEqual(
      expect.objectContaining({
        code: "ttm-component-basis",
        message: expect.stringContaining(`latestYearToDate ${asc606}`),
      }),
    );
    expect(
      artifact.omissionNotes.find((item) => item.code === "revenue-concept-splice")?.message,
    ).toContain(
      `proven by ${asc606} in ${tayd} matching Revenues 2025-06-01 to 2025-08-31 at 9918350`,
    );
  });

  test.each([
    {
      name: "one disagreeing shared period",
      alias: [sec(133_275_000, "10-K", "FY", "2024-01-01", "2024-12-31", keelQ2, "2026-08-10")],
      unit: "USD",
    },
    {
      name: "a disagreeing derived period from an earlier filing",
      alias: [
        sec(
          100_000_000,
          "10-Q",
          "Q2",
          "2025-01-01",
          "2025-06-30",
          "0001812477-25-000001",
          "2025-08-10",
        ),
        sec(
          52_349_001,
          "10-Q",
          "Q2",
          "2025-04-01",
          "2025-06-30",
          "0001812477-25-000001",
          "2025-08-10",
        ),
      ],
      unit: "USD",
    },
    { name: "a different currency", alias: [], unit: "EUR" },
    {
      name: "another roster concept filing a different value for a spliced period",
      alias: [],
      unit: "USD",
      options: {
        others: {
          SalesRevenueNet: {
            USD: [sec(31_000_000, "10-Q", "Q2", "2026-04-01", "2026-06-30", keelQ2, "2026-08-10")],
          },
        },
      },
    },
    {
      name: "an alias quarter disagreeing with the selected H1 less Q2",
      alias: [
        sec(110, "10-Q", "Q1", "2024-01-01", "2024-03-31", "0001812477-24-000001", "2024-05-10"),
      ],
      unit: "USD",
      options: {
        revenues: [
          sec(250, "10-Q", "Q2", "2024-01-01", "2024-06-30", "0001812477-24-000002", "2024-08-10"),
          sec(150, "10-Q", "Q2", "2024-04-01", "2024-06-30", "0001812477-24-000002", "2024-08-10"),
        ],
      },
    },
    {
      name: "a proof span starting a day off the selected quarter",
      alias: [],
      unit: "USD",
      options: {
        aliasBase: [
          sec(67_422_000, "10-Q", "Q2", "2026-01-02", "2026-06-30", keelQ2, "2026-08-10"),
          sec(30_430_000, "10-Q", "Q2", "2026-04-01", "2026-06-30", keelQ2, "2026-08-10"),
        ],
      },
    },
  ])(
    "withholds the splice on $name and keeps the stale-concept gap",
    ({ alias, unit, options }) => {
      expect(spliced(keel())).toBe(true);
      const artifact = keel(alias, unit, options);

      expect(spliced(artifact)).toBe(false);
      expect(artifact.omissionNotes.map((item) => item.code)).not.toContain(
        "revenue-concept-splice",
      );
      if (unit === "USD") {
        expect(historyGapMessages(artifact)).toContainEqual(
          expect.stringContaining(`while ${asc606} reports periods to 2026-06-30`),
        );
      }
    },
  );

  test("withholds the splice when contract revenue is a fraction of total revenue (MARA-shaped)", () => {
    const filings = ["0001507605-26-000007", "0001507605-26-000016", "0001507605-26-000022"];
    const mara = (fiscalYear: number, firstQuarter: number) =>
      derive(
        payload({
          "us-gaap": {
            Revenues: {
              USD: [
                sec(
                  fiscalYear,
                  "10-K",
                  "FY",
                  "2025-01-01",
                  "2025-12-31",
                  filings[0]!,
                  "2026-03-02",
                ),
                sec(
                  firstQuarter,
                  "10-Q",
                  "Q1",
                  "2026-01-01",
                  "2026-03-31",
                  filings[1]!,
                  "2026-05-11",
                ),
              ],
            },
            [asc606]: {
              USD: [
                sec(
                  17_413_000,
                  "10-Q",
                  "Q1",
                  "2026-01-01",
                  "2026-03-31",
                  filings[1]!,
                  "2026-05-11",
                ),
                sec(
                  31_224_000,
                  "10-Q",
                  "Q2",
                  "2026-01-01",
                  "2026-06-30",
                  filings[2]!,
                  "2026-08-06",
                ),
                sec(
                  13_811_000,
                  "10-Q",
                  "Q2",
                  "2026-04-01",
                  "2026-06-30",
                  filings[2]!,
                  "2026-08-06",
                ),
              ],
            },
          },
        }),
        { analysisAsOf: "2026-11-05T00:00:00.000Z" },
      );
    expect(spliced(mara(58_704_000, 17_413_000))).toBe(true);
    const artifact = mara(907_093_000, 174_614_000);

    expect(spliced(artifact)).toBe(false);
    expect(historyGapMessages(artifact)).toContainEqual(
      expect.stringContaining(`while ${asc606} reports periods to 2026-06-30`),
    );
  });

  test("dates a spliced period no earlier than the amendment that proves it", () => {
    const original = "0001812477-26-000020";
    const amendment = "0001812477-26-000025";
    const artifact = keel([], "USD", {
      aliasBase: [
        sec(30_430_000, "10-Q", "Q2", "2026-04-01", "2026-06-30", original, "2026-08-01"),
        sec(67_422_000, "10-Q/A", "Q2", "2026-01-01", "2026-06-30", amendment, "2026-08-15"),
        sec(30_430_000, "10-Q/A", "Q2", "2026-04-01", "2026-06-30", amendment, "2026-08-15"),
      ],
    });

    expect(
      artifact.statements.incomeStatement.revenue.interim
        .filter((item) => item.periodEnd === "2026-06-30")
        .map((item) => [item.periodStart, item.firstPublicAt]),
    ).toEqual([
      ["2026-01-01", "2026-08-15"],
      ["2026-04-01", "2026-08-15"],
    ]);
  });

  test("dates a TTM built on a spliced quarter no earlier than its later proof filing", () => {
    const original = "0001376474-26-000600";
    const amendment = "0001376474-26-000650";
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: {
            USD: [
              sec(
                9_918_350,
                "10-Q",
                "Q1",
                "2025-06-01",
                "2025-08-31",
                "0001376474-25-000835",
                "2025-10-01",
              ),
              sec(
                41_649_673,
                "10-K",
                "FY",
                "2025-06-01",
                "2026-05-31",
                "0001376474-26-000567",
                "2026-08-18",
              ),
            ],
          },
          [asc606]: {
            USD: [
              sec(7_300_239, "10-Q", "Q1", "2026-06-01", "2026-08-31", original, "2026-10-02"),
              sec(9_918_350, "10-Q/A", "Q1", "2025-06-01", "2025-08-31", amendment, "2026-10-20"),
              sec(7_300_239, "10-Q/A", "Q1", "2026-06-01", "2026-08-31", amendment, "2026-10-20"),
            ],
          },
        },
      }),
      { analysisAsOf: "2026-11-05T00:00:00.000Z" },
    );
    const { ttm } = artifact.statements.incomeStatement.revenue;

    expect(ttm).toMatchObject({ value: 39_031_562, periodEnd: "2026-08-31" });
    expect(ttm?.components).toMatchObject({
      latestYearToDate: { concept: asc606, firstPublicAt: "2026-10-20" },
    });
    expect(valuationPeriodInputs(artifact).ttm?.revenue?.publicAt).toBe("2026-10-20");
  });

  test("never fills an earlier gap from an alias filing that reports no newer period", () => {
    const olderQ3 = sec(
      55_000_000,
      "10-Q",
      "Q3",
      "2025-07-01",
      "2025-09-30",
      "0001812477-25-000002",
      "2025-11-10",
    );
    const artifact = keel([olderQ3]);

    expect(spliced(artifact)).toBe(true);
    expect(
      financialStatementFacts(artifact.statements.incomeStatement.revenue).map(
        (item) => item.periodEnd,
      ),
    ).not.toContain("2025-09-30");
  });
});

function interimAt(series: FinancialStatementSeries, periodStart: string, periodEnd: string) {
  return series.interim.find(
    (item) => item.periodStart === periodStart && item.periodEnd === periodEnd,
  );
}

type RawRow = readonly [
  start: string | undefined,
  end: string,
  value: number,
  accn: string,
  filed: string,
];
const raw = ([start, end, val, accn, filed]: RawRow) => ({
  ...(start === undefined ? {} : { start }),
  end,
  val,
  accn,
  filed,
  form: "10-K",
  fp: "FY",
});
function unproven(statementRows: readonly RawRow[], conceptRows: readonly RawRow[]) {
  const values = conceptRows.map(raw);
  const root = {
    Assets: {
      units: {
        USD: statementRows.map(([, end, , accn, filed]) => raw([undefined, end, 1, accn, filed])),
      },
    },
    OtherNonoperatingIncomeExpense: { units: { USD: statementRows.map(raw) } },
    Concept: { units: { USD: values } },
  };
  return [...unprovenRestatements(root, values).keys()].map(
    (value) => (value as { accn: string }).accn,
  );
}

describe("unproven restatements", () => {
  const SHIFTED = "0001193125-26-338382";
  const FILINGS = {
    "0000950170-24-132565": ["10-K", "FY", "2024-12-03", "2024-07-01", "2024-09-30"],
    "0000950170-25-067219": ["10-Q", "Q2", "2025-05-08", "2025-01-01", "2025-03-31"],
    "0000827876-25-000005": ["10-Q", "Q3", "2025-08-07", "2025-04-01", "2025-06-30"],
    "0001193125-25-297510": ["10-K", "FY", "2025-11-25", "2025-07-01", "2025-09-30"],
    "0001193125-26-039538": ["10-Q", "Q1", "2026-02-05", "2025-10-01", "2025-12-31"],
    "0001193125-26-217036": ["10-Q", "Q2", "2026-05-11", "2026-01-01", "2026-03-31"],
    [SHIFTED]: ["10-Q", "Q3", "2026-08-06", "2026-04-01", "2026-06-30"],
  } as const;
  type Accession = keyof typeof FILINGS;
  type Row = readonly [start: string, end: string, value: number, accession: Accession];

  function rows(input: readonly Row[]): Record<string, unknown>[] {
    return input.map(([periodStart, periodEnd, value, accessionNumber]) => {
      const [form, fiscalPeriod, filedAt] = FILINGS[accessionNumber];
      return fact({ value, form, fiscalPeriod, filedAt, periodStart, periodEnd, accessionNumber });
    });
  }

  // Each filing's own period end: a balance-sheet instant and a quarter duration ending there.
  function periodEndSupport(accessions: readonly Accession[]) {
    const support = (isInstant: boolean) =>
      accessions.map((accessionNumber) => {
        const [form, fiscalPeriod, filedAt, periodStart, periodEnd] = FILINGS[accessionNumber];
        return fact({
          value: 1,
          form,
          fiscalPeriod,
          filedAt,
          ...(isInstant ? {} : { periodStart }),
          periodEnd,
          accessionNumber,
        });
      });
    return {
      Assets: { USD: support(true) },
      OtherNonoperatingIncomeExpense: { USD: support(false) },
    };
  }

  const EPS: readonly Row[] = [
    ["2023-10-01", "2024-09-30", -0.69, "0000950170-24-132565"],
    ["2023-10-01", "2024-09-30", -0.69, "0001193125-25-297510"],
    ["2024-10-01", "2025-03-31", 0.34, "0000950170-25-067219"],
    ["2024-10-01", "2025-03-31", 0.34, "0001193125-26-217036"],
    ["2024-10-01", "2025-03-31", 1.13, SHIFTED],
    ["2025-01-01", "2025-03-31", -0.49, "0000950170-25-067219"],
    ["2025-01-01", "2025-03-31", -0.49, "0001193125-26-217036"],
    ["2025-01-01", "2025-03-31", 0.78, SHIFTED],
    ["2024-10-01", "2025-06-30", 1.13, "0000827876-25-000005"],
    ["2025-04-01", "2025-06-30", 0.78, "0000827876-25-000005"],
    ["2024-10-01", "2025-09-30", 1.12, "0001193125-25-297510"],
    ["2025-10-01", "2025-12-31", -1.35, "0001193125-26-039538"],
    ["2025-10-01", "2026-03-31", -2.86, "0001193125-26-217036"],
    ["2025-10-01", "2026-03-31", -3.77, SHIFTED],
    ["2026-01-01", "2026-03-31", -1.52, "0001193125-26-217036"],
    ["2026-01-01", "2026-03-31", -0.89, SHIFTED],
  ];
  const SHARES: readonly Row[] = [
    ["2025-10-01", "2026-03-31", 274_726_414, "0001193125-26-217036"],
    ["2025-10-01", "2026-03-31", 272_626_480, SHIFTED],
    ["2026-01-01", "2026-03-31", 267_827_913, "0001193125-26-217036"],
    ["2026-01-01", "2026-03-31", 268_426_611, SHIFTED],
  ];
  const AS_OF = "2026-11-14T00:00:00.000Z";
  const ALL_FILINGS = Object.keys(FILINGS) as Accession[];

  function companyFacts(supported: readonly Accession[], eps: readonly Row[]) {
    return payload({
      "us-gaap": {
        ...periodEndSupport(supported),
        IncomeLossFromContinuingOperationsPerDilutedShare: { "USD/shares": rows(eps) },
        WeightedAverageNumberOfDilutedSharesOutstanding: { shares: rows(SHARES) },
      },
    });
  }

  function clsk(supported: readonly Accession[] = ALL_FILINGS, eps: readonly Row[] = EPS) {
    return derive(companyFacts(supported, eps), { generatedAt: AS_OF, analysisAsOf: AS_OF });
  }

  function sixMonthEps(supported: readonly Accession[], eps: readonly Row[]) {
    return interimAt(
      clsk(supported, eps).statements.perShare.continuingDilutedEps,
      "2025-10-01",
      "2026-03-31",
    );
  }

  test("CLSK 10-Q 0001193125-26-338382 tags its EPS table a quarter early: earlier values stand", () => {
    const artifact = clsk();
    const { continuingDilutedEps: dilutedEps, dilutedShares } = artifact.statements.perShare;

    const sixMonths = interimAt(dilutedEps, "2025-10-01", "2026-03-31");
    expect(sixMonths).toMatchObject({
      value: -2.86,
      accessionNumber: "0001193125-26-217036",
      firstPublicAt: "2026-05-11",
    });
    expect(sixMonths?.restatedFrom).toBeUndefined();
    expect(interimAt(dilutedEps, "2024-10-01", "2025-03-31")?.value).toBe(0.34);
    expect(dilutedEps.ttm?.periodEnd).toBe("2026-03-31");
    expect(dilutedEps.ttm?.value).toBeCloseTo(-2.08);
    expect(interimAt(dilutedShares, "2025-10-01", "2026-03-31")?.value).toBe(274_726_414);
    expect(artifact.omissionNotes.filter((note) => note.code === "unproven-restatement")).toEqual([
      expect.objectContaining({
        seriesKey: "continuingDilutedEps",
        message: expect.stringContaining("period ending 2026-06-30"),
      }),
      expect.objectContaining({ seriesKey: "dilutedShares" }),
    ]);
    expect(historyGapMessages(artifact)).toContainEqual(
      expect.stringContaining(
        `SEC IncomeLossFromContinuingOperationsPerDilutedShare in 10-Q accession ${SHIFTED}`,
      ),
    );
  });

  test("the legacy SEC metrics reader drops the same rows", () => {
    expect(summarizeSecFundamentals(companyFacts(ALL_FILINGS, EPS), AS_OF)?.metrics).toMatchObject({
      continuingDilutedEps: -2.86,
      dilutedShares: 274_726_414,
    });
  });

  test("without a derivable period end the latest filing still wins", () => {
    const supported = ALL_FILINGS.filter((accession) => accession !== SHIFTED);

    expect(sixMonthEps(supported, EPS)).toMatchObject({
      value: -3.77,
      restatedFrom: { value: -2.86 },
    });
  });

  test("a filing that also tags its own period end still restates", () => {
    const eps: readonly Row[] = [...EPS, ["2025-10-01", "2026-06-30", -4.5, SHIFTED]];

    expect(sixMonthEps(ALL_FILINGS, eps)).toMatchObject({
      value: -3.77,
      restatedFrom: { value: -2.86 },
    });
  });

  test("a restated prior-year comparative is aligned with the filing's period end", () => {
    const eps: readonly Row[] = [...EPS, ["2024-10-01", "2025-06-30", 1.2, SHIFTED]];

    expect(
      interimAt(
        clsk(ALL_FILINGS, eps).statements.perShare.continuingDilutedEps,
        "2024-10-01",
        "2025-06-30",
      ),
    ).toMatchObject({ value: 1.2, restatedFrom: { value: 1.13 } });
  });

  test("a 52/53-week comparative a few days off the period end is aligned", () => {
    const eps: readonly Row[] = [...EPS, ["2024-09-29", "2025-06-28", 1.2, SHIFTED]];

    expect(sixMonthEps(ALL_FILINGS, eps)).toMatchObject({
      value: -3.77,
      restatedFrom: { value: -2.86 },
    });
  });

  test("an off-period value with no earlier filing is kept", () => {
    const eps: readonly Row[] = [...EPS, ["2023-10-01", "2024-03-31", 0.1, SHIFTED]];
    const { continuingDilutedEps: dilutedEps } = clsk(ALL_FILINGS, eps).statements.perShare;

    expect(interimAt(dilutedEps, "2023-10-01", "2024-03-31")?.value).toBe(0.1);
    expect(interimAt(dilutedEps, "2025-10-01", "2026-03-31")?.value).toBe(-2.86);
  });

  test("CCI 10-Q 0001051470-22-000115 tags its Q1 2022 dividend paid on the Q3 2021 span", () => {
    const filings = {
      "0001051470-21-000191": ["10-Q", "Q3", "2021-11-05", "2021-07-01", "2021-09-30"],
      "0001051470-22-000115": ["10-Q", "Q1", "2022-04-29", "2022-01-01", "2022-03-31"],
    } as const;
    const row = (accessionNumber: keyof typeof filings, value: number, isInstant = false) => {
      const [form, fiscalPeriod, filedAt, periodStart, periodEnd] = filings[accessionNumber];
      return fact({
        value,
        form,
        fiscalPeriod,
        filedAt,
        ...(isInstant ? {} : { periodStart }),
        periodEnd,
        accessionNumber,
      });
    };
    const artifact = derive(
      payload({
        "us-gaap": {
          Assets: {
            USD: [row("0001051470-21-000191", 1, true), row("0001051470-22-000115", 1, true)],
          },
          OtherNonoperatingIncomeExpense: {
            USD: [row("0001051470-21-000191", 1), row("0001051470-22-000115", 1)],
          },
          CommonStockDividendsPerShareCashPaid: {
            "USD/shares": [
              fact({
                value: 1.33,
                form: "10-Q",
                fiscalPeriod: "Q3",
                filedAt: "2021-11-05",
                periodStart: "2021-07-01",
                periodEnd: "2021-09-30",
                accessionNumber: "0001051470-21-000191",
              }),
              fact({
                value: 1.47,
                form: "10-Q",
                fiscalPeriod: "Q1",
                filedAt: "2022-04-29",
                periodStart: "2021-07-01",
                periodEnd: "2021-09-30",
                accessionNumber: "0001051470-22-000115",
              }),
            ],
          },
        },
      }),
      { analysisAsOf: "2022-06-30T00:00:00.000Z" },
    );

    const quarter = artifact.statements.perShare.dividendsPerShare.interim.find(
      (item) => item.periodEnd === "2021-09-30",
    );
    expect(quarter).toMatchObject({ value: 1.33, accessionNumber: "0001051470-21-000191" });
    expect(quarter?.restatedFrom).toBeUndefined();
    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({
        code: "unproven-restatement",
        seriesKey: "dividendsPerShare",
        message: expect.stringContaining("0001051470-22-000115"),
      }),
    );
  });

  test("an off-period value a later filing supersedes needs no gap (COST FY2021 10-K special dividend)", () => {
    const tenK = "0000909832-21-000014";
    const quarter = (value: number, filedAt: string, accessionNumber: string, form = "10-Q") =>
      fact({
        value,
        form,
        fiscalPeriod: form === "10-K" ? "FY" : "Q1",
        filedAt,
        periodStart: "2020-08-31",
        periodEnd: "2020-11-22",
        accessionNumber,
      });
    const tenKPeriod = { form: "10-K", fiscalPeriod: "FY", filedAt: "2021-10-06" };
    const artifact = derive(
      payload({
        "us-gaap": {
          Assets: {
            USD: [
              fact({ ...tenKPeriod, value: 1, periodEnd: "2021-08-29", accessionNumber: tenK }),
            ],
          },
          OtherNonoperatingIncomeExpense: {
            USD: [
              fact({
                ...tenKPeriod,
                value: 1,
                periodStart: "2020-08-31",
                periodEnd: "2021-08-29",
                accessionNumber: tenK,
              }),
            ],
          },
          CommonStockDividendsPerShareDeclared: {
            "USD/shares": [
              quarter(0.7, "2020-12-16", "0000909832-20-000026"),
              quarter(10, "2021-10-06", tenK, "10-K"),
              quarter(0.7, "2021-12-22", "0000909832-21-000021"),
            ],
          },
        },
      }),
      { analysisAsOf: "2022-01-31T00:00:00.000Z" },
    );

    expect(
      artifact.statements.perShare.dividendsPerShare.interim.find(
        (item) => item.periodEnd === "2020-11-22",
      )?.value,
    ).toBe(0.7);
    expect(artifact.omissionNotes.map((note) => note.code)).not.toContain("unproven-restatement");
  });

  describe("predicate over raw companyfacts rows", () => {
    test("an 8-K recast with several statement dates restates years it carries (GPN 0001123360-25-000080)", () => {
      const recast = "0001123360-25-000080";
      expect(
        unproven(
          [
            ["2023-01-01", "2023-12-31", 1, recast, "2025-11-04"],
            ["2024-01-01", "2024-12-31", 1, recast, "2025-11-04"],
            ["2025-01-01", "2025-03-31", 1, recast, "2025-11-04"],
          ],
          [
            ["2022-01-01", "2022-12-31", -189_030_000, "0001123360-25-000011", "2025-02-14"],
            ["2022-01-01", "2022-12-31", -447_432_000, recast, "2025-11-04"],
          ],
        ),
      ).toEqual([]);
    });

    test("a repeat of the standing value is no restatement (Flowserve 8-K 0000030625-12-000018)", () => {
      const recast = "0000030625-12-000018";
      expect(
        unproven(
          [["2012-01-01", "2012-06-30", 1, recast, "2012-08-30"]],
          [
            ["2009-01-01", "2009-12-31", -60_838_000, "0000950123-10-016384", "2010-02-24"],
            ["2009-01-01", "2009-12-31", 60_838_000, "0000030625-12-000005", "2012-02-22"],
            ["2009-01-01", "2009-12-31", 60_838_000, recast, "2012-08-30"],
          ],
        ),
      ).toEqual([]);
    });

    test("a correction re-filed unchanged by the next filing stands (Cognex SBC 2020-03-30..2020-06-28)", () => {
      expect(
        unproven(
          [
            ["2021-01-01", "2021-12-31", 1, "0000851205-22-000008", "2022-02-17"],
            ["2022-01-01", "2022-12-31", 1, "0000851205-23-000004", "2023-02-16"],
          ],
          [
            ["2020-03-30", "2020-06-28", -1_401_000, "0000851205-21-000020", "2021-08-05"],
            ["2020-03-30", "2020-06-28", 1_401_000, "0000851205-22-000008", "2022-02-17"],
            ["2020-03-30", "2020-06-28", 1_401_000, "0000851205-23-000004", "2023-02-16"],
          ],
        ),
      ).toEqual(["0000851205-22-000008"]);
    });
  });

  test("the shifted value is withheld before its superseder is filed (COST as of 2021-11-01)", () => {
    const quarter = (value: number, filedAt: string, accessionNumber: string, form = "10-Q") =>
      fact({
        value,
        form,
        fiscalPeriod: form === "10-K" ? "FY" : "Q1",
        filedAt,
        periodStart: "2020-08-31",
        periodEnd: "2020-11-22",
        accessionNumber,
      });
    const tenK = "0000909832-21-000014";
    const tenKPeriod = {
      form: "10-K",
      fiscalPeriod: "FY",
      filedAt: "2021-10-06",
      accessionNumber: tenK,
    };
    const artifact = derive(
      payload({
        "us-gaap": {
          Assets: { USD: [fact({ ...tenKPeriod, value: 1, periodEnd: "2021-08-29" })] },
          OtherNonoperatingIncomeExpense: {
            USD: [
              fact({ ...tenKPeriod, value: 1, periodStart: "2020-08-31", periodEnd: "2021-08-29" }),
            ],
          },
          CommonStockDividendsPerShareDeclared: {
            "USD/shares": [
              quarter(0.7, "2020-12-16", "0000909832-20-000026"),
              quarter(10, "2021-10-06", tenK, "10-K"),
              quarter(0.7, "2021-12-22", "0000909832-21-000021"),
            ],
          },
        },
      }),
      { analysisAsOf: "2021-11-01T00:00:00.000Z" },
    );

    expect(
      artifact.statements.perShare.dividendsPerShare.interim.find(
        (item) => item.periodEnd === "2020-11-22",
      ),
    ).toMatchObject({ value: 0.7, accessionNumber: "0000909832-20-000026" });
    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({
        code: "unproven-restatement",
        message: expect.stringContaining(tenK),
      }),
    );
  });

  test("ifrs-full facts follow the same rule", () => {
    const usGaapFacts = companyFacts(ALL_FILINGS, EPS) as {
      facts: Record<string, Record<string, unknown>>;
    };
    const gaap = usGaapFacts.facts["us-gaap"]!;
    const ifrs = derive(
      {
        facts: {
          "ifrs-full": {
            Assets: gaap.Assets,
            OtherNonoperatingIncomeExpense: gaap.OtherNonoperatingIncomeExpense,
            DilutedEarningsLossPerShareFromContinuingOperations:
              gaap.IncomeLossFromContinuingOperationsPerDilutedShare,
          },
        },
      },
      { generatedAt: AS_OF, analysisAsOf: AS_OF },
    );

    expect(
      interimAt(ifrs.statements.perShare.continuingDilutedEps, "2025-10-01", "2026-03-31")?.value,
    ).toBe(-2.86);
  });
});
