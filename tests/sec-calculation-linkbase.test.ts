import { describe, expect, test } from "bun:test";
import type { ExtendedEvidenceItem } from "../src/domain/evidence";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  schemaCalculation,
  secDepreciationCalcMetrics,
  xbrlSchemaHref,
} from "../src/sources/sec-calculation-linkbase";

const calc = async (name: string) =>
  secDepreciationCalcMetrics(
    await Bun.file(`${import.meta.dir}/fixtures/sec-reference-set/${name}.cal.xml`).text(),
  );

const arc = (
  from: string,
  to: string,
  arcrole = "http://www.xbrl.org/2003/arcrole/summation-item",
  weight = 1,
) =>
  `<link:loc xlink:label="${from}" xlink:href="x.xsd#us-gaap_${from}"/><link:loc xlink:label="${to}" xlink:href="x.xsd#us-gaap_${to}"/><link:calculationArc xlink:arcrole="${arcrole}" xlink:from="${from}" xlink:to="${to}" weight="${weight}"/>`;
const SUM = "http://www.xbrl.org/2003/arcrole/summation-item";
const role = (body: string, name = "r") =>
  `<link:calculationLink xlink:role="${name}">${body}</link:calculationLink>`;
const ADJ = "AdjustmentsToReconcileNetIncomeLossToCashProvidedByUsedInOperatingActivities";
const OCF = "NetCashProvidedByUsedInOperatingActivities";

const schemaWithRefs = (refs: string) =>
  `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink"><xs:annotation><xs:appinfo>${refs}</xs:appinfo></xs:annotation></xs:schema>`;

describe("secDepreciationCalcMetrics", () => {
  test("ABBV FY2025 10-K 0001551152-26-000008 adds Depreciation and intangible amortization into OCF", async () => {
    expect(await calc("abbv-10k-0001551152-26-000008")).toEqual({
      "daCalc|Depreciation": 1,
      "daCalc|AmortizationOfIntangibleAssets": 1,
      daCalcRead: "true",
    });
  });

  test("MSFT FY2025 10-K 0000950170-25-100235 adds only the extension D&A-and-other line", async () => {
    expect(await calc("msft-10k-0000950170-25-100235")).toEqual({
      "daCalc|msft_DepreciationAmortizationAndOther": 1,
      daCalcRead: "true",
    });
  });

  test("DDOG FY2022 and AMD FY2022 place one face D&A line; financing and contract-cost amortization are not D&A", async () => {
    expect(await calc("ddog-10k-0001561550-23-000006")).toEqual({
      "daCalc|DepreciationAndAmortization": 1,
      daCalcRead: "true",
    });
    expect(await calc("amd-10k-0000002488-23-000047")).toEqual({
      "daCalc|OtherDepreciationAndAmortization": 1,
      daCalcRead: "true",
    });
  });

  test("AMD FY2025 10-K 0000002488-26-000018 adds the D&A pair under continuing-operations OCF", async () => {
    expect(await calc("amd-10k-0000002488-26-000018")).toEqual({
      "daCalc|OtherDepreciationAndAmortization": 1,
      "daCalc|AdjustmentForAmortization": 1,
      daCalcRead: "true",
    });
  });

  test("components split across two OCF roles are a conflict, not a proof", () => {
    expect(
      secDepreciationCalcMetrics(
        role(arc(OCF, "Depreciation"), "a") + role(arc(OCF, "AmortizationOfIntangibleAssets"), "b"),
      ),
    ).toEqual({ daCalcRead: "conflict" });
  });

  test("one role split across several calculationLink elements merges into one network", () => {
    expect(
      secDepreciationCalcMetrics(
        role(arc(OCF, "Depreciation")) + role(arc(OCF, "AmortizationOfIntangibleAssets")),
      ),
    ).toEqual({
      "daCalc|Depreciation": 1,
      "daCalc|AmortizationOfIntangibleAssets": 1,
      daCalcRead: "true",
    });
  });

  test("the same arc re-weighted within one role is a conflict", () => {
    expect(
      secDepreciationCalcMetrics(
        role(arc(OCF, "Depreciation")) + role(arc(OCF, "Depreciation", SUM, -1)),
      ),
    ).toEqual({ daCalcRead: "conflict" });
  });

  test("reads D&A under an intermediate adjustments parent with composed weights", () => {
    expect(
      secDepreciationCalcMetrics(
        role(
          arc(OCF, "NetIncomeLoss") +
            arc(OCF, ADJ, SUM, -1) +
            arc(ADJ, "Depreciation") +
            arc(ADJ, "AmortizationOfIntangibleAssets"),
        ),
      ),
    ).toEqual({
      "daCalc|Depreciation": -1,
      "daCalc|AmortizationOfIntangibleAssets": -1,
      daCalcRead: "true",
    });
  });

  test("a prohibiting or prioritized arc is a conflict, not a proof", () => {
    const prohibited = arc(ADJ, "Depreciation").replace(
      ' weight="1"',
      ' weight="1" use="prohibited" priority="1"',
    );
    expect(
      secDepreciationCalcMetrics(
        role(
          arc(OCF, ADJ) +
            arc(ADJ, "Depreciation") +
            arc(ADJ, "AmortizationOfIntangibleAssets") +
            prohibited,
        ),
      ),
    ).toEqual({ daCalcRead: "conflict" });
  });

  test("a rootless operating cash flow cycle in one role is a conflict, not a proof", () => {
    const CONT = "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations";
    expect(
      secDepreciationCalcMetrics(
        role(arc(OCF, CONT) + arc(CONT, OCF) + arc(CONT, "Depreciation"), "a") +
          role(arc(OCF, "NetIncomeLoss"), "b"),
      ),
    ).toEqual({ daCalcRead: "conflict" });
  });

  test("links sharing a role but not an arcrole do not merge", () => {
    expect(
      secDepreciationCalcMetrics(
        role(arc(OCF, "Depreciation")) +
          role(
            arc(
              OCF,
              "AmortizationOfIntangibleAssets",
              "https://xbrl.org/2023/arcrole/summation-item",
            ),
          ),
      ),
    ).toEqual({ daCalcRead: "conflict" });
  });

  test("a calculation cycle is a conflict, not a proof", () => {
    expect(secDepreciationCalcMetrics(role(arc(OCF, ADJ) + arc(ADJ, OCF)))).toEqual({
      daCalcRead: "conflict",
    });
  });

  test("ignores arcs that are not summation-item", () => {
    expect(
      secDepreciationCalcMetrics(
        role(
          arc(OCF, "Depreciation") +
            arc(OCF, "AmortizationOfIntangibleAssets", "http://example.com/other"),
        ),
      ),
    ).toEqual({ "daCalc|Depreciation": 1, daCalcRead: "true" });
  });

  test("parses any namespace prefix and the Calc 1.1 arcrole", () => {
    const xml = role(arc(OCF, "Depreciation", "https://xbrl.org/2023/arcrole/summation-item"))
      .replaceAll("link:", "lb:")
      .replaceAll("xlink:", "xl:");
    expect(secDepreciationCalcMetrics(xml)).toEqual({
      "daCalc|Depreciation": 1,
      daCalcRead: "true",
    });
    expect(xbrlSchemaHref('<ix:references><schemaRef xl:href="a.xsd"/></ix:references>')).toBe(
      "a.xsd",
    );
  });

  test("a linkbase without an operating cash-flow tree is not read", () => {
    expect(secDepreciationCalcMetrics("<link:linkbase/>")).toEqual({});
  });

  test("locates the schema and its calculation linkbase", () => {
    expect(
      xbrlSchemaHref('<link:schemaRef xlink:type="simple" xlink:href="amd-20251227.xsd"/>'),
    ).toBe("amd-20251227.xsd");
    expect(xbrlSchemaHref("<html></html>")).toBeUndefined();
    const pre =
      '<link:linkbaseRef xlink:href="amd-20251227_pre.xml" xlink:role="http://www.xbrl.org/2003/role/presentationLinkbaseRef"/>';
    const cal =
      "<link:linkbaseRef xlink:href='amd-20251227_cal.xml' xlink:role='http://www.xbrl.org/2003/role/calculationLinkbaseRef'/>";
    expect(schemaCalculation(schemaWithRefs(pre + cal))).toEqual({
      hrefs: ["amd-20251227_cal.xml"],
      embedded: false,
    });
    expect(schemaCalculation(schemaWithRefs(pre))).toEqual({ hrefs: [], embedded: false });
    expect(schemaCalculation(pre + cal)).toEqual({ hrefs: [], embedded: false });
    expect(schemaCalculation(schemaWithRefs(cal + cal.replace("_cal", "_cal2")))).toEqual({
      hrefs: ["amd-20251227_cal.xml", "amd-20251227_cal2.xml"],
      embedded: false,
    });
    expect(
      schemaCalculation(schemaWithRefs(`${cal}<link:linkbase>${role("")}</link:linkbase>`)),
    ).toEqual({ hrefs: ["amd-20251227_cal.xml"], embedded: true });
    expect(xbrlSchemaHref("<link:schemaRef xlink:type='simple' xlink:href='q.xsd'/>")).toBe(
      "q.xsd",
    );
    expect(xbrlSchemaHref('<link:schemaRef title="a>b" xlink:href="q.xsd"/>')).toBe("q.xsd");
  });
});

const ABBV_ACCN = "0001551152-26-000008";

function deriveAbbv(calcMetrics: Record<string, number | string> | undefined) {
  const column = (concept: string, val: number) => ({
    start: "2025-01-01",
    end: "2025-12-31",
    val,
    accn: ABBV_ACCN,
    fy: 2025,
    fp: "FY",
    form: "10-K",
    filed: "2026-02-20",
    concept,
  });
  const concepts = Object.fromEntries(
    (
      [
        ["Revenues", 1e9],
        ["DepreciationDepletionAndAmortization", 0],
        ["Depreciation", 762_000_000],
        ["AmortizationOfIntangibleAssets", 7_377_000_000],
      ] as const
    ).map(([concept, val]) => [concept, { units: { USD: [column(concept, val)] } }]),
  );
  const filings: ExtendedEvidenceItem[] =
    calcMetrics === undefined
      ? []
      : [
          {
            category: "sec-edgar",
            title: "ABBV SEC 10-K",
            summary: "",
            sourceIds: [],
            observedAt: "2026-10-31T00:00:00.000Z",
            metrics: { form: "10-K", accessionNumber: ABBV_ACCN, ...calcMetrics },
          },
        ];
  const statements = deriveFinancialStatements(
    { facts: { "us-gaap": concepts } },
    {
      symbol: "ABBV",
      generatedAt: "2026-10-31T00:00:00.000Z",
      analysisAsOf: "2026-10-31T00:00:00.000Z",
      sourceId: "sec",
      secFilings: filings,
    },
  );
  return {
    value: statements.statements.cashFlowStatement.depreciationAndAmortization.annual[0]?.value,
    note: statements.omissionNotes.find((note) => note.code === "unchecked-component-sum")?.message,
  };
}

describe("D&A component sum checked by the calculation linkbase", () => {
  test("ABBV FY2025 publishes 8,139M with no unchecked note when the calc tree proves the pair", async () => {
    const result = deriveAbbv(await calc("abbv-10k-0001551152-26-000008"));
    expect(result.value).toBe(8_139_000_000);
    expect(result.note).toBeUndefined();
  });

  test("an extension D&A line in the calc tree keeps the note and names it", async () => {
    const result = deriveAbbv(await calc("msft-10k-0000950170-25-100235"));
    expect(result.value).toBe(8_139_000_000);
    expect(result.note).toContain(
      "cash-flow calculation adds msft_DepreciationAmortizationAndOther into operating cash flow",
    );
  });

  test("no linkbase read keeps the note with a declared reason", () => {
    const result = deriveAbbv(undefined);
    expect(result.value).toBe(8_139_000_000);
    expect(result.note).toContain("no same-filing calculation linkbase was read");
  });

  test("a failed linkbase fetch keeps the note and says the fetch failed", () => {
    const result = deriveAbbv({ daCalcRead: "fetch-failed" });
    expect(result.value).toBe(8_139_000_000);
    expect(result.note).toContain(
      `filing ${ABBV_ACCN}'s calculation linkbase could not be fetched`,
    );
  });

  test("conflicting OCF roles keep the note and say why", () => {
    expect(deriveAbbv({ daCalcRead: "conflict" }).note).toContain(
      "operating cash-flow calculation roles disagree",
    );
  });

  test("a calc tree from another accession proves nothing", async () => {
    const metrics = await calc("abbv-10k-0001551152-26-000008");
    const result = deriveAbbv({ ...metrics, accessionNumber: "0001551152-25-000001" });
    expect(result.note).toContain("no same-filing calculation linkbase was read");
  });
});

const ABBV_10Q = "0001551152-26-000060";

function deriveAbbvH1(calcMetrics: Record<string, number | string> | undefined) {
  const column = (val: number) => ({
    start: "2026-01-01",
    end: "2026-06-30",
    val,
    accn: ABBV_10Q,
    fy: 2026,
    fp: "Q2",
    form: "10-Q",
    filed: "2026-08-01",
  });
  const concepts = Object.fromEntries(
    (
      [
        ["Revenues", 1e9],
        ["Depreciation", 390_000_000],
        ["AmortizationOfIntangibleAssets", 3_600_000_000],
      ] as const
    ).map(([concept, val]) => [concept, { units: { USD: [column(val)] } }]),
  );
  const statements = deriveFinancialStatements(
    { facts: { "us-gaap": concepts } },
    {
      symbol: "ABBV",
      generatedAt: "2026-10-31T00:00:00.000Z",
      analysisAsOf: "2026-10-31T00:00:00.000Z",
      sourceId: "sec",
      secFilings:
        calcMetrics === undefined
          ? []
          : [
              {
                category: "sec-edgar",
                title: "ABBV SEC 10-Q",
                summary: "",
                sourceIds: [],
                observedAt: "2026-10-31T00:00:00.000Z",
                metrics: { form: "10-Q", accessionNumber: ABBV_10Q, ...calcMetrics },
              },
            ],
    },
  );
  return {
    value: statements.statements.cashFlowStatement.depreciationAndAmortization.interim[0]?.value,
    note: statements.omissionNotes.find((note) => note.code === "unchecked-component-sum")?.message,
  };
}

describe("10-Q D&A component sum checked by the 10-Q's own calculation linkbase", () => {
  const proof = secDepreciationCalcMetrics(
    role(arc(OCF, "Depreciation") + arc(OCF, "AmortizationOfIntangibleAssets")),
  );

  test("a 10-Q calc tree adding both components into OCF drops the note", () => {
    expect(deriveAbbvH1(proof)).toEqual({ value: 3_990_000_000, note: undefined });
  });

  test("conflicting roles, no read, or another filing's tree keep the value with the note", () => {
    expect(deriveAbbvH1({ daCalcRead: "conflict" }).note).toContain(
      "operating cash-flow calculation roles disagree",
    );
    expect(deriveAbbvH1(undefined)).toMatchObject({
      value: 3_990_000_000,
      note: expect.stringContaining("no same-filing calculation linkbase was read"),
    });
    expect(deriveAbbvH1({ ...proof, accessionNumber: ABBV_ACCN }).note).toContain(
      "no same-filing calculation linkbase was read",
    );
  });
});

const AMD_ACCN = "0000002488-26-000018";

const AMD_VALUES: readonly (readonly [string, number])[] = [
  ["Revenues", 34_639_000_000],
  ["Depreciation", 521_000_000],
  ["AmortizationOfIntangibleAssets", 2_300_000_000],
  ["OtherDepreciationAndAmortization", 750_000_000],
  ["AdjustmentForAmortization", 2_254_000_000],
];

function deriveAmd(calcMetrics: Record<string, number | string> | undefined, values = AMD_VALUES) {
  const concepts = Object.fromEntries(
    values.map(([concept, val]) => [
      concept,
      {
        units: {
          USD: [
            {
              start: "2024-12-29",
              end: "2025-12-27",
              val,
              accn: AMD_ACCN,
              fy: 2025,
              fp: "FY",
              form: "10-K",
              filed: "2026-02-04",
            },
          ],
        },
      },
    ]),
  );
  const statements = deriveFinancialStatements(
    { facts: { "us-gaap": concepts } },
    {
      symbol: "AMD",
      generatedAt: "2026-10-31T00:00:00.000Z",
      analysisAsOf: "2026-10-31T00:00:00.000Z",
      sourceId: "sec",
      secFilings:
        calcMetrics === undefined
          ? []
          : [
              {
                category: "sec-edgar",
                title: "AMD SEC 10-K",
                summary: "",
                sourceIds: [],
                observedAt: "2026-10-31T00:00:00.000Z",
                metrics: { form: "10-K", accessionNumber: AMD_ACCN, ...calcMetrics },
              },
            ],
    },
  );
  return {
    value: statements.statements.cashFlowStatement.depreciationAndAmortization.annual[0]?.value,
    note: statements.omissionNotes.find((note) => note.code === "unchecked-component-sum")?.message,
  };
}

describe("D&A face pair checked by the calculation linkbase", () => {
  test("AMD FY2025 publishes 3,004M unqualified when 10-K 0000002488-26-000018 adds both lines into OCF", async () => {
    const result = deriveAmd(await calc("amd-10k-0000002488-26-000018"));
    expect(result.value).toBe(3_004_000_000);
    expect(result.note).toBeUndefined();
  });

  test("an add-back nested under the face D&A line keeps the value with the note", () => {
    const nested = secDepreciationCalcMetrics(
      role(arc(OCF, "OtherDepreciationAndAmortization")) +
        role(arc("OtherDepreciationAndAmortization", "AdjustmentForAmortization")),
    );
    const result = deriveAmd(nested);
    expect(result.value).toBe(3_004_000_000);
    expect(result.note).toContain(
      "is cash-flow OtherDepreciationAndAmortization + AdjustmentForAmortization, not checked",
    );
    expect(result.note).toContain(
      "cash-flow calculation adds OtherDepreciationAndAmortization into operating cash flow",
    );
  });

  test("no linkbase or conflicting roles keep the note with the reason", () => {
    expect(deriveAmd(undefined).note).toContain("no same-filing calculation linkbase was read");
    expect(deriveAmd({ daCalcRead: "conflict" }).note).toContain(
      "operating cash-flow calculation roles disagree",
    );
  });
});

// MRK FY2025 shape: rounded 2.8B note amortization yields to the 2,793M cash-flow line.
const MRK_VALUES = [
  ["Revenues", 64_000_000_000],
  ["Depreciation", 3_045_000_000],
  ["AmortizationOfIntangibleAssets", 2_800_000_000],
  ["AdjustmentForAmortization", 2_793_000_000],
] as const;

describe("D&A depreciation plus cash-flow amortization checked by the calculation linkbase", () => {
  test("no linkbase keeps 5,838M with a note naming the cash-flow add-back", () => {
    const result = deriveAmd(undefined, MRK_VALUES);
    expect(result.value).toBe(5_838_000_000);
    expect(result.note).toContain(
      "is depreciation + cash-flow AdjustmentForAmortization, not checked against the filed cash-flow statement: no same-filing calculation linkbase was read",
    );
  });

  test("a calc tree adding Depreciation and AdjustmentForAmortization into OCF drops the note", () => {
    const proof = secDepreciationCalcMetrics(
      role(arc(OCF, "Depreciation") + arc(OCF, "AdjustmentForAmortization")),
    );
    const result = deriveAmd(proof, MRK_VALUES);
    expect(result.value).toBe(5_838_000_000);
    expect(result.note).toBeUndefined();
  });
});

describe("disconnected operating cash-flow totals in one role", () => {
  const split = (first: string, second: string) =>
    secDepreciationCalcMetrics(
      role(
        arc("NetCashProvidedByUsedInOperatingActivities", first) +
          arc("NetCashProvidedByUsedInOperatingActivitiesContinuingOperations", second),
      ),
    );

  test("are a conflict, so the AMD face pair keeps its note", () => {
    const metrics = split("OtherDepreciationAndAmortization", "AdjustmentForAmortization");
    expect(metrics).toEqual({ daCalcRead: "conflict" });
    expect(deriveAmd(metrics).note).toContain("operating cash-flow calculation roles disagree");
  });

  test("are a conflict, so the ABBV component sum keeps its note", () => {
    const metrics = split("Depreciation", "AmortizationOfIntangibleAssets");
    expect(deriveAbbv(metrics).note).toContain("operating cash-flow calculation roles disagree");
  });
});
