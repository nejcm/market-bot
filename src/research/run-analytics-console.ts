import type { RunAnalytics } from "./run-analytics";

// Compact stderr summary of the run-quality telemetry persisted to analytics.json.
// Stdout stays reserved for the run-dir path so machine consumers are unaffected.
// Only actionable signals are rendered; non-essential lines are omitted when empty.

function subjectLabel(analytics: RunAnalytics): string {
  return analytics.symbol !== undefined ? ` ${analytics.symbol}` : "";
}

function predictionLine(predictions: RunAnalytics["predictions"]): string {
  const missing =
    predictions.shortfall?.missingCount ?? predictions.targetCount - predictions.count;
  const target = predictions.targetMet
    ? `${String(predictions.count)}/${String(predictions.targetCount)} target met`
    : `${String(predictions.count)}/${String(predictions.targetCount)} target (${String(
        missing,
      )} short${predictions.shortfall?.disclosed === false ? ", undisclosed" : ""})`;
  const signal = `${String(predictions.informativeCount)} informative, ${String(
    predictions.nearBaseRateCount,
  )} near base rate${predictions.signalTargetMet ? "" : " (below signal floor)"}`;
  return `  Predictions: ${target} · ${signal}`;
}

function evidenceLaneLine(lanes: NonNullable<RunAnalytics["evidenceLanes"]>): string {
  const gapNote =
    lanes.requiredGapLaneCount > 0
      ? ` · ${String(lanes.requiredGapLaneCount)} required gap(s)`
      : "";
  return `  Evidence lanes: ${String(lanes.coveredLaneCount)} covered, ${String(
    lanes.gapLaneCount,
  )} gap(s)${gapNote}`;
}

function auditLine(audit: NonNullable<RunAnalytics["postSynthesisAudit"]>): string {
  const codes = Object.entries(audit.byCode)
    .map(([code, count]) => `${code}:${String(count)}`)
    .join(", ");
  return `  Audit: ${String(audit.warningCount)} warning(s)${codes === "" ? "" : ` [${codes}]`}`;
}

export function renderRunAnalyticsConsole(analytics: RunAnalytics): string {
  const { evidenceLanes, evidenceQuality, postSynthesisAudit, predictions } = analytics;
  const lines: string[] = [
    `Run quality — ${analytics.jobType}${subjectLabel(analytics)} (${analytics.runId})`,
    predictionLine(predictions),
  ];

  if (evidenceLanes !== undefined) {
    lines.push(evidenceLaneLine(evidenceLanes));
  }

  lines.push(
    `  Confidence: ${evidenceQuality.confidence} · ${String(evidenceQuality.dataGapCount)} data gap(s)`,
  );

  if (postSynthesisAudit !== undefined && postSynthesisAudit.warningCount > 0) {
    lines.push(auditLine(postSynthesisAudit));
  }

  for (const warning of predictions.mixWarnings) {
    lines.push(`  ! ${warning}`);
  }

  return lines.join("\n");
}
