import type { ResearchReport } from "../domain/report";
import { formatLensValue } from "../sources/extended-evidence/value-format";
import { citedSourceIds, markdownText, sourceRefs } from "./markdown-primitives";
import { readMetricSectionsExtra } from "./report-extras-contract";

type MetricRow = NonNullable<ReturnType<typeof readMetricSectionsExtra>>[number]["metrics"][number];

function formattedValue({ value, unit, currency }: MetricRow): string | undefined {
  if (typeof value === "string") {
    return value === "" ? undefined : value;
  }
  return value === undefined || !Number.isFinite(value) || unit === undefined
    ? undefined
    : formatLensValue(value, unit, currency);
}

function metricLine(report: ResearchReport, metric: MetricRow): readonly string[] {
  if (metric.label === undefined) {
    return [];
  }
  const label = markdownText(metric.label);
  const value = metric.status === "value" ? formattedValue(metric) : undefined;
  if (value === undefined) {
    return [`- ${label}: not available, ${markdownText(metric.reason ?? "no value")}`];
  }
  const detail = [
    ...(metric.periodEnd === undefined ? [] : [`FY ending ${metric.periodEnd}`]),
    ...(metric.basis === undefined ? [] : [metric.basis]),
  ].join("; ");
  const refs = sourceRefs(citedSourceIds(report, metric));
  return [
    `- ${label}: ${markdownText(value)}${detail === "" ? "" : ` (${markdownText(detail)})`}${refs === "" ? "" : ` ${refs}`}`,
  ];
}

export function renderMetricSections(report: ResearchReport): string {
  const sections = readMetricSectionsExtra(report.extras?.metricSections) ?? [];
  return sections
    .flatMap((section) =>
      section.title === undefined
        ? []
        : [
            `## ${markdownText(section.title)}`,
            "",
            ...section.metrics.flatMap((metric) => metricLine(report, metric)),
            "",
          ],
    )
    .join("\n");
}
