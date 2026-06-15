import { MIN_CALIBRATION_SAMPLE, UNKNOWN_REGIME_BUCKET } from "./calibration";
import type { CalibrationMetric, CalibrationSummary } from "./types";

function formatBrier(value: number): string {
  return value.toFixed(4);
}

function formatSkill(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(4)}`;
}

function formatRate(value: number): string {
  return (value * 100).toFixed(1);
}

interface MetricTable {
  readonly title: string;
  readonly label: string;
  readonly metricsByKey: Record<string, CalibrationMetric>;
  readonly emptyText?: string;
}

function renderMetricTable(lines: string[], table: MetricTable): void {
  const { title, label, metricsByKey, emptyText } = table;
  lines.push(`## ${title}`, "");
  if (Object.keys(metricsByKey).length === 0 && emptyText !== undefined) {
    lines.push(emptyText, "");
    return;
  }
  lines.push(`| ${label} | Brier | Count |`);
  lines.push("|---|---|---|");
  for (const [key, metrics] of Object.entries(metricsByKey)) {
    lines.push(`| ${key} | ${formatBrier(metrics.brierScore)} | ${String(metrics.count)} |`);
  }
  lines.push("");
}

function renderMarketRegimeSection(lines: string[], summary: CalibrationSummary): void {
  renderMetricTable(lines, {
    title: "By market regime",
    label: "Regime",
    metricsByKey: summary.byMarketRegime,
    emptyText: `_No market regime meets the ${String(MIN_CALIBRATION_SAMPLE)}-sample floor yet._`,
  });

  // Disclose buckets excluded from the slice: sub-floor regimes and the "unknown"
  // (absent/unparseable regime) bucket, so coverage stays honest where a Brier is withheld.
  const excluded = Object.entries(summary.marketRegimeCoverage).filter(
    ([key]) => summary.byMarketRegime[key] === undefined,
  );
  if (excluded.length === 0) {
    return;
  }
  const parts = excluded.map(([key, count]) => {
    const note = key === UNKNOWN_REGIME_BUCKET ? "no regime label" : "below sample floor";
    return `${key} (${String(count)}, ${note})`;
  });
  lines.push(`Excluded from the regime slice: ${parts.join("; ")}.`, "");
}

function renderAutopsyCauseTable(lines: string[], summary: CalibrationSummary): void {
  lines.push("## Forecast error taxonomy", "");
  const entries = Object.entries(summary.byMissAutopsyCause).toSorted(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  if (entries.length === 0) {
    lines.push("_No material forecast-error autopsies yet._", "");
    return;
  }
  lines.push(`Material forecast-error autopsies: ${String(summary.missAutopsyCount)}`, "");
  lines.push("| Cause | Count |");
  lines.push("|---|---|");
  for (const [cause, count] of entries) {
    lines.push(`| ${cause} | ${String(count)} |`);
  }
  lines.push("");
}

export function renderCalibrationMarkdown(summary: CalibrationSummary): string {
  const lines: string[] = [
    "# Calibration Summary",
    "",
    `Generated at: ${summary.generatedAt}`,
    "",
    `Resolved predictions: ${String(summary.resolvedCount)}`,
    "",
  ];

  if (summary.resolvedCount < MIN_CALIBRATION_SAMPLE) {
    lines.push(
      `> Small sample (${String(summary.resolvedCount)} of ${String(MIN_CALIBRATION_SAMPLE)} minimum): calibration metrics are not yet reliable.`,
      "",
    );
  }

  lines.push(
    `Overall Brier score: ${formatBrier(summary.brierScore)}`,
    "",
    `Brier skill vs always-0.5 baseline: ${formatSkill(summary.brierSkillScore)} (0 = no edge, 1 = perfect, <0 = worse than a coin flip)`,
    "",
    "## Reliability bins",
    "",
  );

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

  renderAutopsyCauseTable(lines, summary);

  renderMetricTable(lines, { title: "By kind", label: "Kind", metricsByKey: summary.byKind });
  renderMetricTable(lines, {
    title: "By asset class",
    label: "Asset class",
    metricsByKey: summary.byAssetClass,
  });
  renderMetricTable(lines, {
    title: "By job type",
    label: "Job type",
    metricsByKey: summary.byJobType,
  });
  renderMetricTable(lines, {
    title: "By market update cadence",
    label: "Cadence",
    metricsByKey: summary.byMarketUpdateCadence,
    emptyText: "_No resolved market-update predictions yet._",
  });
  renderMetricTable(lines, {
    title: "By horizon bucket",
    label: "Horizon",
    metricsByKey: summary.byHorizonBucket,
  });
  renderMarketRegimeSection(lines, summary);

  return lines.join("\n");
}
