import { describe, expect, test } from "bun:test";
import type { ResearchReport } from "../src/domain/types";
import { renderMarkdownReport } from "../src/report/markdown";
import { assertSafeReportLanguage, validateResearchReport } from "../src/report/schema";
import { reverseDcfArtifact } from "./support/fixtures";

function report(summary = "Evidence is sourced and caveated."): ResearchReport {
  return {
    runId: "golden",
    jobType: "daily",
    assetClass: "equity",
    generatedAt: "2026-05-19T00:00:00.000Z",
    summary,
    keyFindings: [
      { text: "Liquidity is sufficient for research coverage.", sourceIds: ["source-1"] },
    ],
    bullCase: [],
    bearCase: [],
    risks: [{ text: "Coverage is narrow.", sourceIds: ["source-1"] }],
    catalysts: [],
    scenarios: [{ name: "Base", description: "Conditions remain mixed.", sourceIds: ["source-1"] }],
    confidence: "low",
    dataGaps: ["No macro source"],
    predictions: [],
    sources: [
      {
        id: "source-1",
        title: "Market snapshot",
        fetchedAt: "2026-05-19T00:00:00.000Z",
        kind: "market-data",
        assetClass: "equity",
      },
    ],
    notFinancialAdvice: true,
  };
}

describe("golden report contracts", () => {
  test("Markdown includes source references, caveats, and one research-only note", () => {
    const markdown = renderMarkdownReport(validateResearchReport(report()));

    expect(markdown).toContain("[source-1]");
    expect(markdown).toContain("No macro source");
    expect(markdown.match(/Research-only note/gu)?.length).toBe(1);
  });

  test("equity Markdown ends with one newline regardless of final appendix population", () => {
    const equityReport = { ...report(), jobType: "equity" as const, symbol: "AAPL" };
    const outputs = [
      renderMarkdownReport(equityReport),
      renderMarkdownReport(equityReport, undefined, { reverseDcf: reverseDcfArtifact() }),
    ];

    for (const markdown of outputs) {
      expect(markdown.endsWith("\n")).toBe(true);
      expect(markdown.endsWith("\n\n")).toBe(false);
    }
  });

  test("non-equity report types retain the legacy section order without an appendix", () => {
    const reports: readonly ResearchReport[] = [
      { ...report(), jobType: "market-overview" },
      { ...report(), jobType: "crypto", assetClass: "crypto", symbol: "BTC" },
      { ...report(), jobType: "research" },
      { ...report(), jobType: "alpha-search" },
    ];
    for (const candidate of reports) {
      const markdown = renderMarkdownReport(candidate);
      expect(markdown).not.toContain("## Appendix");
      if (candidate.jobType === "alpha-search") {
        expect(markdown).toContain("## Research Leads");
        continue;
      }
      const summary = markdown.indexOf("## Summary");
      const findings = markdown.indexOf("## Key Findings");
      const risks = markdown.indexOf("## Risks");
      const dataGaps = markdown.indexOf("## Data Gaps");
      expect(summary).toBeGreaterThanOrEqual(0);
      expect(findings).toBeGreaterThan(summary);
      expect(risks).toBeGreaterThan(findings);
      expect(dataGaps).toBeGreaterThan(risks);
    }
  });

  test("safety scanner blocks trade-action wording", () => {
    expect(() => assertSafeReportLanguage(report("This says sell the instrument."))).toThrow(
      "trade-action language",
    );
    expect(() =>
      assertSafeReportLanguage(report("This says go long and set a stop loss.")),
    ).toThrow("trade-action language");
    expect(() =>
      assertSafeReportLanguage(report("This says reduce exposure after the catalyst.")),
    ).toThrow("trade-action language");
    expect(() =>
      assertSafeReportLanguage(report("Investors should open a position in SPY.")),
    ).toThrow("trade-action language");
  });

  test("safety scanner allows neutral business uses of trade-action verbs", () => {
    expect(() =>
      assertSafeReportLanguage(
        report("Apple sells devices and holds cash while customers buy services."),
      ),
    ).not.toThrow();
  });
});
