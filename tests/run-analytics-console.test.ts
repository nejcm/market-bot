import { describe, expect, test } from "bun:test";
import { renderRunAnalyticsConsole } from "../src/research/run-analytics-console";
import type { RunAnalytics } from "../src/research/run-analytics";

function baseAnalytics(): RunAnalytics {
  return {
    version: 1,
    runId: "run-1",
    generatedAt: "2026-05-19T00:00:00.000Z",
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    depth: "deep",
    sourceFunnel: {
      rawSnapshots: { total: 0, byAdapter: {} },
      reportSources: { total: 0, byKind: {}, byProvider: {} },
      sourceGaps: { total: 0, bySource: {} },
      sourceGapClasses: { missingCredential: 0, fetchFailed: 0, unsupportedCoverage: 0, other: 0 },
      dataGaps: { total: 0 },
    },
    newsDedupe: {
      fetchedNewsSourcesByProvider: {},
      fetchedNewsSourceCount: 0,
      canonicalDedupedNewsSourceCount: 0,
      canonicalDuplicateNewsSourceCount: 0,
      persistentSuppressedNewsSourceCount: 0,
      relevantBeforeSeenFilterCount: 0,
      relevantSuppressedBySeenFilterCount: 0,
      relevantSelectedCount: 0,
      repeatFallbackKeptCount: 0,
      selectedNewsSourceCount: 0,
      repeatFallbackUsed: false,
    },
    evidenceQuality: {
      confidence: "medium",
      dataGapCount: 1,
      extendedEvidence: { itemCount: 0, gapCount: 0, itemsByCategory: {}, gapsBySource: {} },
      marketContext: { itemCount: 0, gapCount: 0, itemsByCategory: {}, gapsBySource: {} },
    },
    predictions: {
      count: 5,
      retryErrorCount: 0,
      validationErrorCount: 0,
      trimWarningCount: 0,
      byKind: { direction: 3, relative: 2 },
      horizonTradingDays: { min: 5, max: 10, average: 7 },
      citedCount: 5,
      uncitedCount: 0,
      targetCount: 5,
      targetMet: true,
      nearBaseRateCount: 2,
      informativeCount: 3,
      signalTargetMet: true,
      mixWarnings: [],
    },
    runShape: {
      traceStages: [],
      stages: [],
      tokenEstimate: 0,
      costEstimateUsd: 0,
    },
  };
}

describe("run analytics console", () => {
  test("renders header, predictions, confidence for a clean run", () => {
    const output = renderRunAnalyticsConsole(baseAnalytics());

    expect(output).toBe(
      [
        "Run quality — equity AAPL (run-1)",
        "  Predictions: 5/5 target met · 3 informative, 2 near base rate",
        "  Confidence: medium · 1 data gap(s)",
      ].join("\n"),
    );
  });

  test("omits the symbol from the header when absent", () => {
    const { symbol: _symbol, ...rest } = baseAnalytics();
    const output = renderRunAnalyticsConsole({ ...rest, jobType: "market-overview" });

    expect(output.startsWith("Run quality — market-overview (run-1)")).toBe(true);
  });

  test("flags an undisclosed prediction shortfall and below-floor signal", () => {
    const analytics = baseAnalytics();
    const output = renderRunAnalyticsConsole({
      ...analytics,
      predictions: {
        ...analytics.predictions,
        count: 3,
        targetCount: 5,
        targetMet: false,
        shortfall: { emittedCount: 3, targetCount: 5, missingCount: 2, disclosed: false },
        informativeCount: 1,
        nearBaseRateCount: 2,
        signalTargetMet: false,
      },
    });

    expect(output).toContain("Predictions: 3/5 target (2 short, undisclosed)");
    expect(output).toContain("1 informative, 2 near base rate (below signal floor)");
  });

  test("renders evidence lanes with a required-gap note", () => {
    const analytics = baseAnalytics();
    const output = renderRunAnalyticsConsole({
      ...analytics,
      evidenceLanes: {
        coveredLaneCount: 6,
        gapLaneCount: 2,
        requiredGapLaneCount: 1,
        sourceCount: 12,
        gapCount: 2,
        coverageRatio: 0.75,
      },
    });

    expect(output).toContain("Evidence lanes: 6 covered, 2 gap(s) · 1 required gap(s)");
  });

  test("renders post-synthesis audit warnings with code breakdown", () => {
    const analytics = baseAnalytics();
    const output = renderRunAnalyticsConsole({
      ...analytics,
      postSynthesisAudit: { warningCount: 2, byCode: { "stale-citation": 1, "gap-label": 1 } },
    });

    expect(output).toContain("Audit: 2 warning(s) [stale-citation:1, gap-label:1]");
  });

  test("omits the audit line when there are no warnings", () => {
    const analytics = baseAnalytics();
    const output = renderRunAnalyticsConsole({
      ...analytics,
      postSynthesisAudit: { warningCount: 0, byCode: {} },
    });

    expect(output).not.toContain("Audit:");
  });

  test("lists each prediction-mix warning on its own line", () => {
    const analytics = baseAnalytics();
    const output = renderRunAnalyticsConsole({
      ...analytics,
      predictions: {
        ...analytics.predictions,
        mixWarnings: ["all emitted predictions are direction kind"],
      },
    });

    expect(output).toContain("  ! all emitted predictions are direction kind");
  });
});
