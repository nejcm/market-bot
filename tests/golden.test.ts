import { describe, expect, test } from "bun:test";
import type { ResearchReport } from "../src/domain/types";
import { renderMarkdownReport } from "../src/report/markdown";
import { assertSafeReportLanguage, validateResearchReport } from "../src/report/schema";

function report(summary = "Evidence is sourced and caveated."): ResearchReport {
  return {
    runId: "golden",
    jobType: "daily",
    assetClass: "equity",
    generatedAt: "2026-05-19T00:00:00.000Z",
    summary,
    keyFindings: [{ text: "Liquidity is sufficient for research coverage.", sourceIds: ["source-1"] }],
    bullCase: [],
    bearCase: [],
    risks: [{ text: "Coverage is narrow.", sourceIds: ["source-1"] }],
    catalysts: [],
    scenarios: [{ name: "Base", description: "Conditions remain mixed.", sourceIds: ["source-1"] }],
    confidence: "low",
    dataGaps: ["No macro source"],
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
    expect(markdown.match(/Research-only note/g)?.length).toBe(1);
  });

  test("safety scanner blocks trade-action wording", () => {
    expect(() => assertSafeReportLanguage(report("This says sell the instrument."))).toThrow("trade-action language");
    expect(() => assertSafeReportLanguage(report("This says go long and set a stop loss."))).toThrow("trade-action language");
    expect(() => assertSafeReportLanguage(report("This says reduce exposure after the catalyst."))).toThrow("trade-action language");
  });
});
