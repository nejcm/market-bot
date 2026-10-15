import type { ResearchReport } from "../domain/report";
import { formatMetricValue, metricPeriodLabel } from "../sources/extended-evidence/value-format";
import { citedSourceIds, markdownText, sourceRefs } from "./markdown-primitives";
import { readMetricSectionsExtra } from "./report-extras-contract";

type MetricRow = NonNullable<ReturnType<typeof readMetricSectionsExtra>>[number]["metrics"][number];

function metricLine(report: ResearchReport, metric: MetricRow): readonly string[] {
  if (metric.label === undefined) {
    return [];
  }
  const label = markdownText(metric.label);
  const value =
    metric.status === "value"
      ? formatMetricValue(metric.value, metric.unit, metric.currency)
      : undefined;
  if (value === undefined) {
    return [`- ${label}: not available, ${markdownText(metric.reason ?? "no value")}`];
  }
  const detail = [
    ...(metric.periodEnd === undefined
      ? []
      : [metricPeriodLabel(metric.periodEnd, metric.periodMonths)]),
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
      section.title === undefined || section.id?.startsWith("valuation-workbench-")
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
