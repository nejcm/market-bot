import { describe, expect, test } from "bun:test";
import { renderRunAnalyticsConsole } from "../src/research/run-analytics-console";
import type { RunAnalytics } from "../src/research/run-analytics";

function baseAnalytics(): RunAnalytics {
  return {
    version: 2,
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
      replacementAttempted: false,
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
        "  Evidence Quality: medium · 1 data gap(s)",
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

  test("renders completion counters when present", () => {
    const analytics = baseAnalytics();
    const output = renderRunAnalyticsConsole({
      ...analytics,
      predictions: {
        ...analytics.predictions,
        completion: {
          attempted: true,
          initialCount: 2,
          acceptedCount: 2,
          rejectedCount: 1,
          outcome: "improved",
        },
      },
    });

    expect(output).toContain("Completion: improved · 2 accepted, 1 rejected");
  });

  test("renders evidence lanes with a limiting-gap note", () => {
    const analytics = baseAnalytics();
    const output = renderRunAnalyticsConsole({
      ...analytics,
      evidenceLanes: {
        coveredLaneCount: 6,
        gapLaneCount: 2,
        coreGapLaneCount: 1,
        materialGapLaneCount: 0,
        sourceCount: 12,
        gapCount: 2,
        coverageRatio: 0.75,
      },
    });

    expect(output).toContain("Evidence lanes: 6 covered, 2 gap(s) · 1 limiting gap(s)");
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

  test("renders source-gap classification breakdown", () => {
    const analytics = baseAnalytics();
    const output = renderRunAnalyticsConsole({
      ...analytics,
      sourceFunnel: {
        ...analytics.sourceFunnel,
        sourceGaps: { total: 5, bySource: {} },
        sourceGapClasses: {
          missingCredential: 2,
          fetchFailed: 1,
          unsupportedCoverage: 1,
          other: 1,
        },
      },
    });

    expect(output).toContain(
      "Source gaps: 5 total (2 credential, 1 unsupported, 1 fetch-failed, 1 other)",
    );
  });

  test("omits source-gap line when no gaps exist", () => {
    const output = renderRunAnalyticsConsole(baseAnalytics());

    expect(output).not.toContain("Source gaps:");
  });

  test("renders model-input sanitation only when content changed", () => {
    const analytics = baseAnalytics();
    expect(renderRunAnalyticsConsole(analytics)).not.toContain("Model input sanitation:");

    const output = renderRunAnalyticsConsole({
      ...analytics,
      modelInputSanitization: {
        entries: [
          {
            provider: "exa",
            ingress: "web-gather",
            profile: "open-web",
            fieldRole: "snippet",
            inputChars: 100,
            outputChars: 70,
            removedInstructionSpanCount: 1,
            removedMarkupChromeCount: 2,
            truncatedFieldCount: 1,
            truncatedCharCount: 10,
            emptyAfterSanitizeFieldCount: 0,
            droppedItemCount: 0,
          },
        ],
      },
    });

    expect(output).toContain(
      "Model input sanitation: 1 instruction, 2 markup/chrome, 1 truncated, 0 emptied, 0 dropped",
    );
  });

  test("renders web fallback summaries only when present", () => {
    const analytics = baseAnalytics();
    const servedOutput = renderRunAnalyticsConsole({
      ...analytics,
      webSources: {
        accepted: 0,
        profileUsed: 0,
        reportCited: 0,
        extrasCited: 0,
        unused: 0,
        usageRatio: 0,
        fallback: {
          attempted: ["exa", "firecrawl"],
          servedBy: "firecrawl",
          failedExaRequests: 1,
        },
      },
    });
    const unavailableOutput = renderRunAnalyticsConsole({
      ...analytics,
      webSources: {
        accepted: 0,
        profileUsed: 0,
        reportCited: 0,
        extrasCited: 0,
        unused: 0,
        usageRatio: 0,
        fallback: {
          attempted: ["exa"],
          unavailableReason: "no-firecrawl-key",
          failedExaRequests: 1,
        },
      },
    });

    expect(servedOutput).toContain(
      "Web fallback: attempted=exa,firecrawl · servedBy=firecrawl · failedExaRequests=1",
    );
    expect(unavailableOutput).toContain(
      "Web fallback: attempted=exa · unavailableReason=no-firecrawl-key · failedExaRequests=1",
    );
    expect(renderRunAnalyticsConsole(analytics)).not.toContain("Web fallback:");
  });
});
