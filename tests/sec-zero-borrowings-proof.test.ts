import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { summationParents } from "../src/sources/sec-calculation-linkbase";
import { parseXbrlInstance } from "../src/sources/sec-xbrl-instance";
import {
  metaLinksTags,
  withoutTaggedZero,
  zeroBorrowingsInstanceProof,
  type ConceptTag,
} from "../src/sources/sec-zero-borrowings-proof";
import type { ExtendedEvidenceItem } from "../src/domain/evidence";

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
];
const TAGS: ReadonlyMap<string, ConceptTag> = new Map([
  ...CREDIT.map((name) => [`${US_GAAP}#${name}`, { crdr: "credit" }] as const),
  [`${US_GAAP}#LongTermDebtFairValue`, {}],
  [`${US_GAAP}#PrepaidExpenseCurrent`, { crdr: "debit" }],
  [`${ISSUER}#FixedRateNotesOutstanding`, { crdr: "credit" }],
  [`${ISSUER}#LeasePaymentsAfterYearFour`, { crdr: "credit" }],
]);

const prove = (
  xml: string,
  parents?: ReadonlyMap<string, ReadonlySet<string>>,
  tags: ReadonlyMap<string, ConceptTag> = TAGS,
) => zeroBorrowingsInstanceProof(parseXbrlInstance(xml), tags, parents, END, "q_htm.xml");
const rejectOf = (xml: string, parents?: ReadonlyMap<string, ReadonlySet<string>>) => {
  const result = prove(xml, parents);
  return "reject" in result ? result.reject : "published";
};

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
    const parents = summationParents(await Bun.file(join(dir, "clfd-20260331_cal.xml")).text());
    const file = "clfd20260331_10q_htm.xml";
    expect(zeroBorrowingsInstanceProof(instance, tags, undefined, "2026-03-31", file)).toEqual({
      reject: "unclassified-credit:clfd:LesseeOperatingLeaseLiabilityToBePaidAfterYearFour",
    });
    expect(zeroBorrowingsInstanceProof(instance, tags, parents, "2026-03-31", file)).toEqual({
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
    ["issuer:AmountDueToLender", "an extension MetaLinks does not list"],
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
    const parents = new Map([
      [
        "issuer:LeasePaymentsAfterYearFour",
        new Set(["us-gaap:LesseeOperatingLeaseLiabilityPaymentsDue"]),
      ],
    ]);
    expect(rejectOf(leaseExtension, parents)).toBe("published");
  });

  test.each([
    [["us-gaap:Liabilities"]],
    [["us-gaap:AccruedLiabilitiesCurrent"]],
    [["us-gaap:LesseeOperatingLeaseLiabilityPaymentsDue", "us-gaap:LiabilitiesCurrent"]],
  ])("an extension summed into %p is not placed", (parents: string[]) => {
    const placement = new Map([["issuer:LeasePaymentsAfterYearFour", new Set(parents)]]);
    expect(rejectOf(leaseExtension, placement)).toBe(
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
  ])("a nil zero tag %s is untagged", (attr, ns) => {
    expect(rejectOf(nilZero(attr, ns))).toBe("untagged-zero");
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
      contexts: `${BASE_CONTEXTS}<x:context xmlns:x="http://www.xbrl.org/2003/instance" id="o"><x:entity><x:identifier scheme="s">1</x:identifier></x:entity><x:period><x:instant>${END}</x:instant></x:period></x:context>`,
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
  test("an unlisted us-gaap credit concept withholds when MetaLinks lacks its tag", () => {
    const result = prove(
      instanceXml(fact("us-gaap:AccruedLiabilitiesCurrent", 5)),
      undefined,
      new Map(),
    );
    expect(result).toMatchObject({ proof: expect.any(String) });
    expect(
      prove(instanceXml(fact("us-gaap:OtherLiabilitiesCurrent", 5)), undefined, new Map()),
    ).toEqual({
      reject: "unclassified-credit:us-gaap:OtherLiabilitiesCurrent",
    });
  });

  test("MetaLinks for another primary document is unreadable", () => {
    expect(metaLinksTags({ instance: { "a.htm": { tag: {} } } }, "b.htm")).toBeUndefined();
    expect(metaLinksTags("not json", "b.htm")).toBeUndefined();
  });

  test("the disable switch drops the proof with its reason", () => {
    const item = {
      sourceIds: ["s"],
      metrics: { zeroBorrowingProof: "p", zeroBorrowingCurrency: "USD", form: "10-Q" },
    } as unknown as ExtendedEvidenceItem;
    expect(withoutTaggedZero(item).metrics).toEqual({
      form: "10-Q",
      zeroBorrowingReject: "tagged-zero debt disabled",
    });
  });
});

const linkbase = (arcs: string) =>
  `<link:linkbase xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink"><link:calculationLink xlink:role="r" xlink:type="extended"><link:loc xlink:href="x.xsd#us-gaap_LesseeOperatingLeaseLiabilityPaymentsDue" xlink:label="p" xlink:type="locator"/><link:loc xlink:href="i.xsd#issuer_LeaseAfterYearFour" xlink:label="c" xlink:type="locator"/>${arcs}</link:calculationLink></link:linkbase>`;
const arc = (extra = "") =>
  `<link:calculationArc xlink:arcrole="http://www.xbrl.org/2003/arcrole/summation-item" xlink:from="p" xlink:to="c" weight="1"${extra} xlink:type="arc"/>`;

describe("calculation linkbase summation parents", () => {
  test("maps an extension child to its us-gaap parent", () => {
    expect(summationParents(linkbase(arc()))).toEqual(
      new Map([
        [
          "issuer:LeaseAfterYearFour",
          new Set(["us-gaap:LesseeOperatingLeaseLiabilityPaymentsDue"]),
        ],
      ]),
    );
  });

  test("a prohibited arc is unreadable rather than silently applied", () => {
    expect(() => summationParents(linkbase(arc(' use="prohibited" priority="1"')))).toThrow();
  });
});
