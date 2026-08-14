import { describe, expect, test } from "bun:test";
import { FINANCIAL_STATEMENT_SERIES_DEFINITIONS } from "../src/sources/extended-evidence/financial-statement-definitions";
import {
  deriveFinancialStatements,
  type FinancialStatementsDeriveInput,
} from "../src/sources/extended-evidence/financial-statements";
import { financialStatementSeries } from "../src/sources/extended-evidence/financial-statement-selection";
import type { FinancialStatementSeriesKey } from "../src/sources/extended-evidence/financial-statements-contract";

interface FactInput {
  readonly value: number;
  readonly form: string;
  readonly fiscalYear: number;
  readonly fiscalPeriod: string;
  readonly filedAt: string;
  readonly periodEnd: string;
  readonly periodStart?: string;
  readonly accessionNumber: string;
}

function fact(input: FactInput): Record<string, unknown> {
  return {
    val: input.value,
    form: input.form,
    fy: input.fiscalYear,
    fp: input.fiscalPeriod,
    filed: input.filedAt,
    end: input.periodEnd,
    accn: input.accessionNumber,
    ...(input.periodStart === undefined ? {} : { start: input.periodStart }),
  };
}

function payload(
  concepts: Readonly<Record<string, Readonly<Record<string, readonly Record<string, unknown>[]>>>>,
): unknown {
  return {
    facts: {
      "ifrs-full": Object.fromEntries(
        Object.entries(concepts).map(([concept, units]) => [concept, { units }]),
      ),
    },
  };
}

function derive(companyFacts: unknown): ReturnType<typeof deriveFinancialStatements> {
  const input: FinancialStatementsDeriveInput = {
    symbol: "TEST",
    generatedAt: "2026-06-15T00:00:00.000Z",
    analysisAsOf: "2026-06-15T00:00:00.000Z",
    sourceId: "extended-sec-edgar-test-fundamentals",
  };
  return deriveFinancialStatements(companyFacts, input);
}

function duplicateNotes(artifact: ReturnType<typeof deriveFinancialStatements>) {
  return artifact.validationNotes.filter(({ code }) => code === "duplicate-superseded");
}

describe("financial statement period keys", () => {
  test("collapses one-day annual drift across a leap-year duration boundary", () => {
    const artifact = derive(
      payload({
        Revenue: {
          CAD: [
            fact({
              value: 100,
              form: "40-F",
              fiscalYear: 2020,
              fiscalPeriod: "FY",
              filedAt: "2021-02-01",
              periodStart: "2019-12-31",
              periodEnd: "2020-12-31",
              accessionNumber: "older",
            }),
            fact({
              value: 100,
              form: "40-F",
              fiscalYear: 2021,
              fiscalPeriod: "FY",
              filedAt: "2022-02-01",
              periodStart: "2020-01-01",
              periodEnd: "2020-12-31",
              accessionNumber: "newer",
            }),
          ],
        },
      }),
    );

    expect(artifact.statements.incomeStatement.revenue.annual).toHaveLength(1);
    expect(artifact.statements.incomeStatement.revenue.annual[0]?.accessionNumber).toBe("newer");
    expect(duplicateNotes(artifact)).toHaveLength(1);
  });

  test("does not merge annual and interim facts ending on the same day", () => {
    const artifact = derive(
      payload({
        Revenue: {
          CAD: [
            fact({
              value: 100,
              form: "40-F",
              fiscalYear: 2025,
              fiscalPeriod: "FY",
              filedAt: "2025-06-01",
              periodStart: "2024-05-01",
              periodEnd: "2025-04-30",
              accessionNumber: "annual",
            }),
            fact({
              value: 30,
              form: "6-K",
              fiscalYear: 2025,
              fiscalPeriod: "Q2",
              filedAt: "2025-06-02",
              periodStart: "2025-02-01",
              periodEnd: "2025-04-30",
              accessionNumber: "interim",
            }),
          ],
        },
      }),
    );

    expect(
      artifact.statements.incomeStatement.revenue.annual.map(({ periodKey }) => periodKey),
    ).toEqual(["duration:12|2025-04-30"]);
    expect(
      artifact.statements.incomeStatement.revenue.interim.map(({ periodKey }) => periodKey),
    ).toEqual(["duration:3|2025-04-30"]);
    expect(duplicateNotes(artifact)).toEqual([]);
  });

  test("does not merge YTD and discrete-quarter facts ending on the same day", () => {
    const artifact = derive(
      payload({
        Revenue: {
          CAD: [
            fact({
              value: 60,
              form: "6-K",
              fiscalYear: 2025,
              fiscalPeriod: "H1",
              filedAt: "2025-06-01",
              periodStart: "2024-11-01",
              periodEnd: "2025-04-30",
              accessionNumber: "ytd",
            }),
            fact({
              value: 30,
              form: "6-K",
              fiscalYear: 2025,
              fiscalPeriod: "Q2",
              filedAt: "2025-06-01",
              periodStart: "2025-02-01",
              periodEnd: "2025-04-30",
              accessionNumber: "discrete",
            }),
          ],
        },
      }),
    );

    expect(
      artifact.statements.incomeStatement.revenue.interim.map(({ periodKey }) => periodKey),
    ).toEqual(["duration:6|2025-04-30", "duration:3|2025-04-30"]);
    expect(duplicateNotes(artifact)).toEqual([]);
  });

  test("keeps instant keys unchanged", () => {
    const artifact = derive(
      payload({
        Assets: {
          CAD: [
            fact({
              value: 100,
              form: "40-F",
              fiscalYear: 2025,
              fiscalPeriod: "FY",
              filedAt: "2025-05-01",
              periodEnd: "2025-04-30",
              accessionNumber: "older",
            }),
            fact({
              value: 110,
              form: "40-F",
              fiscalYear: 2025,
              fiscalPeriod: "FY",
              filedAt: "2025-06-01",
              periodEnd: "2025-04-30",
              accessionNumber: "newer",
            }),
          ],
        },
      }),
    );

    expect(artifact.statements.balanceSheet.totalAssets.annual).toHaveLength(1);
    expect(artifact.statements.balanceSheet.totalAssets.annual[0]).toMatchObject({
      value: 110,
      periodKey: "instant|2025-04-30",
      accessionNumber: "newer",
    });
    expect(duplicateNotes(artifact)).toHaveLength(1);
  });

  test("collapses six BNS-shaped duplicates from 97 annual inputs to 91 rows", () => {
    const duplicatedSeries = new Set<FinancialStatementSeriesKey>([
      "revenue",
      "netIncome",
      "operatingCashFlow",
      "dividendsPaid",
      "dilutedEps",
      "dilutedShares",
    ]);
    let inputRows = 0;
    const concepts = Object.fromEntries(
      FINANCIAL_STATEMENT_SERIES_DEFINITIONS.map((definition, definitionIndex) => {
        const concept = definition.concepts["ifrs-full"][0]!;
        const unit = { monetary: "CAD", shares: "shares", "per-share": "CAD/shares" }[
          definition.unitKind
        ];
        const firstYear = duplicatedSeries.has(definition.key) ? 2014 : 2015;
        const facts = Array.from({ length: 2020 - firstYear }, (_, index) => {
          const year = firstYear + index;
          return fact({
            value: definitionIndex * 1000 + year,
            form: "40-F",
            fiscalYear: year,
            fiscalPeriod: "FY",
            filedAt: `${String(year + 1)}-01-04`,
            ...(definition.kind === "duration" ? { periodStart: `${String(year - 1)}-11-01` } : {}),
            periodEnd: `${String(year)}-10-31`,
            accessionNumber: `${definition.key}-${String(year)}`,
          });
        });
        if (duplicatedSeries.has(definition.key)) {
          facts.push(
            fact({
              value: definitionIndex * 1000 + 2018,
              form: "40-F",
              fiscalYear: 2020,
              fiscalPeriod: "FY",
              filedAt: "2020-01-03",
              periodStart: "2017-11-02",
              periodEnd: "2018-10-31",
              accessionNumber: `${definition.key}-2018-refiled`,
            }),
          );
        }
        inputRows += facts.length;
        return [concept, { [unit]: facts }];
      }),
    );

    const artifact = derive(payload(concepts));
    const annualRows = financialStatementSeries(artifact).reduce(
      (total, series) => total + series.annual.length,
      0,
    );

    expect(inputRows).toBe(97);
    expect(annualRows).toBe(91);
    expect(duplicateNotes(artifact)).toHaveLength(6);
  });
});
