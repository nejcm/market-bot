import { describe, expect, test } from "bun:test";
import { secBalanceSheetFaceMetrics } from "../src/sources/sec-segment-facts";
import { zeroBorrowingsTextProof } from "../src/sources/sec-zero-borrowings-text";

// CLFD 10-Q 0001171843-26-005329, Debt note.
const CLFD =
  "On April 27, 2022, the Company entered into a loan agreement that provides a $ 40,000,000 revolving line of credit. As of June 30, 2026 and September 30, 2025, the Company had no borrowings against this line of credit. Net cash used in financing activities of discontinued operations totaled $1,196,000, driven by the factoring liability held by Nestor Cables.";
const proof = (text: string) => zeroBorrowingsTextProof(`<p>${text}</p>`, "2026-06-30");

describe("zero-borrowings text proof", () => {
  test("the CLFD sentence proves zero at its instant", () => {
    expect(proof(CLFD)).toEqual({
      zeroBorrowingText:
        "As of June 30, 2026 and September 30, 2025, the Company had no borrowings against this line of credit.",
    });
  });

  test.each([
    [
      "a comparative date only",
      "As of September 30, 2025, the Company had no borrowings against its line of credit.",
    ],
    [
      "a carve-out",
      "As of June 30, 2026, the Company had no borrowings other than its line of credit.",
    ],
    [
      "an amount",
      "As of June 30, 2026, the Company had no borrowings against its line of credit and $5 million of notes payable.",
    ],
    [
      "a contrast",
      "As of June 30, 2026, the Company had borrowings under its line of credit, whereas as of September 30, 2025, it had no borrowings under that line of credit.",
    ],
    [
      "a subsidiary subject",
      "As of June 30, 2026, our subsidiary Alpha had no borrowings under its line of credit.",
    ],
    [
      "an affiliate subject",
      "As of June 30, 2026, the Company's affiliate had no borrowings under its line of credit.",
    ],
    ["a denied claim", "The claim that as of June 30, 2026 the Company had no debt was false."],
    ["a denied zero", "As of June 30, 2026, it was not true that the Company had no debt."],
    ["a covenant statement", "As of June 30, 2026, the Company had no debt covenant violations."],
    [
      "a statement reported for another date",
      "As of June 30, 2026, the Company had no borrowings under its line of credit, as reported as of September 30, 2025.",
    ],
    [
      "an expectation",
      "The Company expects that as of June 30, 2026 it will have no borrowings under its line of credit.",
    ],
    ["a target date", "The Company had no borrowings under its line of credit by June 30, 2026."],
    [
      "letters of credit",
      "As of June 30, 2026, the Company had no borrowings under the line of credit, which backs letters of credit.",
    ],
  ])("%s rejects", (_name, sentence) => {
    expect(proof(sentence).zeroBorrowingText).toBeUndefined();
  });

  test("a bare no-debt sentence covers every facility", () => {
    expect(
      proof("The Company has a term loan. As of June 30, 2026, the Company had no debt.")
        .zeroBorrowingText,
    ).toBe("As of June 30, 2026, the Company had no debt.");
  });

  test("a continuing facility the sentence does not cover rejects", () => {
    expect(proof(`${CLFD} The Company also has a term loan with the bank.`)).toEqual({
      zeroBorrowingReject: "uncovered-facility:term loan",
    });
  });

  test("a revolving zero with any-of wording does not cover a term loan", () => {
    expect(
      proof(
        "The Company has a revolving line of credit and a term loan. As of June 30, 2026, the Company had no borrowings under any of its lines of credit.",
      ).zeroBorrowingText,
    ).toBeUndefined();
  });

  test.each([
    ["domestic and foreign", "domestic", "foreign"],
    ["secured and unsecured", "secured", "unsecured"],
  ])("%s facilities need a sentence each", (_name, first, second) => {
    const filing = `The Company has a ${first} line of credit and an ${second} line of credit.`;
    expect(
      proof(
        `${filing} As of June 30, 2026, the Company had no borrowings under its ${first} line of credit.`,
      ),
    ).toEqual({
      zeroBorrowingReject: "uncovered-facility:line of credit",
    });
    expect(
      proof(
        `${filing} As of June 30, 2026, the Company had no borrowings under its lines of credit.`,
      ).zeroBorrowingText,
    ).toBeDefined();
  });

  test.each([
    ["commercial paper", "The Company issues commercial paper."],
    [
      "an unmodified and a secured line in one sentence",
      "The Company has a line of credit and a secured line of credit.",
    ],
    ["plural term loans", "The Company has $10 million of term loans."],
    ["a term loan not held for sale", "The term loan is not held for sale."],
  ])("%s needs its own cover", (_name, filing) => {
    expect(proof(`${CLFD} ${filing}`).zeroBorrowingReject).toMatch(/^uncovered-facility:/u);
  });

  test("domestic revolving and foreign revolving lines are different facilities", () => {
    expect(
      proof(
        "The Company has a domestic revolving line of credit and a foreign revolving line of credit. As of June 30, 2026, the Company had no borrowings under its domestic revolving line of credit.",
      ),
    ).toEqual({ zeroBorrowingReject: "uncovered-facility:line of credit" });
  });

  test("parent-only statements reject", () => {
    expect(proof(`${CLFD} Condensed financial information of Registrant only.`)).toEqual({
      zeroBorrowingReject: "parent-only",
    });
  });

  test("a term loan unrelated to discontinued operations stays in coverage", () => {
    expect(proof(`${CLFD} The term loan is unrelated to discontinued operations.`)).toEqual({
      zeroBorrowingReject: "uncovered-facility:term loan",
    });
  });

  test("a disposal-group zero does not cover a continuing term loan", () => {
    expect(
      proof(
        "The Company has a term loan. As of June 30, 2026, the Company's discontinued operations had no borrowings under the term loan.",
      ).zeroBorrowingText,
    ).toBeUndefined();
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
