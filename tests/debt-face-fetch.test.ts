import { describe, expect, test } from "bun:test";
import type { ExtendedEvidenceItem } from "../src/domain/evidence";
import {
  DEBT_FACE_FETCH_CAP,
  collectSecDebtFaceFilings,
} from "../src/sources/evidence-request-tools";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { financialStatementFacts } from "../src/sources/extended-evidence/financial-statement-selection";
import {
  debtInstantsNeedingFace,
  financialStatementsDebtBasisGaps,
  withheldDebt,
} from "../src/sources/extended-evidence/sec-debt";
import { balanceSheetHistory, financialPosition } from "../src/report/equity-reader-statements";
import { assertCompositeFactIntegrity } from "../src/corpus/financial-statement-invariants";
import { secBalanceSheetFaceMetrics } from "../src/sources/sec-segment-facts";
import { collectFinancialStatements } from "../src/sources/collector-equity-enrichment";
import { valuationPeriodInputs } from "../src/sources/extended-evidence/valuation-workbench-inputs";
import type { CollectContext, SourceRequestExecutor } from "../src/sources/types";

type Row = readonly [label: string, concept: string, value: number];

const AS_OF = "2026-10-27T00:00:00.000Z";
const AUG_ACCN = "0001193125-26-389274";
const FY_ACCN = "0001193125-26-277521";
const QCOM_ACCN = "0000804328-26-000086";

const cell = (concept: string, value: number) =>
  `<td><ix:nonFraction name="${concept}" contextRef="c" unitRef="usd" scale="3">${value.toLocaleString("en-US")}</ix:nonFraction></td>`;
const balanceSheet = (periodEnd: string, rows: readonly Row[]) =>
  [
    `<xbrli:context id="c"><xbrli:entity></xbrli:entity><xbrli:period><xbrli:instant>${periodEnd}</xbrli:instant></xbrli:period></xbrli:context>`,
    "<table>",
    ...rows.map(([label, concept, value]) => `<tr><td>${label}</td>${cell(concept, value)}</tr>`),
    "</table>",
  ].join("");

// ORCL 10-Q 0001193125-26-389274 face, 2026-08-31.
const AUG_ROWS: readonly Row[] = [
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

const fact = (value: number, end: string, filed: string, accn: string, form = "10-Q") => ({
  val: value,
  end,
  filed,
  accn,
  form,
  fy: 2027,
  fp: form === "10-Q" ? "Q1" : "FY",
});
const aug = (value: number) => fact(value, "2026-08-31", "2026-09-11", AUG_ACCN);
const fy = (value: number) => fact(value, "2026-05-31", "2026-06-22", FY_ACCN, "10-K");
const GAAP = {
  Revenues: [
    { ...fy(57_000_000_000), start: "2025-06-01" },
    { ...aug(14_900_000_000), start: "2026-06-01" },
  ],
  NotesPayableCurrent: [fy(7_199_000_000), aug(7_625_000_000)],
  LongTermNotesAndLoans: [fy(122_342_000_000), aug(117_712_000_000)],
  DebtCurrent: [fy(7_199_000_000)],
  LongTermNotesPayable: [fy(122_342_000_000)],
  DebtLongtermAndShorttermCombinedAmount: [fy(129_541_000_000)],
};

function faceItem(accessionNumber: string, reportDate: string, rows: readonly Row[]) {
  return {
    sourceIds: [`sec-filing-${accessionNumber}`],
    metrics: { accessionNumber, reportDate },
    html: balanceSheet(reportDate, rows),
  };
}

async function derive(
  gaap: Readonly<Record<string, readonly Record<string, unknown>[]>>,
  faces: readonly ReturnType<typeof faceItem>[] = [],
) {
  return deriveItems(
    gaap,
    faces.map(
      ({ sourceIds, metrics, html }) =>
        ({
          sourceIds,
          metrics: { ...metrics, ...secBalanceSheetFaceMetrics(html, metrics.reportDate) },
        }) as unknown as ExtendedEvidenceItem,
    ),
  );
}

function deriveItems(
  gaap: Readonly<Record<string, readonly Record<string, unknown>[]>>,
  secFilings: readonly ExtendedEvidenceItem[],
) {
  return deriveFinancialStatements(
    {
      facts: {
        "us-gaap": Object.fromEntries(
          Object.entries(gaap).map(([concept, usd]) => [concept, { units: { USD: usd } }]),
        ),
      },
    },
    {
      symbol: "ORCL",
      generatedAt: AS_OF,
      analysisAsOf: AS_OF,
      sourceId: "sec",
      secFilings,
    },
  );
}

const augustDebt = (artifact: Awaited<ReturnType<typeof derive>>) =>
  financialStatementFacts(artifact.statements.balanceSheet.debt).find(
    ({ periodEnd }) => periodEnd === "2026-08-31",
  );

const gaapLoc = (name: string, label: string) =>
  `<link:loc xlink:href="https://xbrl.fasb.org/us-gaap/2025/elts/us-gaap-2025.xsd#us-gaap_${name}" xlink:label="${label}" xlink:type="locator"/>`;
const sumArc = (from: string, to: string, weight: string) =>
  `<link:calculationArc xlink:arcrole="http://www.xbrl.org/2003/arcrole/summation-item" xlink:from="${from}" xlink:to="${to}" weight="${weight}" xlink:type="arc"/>`;
const CASH_FLOW_CAL = `<link:calculationLink xlink:role="cf" xlink:type="extended">${gaapLoc("NetCashProvidedByUsedInInvestingActivitiesContinuingOperations", "i")}${gaapLoc("PaymentsToAcquireProductiveAssets", "x")}${gaapLoc("NetCashProvidedByUsedInOperatingActivities", "o")}${gaapLoc("DepreciationDepletionAndAmortization", "d")}${sumArc("i", "x", "-1.0")}${sumArc("o", "d", "1.0")}</link:calculationLink>`;

describe("debt instants withheld for want of a face", () => {
  test("ORCL 2026-08-31 without its 10-Q face asks for accession 0001193125-26-389274", async () => {
    const artifact = await derive(GAAP);
    expect(augustDebt(artifact)).toBeUndefined();
    expect(debtInstantsNeedingFace(artifact)).toContainEqual({
      periodEnd: "2026-08-31",
      accessionNumber: AUG_ACCN,
    });
  });

  test("its own face then publishes 7,625M + 117,712M = 125,337M and asks for nothing more", async () => {
    const artifact = await derive(GAAP, [faceItem(AUG_ACCN, "2026-08-31", AUG_ROWS)]);
    expect(augustDebt(artifact)).toMatchObject({ value: 125_337_000_000 });
    expect(debtInstantsNeedingFace(artifact).map(({ periodEnd }) => periodEnd)).not.toContain(
      "2026-08-31",
    );
  });

  test("an unrecognized borrowing tag at the instant is not face-fixable", async () => {
    const artifact = await derive({ ...GAAP, SeniorNotes: [aug(42_749_000_000)] });
    expect(augustDebt(artifact)).toBeUndefined();
    expect(debtInstantsNeedingFace(artifact).map(({ periodEnd }) => periodEnd)).not.toContain(
      "2026-08-31",
    );
  });

  // An amount bound proves no containment: SeniorNotes may sit in OtherLiabilitiesNoncurrent (28,183M).
  test.each([
    ["inside other liabilities", { SeniorNotes: [aug(28_183_000_000)] }],
    [
      "two tags summing above the face rows",
      { SeniorNotes: [aug(80_000_000_000)], SubordinatedDebt: [aug(80_000_000_000)] },
    ],
  ] as const)(
    "a footed face does not publish beside unrecognized tags %s",
    async (_name, extra) => {
      const artifact = await derive({ ...GAAP, ...extra }, [
        faceItem(AUG_ACCN, "2026-08-31", AUG_ROWS),
      ]);
      expect(augustDebt(artifact)).toBeUndefined();
    },
  );

  test("QCOM 0000804328-26-000086 with off-face CommercialPaper and LongTermDebtCurrent still asks for its face", async () => {
    const june = (value: number) => fact(value, "2026-06-28", "2026-07-29", QCOM_ACCN);
    const artifact = await derive({
      Revenues: [{ ...june(10_000_000_000), start: "2026-03-30" }],
      CommercialPaper: [june(498_000_000)],
      DebtCurrent: [june(2_489_000_000)],
      LongTermDebt: [june(12_781_000_000)],
      LongTermDebtCurrent: [june(1_991_000_000)],
    });
    expect(debtInstantsNeedingFace(artifact)).toEqual([
      { periodEnd: "2026-06-28", accessionNumber: QCOM_ACCN },
    ]);
  });

  test("an unresolved fetched FY face no longer blocks August's own fetch", async () => {
    const unresolvedFy = faceItem(FY_ACCN, "2026-05-31", [
      ["Total assets", "us-gaap:Assets", 1_000_000_000],
      ["Notes payable, current", "us-gaap:NotesPayableCurrent", 7_199_000],
      ["Other current liabilities", "us-gaap:OtherLiabilitiesCurrent", 1_000_000],
      ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 8_199_000],
      ["Bridge loan", "orcl:BridgeLoanNoncurrent", 1_000_000],
      ["Notes payable and other borrowings", "us-gaap:LongTermNotesAndLoans", 122_342_000],
      ["Total non-current liabilities", "us-gaap:LiabilitiesNoncurrent", 123_342_000],
    ]);
    const before = await derive(GAAP, [unresolvedFy]);
    expect(
      financialStatementFacts(before.statements.balanceSheet.debt).some(
        ({ periodEnd }) => periodEnd === "2026-05-31",
      ),
    ).toBe(false);
    expect(debtInstantsNeedingFace(before)).toContainEqual({
      periodEnd: "2026-08-31",
      accessionNumber: AUG_ACCN,
    });
    const after = await derive(GAAP, [unresolvedFy, faceItem(AUG_ACCN, "2026-08-31", AUG_ROWS)]);
    expect(augustDebt(after)).toMatchObject({ value: 125_337_000_000 });
  });

  test("a fetched face that only matches by amount still withholds (AMZN-like)", async () => {
    const hidden = AUG_ROWS.map(
      (row): Row =>
        row[1] === "us-gaap:NotesPayableCurrent"
          ? [
              "Accrued and other current liabilities",
              "us-gaap:OtherAccruedLiabilitiesCurrent",
              row[2],
            ]
          : row,
    );
    const artifact = await derive(GAAP, [faceItem(AUG_ACCN, "2026-08-31", hidden)]);
    expect(augustDebt(artifact)).toBeUndefined();
  });

  test("an instant outside the revenue history is not fetched", async () => {
    const { Revenues: _revenues, ...withoutRevenue } = GAAP;
    expect(debtInstantsNeedingFace(await derive(withoutRevenue))).toEqual([]);
  });
});

const CIK = "1341439";
const instant = (month: number) => {
  const periodEnd = `2026-0${String(month)}-28`;
  return { periodEnd, accessionNumber: `0001193125-26-00000${String(month)}` };
};

function submissions(instants: readonly { periodEnd: string; accessionNumber: string }[]) {
  return {
    filings: {
      recent: {
        form: instants.map(() => "10-Q"),
        filingDate: instants.map(() => "2026-09-11"),
        reportDate: instants.map(({ periodEnd }) => periodEnd),
        accessionNumber: instants.map(({ accessionNumber }) => accessionNumber),
        primaryDocument: instants.map(({ accessionNumber }) => `${accessionNumber}.htm`),
      },
    },
  };
}

function ctx(text: SourceRequestExecutor["text"]): CollectContext {
  return {
    command: { jobType: "equity", assetClass: "equity", symbol: "ORCL", depth: "deep" },
    fetchedAt: AS_OF,
    newsLimit: 2,
    cryptoMoverLimit: 2,
    request: {
      fetch: () => Promise.reject(new Error("unexpected base fetch")),
      json: async () => {
        throw new Error("unexpected json fetch");
      },
      text,
    },
  };
}

const faceText = (url: string, periodEnd: string) => ({
  rawSnapshot: { id: `raw-${url}`, adapter: "sec-filing-text", fetchedAt: AS_OF, payload: "" },
  payload: balanceSheet(periodEnd, AUG_ROWS),
});

describe("collectSecDebtFaceFilings", () => {
  test("reads at most 22 faces, one per filing, and declares the rest", async () => {
    const instants = Array.from({ length: 23 }, (_, index) => ({
      periodEnd: new Date(Date.UTC(2026, 8 - index, 28)).toISOString().slice(0, 10),
      accessionNumber: `0001193125-26-${String(index).padStart(6, "0")}`,
    }));
    const urls: string[] = [];
    const out = await collectSecDebtFaceFilings(
      ctx(async ({ url }) => {
        urls.push(url);
        return faceText(
          url,
          instants.find(({ accessionNumber }) => url.includes(accessionNumber.replaceAll("-", "")))!
            .periodEnd,
        );
      }),
      { cik: CIK, symbol: "ORCL", submissionsPayload: submissions(instants) },
      instants,
    );
    expect(DEBT_FACE_FETCH_CAP).toBe(22);
    expect(urls).toHaveLength(22);
    expect(out.items).toHaveLength(22);
    expect(new Set(out.sources.map(({ id }) => id)).size).toBe(22);
    expect(out.items[0]?.metrics?.accessionNumber).toBe(instants[0]?.accessionNumber);
    expect(out.gaps).toEqual([
      expect.objectContaining({
        cause: "suppressed-by-design",
        message: expect.stringContaining("past the 22-filing cap per run: 2024-11-28)"),
      }),
    ]);
  });

  test("a failed fetch publishes nothing and declares the instant", async () => {
    const [only] = [instant(8)];
    const out = await collectSecDebtFaceFilings(
      ctx(async () => ({ source: "sec-filing-text", message: "fetch failed" })),
      { cik: CIK, symbol: "ORCL", submissionsPayload: submissions([only!]) },
      [only!],
    );
    expect(out.items).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({
        cause: "fetch-failed",
        message: expect.stringContaining("fetch failed: 2026-08-28"),
      }),
    ]);
  });

  test("an amended or missing filing and an unfooted face are declared, not read", async () => {
    const [missing, unfooted] = [instant(7), instant(6)];
    const out = await collectSecDebtFaceFilings(
      ctx(async ({ url }) => ({ ...faceText(url, unfooted!.periodEnd), payload: "<html></html>" })),
      { cik: CIK, symbol: "ORCL", submissionsPayload: submissions([unfooted!]) },
      [missing!, unfooted!],
    );
    expect(out.items).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({
        cause: "provider-data-missing",
        message: expect.stringMatching(
          /no original 10-K\/10-Q in the submissions index: 2026-07-28.*no footed balance-sheet face: 2026-06-28/u,
        ),
      }),
    ]);
  });
});

// TDG FY2025 10-K 0001260221-25-000081 (report date 2025-09-30), companyfacts values in millions with its
// 2024-09-30 comparative column; lease placement as in the FY2026 10-K.
const TDG_CIK = "1260221";
const TDG_K25 = "0001260221-25-000081";
const TDG_K24 = "0001260221-24-000083";
type TdgRow = readonly [label: string, concept: string, fy2025: number | undefined, fy2024: number];
const TDG_ROWS: readonly TdgRow[] = [
  ["Total assets", "us-gaap:Assets", 22_909, 25_586],
  ["Accounts payable", "us-gaap:AccountsPayableCurrent", 368, 323],
  ["Accrued and other current liabilities", "us-gaap:AccruedLiabilitiesCurrent", 966, 1216],
  ["Dividends payable", "us-gaap:DividendsPayableCurrent", undefined, 4216],
  ["Current portion of long-term debt", "us-gaap:LongTermDebtCurrent", 124, 98],
  ["Short-term borrowings", "us-gaap:ShortTermBankLoansAndNotesPayable", 724, 486],
  ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 2182, 6339],
  ["Long-term debt", "us-gaap:LongTermDebtAndCapitalLeaseObligations", 29_167, 24_296],
  ["Deferred income taxes", "us-gaap:DeferredIncomeTaxLiabilitiesNet", 759, 766],
  ["Other non-current liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 480, 468],
  ["Total liabilities", "us-gaap:Liabilities", 32_588, 31_869],
];
const TDG_GAAP_ROWS: Readonly<Record<string, readonly [number | undefined, number]>> = {
  LongTermDebt: [29_291, 24_394],
  FinanceLeaseLiability: [284, 262],
  FinanceLeaseLiabilityCurrent: [8, 6],
  FinanceLeaseLiabilityNoncurrent: [276, 256],
  OperatingLeaseLiabilityCurrent: [15, 19],
  ...Object.fromEntries(
    TDG_ROWS.map(([, concept, fy2025, fy2024]) => [
      concept.replace("us-gaap:", ""),
      [fy2025, fy2024],
    ]),
  ),
};
const tdgFact = (millions: number, end: string, accn: string, filed: string) =>
  fact(millions * 1e6, end, filed, accn, "10-K");
const TDG_GAAP = {
  ...Object.fromEntries(
    Object.entries(TDG_GAAP_ROWS).map(([concept, [fy2025, fy2024]]) => [
      concept,
      [
        ...(fy2025 === undefined ? [] : [tdgFact(fy2025, "2025-09-30", TDG_K25, "2025-11-12")]),
        tdgFact(fy2024, "2024-09-30", TDG_K24, "2024-11-07"),
        tdgFact(fy2024, "2024-09-30", TDG_K25, "2025-11-12"),
      ],
    ]),
  ),
  Revenues: [
    { ...tdgFact(8831, "2025-09-30", TDG_K25, "2025-11-12"), start: "2024-10-01" },
    { ...tdgFact(7940, "2024-09-30", TDG_K24, "2024-11-07"), start: "2023-10-01" },
    { ...tdgFact(7940, "2024-09-30", TDG_K25, "2025-11-12"), start: "2023-10-01" },
  ],
};
const tdgCell = (concept: string, millions: number | undefined, context: string) =>
  millions === undefined
    ? "<td>—</td>"
    : `<td><ix:nonFraction name="${concept}" contextRef="${context}" unitRef="usd" scale="6">${millions.toLocaleString("en-US")}</ix:nonFraction></td>`;
const tdgFace = (
  rows: readonly TdgRow[] = TDG_ROWS,
  currentEnd = "2025-09-30",
  priorEnd = "2024-09-30",
) =>
  `${[
    ["c", currentEnd],
    ["p", priorEnd],
  ]
    .map(
      ([id, end]) =>
        `<xbrli:context id="${id}"><xbrli:entity></xbrli:entity><xbrli:period><xbrli:instant>${end}</xbrli:instant></xbrli:period></xbrli:context>` +
        `<ix:nonNumeric contextRef="${id}" name="us-gaap:FinanceLeaseLiabilityCurrentStatementOfFinancialPositionExtensibleList">http://fasb.org/us-gaap/2025#LongTermDebtCurrent</ix:nonNumeric>` +
        `<ix:nonNumeric contextRef="${id}" name="us-gaap:FinanceLeaseLiabilityNoncurrentStatementOfFinancialPositionExtensibleList">http://fasb.org/us-gaap/2025#LongTermDebtAndCapitalLeaseObligations</ix:nonNumeric>`,
    )
    .join(
      "",
    )}<table>${rows.map(([label, concept, fy2025, fy2024]) => `<tr><td>${label}</td>${tdgCell(concept, fy2025, "c")}${tdgCell(concept, fy2024, "p")}</tr>`).join("")}</table>`;
const tdgSubmissions = (form = "10-K", reportDate = "2025-09-30") => ({
  filings: {
    recent: {
      form: [form],
      filingDate: ["2025-11-12"],
      reportDate: [reportDate],
      accessionNumber: [TDG_K25],
      primaryDocument: ["tdg-20250930.htm"],
    },
  },
});
const TDG_Q1_25 = "0001260221-25-000014";
const tdgK24Submissions = (k24Inline = 1) => ({
  filings: {
    recent: {
      form: ["10-K", "10-Q", "10-K"],
      filingDate: ["2025-11-12", "2025-02-04", "2024-11-07"],
      reportDate: ["2025-09-30", "2024-12-28", "2024-09-30"],
      accessionNumber: [TDG_K25, TDG_Q1_25, TDG_K24],
      primaryDocument: ["tdg-20250930.htm", "tdg-20241228.htm", "tdg-20240930.htm"],
      isInlineXBRL: [1, 1, k24Inline],
    },
  },
});
const tdgSubmissionsWithK24 = () => ({
  filings: {
    recent: {
      form: ["10-K", "10-K"],
      filingDate: ["2025-11-12", "2024-11-07"],
      reportDate: ["2025-09-30", "2024-09-30"],
      accessionNumber: [TDG_K25, TDG_K24],
      primaryDocument: ["tdg-20250930.htm", "tdg-20240930.htm"],
    },
  },
});
const tdgDebt = (items: readonly ExtendedEvidenceItem[]) =>
  new Map(
    financialStatementFacts(deriveItems(TDG_GAAP, items).statements.balanceSheet.debt).map(
      (debt) => [debt.periodEnd, debt],
    ),
  );

async function tdgFaces(face = tdgFace(), submissionsPayload: unknown = tdgSubmissions()) {
  const urls: string[] = [];
  const out = await collectSecDebtFaceFilings(
    ctx(async ({ url }) => {
      urls.push(url);
      return { ...faceText(url, "2025-09-30"), payload: face };
    }),
    { cik: TDG_CIK, symbol: "ORCL", submissionsPayload },
    debtInstantsNeedingFace(deriveItems(TDG_GAAP, [])),
  );
  return { urls, out };
}

describe("TDG FY2025 10-K 0001260221-25-000081 comparative column 2024-09-30", () => {
  test("both withheld instants ask for the one 10-K that last filed their lines", () => {
    expect(debtInstantsNeedingFace(deriveItems(TDG_GAAP, []))).toEqual([
      { periodEnd: "2025-09-30", accessionNumber: TDG_K25 },
      { periodEnd: "2024-09-30", accessionNumber: TDG_K25 },
    ]);
  });

  test("withheld 2024-09-30 asks for the earliest comparative first, then its own iXBRL 10-K, unless read", () => {
    const artifact = deriveItems(TDG_GAAP, []);
    const at2024 = (secFilings: readonly ExtendedEvidenceItem[] = []) =>
      debtInstantsNeedingFace(artifact, tdgK24Submissions(), secFilings).filter(
        ({ periodEnd }) => periodEnd === "2024-09-30",
      );
    expect(at2024()).toEqual([
      { periodEnd: "2024-09-30", accessionNumber: TDG_Q1_25 },
      { periodEnd: "2024-09-30", accessionNumber: TDG_K24 },
    ]);
    const ownK24 = { metrics: { accessionNumber: TDG_K24 } } as unknown as ExtendedEvidenceItem;
    expect(at2024([ownK24])).toEqual([{ periodEnd: "2024-09-30", accessionNumber: TDG_Q1_25 }]);
  });

  // TDG's FY2018 10-K 0001260221-18-000070 has isInlineXBRL 0, so its face cannot foot.
  test("a fallback face that is not inline XBRL or already read is not requested, and the instant stays withheld", () => {
    const artifact = deriveItems(TDG_GAAP, []);
    const notInline = {
      filings: { recent: { ...tdgSubmissions().filings.recent, isInlineXBRL: [0] } },
    };
    const k25 = { metrics: { accessionNumber: TDG_K25 } } as unknown as ExtendedEvidenceItem;
    expect(debtInstantsNeedingFace(artifact, notInline)).toEqual([]);
    expect(debtInstantsNeedingFace(artifact, undefined, [k25])).toEqual([]);
    expect(artifact.omissionNotes?.map(({ periodKey }) => periodKey)).toEqual(
      expect.arrayContaining(["instant|2025-09-30", "instant|2024-09-30"]),
    );
  });

  test("an own 10-K SEC marks as not inline XBRL is not requested, only the comparative", () => {
    expect(
      debtInstantsNeedingFace(deriveItems(TDG_GAAP, []), tdgK24Submissions(0)).filter(
        ({ periodEnd }) => periodEnd === "2024-09-30",
      ),
    ).toEqual([{ periodEnd: "2024-09-30", accessionNumber: TDG_Q1_25 }]);
  });

  test("one read, one source, publishes 2025-09-30 29,731M and 2024-09-30 24,618M", async () => {
    const { urls, out } = await tdgFaces();
    expect(urls).toEqual([
      "https://www.sec.gov/Archives/edgar/data/1260221/000126022125000081/tdg-20250930.htm",
    ]);
    expect(out.sources.map(({ id }) => id)).toEqual([
      `extended-sec-edgar-orcl-10k-face-${TDG_K25}`,
    ]);
    expect(out.gaps).toEqual([]);
    const debt = tdgDebt(out.items);
    // 124 + 724 + 29,167 - 8 - 276 and 98 + 486 + 24,296 - 6 - 256.
    expect(debt.get("2025-09-30")).toMatchObject({ value: 29_731e6, accessionNumber: TDG_K25 });
    expect(debt.get("2024-09-30")).toMatchObject({ value: 24_618e6, accessionNumber: TDG_K25 });
    expect(debt.get("2024-09-30")?.sourceIds).toContain(
      `extended-sec-edgar-orcl-10k-face-${TDG_K25}`,
    );
  });

  test("2024-09-30 is public only from the FY2025 10-K that proves it, not the FY2024 10-K", async () => {
    const { out } = await tdgFaces();
    expect(tdgDebt(out.items).get("2024-09-30")?.firstPublicAt).toBe("2025-11-12");
    const rows = new Map(
      valuationPeriodInputs(deriveItems(TDG_GAAP, out.items)).periods.map((row) => [
        `${row.basis}|${row.periodEnd}`,
        row,
      ]),
    );
    expect(rows.get("annual|2024-09-30")?.rowPublicAt).toBe("2024-11-07");
    expect(rows.get("annual|2024-09-30")?.debt).toBeUndefined();
    expect(rows.get("ttm|2025-09-30")?.debt).toMatchObject({
      value: 29_731e6,
      publicAt: "2025-11-12",
    });
  });

  test("a 10-Q comparative that proved 2024-09-30 on 2025-02-04 dates it before the 10-K's", async () => {
    const q1 = "0001260221-25-000010";
    const gaap = Object.fromEntries(
      Object.entries(TDG_GAAP).map(([concept, facts]) => {
        const prior = TDG_GAAP_ROWS[concept]?.[1];
        return [
          concept,
          prior === undefined
            ? facts
            : [...facts, fact(prior * 1e6, "2024-09-30", "2025-02-04", q1)],
        ];
      }),
    );
    const q1Face = {
      sourceIds: [`sec-filing-${q1}`],
      metrics: {
        accessionNumber: q1,
        reportDate: "2024-12-28",
        filingDate: "2025-02-04",
        ...secBalanceSheetFaceMetrics(tdgFace(TDG_ROWS, "2024-12-28"), "2024-12-28"),
      },
    } as unknown as ExtendedEvidenceItem;
    const { out } = await tdgFaces();
    const debt = financialStatementFacts(
      deriveItems(gaap, [...out.items, q1Face]).statements.balanceSheet.debt,
    ).filter(({ periodEnd }) => periodEnd === "2024-09-30");
    expect(
      debt.map(({ periodType, value, firstPublicAt }) => [periodType, value, firstPublicAt]),
    ).toEqual([
      ["annual", 24_618e6, "2025-02-04"],
      ["interim", 24_618e6, "2025-02-04"],
    ]);
  });

  test("an unfooted comparative column is declared and stays withheld", async () => {
    const unfooted = TDG_ROWS.map(
      ([label, concept, fy2025, fy2024]): TdgRow =>
        concept === "us-gaap:DividendsPayableCurrent"
          ? [label, concept, fy2025, 4000]
          : [label, concept, fy2025, fy2024],
    );
    const { urls, out } = await tdgFaces(tdgFace(unfooted));
    expect(urls).toHaveLength(1);
    expect(out.items).toHaveLength(1);
    expect(out.gaps).toEqual([
      expect.objectContaining({
        cause: "provider-data-missing",
        message: expect.stringContaining("(no footed balance-sheet face: 2024-09-30)"),
      }),
    ]);
    const debt = tdgDebt(out.items);
    expect(debt.get("2025-09-30")?.value).toBe(29_731e6);
    expect(debt.get("2024-09-30")).toBeUndefined();
  });

  test.each([
    ["an amended 10-K/A", tdgSubmissions("10-K/A")],
    ["a report date before the instants", tdgSubmissions("10-K", "2024-06-29")],
  ])("%s is refused without a request", async (_name, payload) => {
    const { urls, out } = await tdgFaces(tdgFace(), payload);
    expect(urls).toEqual([]);
    expect(out.items).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(
          "no original 10-K/10-Q in the submissions index: 2025-09-30, 2024-09-30",
        ),
      }),
    ]);
  });
});

type ColumnRow = readonly [label: string, concept: string, ...thousands: (number | undefined)[]];
const columnsFace = (
  ends: readonly string[],
  rows: readonly ColumnRow[],
  placements: readonly (readonly [lease: string, line: string])[] = [],
) =>
  `${ends
    .map(
      (end, index) =>
        `<xbrli:context id="k${String(index)}"><xbrli:entity></xbrli:entity><xbrli:period><xbrli:instant>${end}</xbrli:instant></xbrli:period></xbrli:context>${placements
          .map(
            ([lease, line]) =>
              `<ix:nonNumeric contextRef="k${String(index)}" name="us-gaap:${lease}StatementOfFinancialPositionExtensibleList">http://fasb.org/us-gaap/2025#${line}</ix:nonNumeric>`,
          )
          .join("")}`,
    )
    .join("")}<table>${rows
    .map(
      ([label, concept, ...values]) =>
        `<tr><td>${label}</td>${values
          .map((value, index) =>
            value === undefined
              ? "<td>—</td>"
              : `<td><ix:nonFraction name="${concept}" contextRef="k${String(index)}" unitRef="usd" scale="3">${value.toLocaleString("en-US")}</ix:nonFraction></td>`,
          )
          .join("")}</tr>`,
    )
    .join("")}</table>`;
const filedFace = (accessionNumber: string, reportDate: string, filingDate: string, html: string) =>
  ({
    sourceIds: [`face-${accessionNumber}`],
    metrics: {
      accessionNumber,
      reportDate,
      filingDate,
      ...secBalanceSheetFaceMetrics(html, reportDate),
    },
  }) as unknown as ExtendedEvidenceItem;
interface TaggedFiling {
  readonly accn: string;
  readonly filed: string;
  readonly form: "10-K" | "10-Q";
  readonly fp: string;
  readonly end: string;
  readonly thousands: Readonly<Record<string, number>>;
}
const companyFacts = (filings: readonly TaggedFiling[]) => {
  const gaap: Record<string, Record<string, unknown>[]> = {};
  for (const { accn, filed, form, fp, end, thousands } of filings) {
    for (const [concept, value] of Object.entries(thousands)) {
      gaap[concept] = [
        ...(gaap[concept] ?? []),
        { val: value * 1000, end, filed, accn, form, fy: 2027, fp },
      ];
    }
  }
  return gaap;
};
const debtAt = (artifact: ReturnType<typeof deriveItems>, end: string) =>
  financialStatementFacts(artifact.statements.balanceSheet.debt)
    .filter(({ periodEnd }) => periodEnd === end)
    .map(({ periodType, value, firstPublicAt }) => [periodType, value, firstPublicAt]);

const tdgK24Face = () =>
  filedFace(
    TDG_K24,
    "2024-09-30",
    "2024-11-07",
    columnsFace(
      ["2024-09-30"],
      TDG_ROWS.map(([label, concept, , fy2024]): ColumnRow => [label, concept, fy2024 * 1000]),
      [
        ["FinanceLeaseLiabilityCurrent", "LongTermDebtCurrent"],
        ["FinanceLeaseLiabilityNoncurrent", "LongTermDebtAndCapitalLeaseObligations"],
      ],
    ),
  );

// TDG FY2024 10-K 0001260221-24-000083 own face (report date 2024-09-30), companyfacts values.
test("TDG 2024-09-30 is public from the FY2024 10-K whose own face proves 24,618M, not the FY2025 comparative", async () => {
  expect(
    debtInstantsNeedingFace(deriveItems(TDG_GAAP, []), tdgSubmissionsWithK24()).filter(
      ({ periodEnd }) => periodEnd === "2024-09-30",
    ),
  ).toEqual([
    { periodEnd: "2024-09-30", accessionNumber: TDG_K25 },
    { periodEnd: "2024-09-30", accessionNumber: TDG_K24 },
  ]);
  const { out } = await tdgFaces();
  const artifact = deriveItems(TDG_GAAP, [...out.items, tdgK24Face()]);
  expect(debtAt(artifact, "2024-09-30")).toEqual([["annual", 24_618e6, "2024-11-07"]]);
  const row = valuationPeriodInputs(artifact).periods.find(
    ({ basis, periodEnd }) => basis === "annual" && periodEnd === "2024-09-30",
  );
  expect(row?.debt).toMatchObject({ value: 24_618e6, publicAt: "2024-11-07" });
  expect(row?.debt?.sourceIds).toContain(`face-${TDG_K24}`);
});

// A zero ConvertibleDebtNoncurrent in the FY2025 10-K's comparative note must not move the FY2024 face's proof.
test("a later filing's zero at 2024-09-30 leaves 24,618M public 2024-11-07 from the FY2024 face", async () => {
  const gaap = {
    ...TDG_GAAP,
    ConvertibleDebtNoncurrent: [tdgFact(0, "2024-09-30", TDG_K25, "2025-11-12")],
  };
  const { out } = await tdgFaces();
  const artifact = deriveItems(gaap, [...out.items, tdgK24Face()]);
  expect(debtAt(artifact, "2024-09-30")).toEqual([["annual", 24_618e6, "2024-11-07"]]);
  const row = valuationPeriodInputs(artifact).periods.find(
    ({ basis, periodEnd }) => basis === "annual" && periodEnd === "2024-09-30",
  );
  expect(row?.debt).toMatchObject({ value: 24_618e6, publicAt: "2024-11-07" });
  expect(row?.debt?.sourceIds).toContain(`face-${TDG_K24}`);
});

const fy2025Row = (artifact: ReturnType<typeof deriveItems>) =>
  valuationPeriodInputs(artifact).periods.find(
    ({ basis, periodEnd }) => basis === "annual" && periodEnd === "2025-03-31",
  );

// VSAT FY2025 10-K 0000950170-25-077138 and FY2026 10-K 0001193125-26-248290 (its 2025-03-31 comparative).
// Debt in thousands: 503,825 + 3,652,882 senior notes tagged CommercialPaperNoncurrent + 2,879,402 - 158,473 finance lease.
describe("VSAT 2025-03-31 debt proved by its original 10-K and the next 10-K's comparative", () => {
  const K25 = "0000950170-25-077138";
  const K26 = "0001193125-26-248290";
  const tags = {
    LongTermDebtCurrent: 503_825,
    CommercialPaperNoncurrent: 3_652_882,
    LongTermDebtAndCapitalLeaseObligations: 6_532_284,
    LongTermDebtAndCapitalLeaseObligationsCurrent: 503_825,
    LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: 7_204_275,
    DebtInstrumentUnamortizedDiscountPremiumAndDebtIssuanceCostsNet: 168_166,
    FinanceLeaseLiability: 158_473,
    OperatingLeaseLiabilityCurrent: 65_310,
    OperatingLeaseLiabilityNoncurrent: 414_133,
    AccountsPayableCurrent: 264_300,
    OtherLiabilitiesNoncurrent: 2_181_153,
    LiabilitiesCurrent: 1_676_654,
    Liabilities: 10_804_224,
  };
  const gaap = {
    ...companyFacts([
      {
        accn: K25,
        filed: "2025-05-27",
        form: "10-K",
        fp: "FY",
        end: "2025-03-31",
        thousands: tags,
      },
      {
        accn: K26,
        filed: "2026-05-29",
        form: "10-K",
        fp: "FY",
        end: "2025-03-31",
        thousands: tags,
      },
    ]),
    Revenues: [
      {
        val: 4_520_656e3,
        start: "2024-04-01",
        end: "2025-03-31",
        filed: "2025-05-27",
        accn: K25,
        form: "10-K",
        fy: 2025,
        fp: "FY",
      },
      {
        val: 4_520_656e3,
        start: "2024-04-01",
        end: "2025-03-31",
        filed: "2026-05-29",
        accn: K26,
        form: "10-K",
        fy: 2026,
        fp: "FY",
      },
      {
        val: 4_600_000e3,
        start: "2025-04-01",
        end: "2026-03-31",
        filed: "2026-05-29",
        accn: K26,
        form: "10-K",
        fy: 2026,
        fp: "FY",
      },
    ],
  };
  // Balance-sheet liability rows; the FY2026 face carries the 2026-03-31 column first.
  const ROWS: readonly ColumnRow[] = [
    ["Total assets", "us-gaap:Assets", 15_226_596, 15_448_784],
    ["Accounts payable", "us-gaap:AccountsPayableCurrent", 288_154, 264_300],
    ["Accrued and other liabilities", "vsat:AccruedAndOtherLiabilitiesCurrent", 951_192, 908_529],
    ["Current portion of long-term debt", "us-gaap:LongTermDebtCurrent", 57_753, 503_825],
    ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 1_297_099, 1_676_654],
    ["Senior notes", "us-gaap:CommercialPaperNoncurrent", 3_664_848, 3_652_882],
    [
      "Other long-term debt",
      "vsat:LongTermDebtOtherThanLongTermCommercialPaperNoncurrent",
      2_726_004,
      2_879_402,
    ],
    [
      "Non-current operating lease liabilities",
      "us-gaap:OperatingLeaseLiabilityNoncurrent",
      430_082,
      414_133,
    ],
    ["Other liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 2_379_301, 2_181_153],
    ["Total liabilities", "us-gaap:Liabilities", 10_497_334, 10_804_224],
  ];
  const k26Face = filedFace(
    K26,
    "2026-03-31",
    "2026-05-29",
    columnsFace(["2026-03-31", "2025-03-31"], ROWS),
  );
  const k25Face = filedFace(
    K25,
    "2025-03-31",
    "2025-05-27",
    columnsFace(
      ["2025-03-31"],
      ROWS.map(([label, concept, , fy2025]): ColumnRow => [label, concept, fy2025]),
    ),
  );

  test("the FY2026 comparative alone publishes 6,877.636M from 2026-05-29 and asks for the original face", () => {
    const artifact = deriveItems(gaap, [k26Face]);
    expect(debtAt(artifact, "2025-03-31")).toEqual([["annual", 6_877_636e3, "2026-05-29"]]);
    expect(fy2025Row(artifact)?.debt).toBeUndefined();
    const submissionsPayload = {
      filings: {
        recent: {
          form: ["10-K", "10-K"],
          filingDate: ["2026-05-29", "2025-05-27"],
          reportDate: ["2026-03-31", "2025-03-31"],
          accessionNumber: [K26, K25],
          primaryDocument: ["vsat-20260331.htm", "vsat-20250331.htm"],
        },
      },
    };
    expect(debtInstantsNeedingFace(artifact, submissionsPayload)).toEqual([
      { periodEnd: "2025-03-31", accessionNumber: K25 },
    ]);
    expect(debtInstantsNeedingFace(artifact)).toEqual([]);
  });

  test("with the original face it is public 2025-05-27 and the FY2025 valuation row uses it", () => {
    const artifact = deriveItems(gaap, [k26Face, k25Face]);
    expect(debtAt(artifact, "2025-03-31")).toEqual([["annual", 6_877_636e3, "2025-05-27"]]);
    expect(fy2025Row(artifact)?.debt).toMatchObject({ value: 6_877_636e3, publicAt: "2025-05-27" });
    expect(fy2025Row(artifact)?.debt?.sourceIds).toEqual(
      expect.arrayContaining([`face-${K25}`, `face-${K26}`]),
    );
  });

  // Generic current maturities on the face, the lease split only in the notes: 5,000 current is unplaced.
  test("a footed face withholds when a nonzero current finance lease is unplaced", () => {
    const {
      LongTermDebtAndCapitalLeaseObligationsCurrent: _current,
      LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: _total,
      ...variant
    } = tags;
    const split = { FinanceLeaseLiabilityCurrent: 5000, FinanceLeaseLiabilityNoncurrent: 153_473 };
    const filing = { form: "10-K", fp: "FY", end: "2025-03-31" } as const;
    const artifact = deriveItems(
      {
        Revenues: gaap.Revenues,
        ...companyFacts([
          { ...filing, accn: K25, filed: "2025-05-27", thousands: variant },
          { ...filing, accn: K26, filed: "2026-05-29", thousands: { ...variant, ...split } },
        ]),
      },
      [k26Face],
    );
    expect(debtAt(artifact, "2025-03-31")).toEqual([]);
  });

  // Current maturities retagged ShortTermDebt leave an omission the face recovers, but not the lease's scope.
  test.each<[string, [lease: string, line: string][], (string | number)[][]]>([
    ["withholds with the 5,000 current lease unplaced", [], []],
    [
      "publishes 6,877.636M with the current lease placed inside ShortTermDebt",
      [["FinanceLeaseLiabilityCurrent", "ShortTermDebt"]],
      [["annual", 6_877_636e3, "2026-05-29"]],
    ],
  ])("the ShortTermDebt variant %s", (_name, placements, expected) => {
    const {
      LongTermDebtAndCapitalLeaseObligationsCurrent: _current,
      LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: _total,
      LongTermDebtCurrent: currentDebt,
      ...rest
    } = tags;
    const variant = { ...rest, ShortTermDebt: currentDebt };
    const split = { FinanceLeaseLiabilityCurrent: 5000, FinanceLeaseLiabilityNoncurrent: 153_473 };
    const filing = { form: "10-K", fp: "FY", end: "2025-03-31" } as const;
    const face = filedFace(
      K26,
      "2026-03-31",
      "2026-05-29",
      columnsFace(
        ["2026-03-31", "2025-03-31"],
        ROWS.map(
          ([label, concept, ...values]): ColumnRow =>
            concept === "us-gaap:LongTermDebtCurrent"
              ? [label, "us-gaap:ShortTermDebt", ...values]
              : [label, concept, ...values],
        ),
        placements,
      ),
    );
    const artifact = deriveItems(
      {
        Revenues: gaap.Revenues,
        ...companyFacts([
          { ...filing, accn: K25, filed: "2025-05-27", thousands: variant },
          { ...filing, accn: K26, filed: "2026-05-29", thousands: { ...variant, ...split } },
        ]),
      },
      [face],
    );
    expect(debtAt(artifact, "2025-03-31")).toEqual(expected);
  });
});

// CORZ FY2025 10-K 0001628280-26-013305 own face and Q2 10-Q 0001839341-26-000014's 2025-12-31 comparative.
test("CORZ interim 2025-12-31 1,060.325M is public from the 10-K's own-face proof on 2026-03-02", () => {
  const shared = {
    Liabilities: 3_310_384,
    LiabilitiesCurrent: 781_401,
    AccruedLiabilitiesCurrent: 511_957,
    OtherLiabilitiesCurrent: 15_777,
    OtherLiabilitiesNoncurrent: 104_261,
    FinanceLeaseLiabilityNoncurrent: 844,
  };
  const gaap = companyFacts([
    {
      accn: "0001628280-26-013305",
      filed: "2026-03-02",
      form: "10-K",
      fp: "FY",
      end: "2025-12-31",
      thousands: {
        ...shared,
        LongTermNotesPayable: 1_060_325,
        FinanceLeaseLiability: 844,
        FinanceLeaseLiabilityCurrent: 0,
      },
    },
    {
      accn: "0001628280-26-031396",
      filed: "2026-05-06",
      form: "10-Q",
      fp: "Q1",
      end: "2025-12-31",
      thousands: {
        ...shared,
        DebtCurrent: 0,
        LongTermDebtNoncurrent: 1_060_325,
        DebtLongtermAndShorttermCombinedAmount: 1_060_325,
        FinanceLeaseLiabilityCurrent: 0,
        DerivativeLiabilitiesCurrent: 0,
      },
    },
    {
      accn: "0001839341-26-000014",
      filed: "2026-07-28",
      form: "10-Q",
      fp: "Q2",
      end: "2025-12-31",
      thousands: {
        ...shared,
        LongTermDebt: 1_060_325,
        LongTermDebtNoncurrent: 1_060_325,
        DebtInstrumentCarryingAmount: 1_085_000,
        DerivativeLiabilitiesCurrent: 0,
      },
    },
  ]);
  const placements = [["FinanceLeaseLiabilityNoncurrent", "OtherLiabilitiesNoncurrent"]] as const;
  const annualFace = filedFace(
    "0001628280-26-013305",
    "2025-12-31",
    "2026-03-02",
    columnsFace(
      ["2025-12-31", "2024-12-31"],
      [
        ["Total Assets", "us-gaap:Assets", 2_347_644, 1_475_946],
        ["Accounts payable", "us-gaap:AccountsPayableCurrent", 126_106, 19_265],
        ["Accrued expenses", "us-gaap:AccruedLiabilitiesCurrent", 511_957, 64_670],
        ["Deferred revenue", "us-gaap:DeferredRevenueCurrent", 127_561, 18_134],
        ["Other current liabilities", "us-gaap:OtherLiabilitiesCurrent", 15_777, 32_493],
        ["Total Current Liabilities", "us-gaap:LiabilitiesCurrent", 781_401, 134_562],
        [
          "Convertible and other notes payable, net of current portion",
          "us-gaap:LongTermNotesPayable",
          1_060_325,
          1_073_990,
        ],
        ["Warrant liabilities", "us-gaap:DerivativeLiabilitiesNoncurrent", 936_107, 1_097_285],
        [
          "Deferred revenue, net of current portion",
          "us-gaap:DeferredRevenueNoncurrent",
          428_290,
          undefined,
        ],
        ["Other noncurrent liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 104_261, 113_158],
        ["Total Liabilities", "us-gaap:Liabilities", 3_310_384, 2_418_995],
      ],
      placements,
    ),
  );
  const q2Face = filedFace(
    "0001839341-26-000014",
    "2026-06-30",
    "2026-07-28",
    columnsFace(
      ["2026-06-30", "2025-12-31"],
      [
        ["Total Assets", "us-gaap:Assets", 5_257_493, 2_347_644],
        ["Accounts payable", "us-gaap:AccountsPayableCurrent", 112_374, 126_106],
        ["Accrued expenses", "us-gaap:AccruedLiabilitiesCurrent", 509_189, 511_957],
        ["Deferred revenue", "us-gaap:DeferredRevenueCurrent", 287_201, 127_561],
        [
          "Warrant liabilities, current portion",
          "us-gaap:DerivativeLiabilitiesCurrent",
          1_811_587,
          undefined,
        ],
        ["Other current liabilities", "us-gaap:OtherLiabilitiesCurrent", 17_443, 15_777],
        ["Total Current Liabilities", "us-gaap:LiabilitiesCurrent", 2_737_794, 781_401],
        ["Long-term debt", "us-gaap:LongTermDebtNoncurrent", 4_297_967, 1_060_325],
        [
          "Warrant liabilities, net of current portion",
          "us-gaap:DerivativeLiabilitiesNoncurrent",
          163_683,
          936_107,
        ],
        [
          "Deferred revenue, net of current portion",
          "us-gaap:DeferredRevenueNoncurrent",
          367_242,
          428_290,
        ],
        ["Other noncurrent liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 110_163, 104_261],
        ["Total Liabilities", "us-gaap:Liabilities", 7_676_849, 3_310_384],
      ],
      placements,
    ),
  );
  expect(debtAt(deriveItems(gaap, [annualFace, q2Face]), "2025-12-31")).toEqual([
    ["annual", 1_060_325e3, "2026-03-02"],
    ["interim", 1_060_325e3, "2026-03-02"],
  ]);
});

// CLSK 10-Qs 0001193125-26-039538 (Q1) and 0001193125-26-338382 (Q3), each with its 2025-09-30 comparative column;
// The FY2025 10-K tags LoansPayable 835,213 and stays unresolved.
test("CLSK interim 2025-09-30 821.156M is public from the Q1 10-Q face on 2026-02-05, not the Q3 one", () => {
  const Q1 = "0001193125-26-039538";
  const Q3 = "0001193125-26-338382";
  const shared = {
    LoansPayableCurrent: 176_570,
    LongTermLoansPayable: 644_586,
    LongTermDebt: 644_586,
    DebtInstrumentCarryingAmount: 821_156,
    AccruedLiabilitiesCurrent: 117_544,
    OtherLiabilitiesCurrent: 6096,
    OtherLiabilitiesNoncurrent: 3281,
    DeferredIncomeTaxesAndOtherLiabilitiesNoncurrent: 44_872,
    LiabilitiesCurrent: 315_765,
    Liabilities: 1_008_504,
  };
  const gaap = companyFacts([
    {
      accn: "0001193125-25-297510",
      filed: "2025-11-25",
      form: "10-K",
      fp: "FY",
      end: "2025-09-30",
      thousands: { ...shared, LoansPayable: 835_213 },
    },
    { accn: Q1, filed: "2026-02-05", form: "10-Q", fp: "Q1", end: "2025-09-30", thousands: shared },
    { accn: Q3, filed: "2026-08-06", form: "10-Q", fp: "Q3", end: "2025-09-30", thousands: shared },
  ]);
  const face = (current: string, values: readonly number[]) =>
    columnsFace(
      [current, "2025-09-30"],
      (
        [
          ["Total assets", "us-gaap:Assets", 3_183_631],
          ["Accounts payable", "us-gaap:AccountsPayableCurrent", 15_159],
          ["Accrued liabilities", "us-gaap:AccruedLiabilitiesCurrent", 117_544],
          ["Other current liabilities", "us-gaap:OtherLiabilitiesCurrent", 6096],
          ["Current portion of debt", "us-gaap:LoansPayableCurrent", 176_570],
          ["Dividends payable", "us-gaap:DividendsPayableCurrent", 396],
          ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 315_765],
          ["Long-term debt, net of current portion", "us-gaap:LongTermLoansPayable", 644_586],
          [
            "Deferred income taxes",
            "us-gaap:DeferredIncomeTaxesAndOtherLiabilitiesNoncurrent",
            44_872,
          ],
          ["Other long-term liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 3281],
          ["Total liabilities", "us-gaap:Liabilities", 1_008_504],
        ] as const
      ).map(
        ([label, concept, prior], index): ColumnRow => [
          label,
          concept,
          values[index] === 0 ? undefined : values[index],
          prior,
        ],
      ),
    );
  const q1Face = filedFace(
    Q1,
    "2025-12-31",
    "2026-02-05",
    face(
      "2025-12-31",
      [3_326_179, 22_116, 103_689, 11_160, 2532, 0, 139_497, 1_786_759, 13_457, 4210, 1_943_923],
    ),
  );
  const q3Face = filedFace(
    Q3,
    "2026-06-30",
    "2026-08-06",
    face(
      "2026-06-30",
      [2_702_199, 11_230, 131_342, 10_827, 2353, 0, 155_752, 1_780_011, 597, 4556, 1_940_916],
    ),
  );
  expect(debtAt(deriveItems(gaap, [q3Face]), "2025-09-30")).toEqual([
    ["interim", 821_156e3, "2026-08-06"],
  ]);
  expect(debtAt(deriveItems(gaap, [q3Face, q1Face]), "2025-09-30")).toEqual([
    ["interim", 821_156e3, "2026-02-05"],
  ]);
});

const Q_ACCN = "0001171843-26-000700";
const K_ACCN = "0001171843-25-005000";
const dec = (value: number, accn = Q_ACCN) => ({
  ...fact(value, "2025-12-31", "2026-02-05", accn),
  fy: 2026,
});
const ZERO_GAAP = {
  Revenues: [
    { ...fact(150_000_000, "2025-06-30", "2025-08-10", K_ACCN, "10-K"), start: "2024-07-01" },
    { ...dec(40_000_000), start: "2025-10-01" },
  ],
  LongTermDebtNoncurrent: [fact(20_000_000, "2025-06-30", "2025-08-10", K_ACCN, "10-K")],
  Liabilities: [dec(18_398_000)],
};
const ZERO_ROWS: readonly Row[] = [
  ["Total assets", "us-gaap:Assets", 300_000],
  ["Accounts payable", "us-gaap:AccountsPayableCurrent", 10_000],
  ["Accrued compensation", "us-gaap:EmployeeRelatedLiabilitiesCurrent", 5000],
  ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 15_000],
  ["Long-term portion of lease liability", "us-gaap:OperatingLeaseLiabilityNoncurrent", 3398],
  ["Total liabilities", "us-gaap:Liabilities", 18_398],
];
const decDebt = (artifact: Awaited<ReturnType<typeof derive>>) =>
  financialStatementFacts(artifact.statements.balanceSheet.debt).find(
    ({ periodEnd }) => periodEnd === "2025-12-31",
  );
const relabel = (label: string, concept = "us-gaap:EmployeeRelatedLiabilitiesCurrent") =>
  ZERO_ROWS.map(
    (row): Row =>
      row[1] === "us-gaap:EmployeeRelatedLiabilitiesCurrent" ? [label, concept, row[2]] : row,
  );
const withRow = (rows: readonly Row[], at: string, row: Row, add = 0): readonly Row[] =>
  rows.flatMap((existing): Row[] =>
    existing[1] === at ? [row, [existing[0], existing[1], existing[2] + add]] : [existing],
  );

const US_GAAP = "http://fasb.org/us-gaap/2025";
const CLFD = "http://www.clearfieldconnection.com/20251231";
// CLFD 10-Q 0001171843-26-000700 shape: a hidden LineOfCredit 0 on the revolver member (fact c1292).
const clfdInstance = (extra = "", unit = "iso4217:USD") =>
  `<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:us-gaap="${US_GAAP}" xmlns:clfd="${CLFD}" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink">
  <link:schemaRef xlink:href="q.xsd" xlink:type="simple"/>
  <context id="i"><entity><identifier scheme="http://www.sec.gov/CIK">0000796505</identifier></entity><period><instant>2025-12-31</instant></period></context>
  <context id="r"><entity><identifier scheme="http://www.sec.gov/CIK">0000796505</identifier><segment><xbrldi:explicitMember dimension="us-gaap:CreditFacilityAxis">us-gaap:RevolvingCreditFacilityMember</xbrldi:explicitMember></segment></entity><period><instant>2025-12-31</instant></period></context>
  <unit id="USD"><measure>${unit}</measure></unit>
  <us-gaap:Liabilities contextRef="i" unitRef="USD" decimals="-3">18398000</us-gaap:Liabilities>
  <us-gaap:AccountsPayableCurrent contextRef="i" unitRef="USD" decimals="-3">10000000</us-gaap:AccountsPayableCurrent>
  <us-gaap:LineOfCredit contextRef="r" unitRef="USD" decimals="-3" id="c1292">0</us-gaap:LineOfCredit>${extra}
</xbrl>`;
const tag = (nsuri: string, localname: string, crdr?: string) => ({
  nsuri,
  localname,
  xbrltype: "monetaryItemType",
  ...(crdr === undefined ? {} : { crdr }),
});
const CLFD_META_LINKS = {
  instance: {
    "q.htm": {
      tag: {
        ...Object.fromEntries(
          ["Liabilities", "AccountsPayableCurrent", "LineOfCredit", "NotesPayable"].map((name) => [
            `us-gaap_${name}`,
            tag(US_GAAP, name, "credit"),
          ]),
        ),
        clfd_LesseeOperatingLeaseLiabilityToBePaidAfterYearFour: tag(
          CLFD,
          "LesseeOperatingLeaseLiabilityToBePaidAfterYearFour",
          "credit",
        ),
      },
    },
  },
};
const LEASE_EXTENSION =
  '<clfd:LesseeOperatingLeaseLiabilityToBePaidAfterYearFour contextRef="i" unitRef="USD" decimals="-3">1447000</clfd:LesseeOperatingLeaseLiabilityToBePaidAfterYearFour>';
const LEASE_CAL = `<link:linkbase xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink"><link:calculationLink xlink:role="r" xlink:type="extended"><link:loc xlink:href="https://xbrl.fasb.org/us-gaap/2025/elts/us-gaap-2025.xsd#us-gaap_LesseeOperatingLeaseLiabilityPaymentsDue" xlink:label="p" xlink:type="locator"/><link:loc xlink:href="q.xsd#clfd_LesseeOperatingLeaseLiabilityToBePaidAfterYearFour" xlink:label="c" xlink:type="locator"/><link:calculationArc xlink:arcrole="http://www.xbrl.org/2003/arcrole/summation-item" xlink:from="p" xlink:to="c" weight="1.0" xlink:type="arc"/></link:calculationLink></link:linkbase>`;
const SCHEMA = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink" targetNamespace="${CLFD}"><xs:annotation><xs:appinfo><link:linkbaseRef xlink:href="q_cal.xml" xlink:role="http://www.xbrl.org/2003/role/calculationLinkbaseRef"/></xs:appinfo></xs:annotation><xs:element id="clfd_LesseeOperatingLeaseLiabilityToBePaidAfterYearFour" name="LesseeOperatingLeaseLiabilityToBePaidAfterYearFour"/></xs:schema>`;

type Served = Readonly<Record<string, unknown>>;
const CLFD_SUBMISSIONS = {
  cik: "0000796505",
  filings: {
    recent: {
      form: ["10-Q", "10-K"],
      filingDate: ["2026-02-05", "2025-08-10"],
      reportDate: ["2025-12-31", "2025-06-30"],
      accessionNumber: [Q_ACCN, K_ACCN],
      primaryDocument: ["q.htm", "k.htm"],
    },
  },
};

function clfdContext(served: Served, adapters: string[] = []): CollectContext {
  const respond = (adapter: string, url: string) => {
    adapters.push(adapter);
    const payload = served[adapter];
    return payload === undefined
      ? { source: adapter, message: `${adapter} fetch failed` }
      : { rawSnapshot: { id: `raw-${url}`, adapter, fetchedAt: "", payload }, payload };
  };
  return {
    command: { jobType: "equity", assetClass: "equity", symbol: "CLFD", depth: "deep" },
    fetchedAt: AS_OF,
    newsLimit: 0,
    cryptoMoverLimit: 0,
    secUserAgent: "test-agent",
    request: {
      fetch: () => Promise.reject(new Error("unexpected base fetch")),
      json: async ({ adapter, url }) => respond(adapter, url) as never,
      text: async ({ adapter, url }) => respond(adapter, url) as never,
    },
  };
}

const clfdServed = (rows: readonly Row[] = ZERO_ROWS, overrides: Served = {}): Served => ({
  "sec-filing-text": `<link:schemaRef xlink:href="q.xsd"/>${balanceSheet("2025-12-31", rows)}`,
  "sec-xbrl-instance": clfdInstance(),
  "sec-metalinks": CLFD_META_LINKS,
  "sec-xbrl-schema": SCHEMA,
  "sec-calculation-linkbase": LEASE_CAL,
  ...overrides,
});

async function clfdFaces(served: Served, adapters: string[] = []) {
  return collectSecDebtFaceFilings(
    clfdContext(served, adapters),
    { cik: "796505", symbol: "CLFD", submissionsPayload: CLFD_SUBMISSIONS },
    [{ periodEnd: "2025-12-31", accessionNumber: Q_ACCN }],
  );
}

const clfdDerive = async (served: Served) =>
  deriveItems(ZERO_GAAP, (await clfdFaces(served)).items);
const withheldMessage = async (served: Served) =>
  financialStatementsDebtBasisGaps(await clfdDerive(served)).map(({ message }) => message);

const taggedZeroNoted = (notes: readonly { code: string }[] | undefined) =>
  (notes ?? []).some(({ code }) => code === "tagged-zero-debt");

const PROOF =
  "us-gaap:LineOfCredit = 0 at 2025-12-31 [us-gaap:CreditFacilityAxis=us-gaap:RevolvingCreditFacilityMember]; fact c1292, q_htm.xml";

describe("CLFD-shaped zero borrowings after the last debt instant", () => {
  test("liabilities with no debt tag after prior debt ask for their own 10-Q face", async () => {
    const artifact = await derive(ZERO_GAAP);
    expect(decDebt(artifact)).toBeUndefined();
    expect(debtInstantsNeedingFace(artifact)).toEqual([
      { periodEnd: "2025-12-31", accessionNumber: Q_ACCN },
    ]);
  });

  test("an issuer that never tagged debt does not ask", async () => {
    const { LongTermDebtNoncurrent: _debt, ...neverDebt } = ZERO_GAAP;
    const artifact = await derive(neverDebt);
    expect(debtInstantsNeedingFace(artifact)).toEqual([]);
  });

  test("an issuer that never tagged debt withholds its newest instant, not an old held-for-sale date (NTGR)", async () => {
    const { LongTermDebtNoncurrent: _debt, ...neverDebt } = ZERO_GAAP;
    const old = fact(5_000_000, "2018-01-01", "2019-02-22", "0001122904-19-000060", "10-K");
    const artifact = await derive({
      ...neverDebt,
      Liabilities: [old, ...neverDebt.Liabilities],
      LiabilitiesOfDisposalGroupIncludingDiscontinuedOperationCurrent: [old],
    });
    expect(withheldDebt(artifact)).toEqual({
      periodEnd: "2025-12-31",
      reason: expect.stringContaining("no debt concept is tagged at any date"),
    });
  });

  test("an issuer that never tagged debt still proves 0 from a face it already read", async () => {
    const { LongTermDebtNoncurrent: _debt, ...neverDebt } = ZERO_GAAP;
    expect(decDebt(deriveItems(neverDebt, (await clfdFaces(clfdServed())).items))?.value).toBe(0);
  });

  test("a face row off the non-borrowing list names itself and asks for nothing more (CALX, NTGR)", async () => {
    const adapters: string[] = [];
    const rows = relabel("Other non-current liabilities", "us-gaap:OtherLiabilitiesNoncurrent");
    const faces = await clfdFaces(clfdServed(rows), adapters);
    expect(adapters).toEqual(["sec-filing-text"]);
    expect(financialStatementsDebtBasisGaps(deriveItems(ZERO_GAAP, faces.items))).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(
          "tagged-zero proof was rejected (face-row:us-gaap:OtherLiabilitiesNoncurrent)",
        ),
      }),
    ]);
  });

  test("its footed face and tagged zero publish 0 cited to the face and the XBRL instance", async () => {
    const adapters: string[] = [];
    const faces = await clfdFaces(clfdServed(), adapters);
    const debt = decDebt(deriveItems(ZERO_GAAP, faces.items));
    expect(adapters).toEqual(["sec-filing-text", "sec-xbrl-instance", "sec-metalinks"]);
    const metaLinksSource = faces.sources.find(({ url }) => url?.endsWith("/MetaLinks.json"));
    expect(debt?.sourceIds).toContain(metaLinksSource?.id);
    expect(debt).toMatchObject({
      value: 0,
      concept: "NoBorrowingsOnFootedFace",
      extractionMethod: "sec-xbrl-instance",
      zeroBorrowingsProof: PROOF,
    });
    const instanceSource = faces.sources.find(({ url }) => url?.endsWith("/q_htm.xml"));
    expect(instanceSource?.url).toBe(
      "https://www.sec.gov/Archives/edgar/data/796505/000117184326000700/q_htm.xml",
    );
    expect(debt?.sourceIds).toEqual(expect.arrayContaining(faces.items[0]!.sourceIds));
    expect(debt?.sourceIds).toContain(instanceSource?.id);
    expect(faces.gaps).toEqual([]);
  });

  test("the synthetic zero passes composite-fact integrity", async () => {
    const artifact = await clfdDerive(clfdServed());
    expect(decDebt(artifact)?.value).toBe(0);
    expect(() => assertCompositeFactIntegrity(artifact)).not.toThrow();
  });

  test("the reader carries the zero-borrowings proof beside the zero debt", async () => {
    const artifact = await clfdDerive(clfdServed());
    expect(financialPosition(artifact, "2026-03-31")?.debt?.zeroBorrowingsProof).toBe(PROOF);
    const rows = balanceSheetHistory(artifact, "2026-06-30")?.rows ?? [];
    expect(rows.find((row) => row.debt?.value === 0)?.debt?.zeroBorrowingsProof).toBe(PROOF);
    expect(rows.filter((row) => row.debt?.zeroBorrowingsProof !== undefined)).toHaveLength(1);
  });

  test("the published zero carries its structural provenance note", async () => {
    const artifact = await clfdDerive(clfdServed());
    expect(artifact.omissionNotes ?? []).toContainEqual(
      expect.objectContaining({
        code: "tagged-zero-debt",
        periodKey: "instant|2025-12-31",
        message: expect.stringContaining(`10-Q ${Q_ACCN} tags ${PROOF}`),
      }),
    );
  });

  test("an operating-lease current-portion row still proves 0", async () => {
    const rows = relabel(
      "Current portion of lease liability",
      "us-gaap:OperatingLeaseLiabilityCurrent",
    );
    expect(decDebt(await clfdDerive(clfdServed(rows)))?.value).toBe(0);
  });

  test("an unlisted lease extension fetches the calculation linkbase and publishes once placed", async () => {
    const adapters: string[] = [];
    const served = clfdServed(ZERO_ROWS, { "sec-xbrl-instance": clfdInstance(LEASE_EXTENSION) });
    const faces = await clfdFaces(served, adapters);
    expect(adapters.slice(-2)).toEqual(["sec-xbrl-schema", "sec-calculation-linkbase"]);
    expect(decDebt(deriveItems(ZERO_GAAP, faces.items))?.value).toBe(0);
  });

  test("the linkbase read for the face also carries its capex and D&A proofs, with no extra request", async () => {
    const leaseOnly: string[] = [];
    await clfdFaces(
      clfdServed(ZERO_ROWS, { "sec-xbrl-instance": clfdInstance(LEASE_EXTENSION) }),
      leaseOnly,
    );
    const adapters: string[] = [];
    const faces = await clfdFaces(
      clfdServed(ZERO_ROWS, {
        "sec-xbrl-instance": clfdInstance(LEASE_EXTENSION),
        "sec-calculation-linkbase": LEASE_CAL.replace(
          "</link:linkbase>",
          `${CASH_FLOW_CAL}</link:linkbase>`,
        ),
      }),
      adapters,
    );
    expect(adapters).toEqual(leaseOnly);
    expect(faces.items[0]?.metrics).toMatchObject({
      accessionNumber: Q_ACCN,
      "capexCalc|PaymentsToAcquireProductiveAssets": -1,
      "daCalc|DepreciationDepletionAndAmortization": 1,
      daCalcRead: "true",
    });
  });

  test("a face with a borrowing row never asks for the instance", async () => {
    const adapters: string[] = [];
    const rows = withRow(
      ZERO_ROWS,
      "us-gaap:LiabilitiesCurrent",
      ["Line of credit", "us-gaap:LineOfCredit", 500],
      500,
    ).map((row): Row => (row[1] === "us-gaap:Liabilities" ? [row[0], row[1], 18_898] : row));
    await clfdFaces(clfdServed(rows), adapters);
    expect(adapters).toEqual(["sec-filing-text"]);
  });

  test.each([
    [
      "instance",
      { "sec-xbrl-instance": undefined },
      "instance-fetch-failed:sec-xbrl-instance",
      "sec-xbrl-instance",
    ],
    [
      "MetaLinks",
      { "sec-metalinks": undefined },
      "instance-fetch-failed:sec-metalinks",
      "sec-metalinks",
    ],
    [
      "calculation linkbase",
      { "sec-xbrl-instance": clfdInstance(LEASE_EXTENSION), "sec-calculation-linkbase": undefined },
      "instance-fetch-failed:sec-calculation-linkbase",
      "sec-calculation-linkbase",
    ],
  ] as const)(
    "a failed %s fetch withholds with its code and gap",
    async (_name, overrides, code, source) => {
      const served = clfdServed(ZERO_ROWS, overrides);
      const faces = await clfdFaces(served);
      expect(faces.gaps).toContainEqual(expect.objectContaining({ source }));
      expect(decDebt(deriveItems(ZERO_GAAP, faces.items))).toBeUndefined();
      expect(await withheldMessage(served)).toEqual([
        expect.stringContaining(`tagged-zero proof was rejected (${code})`),
      ]);
    },
  );

  test.each([
    [
      "an unreadable instance",
      { "sec-xbrl-instance": `<!DOCTYPE x>${clfdInstance()}` },
      "instance-unreadable",
    ],
    [
      "MetaLinks for another document",
      { "sec-metalinks": { instance: {} } },
      "metalinks-unreadable",
    ],
    [
      "an unreadable calculation linkbase",
      { "sec-xbrl-instance": clfdInstance(LEASE_EXTENSION), "sec-calculation-linkbase": "<x>" },
      "calculation-linkbase-unreadable",
    ],
    [
      "a nonzero notes payable fact",
      {
        "sec-xbrl-instance": clfdInstance(
          '<us-gaap:NotesPayable contextRef="i" unitRef="USD">500000</us-gaap:NotesPayable>',
        ),
      },
      "unclassified-credit:us-gaap:NotesPayable",
    ],
    [
      "an instance reported in euros",
      { "sec-xbrl-instance": clfdInstance("", "iso4217:EUR") },
      "currency-mismatch:EUR",
    ],
    [
      "a notes payable fact with no unit",
      {
        "sec-xbrl-instance": clfdInstance(
          '<us-gaap:NotesPayable contextRef="i">500000</us-gaap:NotesPayable>',
        ),
      },
      "unit-unreadable:us-gaap:NotesPayable",
    ],
    [
      "us-gaap notes payable placed under a lease total",
      {
        "sec-xbrl-instance": clfdInstance(
          `${LEASE_EXTENSION}<us-gaap:NotesPayable contextRef="i" unitRef="USD">500000</us-gaap:NotesPayable>`,
        ),
        "sec-calculation-linkbase": LEASE_CAL.replace(
          "</link:calculationLink>",
          '<link:loc xlink:href="https://xbrl.fasb.org/us-gaap/2025/elts/us-gaap-2025.xsd#us-gaap_NotesPayable" xlink:label="n" xlink:type="locator"/><link:calculationArc xlink:arcrole="http://www.xbrl.org/2003/arcrole/summation-item" xlink:from="p" xlink:to="n" weight="1" xlink:type="arc"/></link:calculationLink>',
        ),
      },
      "unclassified-credit:us-gaap:NotesPayable",
    ],
    [
      "an anchor tagged for another entity",
      {
        "sec-xbrl-instance": clfdInstance().replace(
          '<context id="r"><entity><identifier scheme="http://www.sec.gov/CIK">0000796505',
          '<context id="r"><entity><identifier scheme="http://www.sec.gov/CIK">0000000002',
        ),
      },
      "entity-mismatch:0000000002",
    ],
    [
      "a notes payable fact inside an unrecognized subtree",
      {
        "sec-xbrl-instance": clfdInstance(
          '<link:unrecognised xmlns:link="http://www.xbrl.org/2003/linkbase"><us-gaap:NotesPayable contextRef="i" unitRef="USD">500000</us-gaap:NotesPayable></link:unrecognised>',
        ),
      },
      "instance-unreadable",
    ],
    [
      "MetaLinks aliasing one concept two ways",
      {
        "sec-metalinks": {
          instance: {
            "q.htm": {
              tag: {
                ...CLFD_META_LINKS.instance["q.htm"].tag,
                alias_NotesPayable: tag(US_GAAP, "NotesPayable", "debit"),
              },
            },
          },
        },
      },
      "metalinks-unreadable",
    ],
  ] as const)("%s withholds with its code", async (_name, overrides, code) => {
    const served = clfdServed(ZERO_ROWS, overrides);
    expect(decDebt(await clfdDerive(served))).toBeUndefined();
    expect(await withheldMessage(served)).toEqual([
      expect.stringContaining(`tagged-zero proof was rejected (${code})`),
    ]);
  });

  test("the disable switch reports its own reason without requesting the instance", async () => {
    const adapters: string[] = [];
    const served = clfdServed(ZERO_ROWS, { "sec-metalinks": { instance: {} } });
    const faces = await collectSecDebtFaceFilings(
      { ...clfdContext(served, adapters), taggedZeroDebtDisabled: true },
      { cik: "796505", symbol: "CLFD", submissionsPayload: CLFD_SUBMISSIONS },
      [{ periodEnd: "2025-12-31", accessionNumber: Q_ACCN }],
    );
    expect(adapters).not.toContain("sec-xbrl-instance");
    expect(adapters).not.toContain("sec-metalinks");
    expect(
      financialStatementsDebtBasisGaps(deriveItems(ZERO_GAAP, faces.items)).map(
        ({ message }) => message,
      ),
    ).toEqual([
      expect.stringContaining("tagged-zero proof was rejected (tagged-zero debt disabled)"),
    ]);
  });

  test("an anchor whose decimal only underflows to zero is not a tagged zero", async () => {
    const instance = clfdInstance().replace(
      ">0</us-gaap:LineOfCredit>",
      `>0.${"0".repeat(400)}1</us-gaap:LineOfCredit>`,
    );
    const served = clfdServed(ZERO_ROWS, { "sec-xbrl-instance": instance });
    expect(decDebt(await clfdDerive(served))).toBeUndefined();
    expect(await withheldMessage(served)).toEqual([
      expect.stringContaining("rests on untagged prose"),
    ]);
  });

  test("a placed publish cites the instance, MetaLinks, schema and calculation linkbase", async () => {
    const served = clfdServed(ZERO_ROWS, { "sec-xbrl-instance": clfdInstance(LEASE_EXTENSION) });
    const faces = await clfdFaces(served);
    const debt = decDebt(deriveItems(ZERO_GAAP, faces.items));
    const base = "https://www.sec.gov/Archives/edgar/data/796505/000117184326000700/";
    const cited = ["q_htm.xml", "MetaLinks.json", "q.xsd", "q_cal.xml"].map((file) =>
      faces.sources.find(({ url }) => url === `${base}${file}`),
    );
    expect(cited.every((source) => source !== undefined)).toBe(true);
    expect(debt?.sourceIds).toEqual(expect.arrayContaining(cited.map((source) => source!.id)));
  });

  test.each([
    ["2025-12-30", false],
    ["2026-02-04", false],
    ["2026-02-05", true],
  ] as const)(
    "the tagged-zero note follows the published proof at cutoff %s",
    async (cutoff, shown) => {
      const artifact = await clfdDerive(clfdServed());
      expect(taggedZeroNoted(financialPosition(artifact, cutoff)?.notes)).toBe(shown);
      expect(taggedZeroNoted(balanceSheetHistory(artifact, cutoff)?.notes)).toBe(shown);
      expect(financialPosition(artifact, cutoff)?.debt?.zeroBorrowingsProof !== undefined).toBe(
        shown,
      );
    },
  );

  test("a zero stated only in untagged prose is withheld with its own gap", async () => {
    const instance = clfdInstance().replace(/<us-gaap:LineOfCredit[^\n]*\n/u, "");
    expect(await withheldMessage(clfdServed(ZERO_ROWS, { "sec-xbrl-instance": instance }))).toEqual(
      [expect.stringContaining("rests on untagged prose")],
    );
  });

  test("a held-for-sale fact filed after the cutoff still withholds with its gap", async () => {
    const late = { ...dec(500), filed: "2026-10-30" };
    const artifact = await derive({
      ...ZERO_GAAP,
      LiabilitiesOfDisposalGroupIncludingDiscontinuedOperationCurrent: [late],
    });
    expect(decDebt(artifact)).toBeUndefined();
    expect(financialStatementsDebtBasisGaps(artifact)).toEqual([
      expect.objectContaining({ message: expect.stringContaining("2025-12-31") }),
    ]);
  });

  const withLiabilities = (rows: readonly Row[], add: number) =>
    rows.map(
      (row): Row => (row[1] === "us-gaap:Liabilities" ? [row[0], row[1], 18_398 + add] : row),
    );
  test.each([
    [
      "a held-for-sale row",
      withLiabilities(
        withRow(
          ZERO_ROWS,
          "us-gaap:LiabilitiesCurrent",
          [
            "Liabilities held for sale",
            "us-gaap:LiabilitiesOfDisposalGroupIncludingDiscontinuedOperationCurrent",
            500,
          ],
          500,
        ),
        500,
      ),
    ],
    [
      "a debt row",
      withLiabilities(
        withRow(
          ZERO_ROWS,
          "us-gaap:LiabilitiesCurrent",
          ["Line of credit", "us-gaap:LineOfCredit", 500],
          500,
        ),
        500,
      ),
    ],
    [
      "an unfooted face",
      ZERO_ROWS.map(
        (row): Row => (row[1] === "us-gaap:LiabilitiesCurrent" ? [row[0], row[1], 15_001] : row),
      ),
    ],
    [
      "an aggregate row that embeds debt",
      relabel(
        "Accrued liabilities and current portion of long-term debt",
        "us-gaap:AccruedLiabilitiesCurrent",
      ),
    ],
    [
      "an aggregate row that embeds bank overdrafts",
      relabel("Accrued liabilities and bank overdrafts", "us-gaap:AccruedLiabilitiesCurrent"),
    ],
    ["an untagged drawn revolver", relabel("Revolving credit facility", "clfd:RevolverDrawn")],
    [
      "an aggregate row whose label is unreadable",
      relabel("", "us-gaap:AccruedLiabilitiesCurrent"),
    ],
    [
      "an aggregate row whose label is only numbers",
      relabel("4,197 $", "us-gaap:AccruedLiabilitiesCurrent"),
    ],
    ["an extension bonds-payable row", relabel("Bonds payable", "clfd:BondsPayable")],
    ["an unlisted us-gaap row", relabel("Customer deposits", "us-gaap:CustomerDepositsCurrent")],
  ] as const)("%s stays withheld even beside a valid tagged zero", async (_name, rows) => {
    expect(decDebt(await clfdDerive(clfdServed(rows)))).toBeUndefined();
  });

  test("another filing's face stays withheld", async () => {
    const other = { ...faceItem("0001171843-26-000001", "2025-12-31", ZERO_ROWS) };
    expect(decDebt(await derive(ZERO_GAAP, [other]))).toBeUndefined();
  });

  test("a footed face read without a proof names that in the withheld note", async () => {
    const artifact = await derive(ZERO_GAAP, [faceItem(Q_ACCN, "2025-12-31", ZERO_ROWS)]);
    expect(decDebt(artifact)).toBeUndefined();
    expect(financialStatementsDebtBasisGaps(artifact)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("tagged-zero proof was rejected (no-proof)"),
      }),
    ]);
  });

  test.each([
    [false, 0],
    [true, undefined],
  ])("collection with the tagged-zero switch off=%s publishes debt %s", async (disabled, value) => {
    const served: Served = {
      ...clfdServed(),
      "sec-filing-text": `ITEM 2. MANAGEMENT'S DISCUSSION ${"Revenue grew on stronger demand. ".repeat(12)} ${String(clfdServed()["sec-filing-text"])}`,
      "sec-tickers": { "0": { cik_str: 796_505, ticker: "CLFD", title: "Clearfield Inc" } },
      "sec-companyfacts": {
        cik: 796_505,
        facts: {
          "us-gaap": Object.fromEntries(
            Object.entries(ZERO_GAAP).map(([concept, usd]) => [concept, { units: { USD: usd } }]),
          ),
        },
      },
      "sec-submissions": CLFD_SUBMISSIONS,
    };
    const adapters: string[] = [];
    const context = clfdContext(served, adapters);
    const { request } = context;
    const scoped: CollectContext = {
      ...context,
      ...(disabled ? { taggedZeroDebtDisabled: true } : {}),
      request: {
        fetch: () => Promise.reject(new Error("unexpected base fetch")),
        json: request.json,
        // The 10-K's primary document is not this 10-Q's face.
        text: async (input) =>
          input.adapter === "sec-filing-text" && input.url.endsWith("/k.htm")
            ? { source: "sec-filing-text", message: "not served" }
            : request.text(input),
      },
    };
    const { statements } = await collectFinancialStatements(scoped, "CLFD");
    expect(statements === undefined ? "none" : decDebt(statements)?.value).toBe(value);
    expect(adapters.includes("sec-xbrl-instance")).toBe(!disabled);
    if (disabled && statements !== undefined) {
      expect(financialStatementsDebtBasisGaps(statements)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("tagged-zero debt disabled"),
          }),
        ]),
      );
    }
  });

  test("a published zero raises no finance-lease basis gap", async () => {
    const artifact = await clfdDerive(clfdServed());
    expect(decDebt(artifact)?.value).toBe(0);
    expect(financialStatementsDebtBasisGaps(artifact)).toEqual([]);
  });

  test("a tagged zero debt total publishes 0 without a face (pre-existing)", async () => {
    const { Liabilities: _liabilities, ...gaap } = ZERO_GAAP;
    const debt = decDebt(
      await derive({ ...gaap, DebtLongtermAndShorttermCombinedAmount: [dec(0)] }),
    );
    expect(debt).toMatchObject({ value: 0, concept: "DebtLongtermAndShorttermCombinedAmount" });
  });

  test("a later filing's prior column stays withheld", async () => {
    const prior = Object.fromEntries(
      Object.entries(
        secBalanceSheetFaceMetrics(balanceSheet("2025-12-31", ZERO_ROWS), "2025-12-31"),
      ).map(([key, value]) => [key.replace(/^faceLine\|/u, "priorFaceLine|2025-12-31|"), value]),
    );
    const later = {
      sourceIds: ["sec-filing-later"],
      metrics: { accessionNumber: Q_ACCN, reportDate: "2026-03-31", ...prior },
    } as unknown as ExtendedEvidenceItem;
    expect(decDebt(deriveItems(ZERO_GAAP, [later]))).toBeUndefined();
  });
});

const LEASE_NAME = "LesseeOperatingLeaseLiabilityToBePaidAfterYearFour";
const CLFD_FOLDER = "https://www.sec.gov/Archives/edgar/data/796505/000117184326000700";
const notesPayable = (attributes = 'unitRef="USD"', body = ">730001</us-gaap:NotesPayable>") =>
  `<us-gaap:NotesPayable contextRef="i" ${attributes}${body}`;
const typedMeta = (
  key: string,
  nsuri: string,
  localname: string,
  xbrltype: string,
  crdr: string | null = "credit",
) => ({
  instance: {
    "q.htm": {
      tag: {
        ...CLFD_META_LINKS.instance["q.htm"].tag,
        [key]: { ...tag(nsuri, localname, crdr ?? undefined), xbrltype },
      },
    },
  },
});
const leaseInstance = (extra = "") => clfdInstance(LEASE_EXTENSION + extra);
const unitlessLease = (xbrltype: string) => ({
  "sec-xbrl-instance": leaseInstance().replace(' unitRef="USD" decimals="-3">1447000', ">730001"),
  "sec-metalinks": typedMeta(`clfd_${LEASE_NAME}`, CLFD, LEASE_NAME, xbrltype),
});
const calcWith = (from: string, to: string) => ({
  "sec-xbrl-instance": leaseInstance(),
  "sec-calculation-linkbase": LEASE_CAL.replace(from, to),
});

describe("tagged-zero proof boundaries", () => {
  test.each(
    ["footnoteLink", "schemaRef", "linkbaseRef", "roleRef", "arcroleRef"].map(
      (link) => [`a notes payable fact inside link:${link}`, link] as const,
    ),
  )("%s makes the instance unreadable", async (_name, link) => {
    const served = clfdServed(ZERO_ROWS, {
      "sec-xbrl-instance": clfdInstance(`<link:${link}>${notesPayable()}</link:${link}>`),
    });
    expect(decDebt(await clfdDerive(served))).toBeUndefined();
    expect(await withheldMessage(served)).toEqual([
      expect.stringContaining("tagged-zero proof was rejected (instance-unreadable)"),
    ]);
  });

  test.each([
    [
      "a footnote holding a non-XHTML element",
      `<link:footnoteLink><link:footnote>${notesPayable()}</link:footnote></link:footnoteLink>`,
      "instance-unreadable",
    ],
    [
      "a footnote link holding a locator with content",
      `<link:footnoteLink><link:loc>${notesPayable()}</link:loc></link:footnoteLink>`,
      "instance-unreadable",
    ],
  ] as const)("%s withholds", async (_name, extra, code) => {
    const served = clfdServed(ZERO_ROWS, { "sec-xbrl-instance": clfdInstance(extra) });
    expect(await withheldMessage(served)).toEqual([
      expect.stringContaining(`tagged-zero proof was rejected (${code})`),
    ]);
  });

  test("a footnote of XHTML text beside its locator and arc still publishes", async () => {
    const footnote =
      '<link:footnoteLink xlink:type="extended" xlink:role="http://www.xbrl.org/2003/role/link"><link:loc xlink:type="locator" xlink:href="#c1292" xlink:label="f"/><link:footnote xlink:type="resource" xlink:label="n"><xhtml:span xmlns:xhtml="http://www.w3.org/1999/xhtml">Revolver <xhtml:b>undrawn</xhtml:b>.</xhtml:span></link:footnote><link:footnoteArc xlink:type="arc" xlink:arcrole="http://www.xbrl.org/2003/arcrole/fact-footnote" xlink:from="f" xlink:to="n"/></link:footnoteLink>';
    const served = clfdServed(ZERO_ROWS, { "sec-xbrl-instance": clfdInstance(footnote) });
    expect(decDebt(await clfdDerive(served))?.value).toBe(0);
  });

  test.each([
    ["an issuer-defined money type", "issuerMoneyItemType"],
    ["an empty type", ""],
    ["a prefixed monetary type", "xbrli:monetaryItemType"],
  ] as const)(
    "a unitless nonzero extension credit with %s is unit-unreadable",
    async (_name, xbrltype) => {
      const adapters: string[] = [];
      const served = clfdServed(ZERO_ROWS, unitlessLease(xbrltype));
      expect(decDebt(deriveItems(ZERO_GAAP, (await clfdFaces(served, adapters)).items))).toBe(
        undefined,
      );
      expect(adapters).not.toContain("sec-xbrl-schema");
      expect(await withheldMessage(served)).toEqual([
        expect.stringContaining(`rejected (unit-unreadable:clfd:${LEASE_NAME})`),
      ]);
    },
  );

  test.each([
    ["typed shares with no unit", notesPayable(""), "sharesItemType", "unit-unreadable"],
    [
      "typed by the issuer with no unit",
      notesPayable(""),
      "issuerMoneyItemType",
      "unit-unreadable",
    ],
    ["typed shares in a USD unit", notesPayable(), "sharesItemType", "unclassified-credit"],
    [
      "nil in a USD unit typed shares",
      notesPayable(
        'unitRef="USD" xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
        "/>",
      ),
      "sharesItemType",
      "nil-fact",
    ],
  ] as const)("notes payable %s withholds", async (_name, notes, xbrltype, code) => {
    const served = clfdServed(ZERO_ROWS, {
      "sec-xbrl-instance": clfdInstance(notes),
      "sec-metalinks": typedMeta("us-gaap_NotesPayable", US_GAAP, "NotesPayable", xbrltype),
    });
    expect(decDebt(await clfdDerive(served))).toBeUndefined();
    expect(await withheldMessage(served)).toEqual([
      expect.stringContaining(`rejected (${code}:us-gaap:NotesPayable)`),
    ]);
  });

  const withUnit = (unit: string, body: string) =>
    clfdInstance(`<unit id="u"><measure>${unit}</measure></unit>${body}`).replace(
      'xmlns:xbrldi="',
      'xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="',
    );
  test.each([
    ["stringItemType", clfdInstance(notesPayable(""))],
    ["sharesItemType", withUnit("xbrli:shares", notesPayable('unitRef="u"'))],
    ["integerItemType", withUnit("xbrli:pure", notesPayable('unitRef="u"'))],
  ] as const)(
    "us-gaap notes payable typed %s contradicts MetaLinks",
    async (xbrltype, instance) => {
      const served = clfdServed(ZERO_ROWS, {
        "sec-xbrl-instance": instance,
        "sec-metalinks": typedMeta("us-gaap_NotesPayable", US_GAAP, "NotesPayable", xbrltype),
      });
      expect(decDebt(await clfdDerive(served))).toBeUndefined();
      expect(await withheldMessage(served)).toEqual([
        expect.stringContaining("rejected (metalinks-contradicts:us-gaap:NotesPayable)"),
      ]);
    },
  );

  test.each([
    ["a us-gaap borrowing concept with no balance", "us-gaap", null],
    ["an extension concept with a credit balance", "clfd", "credit"],
  ] as const)("a shares fact for %s contradicts MetaLinks", async (_name, prefix, crdr) => {
    const name = prefix === "us-gaap" ? "LongTermDebt" : "IssuerShares";
    const nsuri = prefix === "us-gaap" ? US_GAAP : CLFD;
    const served = clfdServed(ZERO_ROWS, {
      "sec-xbrl-instance": withUnit(
        "xbrli:shares",
        `<${prefix}:${name} contextRef="i" unitRef="u">730001</${prefix}:${name}>`,
      ),
      "sec-metalinks": typedMeta(`${prefix}_${name}`, nsuri, name, "sharesItemType", crdr),
    });
    expect(await withheldMessage(served)).toEqual([
      expect.stringContaining(`rejected (metalinks-contradicts:${prefix}:${name})`),
    ]);
  });

  test("a share count with no balance stays outside the census", async () => {
    const name = "CommonStockSharesOutstanding";
    const served = clfdServed(ZERO_ROWS, {
      "sec-xbrl-instance": withUnit(
        "xbrli:shares",
        `<us-gaap:${name} contextRef="i" unitRef="u">730001</us-gaap:${name}>`,
      ),
      "sec-metalinks": typedMeta(`us-gaap_${name}`, US_GAAP, name, "sharesItemType", null),
    });
    expect(decDebt(await clfdDerive(served))?.value).toBe(0);
  });

  test.each([
    [
      "the instance root",
      {
        "sec-xbrl-instance": clfdInstance().replace(
          "<xbrl ",
          '<xbrl xml:base="https://other.test/" ',
        ),
      },
      "instance-unreadable",
    ],
    [
      "the instance schemaRef",
      {
        "sec-xbrl-instance": leaseInstance().replace(
          "<link:schemaRef ",
          '<link:schemaRef xml:base="../000117184326003126/" ',
        ),
      },
      "instance-unreadable",
    ],
    [
      "the schema linkbaseRef",
      {
        "sec-xbrl-instance": leaseInstance(),
        "sec-xbrl-schema": SCHEMA.replace(
          "<link:linkbaseRef ",
          '<link:linkbaseRef xml:base="../000117184326003126/" ',
        ),
      },
      "calculation-linkbase-unreadable",
    ],
    [
      "the calculation linkbase root",
      calcWith("<link:linkbase ", '<link:linkbase xml:base="https://other.test/" '),
      "calculation-linkbase-unreadable",
    ],
    [
      "a calculation link",
      calcWith(
        "<link:calculationLink ",
        '<link:calculationLink xml:base="../000117184326003126/" ',
      ),
      "calculation-linkbase-unreadable",
    ],
    [
      "a calculation locator",
      calcWith('xlink:href="q.xsd#', 'xml:base="https://other.test/" xlink:href="q.xsd#'),
      "calculation-linkbase-unreadable",
    ],
  ] as const)("xml:base on %s withholds", async (_name, overrides, code) => {
    expect(await withheldMessage(clfdServed(ZERO_ROWS, overrides))).toEqual([
      expect.stringContaining(`rejected (${code})`),
    ]);
  });

  const secondCalcRef =
    '<link:linkbaseRef xlink:type="simple" xlink:href="debt_cal.xml" xlink:role="http://www.xbrl.org/2003/role/calculationLinkbaseRef"/>';
  const rolelessRef = '<link:linkbaseRef xlink:type="simple" xlink:href="debt_cal.xml"/>';
  const embeddedLease = LEASE_CAL.replace('xlink:role="r"', 'xlink:role="debt"');
  test.each([
    [
      "a schema naming a roleless linkbase beside its calculation linkbase",
      SCHEMA.replace("</xs:appinfo>", `${rolelessRef}</xs:appinfo>`),
      leaseInstance(),
    ],
    [
      "a schema naming a roleless linkbase beside an embedded calculation link",
      SCHEMA.replace(/<link:linkbaseRef[^>]*\/>/u, `${rolelessRef}${embeddedLease}`),
      leaseInstance(),
    ],
    [
      "an instance naming a roleless linkbase",
      SCHEMA,
      leaseInstance().replace('xlink:type="simple"/>', `xlink:type="simple"/>${rolelessRef}`),
    ],
    [
      "a schema naming two calculation linkbases",
      SCHEMA.replace("</xs:appinfo>", `${secondCalcRef}</xs:appinfo>`),
      leaseInstance(),
    ],
    [
      "a schema embedding a calculation link beside its external one",
      SCHEMA.replace(
        "</xs:appinfo>",
        `${LEASE_CAL.replace('xlink:role="r"', 'xlink:role="debt"')}</xs:appinfo>`,
      ),
      leaseInstance(),
    ],
    [
      "an instance naming its own calculation linkbase",
      SCHEMA,
      leaseInstance().replace("</xbrl>", `${secondCalcRef}</xbrl>`),
    ],
  ] as const)("%s withholds", async (_name, schema, instance) => {
    const adapters: string[] = [];
    const served = clfdServed(ZERO_ROWS, {
      "sec-xbrl-instance": instance,
      "sec-xbrl-schema": schema,
    });
    expect(decDebt(deriveItems(ZERO_GAAP, (await clfdFaces(served, adapters)).items))).toBe(
      undefined,
    );
    expect(adapters).not.toContain("sec-calculation-linkbase");
    expect(await withheldMessage(served)).toEqual([
      expect.stringContaining("rejected (calculation-linkbase-ambiguous)"),
    ]);
  });

  test.each([
    ["calculation link", ' xlink:type="extended"', ' xlink:type="simple"'],
    ["calculation locator", 'xlink:label="c" xlink:type="locator"', 'xlink:label="c"'],
    ["calculation arc", 'weight="1.0" xlink:type="arc"', 'weight="1.0" xlink:type="resource"'],
  ] as const)("a %s with the wrong xlink:type withholds", async (_name, from, to) => {
    expect(await withheldMessage(clfdServed(ZERO_ROWS, calcWith(from, to)))).toEqual([
      expect.stringContaining("rejected (calculation-linkbase-unreadable)"),
    ]);
  });

  test.each([
    ["extension", "q.xsd#clfd_", "q.xsd#clfd%5F"],
    ["us-gaap parent", "us-gaap-2025.xsd#us-gaap_", "us-gaap-2025.xsd#us-gaap%5F"],
  ] as const)(
    "a percent-encoded %s locator fragment still places the lease extension",
    async (_name, from, to) => {
      const served = clfdServed(ZERO_ROWS, calcWith(from, to));
      expect(decDebt(await clfdDerive(served))?.value).toBe(0);
    },
  );

  test("presentation, label, definition and reference linkbases beside the calculation linkbase still publish", async () => {
    const refs = ["presentation", "label", "definition", "reference"]
      .map(
        (kind) =>
          `<link:linkbaseRef xlink:type="simple" xlink:href="q_${kind}.xml" xlink:role="http://www.xbrl.org/2003/role/${kind}LinkbaseRef"/>`,
      )
      .join("");
    const served = clfdServed(ZERO_ROWS, {
      "sec-xbrl-instance": leaseInstance(),
      "sec-xbrl-schema": SCHEMA.replace("</xs:appinfo>", `${refs}</xs:appinfo>`),
    });
    expect(decDebt(await clfdDerive(served))?.value).toBe(0);
  });

  test("a malformed locator fragment escape withholds", async () => {
    const served = clfdServed(ZERO_ROWS, calcWith("q.xsd#clfd_", "q.xsd#clfd%ZZ"));
    expect(await withheldMessage(served)).toEqual([
      expect.stringContaining("rejected (calculation-linkbase-unreadable)"),
    ]);
  });

  const placedSchema = (elements: string, namespace = CLFD) =>
    SCHEMA.replace(`targetNamespace="${CLFD}"`, `targetNamespace="${namespace}"`).replace(
      /<xs:element[^>]*\/>/u,
      elements,
    );
  test.each([
    [
      "an extension schema claiming the us-gaap namespace",
      placedSchema(`<xs:element id="clfd_${LEASE_NAME}" name="NotesPayable"/>`, US_GAAP),
    ],
    [
      "a schema giving one id two declarations",
      placedSchema(
        `<xs:element id="clfd_${LEASE_NAME}" name="Other"/><xs:element id="clfd_${LEASE_NAME}" name="${LEASE_NAME}"/>`,
      ),
    ],
    [
      "a locator naming a nested local declaration",
      placedSchema(
        `<xs:element id="real" name="${LEASE_NAME}"/><xs:element id="holder" name="Holder"><xs:complexType><xs:sequence><xs:element id="clfd_${LEASE_NAME}" name="${LEASE_NAME}"/></xs:sequence></xs:complexType></xs:element>`,
      ),
    ],
  ] as const)("%s is calculation-linkbase-unreadable", async (_name, schema) => {
    const served = clfdServed(ZERO_ROWS, {
      "sec-xbrl-instance": leaseInstance(),
      "sec-xbrl-schema": schema,
    });
    expect(await withheldMessage(served)).toEqual([
      expect.stringContaining("rejected (calculation-linkbase-unreadable)"),
    ]);
  });

  test.each([
    ["1.0000000000000000001", "withheld"],
    ["0.999999999999999999999", "withheld"],
    ["+01.000", 0],
    ["1", 0],
  ] as const)("a lease placement weighted %s is %s", async (weight, expected) => {
    const served = clfdServed(ZERO_ROWS, calcWith('weight="1.0"', `weight="${weight}"`));
    expect(decDebt(await clfdDerive(served))?.value ?? "withheld").toBe(expected);
  });

  test.each([
    ["a dot-relative locator", calcWith('xlink:href="q.xsd#', 'xlink:href="./q.xsd#')],
    [
      "an absolute same-accession locator",
      calcWith('xlink:href="q.xsd#', `xlink:href="${CLFD_FOLDER}/q.xsd#`),
    ],
    [
      "a single-quoted schema",
      { "sec-xbrl-instance": leaseInstance(), "sec-xbrl-schema": SCHEMA.replaceAll('"', "'") },
    ],
    [
      "a single-quoted, dot-relative instance schemaRef",
      {
        "sec-xbrl-instance": leaseInstance().replace('xlink:href="q.xsd"', "xlink:href='./q.xsd'"),
      },
    ],
    [
      "an absolute same-accession schemaRef",
      { "sec-xbrl-instance": leaseInstance().replace('"q.xsd"', `"${CLFD_FOLDER}/q.xsd"`) },
    ],
    [
      "a second prefix for the extension namespace on the fact",
      {
        "sec-xbrl-instance": leaseInstance()
          .replace(`xmlns:clfd="${CLFD}"`, `xmlns:clfd="${CLFD}" xmlns:alias="${CLFD}"`)
          .replaceAll(`clfd:${LEASE_NAME}`, `alias:${LEASE_NAME}`),
      },
    ],
  ] as const)("%s still places the lease extension", async (_name, overrides) => {
    const faces = await clfdFaces(clfdServed(ZERO_ROWS, overrides));
    expect(decDebt(deriveItems(ZERO_GAAP, faces.items))?.value).toBe(0);
    expect(faces.sources.map(({ url }) => url)).toEqual(
      expect.arrayContaining([`${CLFD_FOLDER}/q.xsd`, `${CLFD_FOLDER}/q_cal.xml`]),
    );
  });

  test.each([
    [
      "a locator into another accession",
      calcWith(
        'xlink:href="q.xsd#',
        'xlink:href="https://www.sec.gov/Archives/edgar/data/796505/000117184326003126/q.xsd#',
      ),
      `unclassified-credit:clfd:${LEASE_NAME}`,
    ],
    [
      "a schemaRef into another accession",
      {
        "sec-xbrl-instance": leaseInstance().replace(
          '"q.xsd"',
          '"https://www.sec.gov/Archives/edgar/data/796505/000117184326003126/q.xsd"',
        ),
      },
      "instance-fetch-failed:sec-xbrl-schema",
    ],
    [
      "a schemaRef climbing out of the accession",
      { "sec-xbrl-instance": leaseInstance().replace('"q.xsd"', '"../000117184326003126/q.xsd"') },
      "instance-fetch-failed:sec-xbrl-schema",
    ],
  ] as const)("%s withholds", async (_name, overrides, code) => {
    expect(await withheldMessage(clfdServed(ZERO_ROWS, overrides))).toEqual([
      expect.stringContaining(`rejected (${code})`),
    ]);
  });
});

// AMRC 10-Q 0001628280-26-052190 at 2026-06-30: the face tag places the 686k current lease inside LongTermDebtCurrent; non-debt rows are synthetic.
describe("AMRC 2026-06-30 current finance lease placed only by its face", () => {
  const AMRC_Q2 = "0001628280-26-052190";
  const lines = {
    LongTermDebtCurrent: 164_343,
    LongTermDebtAndCapitalLeaseObligations: 1_794_492,
    FinanceLeaseLiabilityCurrent: 686,
    FinanceLeaseLiabilityNoncurrent: 11_212,
  };
  const filing = {
    accn: AMRC_Q2,
    filed: "2026-08-04",
    form: "10-Q",
    fp: "Q2",
    end: "2026-06-30",
  } as const;
  const gaap = companyFacts([{ ...filing, thousands: lines }]);
  const revenue = companyFacts([{ ...filing, thousands: { Revenues: 400_000 } }]).Revenues ?? [];
  gaap.Revenues = revenue.map((row) => ({ ...row, start: "2026-04-01" }));
  const face = filedFace(
    AMRC_Q2,
    "2026-06-30",
    "2026-08-04",
    columnsFace(
      ["2026-06-30"],
      [
        ["Total assets", "us-gaap:Assets", 3_000_000],
        [
          "Current portions of long-term debt and financing lease liabilities, net",
          "us-gaap:LongTermDebtCurrent",
          164_343,
        ],
        ["Accounts payable", "us-gaap:AccountsPayableCurrent", 100_000],
        ["Total current liabilities", "us-gaap:LiabilitiesCurrent", 264_343],
        [
          "Long-term debt and financing lease liabilities, net",
          "us-gaap:LongTermDebtAndCapitalLeaseObligations",
          1_794_492,
        ],
        ["Other liabilities", "us-gaap:OtherLiabilitiesNoncurrent", 50_000],
        ["Total liabilities", "us-gaap:Liabilities", 2_108_835],
      ],
      [["FinanceLeaseLiabilityCurrent", "LongTermDebtCurrent"]],
    ),
  );

  test("without the face it withholds and asks for the 10-Q", () => {
    const artifact = deriveItems(gaap, []);
    expect(debtAt(artifact, "2026-06-30")).toEqual([]);
    expect(debtInstantsNeedingFace(artifact)).toContainEqual({
      periodEnd: "2026-06-30",
      accessionNumber: AMRC_Q2,
    });
  });

  test("the face's placement tag publishes 164,343k − 686k + 1,794,492k − 11,212k = 1,946,937k", () => {
    expect(debtAt(deriveItems(gaap, [face]), "2026-06-30")).toEqual([
      ["interim", 1_946_937e3, "2026-08-04"],
    ]);
  });
});

const instantDebt = (artifact: ReturnType<typeof deriveItems>, end: string) => {
  const { annual, interim } = artifact.statements.balanceSheet.debt;
  return [annual, interim].map((facts) => facts.find((debt) => debt.periodEnd === end)?.value);
};
// One 10-K and one later 10-Q comparative at `end`; each line is [10-K value, 10-Q value].
const comparativeDebt = (
  end: string,
  annual: readonly [accn: string, filed: string],
  interim: readonly [accn: string, filed: string],
  lines: Readonly<Record<string, readonly [number | undefined, number | undefined]>>,
) =>
  instantDebt(
    deriveItems(
      {
        ...Object.fromEntries(
          Object.entries(lines).map(([concept, [k, q]]) => [
            concept,
            [
              ...(k === undefined ? [] : [fact(k, end, annual[1], annual[0], "10-K")]),
              ...(q === undefined ? [] : [fact(q, end, interim[1], interim[0])]),
            ],
          ]),
        ),
        Revenues: [
          {
            ...fact(40e9, end, annual[1], annual[0], "10-K"),
            start: `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`,
          },
          { ...fact(10e9, interim[1], interim[1], interim[0]), start: end },
        ],
      },
      [],
    ),
    end,
  );

describe("a later 10-Q comparative that drops only the 10-K's finance-lease legs", () => {
  const TDG_Q1_26 = "0001260221-26-000017";
  const RECAST = { AccountsPayableCurrent: 400, AccruedLiabilitiesCurrent: 934 };
  const tdgWithComparative = (filed: string, recast: Readonly<Record<string, number>> = {}) => ({
    ...TDG_GAAP,
    Revenues: [
      ...TDG_GAAP.Revenues,
      { ...fact(2290e6, "2025-12-27", filed, TDG_Q1_26), start: "2025-10-01" },
    ],
    ...Object.fromEntries(
      Object.entries({
        LongTermDebtCurrent: 124,
        ShortTermBankLoansAndNotesPayable: 724,
        LongTermDebtAndCapitalLeaseObligations: 29_167,
        LiabilitiesCurrent: 2182,
        ...recast,
      }).map(([concept, millions]) => [
        concept,
        [
          ...(TDG_GAAP[concept as keyof typeof TDG_GAAP] ?? []),
          fact(millions * 1e6, "2025-09-30", filed, TDG_Q1_26),
        ],
      ]),
    ),
  });

  const tdgQ1Face = (filed: string, recast: Readonly<Record<string, number>> = {}) =>
    ({
      sourceIds: [`sec-filing-${TDG_Q1_26}`],
      metrics: {
        accessionNumber: TDG_Q1_26,
        reportDate: "2025-12-27",
        filingDate: filed,
        ...secBalanceSheetFaceMetrics(
          tdgFace(
            TDG_ROWS.map(([label, concept, fy2025]): TdgRow => {
              const value = recast[concept.replace("us-gaap:", "")] ?? fy2025;
              return [label, concept, value, value ?? 0];
            }),
            "2025-12-27",
            "2025-09-30",
          ),
          "2025-12-27",
        ),
      },
    }) as unknown as ExtendedEvidenceItem;

  test("TDG 2025-09-30 keeps 10-K 0001260221-25-000081's 29,731M, not 10-Q 0001260221-26-000017's 30,015M, before 2026-11-10", async () => {
    const { out } = await tdgFaces();
    const artifact = deriveItems(tdgWithComparative("2026-02-03"), [
      ...out.items,
      tdgQ1Face("2026-02-03"),
    ]);
    expect(instantDebt(artifact, "2025-09-30")).toEqual([29_731e6, undefined]);
    expect(balanceSheetHistory(artifact, "2026-11-09")?.rows.map((row) => row.debt?.value)).toEqual(
      [24_618e6, 29_731e6],
    );
  });

  test("a comparative filed before the 10-K is not dated by it, so both stay", async () => {
    const { out } = await tdgFaces();
    expect(
      instantDebt(
        deriveItems(tdgWithComparative("2025-11-01"), [...out.items, tdgQ1Face("2025-11-01")]),
        "2025-09-30",
      ),
    ).toEqual([29_731e6, 30_015e6]);
  });

  test("a liability line recast between the filings keeps the comparative", async () => {
    const { out } = await tdgFaces();
    expect(
      instantDebt(
        deriveItems(tdgWithComparative("2026-02-03", RECAST), [
          ...out.items,
          tdgQ1Face("2026-02-03", RECAST),
        ]),
        "2025-09-30",
      ),
    ).toEqual([29_731e6, 30_015e6]);
  });

  test("an incomplete 10-K resolution leaves the comparative published", () => {
    expect(
      instantDebt(
        deriveItems(tdgWithComparative("2026-02-03"), [tdgQ1Face("2026-02-03")]),
        "2025-09-30",
      ),
    ).toEqual([undefined, 30_015e6]);
  });

  test("DG 2026-01-30 keeps 10-K 0001104659-26-032325's 4,431,616k with only the noncurrent leg tagged", () => {
    expect(
      comparativeDebt(
        "2026-01-30",
        ["0001104659-26-032325", "2026-03-20"],
        ["0001104659-26-069205", "2026-06-02"],
        {
          LongTermDebtAndCapitalLeaseObligationsCurrent: [14_401_000, 14_401_000],
          LongTermDebtAndCapitalLeaseObligations: [4_565_881_000, 4_565_881_000],
          FinanceLeaseLiabilityNoncurrent: [148_666_000, undefined],
        },
      ),
    ).toEqual([4_431_616_000, undefined]);
  });

  test("GLW 2025-12-31 differs by 1,241M against 1,232M of legs, so both stay", () => {
    expect(
      comparativeDebt(
        "2025-12-31",
        ["0000024741-26-000124", "2026-02-12"],
        ["0000024741-26-000205", "2026-05-01"],
        {
          DebtCurrent: [804e6, 804e6],
          LongTermDebtAndCapitalLeaseObligationsCurrent: [795e6, undefined],
          LongTermDebtAndCapitalLeaseObligations: [7630e6, 7630e6],
          LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [8425e6, undefined],
          FinanceLeaseLiability: [1232e6, undefined],
          FinanceLeaseLiabilityCurrent: [84e6, undefined],
          FinanceLeaseLiabilityNoncurrent: [1148e6, undefined],
        },
      ),
    ).toEqual([7193e6, 8434e6]);
  });

  test("LUMN 2024-12-31 sits below the 10-K's 18,303M, so both stay", () => {
    expect(
      comparativeDebt(
        "2024-12-31",
        ["0000018926-25-000010", "2025-02-20"],
        ["0000018926-25-000049", "2025-05-01"],
        {
          DebtAndCapitalLeaseObligations: [17_906e6, 17_906e6],
          LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [18_518e6, undefined],
          LongTermDebtAndCapitalLeaseObligationsCurrent: [412e6, 412e6],
          LongTermDebtAndCapitalLeaseObligations: [17_494e6, 17_494e6],
          FinanceLeaseLiability: [215e6, undefined],
          FinanceLeaseLiabilityCurrent: [17e6, undefined],
          FinanceLeaseLiabilityNoncurrent: [198e6, undefined],
        },
      ),
    ).toEqual([18_303e6, 17_906e6]);
  });
});
