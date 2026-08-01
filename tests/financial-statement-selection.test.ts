import { describe, expect, test } from "bun:test";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementSeriesKey,
  FinancialStatementTtm,
  FinancialStatementsArtifact,
  SupportedSecForm,
} from "../src/sources/extended-evidence/financial-statements-contract";
import {
  financialStatementFactForPeriod,
  financialStatementFactsAreCompatible,
  financialStatementSeries,
  financialStatementSeriesByKey,
  financialStatementTtmsAreCompatible,
  financialStatementTtmsSharePeriod,
  latestCommonFinancialStatementFacts,
  latestFinancialStatementFact,
} from "../src/sources/extended-evidence/financial-statement-selection";

interface FactOverrides {
  readonly value?: number;
  readonly periodKey?: string;
  readonly periodType?: "annual" | "interim";
  readonly periodStart?: string | null;
  readonly periodEnd?: string;
  readonly filedAt?: string;
  readonly amendment?: boolean;
  readonly accessionNumber?: string | null;
  readonly currency?: string | null;
  readonly unit?: string;
  readonly unitScale?: number;
}

function fact(overrides: FactOverrides = {}): FinancialStatementFact {
  const periodType = overrides.periodType ?? "annual";
  const amendment = overrides.amendment ?? false;
  const canonicalForm = periodType === "annual" ? "10-K" : "10-Q";
  let form: SupportedSecForm = canonicalForm;
  if (amendment) {
    form = canonicalForm === "10-K" ? "10-K/A" : "10-Q/A";
  }
  return {
    value: overrides.value ?? 1,
    periodKey: overrides.periodKey ?? "2024-01-01|2024-12-31",
    periodType,
    form,
    canonicalForm,
    amendment,
    accessionNumber: overrides.accessionNumber ?? "accession-a",
    filedAt: overrides.filedAt ?? "2025-02-01",
    ...(overrides.periodStart === null
      ? {}
      : { periodStart: overrides.periodStart ?? "2024-01-01" }),
    periodEnd: overrides.periodEnd ?? "2024-12-31",
    fiscalYear: 2024,
    fiscalPeriod: periodType === "annual" ? "FY" : "Q4",
    taxonomy: "us-gaap",
    concept: "TestConcept",
    currency: overrides.currency === undefined ? "USD" : overrides.currency,
    unit: overrides.unit ?? "USD",
    unitScale: overrides.unitScale ?? 1,
    extractionMethod: "sec-companyfacts",
    sourceIds: ["sec-test"],
  };
}

function ttm(overrides: Partial<FinancialStatementTtm> = {}): FinancialStatementTtm {
  const fiscalYear = fact();
  const latestYearToDate = fact({
    periodKey: "2025-01-01|2025-03-31",
    periodType: "interim",
    periodStart: "2025-01-01",
    periodEnd: "2025-03-31",
  });
  const priorYearToDate = fact({
    periodKey: "2024-01-01|2024-03-31",
    periodType: "interim",
    periodStart: "2024-01-01",
    periodEnd: "2024-03-31",
  });
  return {
    value: 1,
    periodStart: "2024-04-01",
    periodEnd: "2025-03-31",
    currency: "USD",
    unit: "USD",
    unitScale: 1,
    extractionMethod: "derived-sec-companyfacts",
    formula: "FY + latest-YTD - prior-YTD",
    sourceIds: ["sec-test"],
    components: { fiscalYear, latestYearToDate, priorYearToDate },
    ...overrides,
  };
}

function series(
  key: FinancialStatementSeriesKey,
  facts: readonly FinancialStatementFact[],
): FinancialStatementSeries {
  return {
    key,
    label: key,
    statement: "incomeStatement",
    annual: facts.filter((item) => item.periodType === "annual"),
    interim: facts.filter((item) => item.periodType === "interim"),
  };
}

describe("financial statement selection", () => {
  test("uses filing, amendment, then accession tie breakers after period and duration", () => {
    const selected = latestFinancialStatementFact([
      fact({ filedAt: "2025-03-01", accessionNumber: "accession-z" }),
      fact({ filedAt: "2025-03-01", amendment: true, accessionNumber: "accession-a" }),
      fact({ filedAt: "2025-03-01", amendment: true, accessionNumber: "accession-b", value: 2 }),
      fact({ filedAt: "2025-02-01", amendment: true, accessionNumber: "accession-z" }),
      fact({ periodEnd: "2023-12-31", periodKey: "2023-01-01|2023-12-31" }),
    ]);

    expect(selected?.value).toBe(2);
  });

  test("prefers the longer annual duration when annual and interim facts share an end", () => {
    const annual = fact({ value: 12 });
    const interim = fact({
      value: 3,
      periodKey: "2024-10-01|2024-12-31",
      periodType: "interim",
      periodStart: "2024-10-01",
      filedAt: "2025-03-01",
    });

    expect(latestFinancialStatementFact([interim, annual])).toBe(annual);
  });

  test("treats instant facts as zero-duration in the total ordering", () => {
    const duration = fact({ value: 12, filedAt: "2025-02-01" });
    const instant = fact({
      value: 2,
      periodKey: "instant|2024-12-31",
      periodStart: null,
      filedAt: "2025-05-01",
    });

    expect(latestFinancialStatementFact([instant, duration])).toBe(duration);
  });

  test("requires matching unit scale for compatible facts", () => {
    expect(financialStatementFactsAreCompatible([fact(), fact({ unitScale: 1000 })])).toBe(false);
  });

  test("checks TTM period alignment separately from full compatibility", () => {
    const base = ttm();
    const differentUnit = ttm({ unit: "EUR" });
    const differentPeriod = ttm({ periodStart: "2024-07-01" });

    expect(financialStatementTtmsSharePeriod([base, differentUnit])).toBe(true);
    expect(financialStatementTtmsAreCompatible([base, differentUnit])).toBe(false);
    expect(financialStatementTtmsSharePeriod([base, differentPeriod])).toBe(false);
    expect(financialStatementTtmsAreCompatible([base, differentPeriod])).toBe(false);
  });

  test("looks up only the exact period key and applies amendment precedence within it", () => {
    const target = "2024-01-01|2024-12-31";
    const values = series("revenue", [
      fact({ periodKey: "2024-04-01|2024-12-31", value: 9 }),
      fact({ periodKey: target, value: 10 }),
      fact({ periodKey: target, value: 11, amendment: true }),
    ]);

    expect(
      financialStatementFactForPeriod([...values.annual, ...values.interim], target)?.value,
    ).toBe(11);
  });

  test("selects the latest exact common period with compatible units and currency", () => {
    const priorKey = "2023-01-01|2023-12-31";
    const latestKey = "2024-01-01|2024-12-31";
    const revenue = series("revenue", [
      fact({ periodKey: priorKey, periodEnd: "2023-12-31", periodStart: "2023-01-01", value: 8 }),
      fact({ periodKey: latestKey, value: 10 }),
    ]);
    const netIncome = series("netIncome", [
      fact({ periodKey: priorKey, periodEnd: "2023-12-31", periodStart: "2023-01-01", value: 2 }),
      fact({
        periodKey: "2024-04-01|2024-12-31",
        periodType: "interim",
        periodStart: "2024-04-01",
        value: 3,
      }),
      fact({ periodKey: latestKey, currency: "EUR", value: 4 }),
    ]);

    expect(
      latestCommonFinancialStatementFacts([revenue, netIncome])?.map((item) => item.value),
    ).toEqual([8, 2]);
  });

  test("handles empty and single-series common-period inputs", () => {
    const empty = series("revenue", []);
    const populated = series("netIncome", [
      fact({ periodKey: "2023-01-01|2023-12-31", periodEnd: "2023-12-31", value: 1 }),
      fact({ value: 2 }),
    ]);

    expect(latestCommonFinancialStatementFacts([])).toBeUndefined();
    expect(latestCommonFinancialStatementFacts([empty, populated])).toBeUndefined();
    expect(latestCommonFinancialStatementFacts([populated])?.map((item) => item.value)).toEqual([
      2,
    ]);
  });

  test("flattens and looks up artifact series through the shared authority", () => {
    const revenue = series("revenue", [fact()]);
    const artifact = {
      statements: {
        incomeStatement: { revenue },
        balanceSheet: {},
        cashFlowStatement: {},
        perShare: {},
      },
    } as unknown as FinancialStatementsArtifact;

    expect(financialStatementSeries(artifact)).toEqual([revenue]);
    expect(financialStatementSeriesByKey(artifact, "revenue")).toBe(revenue);
    expect(financialStatementSeriesByKey(artifact, "cash")).toBeUndefined();
  });
});
