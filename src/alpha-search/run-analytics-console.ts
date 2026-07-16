import type { AlphaSearchRunAnalytics } from "./workflow";

// Compact stderr summary of the alpha-search run telemetry persisted to analytics.json.
// Mirrors research/run-analytics-console.ts: stdout stays reserved for the run-dir path,
// And the run is already persisted, so this summary must never abort a completed run.

export function renderAlphaSearchAnalyticsConsole(analytics: AlphaSearchRunAnalytics): string {
  const { alphaSearch, sourceFunnel } = analytics;
  return [
    `Run quality — ${analytics.jobType} (${analytics.runId})`,
    `  Candidates: ${String(alphaSearch.socialCandidateCount)} social, ${String(
      alphaSearch.secCandidateCount,
    )} SEC · ${String(alphaSearch.rejectedCandidateCount)} rejected`,
    `  Leads: ${String(alphaSearch.researchLeadCount)} evaluated (${String(
      alphaSearch.validLeadCount,
    )} Yahoo-valid)`,
    `  Evidence: ${String(sourceFunnel.reportSources.total)} source(s) · ${String(
      sourceFunnel.sourceGaps.total,
    )} source gap(s), ${String(alphaSearch.fundamentalGapCount)} fundamental gap(s), ${String(
      sourceFunnel.dataGaps.total,
    )} data gap(s)`,
  ].join("\n");
}
