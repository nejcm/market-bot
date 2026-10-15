import { readMetricSectionsExtra } from "../../src/report/report-extras-contract";
import {
  formatMetricValue,
  metricPeriodLabel,
} from "../../src/sources/extended-evidence/value-format";
import { readRecord } from "./view-model-format";

interface MetricTileView {
  readonly label: string;
  readonly status: string;
  readonly value?: string;
  readonly period?: string;
  readonly basis?: string;
  readonly reason?: string;
  readonly sourceIds: readonly string[];
}

export interface MetricSectionView {
  readonly id?: string;
  readonly title: string;
  readonly metrics: readonly MetricTileView[];
}

// Undefined when the report carries no Metric Sections; `[]` is kept apart for a bare header.
export function metricSectionsView(
  report: Record<string, unknown> | undefined,
): readonly MetricSectionView[] | undefined {
  const sections = readMetricSectionsExtra(readRecord(report?.extras)?.metricSections);
  return sections?.flatMap(({ id, title, metrics }): readonly MetricSectionView[] =>
    title === undefined || title.trim() === ""
      ? []
      : [
          {
            ...(id !== undefined ? { id } : {}),
            title,
            metrics: metrics.flatMap((metric): readonly MetricTileView[] => {
              if (metric.label === undefined || metric.label.trim() === "") {
                return [];
              }
              const status = metric.status ?? "missing";
              const value =
                status === "value"
                  ? formatMetricValue(metric.value, metric.unit, metric.currency)
                  : undefined;
              const { periodEnd, periodMonths, basis, reason } = metric;
              return [
                {
                  label: metric.label,
                  status,
                  ...(value !== undefined ? { value } : {}),
                  ...(periodEnd !== undefined
                    ? { period: metricPeriodLabel(periodEnd, periodMonths) }
                    : {}),
                  ...(basis !== undefined ? { basis } : {}),
                  ...(value === undefined ? { reason: reason ?? "no value" } : {}),
                  sourceIds: metric.sourceIds,
                },
              ];
            }),
          },
        ],
  );
}
