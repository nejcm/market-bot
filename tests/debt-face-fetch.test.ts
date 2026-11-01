import { describe, expect, test } from "bun:test";
import type { ExtendedEvidenceItem } from "../src/domain/evidence";
import {
  DEBT_FACE_FETCH_CAP,
  collectSecDebtFaceFilings,
} from "../src/sources/evidence-request-tools";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { financialStatementFacts } from "../src/sources/extended-evidence/financial-statement-selection";
import { debtInstantsNeedingFace } from "../src/sources/extended-evidence/sec-debt";
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
