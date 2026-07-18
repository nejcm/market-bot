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
  const limitingGapCount = lanes.coreGapLaneCount + lanes.materialGapLaneCount;
  const gapNote = limitingGapCount > 0 ? ` · ${String(limitingGapCount)} limiting gap(s)` : "";
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

function sourceGapClassLine(analytics: RunAnalytics): string | undefined {
  // Cosmetic digest must never abort: tolerate analytics that predates the
  // SourceGapClasses field or omits sourceFunnel entirely.
  const funnel = analytics.sourceFunnel as RunAnalytics["sourceFunnel"] | undefined;
  const classes = funnel?.sourceGapClasses;
  const total = funnel?.sourceGaps?.total ?? 0;
  if (classes === undefined || total === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (classes.missingCredential > 0) {
    parts.push(`${String(classes.missingCredential)} credential`);
  }
  if (classes.unsupportedCoverage > 0) {
    parts.push(`${String(classes.unsupportedCoverage)} unsupported`);
  }
  if (classes.fetchFailed > 0) {
    parts.push(`${String(classes.fetchFailed)} fetch-failed`);
  }
  if (classes.other > 0) {
    parts.push(`${String(classes.other)} other`);
  }
  return `  Source gaps: ${String(total)} total (${parts.join(", ")})`;
}

function modelInputSanitizationLine(analytics: RunAnalytics): string | undefined {
  const entries = analytics.modelInputSanitization?.entries ?? [];
  const totals = entries.reduce(
    (sum, entry) => ({
      instructions: sum.instructions + entry.removedInstructionSpanCount,
      markupChrome: sum.markupChrome + entry.removedMarkupChromeCount,
      truncated: sum.truncated + entry.truncatedFieldCount,
      emptied: sum.emptied + entry.emptyAfterSanitizeFieldCount,
      dropped: sum.dropped + entry.droppedItemCount,
    }),
    { instructions: 0, markupChrome: 0, truncated: 0, emptied: 0, dropped: 0 },
  );
  if (Object.values(totals).every((count) => count === 0)) {
    return undefined;
  }
  return `  Model input sanitation: ${String(totals.instructions)} instruction, ${String(
    totals.markupChrome,
  )} markup/chrome, ${String(totals.truncated)} truncated, ${String(
    totals.emptied,
  )} emptied, ${String(totals.dropped)} dropped`;
}

function webFallbackLine(analytics: RunAnalytics): string | undefined {
  const fallback = analytics.webSources?.fallback;
  if (fallback === undefined) {
    return undefined;
  }
  const fields = [`attempted=${fallback.attempted.join(",")}`];
  if (fallback.servedBy !== undefined) {
    fields.push(`servedBy=${fallback.servedBy}`);
  }
  if (fallback.unavailableReason !== undefined) {
    fields.push(`unavailableReason=${fallback.unavailableReason}`);
  }
  fields.push(`failedExaRequests=${String(fallback.failedExaRequests)}`);
  return `  Web fallback: ${fields.join(" · ")}`;
}

export function renderRunAnalyticsConsole(analytics: RunAnalytics): string {
  const { evidenceLanes, evidenceQuality, postSynthesisAudit, predictions } = analytics;
  const lines: string[] = [
    `Run quality — ${analytics.jobType}${subjectLabel(analytics)} (${analytics.runId})`,
    predictionLine(predictions),
  ];
  if (predictions.completion !== undefined) {
    lines.push(
      `  Completion: ${predictions.completion.outcome} · ${String(predictions.completion.acceptedCount)} accepted, ${String(predictions.completion.rejectedCount)} rejected`,
    );
  }

  if (evidenceLanes !== undefined) {
    lines.push(evidenceLaneLine(evidenceLanes));
  }

  lines.push(
    `  Evidence Quality: ${evidenceQuality.label ?? evidenceQuality.confidence ?? "low"} · ${String(evidenceQuality.dataGapCount)} data gap(s)`,
  );

  const gapLine = sourceGapClassLine(analytics);
  if (gapLine !== undefined) {
    lines.push(gapLine);
  }

  const sanitizationLine = modelInputSanitizationLine(analytics);
  if (sanitizationLine !== undefined) {
    lines.push(sanitizationLine);
  }

  const fallbackLine = webFallbackLine(analytics);
  if (fallbackLine !== undefined) {
    lines.push(fallbackLine);
  }

  if (postSynthesisAudit !== undefined && postSynthesisAudit.warningCount > 0) {
    lines.push(auditLine(postSynthesisAudit));
  }

  for (const warning of predictions.mixWarnings) {
    lines.push(`  ! ${warning}`);
  }

  return lines.join("\n");
}
