import { describe, expect, test } from "bun:test";
import {
  canonicalizeSecForm,
  deriveFinancialStatements,
} from "../src/sources/extended-evidence/financial-statements";
import { attachFinancialStatementParity } from "../src/sources/extended-evidence/financial-statements-parity";
import { deriveFundamentalHistory } from "../src/sources/extended-evidence/fundamental-history";

interface FactInput {
  readonly value: number;
  readonly form: string;
  readonly fiscalYear: number;
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
    fy: input.fiscalYear,
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
    expect(canonicalizeSecForm("40-F")).toBeUndefined();
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
        periodKey: "annual|2025-01-01|2025-12-31",
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

  test("reports same-period legacy value changes as unexplained parity mismatches", () => {
    const companyFacts = payload({ "us-gaap": { Revenues: { USD: [annual(100, 2025)] } } });
    const artifact = derive(companyFacts);
    const history = deriveFundamentalHistory(companyFacts, {
      symbol: "TEST",
      generatedAt: "2026-06-15T00:00:00.000Z",
      analysisAsOf: "2026-06-15T00:00:00.000Z",
      sourceId: "extended-sec-edgar-test-fundamentals",
    });
    const changedHistory = {
      ...history,
      series: {
        ...history.series,
        revenue: {
          ...history.series.revenue,
          annual: history.series.revenue.annual.map((point) => ({
            ...point,
            value: point.value + 1,
          })),
        },
      },
    };
    const parity = attachFinancialStatementParity(artifact, {
      fundamentalHistory: changedHistory,
    }).shadowParity;

    expect(parity.unexplainedCount).toBeGreaterThan(0);
    expect(parity.comparisons).toContainEqual(
      expect.objectContaining({
        consumer: "fundamental-history",
        field: "revenue.annual",
        status: "unexplained",
      }),
    );
  });

  test("reports missing legacy periods and TTM values instead of skipping them", () => {
    const companyFacts = payload({
      "us-gaap": {
        Revenues: {
          USD: [
            annual(100, 2024),
            interim({
              value: 20,
              year: 2024,
              endMonthDay: "03-31",
              form: "10-Q",
              fiscalPeriod: "Q1",
            }),
            interim({
              value: 30,
              year: 2025,
              endMonthDay: "03-31",
              form: "10-Q",
              fiscalPeriod: "Q1",
            }),
          ],
        },
      },
    });
    const artifact = derive(companyFacts);
    const history = deriveFundamentalHistory(companyFacts, {
      symbol: "TEST",
      generatedAt: "2026-06-15T00:00:00.000Z",
      analysisAsOf: "2026-06-15T00:00:00.000Z",
      sourceId: "extended-sec-edgar-test-fundamentals",
    });
    const { ttm: _ttm, ...revenueWithoutTtm } = history.series.revenue;
    const parity = attachFinancialStatementParity(artifact, {
      fundamentalHistory: {
        ...history,
        series: {
          ...history.series,
          revenue: { ...revenueWithoutTtm, annual: [] },
        },
      },
    }).shadowParity;

    expect(parity.comparisons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "revenue.annual",
          status: "unexplained",
          legacyValue: "missing",
        }),
        expect.objectContaining({
          field: "revenue.ttm",
          status: "unexplained",
          legacyValue: "missing",
        }),
      ]),
    );
  });

  test("reports same-period Financial Lens value changes as unexplained", () => {
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        CashAndCashEquivalentsAtCarryingValue: {
          USD: [
            fact({
              value: 40,
              form: "10-K",
              fiscalYear: 2025,
              fiscalPeriod: "FY",
              filedAt: "2026-02-15",
              periodEnd: "2025-12-31",
            }),
          ],
        },
      },
    });
    const artifact = derive(companyFacts);
    const history = deriveFundamentalHistory(companyFacts, {
      symbol: "TEST",
      generatedAt: "2026-06-15T00:00:00.000Z",
      analysisAsOf: "2026-06-15T00:00:00.000Z",
      sourceId: "extended-sec-edgar-test-fundamentals",
    });
    const parity = attachFinancialStatementParity(artifact, {
      fundamentalHistory: history,
      financialLenses: {
        version: 1,
        generatedAt: "2026-06-15T00:00:00.000Z",
        symbol: "TEST",
        lenses: [
          {
            name: "Financial Strength",
            posture: "criteria-mixed",
            sourceIds: ["extended-sec-edgar-test-fundamentals"],
            metrics: [
              {
                key: "cash",
                label: "Cash",
                value: 41,
                unit: "currency",
                currency: "USD",
                periodEnd: "2025-12-31",
                sourceIds: ["extended-sec-edgar-test-fundamentals"],
              },
            ],
          },
        ],
        sourceIds: ["extended-sec-edgar-test-fundamentals"],
      },
    }).shadowParity;

    expect(parity.comparisons).toContainEqual(
      expect.objectContaining({
        consumer: "financial-lens",
        field: "cash",
        status: "unexplained",
      }),
    );
  });

  test("compares fundamental-history parity by exact start/end period key", () => {
    const companyFacts = payload({ "us-gaap": { Revenues: { USD: [annual(100, 2025)] } } });
    const artifact = derive(companyFacts);
    const history = deriveFundamentalHistory(companyFacts, {
      symbol: "TEST",
      generatedAt: "2026-06-15T00:00:00.000Z",
      analysisAsOf: "2026-06-15T00:00:00.000Z",
      sourceId: "extended-sec-edgar-test-fundamentals",
    });
    const parity = attachFinancialStatementParity(artifact, {
      fundamentalHistory: {
        ...history,
        series: {
          ...history.series,
          revenue: {
            ...history.series.revenue,
            annual: history.series.revenue.annual.map((point) => ({
              ...point,
              periodStart: "2025-04-01",
            })),
          },
        },
      },
    }).shadowParity;

    expect(
      parity.comparisons.filter(
        (comparison) =>
          comparison.field === "revenue.annual" && comparison.status === "unexplained",
      ),
    ).toHaveLength(2);
  });

  test("verifies Financial Lens duration and reporting-currency differences", () => {
    const companyFacts = payload({
      "us-gaap": {
        Revenues: { USD: [annual(100, 2025)] },
        GrossProfit: { USD: [annual(40, 2025)] },
      },
    });
    const artifact = derive(companyFacts);
    const history = deriveFundamentalHistory(companyFacts, {
      symbol: "TEST",
      generatedAt: "2026-06-15T00:00:00.000Z",
      analysisAsOf: "2026-06-15T00:00:00.000Z",
      sourceId: "extended-sec-edgar-test-fundamentals",
    });
    const parity = attachFinancialStatementParity(artifact, {
      fundamentalHistory: {
        ...history,
        series: {
          ...history.series,
          revenue: {
            ...history.series.revenue,
            annual: history.series.revenue.annual.map((point) => ({
              ...point,
              currency: "EUR",
            })),
          },
        },
      },
      financialLenses: {
        version: 1,
        generatedAt: "2026-06-15T00:00:00.000Z",
        symbol: "TEST",
        lenses: [
          {
            name: "Quality",
            posture: "criteria-mixed",
            sourceIds: ["extended-sec-edgar-test-fundamentals"],
            metrics: [
              {
                key: "grossMargin",
                label: "Gross margin",
                value: 0.4,
                unit: "ratio-percent",
                periodEnd: "2025-12-31",
                periodMonths: 9,
                sourceIds: ["extended-sec-edgar-test-fundamentals"],
              },
            ],
          },
        ],
        sourceIds: ["extended-sec-edgar-test-fundamentals"],
      },
    }).shadowParity;

    expect(parity.comparisons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumer: "fundamental-history",
          field: "revenue.annual",
          status: "explained",
          reasonCode: "canonical-reporting-currency-isolation",
        }),
        expect.objectContaining({
          consumer: "financial-lens",
          field: "grossMargin",
          status: "explained",
          reasonCode: "canonical-period-selection",
        }),
      ]),
    );
  });

  test("does not explain a Financial Lens window mismatch when that window exists", () => {
    const companyFacts = payload({
      "us-gaap": {
        Revenues: {
          USD: [
            annual(100, 2025),
            fact({
              value: 75,
              form: "10-K",
              fiscalYear: 2025,
              fiscalPeriod: "FY",
              filedAt: "2026-02-15",
              periodStart: "2025-04-01",
              periodEnd: "2025-12-31",
            }),
          ],
        },
        GrossProfit: {
          USD: [
            annual(40, 2025),
            fact({
              value: 30,
              form: "10-K",
              fiscalYear: 2025,
              fiscalPeriod: "FY",
              filedAt: "2026-02-15",
              periodStart: "2025-04-01",
              periodEnd: "2025-12-31",
            }),
          ],
        },
      },
    });
    const artifact = derive(companyFacts);
    const parity = attachFinancialStatementParity(artifact, {
      financialLenses: {
        version: 1,
        generatedAt: "2026-06-15T00:00:00.000Z",
        symbol: "TEST",
        lenses: [
          {
            name: "Quality",
            posture: "criteria-mixed",
            sourceIds: ["extended-sec-edgar-test-fundamentals"],
            metrics: [
              {
                key: "grossMargin",
                label: "Gross margin",
                value: 0.4,
                unit: "ratio-percent",
                periodEnd: "2025-12-31",
                periodMonths: 12,
                sourceIds: ["extended-sec-edgar-test-fundamentals"],
              },
            ],
          },
        ],
        sourceIds: ["extended-sec-edgar-test-fundamentals"],
      },
    }).shadowParity;

    expect(parity.comparisons).toContainEqual(
      expect.objectContaining({
        consumer: "financial-lens",
        field: "grossMargin",
        status: "unexplained",
      }),
    );
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
