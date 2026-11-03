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
import { balanceSheetHistory, financialPosition } from "../src/report/equity-reader-statements";
import { assertCompositeFactIntegrity } from "./support/run-fixtures/financial-invariants";
import { secBalanceSheetFaceMetrics } from "../src/sources/sec-segment-facts";
import { collectFinancialStatements } from "../src/sources/collector-equity-enrichment";
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
      extractionMethod: "sec-filing-face-text",
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
    expect(financialPosition(artifact, "2026-06-30")?.debt?.zeroBorrowingsProof).toBe(PROOF);
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
    const context = clfdContext(served);
    const { request } = context;
    const scoped: CollectContext = {
      ...context,
      request: {
        json: request.json,
        // The 10-K's primary document is not this 10-Q's face.
        text: async (input) =>
          input.adapter === "sec-filing-text" && input.url.endsWith("/k.htm")
            ? { source: "sec-filing-text", message: "not served" }
            : request.text(input),
      },
    };
    const { statements } = await collectFinancialStatements(scoped, "CLFD", disabled);
    expect(statements === undefined ? "none" : decDebt(statements)?.value).toBe(value);
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
