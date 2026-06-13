import { brierSkillScore, MIN_CALIBRATION_SAMPLE } from "./calibration";
import type { CalibrationMetric, CalibrationSummary } from "./types";

export { MIN_CALIBRATION_SAMPLE } from "./calibration";

function fmtBrier(v: number): string {
  return v.toFixed(4);
}

function fmtSkill(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
}

function metricRows(
  entries: readonly [string, CalibrationMetric][],
  labelWidth: number,
): readonly string[] {
  return entries.map(
    ([key, m]) =>
      `  ${key.padEnd(labelWidth)}  ${fmtSkill(brierSkillScore(m.brierScore)).padStart(6)}   n=${String(m.count)}`,
  );
}

export function renderCalibrationConsole(summary: CalibrationSummary): string {
  const lines: string[] = [
    `Calibration dashboard — ${summary.generatedAt}`,
    "",
    `  Resolved:    ${String(summary.resolvedCount)} predictions`,
    `  Brier score: ${fmtBrier(summary.brierScore)}`,
    `  Brier skill: ${fmtSkill(summary.brierSkillScore)}  (0=no edge, +1=perfect, <0=worse than coin flip)`,
  ];

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

  return lines.join("\n");
}
