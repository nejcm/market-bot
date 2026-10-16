import type { ExtendedEvidence } from "../../domain/evidence";
import type { MetricSection } from "../../sources/extended-evidence/metric-engine";
import { formatMetricValue } from "../../sources/extended-evidence/value-format";

export function metricReferenceEvidence(
  sections: readonly MetricSection[],
): Record<string, unknown> {
  return {
    metricReferences: sections.map((section) => {
      const metrics = section.metrics.map(
        (metric): Record<string, unknown> => ({
          reference: `<<metric:${section.id}.${metric.id}>>`,
          label: metric.label,
          status: metric.status,
          unit: metric.unit,
          basis: metric.basis,
          ...(metric.currency !== undefined ? { currency: metric.currency } : {}),
          ...(metric.periodEnd !== undefined ? { periodEnd: metric.periodEnd } : {}),
          ...(metric.periodMonths !== undefined ? { periodMonths: metric.periodMonths } : {}),
          sourceIds: metric.sourceIds,
          ...(metric.status === "value"
            ? { value: formatMetricValue(metric.value, metric.unit, metric.currency) }
            : {}),
        }),
      );
      const defaults = Object.fromEntries(
        Object.entries(metrics[0] ?? {}).filter(
          ([key, value]) =>
            key !== "reference" &&
            key !== "label" &&
            key !== "status" &&
            key !== "value" &&
            metrics.length > 1 &&
            metrics.every((metric) => JSON.stringify(metric[key]) === JSON.stringify(value)),
        ),
      );
      return {
        id: section.id,
        title: section.title,
        ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
        metrics: metrics.map((metric) =>
          Object.fromEntries(Object.entries(metric).filter(([key]) => !(key in defaults))),
        ),
      };
    }),
    metricReferenceInstruction:
      "Each metric inherits its section defaults; missing-metric reasons are declared in sourceGaps. For narrative claims about catalog metrics, copy the exact <<metric:<section>.<id>>> reference instead of restating or calculating its number. Use only status=value references; retain the label, basis and period in prose and cite sourceIds. Assembly formats values and adds their citations. Unknown, unavailable, malformed or unciteable references reject the report for repair. References belong only in cited findings, cases, risks, catalysts, scenarios, Business Framework text, Earnings Setup bullets or Spotlight rationales, never summary, dataGaps or prediction DSL.",
  };
}

export function withoutRestatedMetricValues(
  evidence: ExtendedEvidence,
  sections: readonly MetricSection[],
): ExtendedEvidence {
  if (sections.length === 0) {
    return evidence;
  }
  return {
    ...evidence,
    items: evidence.items.map((item) => {
      if (item.category !== "business-framework" && item.category !== "financial-lens") {
        return item;
      }
      const sectionMetrics = sections
        .filter(({ id }) => id.startsWith(`${item.category}-`))
        .flatMap(({ metrics }) => metrics);
      if (sectionMetrics.length === 0) {
        return item;
      }
      const keys = new Set(
        sectionMetrics
          .filter(({ unit }) => unit !== "text")
          .flatMap(({ id }) => [id, `${id}PeriodEnd`]),
      );
      return {
        ...item,
        summary: sectionMetrics.reduce((summary, metric) => {
          const value =
            metric.status === "value" && metric.unit !== "text"
              ? formatMetricValue(metric.value, metric.unit, metric.currency)
              : undefined;
          return value === undefined
            ? summary
            : summary.replaceAll(`${metric.label} ${value}`, metric.label);
        }, item.summary),
        metrics: Object.fromEntries(
          Object.entries(item.metrics ?? {}).filter(([key]) => !keys.has(key)),
        ),
      };
    }),
  };
}
