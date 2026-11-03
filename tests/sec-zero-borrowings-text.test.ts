import { describe, expect, test } from "bun:test";
import { secBalanceSheetFaceMetrics } from "../src/sources/sec-segment-facts";
import { factValue } from "../src/sources/sec-ixbrl-fact";
import { UNTAGGED_ZERO, zeroBorrowingsTagProof } from "../src/sources/sec-zero-borrowings-text";

const DEC = "2025-12-31";
const REVOLVER = [
  ["us-gaap:CreditFacilityAxis", "us-gaap:RevolvingCreditFacilityMember"],
  [
    "us-gaap:DebtInstrumentAxis",
    "clfd:LoanAndSecurityAgreementWithBremerBankNationalAssociationMember",
  ],
] as const;
const context = (
  id: string,
  instant: string,
  members: readonly (readonly [string, string])[] = [],
) =>
  `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000796505</xbrli:identifier>${
    members.length === 0
      ? ""
      : `<xbrli:segment>${members.map(([axis, member]) => `<xbrldi:explicitMember dimension="${axis}">${member}</xbrldi:explicitMember>`).join("")}</xbrli:segment>`
  }</xbrli:entity><xbrli:period><xbrli:instant>${instant}</xbrli:instant></xbrli:period></xbrli:context>`;
const fact = (
  id: string,
  contextRef: string,
  name: string,
  shown: string,
  extra = 'format="ixt:num-dot-decimal" scale="0"',
) =>
  `<ix:nonFraction id="${id}" contextRef="${contextRef}" unitRef="USD" name="${name}" ${extra}>${shown}</ix:nonFraction>`;
const filing = (hidden: readonly string[], contexts: readonly string[], prose: string) =>
  `<html><body><div style="display:none"><ix:header><ix:hidden>${hidden.join("")}</ix:hidden><ix:resources>${contexts.join("")}</ix:resources></ix:header></div>${prose}</body></html>`;

// Trimmed from CLFD 10-Q 2025-12-31 (debt note): the hidden LineOfCredit = 0 linked to the word "no".
const CLFD_SENTENCE =
  "As of December 31, 2025 and September 30, 2025, the Company had no borrowings against this line of credit.";
const CLFD_PROSE =
  '<p>On April 27, 2022, the Company entered into a loan agreement that provides a $40,000,000 revolving line of credit.</p><p>As of December 31, 2025 and September 30, 2025, the Company had <span style="-sec-ix-hidden:c1292"><span style="-sec-ix-hidden:c1293">no</span></span> borrowings against this line of credit.</p>';
const CLFD_ZERO = fact("c1292", "rev-dec", "us-gaap:LineOfCredit", "0");
const CLFD_CONTEXTS = [
  context("rev-dec", DEC, REVOLVER),
  context("rev-sep", "2025-09-30", REVOLVER),
  context("dec", DEC),
];
const CLFD_FACT =
  "us-gaap:LineOfCredit = 0 [us-gaap:CreditFacilityAxis=us-gaap:RevolvingCreditFacilityMember, us-gaap:DebtInstrumentAxis=clfd:LoanAndSecurityAgreementWithBremerBankNationalAssociationMember]";
const clfd = (hidden: readonly string[] = [CLFD_ZERO], prose = CLFD_PROSE) =>
  zeroBorrowingsTagProof(filing(hidden, CLFD_CONTEXTS, prose), DEC);
const rejectOf = (proof: Readonly<Record<string, string>>) => proof.zeroBorrowingReject;

describe("zero-borrowings tagged-zero proof", () => {
  test("the CLFD hidden LineOfCredit = 0 publishes with its linked sentence", () => {
    expect(clfd()).toEqual({ zeroBorrowingText: CLFD_SENTENCE, zeroBorrowingFact: CLFD_FACT });
  });

  test("a visible zero fact cites the sentence it sits in", () => {
    const prose = `<p>At December 31, 2025, commercial paper outstanding was $${fact("v", "dec", "us-gaap:CommercialPaper", "—", 'format="ixt:fixed-zero"')} under the program.</p>`;
    expect(zeroBorrowingsTagProof(filing([], CLFD_CONTEXTS, prose), DEC)).toEqual({
      zeroBorrowingText:
        "At December 31, 2025, commercial paper outstanding was $ — under the program.",
      zeroBorrowingFact: "us-gaap:CommercialPaper = 0",
    });
  });

  test.each([
    ["the dot-decimal 0", fact("z", "dec", "us-gaap:LineOfCredit", "0")],
    ["a fixed-zero dash", fact("z", "dec", "us-gaap:LineOfCredit", "—", 'format="ixt:fixed-zero"')],
    [
      "a signed scaled 0",
      fact(
        "z",
        "dec",
        "us-gaap:LineOfCredit",
        "0",
        'format="ixt:num-dot-decimal" scale="6" sign="-"',
      ),
    ],
  ])("%s is a tagged zero", (_name, zero) => {
    const prose = CLFD_PROSE.slice(CLFD_PROSE.indexOf("</p>") + 4);
    expect(clfd([zero.replace('id="z"', 'id="c1292"')], prose).zeroBorrowingFact).toBe(
      "us-gaap:LineOfCredit = 0",
    );
  });

  test.each([
    [
      "a dash shown in a decimal format",
      fact("c1292", "dec", "us-gaap:LineOfCredit", "-"),
      "untagged-zero",
    ],
    [
      "a zero at a prior instant only",
      fact("c1292", "rev-sep", "us-gaap:LineOfCredit", "0"),
      "untagged-zero",
    ],
    [
      "a zero on a non-borrowing concept",
      fact("c1292", "rev-dec", "us-gaap:LineOfCreditFacilityMaximumBorrowingCapacity", "0"),
      "untagged-zero",
    ],
    [
      "a zero on a custom concept",
      fact("c1292", "rev-dec", "clfd:LineOfCreditBorrowings", "0"),
      "untagged-zero",
    ],
  ])("%s does not publish", (_name, zero, code) => {
    expect(rejectOf(clfd([zero]))).toBe(code);
  });

  test.each([
    [
      "a nonzero default-context debt fact",
      fact("n", "dec", "us-gaap:LongTermDebtNoncurrent", "12,500"),
    ],
    ["a nonzero custom-namespace borrowing", fact("n", "dec", "clfd:EquipmentTermLoan", "300")],
    [
      "a nonzero disposal-group debt fact",
      fact(
        "n",
        "dec",
        "clfd:DisposalGroupIncludingDiscontinuedOperationLongtermDebtCurrent",
        "1,196",
      ),
    ],
    ["an unreadable borrowing value", fact("n", "dec", "us-gaap:NotesPayable", "n/a")],
  ])("%s at the instant rejects the zero", (_name, nonzero) => {
    expect(rejectOf(clfd([CLFD_ZERO, nonzero]))).toMatch(/^nonzero:/u);
  });

  test("a nonzero capacity or debt-securities holding is not a borrowing", () => {
    const capacity = fact(
      "m",
      "rev-dec",
      "us-gaap:LineOfCreditFacilityMaximumBorrowingCapacity",
      "40,000,000",
    );
    const securities = fact(
      "s",
      "dec",
      "us-gaap:AvailableForSaleSecuritiesDebtSecurities",
      "9,000",
    );
    expect(clfd([CLFD_ZERO, capacity, securities]).zeroBorrowingFact).toBe(CLFD_FACT);
  });

  test("a facility kind the tagged zeros do not name stays withheld", () => {
    const prose = `${CLFD_PROSE}<p>The term loan is unrelated to discontinued operations.</p>`;
    expect(rejectOf(clfd([CLFD_ZERO], prose))).toBe("uncovered-facility:term loan");
  });

  test("a facility named only for discontinued operations needs no tag", () => {
    const prose = `${CLFD_PROSE}<p>The factoring arrangement of discontinued operations held for sale was repaid.</p>`;
    expect(clfd([CLFD_ZERO], prose).zeroBorrowingFact).toBe(CLFD_FACT);
  });

  test("a parent-company-only filing is rejected", () => {
    expect(
      rejectOf(
        clfd(
          [CLFD_ZERO],
          `${CLFD_PROSE}<p>Condensed financial information, parent company only.</p>`,
        ),
      ),
    ).toBe("parent-only");
  });

  test.each([
    ["an unlinked hidden zero", CLFD_PROSE.replaceAll(/ style="-sec-ix-hidden:c129\d"/gu, "")],
    [
      "a hidden zero linked from a table cell",
      '<table><tr><td>Line of credit</td><td><span style="-sec-ix-hidden:c1292">—</span></td></tr></table>',
    ],
    ["a link to a longer id only", CLFD_PROSE.replace("c1292", "c12920")],
  ])("%s is not cited", (_name, prose) => {
    expect(rejectOf(clfd([CLFD_ZERO], prose))).toBe("zero-not-cited");
  });

  // Prose the earlier sentence verifier was probed with (round 1-2 reviews): with no tagged zero none publishes.
  test.each([
    [
      "A1",
      "As of December 31, 2025, the outstanding borrowings under the line of credit bear interest at a rate of no less than 5%.",
    ],
    [
      "A2",
      "Subsequent to December 31, 2025, we repaid all borrowings under the line of credit and, as of February 15, 2026, no amounts were drawn.",
    ],
    ["A3", "At December 31, 2025, there were no amounts drawn under the Company's line of credit."],
    [
      "A4",
      "Subsidiaries of the Company had no borrowings under their line of credit as of December 31, 2025.",
    ],
    [
      "A6",
      "Borrowings outstanding under the line of credit were 12,500 at December 31, 2025, compared with no borrowings at December 31, 2024.",
    ],
    ["A7", CLFD_SENTENCE],
    [
      "B1",
      "As of December 31, 2025, the term loan remained fully drawn – the Company had no borrowings under its line of credit.",
    ],
    [
      "B4",
      "If the Company has no borrowings under the line of credit as of December 31, 2025, no commitment fee is payable.",
    ],
    [
      "B5",
      "As of December 31, 2025, the Company shall have no borrowings under its line of credit.",
    ],
    [
      "B10",
      "Unless the Company had no borrowings under its line of credit as of December 31, 2025, interest accrues.",
    ],
  ])("probe %s in untagged prose is withheld", (_probe, sentence) => {
    expect(rejectOf(clfd([], `<p>${sentence}</p>`))).toBe("untagged-zero");
  });

  test("probe A2 with the zero tagged only at its later date is withheld", () => {
    const later = context("feb", "2026-02-15", REVOLVER);
    const prose =
      '<p>As of February 15, 2026, <span style="-sec-ix-hidden:c1292">no</span> amounts were drawn.</p>';
    expect(
      rejectOf(
        zeroBorrowingsTagProof(
          filing(
            [fact("c1292", "feb", "us-gaap:LineOfCredit", "0")],
            [...CLFD_CONTEXTS, later],
            prose,
          ),
          DEC,
        ),
      ),
    ).toBe("untagged-zero");
  });

  test("probe A6 with its amount tagged is rejected by the nonzero fact", () => {
    expect(
      rejectOf(clfd([CLFD_ZERO, fact("a6", "rev-dec", "us-gaap:LineOfCredit", "12,500")])),
    ).toBe("nonzero:us-gaap:LineOfCredit");
  });

  // B-probes zero the line of credit while stating another facility; the census holds them whatever the grammar.
  test.each([
    [
      "A3",
      "The Company has senior notes due 2030 and a term loan.",
      "uncovered-facility:senior notes/term loan",
    ],
    [
      "B2",
      "As of December 31, 2025, the Company had no amounts outstanding under its term loan.",
      "uncovered-facility:term loan",
    ],
    [
      "B3",
      "The Company had borrowings outstanding under its term loan.",
      "uncovered-facility:term loan",
    ],
    ["B7", "The term loan was fully drawn.", "uncovered-facility:term loan"],
    ["B9", "The term loan balance was five million dollars.", "uncovered-facility:term loan"],
    [
      "B11",
      "Although the term loan had been drawn in full, the Company had no other borrowings.",
      "uncovered-facility:term loan",
    ],
    [
      "B12",
      "The Company had no borrowings, as the term loan had been drawn in full.",
      "uncovered-facility:term loan",
    ],
    ["B13", "Borrowings under the term loan were not repaid.", "uncovered-facility:term loan"],
    [
      "B14",
      "The revolver was undrawn, and the term loan was outstanding in full.",
      "uncovered-facility:term loan",
    ],
    [
      "B15",
      "The Company had drawn the term loan in full and had no borrowings under its revolver.",
      "uncovered-facility:term loan",
    ],
  ])("probe %s beside a tagged line-of-credit zero is withheld", (_probe, sentence, code) => {
    expect(rejectOf(clfd([CLFD_ZERO], `${CLFD_PROSE}<p>${sentence}</p>`))).toBe(code);
  });

  test.each([
    [
      "B6",
      "As of December 31, 2025, the Company is required to maintain no borrowings under its line of credit.",
    ],
    ["B8", "As of December 31, 2025, the Company had no borrowings under its line of credit.¹"],
  ])("probe %s with no tag behind it is withheld", (_probe, sentence) => {
    expect(rejectOf(clfd([], `${CLFD_PROSE}<p>${sentence}</p>`))).toBe("untagged-zero");
  });

  test("an untagged liability row breaks footing, so no face is read", () => {
    const html = [
      '<xbrli:context id="c"><xbrli:entity></xbrli:entity><xbrli:period><xbrli:instant>2026-06-30</xbrli:instant></xbrli:period></xbrli:context><table>',
      '<tr><td>Total assets</td><td><ix:nonFraction name="us-gaap:Assets" contextRef="c" unitRef="usd">300</ix:nonFraction></td></tr>',
      '<tr><td>Accounts payable</td><td><ix:nonFraction name="us-gaap:AccountsPayableCurrent" contextRef="c" unitRef="usd">10</ix:nonFraction></td></tr>',
      "<tr><td>Bank loan</td><td>5</td></tr>",
      '<tr><td>Total current liabilities</td><td><ix:nonFraction name="us-gaap:LiabilitiesCurrent" contextRef="c" unitRef="usd">15</ix:nonFraction></td></tr>',
      '<tr><td>Total liabilities</td><td><ix:nonFraction name="us-gaap:Liabilities" contextRef="c" unitRef="usd">15</ix:nonFraction></td></tr>',
      "</table>",
    ].join("");
    expect(secBalanceSheetFaceMetrics(html, "2026-06-30")).toEqual({});
  });
});

// Sol's review snippets: a hidden LineOfCredit = 0 in context "r" (a domestic revolver), linked to "no".
const DOMESTIC = [["us-gaap:DebtInstrumentAxis", "issuer:DomesticRevolverMember"]] as const;
const SOL_ZERO = fact("z", "r", "us-gaap:LineOfCredit", "0");
const SOL_PROSE =
  '<p>At December 31, 2025, the Company had <span style="-sec-ix-hidden:z">no</span> borrowings under its domestic line of credit.</p>';
const sol = (
  hidden: readonly string[] = [SOL_ZERO],
  prose = SOL_PROSE,
  contexts: readonly string[] = [context("r", DEC, DOMESTIC)],
) => zeroBorrowingsTagProof(filing(hidden, contexts, prose), DEC);

describe("zero-borrowings tagged-zero proof, review probes", () => {
  test("the domestic revolver's linked zero publishes on its own", () => {
    expect(sol()).toEqual({
      zeroBorrowingText:
        "At December 31, 2025, the Company had no borrowings under its domestic line of credit.",
      zeroBorrowingFact:
        "us-gaap:LineOfCredit = 0 [us-gaap:DebtInstrumentAxis=issuer:DomesticRevolverMember]",
    });
  });

  test.each([
    [
      "a second, foreign line of credit",
      "<p>The foreign line of credit had $500,000 outstanding, included in accrued liabilities.</p>",
      "uncovered-facility:foreign line of credit",
    ],
    [
      "a promissory note",
      "<p>The Company issued a promissory note with $500,000 outstanding.</p>",
      "uncovered-facility:promissory note",
    ],
    [
      "a separate equipment loan agreement",
      "<p>The Company has a separate equipment loan agreement with $500,000 outstanding.</p>",
      "uncovered-facility:equipment loan agreement",
    ],
  ])("one facility's zero does not cover %s", (_name, paragraph, code) => {
    expect(rejectOf(sol([SOL_ZERO], `${SOL_PROSE}${paragraph}`))).toBe(code);
  });

  test("a disposal-group zero is not issuer-wide evidence", () => {
    const disposal = context("r", DEC, [
      [
        "us-gaap:DisposalGroupClassificationAxis",
        "us-gaap:DisposalGroupIncludingDiscontinuedOperationMember",
      ],
    ]);
    expect(rejectOf(sol([SOL_ZERO], SOL_PROSE, [disposal]))).toBe(
      "scoped-zero:us-gaap:DisposalGroupClassificationAxis",
    );
  });

  test.each([
    ["us-gaap:FinanceLeaseLiabilityCurrent", "nonzero:us-gaap:FinanceLeaseLiabilityCurrent"],
    [
      "issuer:RevolvingCreditFacilityOutstandingBalance",
      "extension-borrowing:issuer:RevolvingCreditFacilityOutstandingBalance",
    ],
    ["issuer:SeniorNotes", "extension-borrowing:issuer:SeniorNotes"],
  ])("a nonzero %s at the instant vetoes the zero", (name, code) => {
    expect(rejectOf(sol([SOL_ZERO, fact("n", "r", name, "500,000")]))).toBe(code);
  });

  test("an issuer operating-lease balance or zero extension debt does not veto", () => {
    const extensions = [
      fact("n", "r", "issuer:LesseeOperatingLeaseLiabilityToBePaidAfterYearFour", "1,447,000"),
      fact("m", "r", "issuer:DisposalGroupIncludingDiscontinuedOperationLongtermDebtCurrent", "0"),
    ];
    expect(sol([SOL_ZERO, ...extensions]).zeroBorrowingFact).toBeDefined();
  });

  test("a nil fixed-zero fact is no zero", () => {
    const nil =
      '<ix:nonFraction id="z" contextRef="r" unitRef="USD" name="us-gaap:LineOfCredit" xsi:nil="true" format="ixt:fixed-zero"></ix:nonFraction>';
    expect(factValue('xsi:nil="true" format="ixt:fixed-zero"', "")).toBeUndefined();
    expect(rejectOf(sol([nil]))).toBe(UNTAGGED_ZERO);
  });

  test.each([
    [
      "a nil fixed-zero",
      '<ix:nonFraction id="n" contextRef="r" unitRef="USD" name="us-gaap:NotesPayable" xsi:nil="true" format="ixt:fixed-zero"></ix:nonFraction>',
    ],
    [
      "a self-closed nil",
      '<ix:nonFraction id="n" contextRef="r" unitRef="USD" name="us-gaap:NotesPayable" xsi:nil="true"/>',
    ],
  ])("%s borrowing beside the zero is unreadable, so it vetoes", (_name, nil) => {
    expect(rejectOf(sol([SOL_ZERO, nil]))).toBe("nonzero:us-gaap:NotesPayable");
  });

  test.each([
    ["an extra namespace declaration", '<xbrli:context id="other" xmlns:x="urn:test">'],
    ["a single-quoted id", "<xbrli:context id='other'>"],
  ])("a nonzero fact in a context with %s still vetoes", (_name, opening) => {
    const other = context("other", DEC, [
      ["us-gaap:DebtInstrumentAxis", "issuer:ForeignRevolverMember"],
    ]).replace('<xbrli:context id="other">', opening);
    const nonzero = fact("n", "other", "us-gaap:LineOfCredit", "500,000");
    expect(
      rejectOf(sol([SOL_ZERO, nonzero], SOL_PROSE, [context("r", DEC, DOMESTIC), other])),
    ).toBe("nonzero:us-gaap:LineOfCredit");
  });

  test("a borrowing fact whose context does not resolve vetoes", () => {
    expect(rejectOf(sol([SOL_ZERO, fact("n", "missing", "us-gaap:LineOfCredit", "500,000")]))).toBe(
      "unresolved-fact:us-gaap:LineOfCredit",
    );
  });

  test.each([
    [
      "an unrelated linked phrase",
      '<p>Our <span style="-sec-ix-hidden:z">international business</span> continues expanding in overseas markets.</p>',
    ],
    [
      "the link text outside a style attribute",
      "<p>At December 31, 2025, the note -sec-ix-hidden:z says no borrowings under its domestic line of credit.</p>",
    ],
  ])("%s is not a cited zero", (_name, prose) => {
    expect(rejectOf(sol([SOL_ZERO], prose))).toBe("zero-not-cited");
  });

  test("the quote stays within its block, so a preceding table is not quoted", () => {
    const prose = `<table><tr><td>Accrued liabilities</td><td>5,000,000</td></tr></table>${SOL_PROSE.slice(3)}`;
    expect(sol([SOL_ZERO], prose).zeroBorrowingText).toBe(
      "At December 31, 2025, the Company had no borrowings under its domestic line of credit.",
    );
  });
});
