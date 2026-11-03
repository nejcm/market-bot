import { describe, expect, test } from "bun:test";
import { extensionShortTermInvestmentsProof } from "../src/sources/sec-extension-investments-proof";
import { parseXbrlInstance } from "../src/sources/sec-xbrl-instance";

const US_GAAP = "http://fasb.org/us-gaap/2025";
const ISSUER = "http://issuer.example/20260930";
const END = "2026-09-30";
const LINE = "issuer:ShortTermInvestmentsExcludingFvo";
const LONG_LINE = "issuer:LongTermInvestmentsExcludingFvo";
const AXIS = "us-gaap:StatementOfFinancialPositionLocationBalanceAxis";

const context = (id: string, line?: string) =>
  `<context id="${id}"><entity><identifier scheme="http://www.sec.gov/CIK">1065088</identifier>${
    line === undefined
      ? ""
      : `<segment><xbrldi:typedMember dimension="${AXIS}"><us-gaap:QName.domain>${line}</us-gaap:QName.domain></xbrldi:typedMember></segment>`
  }</entity><period><instant>${END}</instant></period></context>`;
const fact = (concept: string, value: number, contextRef = "i", unit = "usd") =>
  `<${concept} id="${concept}-${contextRef}" contextRef="${contextRef}" unitRef="${unit}" decimals="-6">${value}</${concept}>`;

const BASE_FACTS = [
  fact("us-gaap:CashAndCashEquivalentsAtCarryingValue", 2000),
  fact(LINE, 809),
  fact("us-gaap:AccountsReceivableNetCurrent", 1977),
  fact("us-gaap:AssetsCurrent", 4786),
  fact(LONG_LINE, 300),
  fact("us-gaap:AvailableForSaleSecuritiesDebtSecurities", 809, "s"),
  fact("us-gaap:AvailableForSaleSecuritiesDebtSecurities", 300, "l"),
];

const instanceXml = (facts = BASE_FACTS) =>
  parseXbrlInstance(`<?xml version="1.0" encoding="utf-8"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:us-gaap="${US_GAAP}" xmlns:issuer="${ISSUER}"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
  xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink">
  <link:schemaRef xlink:href="issuer-20260930.xsd" xlink:type="simple"/>
  ${context("i")}${context("s", LINE)}${context("l", LONG_LINE)}
  <unit id="usd"><measure>iso4217:USD</measure></unit>
  <unit id="eur"><measure>iso4217:EUR</measure></unit>
  ${facts.join("")}
</xbrl>`);

const ASSETS_CURRENT = `${US_GAAP}#AssetsCurrent`;
const parents = (lineWeight = "1") =>
  new Map([
    [`${US_GAAP}#CashAndCashEquivalentsAtCarryingValue`, [{ parent: ASSETS_CURRENT, weight: "1" }]],
    [
      `${ISSUER}#ShortTermInvestmentsExcludingFvo`,
      [{ parent: ASSETS_CURRENT, weight: lineWeight }],
    ],
    [`${US_GAAP}#AccountsReceivableNetCurrent`, [{ parent: ASSETS_CURRENT, weight: "1" }]],
    [`${ISSUER}#LongTermInvestmentsExcludingFvo`, [{ parent: `${US_GAAP}#Assets`, weight: "1" }]],
  ]);

const prove = (instance = instanceXml(), placementParents = parents()) =>
  extensionShortTermInvestmentsProof(
    instance,
    { extensionNamespace: ISSUER, parents: placementParents },
    { file: "issuer-20260930_htm.xml", cik: "0001065088" },
  );
const without = (concept: string, contextRef = "i") =>
  BASE_FACTS.filter((row) => !row.startsWith(`<${concept} id="${concept}-${contextRef}"`));

describe("extensionShortTermInvestmentsProof", () => {
  test("proves a current-asset extension line its located investment facts sum to", () => {
    const proof = prove();
    expect(proof).toEqual({
      proved: [
        {
          periodEnd: END,
          concept: LINE,
          value: 809,
          currency: "USD",
          assetsCurrent: 4786,
          proof: `${LINE} = 809 USD at ${END}: adds into us-gaap:AssetsCurrent at weight 1, current assets foot to 4786, and us-gaap:AvailableForSaleSecuritiesDebtSecurities located on it sum to 809; fact ${LINE}-i, issuer-20260930_htm.xml`,
        },
      ],
      rejected: [],
    });
  });

  test("ignores a located line outside current assets", () => {
    const placement = parents();
    placement.delete(`${ISSUER}#ShortTermInvestmentsExcludingFvo`);
    expect(prove(instanceXml(), placement)).toEqual({ proved: [], rejected: [] });
  });

  test("rejects a line that adds into current assets at a weight other than 1", () => {
    expect(prove(instanceXml(), parents("-1"))).toEqual({
      proved: [],
      rejected: [{ periodEnd: END, reject: "assets-current-weight:-1" }],
    });
  });

  test("rejects current assets that do not foot", () => {
    const facts = [...without("us-gaap:AssetsCurrent"), fact("us-gaap:AssetsCurrent", 4800)];
    expect(prove(instanceXml(facts))).toEqual({
      proved: [],
      rejected: [{ periodEnd: END, reject: "current-assets-do-not-foot:4786≠4800" }],
    });
  });

  test("rejects located investment facts that do not sum to the line", () => {
    const facts = [
      ...without("us-gaap:AvailableForSaleSecuritiesDebtSecurities", "s"),
      fact("us-gaap:AvailableForSaleSecuritiesDebtSecurities", 800, "s"),
    ];
    expect(prove(instanceXml(facts))).toEqual({
      proved: [],
      rejected: [{ periodEnd: END, reject: "located-investments-do-not-sum:800≠809" }],
    });
  });

  test("rejects a line with no located investment facts", () => {
    expect(
      prove(instanceXml(without("us-gaap:AvailableForSaleSecuritiesDebtSecurities", "s"))),
    ).toEqual({
      proved: [],
      rejected: [{ periodEnd: END, reject: "no-located-investment-facts" }],
    });
  });

  test("rejects a missing AssetsCurrent total and a currency mismatch", () => {
    expect(prove(instanceXml(without("us-gaap:AssetsCurrent")))).toEqual({
      proved: [],
      rejected: [{ periodEnd: END, reject: "no-assets-current-fact" }],
    });
    const eur = [
      ...without("us-gaap:AvailableForSaleSecuritiesDebtSecurities", "s"),
      fact("us-gaap:AvailableForSaleSecuritiesDebtSecurities", 809, "s", "eur"),
    ];
    expect(prove(instanceXml(eur))).toEqual({
      proved: [],
      rejected: [
        {
          periodEnd: END,
          reject: "currency-mismatch:us-gaap:AvailableForSaleSecuritiesDebtSecurities",
        },
      ],
    });
  });

  test("rejects an instance filed for another entity", () => {
    expect(
      extensionShortTermInvestmentsProof(
        instanceXml(),
        { extensionNamespace: ISSUER, parents: parents() },
        { file: "x", cik: "2" },
      ),
    ).toEqual({ reject: "entity-mismatch:1065088" });
  });
});
