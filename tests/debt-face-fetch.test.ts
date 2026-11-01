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
} from "../src/sources/extended-evidence/sec-debt";
import { secBalanceSheetFaceMetrics } from "../src/sources/sec-segment-facts";
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

// CLFD 10-Q 0001171843-26-000700, Debt note.
const CLFD_TEXT =
  "The Company has a $ 40,000,000 revolving line of credit. As of December 31, 2025 and September 30, 2025, the Company had no borrowings against this line of credit.";

function faceItem(
  accessionNumber: string,
  reportDate: string,
  rows: readonly Row[],
  text = CLFD_TEXT,
) {
  return {
    sourceIds: [`sec-filing-${accessionNumber}`],
    metrics: { accessionNumber, reportDate },
    html: `${balanceSheet(reportDate, rows)}<p>${text}</p>`,
  };
}

async function derive(
  gaap: Readonly<Record<string, readonly Record<string, unknown>[]>>,
  faces: readonly ReturnType<typeof faceItem>[] = [],
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
      secFilings: faces.map(
        ({ sourceIds, metrics, html }) =>
          ({
            sourceIds,
            metrics: { ...metrics, ...secBalanceSheetFaceMetrics(html, metrics.reportDate) },
          }) as unknown as ExtendedEvidenceItem,
      ),
    },
  );
}

const augustDebt = (artifact: Awaited<ReturnType<typeof derive>>) =>
  financialStatementFacts(artifact.statements.balanceSheet.debt).find(
    ({ periodEnd }) => periodEnd === "2026-08-31",
  );

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
  test(`reads at most ${String(DEBT_FACE_FETCH_CAP)} faces and declares the rest`, async () => {
    const instants = [6, 5, 4, 3, 2].map((month) => instant(month));
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
    expect(urls).toHaveLength(DEBT_FACE_FETCH_CAP);
    expect(out.items).toHaveLength(DEBT_FACE_FETCH_CAP);
    expect(new Set(out.sources.map(({ id }) => id)).size).toBe(DEBT_FACE_FETCH_CAP);
    expect(out.items[0]?.metrics?.accessionNumber).toBe(instants[0]?.accessionNumber);
    expect(out.gaps).toEqual([
      expect.objectContaining({
        cause: "suppressed-by-design",
        message: expect.stringContaining("past the 4-filing cap per run: 2026-02-28"),
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

  test("its footed face with no debt row publishes 0 cited to the face", async () => {
    const face = faceItem(Q_ACCN, "2025-12-31", ZERO_ROWS);
    const debt = decDebt(await derive(ZERO_GAAP, [face]));
    expect(debt).toMatchObject({ value: 0 });
    expect(debt?.sourceIds).toContain(face.sourceIds[0]);
    expect(debt?.zeroBorrowingsQuote).toBe(
      "As of December 31, 2025 and September 30, 2025, the Company had no borrowings against this line of credit.",
    );
  });

  test("an operating-lease current-portion row still proves 0", async () => {
    const rows = relabel(
      "Current portion of lease liability",
      "us-gaap:OperatingLeaseLiabilityCurrent",
    );
    expect(decDebt(await derive(ZERO_GAAP, [faceItem(Q_ACCN, "2025-12-31", rows)]))?.value).toBe(0);
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

  test.each([
    [
      "a held-for-sale row",
      [
        faceItem(
          Q_ACCN,
          "2025-12-31",
          withRow(
            ZERO_ROWS,
            "us-gaap:LiabilitiesCurrent",
            [
              "Liabilities held for sale",
              "us-gaap:LiabilitiesOfDisposalGroupIncludingDiscontinuedOperationCurrent",
              500,
            ],
            500,
          ).map((row): Row => (row[1] === "us-gaap:Liabilities" ? [row[0], row[1], 18_898] : row)),
        ),
      ],
    ],
    [
      "a debt row",
      [
        faceItem(
          Q_ACCN,
          "2025-12-31",
          withRow(
            ZERO_ROWS,
            "us-gaap:LiabilitiesCurrent",
            ["Line of credit", "us-gaap:LineOfCredit", 500],
            500,
          ).map((row): Row => (row[1] === "us-gaap:Liabilities" ? [row[0], row[1], 18_898] : row)),
        ),
      ],
    ],
    [
      "a face whose filing states no zero borrowings",
      [faceItem(Q_ACCN, "2025-12-31", ZERO_ROWS, "")],
    ],
    [
      "a face whose filing names an uncovered term loan",
      [faceItem(Q_ACCN, "2025-12-31", ZERO_ROWS, `${CLFD_TEXT} The Company also has a term loan.`)],
    ],
    ["another filing's face", [faceItem("0001171843-26-000001", "2025-12-31", ZERO_ROWS)]],
    [
      "an unfooted face",
      [
        faceItem(
          Q_ACCN,
          "2025-12-31",
          ZERO_ROWS.map(
            (row): Row =>
              row[1] === "us-gaap:LiabilitiesCurrent" ? [row[0], row[1], 15_001] : row,
          ),
        ),
      ],
    ],
    [
      "an aggregate row that embeds debt",
      [
        faceItem(
          Q_ACCN,
          "2025-12-31",
          relabel(
            "Accrued liabilities and current portion of long-term debt",
            "us-gaap:AccruedLiabilitiesCurrent",
          ),
        ),
      ],
    ],
    [
      "an aggregate row that embeds bank overdrafts",
      [
        faceItem(
          Q_ACCN,
          "2025-12-31",
          relabel("Accrued liabilities and bank overdrafts", "us-gaap:AccruedLiabilitiesCurrent"),
        ),
      ],
    ],
    [
      "an untagged drawn revolver",
      [faceItem(Q_ACCN, "2025-12-31", relabel("Revolving credit facility", "clfd:RevolverDrawn"))],
    ],
    [
      "an aggregate row whose label is unreadable",
      [faceItem(Q_ACCN, "2025-12-31", relabel("", "us-gaap:AccruedLiabilitiesCurrent"))],
    ],
    [
      "an aggregate row whose label is only numbers",
      [faceItem(Q_ACCN, "2025-12-31", relabel("4,197 $", "us-gaap:AccruedLiabilitiesCurrent"))],
    ],
    [
      "an extension bonds-payable row",
      [faceItem(Q_ACCN, "2025-12-31", relabel("Bonds payable", "clfd:BondsPayable"))],
    ],
    [
      "an unlisted us-gaap row",
      [
        faceItem(
          Q_ACCN,
          "2025-12-31",
          relabel("Customer deposits", "us-gaap:CustomerDepositsCurrent"),
        ),
      ],
    ],
  ] as const)("%s stays withheld", async (_name, faces) => {
    expect(decDebt(await derive(ZERO_GAAP, faces))).toBeUndefined();
  });

  test("a rejected text proof names its codes in the withheld note", async () => {
    const artifact = await derive(ZERO_GAAP, [faceItem(Q_ACCN, "2025-12-31", ZERO_ROWS, "")]);
    expect(financialStatementsDebtBasisGaps(artifact)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("text proof was rejected (no-sentence)"),
      }),
    ]);
  });

  test("a published zero raises no finance-lease basis gap", async () => {
    const artifact = await derive(ZERO_GAAP, [faceItem(Q_ACCN, "2025-12-31", ZERO_ROWS)]);
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
    const artifact = deriveFinancialStatements(
      {
        facts: {
          "us-gaap": Object.fromEntries(
            Object.entries(ZERO_GAAP).map(([concept, usd]) => [concept, { units: { USD: usd } }]),
          ),
        },
      },
      {
        symbol: "CLFD",
        generatedAt: AS_OF,
        analysisAsOf: AS_OF,
        sourceId: "sec",
        secFilings: [later],
      },
    );
    expect(decDebt(artifact)).toBeUndefined();
  });
});
