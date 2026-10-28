import { describe, expect, test } from "bun:test";
import type { ExtendedEvidenceItem } from "../src/domain/evidence";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  financialStatementFacts,
  latestFinancialStatementFact,
} from "../src/sources/extended-evidence/financial-statement-selection";
import { summarizeSecFundamentals } from "../src/sources/extended-evidence/sec-edgar";
import { secBalanceSheetFaceMetrics } from "../src/sources/sec-segment-facts";

type Row = readonly [label: string, concept: string, value: number];

const AS_OF = "2026-10-27T00:00:00.000Z";

const cell = (concept: string, value: number, context: string) =>
  `<td><ix:nonFraction name="${concept}" contextRef="${context}" unitRef="usd" scale="3">${value.toLocaleString("en-US")}</ix:nonFraction></td>`;

function balanceSheet(periodEnd: string, rows: readonly Row[]): string {
  return [
    `<xbrli:context id="c"><xbrli:entity></xbrli:entity><xbrli:period><xbrli:instant>${periodEnd}</xbrli:instant></xbrli:period></xbrli:context>`,
    `<xbrli:context id="s"><xbrli:entity><xbrli:segment>m</xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>${periodEnd}</xbrli:instant></xbrli:period></xbrli:context>`,
    "<table>",
    ...rows.map(
      ([label, concept, value]) =>
        `<tr><td>${label}</td>${cell(concept, value, "c")}${cell(concept, 1, "s")}</tr>`,
    ),
    "</table>",
  ].join("");
}

function faceFiling(
  accessionNumber: string,
  reportDate: string,
  rows: readonly Row[],
): ExtendedEvidenceItem {
  return {
    sourceIds: [`sec-filing-${accessionNumber}`],
    metrics: {
      accessionNumber,
      reportDate,
      ...secBalanceSheetFaceMetrics(balanceSheet(reportDate, rows), reportDate),
    },
  } as unknown as ExtendedEvidenceItem;
}

function derive(
  gaap: Readonly<Record<string, readonly Record<string, unknown>[]>>,
  secFilings: readonly ExtendedEvidenceItem[],
) {
  const companyFacts = {
    facts: {
      "us-gaap": Object.fromEntries(
        Object.entries({
          Revenues: [
            { ...fact(100, "2025-12-31", "2026-02-15", "revenue", "10-K"), start: "2025-01-01" },
          ],
          ...gaap,
        }).map(([concept, usd]) => [concept, { units: { USD: usd } }]),
      ),
    },
  };
  const artifact = deriveFinancialStatements(companyFacts, {
    symbol: "TEST",
    generatedAt: AS_OF,
    analysisAsOf: AS_OF,
    sourceId: "sec",
    secFilings,
  });
  return {
    debt: latestFinancialStatementFact(
      financialStatementFacts(artifact.statements.balanceSheet.debt),
    ),
    legacy: summarizeSecFundamentals(companyFacts, AS_OF)?.metrics.debt,
  };
}

const fact = (value: number, end: string, filed: string, accn: string, form = "10-Q") => ({
  val: value,
  end,
  filed,
  accn,
  form,
  fy: 2026,
  fp: form === "10-Q" ? "Q1" : "FY",
});

const HIVE_ACCN = "0001062993-26-004434";
const HIVE_ROWS: readonly Row[] = [
  ["Total assets", "us-gaap:Assets", 1_000_000],
  [
    "Accounts payable and accrued liabilities",
    "us-gaap:AccountsPayableAndAccruedLiabilitiesCurrent",
    118_403,
  ],
  ["Current portion of lease liability", "hive:LeaseLiabilityCurrent", 12_216],
  ["Current portion of loans payable", "us-gaap:LoansPayableCurrent", 1460],
  ["Term loan", "us-gaap:ShortTermBorrowings", 1600],
  ["Current portion of mortgage payable", "hive:MortgagePayableCurrent", 162],
  ["Warrant liability", "hive:WarrantLiabilityCurrent", 2154],
  ["Current income tax liability", "hive:IncomeTaxLiabilityCurrent", 7059],
  ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 143_054],
  ["Convertible loan - liability component", "us-gaap:ConvertibleDebtNoncurrent", 234_872],
  ["Loans payable", "us-gaap:LongTermLoansPayable", 9457],
  ["Lease liability", "hive:LeaseLiabilityNoncurrent", 96_237],
  ["Mortgage payable", "hive:MortgagePayableNoncurrent", 18_300],
  ["Deferred tax liability", "us-gaap:DeferredIncomeTaxLiabilitiesNet", 21],
  ["Total liabilities", "us-gaap:Liabilities", 501_941],
];
const hiveJune = (value: number) => fact(value, "2026-06-30", "2026-08-14", HIVE_ACCN);
const HIVE_GAAP = {
  LongTermNotesPayable: [
    fact(9_828_000, "2025-12-31", "2026-02-17", "0001062993-26-000943", "6-K"),
  ],
  LoansPayableCurrent: [hiveJune(1_460_000)],
  ShortTermBorrowings: [hiveJune(1_600_000)],
  ConvertibleDebtNoncurrent: [hiveJune(234_872_000)],
  LongTermLoansPayable: [hiveJune(9_457_000)],
};

const VSAT_ACCN = "0001193125-26-337903";
const VSAT_ROWS: readonly Row[] = [
  ["Total assets", "us-gaap:Assets", 15_000_000],
  ["Accounts payable", "us-gaap:AccountsPayableCurrent", 288_629],
  ["Accrued and other liabilities", "vsat:AccruedAndOtherLiabilitiesCurrent", 902_530],
  ["Current portion of long-term debt", "us-gaap:LongTermDebtCurrent", 661_939],
  ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 1_853_098],
  ["Senior notes", "us-gaap:CommercialPaperNoncurrent", 3_068_721],
  [
    "Other long-term debt",
    "vsat:LongTermDebtOtherThanLongTermCommercialPaperNoncurrent",
    2_711_739,
  ],
  ["Non-current operating lease liabilities", "us-gaap:OperatingLeaseLiabilityNoncurrent", 420_685],
  ["Other liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 2_339_668],
  ["Total liabilities", "us-gaap:Liabilities", 10_393_911],
];
const vsatJune = (value: number) => fact(value, "2026-06-30", "2026-08-06", VSAT_ACCN);
const VSAT_GAAP = {
  LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [vsatJune(6_570_503_000)],
  LongTermDebtAndCapitalLeaseObligationsCurrent: [vsatJune(661_939_000)],
  LongTermDebtCurrent: [vsatJune(661_939_000)],
  LongTermDebtAndCapitalLeaseObligations: [vsatJune(5_780_460_000)],
  FinanceLeaseLiability: [vsatJune(142_678_000)],
  DebtInstrumentUnamortizedDiscountPremiumAndDebtIssuanceCostsNet: [vsatJune(128_104_000)],
  CommercialPaperNoncurrent: [vsatJune(3_068_721_000)],
};

const withRow = (rows: readonly Row[], concept: string, row: Row) =>
  rows.map((current) => (current[1] === concept ? row : current));

describe("secBalanceSheetFaceMetrics", () => {
  test("emits undimensioned liability rows with labels when both sides foot", () => {
    const metrics = secBalanceSheetFaceMetrics(balanceSheet("2026-06-30", HIVE_ROWS), "2026-06-30");
    expect(metrics["faceLine|current|hive:MortgagePayableCurrent"]).toBe(162_000);
    expect(metrics["faceLine|noncurrent|hive:MortgagePayableNoncurrent"]).toBe(18_300_000);
    expect(metrics["faceLabel|hive:MortgagePayableNoncurrent"]).toContain("Mortgage payable");
    expect(metrics["faceLine|current|us-gaap:Assets"]).toBeUndefined();
  });

  test("emits nothing when a side is off by one thousand", () => {
    const rows = withRow(HIVE_ROWS, "hive:MortgagePayableNoncurrent", [
      "Mortgage payable",
      "hive:MortgagePayableNoncurrent",
      18_301,
    ]);
    expect(secBalanceSheetFaceMetrics(balanceSheet("2026-06-30", rows), "2026-06-30")).toEqual({});
  });
});

describe("HIVE 10-Q 0001062993-26-004434 2026-06-30 face statement", () => {
  test("labelled mortgage extensions beside footing standard lines recover 265.851M", () => {
    const { debt, legacy } = derive(HIVE_GAAP, [faceFiling(HIVE_ACCN, "2026-06-30", HIVE_ROWS)]);
    expect(debt).toMatchObject({
      value: 265_851_000,
      periodEnd: "2026-06-30",
      accessionNumber: HIVE_ACCN,
    });
    expect(debt?.concept).toContain("MortgagePayableNoncurrent");
    expect(debt?.sourceIds).toContain(`sec-filing-${HIVE_ACCN}`);
    expect(
      debt?.composite?.components.find(({ concept }) => concept === "MortgagePayableNoncurrent")
        ?.sourceIds,
    ).toEqual([`sec-filing-${HIVE_ACCN}`]);
    expect(legacy).toBeUndefined();
  });

  test("without a face statement the renamed 40-F line still withholds it", () => {
    expect(derive(HIVE_GAAP, []).debt?.periodEnd).not.toBe("2026-06-30");
  });

  test("an extension whose label disagrees with its name withholds it", () => {
    const rows = withRow(HIVE_ROWS, "hive:MortgagePayableNoncurrent", [
      "Other liability",
      "hive:MortgagePayableNoncurrent",
      18_300,
    ]);
    expect(derive(HIVE_GAAP, [faceFiling(HIVE_ACCN, "2026-06-30", rows)]).debt?.periodEnd).not.toBe(
      "2026-06-30",
    );
  });

  test.each([
    [
      "a label naming both debt and a non-debt item",
      "Mortgage plus interest",
      "hive:MortgagePayableNoncurrent",
    ],
    ["an extension neither name nor label classifies", "Deferred credits", "hive:DeferredCredits"],
  ] as const)("%s withholds it", (_case, label, concept) => {
    const rows = withRow(HIVE_ROWS, "hive:MortgagePayableNoncurrent", [label, concept, 18_300]);
    expect(derive(HIVE_GAAP, [faceFiling(HIVE_ACCN, "2026-06-30", rows)]).debt?.periodEnd).not.toBe(
      "2026-06-30",
    );
  });

  test("a face statement from another filing proves nothing", () => {
    const filing = faceFiling("0001062993-26-009999", "2026-06-30", HIVE_ROWS);
    expect(derive(HIVE_GAAP, [filing]).debt?.periodEnd).not.toBe("2026-06-30");
  });

  test("tagged lines that differ from the face lines withhold it", () => {
    const gaap = { ...HIVE_GAAP, LongTermLoansPayable: [hiveJune(9_456_000)] };
    expect(derive(gaap, [faceFiling(HIVE_ACCN, "2026-06-30", HIVE_ROWS)]).debt?.periodEnd).not.toBe(
      "2026-06-30",
    );
  });
});

describe("VSAT 10-Q 0001193125-26-337903 2026-06-30 face statement", () => {
  test("senior notes and other debt foot to the tagged lines: 6,442.399M less 142.678M leases", () => {
    const { debt, legacy } = derive(VSAT_GAAP, [faceFiling(VSAT_ACCN, "2026-06-30", VSAT_ROWS)]);
    expect(debt).toMatchObject({
      value: 6_299_721_000,
      periodEnd: "2026-06-30",
      accessionNumber: VSAT_ACCN,
    });
    expect(debt?.sourceIds).toEqual(["sec", `sec-filing-${VSAT_ACCN}`]);
    expect(legacy).toBeUndefined();
  });

  test("a deduction from another filing withholds it", () => {
    const gaap = {
      ...VSAT_GAAP,
      FinanceLeaseLiability: [fact(1, "2026-06-30", "2026-08-06", "0001193125-26-999999")],
    };
    expect(derive(gaap, [faceFiling(VSAT_ACCN, "2026-06-30", VSAT_ROWS)]).debt?.periodEnd).not.toBe(
      "2026-06-30",
    );
  });

  test("face debt lines one thousand short of the tagged lines withhold it", () => {
    const rows = withRow(
      withRow(VSAT_ROWS, "vsat:LongTermDebtOtherThanLongTermCommercialPaperNoncurrent", [
        "Other long-term debt",
        "vsat:LongTermDebtOtherThanLongTermCommercialPaperNoncurrent",
        2_711_738,
      ]),
      "us-gaap:OtherLiabilitiesNoncurrent",
      ["Other liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 2_339_669],
    );
    expect(derive(VSAT_GAAP, [faceFiling(VSAT_ACCN, "2026-06-30", rows)]).debt?.periodEnd).not.toBe(
      "2026-06-30",
    );
  });
});
