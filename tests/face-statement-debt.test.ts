import { describe, expect, test } from "bun:test";
import type { ExtendedEvidenceItem } from "../src/domain/evidence";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  financialStatementFacts,
  latestFinancialStatementFact,
} from "../src/sources/extended-evidence/financial-statement-selection";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import {
  financialStatementsDebtBasisGaps,
  withStatementDebtBasisGaps,
} from "../src/sources/extended-evidence/sec-debt";
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
    summary: summarizeSecFundamentals(companyFacts, AS_OF),
    artifact,
    notes: artifact.omissionNotes,
    gaps: financialStatementsDebtBasisGaps(artifact),
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

const SAME_ACCN = "0000000000-26-000001";
const sameJune = (value: number, accn = SAME_ACCN) => fact(value, "2026-06-30", "2026-08-10", accn);
const NOTES_ROWS: readonly Row[] = [
  ["Total assets", "us-gaap:Assets", 1000],
  ["Accounts payable", "us-gaap:AccountsPayableCurrent", 50],
  ["Current loans", "us-gaap:LoansPayableCurrent", 10],
  ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 60],
  ["Long-term debt", "us-gaap:LongTermDebtNoncurrent", 90],
  ["Notes payable", "us-gaap:LongTermNotesPayable", 10],
  ["Total liabilities", "us-gaap:Liabilities", 160],
];
const NOTES_GAAP = {
  LoansPayableCurrent: [sameJune(10_000)],
  LongTermDebtNoncurrent: [sameJune(90_000)],
  LongTermNotesPayable: [sameJune(10_000)],
};
const LEASE_ROWS: readonly Row[] = [
  ["Total assets", "us-gaap:Assets", 1000],
  ["Accounts payable", "us-gaap:AccountsPayableCurrent", 50],
  ["Current debt", "us-gaap:DebtCurrent", 10],
  ["Current finance lease liabilities", "us-gaap:FinanceLeaseLiabilityCurrent", 5],
  ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 65],
  ["Loans payable", "us-gaap:LongTermLoansPayable", 90],
  ["Total liabilities", "us-gaap:Liabilities", 155],
];
const LEASE_GAAP = {
  DebtCurrent: [sameJune(10_000)],
  FinanceLeaseLiabilityCurrent: [sameJune(5000)],
  LongTermLoansPayable: [sameJune(90_000)],
};

describe("complete resolution checked against a same-filing face", () => {
  test("a separate notes row beside LongTermDebtNoncurrent withholds the 100 sum", () => {
    const { debt, notes } = derive(NOTES_GAAP, [faceFiling(SAME_ACCN, "2026-06-30", NOTES_ROWS)]);
    expect(debt).toBeUndefined();
    expect(notes).toContainEqual(
      expect.objectContaining({
        code: "incomplete-composite-series",
        message: expect.stringContaining("LongTermNotesPayable outside the resolved debt lines"),
      }),
    );
  });

  test("without a face the notes row stays subsumed", () => {
    expect(derive(NOTES_GAAP, []).debt?.value).toBe(100_000);
  });

  test("a separate face finance lease is not deducted: 10 + 90", () => {
    const { debt, gaps } = derive(LEASE_GAAP, [faceFiling(SAME_ACCN, "2026-06-30", LEASE_ROWS)]);
    expect(debt).toMatchObject({ value: 100_000, concept: "DebtCurrent+LongTermLoansPayable" });
    expect(gaps).toEqual([]);
    expect(debt?.sourceIds).toContain(`sec-filing-${SAME_ACCN}`);
  });

  test.each([
    ["no face", []],
    ["a face from another filing", [faceFiling("0000000000-26-000002", "2026-06-30", LEASE_ROWS)]],
  ] as const)("with %s the lease is still deducted: 95", (_case, filings) => {
    expect(derive(LEASE_GAAP, filings).debt?.value).toBe(95_000);
  });

  test("a current face lease leaves the noncurrent lease deduction: 10 + 90 - 5", () => {
    const rows = withRow(
      withRow(
        withRow(LEASE_ROWS, "us-gaap:LongTermLoansPayable", [
          "Long-term debt and finance leases",
          "us-gaap:LongTermDebtAndCapitalLeaseObligations",
          90,
        ]),
        "us-gaap:DebtCurrent",
        ["Current loans", "us-gaap:LoansPayableCurrent", 10],
      ),
      "us-gaap:FinanceLeaseLiabilityCurrent",
      ["Current finance lease liabilities", "us-gaap:FinanceLeaseLiabilityCurrent", 2],
    ).map(
      (row): Row =>
        row[1] === "us-gaap:LiabilitiesCurrent"
          ? [row[0], row[1], 62]
          : row[1] === "us-gaap:Liabilities"
            ? [row[0], row[1], 152]
            : row,
    );
    const gaap = {
      LoansPayableCurrent: [sameJune(10_000)],
      FinanceLeaseLiabilityCurrent: [sameJune(2000)],
      LongTermDebtAndCapitalLeaseObligations: [sameJune(90_000)],
      FinanceLeaseLiabilityNoncurrent: [sameJune(5000)],
    };
    expect(derive(gaap, [faceFiling(SAME_ACCN, "2026-06-30", rows)]).debt?.value).toBe(95_000);
  });

  describe("a total lease deducted beside a split face lease row", () => {
    const rows: readonly Row[] = [
      ["Total assets", "us-gaap:Assets", 1000],
      ["Accounts payable", "us-gaap:AccountsPayableCurrent", 50],
      ["Current finance lease liabilities", "us-gaap:FinanceLeaseLiabilityCurrent", 2],
      ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 52],
      ["Debt and finance leases", "us-gaap:DebtAndCapitalLeaseObligations", 100],
      ["Total liabilities", "us-gaap:Liabilities", 152],
    ];
    const gaap = {
      DebtAndCapitalLeaseObligations: [sameJune(100_000)],
      FinanceLeaseLiabilityCurrent: [sameJune(2000)],
      FinanceLeaseLiability: [sameJune(7000)],
    };

    test("withholds rather than removing the face's current part: not 100 - 7", () => {
      const { debt, gaps } = derive(gaap, [faceFiling(SAME_ACCN, "2026-06-30", rows)]);
      expect(debt).toBeUndefined();
      expect(gaps[0]?.message).toContain(
        "presents FinanceLeaseLiabilityCurrent on its own row, so the part of FinanceLeaseLiability",
      );
    });

    test.each([
      ["no face", []],
      ["a face from another filing", [faceFiling("0000000000-26-000002", "2026-06-30", rows)]],
    ] as const)("with %s the total is still deducted: 93", (_case, filings) => {
      expect(derive(gaap, filings).debt?.value).toBe(93_000);
    });
  });

  test("a tagged amount that differs from its face row withholds it", () => {
    const gaap = { ...LEASE_GAAP, DebtCurrent: [sameJune(15_000)] };
    const { debt, notes } = derive(gaap, [faceFiling(SAME_ACCN, "2026-06-30", LEASE_ROWS)]);
    expect(debt).toBeUndefined();
    expect(notes).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("face statement amounts differ from tagged DebtCurrent"),
      }),
    );
  });

  test("a zero face notes row leaves 10 + 90", () => {
    const rows = withRow(NOTES_ROWS, "us-gaap:LongTermNotesPayable", [
      "Notes payable",
      "us-gaap:LongTermNotesPayable",
      0,
    ]).map((row): Row => (row[1] === "us-gaap:Liabilities" ? [row[0], row[1], 150] : row));
    const gaap = { ...NOTES_GAAP, LongTermNotesPayable: [sameJune(0)] };
    expect(derive(gaap, [faceFiling(SAME_ACCN, "2026-06-30", rows)]).debt?.value).toBe(100_000);
  });

  test("a labelled extension notes row beside the lines withholds it", () => {
    const rows = withRow(NOTES_ROWS, "us-gaap:LongTermNotesPayable", [
      "Notes payable",
      "test:NotesPayableNoncurrent",
      10,
    ]);
    const { LongTermNotesPayable: _notes, ...gaap } = NOTES_GAAP;
    const { debt, notes } = derive(gaap, [faceFiling(SAME_ACCN, "2026-06-30", rows)]);
    expect(debt).toBeUndefined();
    expect(notes).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("NotesPayableNoncurrent") }),
    );
  });

  test("a current face lease keeps the noncurrent possible-lease gap", () => {
    const rows = withRow(LEASE_ROWS, "us-gaap:LongTermLoansPayable", [
      "Long-term debt and finance leases",
      "us-gaap:LongTermDebtAndCapitalLeaseObligations",
      90,
    ]);
    const gaap = {
      DebtCurrent: [sameJune(10_000)],
      FinanceLeaseLiabilityCurrent: [sameJune(5000)],
      LongTermDebtAndCapitalLeaseObligations: [sameJune(90_000)],
    };
    const { debt, gaps } = derive(gaap, [faceFiling(SAME_ACCN, "2026-06-30", rows)]);
    expect(debt?.value).toBe(100_000);
    expect(gaps).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("LongTermDebtAndCapitalLeaseObligations is tagged"),
      }),
    ]);
    expect(gaps[0]?.message).not.toContain("DebtCurrent");
  });

  test("a neutral extension row beside the lines keeps 10 + 90", () => {
    const rows = withRow(LEASE_ROWS, "us-gaap:AccountsPayableCurrent", [
      "Deferred revenue",
      "test:DeferredRevenueCurrent",
      50,
    ]);
    expect(derive(LEASE_GAAP, [faceFiling(SAME_ACCN, "2026-06-30", rows)]).debt?.value).toBe(
      100_000,
    );
  });

  test("a credit-facility extension neither name nor label calls debt withholds it", () => {
    const rows = withRow(LEASE_ROWS, "us-gaap:AccountsPayableCurrent", [
      "Revolving credit facility",
      "test:CreditFacility",
      50,
    ]);
    const { debt, notes } = derive(LEASE_GAAP, [faceFiling(SAME_ACCN, "2026-06-30", rows)]);
    expect(debt).toBeUndefined();
    expect(notes).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("CreditFacility as a possible borrowing"),
      }),
    );
  });

  test("an extension hinting at borrowing in its label only withholds it", () => {
    const rows = withRow(LEASE_ROWS, "us-gaap:AccountsPayableCurrent", [
      "Credit facility",
      "test:OtherLiabilitiesCurrent",
      50,
    ]);
    expect(derive(LEASE_GAAP, [faceFiling(SAME_ACCN, "2026-06-30", rows)]).debt).toBeUndefined();
  });

  test("an extension row sharing a standard local name still withholds it", () => {
    const rows = withRow(NOTES_ROWS, "us-gaap:LongTermNotesPayable", [
      "Other long-term debt",
      "test:LongTermDebtNoncurrent",
      10,
    ]);
    const { LongTermNotesPayable: _notes, ...gaap } = NOTES_GAAP;
    expect(derive(gaap, [faceFiling(SAME_ACCN, "2026-06-30", rows)]).debt).toBeUndefined();
  });
});

const QCOM_ACCN = "0000804328-26-000086";
const QCOM_ROWS: readonly Row[] = [
  ["Total assets", "us-gaap:Assets", 57_367_000],
  ["Trade accounts payable", "us-gaap:AccountsPayableCurrent", 8_924_000],
  ["Short-term debt", "us-gaap:DebtCurrent", 2_489_000],
  ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 11_413_000],
  ["Long-term debt", "us-gaap:LongTermDebt", 12_781_000],
  ["Other liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 5_515_000],
  ["Total liabilities", "us-gaap:Liabilities", 29_709_000],
];
const qcomJune = (value: number, accn = QCOM_ACCN) => fact(value, "2026-06-28", "2026-07-29", accn);
const QCOM_GAAP = {
  CommercialPaper: [qcomJune(498_000_000)],
  DebtCurrent: [qcomJune(2_489_000_000)],
  LongTermDebt: [qcomJune(12_781_000_000)],
  LongTermDebtCurrent: [qcomJune(1_991_000_000)],
};

const RKLB_ACCN = "0001819994-26-000062";
const RKLB_ROWS: readonly Row[] = [
  ["Total assets", "us-gaap:Assets", 4_187_374],
  ["Other current liabilities", "us-gaap:OtherLiabilitiesCurrent", 528_196],
  ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 528_196],
  ["Convertible senior notes, net", "us-gaap:LongTermDebt", 13_129],
  ["Long-term borrowings, net", "us-gaap:LongTermDebtNoncurrent", 1716],
  ["Other non-current liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 152_180],
  ["Total liabilities", "us-gaap:Liabilities", 695_221],
];
const RKLB_GAAP = {
  LongTermDebt: [fact(13_129_000, "2026-06-30", "2026-08-10", RKLB_ACCN)],
  LongTermDebtNoncurrent: [fact(1_716_000, "2026-06-30", "2026-08-10", RKLB_ACCN)],
};

const GPN_ACCN = "0001123360-26-000084";
const GPN_ROWS: readonly Row[] = [
  ["Total assets", "us-gaap:Assets", 50_000_000],
  ["Accounts payable", "us-gaap:AccountsPayableCurrent", 3_000_000],
  ["Lines of credit", "us-gaap:LinesOfCreditCurrent", 1_136_764],
  [
    "Current portion of long-term debt",
    "us-gaap:LongTermDebtAndCapitalLeaseObligationsCurrent",
    925_032,
  ],
  ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 5_061_796],
  ["Long-term debt", "us-gaap:LongTermDebtAndCapitalLeaseObligations", 21_493_294],
  ["Other noncurrent liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 2_000_000],
  ["Total liabilities", "us-gaap:Liabilities", 28_555_090],
];
const gpnJune = (value: number) => fact(value, "2026-06-30", "2026-08-05", GPN_ACCN);
const GPN_GAAP = {
  LinesOfCreditCurrent: [gpnJune(1_136_764_000)],
  LongTermDebtAndCapitalLeaseObligationsCurrent: [gpnJune(925_032_000)],
  LongTermDebtAndCapitalLeaseObligations: [gpnJune(21_493_294_000)],
  LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [gpnJune(22_418_326_000)],
  FinanceLeaseLiability: [gpnJune(34_976_000)],
};

describe("same-concept face rows settle LongTermDebt scope and current placement", () => {
  test("QCOM 10-Q 0000804328-26-000086 2026-06-28: DebtCurrent 2,489M + LongTermDebt 12,781M", () => {
    expect(derive(QCOM_GAAP, []).debt).toBeUndefined();
    const { debt } = derive(QCOM_GAAP, [faceFiling(QCOM_ACCN, "2026-06-28", QCOM_ROWS)]);
    expect(debt?.value).toBe(15_270_000_000);
    expect(debt?.periodEnd).toBe("2026-06-28");
  });

  test("RKLB 10-Q 0001819994-26-000062 2026-06-30: two noncurrent face rows, 14,845k", () => {
    expect(derive(RKLB_GAAP, []).debt).toBeUndefined();
    const { debt } = derive(RKLB_GAAP, [faceFiling(RKLB_ACCN, "2026-06-30", RKLB_ROWS)]);
    expect(debt?.value).toBe(14_845_000);
  });

  test("GPN 10-Q 0001123360-26-000084 2026-06-30 stays withheld: its total is off the face", () => {
    expect(derive(GPN_GAAP, []).debt).toBeUndefined();
    expect(derive(GPN_GAAP, [faceFiling(GPN_ACCN, "2026-06-30", GPN_ROWS)]).debt).toBeUndefined();
  });

  test("an off-face total is never face-backed: the face leaves it as without a face", () => {
    const gaap = {
      ...QCOM_GAAP,
      DebtLongtermAndShorttermCombinedAmount: [qcomJune(15_270_000_000)],
    };
    const { debt } = derive(gaap, [faceFiling(QCOM_ACCN, "2026-06-28", QCOM_ROWS)]);
    expect(debt).toEqual(derive(gaap, []).debt);
    expect(debt?.sourceIds).not.toContain(`sec-filing-${QCOM_ACCN}`);
  });

  test.each([
    ["a face from another filing", [faceFiling("0000804328-26-000001", "2026-06-28", QCOM_ROWS)]],
    [
      "a face row whose amount differs",
      [
        faceFiling(
          QCOM_ACCN,
          "2026-06-28",
          withRow(
            withRow(QCOM_ROWS, "us-gaap:LongTermDebt", [
              "Long-term debt",
              "us-gaap:LongTermDebt",
              12_780_000,
            ]),
            "us-gaap:OtherLiabilitiesNoncurrent",
            ["Other liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 5_516_000],
          ),
        ),
      ],
    ],
    [
      "an unfooted face",
      [
        faceFiling(
          QCOM_ACCN,
          "2026-06-28",
          withRow(QCOM_ROWS, "us-gaap:Liabilities", [
            "Total liabilities",
            "us-gaap:Liabilities",
            1,
          ]),
        ),
      ],
    ],
    [
      "LongTermDebt on the current side of the face",
      [
        faceFiling(QCOM_ACCN, "2026-06-28", [
          ["Total assets", "us-gaap:Assets", 57_367_000],
          ["Short-term debt", "us-gaap:DebtCurrent", 2_489_000],
          ["Long-term debt", "us-gaap:LongTermDebt", 12_781_000],
          ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 15_270_000],
          ["Other liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 14_439_000],
          ["Total liabilities", "us-gaap:Liabilities", 29_709_000],
        ]),
      ],
    ],
  ] as const)("QCOM stays withheld with %s", (_case, filings) => {
    expect(derive(QCOM_GAAP, filings).debt).toBeUndefined();
  });

  test("an instrument that is not its own face row stays withheld (AMAT-like)", () => {
    const accn = "0001628280-26-058235";
    const june = (value: number) => fact(value, "2026-07-26", "2026-08-20", accn);
    const rows: readonly Row[] = [
      ["Total assets", "us-gaap:Assets", 40_000_000],
      ["Accounts payable", "us-gaap:AccountsPayableCurrent", 5_000_000],
      ["Short-term borrowings and current debt", "us-gaap:ShortTermBorrowings", 1_299_000],
      ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 6_299_000],
      ["Long-term debt", "us-gaap:LongTermDebtNoncurrent", 5_245_000],
      ["Total liabilities", "us-gaap:Liabilities", 11_544_000],
    ];
    const gaap = {
      ShortTermBorrowings: [june(1_299_000_000)],
      LongTermDebtCurrent: [june(1_199_000_000)],
      LongTermDebtNoncurrent: [june(5_245_000_000)],
    };
    expect(derive(gaap, []).debt).toBeUndefined();
    expect(derive(gaap, [faceFiling(accn, "2026-07-26", rows)]).debt).toBeUndefined();
  });
});

describe("face-row placement review cases", () => {
  test("LongTermDebt already the noncurrent generic is not counted twice", () => {
    const june = (value: number) => fact(value, "2026-06-28", "2026-07-29", QCOM_ACCN);
    const rows: readonly Row[] = [
      ["Total assets", "us-gaap:Assets", 500],
      ["Accounts payable", "us-gaap:AccountsPayableCurrent", 40],
      ["Short-term debt", "us-gaap:DebtCurrent", 10],
      ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 50],
      ["Long-term debt", "us-gaap:LongTermDebt", 90],
      ["Notes payable", "us-gaap:LongTermNotesPayable", 0],
      ["Total liabilities", "us-gaap:Liabilities", 140],
    ];
    const gaap = {
      DebtCurrent: [june(10_000)],
      LongTermDebt: [june(90_000)],
      LongTermNotesPayable: [june(0)],
    };
    expect(derive(gaap, [faceFiling(QCOM_ACCN, "2026-06-28", rows)]).debt).toMatchObject({
      value: 100_000,
      concept: "DebtCurrent+LongTermDebt",
    });
  });

  test("GPN with an off-face total that misses the face legs stays withheld", () => {
    const gaap = {
      ...GPN_GAAP,
      LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [gpnJune(22_500_000_000)],
    };
    expect(derive(gaap, [faceFiling(GPN_ACCN, "2026-06-30", GPN_ROWS)]).debt).toBeUndefined();
  });

  test.each([
    "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities",
    "FinanceLeaseLiability",
  ] as const)("GPN with %s from another filing stays withheld", (concept) => {
    const value = GPN_GAAP[concept][0]?.val ?? 0;
    const gaap = {
      ...GPN_GAAP,
      [concept]: [fact(value, "2026-06-30", "2026-08-05", "0001123360-26-000099")],
    };
    expect(derive(gaap, [faceFiling(GPN_ACCN, "2026-06-30", GPN_ROWS)]).debt).toBeUndefined();
  });
});

const withheldJune = <T extends { message: string }>(gaps: readonly T[]) =>
  gaps.filter((gap) =>
    gap.message.startsWith("SEC debt withheld: the newest debt instant 2026-06-28"),
  );

describe("the SEC summary's debt reading follows the face-aware statements", () => {
  const face = derive(QCOM_GAAP, [faceFiling(QCOM_ACCN, "2026-06-28", QCOM_ROWS)]);
  const faceless = derive(QCOM_GAAP, []);
  const summaryGaps = (faceless.summary?.gaps ?? []).map((gap) => ({
    ...gap,
    symbol: "TEST",
    evidenceQualityImpact: "extended-evidence-cap" as const,
  }));

  test("QCOM face: the faceless withheld gap gives way to the statements' gaps", () => {
    expect(withheldJune(summaryGaps)).toHaveLength(1);
    const gaps = withStatementDebtBasisGaps(summaryGaps, face.artifact);
    expect(withheldJune(gaps)).toEqual([]);
    expect(
      gaps.filter((gap) => gap.message.startsWith("SEC debt")).map((gap) => gap.message),
    ).toEqual(face.gaps.map((gap) => gap.message));
    expect(gaps.every((gap) => gap.evidenceQualityImpact === "extended-evidence-cap")).toBe(true);
    const item = withCanonicalFinancialLensInputs(
      {
        items: [
          {
            category: "sec-edgar",
            title: "TEST SEC",
            summary: faceless.summary?.summary ?? "",
            sourceIds: ["sec"],
            observedAt: AS_OF,
            metrics: faceless.summary?.metrics,
          } as ExtendedEvidenceItem,
        ],
        gaps: [],
      },
      face.artifact,
    ).items[0];
    expect(item?.summary).toContain("debt 15270000000");
    expect(item?.metrics?.debtIncompletePeriodEnd).toBeUndefined();
  });

  test("another symbol's debt gap is not the statements' to replace", () => {
    const peer = { ...withheldJune(summaryGaps)[0]!, symbol: "PEER" };
    expect(withStatementDebtBasisGaps([...summaryGaps, peer], face.artifact)).toContainEqual(peer);
  });

  test("without a face, or without enrichment, the summary gaps stand unchanged", () => {
    expect(withStatementDebtBasisGaps(summaryGaps, faceless.artifact)).toBe(summaryGaps);
    expect(withStatementDebtBasisGaps(summaryGaps, undefined)).toBe(summaryGaps);
  });
});

const NVDA_ACCN = "0001045810-26-000075";
const NVDA_ROWS: readonly Row[] = [
  ["Total assets", "us-gaap:Assets", 200_000_000],
  ["Accounts payable", "us-gaap:AccountsPayableCurrent", 20_000_000],
  ["Short-term debt", "us-gaap:DebtCurrent", 1_000_000],
  ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 21_000_000],
  ["Long-term debt", "us-gaap:LongTermDebtNoncurrent", 32_366_000],
  ["Other long-term liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 10_918_000],
  ["Total liabilities", "us-gaap:Liabilities", 64_284_000],
];
const nvdaJuly = (value: number) => fact(value, "2026-07-26", "2026-08-27", NVDA_ACCN);
const NVDA_GAAP = {
  DebtCurrent: [nvdaJuly(1_000_000_000)],
  LongTermDebt: [nvdaJuly(33_366_000_000)],
  LongTermDebtNoncurrent: [nvdaJuly(32_366_000_000)],
};
const NVDA_NOTES_ROWS = withRow(NVDA_ROWS, "us-gaap:OtherLiabilitiesNoncurrent", [
  "Notes payable",
  "us-gaap:LongTermNotesPayable",
  10_918_000,
]);
const NVDA_NOTES_GAAP = { ...NVDA_GAAP, LongTermNotesPayable: [nvdaJuly(10_918_000_000)] };

describe("an off-face complete total checked against same-filing face rows", () => {
  test("NVDA 10-Q 0001045810-26-000075 2026-07-26: LongTermDebt 33,366M equals face 1,000M + 32,366M", () => {
    const { debt } = derive(NVDA_GAAP, [faceFiling(NVDA_ACCN, "2026-07-26", NVDA_ROWS)]);
    expect(debt).toMatchObject({ value: 33_366_000_000, concept: "LongTermDebt" });
  });

  test("a face notes row the off-face total leaves out withholds it", () => {
    expect(derive(NVDA_NOTES_GAAP, []).debt?.value).toBe(33_366_000_000);
    const { debt, notes } = derive(NVDA_NOTES_GAAP, [
      faceFiling(NVDA_ACCN, "2026-07-26", NVDA_NOTES_ROWS),
    ]);
    expect(debt).toBeUndefined();
    expect(notes).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("face statement debt rows total 44284000000"),
      }),
    );
  });

  test.each([
    ["no face", []],
    [
      "a face from another filing",
      [faceFiling("0001045810-26-000001", "2026-07-26", NVDA_NOTES_ROWS)],
    ],
    [
      "an unfooted face",
      [
        faceFiling(
          NVDA_ACCN,
          "2026-07-26",
          withRow(NVDA_NOTES_ROWS, "us-gaap:Liabilities", [
            "Total liabilities",
            "us-gaap:Liabilities",
            1,
          ]),
        ),
      ],
    ],
  ] as const)("%s keeps today's 33,366M", (_name, filings) => {
    expect(derive(NVDA_NOTES_GAAP, filings).debt?.value).toBe(33_366_000_000);
  });

  test("face legs keep 93,000; a lease deduction from an off-face 100,000 total withholds it", () => {
    const rows: readonly Row[] = [
      ["Total assets", "us-gaap:Assets", 1000],
      ["Accounts payable", "us-gaap:AccountsPayableCurrent", 50],
      ["Current debt", "us-gaap:DebtCurrent", 10],
      ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 60],
      ["Long-term debt and finance leases", "us-gaap:LongTermDebtAndCapitalLeaseObligations", 90],
      ["Total liabilities", "us-gaap:Liabilities", 150],
    ];
    const gaap = {
      DebtCurrent: [sameJune(10_000)],
      LongTermDebtAndCapitalLeaseObligations: [sameJune(90_000)],
      FinanceLeaseLiabilityCurrent: [sameJune(2000)],
      FinanceLeaseLiabilityNoncurrent: [sameJune(5000)],
    };
    const face = [faceFiling(SAME_ACCN, "2026-06-30", rows)];
    expect(derive(gaap, face).debt?.value).toBe(93_000);
    const withTotal = {
      ...gaap,
      LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [sameJune(100_000)],
    };
    expect(derive(withTotal, face).debt).toBeUndefined();
  });

  test("face rows that sum with float error still match: 1.001 + 1.001 at scale 3 is 2,002", () => {
    const rows = withRow(
      withRow(NVDA_ROWS, "us-gaap:DebtCurrent", ["Short-term debt", "us-gaap:DebtCurrent", 1.001]),
      "us-gaap:LongTermDebtNoncurrent",
      ["Long-term debt", "us-gaap:LongTermDebtNoncurrent", 1.001],
    ).map(
      ([label, concept, value]): Row =>
        concept === "us-gaap:LiabilitiesCurrent"
          ? [label, concept, 20_000_001.001]
          : concept === "us-gaap:Liabilities"
            ? [label, concept, 30_918_002.002]
            : [label, concept, value],
    );
    const gaap = {
      DebtCurrent: [nvdaJuly(1001)],
      LongTermDebt: [nvdaJuly(2002)],
      LongTermDebtNoncurrent: [nvdaJuly(1001)],
    };
    expect(derive(gaap, [faceFiling(NVDA_ACCN, "2026-07-26", rows)]).debt?.value).toBe(2002);
  });

  const LEASE_FACE_ROWS: readonly Row[] = [
    ["Total assets", "us-gaap:Assets", 1000],
    ["Accounts payable", "us-gaap:AccountsPayableCurrent", 50],
    ["Current debt", "us-gaap:DebtCurrent", 10],
    ["Current finance lease liabilities", "us-gaap:FinanceLeaseLiabilityCurrent", 2],
    ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 62],
    ["Long-term debt", "us-gaap:LongTermDebtNoncurrent", 90],
    ["Finance lease liabilities", "us-gaap:FinanceLeaseLiabilityNoncurrent", 5],
    ["Total liabilities", "us-gaap:Liabilities", 157],
  ];
  const LEASES_IN_OTHER_ROWS: readonly Row[] = [
    ["Total assets", "us-gaap:Assets", 1000],
    ["Accounts payable", "us-gaap:AccountsPayableCurrent", 50],
    ["Current debt", "us-gaap:DebtCurrent", 10],
    ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 60],
    ["Long-term debt", "us-gaap:LongTermDebtNoncurrent", 90],
    ["Other liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 7],
    ["Total liabilities", "us-gaap:Liabilities", 157],
  ];
  const debtLegs = { DebtCurrent: [sameJune(10_000)], LongTermDebtNoncurrent: [sameJune(90_000)] };
  const splitLeases = {
    FinanceLeaseLiabilityCurrent: [sameJune(2000)],
    FinanceLeaseLiabilityNoncurrent: [sameJune(5000)],
  };
  const offFaceTotal = (value: number) => ({
    LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [sameJune(value)],
  });
  test.each([
    [
      "a lease-inclusive 107,000 beside face leases",
      LEASE_FACE_ROWS,
      { ...splitLeases, ...offFaceTotal(107_000) },
    ],
    [
      "a lease-exclusive 100,000 beside face leases",
      LEASE_FACE_ROWS,
      { ...splitLeases, ...offFaceTotal(100_000) },
    ],
    [
      "9,000 deducted where the face shows 7,000 of leases",
      LEASE_FACE_ROWS,
      { FinanceLeaseLiability: [sameJune(9000)], ...offFaceTotal(107_000) },
    ],
    [
      "leases inside other liabilities under a 102,000 total",
      LEASES_IN_OTHER_ROWS,
      { FinanceLeaseLiability: [sameJune(7000)], ...offFaceTotal(102_000) },
    ],
    [
      "9,000 deducted from another filing",
      LEASE_FACE_ROWS,
      {
        ...splitLeases,
        FinanceLeaseLiability: [sameJune(9000, "0000000000-26-000002")],
        ...offFaceTotal(107_000),
      },
    ],
  ] as const)("a lease deduction from an off-face total withholds it: %s", (_name, rows, gaap) => {
    const { debt, notes } = derive({ ...debtLegs, ...gaap }, [
      faceFiling(SAME_ACCN, "2026-06-30", rows),
    ]);
    expect(debt?.periodEnd).not.toBe("2026-06-30");
    expect(notes).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("lease deduction from an off-face total is not proven"),
      }),
    );
  });
});

const ORCL_ACCN = "0001193125-26-389274";
const ORCL_ROWS: readonly Row[] = [
  ["Total assets", "us-gaap:Assets", 303_259_000],
  ["Notes payable, current", "us-gaap:NotesPayableCurrent", 7_625_000],
  ["Accounts payable", "us-gaap:AccountsPayableCurrent", 11_063_000],
  ["Accrued compensation", "us-gaap:EmployeeRelatedLiabilitiesCurrent", 1_760_000],
  ["Deferred revenues", "us-gaap:ContractWithCustomerLiabilityCurrent", 14_686_000],
  ["Other current liabilities", "us-gaap:OtherLiabilitiesCurrent", 12_380_000],
  ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 47_514_000],
  ["Notes payable and other borrowings", "us-gaap:LongTermNotesAndLoans", 117_712_000],
  ["Income taxes payable", "us-gaap:AccruedIncomeTaxesNoncurrent", 12_060_000],
  ["Operating lease liabilities", "us-gaap:OperatingLeaseLiabilityNoncurrent", 30_594_000],
  ["Other non-current liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 28_183_000],
  ["Total non-current liabilities", "us-gaap:LiabilitiesNoncurrent", 188_549_000],
];
const orclAug = (value: number, accn = ORCL_ACCN) => fact(value, "2026-08-31", "2026-09-11", accn);
const orclFy = (value: number) =>
  fact(value, "2026-05-31", "2026-06-22", "0001193125-26-277521", "10-K");
const ORCL_GAAP = {
  NotesPayableCurrent: [orclFy(7_199_000_000), orclAug(7_625_000_000)],
  LongTermNotesAndLoans: [orclFy(122_342_000_000), orclAug(117_712_000_000)],
  DebtCurrent: [orclFy(7_199_000_000)],
  LongTermNotesPayable: [orclFy(122_342_000_000)],
  DebtLongtermAndShorttermCombinedAmount: [orclFy(129_541_000_000)],
  SeniorNotes: [fact(42_749_000_000, "2026-02-28", "2026-03-11", "0001193125-26-101045")],
};

const augustDebt = (...args: Parameters<typeof derive>) =>
  financialStatementFacts(derive(...args).artifact.statements.balanceSheet.debt).find(
    ({ periodEnd }) => periodEnd === "2026-08-31",
  );

describe("ORCL 10-Q 0001193125-26-389274 2026-08-31: a face with no total-liabilities row", () => {
  test("foots on LiabilitiesNoncurrent and publishes 7,625M + 117,712M = 125,337M", () => {
    expect(augustDebt(ORCL_GAAP, [])).toBeUndefined();
    const { debt } = derive(ORCL_GAAP, [faceFiling(ORCL_ACCN, "2026-08-31", ORCL_ROWS)]);
    expect(debt).toMatchObject({ value: 125_337_000_000, periodEnd: "2026-08-31" });
    expect(debt?.accessionNumber).toBe(ORCL_ACCN);
  });

  test.each([
    [
      "a face from another filing",
      ORCL_GAAP,
      [faceFiling("0001193125-26-000001", "2026-08-31", ORCL_ROWS)],
    ],
    [
      "an unfooted face",
      ORCL_GAAP,
      [
        faceFiling(
          ORCL_ACCN,
          "2026-08-31",
          withRow(ORCL_ROWS, "us-gaap:LiabilitiesNoncurrent", [
            "Total non-current liabilities",
            "us-gaap:LiabilitiesNoncurrent",
            188_548_000,
          ]),
        ),
      ],
    ],
    [
      "an omitted concept still on the face",
      { ...ORCL_GAAP, SeniorNotes: [...ORCL_GAAP.SeniorNotes, orclAug(28_183_000_000)] },
      [
        faceFiling(
          ORCL_ACCN,
          "2026-08-31",
          withRow(ORCL_ROWS, "us-gaap:OtherLiabilitiesNoncurrent", [
            "Senior notes",
            "us-gaap:SeniorNotes",
            28_183_000,
          ]),
        ),
      ],
    ],
  ] as const)("%s stays withheld", (_name, gaap, filings) => {
    expect(augustDebt(gaap, filings)).toBeUndefined();
  });
});

const ORCL_CURRENT = ORCL_ROWS.slice(0, 7);
const orclFace = (html: string) =>
  ({
    sourceIds: [`sec-filing-${ORCL_ACCN}`],
    metrics: {
      accessionNumber: ORCL_ACCN,
      reportDate: "2026-08-31",
      ...secBalanceSheetFaceMetrics(html, "2026-08-31"),
    },
  }) as unknown as ExtendedEvidenceItem;
const orclRow = (row: Row) => withRow(ORCL_ROWS, "us-gaap:OtherLiabilitiesNoncurrent", row);

describe("ORCL face proof fails closed", () => {
  test("a noncurrent subtotal reached across an equity row emits no face", () => {
    const html = balanceSheet("2026-08-31", [
      ...ORCL_CURRENT,
      ["Stockholders' equity", "us-gaap:StockholdersEquity", 117_712_000],
      ["Total non-current liabilities", "us-gaap:LiabilitiesNoncurrent", 117_712_000],
    ]);
    expect(secBalanceSheetFaceMetrics(html, "2026-08-31")).toEqual({});
    expect(augustDebt(ORCL_GAAP, [orclFace(html)])).toBeUndefined();
  });

  test("a noncurrent subtotal from a later table emits no face", () => {
    const html = `${balanceSheet("2026-08-31", [
      ...ORCL_CURRENT,
      ["Other non-current liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 117_712_000],
    ])}<table><tr><td>Total</td>${cell("us-gaap:LiabilitiesNoncurrent", 117_712_000, "c")}</tr></table>`;
    expect(secBalanceSheetFaceMetrics(html, "2026-08-31")).toEqual({});
  });

  test.each([
    [
      "a mixed notes and lease row",
      "Notes payable and finance leases",
      "us-gaap:LongTermNotesAndFinanceLeaseLiabilities",
    ],
    [
      "a notes plus accrued interest row",
      "Notes payable and accrued interest",
      "us-gaap:NotesAndInterestPayableNoncurrentX",
    ],
    ["a loan commitments row", "Loan commitments", "us-gaap:LoanCommitments"],
    ["an unrecognized row labelled as borrowings", "Other borrowings", "us-gaap:OtherNoncurrentX"],
  ] as const)("%s withholds rather than publishing 7,625M", (_name, label, concept) => {
    const face = faceFiling(ORCL_ACCN, "2026-08-31", orclRow([label, concept, 28_183_000]));
    expect(augustDebt(ORCL_GAAP, [face])).toBeUndefined();
  });
});

describe("a rejected face never behaves like no face", () => {
  const mixed = (rows: readonly Row[], label: string, concept: string) =>
    withRow(
      rows,
      rows === NVDA_ROWS ? "us-gaap:OtherLiabilitiesNoncurrent" : "us-gaap:LongTermNotesPayable",
      [label, concept, 10_918_000],
    );

  test("NVDA off-face 33,366M beside a mixed notes-and-lease row withholds with a reason", () => {
    const rows = mixed(
      NVDA_NOTES_ROWS,
      "Notes payable and finance leases",
      "us-gaap:LongTermNotesAndFinanceLeaseLiabilities",
    );
    const { debt, notes } = derive(NVDA_GAAP, [faceFiling(NVDA_ACCN, "2026-07-26", rows)]);
    expect(debt).toBeUndefined();
    expect(notes).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "LongTermNotesAndFinanceLeaseLiabilities as a possible borrowing",
        ),
      }),
    );
  });

  test("a complete resolution whose same-filing face is rejected withholds", () => {
    const rows = mixed(NVDA_ROWS, "Loan commitments", "us-gaap:LoanCommitments");
    expect(derive(NVDA_GAAP, [faceFiling(NVDA_ACCN, "2026-07-26", NVDA_ROWS)]).debt?.value).toBe(
      33_366_000_000,
    );
    expect(derive(NVDA_GAAP, [faceFiling(NVDA_ACCN, "2026-07-26", rows)]).debt).toBeUndefined();
  });

  test("a rejected face from another filing leaves the resolution alone", () => {
    const rows = mixed(NVDA_ROWS, "Loan commitments", "us-gaap:LoanCommitments");
    const face = faceFiling("0001045810-26-000001", "2026-07-26", rows);
    expect(derive(NVDA_GAAP, [face]).debt?.value).toBe(33_366_000_000);
  });
});

test("a face with LiabilitiesNoncurrent but no current or total row emits nothing", () => {
  const html = balanceSheet("2026-08-31", [
    ["Total assets", "us-gaap:Assets", 100],
    ["Other", "us-gaap:OtherLiabilitiesNoncurrent", 40],
    ["Total non-current liabilities", "us-gaap:LiabilitiesNoncurrent", 40],
  ]);
  expect(secBalanceSheetFaceMetrics(html, "2026-08-31")).toEqual({});
});

test.each([
  ["a zero loan commitments row", "Loan commitments", "us-gaap:LoanCommitments", 0],
  [
    "an asset retirement obligations row",
    "Asset retirement obligations",
    "us-gaap:AssetRetirementObligationsNoncurrent",
    10_918_000,
  ],
  [
    "a blank-labelled accounts payable row",
    "<table><tr><td>(1)</td></tr></table>",
    "us-gaap:AccountsPayableCurrent",
    10_918_000,
  ],
] as const)("%s keeps NVDA's face-checked 33,366M", (_name, label, concept, value) => {
  const rows = withRow(NVDA_ROWS, "us-gaap:OtherLiabilitiesNoncurrent", [label, concept, value]);
  const fixed =
    value === 0
      ? [
          ...rows.slice(0, -1),
          ["Other", "us-gaap:OtherLiabilitiesNoncurrent", 10_918_000] as Row,
          rows.at(-1)!,
        ]
      : rows;
  expect(derive(NVDA_GAAP, [faceFiling(NVDA_ACCN, "2026-07-26", fixed)]).debt?.value).toBe(
    33_366_000_000,
  );
});

const ORCL_PRIOR_ROWS: readonly Row[] = [
  ["Total assets", "us-gaap:Assets", 261_759_000],
  ["Notes payable, current", "us-gaap:NotesPayableCurrent", 7_199_000],
  ["Accounts payable", "us-gaap:AccountsPayableCurrent", 10_977_000],
  ["Accrued compensation", "us-gaap:EmployeeRelatedLiabilitiesCurrent", 2_225_000],
  ["Deferred revenues", "us-gaap:ContractWithCustomerLiabilityCurrent", 9_916_000],
  ["Other current liabilities", "us-gaap:OtherLiabilitiesCurrent", 11_447_000],
  ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 41_764_000],
  ["Notes payable and other borrowings", "us-gaap:LongTermNotesAndLoans", 122_342_000],
  ["Income taxes payable", "us-gaap:AccruedIncomeTaxesNoncurrent", 11_771_000],
  ["Operating lease liabilities", "us-gaap:OperatingLeaseLiabilityNoncurrent", 26_648_000],
  ["Other non-current liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 16_178_000],
  ["Total non-current liabilities", "us-gaap:LiabilitiesNoncurrent", 176_939_000],
];

const twoColumnFace = (prior: readonly Row[]) =>
  [
    `<xbrli:context id="c"><xbrli:period><xbrli:instant>2026-08-31</xbrli:instant></xbrli:period></xbrli:context>`,
    `<xbrli:context id="p"><xbrli:period><xbrli:instant>2026-05-31</xbrli:instant></xbrli:period></xbrli:context>`,
    "<table>",
    ...ORCL_ROWS.map(
      ([label, concept, value], index) =>
        `<tr><td>${label}</td>${cell(concept, value, "c")}${cell(concept, prior[index]![2], "p")}</tr>`,
    ),
    "</table>",
  ].join("");

describe("ORCL 10-Q 0001193125-26-389274 prior-year-end column 2026-05-31", () => {
  const priorQ1 = (value: number) => fact(value, "2026-05-31", "2026-09-11", ORCL_ACCN);
  const gaap = {
    ...ORCL_GAAP,
    NotesPayableCurrent: [...ORCL_GAAP.NotesPayableCurrent, priorQ1(7_199_000_000)],
    LongTermNotesAndLoans: [...ORCL_GAAP.LongTermNotesAndLoans, priorQ1(122_342_000_000)],
  };
  const mayDebt = (prior: readonly Row[]) =>
    financialStatementFacts(
      derive(gaap, [orclFace(twoColumnFace(prior))]).artifact.statements.balanceSheet.debt,
    ).filter(({ periodEnd }) => periodEnd === "2026-05-31");

  test("the footed comparative column proves 7,199M + 122,342M = 129,541M", () => {
    expect(mayDebt(ORCL_PRIOR_ROWS)).toContainEqual(
      expect.objectContaining({ value: 129_541_000_000, accessionNumber: ORCL_ACCN }),
    );
  });

  test("an unfooted comparative column falls back to the 10-K its lines equal", () => {
    const rows = withRow(ORCL_PRIOR_ROWS, "us-gaap:LiabilitiesNoncurrent", [
      "Total non-current liabilities",
      "us-gaap:LiabilitiesNoncurrent",
      176_938_000,
    ]);
    expect(mayDebt(rows)).toEqual([
      expect.objectContaining({
        value: 129_541_000_000,
        accessionNumber: "0001193125-26-277521",
        form: "10-K",
      }),
    ]);
  });

  test("an unfooted comparative column that restates a 10-K line keeps it withheld", () => {
    const rows = withRow(ORCL_PRIOR_ROWS, "us-gaap:LiabilitiesNoncurrent", [
      "Total non-current liabilities",
      "us-gaap:LiabilitiesNoncurrent",
      176_938_000,
    ]);
    const restated = {
      ...gaap,
      NotesPayableCurrent: [...ORCL_GAAP.NotesPayableCurrent, priorQ1(7_200_000_000)],
    };
    expect(
      financialStatementFacts(
        derive(restated, [orclFace(twoColumnFace(rows))]).artifact.statements.balanceSheet.debt,
      ).filter(({ periodEnd }) => periodEnd === "2026-05-31"),
    ).toEqual([]);
  });
});

test("a prior-only borrowing row keeps its row label and withholds 2026-05-31", () => {
  const html = [
    `<xbrli:context id="c"><xbrli:period><xbrli:instant>2026-08-31</xbrli:instant></xbrli:period></xbrli:context>`,
    `<xbrli:context id="p"><xbrli:period><xbrli:instant>2026-05-31</xbrli:instant></xbrli:period></xbrli:context>`,
    "<table>",
    ...ORCL_ROWS.map(([label, concept, value], index) => {
      const prior = ORCL_PRIOR_ROWS[index]![2];
      const bumped = concept === "us-gaap:LiabilitiesNoncurrent" ? prior + 1_000_000 : prior;
      const extra =
        concept === "us-gaap:LiabilitiesNoncurrent"
          ? `<tr><td>Other borrowings</td><td></td>${cell("us-gaap:OtherNoncurrentX", 1_000_000, "p")}</tr>`
          : "";
      return `${extra}<tr><td>${label}</td>${cell(concept, value, "c")}${cell(concept, bumped, "p")}</tr>`;
    }),
    "</table>",
  ].join("");
  const metrics = secBalanceSheetFaceMetrics(html, "2026-08-31");
  expect(metrics["priorFaceLine|2026-05-31|noncurrent|us-gaap:OtherNoncurrentX"]).toBe(
    1_000_000_000,
  );
  expect(metrics["faceLabel|2026-05-31|us-gaap:OtherNoncurrentX"]).toContain("Other borrowings");
  const gaap = {
    ...ORCL_GAAP,
    NotesPayableCurrent: [
      ...ORCL_GAAP.NotesPayableCurrent,
      fact(7_199_000_000, "2026-05-31", "2026-09-11", ORCL_ACCN),
    ],
    LongTermNotesAndLoans: [
      ...ORCL_GAAP.LongTermNotesAndLoans,
      fact(122_342_000_000, "2026-05-31", "2026-09-11", ORCL_ACCN),
    ],
  };
  const may = financialStatementFacts(
    derive(gaap, [orclFace(html)]).artifact.statements.balanceSheet.debt,
  ).filter(({ periodEnd }) => periodEnd === "2026-05-31");
  expect(may).toEqual([]);
});

test("an unlabelled nonzero unrecognized face row withholds ORCL", () => {
  const face = faceFiling(
    ORCL_ACCN,
    "2026-08-31",
    orclRow(["", "us-gaap:OtherNoncurrentX", 28_183_000]),
  );
  expect(augustDebt(ORCL_GAAP, [face])).toBeUndefined();
});

test("a hidden label on an opaque unrecognized row withholds NVDA", () => {
  const label = "Other borrowings<table><tr><td>(1)</td></tr></table>";
  const rows = withRow(NVDA_ROWS, "us-gaap:OtherLiabilitiesNoncurrent", [
    label,
    "us-gaap:OtherNoncurrentX",
    10_918_000,
  ]);
  expect(derive(NVDA_GAAP, [faceFiling(NVDA_ACCN, "2026-07-26", rows)]).debt).toBeUndefined();
});

test("a nested footnote table in the label cell cannot hide a borrowing row", () => {
  const label = "Other borrowings<table><tr><td>(1)</td></tr></table>";
  const rows = withRow(NVDA_ROWS, "us-gaap:OtherLiabilitiesNoncurrent", [
    label,
    "us-gaap:OtherBorrowingsNoncurrentX",
    10_918_000,
  ]);
  expect(derive(NVDA_GAAP, [faceFiling(NVDA_ACCN, "2026-07-26", rows)]).debt).toBeUndefined();
});

test("a prior-column borrowing label is not overwritten by the current column's label", () => {
  const html = [
    `<xbrli:context id="c"><xbrli:period><xbrli:instant>2026-08-31</xbrli:instant></xbrli:period></xbrli:context>`,
    `<xbrli:context id="p"><xbrli:period><xbrli:instant>2026-05-31</xbrli:instant></xbrli:period></xbrli:context>`,
    "<table>",
    ...ORCL_ROWS.map(([label, concept, value], index) => {
      const prior = ORCL_PRIOR_ROWS[index]![2];
      if (concept === "us-gaap:OtherLiabilitiesNoncurrent") {
        return [
          `<tr><td>Other liabilities</td>${cell("us-gaap:OtherNoncurrentX", value, "c")}<td></td></tr>`,
          `<tr><td>Other non-current liabilities</td><td></td>${cell(concept, prior - 1_000_000, "p")}</tr>`,
          `<tr><td>Other borrowings</td><td></td>${cell("us-gaap:OtherNoncurrentX", 1_000_000, "p")}</tr>`,
        ].join("");
      }
      return `<tr><td>${label}</td>${cell(concept, value, "c")}${cell(concept, prior, "p")}</tr>`;
    }),
    "</table>",
  ].join("");
  const metrics = secBalanceSheetFaceMetrics(html, "2026-08-31");
  expect(metrics["priorFaceLine|2026-05-31|noncurrent|us-gaap:OtherNoncurrentX"]).toBe(
    1_000_000_000,
  );
  const gaap = {
    ...ORCL_GAAP,
    NotesPayableCurrent: [
      ...ORCL_GAAP.NotesPayableCurrent,
      fact(7_199_000_000, "2026-05-31", "2026-09-11", ORCL_ACCN),
    ],
    LongTermNotesAndLoans: [
      ...ORCL_GAAP.LongTermNotesAndLoans,
      fact(122_342_000_000, "2026-05-31", "2026-09-11", ORCL_ACCN),
    ],
  };
  const may = financialStatementFacts(
    derive(gaap, [orclFace(html)]).artifact.statements.balanceSheet.debt,
  ).filter(({ periodEnd }) => periodEnd === "2026-05-31");
  expect(may).toEqual([]);
});

test("a blank-labelled extension borrowing row rejects the face, so NVDA's 33,366M withholds", () => {
  const label = "Other borrowings<table><tr><td>(1)</td></tr></table>";
  const rows = withRow(NVDA_ROWS, "us-gaap:OtherLiabilitiesNoncurrent", [
    label,
    "nvda:OtherBorrowingsNoncurrent",
    10_918_000,
  ]);
  const { debt, notes } = derive(NVDA_GAAP, [faceFiling(NVDA_ACCN, "2026-07-26", rows)]);
  expect(debt).toBeUndefined();
  expect(notes).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining("OtherBorrowingsNoncurrent as a possible borrowing"),
    }),
  );
});

test("a blank-labelled row's prior label drops the current column's number, so 2026-05-31 withholds", () => {
  const html = [
    `<xbrli:context id="c"><xbrli:period><xbrli:instant>2026-08-31</xbrli:instant></xbrli:period></xbrli:context>`,
    `<xbrli:context id="p"><xbrli:period><xbrli:instant>2026-05-31</xbrli:instant></xbrli:period></xbrli:context>`,
    "<table>",
    ...ORCL_ROWS.map(([label, concept, value], index) => {
      const prior = ORCL_PRIOR_ROWS[index]![2];
      const extra = concept === "us-gaap:LiabilitiesNoncurrent" ? 1_000_000 : 0;
      const blank =
        extra === 0
          ? ""
          : `<tr><td></td>${cell("us-gaap:OtherNoncurrentX", 1_000_000, "c")}${cell("us-gaap:OtherNoncurrentX", 1_000_000, "p")}</tr>`;
      return `${blank}<tr><td>${label}</td>${cell(concept, value + extra, "c")}${cell(concept, prior + extra, "p")}</tr>`;
    }),
    "</table>",
  ].join("");
  const metrics = secBalanceSheetFaceMetrics(html, "2026-08-31");
  expect(metrics["faceLabel|2026-05-31|us-gaap:OtherNoncurrentX"]).toBe("");
  const gaap = {
    ...ORCL_GAAP,
    NotesPayableCurrent: [
      ...ORCL_GAAP.NotesPayableCurrent,
      fact(7_199_000_000, "2026-05-31", "2026-09-11", ORCL_ACCN),
    ],
    LongTermNotesAndLoans: [
      ...ORCL_GAAP.LongTermNotesAndLoans,
      fact(122_342_000_000, "2026-05-31", "2026-09-11", ORCL_ACCN),
    ],
  };
  expect(
    financialStatementFacts(
      derive(gaap, [orclFace(html)]).artifact.statements.balanceSheet.debt,
    ).filter(({ periodEnd }) => periodEnd === "2026-05-31"),
  ).toEqual([]);
});
