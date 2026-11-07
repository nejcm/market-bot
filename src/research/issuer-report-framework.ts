import {
  businessFrameworkItemMetrics,
  businessFrameworkSummary,
  sectionSummary,
} from "../sources/extended-evidence/business-framework";
import { businessFrameworkMetrics } from "../sources/extended-evidence/business-framework-metrics";
import type { MetricSection } from "../sources/extended-evidence/metric-engine";
import type { CollectedSources } from "../sources/types";

const FRAMEWORK_INPUT = /^issuer-report-(?:revenue|profit-attributable-to-owners)-/u;

function issuerSourceIds(section: MetricSection | undefined): readonly string[] {
  return (section?.metrics ?? []).flatMap(({ inputs }) =>
    inputs.filter(({ artifact }) => artifact === "issuerReport").flatMap((row) => row.sourceIds),
  );
}

// Built at collection, before Web Gather; re-derived once issuer revenue or profit rows exist.
export function withIssuerReportFramework(
  collectedSources: CollectedSources,
  symbol: string,
  issuerReport: MetricSection,
): CollectedSources {
  const framework = collectedSources.businessFramework;
  if (framework === undefined || !issuerReport.metrics.some(({ id }) => FRAMEWORK_INPUT.test(id))) {
    return collectedSources;
  }
  const evidence = collectedSources.extendedEvidence;
  const snapshot = collectedSources.marketSnapshots.find(
    (row) => row.assetClass === "equity" && row.symbol.toUpperCase() === symbol.toUpperCase(),
  );
  const metrics = businessFrameworkMetrics(
    {
      symbol,
      ...(collectedSources.financialStatements === undefined
        ? {}
        : { statements: collectedSources.financialStatements }),
      ...(evidence === undefined ? {} : { evidence }),
      ...(snapshot === undefined ? {} : { snapshot }),
      asOf: framework.generatedAt,
      issuerReport,
    },
    (collectedSources.metricSections ?? [])
      .filter(({ id }) => id.startsWith("financial-lens-"))
      .flatMap((section) => section.metrics),
  );
  const sections = framework.sections.map((section) => {
    const metricSection = metrics.sections[section.name];
    const posture = metrics.postures[section.name];
    return {
      ...section,
      posture,
      summary: sectionSummary(section.name, posture, metricSection),
      sourceIds: [...new Set([...section.sourceIds, ...issuerSourceIds(metricSection)])],
    };
  });
  const sourceIds = [
    ...new Set([...framework.sourceIds, ...sections.flatMap((row) => row.sourceIds)]),
  ];
  const { phase: _stale, ...unphased } = framework;
  const { phase } = metrics;
  const refreshed = Object.values(metrics.sections);
  return {
    ...collectedSources,
    businessFramework: {
      ...unphased,
      ...(phase === undefined ? {} : { phase }),
      sections,
      sourceIds,
    },
    ...(evidence === undefined
      ? {}
      : {
          extendedEvidence: {
            ...evidence,
            items: evidence.items.map((item) =>
              item.category === "business-framework"
                ? {
                    ...item,
                    summary: businessFrameworkSummary(sections),
                    sourceIds: [...new Set([...item.sourceIds, ...sourceIds])],
                    metrics: businessFrameworkItemMetrics(phase, sections),
                  }
                : item,
            ),
          },
        }),
    ...(collectedSources.metricSections === undefined
      ? {}
      : {
          metricSections: collectedSources.metricSections.map(
            (section) => refreshed.find(({ id }) => id === section.id) ?? section,
          ),
        }),
    // In place, so each section gap keeps its position.
    sourceGaps: [
      ...collectedSources.sourceGaps.flatMap((gap) =>
        refreshed.some(({ id }) => id === gap.source)
          ? metrics.sourceGaps.filter(({ source }) => source === gap.source)
          : [gap],
      ),
      ...metrics.sourceGaps.filter(
        ({ source }) => !collectedSources.sourceGaps.some((gap) => gap.source === source),
      ),
    ],
  };
}
