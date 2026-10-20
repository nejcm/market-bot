import { MIN_CALIBRATION_SAMPLE } from "./calibration";
import { NO_RESOLVED_METRIC_TEXT } from "./calibration-invariant";
import {
  pairedSkillDecisionText,
  pairedSkillPolicyNote,
  pairedSkillStatusText,
} from "./calibration-read";
import type {
  CalibrationMetric,
  CalibrationSummary,
  PairedSkillMetric,
  PairedSkillPolicy,
} from "./types";

export { MIN_CALIBRATION_SAMPLE } from "./calibration";

function pairedSkillLine(
  label: string,
  metric: PairedSkillMetric,
  policy: PairedSkillPolicy,
): string {
  const interval =
    metric.ciLow === undefined || metric.ciHigh === undefined
      ? "no interval"
      : `[${fmtBrier(metric.ciLow)}, ${fmtBrier(metric.ciHigh)}]`;
  return `    ${label}: ${fmtBrier(metric.deltaBrier)} ${interval}, n=${String(metric.count)}, ${String(metric.blockCount)} blocks, ${pairedSkillStatusText(metric, policy)}; at next review: ${pairedSkillDecisionText(metric.decisionRule)}`;
}

function fmtBrier(v: number): string {
  return v.toFixed(4);
}

function fmtRate(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function metricRows(
  entries: readonly [string, CalibrationMetric][],
  labelWidth: number,
): readonly string[] {
  return entries.map(
    ([key, m]) =>
      `  ${key.padEnd(labelWidth)}  Brier ${fmtBrier(m.brierScore)}   n=${String(m.count)}${m.count < MIN_CALIBRATION_SAMPLE ? " [thin/unreliable]" : ""}`,
  );
}

export function renderCalibrationConsole(summary: CalibrationSummary): string {
  const lines: string[] = [
    `Calibration dashboard — ${summary.generatedAt}`,
    "",
    `  Resolved:    ${String(summary.resolvedCount)} forecast events`,
    `               ${String(summary.duplicateForecastCount)} duplicate issuances collapsed`,
    `  Hit rate:    ${summary.hitRate === undefined ? NO_RESOLVED_METRIC_TEXT : fmtRate(summary.hitRate)}`,
    `  Brier score: ${summary.brierScore === undefined ? NO_RESOLVED_METRIC_TEXT : fmtBrier(summary.brierScore)}`,
    `  Conditional: ${String(summary.conditionalPredictions.activatedCount)} activated; ${String(summary.conditionalPredictions.voidedCount)} voided/excluded`,
  ];

  const paired = summary.pairedSkill;
  if (paired === undefined) {
    lines.push("  Paired skill: not recorded in this summary");
  } else if (paired.overall === undefined) {
    lines.push("  Paired skill: no resolved Forecast Event carries a Forecast Baseline yet");
  } else {
    lines.push(
      `  Paired skill vs Forecast Baseline (ΔBrier, ${String(Math.round(paired.policy.confidenceLevel * 100))}% interval):`,
    );
    lines.push(pairedSkillLine("all", paired.overall, paired.policy));
    for (const [kind, metric] of Object.entries(paired.byKind)) {
      lines.push(pairedSkillLine(kind, metric, paired.policy));
    }
    lines.push(`    ${pairedSkillPolicyNote(paired.policy)}`);
  }
  if (paired !== undefined) {
    lines.push(`    ${String(paired.excludedWithoutBaselineCount)} excluded without a baseline`);
    if (paired.nextReviewDate !== undefined) {
      lines.push(`    Next pre-registered review: ${paired.nextReviewDate}`);
    }
  }

  if (summary.resolvedCount < MIN_CALIBRATION_SAMPLE) {
    lines.push(
      "",
      `  Small sample (${String(summary.resolvedCount)} of ${String(MIN_CALIBRATION_SAMPLE)} minimum) — metrics not yet reliable.`,
    );
    return lines.join("\n");
  }

  if (summary.bins.length > 0) {
    lines.push("", "Reliability (stated probability vs observed hit rate)", "");
    for (const bin of summary.bins) {
      const hitPct = `${(bin.hitRate * 100).toFixed(0)}%`.padStart(4);
      lines.push(
        `  ${bin.label.padEnd(9)}  n=${String(bin.totalCount).padStart(4)}  hit ${hitPct}`,
      );
    }
  }

  const kindEntries = Object.entries(summary.byKind);
  if (kindEntries.length > 0) {
    lines.push("", "By kind", "");
    lines.push(...metricRows(kindEntries, 14));
  }

  const horizonEntries = Object.entries(summary.byHorizonBucket);
  if (horizonEntries.length > 0) {
    lines.push("", "By horizon", "");
    lines.push(...metricRows(horizonEntries, 10));
  }

  const regimeEntries = Object.entries(summary.byMarketRegime);
  if (regimeEntries.length > 0) {
    lines.push("", "By market regime", "");
    lines.push(...metricRows(regimeEntries, 18));
  }

  return lines.join("\n");
}
