import { describe, expect, test } from "bun:test";
import { renderAlphaSearchAnalyticsConsole } from "../src/alpha-search/run-analytics-console";
import type { AlphaSearchRunAnalytics } from "../src/alpha-search/workflow";

function analytics(
  overrides: Partial<AlphaSearchRunAnalytics["alphaSearch"]> = {},
): AlphaSearchRunAnalytics {
  return {
    version: 2,
    runId: "alpha-run",
    generatedAt: "2026-05-19T00:00:00.000Z",
    jobType: "alpha-search",
    assetClass: "equity",
    depth: "deep",
    sourceFunnel: {
      reportSources: { total: 14, byKind: {}, byProvider: {} },
      sourceGaps: { total: 2, bySource: {} },
      dataGaps: { total: 1 },
    },
    alphaSearch: {
      socialCandidateCount: 8,
      secCandidateCount: 4,
      validLeadCount: 5,
      researchLeadCount: 3,
      rejectedCandidateCount: 9,
      fundamentalGapCount: 1,
      ...overrides,
    },
    runShape: { traceStages: [], tokenEstimate: 0, costEstimateUsd: 0 },
  };
}

describe("alpha-search run analytics console", () => {
  test("summarizes candidates, leads, and evidence", () => {
    const output = renderAlphaSearchAnalyticsConsole(analytics());

    expect(output).toBe(
      [
        "Run quality — alpha-search (alpha-run)",
        "  Candidates: 8 social, 4 SEC · 9 rejected",
        "  Leads: 3 surfaced of 5 valid",
        "  Evidence: 14 source(s) · 2 source gap(s), 1 fundamental gap(s), 1 data gap(s)",
      ].join("\n"),
    );
  });

  test("renders zeroed counts without throwing", () => {
    const output = renderAlphaSearchAnalyticsConsole(
      analytics({
        socialCandidateCount: 0,
        secCandidateCount: 0,
        validLeadCount: 0,
        researchLeadCount: 0,
        rejectedCandidateCount: 0,
        fundamentalGapCount: 0,
      }),
    );

    expect(output).toContain("  Candidates: 0 social, 0 SEC · 0 rejected");
    expect(output).toContain("  Leads: 0 surfaced of 0 valid");
  });
});
