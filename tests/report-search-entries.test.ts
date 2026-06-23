import { describe, expect, test } from "bun:test";
import { reportSearchCandidates, type ReportSearchCandidate } from "../src/report-search-entries";

const MEASURABLE_AS = "close(SPY, +5) > close(SPY, 0)";

const report: Record<string, unknown> = {
  runId: "run-1",
  summary: "summary text",
  keyFindings: [
    { text: "finding 1", sourceIds: ["s1"] },
    { text: "   ", sourceIds: [] },
  ],
  bullCase: [{ text: "bull", sourceIds: [] }],
  bearCase: [{ text: "bear", sourceIds: [] }],
  risks: [{ text: "risk", sourceIds: [] }],
  catalysts: [{ text: "catalyst", sourceIds: [] }],
  predictions: [
    {
      id: "p1",
      claim: "claim text",
      kind: "direction",
      subject: "SPY",
      measurableAs: MEASURABLE_AS,
      horizonTradingDays: 5,
      probability: 0.6,
      sourceIds: ["s2"],
    },
  ],
  sources: [
    {
      id: "s1",
      title: "title",
      publisher: "pub",
      provider: "prov",
      summary: "summ",
      snippet: "snip",
      url: "http://example.com",
      kind: "news",
      fetchedAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  dataGaps: ["gap 1"],
  extendedEvidence: {
    instrument: { symbol: "SPY", assetClass: "equity" },
    items: [
      {
        category: "valuation",
        title: "EV title",
        summary: "ev summary",
        sourceIds: ["ev1"],
        metrics: { evToAnnualizedRevenue: 12.3 },
        observedAt: "2026-06-01T00:00:00.000Z",
      },
    ],
    gaps: [],
  },
};

function sections(candidates: readonly ReportSearchCandidate[]): string[] {
  return candidates.map((candidate) => candidate.section);
}

function find(
  candidates: readonly ReportSearchCandidate[],
  section: string,
): ReportSearchCandidate {
  const candidate = candidates.find((entry) => entry.section === section);
  if (candidate === undefined) {
    throw new Error(`no candidate for section ${section}`);
  }
  return candidate;
}

describe("reportSearchCandidates", () => {
  test("console scope emits the agreed section order with console labels and text", () => {
    const candidates = reportSearchCandidates(report, "console");

    expect(sections(candidates)).toEqual([
      "summary",
      "keyFindings",
      "bullCase",
      "bearCase",
      "risks",
      "catalysts",
      "predictions",
      "sources",
      "dataGaps",
      "extendedEvidence",
    ]);

    expect(candidates.filter((candidate) => candidate.section === "keyFindings")).toHaveLength(1);

    expect(find(candidates, "summary").text).toBe("summary text");
    expect(find(candidates, "keyFindings").label).toBe("Key finding 1");
    expect(find(candidates, "keyFindings").sourceIds).toEqual(["s1"]);
    expect(find(candidates, "predictions").label).toBe("Observable forecast p1");
    expect(find(candidates, "predictions").sourceIds).toEqual(["s2"]);
    expect(find(candidates, "sources").label).toBe("Source s1");
    expect(find(candidates, "sources").sourceIds).toEqual(["s1"]);
    expect(find(candidates, "dataGaps").label).toBe("Data gap 1");
    expect(find(candidates, "extendedEvidence").label).toBe("EV title");
    expect(find(candidates, "extendedEvidence").sourceIds).toEqual(["ev1"]);

    expect(find(candidates, "predictions").text).toContain(MEASURABLE_AS);
    expect(find(candidates, "sources").text).toBe("title pub prov summ snip http://example.com");
    expect(find(candidates, "extendedEvidence").text).toContain("12.3");
  });

  test("history scope emits dataGaps before predictions and drops extendedEvidence", () => {
    const candidates = reportSearchCandidates(report, "history");

    expect(sections(candidates)).toEqual([
      "summary",
      "keyFindings",
      "bullCase",
      "bearCase",
      "risks",
      "catalysts",
      "dataGaps",
      "predictions",
      "sources",
    ]);

    expect(find(candidates, "keyFindings").label).toBe("keyFindings 1");
    expect(find(candidates, "predictions").label).toBe("p1");
    expect(find(candidates, "sources").label).toBe("s1");
    expect(find(candidates, "dataGaps").label).toBe("Data gap 1");

    expect(find(candidates, "predictions").text).not.toContain(MEASURABLE_AS);
    expect(find(candidates, "sources").text).toBe("title summ snip");
  });

  test("skips empty summary and empty-text sections", () => {
    const candidates = reportSearchCandidates(
      { summary: "   ", keyFindings: [{ text: "" }] },
      "console",
    );
    expect(candidates).toEqual([]);
  });
});
