import { describe, expect, test } from "bun:test";
import { normalizeFilingText, secFilingSectionPacket } from "../src/sources/sec-filing-text";

const MDNA = `ITEM 2. MANAGEMENT'S DISCUSSION ${"Revenue grew on stronger demand while margins held steady. ".repeat(8)}`;

function riskFactors(body: string): string {
  return `${MDNA} ITEM 1A. RISK FACTORS ${body} ITEM 2. UNREGISTERED SALES OF EQUITY SECURITIES None.`;
}

describe("short Risk Factors sections", () => {
  test("accepts a 10-Q no-material-changes disclosure in either order", () => {
    for (const body of [
      "Risk factors are described in Part I, Item 1A of our Annual Report on Form 10-K for fiscal 2025. There have been no material changes from those risk factors.",
      "There have been no material changes to the risk factors disclosed in our Annual Report on Form 10-K for the fiscal year ended 2025.",
    ]) {
      const result = secFilingSectionPacket(riskFactors(body), "10-Q");

      expect(result.packet).toContain(`[Risk Factors] ITEM 1A. RISK FACTORS ${body}`);
      expect(result.misses.map((miss) => miss.label)).toEqual(["Segments", "Notes"]);
    }
  });

  test("still rejects unrelated short sections, TOC lines, and short 10-K disclosures", () => {
    const unrelated = secFilingSectionPacket(
      riskFactors("Our business is subject to many risks described elsewhere in this report."),
      "10-Q",
    );
    const toc = secFilingSectionPacket(
      `ITEM 1A. RISK FACTORS 31 ITEM 2. UNREGISTERED SALES 31 ${MDNA}`,
      "10-Q",
    );
    const annual = secFilingSectionPacket(
      riskFactors(
        "There have been no material changes to the risk factors disclosed in our Annual Report on Form 10-K.",
      ).replace("ITEM 2. MANAGEMENT", "ITEM 7. MANAGEMENT"),
      "10-K",
    );

    for (const result of [unrelated, toc, annual]) {
      expect(result.packet).not.toContain("[Risk Factors]");
      expect(result.misses).toContainEqual(
        expect.objectContaining({ label: "Risk Factors", reason: "too-short" }),
      );
    }
  });

  test("leaves the packet undefined when no section is accepted", () => {
    expect(
      secFilingSectionPacket(
        "ITEM 1A. RISK FACTORS See the risks noted elsewhere in this quarterly report for detail.",
        "10-Q",
      ),
    ).toEqual({ packet: undefined, misses: [], sectionCount: 4 });
  });
});

const SAFE_HARBOR =
  "<p>The statements in this report include forward-looking statements about expectations, plans, and outlook that involve risks and uncertainties. </p>".repeat(
    10,
  );
const STATEMENTS = `<p>ITEM 1. CONDENSED CONSOLIDATED FINANCIAL STATEMENTS</p><table><tr><td>Total assets</td><td>$ 77,019</td><td>$ 76,926</td></tr><tr><td>Total liabilities</td><td>$ 14,812</td><td>$ 15,173</td></tr><tr><td>Net revenue</td><td>$ 9,245</td><td>$ 5,835</td></tr></table>${"<p>The accompanying notes are an integral part of these condensed consolidated statements. </p>".repeat(6)}`;
const RESULTS =
  "<p>Net revenue for the three months ended June 27, 2026 was $9.2 billion, up from $5.8 billion in the prior-year period. Client net revenue of $3.1 billion increased on stronger processor demand. </p>".repeat(
    4,
  );

function amdShaped10Q(
  results = `<p><b>Results of Continuing Operations</b></p>${RESULTS}`,
): string {
  return normalizeFilingText(
    [
      "<p>Table of Contents</p><p>Item 2 Management’s Discussion and Analysis of Financial Condition and Results of Operations 22</p><p>Item 3 Quantitative and Qualitative Disclosures about Market Risk 29</p>",
      STATEMENTS,
      "<p>21</p><p>Table of Contents</p><p>ITEM 2. MANAGEMENT’S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION AND RESULTS OF OPERATIONS</p>",
      SAFE_HARBOR,
      "<p>For a discussion of factors that could cause actual results to differ, see “Part II, Item 1A—Risk Factors” and the “Financial Condition” section set forth in “Part I, Item 2-Management’s Discussion and Analysis of Financial Condition and Results of Operations,” or MD&amp;A, which management reviews alongside segment trends and capital priorities for the period.</p>",
      results,
      "<p>Interest income decreased compared with the three months ended June 28, 2025.</p><p>29</p><p>Table of Contents</p><p>ITEM 3. QUANTITATIVE AND QUALITATIVE DISCLOSURES ABOUT MARKET RISK</p><p>Interest rate exposure is unchanged.</p>",
      `<p>ITEM 1A. RISK FACTORS</p>${"<p>Supply concentration, export restrictions, and competition could reduce demand for our products. </p>".repeat(6)}`,
      "<p>58</p><p>Table of Contents</p><p>ITEM 2. UNREGISTERED SALES OF EQUITY SECURITIES</p><p>None.</p>",
    ].join(""),
  );
}

function section(packet: string | undefined, label: string): string {
  return (packet ?? "").split("\n\n").find((part) => part.startsWith(`[${label}] `)) ?? "";
}

function amdShaped10K(resultsRepeat: number): string {
  return normalizeFilingText(
    [
      "<p>INDEX</p><p>ITEM 7. Management’s Discussion and Analysis 47</p><p>ITEM 7A. Quantitative and Qualitative Disclosure About Market Risk 57</p>",
      `<p>ITEM 1. BUSINESS</p>${"<p>We design processors and related software for data center, client, gaming, and embedded markets. </p>".repeat(5)}`,
      "<p>For more detail, see the discussion set forth in “Part II, Item 7-Management’s Discussion and Analysis of Financial Condition and Results of Operations,” which covers demand trends across every end market we serve today.</p>".repeat(
        4,
      ),
      "<p>46</p><p>Table of Contents</p><p>ITEM 7. MANAGEMENT’S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION AND RESULTS OF OPERATIONS</p>",
      "<p>Read this with “Part II, Item 8: Financial Statements and Supplementary Data.” </p>",
      `<p>Results of Operations</p>${"<p>Net revenue for 2025 was $34.6 billion compared to net revenue of $25.8 billion in 2024. </p>".repeat(resultsRepeat)}`,
      "<p>Liquidity remains adequate.</p><p>56</p><p>Table of Contents</p><p>ITEM 7A—QUANTITATIVE AND QUALITATIVE DISCLOSURE ABOUT MARKET RISK</p><p>Not material.</p>",
    ].join(""),
  );
}

describe("MD&A extraction", () => {
  test("AMD-shaped 10-Q reanchors on the results subheading past inline Item references", () => {
    const { packet } = secFilingSectionPacket(amdShaped10Q(), "10-Q");
    const mdna = section(packet, "MD&A");

    expect(mdna.startsWith("[MD&A] Results of Continuing Operations Net revenue")).toBe(true);
    expect(mdna).toContain("$9.2 billion");
    expect(mdna.length - "[MD&A] ".length).toBeLessThanOrEqual(3000);
    expect(mdna).not.toContain("Total assets");
    expect(mdna).not.toContain("QUANTITATIVE AND QUALITATIVE");
    expect(section(packet, "Risk Factors")).toContain(
      "[Risk Factors] ITEM 1A. RISK FACTORS Supply",
    );
  });

  test("falls back to the section start when no results subheading exists", () => {
    const { packet } = secFilingSectionPacket(amdShaped10Q(RESULTS), "10-Q");
    const mdna = section(packet, "MD&A");

    expect(mdna.startsWith("[MD&A] ITEM 2. MANAGEMENT’S DISCUSSION AND ANALYSIS")).toBe(true);
    expect(mdna).toContain("Part II, Item 1A—Risk Factors” and the “Financial Condition” section");
    expect(mdna).toContain("which management reviews");
  });

  test("CLFD-shaped 10-Q keeps reading past an annual-report Item 7. cross-reference", () => {
    const text = normalizeFilingText(
      [
        "<p>TABLE OF CONTENTS</p><p>ITEM 2. MANAGEMENT ’ S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION AND RESULTS OF OPERATIONS 23</p><p>ITEM 3. QUANTITATIVE AND QUALITATIVE DISCLOSURES ABOUT MARKET RISK 30</p>",
        STATEMENTS,
        "<p>ITEM 2. MANAGEMENT ’ S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION AND RESULTS OF OPERATIONS</p>",
        "<p>The following discussion and analysis should be read with the condensed consolidated financial statements. </p>".repeat(
          4,
        ),
        "<p>RESULTS OF OPERATIONS</p><p>THREE MONTHS ENDED JUNE 30, 2026 VS. THREE MONTHS ENDED JUNE 30, 2025</p>",
        "<p>Net sales for the three months ended June 30, 2026 were $41,914,000, an increase of 3%. </p>".repeat(
          3,
        ),
        "<p>These accounting estimates are described in Item 7. “Management’s Discussion and Analysis of Financial Condition and Results of Operations” of the Company’s Annual Report on Form 10-K. Gross profit rose on product mix. </p>",
        "<p>Actual results could differ unless required by law.</p><p>29</p><p>ITEM 3: QUANTITATIVE AND QUALITATIVE DISCLOSURES ABOUT MARKET RISK</p><p>Not material.</p>",
      ].join(""),
    );
    const mdna = section(secFilingSectionPacket(text, "10-Q").packet, "MD&A");

    expect(mdna.startsWith("[MD&A] RESULTS OF OPERATIONS THREE MONTHS ENDED")).toBe(true);
    expect(mdna).toContain("$41,914,000");
    expect(mdna).toContain("Gross profit rose on product mix");
    expect(mdna).not.toContain("QUANTITATIVE AND QUALITATIVE");
  });

  test("10-K skips cross-reference anchors and stops at a dashed heading after a page footer", () => {
    const mdna = section(secFilingSectionPacket(amdShaped10K(5), "10-K").packet, "MD&A");

    expect(
      mdna.startsWith("[MD&A] Results of Operations Net revenue for 2025 was $34.6 billion"),
    ).toBe(true);
    expect(mdna).toContain("Liquidity remains adequate");
    expect(mdna).not.toContain("QUANTITATIVE AND QUALITATIVE");
  });

  test("keeps the section start when the results tail is too short to select", () => {
    const mdna = section(secFilingSectionPacket(amdShaped10K(2), "10-K").packet, "MD&A");

    expect(mdna.startsWith("[MD&A] ITEM 7. MANAGEMENT’S DISCUSSION")).toBe(true);
    expect(mdna).toContain("Item 8: Financial Statements");
    expect(mdna).toContain("Liquidity remains adequate");
  });
});

const FILLER =
  "<p>Management reviews demand, pricing, and capital priorities each quarter. </p>".repeat(6);
const MARKET_RISK = `<p>Our hedges cover $750 million of notional exposure. </p>${FILLER}`;

function mixedCaseFiling(input: {
  readonly heading: string;
  readonly intro: string;
  readonly subheading: string;
  readonly nextHeading?: string;
}): string {
  return normalizeFilingText(
    [
      `<p>Prior statements end here.</p><p>${input.heading}</p>`,
      `<p>${input.intro}</p>`,
      FILLER,
      `<p>${input.subheading}</p>${RESULTS}`,
      `<p>Liquidity remains adequate.</p><p>${input.nextHeading ?? "Part I, Item 3. Quantitative and Qualitative Disclosures About Market Risk"}</p>`,
      MARKET_RISK,
    ].join(""),
  );
}

describe("heading rule", () => {
  test("accepts Part-prefixed mixed-case headings for both forms and stops at the next one", () => {
    for (const [form, heading, nextHeading] of [
      [
        "10-Q",
        "Part I, Item 2. Management’s Discussion and Analysis of Financial Condition and Results of Operations",
        "Part I, Item 3. Quantitative and Qualitative Disclosures About Market Risk",
      ],
      [
        "10-K",
        "Part II, Item 7. Management’s Discussion and Analysis of Financial Condition and Results of Operations",
        "Part II, Item 7A. Quantitative and Qualitative Disclosures About Market Risk",
      ],
    ] as const) {
      const mdna = section(
        secFilingSectionPacket(
          mixedCaseFiling({
            heading,
            intro: "Overview.",
            subheading: "Results of Operations",
            nextHeading,
          }),
          form,
        ).packet,
        "MD&A",
      );

      expect(mdna.startsWith("[MD&A] Results of Operations Net revenue")).toBe(true);
      expect(mdna).toContain("Liquidity remains adequate");
      expect(mdna).not.toContain("$750 million");
    }
  });

  test("inline Item references neither truncate MD&A nor open a Risk Factors section", () => {
    for (const reference of [
      "refer to Item 1A—Risk Factors",
      "See also Item 1A—Risk Factors",
      "pursuant to Item 1A—Risk Factors",
    ]) {
      const result = secFilingSectionPacket(
        mixedCaseFiling({
          heading: "ITEM 2. MANAGEMENT’S DISCUSSION AND ANALYSIS",
          intro: `For the risks that apply to us, ${reference} in this report.`,
          subheading: "RESULTS OF OPERATIONS",
        }),
        "10-Q",
      );

      expect(section(result.packet, "MD&A")).toContain("$9.2 billion");
      expect(result.packet).not.toContain("[Risk Factors]");
      expect(result.misses).toContainEqual({ label: "Risk Factors", reason: "absent" });
    }
  });

  test("results anchor skips prose and local contents entries and tolerates typography", () => {
    for (const subheading of ["Results Of Operations", "R ESULTS OF O PERATIONS"]) {
      const mdna = section(
        secFilingSectionPacket(
          mixedCaseFiling({
            heading:
              "ITEM 2. MANAGEMENT’S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION And Results of Operations",
            intro:
              "Contents: Overview 22 Results of Operations 25 Liquidity 27. Readers should consult Results of Operations below.",
            subheading,
          }),
          "10-Q",
        ).packet,
        "MD&A",
      );

      expect(mdna.startsWith(`[MD&A] ${subheading} Net revenue`)).toBe(true);
    }
  });
});

describe("heading rule edge cases", () => {
  test("anchors on a results heading followed by a formatted table figure", () => {
    const mdna = section(
      secFilingSectionPacket(
        mixedCaseFiling({
          heading: "ITEM 2. MANAGEMENT’S DISCUSSION AND ANALYSIS",
          intro: "Overview.",
          subheading:
            "Results of Operations</p><table><tr><td>91,344</td><td>88,120</td></tr></table><p>",
        }),
        "10-Q",
      ).packet,
      "MD&A",
    );

    expect(mdna.startsWith("[MD&A] Results of Operations 91,344")).toBe(true);
  });

  test("accepts a document-initial Part-prefixed heading for both forms", () => {
    for (const [form, heading] of [
      ["10-Q", "Part I, Item 2. MANAGEMENT’S DISCUSSION AND ANALYSIS"],
      ["10-K", "Part II, Item 7. MANAGEMENT’S DISCUSSION AND ANALYSIS"],
    ] as const) {
      const text = normalizeFilingText(
        `<p>${heading}</p>${FILLER}<p>Results of Operations</p>${RESULTS}`,
      );

      expect(section(secFilingSectionPacket(text, form).packet, "MD&A")).toContain("$9.2 billion");
    }
  });

  test("quoted and all-caps cross-references are not headings", () => {
    for (const reference of [
      'refer to "Part II, Item 1A—Risk Factors"',
      "Please see ITEM 1A—RISK FACTORS",
    ]) {
      const result = secFilingSectionPacket(
        mixedCaseFiling({
          heading: "ITEM 2. MANAGEMENT’S DISCUSSION AND ANALYSIS",
          intro: `For the risks that apply to us, ${reference} in this report.`,
          subheading: "RESULTS OF OPERATIONS",
        }),
        "10-Q",
      );

      expect(section(result.packet, "MD&A")).toContain("$9.2 billion");
      expect(result.misses).toContainEqual({ label: "Risk Factors", reason: "absent" });
    }
  });

  test("results anchor skips colon prose, dotted leaders and parenthesized pages", () => {
    for (const intro of [
      "We discuss these topics: Results of Operations below.",
      "Overview 22 Results of Operations ........ 24 Liquidity 27.",
      "Overview (22) Results of Operations (24) Liquidity (27).",
    ]) {
      const mdna = section(
        secFilingSectionPacket(
          mixedCaseFiling({
            heading: "ITEM 2. MANAGEMENT’S DISCUSSION AND ANALYSIS",
            intro,
            subheading: "RESULTS OF OPERATIONS",
          }),
          "10-Q",
        ).packet,
        "MD&A",
      );

      expect(mdna.startsWith("[MD&A] RESULTS OF OPERATIONS Net revenue")).toBe(true);
    }
  });
});

describe("page furniture from cached filings", () => {
  const body =
    "<p>We build networks and serve carriers, governments, and enterprise customers worldwide. </p>".repeat(
      6,
    );

  test("lowercase Table of contents footer precedes real Risk Factors and MD&A (Vertiv 10-K)", () => {
    const text = normalizeFilingText(
      [
        "<p>Requests should be directed to investor relations.</p><p>14</p><p>Table of contents</p>",
        `<p>Item 1A. Risk Factors</p>${body}`,
        "<p>Requests end here.</p><p>36</p><p>Table of contents</p>",
        `<p>Item 7. Management’s Discussion and Analysis</p>${body}`,
      ].join(""),
    );
    const { packet } = secFilingSectionPacket(text, "10-K");

    expect(
      section(packet, "Risk Factors").startsWith("[Risk Factors] Item 1A. Risk Factors We build"),
    ).toBe(true);
    expect(section(packet, "MD&A").startsWith("[MD&A] Item 7. Management’s Discussion")).toBe(true);
  });

  test("Roman page footer precedes a Part-prefixed Business heading (ASTS 10-K)", () => {
    const text = normalizeFilingText(
      `<p>future events or otherwise.</p><p>vi</p><p>PART I</p><p>Item 1. Business</p>${body}`,
    );

    expect(section(secFilingSectionPacket(text, "10-K").packet, "Business")).toContain(
      "[Business] Item 1. Business We build",
    );
  });

  test("a Roman token inside prose is not page furniture", () => {
    const result = secFilingSectionPacket(
      mixedCaseFiling({
        heading: "ITEM 2. MANAGEMENT’S DISCUSSION AND ANALYSIS",
        intro:
          "For the risks that apply to us, refer to Appendix vi Item 1A—Risk Factors in this report.",
        subheading: "RESULTS OF OPERATIONS",
      }),
      "10-Q",
    );

    expect(section(result.packet, "MD&A")).toContain("$9.2 billion");
    expect(result.misses).toContainEqual({ label: "Risk Factors", reason: "absent" });
  });
});
