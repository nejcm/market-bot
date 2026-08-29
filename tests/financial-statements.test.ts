import { describe, expect, test } from "bun:test";
import {
  canonicalizeSecForm,
  deriveFinancialStatements,
} from "../src/sources/extended-evidence/financial-statements";
import { latestFinancialStatementFact } from "../src/sources/extended-evidence/financial-statement-selection";
import type { FinancialStatementSeries } from "../src/sources/extended-evidence/financial-statements-contract";
import { buildValuationWorkbench } from "../src/sources/extended-evidence/valuation-workbench";

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
      value: 4_000_000_000,
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
      value: 4_000_000_000,
      extractionMethod: "sec-companyfacts",
      concept: "LongTermDebt",
    });
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

  test("records a one-legged composite when only noncurrent debt is tagged", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
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
      value: 2_351_000_000,
      periodEnd: "2026-06-27",
      extractionMethod: "derived-sec-companyfacts",
      concept: "LongTermDebtNoncurrent",
    });
    expect(debt?.composite?.components).toEqual([
      expect.objectContaining({
        concept: "LongTermDebtNoncurrent",
        value: 2_351_000_000,
        periodEnd: "2026-06-27",
      }),
    ]);
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

  test("does not record untagged debt when no balance-sheet series is tagged", () => {
    const artifact = derive(
      payload({
        "us-gaap": {
          Revenues: { USD: [annual(100, 2025)] },
        },
      }),
    );

    expect(
      artifact.omissionNotes.some((note) => note.code === "untagged-balance-sheet-series"),
    ).toBe(false);
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
});
