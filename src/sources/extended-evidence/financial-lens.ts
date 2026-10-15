import { isInstrumentCommand, type ResearchCommand } from "../../cli/args";
import type { ExtendedEvidence, ExtendedEvidenceItem } from "../../domain/evidence";
import type { MarketSnapshot, VerifiedMarketSnapshot } from "../../domain/market-data";
import type { SourceGap } from "../../domain/sources";
import { sourceGap } from "../../domain/source-gaps";
import { verifiedSnapshotSourceId } from "../../research/verified-snapshot-contract";
import { financialLensMetrics } from "./financial-lens-sections";
import {
  itemByCategory,
  secFundamentalItem,
  tickerSnapshot,
  type FinancialLens,
  type FinancialLensArtifact,
  type FinancialLensMetric,
  type FinancialLensName,
  type FinancialLensResult,
} from "./financial-lens-metrics";
import type { FinancialStatementsArtifact } from "./financial-statements-contract";
import type { MetricContext, MetricResult, MetricSection } from "./metric-engine";
import { formatLensValue } from "./value-format";
import type { SubsequentFinancingBridgeArtifact } from "./subsequent-financing";
import type { EquityReportingFreshness } from "./equity-analysis-completeness";

export type {
  FinancialLensArtifact,
  FinancialLensMetric,
  FinancialLensName,
  FinancialLensPosture,
} from "./financial-lens-metrics";

export interface FinancialLensEvidenceResult extends FinancialLensResult {
  readonly metricSections?: readonly MetricSection[];
  readonly metricSectionGaps?: readonly SourceGap[];
}

const LENS_ORDER: readonly FinancialLensName[] = [
  "Quality",
  "Growth",
  "Financial Strength",
  "Value",
  "Momentum",
];

function summarizeMetricValue(lensMetric: FinancialLensMetric): string {
  return typeof lensMetric.value === "string"
    ? lensMetric.value
    : formatLensValue(lensMetric.value, lensMetric.unit, lensMetric.currency);
}

function summarizeLens(lens: FinancialLens): string {
  const metricText = lens.metrics
    .slice(0, 4)
    .map((item) => `${item.label} ${summarizeMetricValue(item)}`)
    .join(", ");
  const currentness =
    lens.currentStatus === "partial"
      ? " [current status partial: unreconciled post-period financing]"
      : "";
  return `${lens.name} ${lens.posture}${metricText === "" ? "" : ` (${metricText})`}${currentness}`;
}

function financialLensGap(symbol: string, missing: readonly string[]): SourceGap {
  return sourceGap({
    source: "financial-lens",
    message: `Financial Lens Evidence partial for ${symbol}: missing ${missing.join(", ")}`,
    provider: "market-bot",
    capability: "extended-evidence",
    cause: "provider-data-missing",
    evidenceQualityImpact: "no-cap",
  });
}

function postureMetricKey(name: FinancialLensName): string {
  if (name === "Financial Strength") {
    return "financialStrengthPosture";
  }
  return `${name.toLowerCase()}Posture`;
}

function metricRow(metric: MetricResult): FinancialLensMetric {
  return {
    key: metric.id,
    label: metric.label,
    value: metric.value as number | string,
    unit: metric.unit,
    sourceIds: metric.sourceIds,
    ...(metric.currency !== undefined ? { currency: metric.currency } : {}),
    ...(metric.periodEnd !== undefined ? { periodEnd: metric.periodEnd } : {}),
    ...(metric.periodMonths !== undefined ? { periodMonths: metric.periodMonths } : {}),
  };
}

function lensSourceIds(
  name: FinancialLensName,
  input: {
    readonly secSourceIds: readonly string[];
    readonly valuationSourceIds: readonly string[];
    readonly yahooSourceIds: readonly string[];
    readonly verifiedSourceIds: readonly string[];
  },
): readonly string[] {
  switch (name) {
    case "Quality":
    case "Growth": {
      return input.secSourceIds;
    }
    case "Financial Strength": {
      return [
        ...new Set([...input.secSourceIds, ...input.valuationSourceIds, ...input.yahooSourceIds]),
      ];
    }
    case "Value": {
      return [...new Set([...input.valuationSourceIds, ...input.yahooSourceIds])];
    }
    case "Momentum": {
      return input.verifiedSourceIds;
    }
  }
}

export function addFinancialLensEvidence(
  command: ResearchCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedEvidence: ExtendedEvidence | undefined,
  verifiedMarketSnapshot: VerifiedMarketSnapshot | undefined,
  generatedAt: string,
  subsequentFinancing?: SubsequentFinancingBridgeArtifact,
  freshness?: EquityReportingFreshness,
  statements?: FinancialStatementsArtifact,
): FinancialLensEvidenceResult {
  if (!isInstrumentCommand(command) || command.assetClass !== "equity") {
    return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
  }

  const secItem = secFundamentalItem(extendedEvidence);
  const valuationItem = itemByCategory(extendedEvidence, "valuation");
  const yahooItem = itemByCategory(extendedEvidence, "yahoo-fundamentals");
  const snapshot = tickerSnapshot(command, marketSnapshots);
  const ctx: MetricContext = {
    symbol: command.symbol,
    ...(statements !== undefined ? { statements } : {}),
    ...(extendedEvidence !== undefined ? { evidence: extendedEvidence } : {}),
    asOf: generatedAt,
    ...(snapshot !== undefined ? { snapshot } : {}),
    ...(verifiedMarketSnapshot !== undefined ? { verifiedSnapshot: verifiedMarketSnapshot } : {}),
    ...(subsequentFinancing !== undefined ? { subsequentFinancing } : {}),
  };
  const metrics = financialLensMetrics(ctx);
  const sourceIdsOf = {
    secSourceIds: secItem?.sourceIds ?? [],
    valuationSourceIds: valuationItem?.sourceIds ?? [],
    yahooSourceIds: yahooItem?.sourceIds ?? [],
    verifiedSourceIds:
      verifiedMarketSnapshot === undefined
        ? []
        : [verifiedSnapshotSourceId(verifiedMarketSnapshot.symbol)],
  };
  const partial =
    (subsequentFinancing?.events.filter((event) => !event.reconciled).length ?? 0) > 0;
  const lenses: readonly FinancialLens[] = LENS_ORDER.map((name): FinancialLens => {
    const lensMetrics = metrics.lensMetrics[name].flatMap((metric) =>
      metric.status === "value" ? [metricRow(metric)] : [],
    );
    const sourceIds = lensSourceIds(name, sourceIdsOf);
    return {
      name,
      posture: metrics.postures[name],
      metrics: lensMetrics,
      sourceIds,
      ...(name === "Financial Strength" && partial
        ? {
            currentStatus: "partial" as const,
            currentStatusReasonCodes: ["unreconciled-post-period-financing"],
          }
        : {}),
    };
  });
  const sourceIds = [
    ...new Set(lenses.flatMap((lens) => lens.sourceIds).filter((sourceId) => sourceId !== "")),
  ];
  const item: ExtendedEvidenceItem = {
    category: "financial-lens",
    title: `${command.symbol} Financial Lens Evidence`,
    summary: `Financial Lens Evidence: ${lenses.map((lens) => summarizeLens(lens)).join("; ")}.`,
    sourceIds,
    observedAt:
      [
        snapshot?.observedAt,
        secItem?.observedAt,
        valuationItem?.observedAt,
        verifiedMarketSnapshot?.fetchedAt,
      ]
        .filter((value): value is string => value !== undefined)
        .toSorted()
        .at(-1) ?? generatedAt,
    metrics: {
      ...Object.fromEntries(
        LENS_ORDER.flatMap((name) => [
          [postureMetricKey(name), metrics.postures[name]] as const,
          ...metrics.lensMetrics[name].flatMap((metric) =>
            metric.status === "value"
              ? [
                  [metric.id, metric.value] as const,
                  // Period ends travel beside their value, matching sec-edgar's `${key}PeriodEnd`
                  // Convention, so the model can date every lens figure it reads.
                  ...(metric.periodEnd === undefined
                    ? []
                    : [[`${metric.id}PeriodEnd`, metric.periodEnd] as const]),
                ]
              : [],
          ),
        ]),
      ),
      // Always-on reporting freshness: present whether or not a completeness gap fired.
      ...(freshness === undefined
        ? {}
        : {
            interimCadence: freshness.interimCadence,
            latestReportedPeriodEnd: freshness.latestReportedPeriodEnd,
            ...(freshness.latestDuePeriodEnd === undefined
              ? {}
              : { expectedDuePeriodEnd: freshness.latestDuePeriodEnd }),
          }),
    },
    ...(secItem?.identity !== undefined ? { identity: secItem.identity } : {}),
  };
  const artifact: FinancialLensArtifact = {
    version: 1,
    generatedAt,
    symbol: command.symbol.toUpperCase(),
    lenses,
    sourceIds,
  };
  const missing = [
    ...(secItem === undefined ? ["SEC fundamentals"] : []),
    ...(valuationItem === undefined ? ["valuation evidence"] : []),
    ...(verifiedMarketSnapshot === undefined ? ["verified market snapshot"] : []),
  ];
  const gaps = missing.length === 0 ? [] : [financialLensGap(command.symbol, missing)];
  const mergedEvidence: ExtendedEvidence = {
    instrument: extendedEvidence?.instrument ?? {
      symbol: command.symbol,
      assetClass: command.assetClass,
    },
    items: [...(extendedEvidence?.items ?? []), item],
    gaps: [...(extendedEvidence?.gaps ?? []), ...gaps],
  };
  return {
    extendedEvidence: mergedEvidence,
    artifact,
    sourceGaps: gaps,
    ...(metrics.sections.length === 0 ? {} : { metricSections: metrics.sections }),
    ...(metrics.sourceGaps.length === 0 ? {} : { metricSectionGaps: metrics.sourceGaps }),
  };
}
