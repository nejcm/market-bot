import { isInstrumentCommand, type ResearchCommand } from "../../cli/args";
import {
  itemByCategory,
  secFundamentalItem,
  tickerSnapshot,
  type FinancialLens,
  type FinancialLensResult,
  type FinancialLensArtifact,
  type FinancialLensMetric,
  type FinancialLensName,
} from "./financial-lens-metrics";
import {
  applySubsequentFinancingCurrentness,
  growthLens,
  momentumLens,
  qualityLens,
  strengthLens,
  valueLens,
} from "./financial-lens-builders";

import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  MarketSnapshot,
  SourceGap,
  VerifiedMarketSnapshot,
} from "../../domain/types";
import { sourceGap } from "../../domain/source-gaps";
import { formatLensValue } from "./value-format";
import type { SubsequentFinancingBridgeArtifact } from "./subsequent-financing";
import type { EquityReportingFreshness } from "./equity-analysis-completeness";

export type {
  FinancialLensArtifact,
  FinancialLensMetric,
  FinancialLensName,
  FinancialLensPosture,
} from "./financial-lens-metrics";

function summarizeLens(lens: FinancialLens): string {
  const metricText = lens.metrics
    .slice(0, 4)
    .map((item) => `${item.label} ${formatValue(item)}`)
    .join(", ");
  const currentness =
    lens.currentStatus === "partial"
      ? " [current status partial: unreconciled post-period financing]"
      : "";
  return `${lens.name} ${lens.posture}${metricText === "" ? "" : ` (${metricText})`}${currentness}`;
}

function formatValue(lensMetric: FinancialLensMetric): string {
  if (typeof lensMetric.value === "string") {
    return lensMetric.value;
  }
  return formatLensValue(lensMetric.value, lensMetric.unit, lensMetric.currency);
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

export function addFinancialLensEvidence(
  command: ResearchCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedEvidence: ExtendedEvidence | undefined,
  verifiedMarketSnapshot: VerifiedMarketSnapshot | undefined,
  generatedAt: string,
  subsequentFinancing?: SubsequentFinancingBridgeArtifact,
  freshness?: EquityReportingFreshness,
): FinancialLensResult {
  if (!isInstrumentCommand(command) || command.assetClass !== "equity") {
    return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
  }

  const secItem = secFundamentalItem(extendedEvidence);
  const valuationItem = itemByCategory(extendedEvidence, "valuation");
  const yahooFundamentalsItem = itemByCategory(extendedEvidence, "yahoo-fundamentals");
  const snapshot = tickerSnapshot(command, marketSnapshots);
  const quoteCurrency = snapshot?.identity?.quoteCurrency ?? "USD";
  const lenses = [
    qualityLens(secItem),
    growthLens(secItem),
    applySubsequentFinancingCurrentness(
      strengthLens(secItem, valuationItem, yahooFundamentalsItem),
      subsequentFinancing,
    ),
    valueLens(valuationItem, secItem, yahooFundamentalsItem, snapshot),
    momentumLens(verifiedMarketSnapshot, quoteCurrency),
  ];
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
        lenses.flatMap((lens) => [
          [postureMetricKey(lens.name), lens.posture] as const,
          ...lens.metrics.flatMap((metricValue) => [
            [metricValue.key, metricValue.value] as const,
            // Period ends travel beside their value, matching sec-edgar's `${key}PeriodEnd`
            // Convention, so the model can date every lens figure it reads.
            ...(metricValue.periodEnd === undefined
              ? []
              : [[`${metricValue.key}PeriodEnd`, metricValue.periodEnd] as const]),
          ]),
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
  return { extendedEvidence: mergedEvidence, artifact, sourceGaps: gaps };
}
