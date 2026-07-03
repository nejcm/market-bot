import { MIN_CALIBRATION_SAMPLE } from "./calibration";
import type { CalibrationMetric, CalibrationSummary } from "./types";

export { MIN_CALIBRATION_SAMPLE } from "./calibration";

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
    `  Resolved:    ${String(summary.resolvedCount)} predictions`,
    `  Hit rate:    ${fmtRate(summary.hitRate)}`,
    `  Brier score: ${fmtBrier(summary.brierScore)}`,
    `  Conditional: ${String(summary.conditionalPredictions.activatedCount)} activated; ${String(summary.conditionalPredictions.voidedCount)} voided/excluded`,
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

  const regimeEntries = Object.entries(summary.byMarketRegime);
  if (regimeEntries.length > 0) {
    lines.push("", "By market regime", "");
    lines.push(...metricRows(regimeEntries, 18));
  }

  return lines.join("\n");
}
