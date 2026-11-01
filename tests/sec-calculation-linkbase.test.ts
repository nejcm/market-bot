import { describe, expect, test } from "bun:test";
import type { ExtendedEvidenceItem } from "../src/domain/evidence";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  calculationLinkbaseHref,
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
    const schema =
      '<link:linkbaseRef xlink:href="amd-20251227_pre.xml" xlink:role="http://www.xbrl.org/2003/role/presentationLinkbaseRef"/>' +
      '<link:linkbaseRef xlink:href="amd-20251227_cal.xml" xlink:role="http://www.xbrl.org/2003/role/calculationLinkbaseRef"/>';
    expect(calculationLinkbaseHref(schema)).toBe("amd-20251227_cal.xml");
    expect(calculationLinkbaseHref(schema.slice(0, schema.indexOf("<link:linkbaseRef", 10)))).toBe(
      undefined,
    );
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
