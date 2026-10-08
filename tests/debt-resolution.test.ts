import { describe, expect, test } from "bun:test";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  financialStatementFacts,
  latestFinancialStatementFact,
} from "../src/sources/extended-evidence/financial-statement-selection";
import { summarizeSecFundamentals } from "../src/sources/extended-evidence/sec-edgar";
import { balanceSheetPeriodDivergence } from "../src/sources/extended-evidence/valuation-comps-support";
import type { ValuationFundamentalInput } from "../src/sources/extended-evidence/valuation-workbench-contract";
import { metricResults } from "../src/sources/extended-evidence/valuation-workbench-metrics";

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

  test("RFIL: a current line of credit plus an explicit zero finance lease beats stale zero LTD", () => {
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

    expect(canonical).toMatchObject({ value: 5_718_000, periodEnd: "2026-07-31" });
    expect(canonical?.composite?.components.map((component) => component.concept)).toEqual([
      "LinesOfCreditCurrent",
      "FinanceLeaseLiability",
    ]);
    expect(legacy?.metrics.debt).toBe(5_718_000);
    expect(legacy?.metrics.debtPeriodEnd).toBe("2026-07-31");
  });

  test("OCC: counts revolver, both term-loan legs and the finance-lease total once", () => {
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

    expect(canonical).toMatchObject({ value: 9_180_370, periodEnd: "2026-07-31" });
    expect(legacy?.metrics.debt).toBe(9_180_370);
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
    expect(legacy?.metrics.debt).toBe(2_675_244);
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

  test("REGN: a lone generic noncurrent line plus both lease legs is complete", () => {
    const at = (value: number, end = "2026-06-30") => instant(value, end, "2026-07-30");
    const yearEnd = (value: number) => instant(value, "2025-12-31", "2026-02-04", "10-K", "FY");
    const { canonical, legacy } = resolve({
      CashAndCashEquivalentsAtCarryingValue: [at(2_000_000_000)],
      LongTermDebtNoncurrent: [yearEnd(1_985_900_000), at(1_986_600_000)],
      FinanceLeaseLiability: [yearEnd(720_000_000)],
      FinanceLeaseLiabilityCurrent: [at(720_000_000)],
      FinanceLeaseLiabilityNoncurrent: [yearEnd(720_000_000), at(0)],
    });

    expect(canonical).toMatchObject({ value: 2_706_600_000, periodEnd: "2026-06-30" });
    expect(legacy?.metrics.debt).toBe(2_706_600_000);
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
        LinesOfCreditCurrent: [at(5)],
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
      value: 103,
      concept:
        "LongTermDebtCurrent+LongTermDebtNoncurrent+FinanceLeaseLiabilityCurrent+FinanceLeaseLiabilityNoncurrent",
    });
    expect(
      resolve({
        ShortTermBorrowings: [at(7)],
        ShortTermDebt: [at(7)],
        LongTermLoansPayable: [at(3)],
      }).canonical,
    ).toMatchObject({ value: 10 });
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

  test("a finance-lease split with one leg missing is incomplete", () => {
    expectRefused(
      {
        LongTermDebtCurrent: [original(10)],
        LongTermDebtNoncurrent: [original(90)],
        FinanceLeaseLiabilityCurrent: [original(1)],
      },
      "finance leases lack FinanceLeaseLiabilityNoncurrent",
    );
  });

  test("lease inclusion is decided per side", () => {
    expect(
      resolve({
        LongTermDebtAndCapitalLeaseObligationsCurrent: [original(11)],
        LongTermDebtNoncurrent: [original(90)],
        FinanceLeaseLiabilityNoncurrent: [original(9)],
      }).canonical,
    ).toMatchObject({ value: 110 });
    expectRefused(
      {
        LongTermDebtAndCapitalLeaseObligationsCurrent: [original(11)],
        LongTermDebtNoncurrent: [original(90)],
        FinanceLeaseLiability: [original(10)],
      },
      "finance leases lack FinanceLeaseLiabilityNoncurrent",
    );
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

  test("lease coverage stays per side when no fresh lease is tagged", () => {
    expectRefused(
      {
        LongTermDebtAndCapitalLeaseObligationsCurrent: [original(11)],
        LongTermDebtNoncurrent: [original(90)],
        FinanceLeaseLiabilityNoncurrent: [priorQuarter(9)],
      },
      "omits FinanceLeaseLiabilityNoncurrent",
    );
  });

  test("DebtCurrent already includes the current finance-lease leg", () => {
    expect(
      resolve({
        DebtCurrent: [original(11)],
        LongTermDebtNoncurrent: [original(90)],
        FinanceLeaseLiabilityCurrent: [original(1)],
        FinanceLeaseLiabilityNoncurrent: [original(9)],
      }).canonical,
    ).toMatchObject({ value: 110 });
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
  return metricResults(
    {
      basis: "ttm",
      periodEnd: "2026-06-30",
      revenue: fundamental(100, "2026-06-30"),
      dilutedShares: { ...fundamental(10, "2026-06-30"), unit: "shares", currency: null },
      cash: fundamental(20, "2026-06-30"),
      debt: fundamental(30, debtPeriodEnd),
    },
    { close: 10, sessionDate: "2026-08-07", currency: "USD", sourceId: "quote" },
    "USD",
    "USD",
    undefined,
  ).enterpriseValueToRevenue;
}

describe("valuation workbench balance-sheet period gate", () => {
  test("populates EV/revenue when cash and debt are 92 days apart", () => {
    expect(evToRevenue("2026-03-30")).toMatchObject({ status: "populated", value: 1.1 });
  });

  test("suppresses EV/revenue with a declared reason at 93 days apart", () => {
    expect(evToRevenue("2026-03-29")).toMatchObject({
      status: "suppressed",
      reason: "mixed-period-balance-sheet",
      detail: "Cash (2026-06-30) and debt (2026-03-29) period ends diverge by 93 days.",
    });
  });
});
