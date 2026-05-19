import type { CalibrationMetric, CalibrationSummary } from "./types";

function formatBrier(value: number): string {
  return value.toFixed(4);
}

function formatRate(value: number): string {
  return (value * 100).toFixed(1);
}

function renderMetricTable(
  lines: string[],
  title: string,
  label: string,
  metricsByKey: Record<string, CalibrationMetric>,
): void {
  lines.push(`## ${title}`, "");
  lines.push(`| ${label} | Brier | Count |`);
  lines.push("|---|---|---|");
  for (const [key, metrics] of Object.entries(metricsByKey)) {
    lines.push(`| ${key} | ${formatBrier(metrics.brierScore)} | ${String(metrics.count)} |`);
  }
  lines.push("");
}

export function renderCalibrationMarkdown(summary: CalibrationSummary): string {
  const lines: string[] = [];
  lines.push("# Calibration Summary", "");
  lines.push(`Generated at: ${summary.generatedAt}`, "");
  lines.push(`Resolved predictions: ${String(summary.resolvedCount)}`, "");
  lines.push(`Overall Brier score: ${formatBrier(summary.brierScore)}`, "");

  lines.push("## Reliability bins", "");
  if (summary.bins.length === 0) {
    lines.push("_No populated bins yet._", "");
  } else {
    lines.push("| Probability range | Hits | Total | Hit rate |");
    lines.push("|---|---|---|---|");
    for (const bin of summary.bins) {
      lines.push(
        `| ${bin.label} | ${String(bin.hitCount)} | ${String(bin.totalCount)} | ${formatRate(bin.hitRate)}% |`,
      );
    }
    lines.push("");
  }

  renderMetricTable(lines, "By kind", "Kind", summary.byKind);
  renderMetricTable(lines, "By asset class", "Asset class", summary.byAssetClass);
  renderMetricTable(lines, "By job type", "Job type", summary.byJobType);
  renderMetricTable(lines, "By market update cadence", "Cadence", summary.byMarketUpdateCadence);
  renderMetricTable(lines, "By horizon bucket", "Horizon", summary.byHorizonBucket);

  return lines.join("\n");
}
