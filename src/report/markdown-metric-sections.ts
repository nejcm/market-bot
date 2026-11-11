import type { ResearchReport } from "../domain/report";
import type { FinancialStatementsArtifact } from "../sources/extended-evidence/financial-statements-contract";
import { operatingRatioNotes } from "./equity-reader-statements";
import { formatMetricValue, metricPeriodLabel } from "../sources/extended-evidence/value-format";
import { citedSourceIds, markdownText, sourceRefs } from "./markdown-primitives";
import { readMetricSectionsExtra } from "./report-extras-contract";

type MetricRow = NonNullable<ReturnType<typeof readMetricSectionsExtra>>[number]["metrics"][number];

function metricLine(
  report: ResearchReport,
  metric: MetricRow,
  sectionId?: string,
): readonly string[] {
  if (metric.label === undefined) {
    return [];
  }
  const label = markdownText(metric.label);
  const value =
    metric.status === "value"
      ? formatMetricValue(metric.value, metric.unit, metric.currency)
      : undefined;
  const detail = [
    ...(metric.periodEnd === undefined
      ? []
      : [
          metricPeriodLabel(
            metric.periodEnd,
            metric.periodMonths,
            sectionId,
            metric.inputs,
            metric.priceAsOf,
          ),
        ]),
    ...(metric.basis === undefined ? [] : [metric.basis]),
  ].join("; ");
  const refs = sourceRefs(citedSourceIds(report, metric));
  const provenance = `${detail === "" ? "" : ` (${markdownText(detail)})`}${refs === "" ? "" : ` ${refs}`}`;
  if (value === undefined) {
    const reason = markdownText(metric.reason ?? "no value");
    if (metric.status === "not-meaningful") {
      return [`- ${label}: not meaningful, ${reason}${provenance}`];
    }
    const status = metric.status === "not-applicable" ? "not applicable" : "not available";
    return [`- ${label}: ${status}, ${reason}`];
  }
  return [`- ${label}: ${markdownText(value)}${provenance}`];
}

export function renderMetricSections(
  report: ResearchReport,
  financialStatements?: FinancialStatementsArtifact,
): string {
  const sections = readMetricSectionsExtra(report.extras?.metricSections) ?? [];
  return sections
    .flatMap((section) =>
      section.title === undefined || section.id?.startsWith("valuation-workbench-")
        ? []
        : [
            `## ${markdownText(section.title)}`,
            "",
            ...section.metrics.flatMap((metric) => metricLine(report, metric, section.id)),
            ...(section.id === "operating-ratios"
              ? (operatingRatioNotes(financialStatements) ?? []).map(
                  (note) => `- ${markdownText(note.message)}`,
                )
              : []),
            "",
          ],
    )
    .join("\n");
}
