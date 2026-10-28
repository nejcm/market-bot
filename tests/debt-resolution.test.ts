import { describe, expect, test } from "bun:test";
import {
  deriveFinancialStatements,
  financialStatementsDebtBasisGaps,
} from "../src/sources/extended-evidence/financial-statements";
import {
  financialStatementFacts,
  latestFinancialStatementFact,
} from "../src/sources/extended-evidence/financial-statement-selection";
import { summarizeSecFundamentals } from "../src/sources/extended-evidence/sec-edgar";
import { summaryLens } from "./support/financial-lens";
import { balanceSheetHistory, financialPosition } from "../src/report/equity-reader-statements";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import { addValuationEvidence } from "../src/sources/extended-evidence/valuation";
import { balanceSheetPeriodDivergence } from "../src/sources/extended-evidence/valuation-comps-support";
import { valuationPeriodInputs } from "../src/sources/extended-evidence/valuation-workbench-inputs";
import { marketSnapshot } from "./support/fixtures";
import type { ValuationFundamentalInput } from "../src/sources/extended-evidence/valuation-workbench-contract";
import { valuationMetricSection } from "../src/sources/extended-evidence/valuation-workbench-metrics";

const ANALYSIS_AS_OF = "2026-10-08T00:00:00.000Z";

function instant(
  value: number,
  periodEnd: string,
  filedAt: string,
  form = "10-Q",
  fiscalPeriod = "Q2",
): Record<string, unknown> {
  return {
    val: value,
    form,
    fy: Number(periodEnd.slice(0, 4)),
    fp: fiscalPeriod,
    filed: filedAt,
    end: periodEnd,
    accn: `${filedAt}-${form}`,
  };
}

function resolve(gaap: Readonly<Record<string, readonly Record<string, unknown>[]>>) {
  const revenue = {
    val: 100,
    form: "10-K",
    fy: 2025,
    fp: "FY",
    filed: "2026-02-15",
    start: "2025-01-01",
    end: "2025-12-31",
    accn: "revenue",
  };
  const companyFacts = {
    facts: {
      "us-gaap": Object.fromEntries(
        Object.entries({ Revenues: [revenue], ...gaap }).map(([concept, usd]) => [
          concept,
          { units: { USD: usd } },
        ]),
      ),
    },
  };
  const artifact = deriveFinancialStatements(companyFacts, {
    symbol: "TEST",
    generatedAt: ANALYSIS_AS_OF,
    analysisAsOf: ANALYSIS_AS_OF,
    sourceId: "extended-sec-edgar-test-fundamentals",
  });
  return {
    artifact,
    canonical: latestFinancialStatementFact(
      financialStatementFacts(artifact.statements.balanceSheet.debt),
    ),
    legacy: summarizeSecFundamentals(companyFacts, ANALYSIS_AS_OF),
  };
}

describe("debt resolution at the cash instant", () => {
  test("INSG: sums disjoint secured debt and line of credit over a stale total", () => {
    const at = (value: number, end = "2026-06-30") => instant(value, end, "2026-08-07");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(1_878_000)],
      SecuredLongTermDebt: [at(41_611_000, "2025-12-31"), at(50_291_000)],
      LongTermLineOfCredit: [at(0, "2025-12-31"), at(10_000_000)],
      LongTermDebt: [instant(152_625_000, "2019-12-31", "2020-03-10", "10-K", "FY")],
      ConvertibleDebtCurrent: [instant(0, "2025-12-31", "2026-03-10", "10-K", "FY")],
    });

    expect(canonical).toMatchObject({
      value: 60_291_000,
      periodEnd: "2026-06-30",
      concept: "LongTermLineOfCredit+SecuredLongTermDebt",
    });
    expect(legacy?.metrics.debt).toBe(60_291_000);
    expect(legacy?.metrics.debtPeriodEnd).toBe("2026-06-30");
    expect(legacy?.debtComposite?.incompleteReason).toBeUndefined();
  });

  test("RFIL: a current line of credit beats stale zero LTD", () => {
    const at = (value: number, end = "2026-07-31") =>
      instant(value, end, "2026-09-12", "10-Q", "Q3");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(4_454_000)],
      LinesOfCreditCurrent: [at(7_836_000, "2025-10-31"), at(5_718_000)],
      FinanceLeaseLiability: [at(0)],
      RepaymentsOfLinesOfCredit: [{ ...at(2_118_000), start: "2025-11-01" }],
      LongTermDebtCurrent: [instant(0, "2024-10-31", "2025-01-28", "10-K", "FY")],
      LongTermDebtNoncurrent: [instant(0, "2024-10-31", "2025-01-28", "10-K", "FY")],
    });

    expect(canonical).toMatchObject({
      value: 5_718_000,
      periodEnd: "2026-07-31",
      concept: "LinesOfCreditCurrent",
    });
    expect(legacy?.metrics.debt).toBe(5_718_000);
    expect(legacy?.metrics.debtPeriodEnd).toBe("2026-07-31");
  });

  test("ADTN: convertible notes plus the line-of-credit leg, never its umbrella too", () => {
    const at = (value: number, end = "2026-06-30") => instant(value, end, "2026-08-04");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(90_000_000)],
      LongTermDebt: [instant(24_600_000, "2019-12-31", "2020-02-28", "10-K", "FY")],
      LineOfCredit: [at(25_000_000, "2026-03-31"), at(25_000_000)],
      LongTermLineOfCredit: [at(25_000_000, "2026-03-31"), at(25_000_000)],
      ConvertibleLongTermNotesPayable: [at(193_425_000, "2026-03-31"), at(193_822_000)],
    });

    expect(canonical).toMatchObject({ value: 218_822_000, periodEnd: "2026-06-30" });
    expect(legacy?.metrics.debt).toBe(218_822_000);
    expect(legacy?.metrics.debtPeriodEnd).toBe("2026-06-30");
  });

  test("a lone LineOfCredit umbrella stands in for its untagged legs", () => {
    const at = (value: number, end = "2026-06-30") => instant(value, end, "2026-08-04");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(1000)],
      LineOfCredit: [at(40_000, "2026-03-31"), at(30_000)],
    });

    expect(canonical).toMatchObject({ value: 30_000, periodEnd: "2026-06-30" });
    expect(legacy?.metrics.debt).toBe(30_000);
  });

  test("a LineOfCredit umbrella that disagrees with its tagged legs is refused", () => {
    const at = (value: number, end = "2026-06-30") => instant(value, end, "2026-08-04");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(1000)],
      LineOfCredit: [at(50_000, "2026-03-31"), at(50_000)],
      LinesOfCreditCurrent: [at(10_000)],
    });

    expect(canonical).toMatchObject({ value: 50_000, periodEnd: "2026-03-31" });
    expect(legacy?.debtComposite?.incompleteReason).toContain("differs from the sum");
  });

  test("an umbrella equal to its legs up to float roundoff is not refused", () => {
    const at = (value: number) => instant(value, "2026-06-30", "2026-08-04");
    const { canonical } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(1000)],
      LineOfCredit: [at(300.3)],
      LinesOfCreditCurrent: [at(100.1)],
      LongTermLineOfCredit: [at(200.2)],
    });

    expect(canonical?.periodEnd).toBe("2026-06-30");
    expect(canonical?.value).toBeCloseTo(300.3);
  });

  test("a zero leg beside a nonzero LineOfCredit umbrella never publishes zero debt", () => {
    const at = (value: number) => instant(value, "2026-06-30", "2026-08-04");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(1000)],
      LineOfCredit: [instant(50, "2026-03-31", "2026-05-05"), at(50)],
      LinesOfCreditCurrent: [at(0)],
    });

    expect(canonical?.periodEnd).toBe("2026-03-31");
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.metrics.debtIncompletePeriodEnd).toBe("2026-06-30");
  });

  test("a LineOfCredit umbrella beside a generic side line is refused, never added", () => {
    const at = (value: number) => instant(value, "2026-06-30", "2026-08-04");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(1000)],
      LongTermDebtCurrent: [at(10)],
      LineOfCredit: [at(50)],
    });

    expect(canonical?.periodEnd).not.toBe("2026-06-30");
    expect(legacy?.debtComposite?.incompleteReason).toContain("LineOfCredit may overlap");
  });

  test("a generic current line alone does not cover a prior LineOfCredit umbrella", () => {
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [instant(1000, "2026-06-30", "2026-08-04")],
      LineOfCredit: [instant(50, "2026-03-31", "2026-05-05")],
      LongTermDebtCurrent: [instant(10, "2026-06-30", "2026-08-04")],
    });

    expect(canonical).toMatchObject({ value: 50, periodEnd: "2026-03-31" });
    expect(legacy?.debtComposite?.incompleteReason).toContain("omits LineOfCredit");
  });

  test("a selected LineOfCredit umbrella covers a prior current leg", () => {
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [instant(1000, "2026-06-30", "2026-08-04")],
      LinesOfCreditCurrent: [instant(10, "2026-03-31", "2026-05-05")],
      LineOfCredit: [instant(50, "2026-06-30", "2026-08-04")],
    });

    expect(canonical).toMatchObject({ value: 50, periodEnd: "2026-06-30" });
    expect(legacy?.metrics.debt).toBe(50);
  });

  test("Akamai: current and noncurrent convertible notes add; current aliases never do", () => {
    const at = (value: number, end = "2026-06-30") => instant(value, end, "2026-08-07");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(1000)],
      ConvertibleLongTermNotesPayable: [at(4_107_607_000, "2026-03-31"), at(5_857_252_000)],
      ConvertibleNotesPayableCurrent: [at(0, "2025-12-31"), at(1_705_576_000)],
      ConvertibleDebtCurrent: [at(1_705_576_000)],
    });

    expect(canonical).toMatchObject({ value: 7_562_828_000, periodEnd: "2026-06-30" });
    expect(legacy?.metrics.debt).toBe(7_562_828_000);
  });

  test("both convertible noncurrent tags are alternatives, not additive", () => {
    const at = (value: number) => instant(value, "2026-06-30", "2026-08-04");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(1000)],
      ConvertibleDebtNoncurrent: [at(500_000)],
      ConvertibleLongTermNotesPayable: [at(500_000)],
    });

    expect(canonical).toMatchObject({ value: 500_000, periodEnd: "2026-06-30" });
    expect(legacy?.metrics.debt).toBe(500_000);
  });

  test("OCC: counts the revolver and both term-loan legs, excluding finance leases", () => {
    const at = (value: number) => instant(value, "2026-07-31", "2026-09-10", "10-Q", "Q3");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(297_193)],
      NotesPayableCurrent: [at(6_329_173)],
      LoansPayableCurrent: [at(66_949)],
      LongTermLoansPayable: [at(2_572_866)],
      FinanceLeaseLiability: [at(211_382)],
      FinanceLeaseLiabilityCurrent: [at(65_504)],
      FinanceLeaseLiabilityNoncurrent: [at(145_878)],
      LongTermDebt: [instant(2_675_244, "2023-10-31", "2024-01-26", "10-K", "FY")],
      LongTermDebtCurrent: [instant(59_075, "2025-04-30", "2025-06-12")],
      LongTermDebtNoncurrent: [instant(2_540_622, "2025-04-30", "2025-06-12")],
    });

    expect(canonical).toMatchObject({ value: 8_968_988, periodEnd: "2026-07-31" });
    expect(legacy?.metrics.debt).toBe(8_968_988);
  });

  test("OCC-shaped partial set with an unrecognized borrowing concept stays incomplete", () => {
    const at = (value: number) => instant(value, "2026-07-31", "2026-09-10", "10-Q", "Q3");
    const { artifact, canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(297_193)],
      NotesPayableCurrent: [at(6_329_173)],
      OtherLongTermDebtNoncurrent: [at(2_572_866)],
      FinanceLeaseLiability: [at(211_382)],
      LongTermDebt: [instant(2_675_244, "2023-10-31", "2024-01-26", "10-K", "FY")],
    });

    expect(canonical).toMatchObject({ value: 2_675_244, periodEnd: "2023-10-31" });
    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({
        code: "incomplete-composite-series",
        message: expect.stringContaining("OtherLongTermDebtNoncurrent"),
      }),
    );
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.debtComposite).toMatchObject({
      periodEnd: "2026-07-31",
      incompleteReason: expect.stringContaining("OtherLongTermDebtNoncurrent"),
    });
  });

  test("a one-sided fresh set omitting a borrowing reported within the prior year stays incomplete", () => {
    const at = (value: number) => instant(value, "2026-07-31", "2026-09-10", "10-Q", "Q3");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(297_193)],
      NotesPayableCurrent: [at(6_329_173)],
      FinanceLeaseLiability: [at(211_382)],
      LongTermLoansPayable: [instant(2_570_793, "2025-10-31", "2026-01-28", "10-K", "FY")],
    });

    expect(canonical?.periodEnd).not.toBe("2026-07-31");
    expect(legacy?.metrics.debt).not.toBe(6_540_555);
    expect(legacy?.debtComposite?.incompleteReason).toContain("LongTermLoansPayable");
  });

  test("REGN: a lone generic noncurrent line is complete and excludes finance leases", () => {
    const at = (value: number, end = "2026-06-30") => instant(value, end, "2026-07-30");
    const yearEnd = (value: number) => instant(value, "2025-12-31", "2026-02-04", "10-K", "FY");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(2_000_000_000)],
      LongTermDebtNoncurrent: [yearEnd(1_985_900_000), at(1_986_600_000)],
      FinanceLeaseLiability: [yearEnd(720_000_000)],
      FinanceLeaseLiabilityCurrent: [at(720_000_000)],
      FinanceLeaseLiabilityNoncurrent: [yearEnd(720_000_000), at(0)],
    });

    expect(canonical).toMatchObject({ value: 1_986_600_000, periodEnd: "2026-06-30" });
    expect(legacy?.metrics.debt).toBe(1_986_600_000);
  });

  test("CLFD: no debt tagged at the cash instant keeps the older debt rather than inferring zero", () => {
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [instant(20_449_000, "2026-06-30", "2026-08-06")],
      LongTermDebtCurrent: [instant(2_358_000, "2025-06-30", "2025-08-28", "10-K", "FY")],
      LongTermDebtNoncurrent: [instant(0, "2025-06-30", "2025-08-28", "10-K", "FY")],
    });

    expect(canonical).toMatchObject({ value: 2_358_000, periodEnd: "2025-06-30" });
    expect(legacy?.metrics.debt).toBe(2_358_000);
    expect(balanceSheetPeriodDivergence(legacy?.metrics)).toMatchObject({
      cashPeriodEnd: "2026-06-30",
      debtPeriodEnd: "2025-06-30",
    });
  });

  test("RELL: stale finance leases alone never establish debt", () => {
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [
        instant(31_779_000, "2026-05-30", "2026-07-24", "10-K", "FY"),
      ],
      FinanceLeaseLiabilityCurrent: [instant(15_000, "2022-02-26", "2022-04-06", "10-Q", "Q3")],
      FinanceLeaseLiabilityNoncurrent: [instant(30_000, "2021-02-27", "2021-04-07", "10-Q", "Q3")],
    });

    expect(canonical).toBeUndefined();
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.debtComposite?.incompleteReason).toBe("no borrowing line item is tagged");
  });

  test("never sums a total with its constituents or two aliases of one line item", () => {
    const at = (value: number) => instant(value, "2026-06-30", "2026-08-06");
    expect(
      resolve({
        LongTermDebt: [at(100)],
        LongTermDebtCurrent: [at(10)],
        LongTermDebtNoncurrent: [at(90)],
        LinesOfCreditCurrent: [at(0)],
      }).canonical,
    ).toMatchObject({ value: 100, concept: "LongTermDebt" });
    expect(
      resolve({
        LongTermDebtCurrent: [at(10)],
        DebtCurrent: [at(15)],
        LongTermDebtNoncurrent: [at(90)],
        LongTermNotesPayable: [at(90)],
        FinanceLeaseLiabilityCurrent: [at(1)],
        FinanceLeaseLiabilityNoncurrent: [at(2)],
      }).canonical,
    ).toMatchObject({
      value: 104,
      concept: "DebtCurrent+LongTermDebtNoncurrent-FinanceLeaseLiabilityCurrent",
    });
    expect(
      resolve({
        ShortTermBorrowings: [at(7)],
        ShortTermDebt: [at(7)],
        LongTermLoansPayable: [at(3)],
      }).canonical,
    ).toMatchObject({ value: 10 });
  });

  test("commercial paper is a constituent of short-term borrowings, never added to it", () => {
    const at = (value: number) => instant(value, "2026-06-30", "2026-08-06");
    expect(
      resolve({
        ShortTermBorrowings: [at(100)],
        CommercialPaper: [at(80)],
        LongTermNotesPayable: [at(200)],
      }).canonical,
    ).toMatchObject({ value: 300, concept: "ShortTermBorrowings+LongTermNotesPayable" });
  });

  test("explicit tagged zeros at the cash instant count as zero debt", () => {
    const at = (value: number) => instant(value, "2026-06-30", "2026-08-06");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(5)],
      LinesOfCreditCurrent: [at(0)],
      LongTermLineOfCredit: [at(0)],
    });

    expect(canonical).toMatchObject({ value: 0, periodEnd: "2026-06-30" });
    expect(legacy?.metrics.debt).toBe(0);
  });
});

describe("debt resolution refuses incomplete component sets", () => {
  const original = (value: number) => instant(value, "2026-06-30", "2026-08-06");
  const amended = (value: number) => instant(value, "2026-06-30", "2026-09-01", "10-Q/A");
  const priorQuarter = (value: number) => instant(value, "2026-03-31", "2026-05-06", "10-Q", "Q1");
  const expectRefused = (gaap: Parameters<typeof resolve>[0], reason: string) => {
    const { artifact, canonical, legacy } = resolve(gaap);
    expect(canonical).toBeUndefined();
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.debtComposite?.incompleteReason).toContain(reason);
    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({
        code: "incomplete-composite-series",
        message: expect.stringContaining(reason),
      }),
    );
  };

  test("a partial instrument amendment cannot drop a leg of the original filing", () => {
    expectRefused(
      {
        NotesPayableCurrent: [original(30), amended(40)],
        LongTermNotesPayable: [original(70)],
      },
      "omits LongTermNotesPayable",
    );
  });

  test("a later filing that restates a component the original reported cannot be summed without a total", () => {
    const later = (value: number) => instant(value, "2026-06-30", "2026-08-20");
    expectRefused(
      {
        ConvertibleNotesPayableCurrent: [original(353), later(353)],
        ConvertibleLongTermNotesPayable: [original(0), later(353)],
      },
      "a later filing restated ConvertibleLongTermNotesPayable (originally 0, filed 2026-08-06)",
    );
  });

  test("a later filing that reclassifies components without changing their total keeps the sum", () => {
    const later = (value: number) => instant(value, "2026-06-30", "2026-08-20");
    const { canonical, legacy } = resolve({
      LongTermDebtCurrent: [original(10), later(15)],
      LongTermDebtNoncurrent: [original(90), later(85)],
    });

    expect(canonical).toMatchObject({ value: 100, periodEnd: "2026-06-30" });
    expect(legacy?.metrics.debt).toBe(100);
  });

  test("offsetting restatements from different filings cannot be summed", () => {
    const later = (value: number) => instant(value, "2026-06-30", "2026-08-20");
    const latest = (value: number) => instant(value, "2026-06-30", "2026-09-10");
    expectRefused(
      {
        LongTermDebtCurrent: [original(10), later(25), latest(15)],
        LongTermDebtNoncurrent: [original(90), later(85)],
      },
      "a later filing restated LongTermDebtCurrent",
    );
  });

  test("an amendment tagging only an unrecognized concept supersedes the original", () => {
    expectRefused(
      {
        LongTermDebtCurrent: [original(10)],
        LongTermDebtNoncurrent: [original(90)],
        OtherLongTermDebtNoncurrent: [amended(95)],
      },
      "unrecognized borrowing concepts are tagged: OtherLongTermDebtNoncurrent",
    );
  });

  test("a two-sided set still covers a borrowing reported the prior quarter", () => {
    const { canonical, legacy } = resolve({
      NotesPayableCurrent: [original(100)],
      SecuredLongTermDebt: [original(200)],
      LongTermLoansPayable: [priorQuarter(50)],
    });
    expect(canonical?.periodEnd).not.toBe("2026-06-30");
    expect(legacy?.metrics.debt).not.toBe(300);
    expect(legacy?.debtComposite?.incompleteReason).toContain("omits LongTermLoansPayable");
  });

  test("an unrecognized borrowing reported the prior quarter must still be tagged", () => {
    expectRefused(
      {
        NotesPayableCurrent: [original(100)],
        OtherLongTermDebtNoncurrent: [priorQuarter(50)],
      },
      "omits OtherLongTermDebtNoncurrent",
    );
  });

  test("a lease-inclusive side loses its own tagged lease leg, else the basis is disclosed", () => {
    const adjusted = resolve({
      LongTermDebtAndCapitalLeaseObligationsCurrent: [original(11)],
      FinanceLeaseLiabilityCurrent: [original(1)],
      LongTermDebtNoncurrent: [original(90)],
      FinanceLeaseLiabilityNoncurrent: [original(9)],
    });
    expect(adjusted.canonical).toMatchObject({
      value: 100,
      concept:
        "LongTermDebtAndCapitalLeaseObligationsCurrent+LongTermDebtNoncurrent-FinanceLeaseLiabilityCurrent",
    });
    expect(adjusted.legacy?.metrics.debt).toBe(100);
    expect(
      adjusted.legacy?.gaps.some((gap) => gap.message.includes("may include finance leases")),
    ).toBe(false);

    const unadjusted = resolve({
      LongTermDebtAndCapitalLeaseObligationsCurrent: [original(11)],
      LongTermDebtNoncurrent: [original(90)],
      FinanceLeaseLiabilityNoncurrent: [original(9)],
    });
    expect(unadjusted.canonical).toMatchObject({ value: 101 });
    expect(unadjusted.legacy?.gaps).toContainEqual(
      expect.objectContaining({
        evidenceQualityImpact: "no-cap",
        message: expect.stringContaining(
          "may include finance leases: LongTermDebtAndCapitalLeaseObligationsCurrent",
        ),
      }),
    );
    expect(financialStatementsDebtBasisGaps(unadjusted.artifact)).toEqual([
      expect.objectContaining({
        message: unadjusted.legacy?.gaps.find((gap) => gap.message.includes("finance leases"))
          ?.message,
      }),
    ]);
  });

  test("a lease-inclusive total loses the finance-lease total tagged beside it", () => {
    expect(
      resolve({
        LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [original(6_570_503_000)],
        FinanceLeaseLiability: [original(142_678_000)],
      }).canonical,
    ).toMatchObject({
      value: 6_427_825_000,
      concept:
        "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities-FinanceLeaseLiability",
    });
  });

  test("a lease-inclusive aggregate is a total alternative, not an extra constituent", () => {
    expect(
      resolve({
        LongTermDebtAndCapitalLeaseObligationsCurrent: [original(1_634_300_000)],
        LongTermDebtAndCapitalLeaseObligations: [original(17_177_000_000)],
        LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [
          original(18_811_300_000),
        ],
        LongTermDebtAndCapitalLeaseObligationsMaturitiesRepaymentsOfPrincipalInYearTwo: [
          original(5),
        ],
      }).canonical,
    ).toMatchObject({ value: 18_811_300_000, periodEnd: "2026-06-30" });
    const priorYearEnd = (value: number) =>
      instant(value, "2025-12-31", "2026-02-12", "10-K", "FY");
    expect(
      resolve({
        DebtCurrent: [original(668_000_000)],
        LongTermDebtAndCapitalLeaseObligations: [original(7_756_000_000)],
        LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [
          priorYearEnd(8_425_000_000),
        ],
        DebtAndCapitalLeaseObligations: [priorYearEnd(8_425_000_000)],
        FinanceLeaseLiabilityCurrent: [priorYearEnd(84_000_000)],
        FinanceLeaseLiabilityNoncurrent: [priorYearEnd(149_000_000)],
        OtherLongTermDebt: [priorYearEnd(339_000_000)],
      }).canonical,
    ).toMatchObject({ value: 8_424_000_000, periodEnd: "2026-06-30" });
  });

  test("DebtCurrent loses its current finance-lease leg", () => {
    expect(
      resolve({
        DebtCurrent: [original(11)],
        LongTermDebtNoncurrent: [original(90)],
        FinanceLeaseLiabilityCurrent: [original(1)],
        FinanceLeaseLiabilityNoncurrent: [original(9)],
      }).canonical,
    ).toMatchObject({ value: 100 });
  });

  test("an unrecognized borrowing tagged at the instant refuses even two generic sides", () => {
    expectRefused(
      {
        LongTermDebtCurrent: [original(4_050_000)],
        LongTermDebtNoncurrent: [original(104_193_000)],
        SubordinatedDebt: [original(106_879_000)],
      },
      "unrecognized borrowing concepts are tagged: SubordinatedDebt",
    );
  });

  test("an unmapped lease-inclusive debt concept refuses the component sum", () => {
    expectRefused(
      {
        LongTermDebtAndFinanceLeaseObligationsCurrent: [original(40)],
        LongTermNotesPayable: [original(70)],
      },
      "LongTermDebtAndFinanceLeaseObligationsCurrent",
    );
  });
});

describe("older complete debt never stands in for a newer incomplete instant", () => {
  const q3 = (value: number) => instant(value, "2025-09-30", "2025-11-05", "10-Q", "Q3");
  const fy = (value: number) => instant(value, "2025-12-31", "2026-02-15", "10-K", "FY");
  const gaap = {
    CashAndCashEquivalentsAtCarryingValue: [fy(20)],
    NotesPayableCurrent: [q3(30), fy(40)],
    LongTermNotesPayable: [q3(70)],
  };

  test.each(["legacy", "canonical"] as const)(
    "%s path publishes no older debt and a dated Source Gap",
    (path) => {
      const { artifact, legacy } = resolve(gaap);
      const item =
        path === "legacy"
          ? { metrics: legacy?.metrics, summary: legacy?.summary }
          : withCanonicalFinancialLensInputs(secEvidenceFrom(legacy?.metrics), artifact).items[0];
      expect(item?.metrics?.debt).toBeUndefined();
      expect(item?.metrics?.debtPeriodEnd).toBeUndefined();
      expect(item?.metrics?.debtIncompletePeriodEnd).toBe("2025-12-31");
      expect(item?.summary).not.toMatch(/debt/u);
      const gaps =
        path === "legacy" ? (legacy?.gaps ?? []) : financialStatementsDebtBasisGaps(artifact);
      expect(gaps).toContainEqual(
        expect.objectContaining({
          message: expect.stringMatching(
            /^SEC debt withheld: the newest debt instant 2025-12-31 is incomplete \(omits LongTermNotesPayable/u,
          ),
        }),
      );
      const position = financialPosition(artifact, ANALYSIS_AS_OF);
      expect(position?.debt).toBeUndefined();
      expect(position?.cash?.value).toBe(20);
      expect(position?.notes?.map((note) => note.periodKey)).toContain("instant|2025-12-31");
      expect(
        balanceSheetHistory(artifact, ANALYSIS_AS_OF)?.rows.find((row) =>
          row.period.includes("2025-09-30"),
        )?.debt?.value,
      ).toBe(100);
    },
  );

  test("target valuation withholds EV and declares a Source Gap", () => {
    const { legacy } = resolve(gaap);
    const result = addValuationEvidence(
      { jobType: "equity", assetClass: "equity", symbol: "TEST", depth: "deep" },
      [marketSnapshot({ symbol: "TEST", marketCap: 100 })],
      {
        instrument: { symbol: "TEST", assetClass: "equity" },
        items: [
          {
            category: "sec-edgar",
            title: "TEST SEC Fundamental Evidence",
            summary: "SEC Fundamental Evidence.",
            sourceIds: ["sec"],
            observedAt: "2026-03-01T00:00:00.000Z",
            metrics: legacy?.metrics ?? {},
          },
        ],
        gaps: [],
      },
      "2026-02-20T00:00:00.000Z",
    );
    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");

    expect(valuation?.metrics?.marketCap).toBe(100);
    expect(valuation?.metrics?.debt).toBeUndefined();
    expect(valuation?.metrics?.netDebt).toBeUndefined();
    expect(valuation?.metrics?.enterpriseValue).toBeUndefined();
    expect(valuation?.metrics?.evToAnnualizedRevenue).toBeUndefined();
    expect(valuation?.metrics?.debtToMarketCap).toBeUndefined();
    expect(result.sourceGaps).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Incomplete SEC debt for TEST: debt at 2025-12-31"),
      }),
    );
  });

  test.each(["legacy", "canonical"] as const)(
    "%s lens ratios never use the older debt as current",
    (path) => {
      const { artifact, legacy } = resolve({
        ...gaap,
        StockholdersEquity: [q3(500), fy(500)],
        CashAndCashEquivalentsAtCarryingValue: [q3(10), fy(20)],
      });
      const lens = summaryLens(
        secEvidenceFrom(legacy?.metrics).items[0],
        "Financial Strength",
        "2026-02-20T00:00:00.000Z",
        path === "canonical" ? artifact : undefined,
      );
      const published = lens.metrics.filter((metric) =>
        ["netDebt", "debtToEquity", "netDebtToMarketCap", "debtToMarketCap"].includes(metric.key),
      );
      expect(published.map((metric) => metric.key)).toEqual([]);
      expect(lens.metrics.find((metric) => metric.key === "debt")).toBeUndefined();
    },
  );

  test("an incomplete total-basis instant withholds the older legacy debt", () => {
    const { legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [fy(20)],
      LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [q3(100), fy(110)],
      LongTermDebtAndCapitalLeaseObligationsCurrent: [fy(10)],
      LongTermDebtAndCapitalLeaseObligations: [fy(100)],
      LinesOfCreditCurrent: [fy(5)],
    });
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.metrics.debtIncompletePeriodEnd).toBe("2025-12-31");
  });

  test("the canonical replacement keeps the incomplete-debt metadata for valuation", () => {
    const { artifact, legacy } = resolve(gaap);
    const replaced = withCanonicalFinancialLensInputs(
      {
        instrument: { symbol: "TEST", assetClass: "equity" },
        items: [
          {
            category: "sec-edgar",
            title: "TEST SEC Fundamental Evidence",
            summary: "SEC Fundamental Evidence.",
            sourceIds: ["sec"],
            observedAt: "2026-03-01T00:00:00.000Z",
            metrics: legacy?.metrics ?? {},
          },
        ],
        gaps: [],
      },
      artifact,
    );
    const result = addValuationEvidence(
      { jobType: "equity", assetClass: "equity", symbol: "TEST", depth: "deep" },
      [marketSnapshot({ symbol: "TEST", marketCap: 100 })],
      replaced,
      "2026-08-15T00:00:00.000Z",
    );
    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");

    expect(valuation?.metrics?.enterpriseValue).toBeUndefined();
    expect(result.sourceGaps).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "debt at 2025-12-31 is incomplete (omits LongTermNotesPayable",
        ),
      }),
    );
  });

  test("the Workbench ignores an incomplete filing published after the observation", () => {
    const { artifact } = resolve({
      ...gaap,
      NotesPayableCurrent: [q3(30), instant(40, "2025-12-31", "2026-04-15", "10-K/A", "FY")],
    });
    expect(valuationPeriodInputs(artifact).periods.at(-1)?.debt).toMatchObject({
      value: 100,
      periodEnd: "2025-09-30",
    });
  });

  test("the Workbench drops debt for the observation", () => {
    const { artifact } = resolve(gaap);
    const period = valuationPeriodInputs(artifact).periods.at(-1);
    expect(period?.cash?.periodEnd).toBe("2025-12-31");
    expect(period?.debt).toBeUndefined();
  });
});

function secEvidenceFrom(metrics: Readonly<Record<string, number | string>> | undefined) {
  return {
    instrument: { symbol: "TEST", assetClass: "equity" as const },
    items: [
      {
        category: "sec-edgar" as const,
        title: "TEST SEC Fundamental Evidence",
        summary: "SEC Fundamental Evidence.",
        sourceIds: ["sec"],
        observedAt: "2026-08-10T00:00:00.000Z",
        metrics: metrics ?? {},
      },
    ],
    gaps: [],
  };
}

function valuationItemFor(evidence: ReturnType<typeof secEvidenceFrom>) {
  return addValuationEvidence(
    { jobType: "equity", assetClass: "equity", symbol: "TEST", depth: "deep" },
    [marketSnapshot({ symbol: "TEST", marketCap: 100 })],
    evidence,
    "2026-08-15T00:00:00.000Z",
  ).extendedEvidence?.items.find((item) => item.category === "valuation");
}

describe("lease deductions and debt-scope disclosure", () => {
  const at = (value: number) => instant(value, "2026-06-30", "2026-08-06");

  test("a lease deduction larger than its aggregate is refused even beside a positive component", () => {
    const { canonical, legacy } = resolve({
      DebtCurrent: [at(10)],
      FinanceLeaseLiabilityCurrent: [at(20)],
      LongTermDebtNoncurrent: [at(90)],
    });
    expect(canonical).toBeUndefined();
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.debtComposite?.incompleteReason).toBe(
      "finance-lease deduction FinanceLeaseLiabilityCurrent exceeds DebtCurrent",
    );
    expect(
      resolve({
        LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [at(10)],
        FinanceLeaseLiability: [at(20)],
      }).canonical,
    ).toBeUndefined();
  });

  test("an unmatched lease-inclusive aggregate changes the disclosure instead of contradicting it", () => {
    const { artifact, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(5)],
      DebtCurrent: [at(11)],
      LongTermDebtNoncurrent: [at(90)],
    });
    for (const evidence of [
      secEvidenceFrom(legacy?.metrics),
      withCanonicalFinancialLensInputs(secEvidenceFrom(legacy?.metrics), artifact),
    ]) {
      const summary = valuationItemFor(evidence as ReturnType<typeof secEvidenceFrom>)?.summary;
      expect(summary).toContain("may include finance leases");
      expect(summary).not.toContain("excludes finance leases");
    }
  });
});

describe("newer valid debt is not withheld by an older incomplete instant", () => {
  test("a calibrated gross-principal June fact outranks an incomplete March note", () => {
    const fy = (value: number) => instant(value, "2025-12-31", "2026-02-15", "10-K", "FY");
    const march = (value: number) => instant(value, "2026-03-31", "2026-05-06", "10-Q", "Q1");
    const june = (value: number) => instant(value, "2026-06-30", "2026-08-06");
    const { artifact, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [june(20)],
      LongTermDebtCurrent: [fy(10), march(15)],
      LongTermDebtNoncurrent: [fy(190)],
      DebtInstrumentCarryingAmount: [fy(200), june(200)],
    });
    const replaced = withCanonicalFinancialLensInputs(secEvidenceFrom(legacy?.metrics), artifact);
    const sec = replaced.items.find((item) => item.category === "sec-edgar");

    expect(sec?.metrics).toMatchObject({ debt: 200, debtPeriodEnd: "2026-06-30" });
    expect(sec?.metrics?.debtIncompletePeriodEnd).toBeUndefined();
    expect(
      valuationItemFor(replaced as ReturnType<typeof secEvidenceFrom>)?.metrics?.enterpriseValue,
    ).toBe(280);
  });
});

function fundamental(value: number, periodEnd: string): ValuationFundamentalInput {
  return {
    value,
    label: "input",
    periodEnd,
    publicAt: "2026-08-06",
    currency: "USD",
    unit: "USD",
    sourceIds: ["sec"],
  };
}

function evToRevenue(debtPeriodEnd: string) {
  return valuationMetricSection({
    symbol: "TEST",
    period: {
      basis: "ttm",
      periodEnd: "2026-06-30",
      revenue: fundamental(100, "2026-06-30"),
      dilutedShares: { ...fundamental(10, "2026-06-30"), unit: "shares", currency: null },
      cash: fundamental(20, "2026-06-30"),
      debt: fundamental(30, debtPeriodEnd),
    },
    price: { close: 10, sessionDate: "2026-08-07", currency: "USD", sourceId: "quote" },
    reportingCurrency: "USD",
    quoteCurrency: "USD",
  }).section.metrics.find(({ id }) => id === "enterpriseValueToRevenue");
}

describe("valuation workbench balance-sheet period gate", () => {
  test("populates EV/revenue when cash and debt are 92 days apart", () => {
    expect(evToRevenue("2026-03-30")).toMatchObject({ status: "value", value: 1.1 });
  });

  test("suppresses EV/revenue with a declared reason at 93 days apart", () => {
    expect(evToRevenue("2026-03-29")).toMatchObject({
      status: "missing",
      reason: "mixed-period-balance-sheet",
    });
  });
});

describe("SEC fundamentals prose withholds older debt behind a newer incomplete instant", () => {
  const fy = (value: number) => instant(value, "2025-12-31", "2026-02-13", "10-K", "FY");

  test("VRTX shape: finance leases only at the newest instant, a borrowing tag last in 2014", () => {
    const { legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [fy(6_143_500_000)],
      LongTermDebt: [instant(33_500_000, "2014-06-30", "2014-08-01")],
      FinanceLeaseLiabilityCurrent: [fy(80_000_000)],
      FinanceLeaseLiabilityNoncurrent: [fy(400_000_000)],
    });

    expect(legacy?.metrics).toMatchObject({ debtIncompletePeriodEnd: "2025-12-31" });
    expect(legacy?.summary).not.toContain("33500000");
    expect(legacy?.gaps).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("SEC debt withheld: the newest debt instant 2025-12-31"),
      }),
    );
    const lensDebt = summaryLens(
      secEvidenceFrom(legacy?.metrics).items[0],
      "Financial Strength",
      ANALYSIS_AS_OF,
    ).metrics.find((metric) => metric.key === "debt");
    expect(lensDebt).toBeUndefined();
  });

  test("a resolvable newest instant still renders its debt", () => {
    const { legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [fy(20)],
      LongTermDebt: [fy(100)],
    });

    expect(legacy?.metrics.debtIncompletePeriodEnd).toBeUndefined();
    expect(legacy?.summary).toContain("debt 100");
    expect(
      summaryLens(
        secEvidenceFrom(legacy?.metrics).items[0],
        "Financial Strength",
        "2026-02-20T00:00:00.000Z",
      ).metrics.find((metric) => metric.key === "debt")?.label,
    ).toBe("Debt");
  });
});

describe("ambiguous LongTermDebt", () => {
  const at = (value: number) => instant(value, "2026-06-30", "2026-08-06");
  const prior = (value: number) => instant(value, "2026-03-31", "2026-05-06", "10-Q", "Q1");
  const filed = (
    value: number,
    periodEnd: string,
    filedAt: string,
    accn: string,
    form = "10-Q",
  ) => ({
    ...instant(value, periodEnd, filedAt, form, form === "10-K" ? "FY" : "Q3"),
    accn,
  });
  const resolveAt = (gaap: Parameters<typeof resolve>[0], periodEnd: string) =>
    financialStatementFacts(resolve(gaap).artifact.statements.balanceSheet.debt).find(
      (fact) => fact.periodEnd === periodEnd,
    );
  const expectGap = (
    gaap: Parameters<typeof resolve>[0],
    reason: string,
    periodEnd = "2026-06-30",
  ) => {
    const { artifact, canonical } = resolve(gaap);
    expect(canonical?.periodEnd).not.toBe(periodEnd);
    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({
        code: "incomplete-composite-series",
        periodKey: `instant|${periodEnd}`,
        message: expect.stringContaining(reason),
      }),
    );
  };

  test("QCOM: the 2026-06-28 10-Q (0000804328-26-000086) cannot show whether LongTermDebt includes maturities", () => {
    const fy2024 = (value: number) =>
      filed(value, "2024-09-29", "2024-11-06", "0000804328-24-000075", "10-K");
    const june = (value: number) =>
      filed(value, "2026-06-28", "2026-07-29", "0000804328-26-000086");
    expectGap(
      {
        CashAndCashEquivalentsAtCarryingValue: [june(4_533_000_000)],
        LongTermDebt: [fy2024(13_270_000_000), june(12_781_000_000)],
        LongTermDebtCurrent: [fy2024(1_364_000_000), june(1_991_000_000)],
        LongTermDebtNoncurrent: [fy2024(13_270_000_000)],
        DebtCurrent: [june(2_489_000_000)],
        CommercialPaper: [june(498_000_000)],
      },
      "without a noncurrent line or total that establishes whether it includes current maturities",
      "2026-06-28",
    );
  });

  // NOW 2026-06-30 10-Q (0001373715-26-000076): 6,997M noncurrent liabilities foot with LongTermDebt as the noncurrent line.
  test("NOW: a closed noncurrent liabilities identity publishes 5,435M + 2,082M = 7,517M at 2026-06-30", () => {
    const june = (value: number) =>
      filed(value, "2026-06-30", "2026-07-23", "0001373715-26-000076");
    const { canonical, legacy } = resolve({
      LongTermDebt: [june(5_435_000_000)],
      ShortTermBorrowings: [june(2_082_000_000)],
      Liabilities: [june(17_000_000_000)],
      LiabilitiesCurrent: [june(10_003_000_000)],
      ContractWithCustomerLiabilityNoncurrent: [june(135_000_000)],
      OperatingLeaseLiabilityNoncurrent: [june(822_000_000)],
      OtherLiabilitiesNoncurrent: [june(605_000_000)],
    });
    expect(canonical).toMatchObject({ value: 7_517_000_000, periodEnd: "2026-06-30" });
    expect(legacy?.metrics.debt).toBe(7_517_000_000);
  });

  describe("ADBE noncurrent liabilities identity (2026-08-28 10-Q 0000796343-26-000156)", () => {
    const august = (value: number) =>
      filed(value, "2026-08-28", "2026-09-22", "0000796343-26-000156");
    const adbe = {
      DebtCurrent: [august(1_597_000_000)],
      LongTermDebt: [august(4_766_000_000)],
      Liabilities: [august(18_217_000_000)],
      LiabilitiesCurrent: [august(11_888_000_000)],
      AccruedIncomeTaxesNoncurrent: [august(567_000_000)],
      ContractWithCustomerLiabilityNoncurrent: [august(110_000_000)],
      OperatingLeaseLiabilityNoncurrent: [august(310_000_000)],
      OtherLiabilitiesNoncurrent: [august(576_000_000)],
    };
    const scopeReason = "LongTermDebt is tagged beside nonzero current debt (DebtCurrent)";

    test("publishes 1,597M current + 4,766M LongTermDebt = 6,363M", () => {
      const { canonical, legacy } = resolve(adbe);
      expect(canonical).toMatchObject({ value: 6_363_000_000, periodEnd: "2026-08-28" });
      expect(legacy?.metrics.debt).toBe(6_363_000_000);
      expect(legacy?.metrics.debtPeriodEnd).toBe("2026-08-28");
    });

    test("prefers a tagged LiabilitiesNoncurrent over the subtraction", () => {
      expect(
        resolve({ ...adbe, LiabilitiesNoncurrent: [august(6_329_000_000)], Liabilities: [] })
          .canonical?.value,
      ).toBe(6_363_000_000);
      expectGap(
        { ...adbe, LiabilitiesNoncurrent: [august(6_330_000_000)] },
        scopeReason,
        "2026-08-28",
      );
    });

    test("withholds when the identity is off by 1M", () => {
      expectGap(
        { ...adbe, OtherLiabilitiesNoncurrent: [august(575_000_000)] },
        scopeReason,
        "2026-08-28",
      );
    });

    test("withholds without a liabilities total", () => {
      expectGap({ ...adbe, Liabilities: [] }, scopeReason, "2026-08-28");
    });

    test("withholds when the totals come from another filing", () => {
      const other = (value: number) =>
        filed(value, "2026-08-28", "2026-12-20", "0000796343-26-000200", "10-K");
      expectGap(
        {
          ...adbe,
          Liabilities: [other(18_217_000_000)],
          LiabilitiesCurrent: [other(11_888_000_000)],
        },
        scopeReason,
        "2026-08-28",
      );
    });

    test("withholds when the totals sit at another instant", () => {
      const may = (value: number) =>
        filed(value, "2026-05-29", "2026-09-22", "0000796343-26-000156");
      expectGap(
        { ...adbe, Liabilities: [may(18_217_000_000)], LiabilitiesCurrent: [may(11_888_000_000)] },
        scopeReason,
        "2026-08-28",
      );
    });

    test("ignores an asset-side noncurrent tag outside the allowlist", () => {
      expect(
        resolve({ ...adbe, CapitalizedContractCostNetNoncurrent: [august(815_000_000)] }).canonical
          ?.value,
      ).toBe(6_363_000_000);
    });

    test("a zero LongTermDebt never closes the identity", () => {
      expectGap(
        {
          ...adbe,
          LongTermDebt: [august(0)],
          Liabilities: [august(13_451_000_000)],
        },
        "LongTermDebt is tagged beside nonzero current debt",
        "2026-08-28",
      );
    });
  });

  test("UBER: the 2026-06-30 10-Q LongTermDebt already includes 1,997M short-term borrowings, so sparse tags stay withheld", () => {
    const june = (value: number) =>
      filed(value, "2026-06-30", "2026-08-05", "0001543151-26-000032", "10-Q");
    expectGap(
      { LongTermDebt: [june(12_723_000_000)], ShortTermBorrowings: [june(1_997_000_000)] },
      "LongTermDebt is tagged beside nonzero current debt (ShortTermBorrowings)",
      "2026-06-30",
    );
  });

  // AMAT FY2019 10-K (0000006951-19-000046): ShortTermBorrowings 600M is the same notes as LongTermDebtCurrent.
  test("AMAT: FY2019 short-term borrowings overlap LongTermDebt 5,313M, so neither tag set yields 5,913M", () => {
    const fy2019 = (value: number) =>
      filed(value, "2019-10-27", "2019-12-13", "0000006951-19-000046", "10-K");
    const longTermDebt = [fy2019(5_313_000_000)];
    const shortTermBorrowings = [fy2019(600_000_000)];

    expectGap(
      {
        LongTermDebt: longTermDebt,
        LongTermDebtCurrent: [fy2019(600_000_000)],
        LongTermDebtNoncurrent: [fy2019(4_713_000_000)],
        ShortTermBorrowings: shortTermBorrowings,
      },
      "ShortTermBorrowings tagged beside LongTermDebtCurrent",
      "2019-10-27",
    );
    expectGap(
      { LongTermDebt: longTermDebt, ShortTermBorrowings: shortTermBorrowings },
      "LongTermDebt is tagged beside nonzero current debt (ShortTermBorrowings)",
      "2019-10-27",
    );
  });

  test("ADBE: DebtCurrent can hold LongTermDebt's own maturities, so 2026-08-28 stays withheld", () => {
    const august = (value: number) => filed(value, "2026-08-28", "2026-09-22", "adbe-2026-q3");
    expectGap(
      { LongTermDebt: [august(4_766_000_000)], DebtCurrent: [august(1_597_000_000)] },
      "LongTermDebt is tagged beside nonzero current debt (DebtCurrent)",
      "2026-08-28",
    );
  });

  test("commercial paper alone may be classified long-term, so it does not prove LongTermDebt's scope", () => {
    expectGap(
      { LongTermDebt: [at(500)], CommercialPaper: [at(100)] },
      "LongTermDebt is tagged beside nonzero current debt (CommercialPaper)",
    );
  });

  test("AMD: the FY2021 10-K (0000002488-22-000016) reports 313M combined debt, not the 1M LongTermDebt", () => {
    const fy2021 = (value: number) =>
      filed(value, "2021-12-25", "2022-02-03", "0000002488-22-000016", "10-K");
    const { artifact } = resolve({
      LongTermDebt: [fy2021(1_000_000)],
      LongTermDebtNoncurrent: [fy2021(1_000_000)],
      ShortTermBorrowings: [fy2021(312_000_000)],
      DebtLongtermAndShorttermCombinedAmount: [fy2021(313_000_000)],
    });

    expect(financialStatementFacts(artifact.statements.balanceSheet.debt)).toContainEqual(
      expect.objectContaining({
        value: 313_000_000,
        periodEnd: "2021-12-25",
        concept: "DebtLongtermAndShorttermCombinedAmount",
      }),
    );
  });

  test("PYPL: noncurrent debt beside untagged principal due within a year stays out of history and EV", () => {
    const fy = (value: number) =>
      filed(value, "2025-12-31", "2026-02-04", "0001633917-26-000010", "10-K");
    const { artifact, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [fy(7_000_000_000)],
      LongTermDebtNoncurrent: [fy(9_987_000_000)],
      LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: [fy(1_397_000_000)],
    });
    expect(financialStatementFacts(artifact.statements.balanceSheet.debt)).toEqual([]);
    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({
        periodKey: "instant|2025-12-31",
        message: expect.stringContaining("no current debt line is tagged"),
      }),
    );
    const history = balanceSheetHistory(artifact, ANALYSIS_AS_OF)?.rows ?? [];
    expect(history.filter((row) => row.debt !== undefined)).toEqual([]);
    expect(
      valuationPeriodInputs(artifact).periods.filter((period) => period.debt !== undefined),
    ).toEqual([]);
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.metrics.debtIncompletePeriodEnd).toBe("2025-12-31");
  });

  test("PYPL: gross principal never fills an instant with untagged principal due within a year", () => {
    const fy2020 = (value: number) =>
      filed(value, "2020-12-31", "2021-02-04", "0001633917-21-000010", "10-K");
    const fy2025 = (value: number) =>
      filed(value, "2025-12-31", "2026-02-04", "0001633917-26-000010", "10-K");
    const { artifact, canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [fy2020(4_000_000_000), fy2025(7_000_000_000)],
      LongTermDebtCurrent: [fy2020(0)],
      LongTermDebtNoncurrent: [fy2020(9_000_000_000), fy2025(9_987_000_000)],
      LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: [fy2025(1_397_000_000)],
      DebtInstrumentCarryingAmount: [fy2020(9_000_000_000), fy2025(11_459_000_000)],
    });
    expect(canonical?.periodEnd).not.toBe("2025-12-31");
    expect(
      balanceSheetHistory(artifact, ANALYSIS_AS_OF)?.rows.filter(
        (row) => row.period.includes("2025-12-31") && row.debt !== undefined,
      ),
    ).toEqual([]);
    expect(
      valuationPeriodInputs(artifact).periods.filter(
        (period) => period.debt?.periodEnd === "2025-12-31",
      ),
    ).toEqual([]);
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.metrics.debtBasis).toBeUndefined();
  });

  test("META: a noncurrent line that nets to its whole principal stays complete", () => {
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(40_000_000_000)],
      LongTermDebtNoncurrent: [at(83_664_000_000)],
      LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: [at(1_000_000_000)],
      DebtInstrumentCarryingAmount: [at(84_000_000_000)],
      DebtInstrumentUnamortizedDiscountPremiumAndDebtIssuanceCostsNet: [at(336_000_000)],
    });
    expect(canonical).toMatchObject({ value: 83_664_000_000, periodEnd: "2026-06-30" });
    expect(legacy?.metrics.debt).toBe(83_664_000_000);
  });

  test("an older withheld instant keeps its dated omission note behind a newer complete one", () => {
    const { artifact, canonical } = resolve({
      LongTermDebt: [prior(100)],
      LongTermDebtCurrent: [prior(10)],
      DebtLongtermAndShorttermCombinedAmount: [at(120)],
    });
    expect(canonical).toMatchObject({ value: 120, periodEnd: "2026-06-30" });
    expect(artifact.omissionNotes).toContainEqual(
      expect.objectContaining({
        code: "incomplete-composite-series",
        periodKey: "instant|2026-03-31",
      }),
    );
  });

  test("scope evidence comes from LongTermDebt's own filing, not an earlier one for the same period", () => {
    const original = (value: number) => filed(value, "2026-06-30", "2026-08-06", "original");
    const later = (value: number) => filed(value, "2026-06-30", "2026-09-01", "later");
    expectGap(
      {
        LongTermDebt: [original(100), later(100)],
        LongTermDebtNoncurrent: [original(100)],
        LongTermDebtCurrent: [later(20)],
      },
      "without a noncurrent line or total",
    );
  });

  test("LongTermDebt's own filing reconciles it even when a later filing re-reports the lines", () => {
    const original = (value: number) => filed(value, "2026-06-30", "2026-08-06", "original");
    const later = (value: number) => filed(value, "2026-06-30", "2026-09-01", "later");
    expect(
      resolve({
        LongTermDebt: [original(100)],
        LongTermLineOfCredit: [original(90), later(90)],
        LinesOfCreditCurrent: [original(10), later(10)],
      }).canonical,
    ).toMatchObject({ value: 100, concept: "LongTermDebt" });
  });

  test("a LongTermDebt total whose lines a later filing restated is withheld", () => {
    const original = (value: number) => filed(value, "2026-06-30", "2026-08-06", "original");
    const later = (value: number) => filed(value, "2026-06-30", "2026-09-01", "later");
    expectGap(
      {
        LongTermDebt: [original(100)],
        LongTermDebtCurrent: [original(20), later(5)],
        LongTermDebtNoncurrent: [original(80)],
      },
      "a later filing restated LongTermDebtCurrent without restating LongTermDebt",
    );
    expect(
      resolve({
        LongTermDebt: [original(100)],
        LongTermDebtCurrent: [original(20), later(5)],
        LongTermDebtNoncurrent: [original(80), later(105)],
        DebtLongtermAndShorttermCombinedAmount: [later(110)],
      }).canonical,
    ).toMatchObject({ value: 110, concept: "DebtLongtermAndShorttermCombinedAmount" });
  });

  test("zero short-term borrowings and zero maturities resolve to zero without DebtCurrent", () => {
    expect(
      resolve({
        LongTermDebt: [at(0)],
        LongTermDebtCurrent: [at(0)],
        LongTermDebtNoncurrent: [at(0)],
        ShortTermBorrowings: [at(0)],
      }).canonical,
    ).toMatchObject({ value: 0 });
  });

  test("a lone LongTermDebt with no current debt tagged stays the total", () => {
    expect(resolve({ LongTermDebt: [at(100)] }).canonical).toMatchObject({
      value: 100,
      concept: "LongTermDebt",
    });
  });

  test("LongTermDebt equal to its noncurrent line is summed with the current lines once", () => {
    expect(
      resolve({
        LongTermDebt: [at(90)],
        LongTermDebtCurrent: [at(10)],
        LongTermDebtNoncurrent: [at(90)],
      }).canonical,
    ).toMatchObject({ value: 100, concept: "LongTermDebtCurrent+LongTermDebtNoncurrent" });
  });

  test("short-term borrowings beside current maturities count only when DebtCurrent reconciles them", () => {
    const lines = {
      LongTermDebt: [at(100)],
      LongTermDebtCurrent: [at(20)],
      LongTermDebtNoncurrent: [at(80)],
      ShortTermBorrowings: [at(20)],
    };
    expect(resolve({ ...lines, DebtCurrent: [at(40)] }).canonical).toMatchObject({ value: 120 });
    const reason =
      "ShortTermBorrowings tagged beside LongTermDebtCurrent with no DebtCurrent or total";
    expectGap(lines, reason);
    // AMAT FY2026 Q3 10-Q (0001628280-26-058235): ShortTermBorrowings 1,299M already holds the 1,199M maturities.
    expectGap(
      {
        LongTermDebtCurrent: [at(1199)],
        ShortTermBorrowings: [at(1299)],
        LongTermDebtNoncurrent: [at(5245)],
      },
      reason,
    );
  });

  test("equal amounts never show a current instrument sits inside current maturities", () => {
    const reason = "tagged beside LongTermDebtCurrent with no DebtCurrent or total";
    // DebtCurrent is the balance-sheet line holding both.
    expect(
      resolve({
        LongTermDebtCurrent: [at(20)],
        NotesPayableCurrent: [at(20)],
        LongTermDebtNoncurrent: [at(80)],
        DebtCurrent: [at(40)],
      }).canonical,
    ).toMatchObject({ value: 120, concept: "DebtCurrent+LongTermDebtNoncurrent" });
    // MARA Q2 2026 10-Q (thousands): notes 335,397 + lines of credit 150,000 = 485,397 current maturities.
    const mara = {
      LongTermDebt: [at(2_417_749)],
      LongTermDebtCurrent: [at(485_397)],
      NotesPayableCurrent: [at(335_397)],
      LinesOfCreditCurrent: [at(150_000)],
      LongTermDebtNoncurrent: [at(1_932_352)],
    };
    expectGap(mara, reason);
    const faceLines = {
      AccountsPayableCurrent: [at(10_489)],
      AccruedLiabilitiesCurrent: [at(74_167)],
      DerivativeLiabilitiesCurrent: [at(1090)],
      OperatingLeaseLiabilityCurrent: [at(3338)],
      FinanceLeaseLiabilityCurrent: [at(178)],
      OtherLiabilitiesCurrent: [at(17_166)],
    };
    expectGap({ ...mara, ...faceLines, LiabilitiesCurrent: [at(591_825 + 485_397)] }, reason);
    expectGap(
      {
        ...mara,
        ...faceLines,
        LongTermDebtCurrent: [at(485_000)],
        LiabilitiesCurrent: [at(591_825)],
      },
      "tagged beside LongTermDebtCurrent",
    );
  });

  test("MARA 10-Q 0001507605-26-000022: face-statement current lines prove notes and credit line are the maturities", () => {
    const q = (value: number) => ({ ...at(value), accn: "0001507605-26-000022" });
    expect(
      resolve({
        LongTermDebt: [q(2_417_749)],
        LongTermDebtCurrent: [q(485_397)],
        NotesPayableCurrent: [q(335_397)],
        LinesOfCreditCurrent: [q(150_000)],
        LongTermDebtNoncurrent: [q(1_932_352)],
        AccountsPayableCurrent: [q(10_489)],
        AccruedLiabilitiesCurrent: [q(74_167)],
        DerivativeLiabilitiesCurrent: [q(1090)],
        OperatingLeaseLiabilityCurrent: [q(3338)],
        FinanceLeaseLiabilityCurrent: [q(178)],
        OtherLiabilitiesCurrent: [q(17_166)],
        LiabilitiesCurrent: [q(591_825)],
      }).canonical,
    ).toMatchObject({
      value: 2_417_749,
      periodEnd: "2026-06-30",
      accessionNumber: "0001507605-26-000022",
    });
  });

  test("commercial paper adds beside current maturities", () => {
    // Apple FY2026 Q3 10-Q (0000320193-26-000020): LongTermDebt 82,300M at principal; carrying lines sum to 84,344M.
    expect(
      resolve({
        LongTermDebt: [at(82_300)],
        LongTermDebtCurrent: [at(11_007)],
        LongTermDebtNoncurrent: [at(71_340)],
        CommercialPaper: [at(1997)],
      }).canonical,
    ).toMatchObject({
      value: 84_344,
      concept: "LongTermDebtCurrent+CommercialPaper+LongTermDebtNoncurrent",
    });
  });

  test("AMZN: the gross-principal fallback never stands in for gapped debt beside current maturities", () => {
    // Q2 2026 10-Q (0001018724-26-000026): DebtInstrumentCarryingAmount 128,894M omits 3,330M maturities and 325M STB.
    const march = (value: number) => instant(value, "2026-03-31", "2026-05-01");
    const june = (value: number) => instant(value, "2026-06-30", "2026-07-31");
    const { canonical } = resolve({
      LongTermDebt: [march(120_000), june(132_995)],
      LongTermDebtCurrent: [march(0), june(3330)],
      LongTermDebtNoncurrent: [march(120_000), june(128_894)],
      ShortTermBorrowings: [june(325)],
      DebtInstrumentCarryingAmount: [march(120_000), june(128_894)],
    });
    expect(canonical).toMatchObject({ periodEnd: "2026-03-31", value: 120_000 });
  });

  test("a selected total gaps beside current lines of credit it does not reconcile", () => {
    // GPN Q2 2026 10-Q (0001123360-26-000084): 1,136.764M settlement lines of credit sit outside the 22,418.326M total.
    expectGap(
      {
        LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [at(22_418.326)],
        LongTermDebt: [at(22_515.505)],
        LongTermDebtAndCapitalLeaseObligationsCurrent: [at(925.032)],
        LinesOfCreditCurrent: [at(1136.764)],
        LongTermDebtAndCapitalLeaseObligations: [at(21_493.294)],
      },
      "LinesOfCreditCurrent tagged beside LongTermDebtAndCapitalLeaseObligationsCurrent",
    );
  });

  test("a LongTermDebt total that reconciles to its lines outranks a principal combined total", () => {
    // AVGO FY2026 Q3 10-Q (0001730168-26-000080): 59,419M carrying vs 61,079M principal.
    expect(
      resolve({
        DebtLongtermAndShorttermCombinedAmount: [at(61_079)],
        LongTermDebt: [at(59_419)],
        LongTermDebtCurrent: [at(2252)],
        DebtCurrent: [at(2252)],
        LongTermDebtNoncurrent: [at(57_167)],
        LongTermDebtAndCapitalLeaseObligations: [at(57_167)],
      }).canonical,
    ).toMatchObject({ value: 59_419, concept: "LongTermDebt" });
  });

  test("instant-dated flow concepts and an all-zero umbrella do not refuse the component sum", () => {
    expect(
      resolve({
        LongTermDebtCurrent: [at(10)],
        LongTermDebtNoncurrent: [at(90)],
        ProceedsFromIssuanceOfLongTermDebt: [at(40)],
        LineOfCredit: [at(0)],
      }).canonical,
    ).toMatchObject({ value: 100 });
  });

  test("AMD: a combined total equal to the classified lines holds a duplicate short-term tag", () => {
    // AMD FY2025 10-K (0000002488-26-000018): current portion 874M + long-term 2,348M; ShortTermBorrowings repeats the 874M.
    const fy = (value: number) => filed(value, "2025-12-27", "2026-02-04", "amd-fy2025", "10-K");
    const { canonical, legacy } = resolve({
      DebtLongtermAndShorttermCombinedAmount: [fy(3222)],
      LongTermDebtCurrent: [fy(874)],
      LongTermDebtNoncurrent: [fy(2348)],
      ShortTermBorrowings: [fy(874)],
    });
    expect(canonical).toMatchObject({ periodEnd: "2025-12-27", value: 3222 });
    expect(legacy?.metrics?.debt).toBe(3222);
  });

  test("a combined total gaps when short-term borrowings exceed the current line", () => {
    expectGap(
      {
        DebtLongtermAndShorttermCombinedAmount: [at(100)],
        LongTermDebtCurrent: [at(10)],
        LongTermDebtNoncurrent: [at(90)],
        ShortTermBorrowings: [at(30)],
      },
      "ShortTermBorrowings",
    );
  });

  test("classified lines outrank a combined total that leaves out short-term debt in DebtCurrent", () => {
    const on = (value: number) =>
      filed(value, "2019-09-29", "2019-11-06", "0001728949-19-000072", "10-K");
    // QCOM FY2019 10-K (0001728949-19-000072): short-term debt 2,496M + long-term 13,437M; combined 15,434M omits 499M paper.
    const canonical = resolveAt(
      {
        DebtLongtermAndShorttermCombinedAmount: [on(15_434)],
        LongTermDebtCurrent: [on(1997)],
        DebtCurrent: [on(2496)],
        LongTermDebtNoncurrent: [on(13_437)],
        CommercialPaper: [on(499)],
      },
      "2019-09-29",
    );
    expect(canonical).toMatchObject({
      value: 15_933,
      concept: "DebtCurrent+LongTermDebtNoncurrent",
    });
  });

  test("a principal combined total yields to same-filing classified lines", () => {
    // AVGO FY2024 10-K: 1,245M maturities + 66,295M noncurrent incl. 13M finance leases; combined 69,847M is principal.
    const on = (value: number) =>
      filed(value, "2024-11-03", "2024-12-20", "0001730168-24-000139", "10-K");
    expect(
      resolveAt(
        {
          DebtLongtermAndShorttermCombinedAmount: [on(69_847)],
          LongTermDebtCurrent: [on(1245)],
          LongTermDebtAndCapitalLeaseObligations: [on(66_295)],
          FinanceLeaseLiabilityCurrent: [on(26)],
          FinanceLeaseLiabilityNoncurrent: [on(13)],
        },
        "2024-11-03",
      ),
    ).toMatchObject({ value: 67_527, accessionNumber: "0001730168-24-000139" });
  });

  test("DebtCurrent outranks narrower current maturities", () => {
    // INTC FY2018 10-K: short-term debt 1,261M + long-term debt 25,098M; maturities 761M.
    const intc = (value: number) =>
      filed(value, "2018-12-29", "2019-02-01", "0000050863-19-000007", "10-K");
    expect(
      resolveAt(
        {
          LongTermDebt: [intc(25_859)],
          LongTermDebtCurrent: [intc(761)],
          DebtCurrent: [intc(1261)],
          LongTermDebtNoncurrent: [intc(25_098)],
        },
        "2018-12-29",
      ),
    ).toMatchObject({
      value: 26_359,
      concept: "DebtCurrent+LongTermDebtNoncurrent",
      accessionNumber: "0000050863-19-000007",
    });
    // ADBE Q1 FY2026 10-Q: current debt 849M carrying vs 850M maturities; LongTermDebt is the noncurrent line.
    const adbe = (value: number) =>
      filed(value, "2026-02-27", "2026-03-13", "0000796343-26-000056");
    expect(
      resolveAt(
        {
          LongTermDebt: [adbe(5379)],
          LiabilitiesNoncurrent: [adbe(5379)],
          LongTermDebtCurrent: [adbe(850)],
          DebtCurrent: [adbe(849)],
        },
        "2026-02-27",
      ),
    ).toMatchObject({ value: 6228, accessionNumber: "0000796343-26-000056" });
  });

  test("LongTermDebt up to maturities plus noncurrent does not refuse a smaller DebtCurrent line", () => {
    const on = (value: number) =>
      filed(value, "2019-12-28", "2020-01-24", "0000050863-20-000011", "10-K");
    // INTC FY2019 10-K (0000050863-20-000011): 3,693M + 25,308M; LongTermDebt 29,003M uses 3,695M maturities.
    expect(
      resolveAt(
        {
          LongTermDebt: [on(29_003)],
          LongTermDebtCurrent: [on(3695)],
          DebtCurrent: [on(3693)],
          LongTermDebtNoncurrent: [on(25_308)],
        },
        "2019-12-28",
      ),
    ).toMatchObject({ value: 29_001, concept: "DebtCurrent+LongTermDebtNoncurrent" });
  });

  test("DebtCurrent holding pre-ASC 842 capital leases keeps the borrowing-only maturities", () => {
    const on = (value: number) =>
      filed(value, "2018-06-24", "2018-08-16", "0000707549-18-000115", "10-K");
    // LRCX FY2018 10-K (0000707549-18-000115): 610,030K current = 608,532K maturities + 1,498K capital leases.
    expect(
      resolveAt(
        {
          LongTermDebt: [on(2_368_748)],
          LongTermDebtCurrent: [on(608_532)],
          DebtCurrent: [on(610_030)],
          LongTermDebtNoncurrent: [on(1_760_216)],
          CapitalLeaseObligationsCurrent: [on(1498)],
        },
        "2018-06-24",
      ),
    ).toMatchObject({ value: 2_368_748 });
  });

  test("AMD: OtherLongTermDebt inside a reconciled noncurrent line is not a stray borrowing", () => {
    // AMD FY2016 10-K: short-term debt 0, long-term debt, net 1,435M.
    const fy = (value: number) => filed(value, "2016-12-31", "2017-02-21", "amd-fy2016", "10-K");
    const { canonical, legacy } = resolve({
      LongTermDebt: [fy(1435)],
      LongTermDebtNoncurrent: [fy(1435)],
      LinesOfCreditCurrent: [fy(0)],
      OtherLongTermDebt: [fy(1)],
    });
    expect(canonical).toMatchObject({ periodEnd: "2016-12-31", value: 1435 });
    expect(legacy?.metrics?.debt).toBe(1435);
  });

  test("a lone OtherLongTermDebt with no line or total that holds it gaps", () => {
    expectGap(
      { LongTermDebtCurrent: [at(10)], OtherLongTermDebt: [at(5)] },
      "OtherLongTermDebt tagged without a noncurrent debt line or total that holds it",
    );
  });

  test.each(["legacy", "canonical"] as const)(
    "NVDA: %s debt YoY spans a component prior and a reconciled LongTermDebt total",
    (path) => {
      // NVDA 10-Q 2026-07-26 (0001045810-26-000075) vs 10-Q 2025-07-27: 33,366M vs 8,466M.
      const q = (value: number, end: string, filedAt: string) =>
        filed(value, end, filedAt, `nvda-${end}`);
      const yearAgo = (value: number) => q(value, "2025-07-27", "2025-08-27");
      const latest = (value: number) => q(value, "2026-07-26", "2026-08-26");
      const { artifact, legacy } = resolve({
        CashAndCashEquivalentsAtCarryingValue: [yearAgo(11_639), latest(22_443)],
        LongTermDebtNoncurrent: [yearAgo(8466), latest(32_366)],
        LongTermDebt: [latest(33_366)],
        DebtCurrent: [latest(1000)],
        LongTermDebtCurrent: [latest(1000)],
      });
      const metrics =
        path === "legacy"
          ? legacy?.metrics
          : withCanonicalFinancialLensInputs(secEvidenceFrom(legacy?.metrics), artifact).items[0]
              ?.metrics;
      expect(metrics?.debt).toBe(33_366);
      expect(metrics?.debtPrior).toBe(8466);
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "%s debt YoY stays suppressed between a principal combined total and a component prior",
    (path) => {
      const yearAgo = (value: number) => instant(value, "2025-06-30", "2025-08-06");
      const { artifact, legacy } = resolve({
        LongTermDebtNoncurrent: [yearAgo(80)],
        DebtLongtermAndShorttermCombinedAmount: [at(100)],
      });
      const metrics =
        path === "legacy"
          ? legacy?.metrics
          : withCanonicalFinancialLensInputs(secEvidenceFrom(legacy?.metrics), artifact).items[0]
              ?.metrics;
      expect(metrics?.debt).toBeDefined();
      expect(metrics?.debtPrior).toBeUndefined();
    },
  );

  test.each([
    [
      "LongTermDebt beside current debt with no noncurrent line or total",
      { LongTermDebt: [at(100)], LongTermDebtCurrent: [at(10)] },
      "without a noncurrent line or total",
    ],
    [
      "LongTermDebt that reconciles to none of the tagged lines",
      { LongTermDebt: [at(200)], LongTermDebtCurrent: [at(10)], LongTermDebtNoncurrent: [at(90)] },
      "LongTermDebt (200) reconciles to none of the tagged lines",
    ],
    [
      "LongTermDebt below its noncurrent line",
      { LongTermDebt: [at(100)], LongTermDebtNoncurrent: [at(150)] },
      "LongTermDebt (100) reconciles to none of the tagged lines",
    ],
    [
      "LongTermDebt equal to the noncurrent line after recent short-term borrowings",
      {
        LongTermDebt: [at(100)],
        LongTermDebtNoncurrent: [at(100)],
        ShortTermBorrowings: [prior(30)],
      },
      "omits ShortTermBorrowings",
    ],
    [
      "LongTermDebt beside zero maturities after recent commercial paper",
      {
        LongTermDebt: [prior(100), at(100)],
        LongTermDebtCurrent: [at(0)],
        CommercialPaper: [prior(30)],
      },
      "LongTermDebt excludes CommercialPaper",
    ],
    [
      "a lone LongTermDebt after recent short-term borrowings",
      { LongTermDebt: [prior(100), at(100)], ShortTermBorrowings: [prior(30)] },
      "LongTermDebt excludes ShortTermBorrowings",
    ],
  ] as const)("declares a gap for %s", (_label, gaap, reason) => {
    expectGap(gaap, reason);
  });
});

describe("debt totals and instruments checked against their lines", () => {
  const filed = (
    value: number,
    periodEnd: string,
    filedAt: string,
    accn: string,
    form = "10-Q",
  ) => ({
    ...instant(value, periodEnd, filedAt, form, form === "10-K" ? "FY" : "Q1"),
    accn,
  });
  const noteFor = (gaap: Parameters<typeof resolve>[0], periodEnd: string) =>
    resolve(gaap).artifact.omissionNotes.find(
      (note) =>
        note.code === "incomplete-composite-series" && note.periodKey === `instant|${periodEnd}`,
    )?.message;

  describe("VSAT 2026-06-30 10-Q 0001193125-26-337903", () => {
    const june = (value: number) =>
      filed(value, "2026-06-30", "2026-08-06", "0001193125-26-337903");
    const vsat = {
      LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [june(6_570_503_000)],
      LongTermDebtAndCapitalLeaseObligationsCurrent: [june(661_939_000)],
      LongTermDebtCurrent: [june(661_939_000)],
      LongTermDebtAndCapitalLeaseObligations: [june(5_780_460_000)],
      FinanceLeaseLiability: [june(142_678_000)],
      DebtInstrumentUnamortizedDiscountPremiumAndDebtIssuanceCostsNet: [june(128_104_000)],
    };

    test("a total above its balance-sheet legs is principal: 6,442.399M lines less 142.678M leases", () => {
      const { canonical, legacy } = resolve(vsat);
      expect(canonical).toMatchObject({ value: 6_299_721_000, periodEnd: "2026-06-30" });
      expect(legacy?.metrics.debt).toBe(6_299_721_000);
    });

    test("the filed CommercialPaperNoncurrent notes tag withholds it", () => {
      const gaap = { ...vsat, CommercialPaperNoncurrent: [june(3_068_721_000)] };
      expect(resolve(gaap).canonical?.periodEnd).not.toBe("2026-06-30");
      expect(resolve(gaap).legacy?.metrics.debt).toBeUndefined();
      expect(noteFor(gaap, "2026-06-30")).toContain("CommercialPaperNoncurrent");
    });

    test("without the unamortized-cost proof the total stays", () => {
      const { canonical } = resolve({
        ...vsat,
        DebtInstrumentUnamortizedDiscountPremiumAndDebtIssuanceCostsNet: [june(128_000_000)],
      });
      expect(canonical).toMatchObject({ value: 6_427_825_000 });
    });

    test("a total equal to its legs stays the total", () => {
      const { canonical } = resolve({
        ...vsat,
        LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [june(6_442_399_000)],
      });
      expect(canonical).toMatchObject({ value: 6_299_721_000 });
      expect(canonical?.concept).toStartWith(
        "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities",
      );
    });
  });

  describe("Corning 2024-12-31", () => {
    const tenK = (value: number) =>
      filed(value, "2024-12-31", "2026-02-12", "0000024741-26-000124", "10-K");
    const tenQ = (value: number) =>
      filed(value, "2024-12-31", "2025-10-31", "0000024741-25-000121");

    test("10-K 0000024741-26-000124: 7,211M total less 174M finance leases = 7,037M", () => {
      const { canonical } = resolve({
        LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [tenK(7_211_000_000)],
        FinanceLeaseLiability: [tenK(174_000_000)],
      });
      expect(canonical).toMatchObject({ value: 7_037_000_000 });
    });

    const twoLegs = {
      DebtCurrent: [tenQ(326_000_000)],
      LongTermDebtAndCapitalLeaseObligations: [tenQ(6_885_000_000)],
      FinanceLeaseLiability: [tenQ(144_000_000)],
    };

    test("10-Q 0000024741-25-000121: a lease total across two legs is withheld", () => {
      expect(noteFor(twoLegs, "2024-12-31")).toContain("its split across");
      expect(resolve(twoLegs).canonical).toBeUndefined();
    });

    test("a later filing's restated lease split leg withholds the deduction", () => {
      const gaap = {
        DebtCurrent: [tenQ(326_000_000), tenK(326_000_000)],
        LongTermDebtAndCapitalLeaseObligations: [tenQ(6_885_000_000), tenK(6_885_000_000)],
        FinanceLeaseLiabilityCurrent: [tenQ(0), tenK(30_000_000)],
        FinanceLeaseLiabilityNoncurrent: [tenQ(144_000_000), tenK(144_000_000)],
      };
      const { canonical, legacy } = resolve(gaap);
      expect(noteFor(gaap, "2024-12-31")).toContain("restated FinanceLeaseLiabilityCurrent");
      expect(canonical).toBeUndefined();
      expect(legacy?.metrics.debt).toBeUndefined();
    });
  });

  describe("AAOI 2024-12-31 10-K 0001437749-26-005875", () => {
    const fy = (value: number) =>
      filed(value, "2024-12-31", "2026-02-26", "0001437749-26-005875", "10-K");
    const aaoi = {
      LongTermDebt: [fy(26_682_000)],
      LongTermDebtCurrent: [fy(22_369_000)],
      LongTermDebtNoncurrent: [fy(4_313_000)],
      ConvertibleLongTermNotesPayable: [fy(134_497_000)],
    };

    test("withholds 26.682M LongTermDebt beside 134.497M convertibles it cannot hold", () => {
      const { canonical, legacy } = resolve(aaoi);
      expect(canonical).toBeUndefined();
      expect(legacy?.metrics.debt).toBeUndefined();
      expect(noteFor(aaoi, "2024-12-31")).toContain(
        "ConvertibleLongTermNotesPayable (134497000) exceeds LongTermDebt (26682000)",
      );
    });

    test("the noncurrent liabilities identity proves the convertibles sit beside: 161.179M", () => {
      const proven = {
        ...aaoi,
        Liabilities: [fy(317_920_000)],
        LiabilitiesCurrent: [fy(170_069_000)],
        OperatingLeaseLiabilityNoncurrent: [fy(9_041_000)],
        ConvertibleNotesPayable: [fy(134_497_000)],
      };
      expect(resolve(proven).canonical).toMatchObject({
        value: 161_179_000,
        concept: "LongTermDebt+ConvertibleLongTermNotesPayable",
        accessionNumber: "0001437749-26-005875",
      });
      expect(resolve(proven).legacy?.metrics.debt).toBe(161_179_000);
      expect(
        resolve({ ...proven, OperatingLeaseLiabilityNoncurrent: [fy(9_040_000)] }).canonical,
      ).toBeUndefined();
    });

    test("an instrument no larger than the total may sit inside it", () => {
      expect(
        resolve({ ...aaoi, ConvertibleLongTermNotesPayable: [fy(4_000_000)] }).canonical?.value,
      ).toBe(26_682_000);
    });
  });

  test("PL 10-Q 0001193125-25-314295: a lone ConvertibleNotesPayable is withheld, not total debt", () => {
    const oct = (value: number) => filed(value, "2025-10-31", "2025-12-10", "0001193125-25-314295");
    const gaap = { ConvertibleNotesPayable: [oct(446_201_000)] };
    expect(resolve(gaap).canonical).toBeUndefined();
    expect(noteFor(gaap, "2025-10-31")).toContain("tagged without its current or noncurrent legs");
  });

  test("HIVE: a 40-F line renamed in the 10-K withholds legacy debt too (0001062993-26-002973)", () => {
    const tenK = (value: number) =>
      filed(value, "2026-03-31", "2026-06-02", "0001062993-26-002973", "10-K");
    const gaap = {
      LongTermNotesPayable: [
        filed(10_200_000, "2025-03-31", "2025-06-26", "0001062993-25-012159", "40-F"),
      ],
      ShortTermBorrowings: [tenK(2_038_000)],
      LoansPayableCurrent: [tenK(1_460_000)],
      LongTermLoansPayable: [tenK(9_497_000)],
    };
    const { canonical, legacy } = resolve(gaap);
    expect(canonical?.periodEnd).not.toBe("2026-03-31");
    expect(legacy?.metrics.debt).toBeUndefined();
    expect(legacy?.debtComposite?.incompleteReason).toContain("omits LongTermNotesPayable");
    const domestic = resolve({ ...gaap, LongTermNotesPayable: [] }).legacy;
    expect(domestic?.metrics.debt).toBe(12_995_000);
  });
});
