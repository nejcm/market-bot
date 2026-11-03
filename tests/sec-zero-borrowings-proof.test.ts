import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  schemaCalculation,
  extensionSchema,
  summationParents,
} from "../src/sources/sec-calculation-linkbase";
import { parseXbrlInstance } from "../src/sources/sec-xbrl-instance";
import {
  metaLinksTags,
  zeroBorrowingsInstanceProof,
  type CalculationPlacement,
  type ConceptTag,
} from "../src/sources/sec-zero-borrowings-proof";

const US_GAAP = "http://fasb.org/us-gaap/2025";
const ISSUER = "http://issuer.example/20251231";
const END = "2025-12-31";

const context = (id: string, members = "", period = `<instant>${END}</instant>`) =>
  `<context id="${id}"><entity><identifier scheme="http://www.sec.gov/CIK">1</identifier>${
    members === "" ? "" : `<segment>${members}</segment>`
  }</entity><period>${period}</period></context>`;
const member = (axis: string, value: string) =>
  `<xbrldi:explicitMember dimension="${axis}">${value}</xbrldi:explicitMember>`;
const fact = (concept: string, value: string | number, contextRef = "i", extra = "") =>
  `<${concept} contextRef="${contextRef}" unitRef="usd" decimals="-3"${extra}>${value}</${concept}>`;
const revolver = member("us-gaap:DebtInstrumentAxis", "issuer:DomesticBankRevolverMember");

const BASE_CONTEXTS = [context("i"), context("r", revolver)].join("");
const BASE_FACTS = [
  fact("us-gaap:Liabilities", 18_398_000),
  fact("us-gaap:AccountsPayableCurrent", 10_000_000),
  fact("us-gaap:LineOfCredit", 0, "r", ' id="z"'),
].join("");

function instanceXml(body = "", { facts = BASE_FACTS, contexts = BASE_CONTEXTS, ns = "" } = {}) {
  return `<?xml version="1.0" encoding="utf-8"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:us-gaap="${US_GAAP}" xmlns:issuer="${ISSUER}"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
  xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"${ns}>
  <link:schemaRef xlink:href="issuer-20251231.xsd" xlink:type="simple"/>
  ${contexts}
  <unit id="usd"><measure>iso4217:USD</measure></unit>
  <unit id="eur"><measure>iso4217:EUR</measure></unit>
  <unit id="shares"><measure>shares</measure></unit>
  <unit id="usdPerShare"><divide><unitNumerator><measure>iso4217:USD</measure></unitNumerator><unitDenominator><measure>shares</measure></unitDenominator></divide></unit>
  ${facts}${body}
</xbrl>`;
}

const CREDIT = [
  "Liabilities",
  "AccountsPayableCurrent",
  "AccruedLiabilitiesCurrent",
  "LineOfCredit",
  "NotesPayable",
  "CapitalLeaseObligationsCurrent",
  "LesseeOperatingLeaseLiabilityPaymentsDue",
  "OtherLiabilitiesCurrent",
];
const MONETARY = "monetaryItemType";
const TAGS: ReadonlyMap<string, ConceptTag> = new Map<string, ConceptTag>([
  ...CREDIT.map((name) => [`${US_GAAP}#${name}`, { crdr: "credit", xbrltype: MONETARY }] as const),
  [`${US_GAAP}#LongTermDebtFairValue`, { xbrltype: MONETARY }],
  [`${US_GAAP}#DebtInstrumentCarryingAmount`, { crdr: "credit", xbrltype: MONETARY }],
  [`${US_GAAP}#PrepaidExpenseCurrent`, { crdr: "debit", xbrltype: MONETARY }],
  [`${ISSUER}#FixedRateNotesOutstanding`, { crdr: "credit", xbrltype: MONETARY }],
  [`${ISSUER}#LeasePaymentsAfterYearFour`, { crdr: "credit", xbrltype: MONETARY }],
  [`${ISSUER}#AmountDueToLender`, { xbrltype: MONETARY }],
  [`${ISSUER}#DisposalGroupDebt`, { crdr: "credit", xbrltype: MONETARY }],
  [`${ISSUER}#CommonSharesIssuedUponDebtConversion`, { xbrltype: "sharesItemType" }],
  [`${ISSUER}#DebtConversionPrice`, { xbrltype: "perShareItemType" }],
  [`${ISSUER}#DebtCovenantRatio`, { xbrltype: "covenantRatioItemType" }],
]);
const SCOPE = { periodEnd: END, file: "q_htm.xml", cik: "0000000001" };

const prove = (
  xml: string,
  placement?: CalculationPlacement,
  tags: ReadonlyMap<string, ConceptTag> = TAGS,
) => zeroBorrowingsInstanceProof(parseXbrlInstance(xml), tags, placement, SCOPE);
const rejectOf = (
  xml: string,
  placement?: CalculationPlacement,
  tags: ReadonlyMap<string, ConceptTag> = TAGS,
) => {
  const result = prove(xml, placement, tags);
  return "reject" in result ? result.reject : "published";
};

const FASB = "https://xbrl.fasb.org/us-gaap/2025/elts/us-gaap-2025.xsd";
const FOLDER = "https://www.sec.gov/Archives/edgar/data/1/000000000125000001";
const CAL_URL = `${FOLDER}/issuer-20251231_cal.xml`;
const SCHEMA = extensionSchema(
  `${FOLDER}/issuer-20251231.xsd`,
  `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="${ISSUER}">${[
    "LeasePaymentsAfterYearFour",
    "FixedRateNotesOutstanding",
  ]
    .map((name) => `<xs:element id="issuer_${name}" name="${name}"/>`)
    .join("")}</xs:schema>`,
);
const locator = (href: string, label: string) =>
  `<link:loc xlink:type="locator" xlink:href="${href}" xlink:label="${label}"/>`;
const arc = (from: string, to: string, weight = "1", extra = "") =>
  `<link:calculationArc xlink:type="arc" xlink:arcrole="http://www.xbrl.org/2003/arcrole/summation-item" xlink:from="${from}" xlink:to="${to}" weight="${weight}"${extra}/>`;
const network = (body: string, role = "r") =>
  `<link:calculationLink xlink:type="extended" xlink:role="${role}">${body}</link:calculationLink>`;
const linkbase = (...networks: string[]) =>
  `<link:linkbase xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink">${networks.join("")}</link:linkbase>`;
// One network summing `child` (an issuer extension unless a full href) into a FASB us-gaap parent.
const placedUnder = (
  parent: string,
  child = "LeasePaymentsAfterYearFour",
  { weight = "1", parentHref = `${FASB}#us-gaap_${parent}` } = {},
) =>
  network(
    locator(parentHref, "p") +
      locator(child.includes("#") ? child : `issuer-20251231.xsd#issuer_${child}`, "c") +
      arc("p", "c", weight),
  );
const placementOf = (xml: string): CalculationPlacement => ({
  extensionNamespace: SCHEMA.namespace,
  parents: summationParents(xml, CAL_URL, SCHEMA),
});

describe("zero borrowings from the XBRL instance", () => {
  test("a facility-scoped tagged zero with only listed credit facts publishes its fact provenance", () => {
    expect(prove(instanceXml())).toEqual({
      proof:
        "us-gaap:LineOfCredit = 0 at 2025-12-31 [us-gaap:DebtInstrumentAxis=issuer:DomesticBankRevolverMember]; fact z, q_htm.xml",
      currency: "USD",
    });
  });

  test("CLFD 10-Q 0001171843-26-003126 publishes only once its calculation linkbase places the lease extension", async () => {
    const dir = join(import.meta.dir, "fixtures/sec-xbrl-instance");
    const instance = parseXbrlInstance(
      await Bun.file(join(dir, "clfd20260331_10q_htm.xml")).text(),
    );
    const tags = metaLinksTags(
      JSON.parse(await Bun.file(join(dir, "MetaLinks.json")).text()),
      "clfd20260331_10q.htm",
    )!;
    const folder = "https://www.sec.gov/Archives/edgar/data/796505/000117184326003126";
    const schema = extensionSchema(
      `${folder}/clfd-20260331.xsd`,
      await Bun.file(join(dir, "clfd-20260331.xsd")).text(),
    );
    const placement = {
      extensionNamespace: schema.namespace,
      parents: summationParents(
        await Bun.file(join(dir, "clfd-20260331_cal.xml")).text(),
        `${folder}/clfd-20260331_cal.xml`,
        schema,
      ),
    };
    const scope = { periodEnd: "2026-03-31", file: "clfd20260331_10q_htm.xml", cik: "796505" };
    expect(zeroBorrowingsInstanceProof(instance, tags, undefined, scope)).toEqual({
      reject: "unclassified-credit:clfd:LesseeOperatingLeaseLiabilityToBePaidAfterYearFour",
    });
    expect(zeroBorrowingsInstanceProof(instance, tags, placement, scope)).toEqual({
      proof:
        "us-gaap:LineOfCredit = 0 at 2026-03-31 [us-gaap:CreditFacilityAxis=us-gaap:RevolvingCreditFacilityMember, us-gaap:DebtInstrumentAxis=clfd:LoanAndSecurityAgreementWithBremerBankNationalAssociationMember]; fact c1613, clfd20260331_10q_htm.xml",
      currency: "USD",
    });
  });
});

describe("facility identity: any other nonzero borrowing fact withholds", () => {
  test.each([
    ["a foreign revolver member", "issuer:ForeignBankRevolverMember"],
    ["a dated facility member", "issuer:DomesticBankRevolver2022Member"],
  ])("%s with a nonzero line of credit", (_name, other) => {
    const body = context("f", member("us-gaap:DebtInstrumentAxis", other));
    expect(
      rejectOf(
        instanceXml(fact("us-gaap:LineOfCredit", 500_000, "f"), {
          contexts: BASE_CONTEXTS + body,
        }),
      ),
    ).toBe("unclassified-credit:us-gaap:LineOfCredit");
  });

  test("a plural second domestic facility with a balance", () => {
    const second = context(
      "s",
      member("us-gaap:DebtInstrumentAxis", "issuer:SecondRevolverMember"),
    );
    const xml = instanceXml(fact("us-gaap:LineOfCredit", 500_000, "s"), {
      contexts: BASE_CONTEXTS + second,
    });
    expect(rejectOf(xml)).toBe("unclassified-credit:us-gaap:LineOfCredit");
  });

  test("another tag's zero does not cover a nonzero facility", () => {
    const loan = context("t", member("us-gaap:DebtInstrumentAxis", "issuer:ForeignTermLoanMember"));
    const xml = instanceXml(
      `${fact("us-gaap:DebtInstrumentCarryingAmount", 0, "t")}${fact("us-gaap:NotesPayable", 500_000)}`,
      { contexts: BASE_CONTEXTS + loan },
    );
    expect(rejectOf(xml)).toBe("unclassified-credit:us-gaap:NotesPayable");
  });
});

describe("borrowing veto by balance and classification, not by name", () => {
  test.each([
    ["issuer:FixedRateNotesOutstanding", "a credit extension whose name says Rate"],
    ["issuer:AmountDueToLender", "an extension MetaLinks gives no balance"],
    ["us-gaap:CapitalLeaseObligationsCurrent", "a legacy capital lease"],
    ["us-gaap:LongTermDebtFairValue", "a fair value with no balance type"],
  ])("%s (%s) withholds", (concept) => {
    expect(rejectOf(instanceXml(fact(concept, 500_000)))).toBe(`unclassified-credit:${concept}`);
  });

  test("a zero extension does not certify an unlisted nonzero one", () => {
    const xml = instanceXml(
      `${fact("issuer:DisposalGroupDebt", 0)}${fact("issuer:AmountDueToLender", 500_000)}`,
    );
    expect(rejectOf(xml)).toBe("unclassified-credit:issuer:AmountDueToLender");
  });

  test("a debit fact is outside the census", () => {
    expect(rejectOf(instanceXml(fact("us-gaap:PrepaidExpenseCurrent", 500_000)))).toBe("published");
  });

  const leaseExtension = instanceXml(fact("issuer:LeasePaymentsAfterYearFour", 1_447_000));
  test("an extension the calculation linkbase sums into lease payments publishes", () => {
    const xml = linkbase(placedUnder("LesseeOperatingLeaseLiabilityPaymentsDue"));
    expect(rejectOf(leaseExtension, placementOf(xml))).toBe("published");
  });

  test.each([["Liabilities"], ["AccruedLiabilitiesCurrent"]])(
    "an extension summed into us-gaap:%s is not placed",
    (parent) => {
      expect(rejectOf(leaseExtension, placementOf(linkbase(placedUnder(parent))))).toBe(
        "unclassified-credit:issuer:LeasePaymentsAfterYearFour",
      );
    },
  );

  test("an extension placed under a lease total in one network and a debt-bearing total in another withholds", () => {
    const xml = linkbase(
      placedUnder("LesseeOperatingLeaseLiabilityPaymentsDue"),
      network(
        locator(`${FASB}#us-gaap_LiabilitiesCurrent`, "p") +
          locator("issuer-20251231.xsd#issuer_LeasePaymentsAfterYearFour", "c") +
          arc("p", "c"),
        "r2",
      ),
    );
    expect(rejectOf(leaseExtension, placementOf(xml))).toBe(
      "unclassified-credit:issuer:LeasePaymentsAfterYearFour",
    );
  });

  test("a dimensioned liabilities total withholds", () => {
    const vie = context("v", member("srt:ConsolidatedEntitiesAxis", "srt:SubsidiariesMember"));
    const xml = instanceXml(fact("us-gaap:Liabilities", 500_000, "v"), {
      contexts: BASE_CONTEXTS + vie,
      ns: ' xmlns:srt="http://fasb.org/srt/2025"',
    });
    expect(rejectOf(xml)).toBe("unclassified-credit:us-gaap:Liabilities");
  });
});

describe("nil facts are never zeros", () => {
  const nilZero = (attr: string, ns = "") =>
    instanceXml("", {
      facts: `${fact("us-gaap:Liabilities", 18_398_000)}<us-gaap:LineOfCredit contextRef="r" unitRef="usd" ${attr}${ns}/>`,
    });
  test.each([
    ['xsi:nil="true"', ""],
    ['xsi:nil="1"', ""],
    ['xsi:nil=" true "', ""],
    ['s:nil="true"', ' xmlns:s="http://www.w3.org/2001/XMLSchema-instance"'],
  ])("a nil zero tag %s is never the anchor", (attr, ns) => {
    expect(rejectOf(nilZero(attr, ns))).toBe("nil-fact:us-gaap:LineOfCredit");
  });

  test("a nil borrowing beside a real zero withholds", () => {
    const xml = instanceXml('<us-gaap:NotesPayable contextRef="i" unitRef="usd" xsi:nil="1"/>');
    expect(rejectOf(xml)).toBe("nil-fact:us-gaap:NotesPayable");
  });

  test("an unreadable nil value makes the instance unreadable", () => {
    expect(() => parseXbrlInstance(nilZero('xsi:nil="yes"'))).toThrow();
  });
});

describe("contexts and prefixes are read as XML, never skipped", () => {
  test("a comment inside the instant still reads the conflicting fact", () => {
    const other = context("o", "", `<instant><!-- reporting date -->${END}</instant>`);
    const xml = instanceXml(fact("us-gaap:NotesPayable", 500_000, "o"), {
      contexts: BASE_CONTEXTS + other,
    });
    expect(rejectOf(xml)).toBe("unclassified-credit:us-gaap:NotesPayable");
  });

  test("an alternate prefix for us-gaap is resolved by its namespace URI", () => {
    const xml = instanceXml(
      `<g:NotesPayable xmlns:g="${US_GAAP}" contextRef='i' unitRef='usd'>500000</g:NotesPayable>`,
    );
    expect(rejectOf(xml)).toBe("unclassified-credit:us-gaap:NotesPayable");
  });

  test("an alternate instance prefix reads its contexts", () => {
    const xml = instanceXml("", {
      contexts: `${BASE_CONTEXTS}<x:context xmlns:x="http://www.xbrl.org/2003/instance" id="o"><x:entity><x:identifier scheme="http://www.sec.gov/CIK">1</x:identifier></x:entity><x:period><x:instant>${END}</x:instant></x:period></x:context>`,
      facts: BASE_FACTS + fact("us-gaap:NotesPayable", 500_000, "o"),
    });
    expect(rejectOf(xml)).toBe("unclassified-credit:us-gaap:NotesPayable");
  });

  test("an unknown context reference withholds", () => {
    expect(rejectOf(instanceXml(fact("us-gaap:NotesPayable", 500_000, "missing")))).toBe(
      "context-unreadable:missing",
    );
  });

  test.each([
    ["a context without a period", context("p", "", "")],
    ["a forever context", context("p", "", "<forever/>")],
    ["a duplicate context id", context("i")],
    ["a dateTime instant", context("p", "", `<instant>${END}T00:00:00</instant>`)],
  ])("%s makes the instance unreadable", (_name, extra) => {
    expect(() => parseXbrlInstance(instanceXml("", { contexts: BASE_CONTEXTS + extra }))).toThrow();
  });

  test.each([
    ["a DOCTYPE", (xml: string) => xml.replace("<xbrl", '<!DOCTYPE x [<!ENTITY e "0">]><xbrl')],
    ["an unbalanced tag", (xml: string) => xml.replace("</xbrl>", "")],
    ["an undeclared prefix", (xml: string) => `${xml.replace("</xbrl>", "")}<zz:Debt/></xbrl>`],
    ["an unknown entity", (xml: string) => xml.replace("18398000", "18398000&e;")],
    ["a hijacked us-gaap prefix", (xml: string) => xml.replace(US_GAAP, ISSUER)],
  ])("%s makes the instance unreadable", (_name, mutate) => {
    expect(() => parseXbrlInstance(mutate(instanceXml()))).toThrow();
  });

  test("CDATA and character references read as text", () => {
    const xml = instanceXml(`${fact("us-gaap:NotesPayable", "<![CDATA[5]]>&#48;&#x30;")}`);
    expect(rejectOf(xml)).toBe("unclassified-credit:us-gaap:NotesPayable");
  });
});

describe("units decide what is monetary", () => {
  test("a nonzero shares fact naming debt is outside the census", () => {
    const xml = instanceXml(
      '<issuer:CommonSharesIssuedUponDebtConversion contextRef="i" unitRef="shares">1000000</issuer:CommonSharesIssuedUponDebtConversion>',
    );
    expect(rejectOf(xml)).toBe("published");
  });

  test("a per-share fact is outside the census", () => {
    const xml = instanceXml(
      '<issuer:DebtConversionPrice contextRef="i" unitRef="usdPerShare">12.5</issuer:DebtConversionPrice>',
    );
    expect(rejectOf(xml)).toBe("published");
  });

  test("a fact in another currency withholds", () => {
    const xml = instanceXml(
      '<us-gaap:AccountsPayableCurrent contextRef="i" unitRef="eur">10</us-gaap:AccountsPayableCurrent>',
    );
    expect(rejectOf(xml)).toBe("currency-mismatch:us-gaap:AccountsPayableCurrent:EUR");
  });

  test("an unknown unit reference withholds", () => {
    const xml = instanceXml(
      '<us-gaap:NotesPayable contextRef="i" unitRef="gbp">10</us-gaap:NotesPayable>',
    );
    expect(rejectOf(xml)).toBe("unit-unreadable:gbp");
  });

  test("an unreadable monetary value withholds", () => {
    expect(rejectOf(instanceXml(fact("us-gaap:NotesPayable", "five")))).toBe(
      "value-unreadable:us-gaap:NotesPayable",
    );
  });

  test("an instance with no issuer-wide liabilities fact withholds", () => {
    expect(rejectOf(instanceXml("", { facts: fact("us-gaap:LineOfCredit", 0, "r") }))).toBe(
      "no-liabilities-fact",
    );
  });
});

describe("the anchor zero", () => {
  test("a zero scoped to a disposal group is not issuer-wide", () => {
    const disposal = context("d", member("us-gaap:DisposalGroupName", "issuer:NestorCablesMember"));
    const xml = instanceXml("", {
      contexts: BASE_CONTEXTS + disposal,
      facts: `${fact("us-gaap:Liabilities", 18_398_000)}${fact("us-gaap:LineOfCredit", 0, "d")}`,
    });
    expect(rejectOf(xml)).toBe("scoped-zero:us-gaap:DisposalGroupName");
  });

  test("no borrowing tagged 0 at the instant is untagged", () => {
    expect(rejectOf(instanceXml("", { facts: fact("us-gaap:Liabilities", 1) }))).toBe(
      "untagged-zero",
    );
  });
});

describe("MetaLinks and the disable switch", () => {
  test("an unlisted us-gaap credit concept withholds", () => {
    expect(rejectOf(instanceXml(fact("us-gaap:OtherLiabilitiesCurrent", 5)))).toBe(
      "unclassified-credit:us-gaap:OtherLiabilitiesCurrent",
    );
  });

  test("MetaLinks for another primary document is unreadable", () => {
    expect(metaLinksTags({ instance: { "a.htm": { tag: {} } } }, "b.htm")).toBeUndefined();
    expect(metaLinksTags("not json", "b.htm")).toBeUndefined();
  });
});

const notesFact = (attributes: string, value = "500000") =>
  `<us-gaap:NotesPayable contextRef="i"${attributes}>${value}</us-gaap:NotesPayable>`;

describe("a monetary fact without one currency measure withholds", () => {
  test.each([
    ["no unit", ""],
    ["a shares unit", ' unitRef="shares"'],
    ["a per-share divide unit", ' unitRef="usdPerShare"'],
  ])("NotesPayable with %s", (_name, attributes) => {
    expect(rejectOf(instanceXml(notesFact(attributes)))).toBe(
      "unit-unreadable:us-gaap:NotesPayable",
    );
  });

  test("a currency measure in another namespace is not a currency", () => {
    const xml = instanceXml(notesFact(' unitRef="odd"')).replace(
      "</xbrl>",
      '<unit id="odd"><measure xmlns:cur="http://unrelated.example/currency">cur:USD</measure></unit></xbrl>',
    );
    expect(rejectOf(xml)).toBe("unit-unreadable:us-gaap:NotesPayable");
  });

  test.each([
    ["no unit", ""],
    ["a shares unit", ' unitRef="shares"'],
  ])("a nil NotesPayable with %s withholds before any unit filter", (_name, attributes) => {
    const xml = instanceXml(`<us-gaap:NotesPayable contextRef="i"${attributes} xsi:nil="true"/>`);
    expect(rejectOf(xml)).toBe("nil-fact:us-gaap:NotesPayable");
  });

  test("a fact in a currency unit is monetary whatever MetaLinks types it", () => {
    const tags = new Map(TAGS).set(`${US_GAAP}#NotesPayable`, {
      crdr: "credit",
      xbrltype: "sharesItemType",
    });
    expect(rejectOf(instanceXml(fact("us-gaap:NotesPayable", 500_000)), undefined, tags)).toBe(
      "unclassified-credit:us-gaap:NotesPayable",
    );
  });

  test("an unknown numeric type with a non-currency unit withholds", () => {
    const xml = instanceXml(
      '<issuer:DebtCovenantRatio contextRef="i" unitRef="shares">3</issuer:DebtCovenantRatio>',
    );
    expect(rejectOf(xml)).toBe("unit-unreadable:issuer:DebtCovenantRatio");
  });

  test.each([
    [
      "a measure beside a divide",
      "<measure>shares</measure><divide><unitNumerator><measure>iso4217:USD</measure></unitNumerator><unitDenominator><measure>shares</measure></unitDenominator></divide>",
    ],
    [
      "a divide without a denominator",
      "<divide><unitNumerator><measure>iso4217:USD</measure></unitNumerator></divide>",
    ],
    ["an element inside a measure", "<measure>iso4217:USD<x/></measure>"],
  ])("%s makes the instance unreadable", (_name, body) => {
    expect(() =>
      parseXbrlInstance(instanceXml().replace("</xbrl>", `<unit id="bad">${body}</unit></xbrl>`)),
    ).toThrow();
  });
});

describe("calculation placement proves identity, weight and every parent", () => {
  const extension = instanceXml(fact("issuer:FixedRateNotesOutstanding", 500_000));
  const lease = "OperatingLeaseLiability";

  test("a us-gaap borrowing summed into a lease total is never pardoned", () => {
    const xml = linkbase(placedUnder(lease, `${FASB}#us-gaap_NotesPayable`));
    expect(rejectOf(instanceXml(fact("us-gaap:NotesPayable", 500_000)), placementOf(xml))).toBe(
      "unclassified-credit:us-gaap:NotesPayable",
    );
  });

  test("a lease parent from a look-alike schema is not the us-gaap concept", () => {
    const xml = linkbase(
      placedUnder(lease, "FixedRateNotesOutstanding", {
        parentHref: "issuer-lookalike.xsd#us-gaap_OperatingLeaseLiability",
      }),
    );
    expect(rejectOf(extension, placementOf(xml))).toBe(
      "unclassified-credit:issuer:FixedRateNotesOutstanding",
    );
  });

  test("a locator into the extension schema must name one of its elements", () => {
    const xml = linkbase(
      placedUnder(lease, "FixedRateNotesOutstanding", {
        parentHref: "issuer-20251231.xsd#us-gaap_OperatingLeaseLiability",
      }),
    );
    expect(() => placementOf(xml)).toThrow();
  });

  test("a fact that rebinds the extension prefix does not inherit its placement", () => {
    const other = "http://unrelated.example/2025";
    const xml = instanceXml(
      fact("issuer:FixedRateNotesOutstanding", 500_000, "i", ` xmlns:issuer="${other}"`),
    );
    const tags = new Map(TAGS).set(`${other}#FixedRateNotesOutstanding`, {
      crdr: "credit",
      xbrltype: MONETARY,
    });
    const placement = placementOf(linkbase(placedUnder(lease, "FixedRateNotesOutstanding")));
    expect(rejectOf(extension, placement)).toBe("published");
    expect(rejectOf(xml, placement, tags)).toBe(
      "unclassified-credit:issuer:FixedRateNotesOutstanding",
    );
  });

  test("a negative weight does not place", () => {
    const xml = linkbase(placedUnder(lease, "FixedRateNotesOutstanding", { weight: "-1" }));
    expect(rejectOf(extension, placementOf(xml))).toBe(
      "unclassified-credit:issuer:FixedRateNotesOutstanding",
    );
  });

  test("weight 1.0 places", () => {
    const xml = linkbase(placedUnder(lease, "FixedRateNotesOutstanding", { weight: "1.0" }));
    expect(rejectOf(extension, placementOf(xml))).toBe("published");
  });

  test.each([["0"], ["bad"], [""], ["1e0"]])("weight %p is unreadable", (weight) => {
    expect(() =>
      placementOf(linkbase(placedUnder(lease, "FixedRateNotesOutstanding", { weight }))),
    ).toThrow();
  });

  test("one relationship weighted both ways is unreadable", () => {
    const body =
      locator(`${FASB}#us-gaap_${lease}`, "p") +
      locator("issuer-20251231.xsd#issuer_FixedRateNotesOutstanding", "c") +
      arc("p", "c", "1") +
      arc("p", "c", "-1");
    expect(() => placementOf(linkbase(network(body)))).toThrow();
  });

  test("a prohibited arc is unreadable rather than silently applied", () => {
    const body =
      locator(`${FASB}#us-gaap_${lease}`, "p") +
      locator("issuer-20251231.xsd#issuer_FixedRateNotesOutstanding", "c") +
      arc("p", "c", "1", ' use="prohibited" priority="1"');
    expect(() => placementOf(linkbase(network(body)))).toThrow();
  });

  test("an extension schema without a target namespace is unreadable", () => {
    expect(() =>
      extensionSchema(
        `${FOLDER}/x.xsd`,
        '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>',
      ),
    ).toThrow();
  });
});

describe("a fact leaves the census only by a known nonmonetary type in a fitting unit", () => {
  const typed = (concept: string, xbrltype: string) =>
    new Map(TAGS).set(`${ISSUER}#${concept}`, { xbrltype });
  test.each([
    ["shares in a shares unit", "sharesItemType", 'unitRef="shares"', "published"],
    [
      "per-share in a currency-per-share unit",
      "perShareItemType",
      'unitRef="usdPerShare"',
      "published",
    ],
    ["per-share in a shares unit", "perShareItemType", 'unitRef="shares"', "unit-unreadable"],
    ["shares in a divide unit", "sharesItemType", 'unitRef="usdPerShare"', "unit-unreadable"],
    ["shares in a USD unit", "sharesItemType", 'unitRef="usd"', "unclassified-credit"],
    ["text with no unit", "stringItemType", "", "published"],
    ["text with a unit", "stringItemType", 'unitRef="shares"', "unit-unreadable"],
    ["an issuer type with no unit", "issuerMoneyItemType", "", "unit-unreadable"],
    ["an empty type with no unit", "", "", "unit-unreadable"],
    [
      "a prefixed shares type in a shares unit",
      "xbrli:sharesItemType",
      'unitRef="shares"',
      "unit-unreadable",
    ],
  ])("%s: %s", (_name, xbrltype, unit, outcome) => {
    const xml = instanceXml(
      `<issuer:AmountDueToLender contextRef="i" ${unit}>730001</issuer:AmountDueToLender>`,
    );
    const result = rejectOf(xml, undefined, typed("AmountDueToLender", xbrltype));
    expect(result).toBe(outcome === "published" ? outcome : `${outcome}:issuer:AmountDueToLender`);
  });

  test.each([
    ["shares in a shares unit", "sharesItemType", ' unitRef="shares"', "published"],
    ["shares in a USD unit", "sharesItemType", ' unitRef="usd"', "nil-fact"],
    ["an issuer type with no unit", "issuerMoneyItemType", "", "nil-fact"],
  ])("a nil fact typed %s: %s", (_name, xbrltype, unit, outcome) => {
    const xml = instanceXml(`<issuer:AmountDueToLender contextRef="i"${unit} xsi:nil="true"/>`);
    const result = rejectOf(xml, undefined, typed("AmountDueToLender", xbrltype));
    expect(result).toBe(outcome === "published" ? outcome : `${outcome}:issuer:AmountDueToLender`);
  });

  test("a zero with an unknown type and no unit cannot hide a balance", () => {
    const xml = instanceXml(
      '<issuer:AmountDueToLender contextRef="i">0</issuer:AmountDueToLender>',
    );
    expect(rejectOf(xml, undefined, typed("AmountDueToLender", "issuerMoneyItemType"))).toBe(
      "published",
    );
  });
});

describe("placement never pardons a standard concept", () => {
  test("a placement claiming the us-gaap namespace still leaves notes payable unclassified", () => {
    const placement: CalculationPlacement = {
      extensionNamespace: US_GAAP,
      parents: new Map([
        [
          `${US_GAAP}#NotesPayable`,
          [{ parent: `${US_GAAP}#OperatingLeaseLiability`, weight: "1" }],
        ],
      ]),
    };
    expect(rejectOf(instanceXml(fact("us-gaap:NotesPayable", 500_000)), placement)).toBe(
      "unclassified-credit:us-gaap:NotesPayable",
    );
  });

  test.each([
    ["us-gaap", "http://fasb.org/us-gaap/2025"],
    ["dei", "http://xbrl.sec.gov/dei/2025"],
    ["the XBRL instance", "http://www.xbrl.org/2003/instance"],
    ["IFRS", "https://xbrl.ifrs.org/taxonomy/2025-03-27/ifrs-full"],
  ])("an extension schema claiming the %s namespace is unreadable", (_name, namespace) => {
    expect(() =>
      extensionSchema(
        `${FOLDER}/x.xsd`,
        `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="${namespace}"><xs:element id="n" name="NotesPayable"/></xs:schema>`,
      ),
    ).toThrow();
  });
});

describe("schema identity is the top-level declaration", () => {
  const schemaOf = (elements: string) =>
    extensionSchema(
      `${FOLDER}/issuer-20251231.xsd`,
      `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="${ISSUER}">${elements}</xs:schema>`,
    );

  test("a nested local declaration is not a concept", () => {
    const schema = schemaOf(
      '<xs:element id="holder" name="Holder"><xs:complexType><xs:sequence><xs:element id="local" name="FixedRateNotesOutstanding"/></xs:sequence></xs:complexType></xs:element>',
    );
    expect([...schema.localById]).toEqual([["holder", "Holder"]]);
  });

  test.each([
    ["two elements", '<xs:element id="a" name="One"/><xs:element id="a" name="Two"/>'],
    [
      "an element and a nested type",
      '<xs:element id="a" name="One"/><xs:complexType name="T"><xs:sequence><xs:element id="a" name="Two"/></xs:sequence></xs:complexType>',
    ],
  ])("a duplicate id across %s is unreadable", (_name, elements) => {
    expect(() => schemaOf(elements)).toThrow();
  });
});

describe("calculation weights are compared as lexical decimals", () => {
  const lease = "OperatingLeaseLiability";
  const extension = instanceXml(fact("issuer:FixedRateNotesOutstanding", 500_000));
  const weighed = (weight: string) =>
    placementOf(linkbase(placedUnder(lease, "FixedRateNotesOutstanding", { weight })));

  test.each([["+1"], ["01.000"], ["1."], ["1"]])("weight %p is exactly one", (weight) => {
    expect(rejectOf(extension, weighed(weight))).toBe("published");
  });

  test.each([["1.0000000000000000001"], ["0.999999999999999999999"], ["-1.0"]])(
    "weight %p is not one",
    (weight) => {
      expect(rejectOf(extension, weighed(weight))).toBe(
        "unclassified-credit:issuer:FixedRateNotesOutstanding",
      );
    },
  );

  test("the same weight in two spellings is one relationship; a rounding-close one conflicts", () => {
    const twice = (a: string, b: string) =>
      placementOf(
        linkbase(
          network(
            locator(`${FASB}#us-gaap_${lease}`, "p") +
              locator("issuer-20251231.xsd#issuer_FixedRateNotesOutstanding", "c") +
              arc("p", "c", a) +
              arc("p", "c", b),
          ),
        ),
      );
    expect(() => twice("1", "+01.00")).not.toThrow();
    expect(() => twice("1", "1.0000000000000000001")).toThrow();
  });
});

describe("CLFD 10-Q 0001171843-26-003126 spellings that keep its placement", () => {
  const dir = join(import.meta.dir, "fixtures/sec-xbrl-instance");
  const folder = "https://www.sec.gov/Archives/edgar/data/796505/000117184326003126";
  const read = (file: string) => Bun.file(join(dir, file)).text();
  const proveClfd = async ({
    instance = (xml: string) => xml,
    calc = (xml: string) => xml,
  } = {}) => {
    const schema = extensionSchema(`${folder}/clfd-20260331.xsd`, await read("clfd-20260331.xsd"));
    return zeroBorrowingsInstanceProof(
      parseXbrlInstance(instance(await read("clfd20260331_10q_htm.xml"))),
      metaLinksTags(JSON.parse(await read("MetaLinks.json")), "clfd20260331_10q.htm")!,
      {
        extensionNamespace: schema.namespace,
        parents: summationParents(
          calc(await read("clfd-20260331_cal.xml")),
          `${folder}/clfd-20260331_cal.xml`,
          schema,
        ),
      },
      { periodEnd: "2026-03-31", file: "clfd20260331_10q_htm.xml", cik: "796505" },
    );
  };

  test.each([
    [
      "dot-relative locators",
      { calc: (xml: string) => xml.replaceAll("clfd-20260331.xsd#", "./clfd-20260331.xsd#") },
    ],
    [
      "absolute same-accession locators",
      {
        calc: (xml: string) =>
          xml.replaceAll('"clfd-20260331.xsd#', `"${folder}/clfd-20260331.xsd#`),
      },
    ],
    [
      "a second prefix for its namespace",
      {
        instance: (xml: string) =>
          xml.replace(
            "xmlns:clfd=",
            'xmlns:alias="http://www.clearfieldconnection.com/20260331" xmlns:clfd=',
          ),
      },
    ],
  ])("%s still prove c1613", async (_name, mutate) => {
    expect(await proveClfd(mutate)).toEqual({
      proof: expect.stringContaining("fact c1613"),
      currency: "USD",
    });
  });

  test("a single-quoted schema still names its calculation linkbase", async () => {
    const xsd = (await read("clfd-20260331.xsd")).replace(
      "</xsd:schema>",
      "<xsd:annotation><xsd:appinfo><link:linkbaseRef xlink:type='simple' xlink:href='clfd-20260331_cal.xml' xlink:role='http://www.xbrl.org/2003/role/calculationLinkbaseRef'/></xsd:appinfo></xsd:annotation></xsd:schema>",
    );
    expect(schemaCalculation(xsd.replaceAll('"', "'"))).toEqual({
      hrefs: ["clfd-20260331_cal.xml"],
      embedded: false,
    });
  });

  test("the instance names its schema and no calculation linkbase", async () => {
    const instance = parseXbrlInstance(await read("clfd20260331_10q_htm.xml"));
    expect(instance.schemaRefs).toEqual(["clfd-20260331.xsd"]);
    expect(instance.calculationLinkbaseRefs).toEqual([]);
  });

  test("xml:base anywhere makes the instance unreadable", async () => {
    const xml = await read("clfd20260331_10q_htm.xml");
    expect(() =>
      parseXbrlInstance(xml.replace("<link:schemaRef ", '<link:schemaRef xml:base="../x/" ')),
    ).toThrow("xml:base");
  });
});

describe("the instance grammar is closed", () => {
  const withContext = (extra: string, body = fact("us-gaap:NotesPayable", 500_000, "o")) =>
    instanceXml(body, { contexts: BASE_CONTEXTS + extra });

  test.each([
    [
      "two periods",
      `<context id="o"><entity><identifier scheme="http://www.sec.gov/CIK">1</identifier></entity><period><instant>2025-12-30</instant></period><period><instant>${END}</instant></period></context>`,
    ],
    [
      "an element inside an instant",
      context("o", "", `<instant>2025-12-30<issuer:date>${END}</issuer:date></instant>`),
    ],
    ["no entity", `<context id="o"><period><instant>${END}</instant></period></context>`],
    [
      "two entities",
      `<context id="o"><entity><identifier scheme="http://www.sec.gov/CIK">1</identifier></entity><entity><identifier scheme="http://www.sec.gov/CIK">2</identifier></entity><period><instant>${END}</instant></period></context>`,
    ],
    [
      "an identifier without a scheme",
      `<context id="o"><entity><identifier>1</identifier></entity><period><instant>${END}</instant></period></context>`,
    ],
    ["an unknown context child", context("o").replace("</context>", "<issuer:note/></context>")],
    ["a month 99 date", context("o", "", "<instant>2025-99-99</instant>")],
    ["February 30", context("o", "", "<instant>2025-02-30</instant>")],
  ])("a context with %s makes the instance unreadable", (_name, extra) => {
    expect(() => parseXbrlInstance(withContext(extra))).toThrow();
  });

  test("a fact wrapped in an unknown linkbase element makes the instance unreadable", () => {
    expect(() =>
      parseXbrlInstance(
        instanceXml(
          `<link:unrecognised>${fact("us-gaap:NotesPayable", 500_000)}</link:unrecognised>`,
        ),
      ),
    ).toThrow();
  });

  test("a footnote link is allowed and holds no facts", () => {
    expect(rejectOf(instanceXml('<link:footnoteLink xlink:type="extended" xlink:role="r"/>'))).toBe(
      "published",
    );
  });

  test("a nil fact with content makes the instance unreadable", () => {
    expect(() =>
      parseXbrlInstance(
        instanceXml(
          '<us-gaap:NotesPayable contextRef="i" unitRef="usd" xsi:nil="true">500000</us-gaap:NotesPayable>',
        ),
      ),
    ).toThrow();
  });

  test("a zero tagged for another entity withholds", () => {
    const other = `<context id="o"><entity><identifier scheme="http://www.sec.gov/CIK">0000000002</identifier></entity><period><instant>${END}</instant></period></context>`;
    expect(rejectOf(withContext(other, fact("us-gaap:LineOfCredit", 0, "o")))).toBe(
      "entity-mismatch:0000000002",
    );
  });

  test("a CIK identifier compares as a number", () => {
    expect(rejectOf(instanceXml().replaceAll(">1</identifier>", ">0000000001</identifier>"))).toBe(
      "published",
    );
  });

  test.each([["&#0;"], ["&#xD800;"], ["&#xFFFE;"], ["\u0001"]])(
    "the illegal character %p makes the XML unreadable",
    (char) => {
      expect(() =>
        parseXbrlInstance(instanceXml().replace("18398000", `18398000${char}`)),
      ).toThrow();
    },
  );

  test("a > inside a quoted attribute value is legal", () => {
    expect(
      rejectOf(instanceXml().replace('<context id="i">', '<context id="i" title="A > B">')),
    ).toBe("published");
  });
});

const metaLinksEntry = (tag: Record<string, unknown>) => ({ instance: { "q.htm": { tag } } });

describe("MetaLinks coverage and consistency", () => {
  const notes = { nsuri: US_GAAP, localname: "NotesPayable", xbrltype: MONETARY, crdr: "credit" };

  test("two entries giving one concept different balances are unreadable", () => {
    expect(
      metaLinksTags(metaLinksEntry({ a: notes, b: { ...notes, crdr: "debit" } }), "q.htm"),
    ).toBeUndefined();
    expect(metaLinksTags(metaLinksEntry({ a: notes, b: notes }), "q.htm")?.size).toBe(1);
  });

  test.each([
    ["an unknown balance", { ...notes, crdr: "sideways" }],
    ["no type", { nsuri: US_GAAP, localname: "NotesPayable", crdr: "credit" }],
  ])("an entry with %s is unreadable", (_name, tag) => {
    expect(metaLinksTags(metaLinksEntry({ a: tag }), "q.htm")).toBeUndefined();
  });

  test("a fact at the instant missing from MetaLinks withholds", () => {
    expect(rejectOf(instanceXml(), undefined, new Map())).toBe(
      "metalinks-missing:us-gaap:Liabilities",
    );
  });
});

describe("lexical decimal zero", () => {
  const tiny = `0.${"0".repeat(330)}1`;
  test("an anchor that underflows a double is not a zero", () => {
    const xml = instanceXml("", {
      facts: `${fact("us-gaap:Liabilities", 18_398_000)}${fact("us-gaap:LineOfCredit", tiny, "r")}`,
    });
    expect(rejectOf(xml)).toBe("untagged-zero");
  });

  test("a borrowing that underflows a double still counts in the census", () => {
    expect(rejectOf(instanceXml(fact("us-gaap:NotesPayable", tiny)))).toBe(
      "unclassified-credit:us-gaap:NotesPayable",
    );
  });

  test.each([["0.00"], ["-0"], ["+.0"]])("%s is a zero anchor", (zero) => {
    const xml = instanceXml("", {
      facts: `${fact("us-gaap:Liabilities", 18_398_000)}${fact("us-gaap:LineOfCredit", zero, "r")}`,
    });
    expect(rejectOf(xml)).toBe("published");
  });

  test.each([["1e3"], ["0x10"], ["Infinity"], ["1,000"]])("%s is unreadable", (value) => {
    expect(rejectOf(instanceXml(fact("us-gaap:NotesPayable", value)))).toBe(
      "value-unreadable:us-gaap:NotesPayable",
    );
  });
});
