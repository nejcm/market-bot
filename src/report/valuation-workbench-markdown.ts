import type {
  HistoricalValuationObservation,
  ValuationWorkbenchArtifact,
} from "../sources/extended-evidence/valuation-workbench-contract";
import type {
  PeerImpliedRange,
  ValuationCompsArtifact,
  ValuationCompsRow,
} from "../sources/extended-evidence/valuation-comps";
import { CAPEX_SCOPE_CAVEAT } from "../sources/extended-evidence/financial-statement-definitions";
import {
  compsCashLabel,
  compsRowRevenueMultipleLabel,
} from "../sources/extended-evidence/valuation-comps-contract";
import { resolveRowPriceAsOf, type MarketSnapshotPriceAsOf } from "../domain/market-data";
import type { ResearchReport } from "../domain/report";
import { formatMetricValue } from "../sources/extended-evidence/value-format";
import type { MetricResult } from "../sources/extended-evidence/metric-engine";

import { knownSourceIds, sourceRefs } from "./markdown-primitives";
import { stringArrayValue } from "../guards";

export function valuationMetricDisplay(metric: MetricResult): string {
  if (metric.status === "value") {
    return formatMetricValue(metric.value, metric.unit, metric.currency) ?? "—";
  }
  if (metric.status === "not-meaningful") {
    return "N/M";
  }
  if (metric.status === "not-applicable") {
    return `not applicable (${metric.reason?.replace(/ \(SIC \d+\)/u, "") ?? "no reason"})`;
  }
  return `— (${metric.reason ?? "no value"})`;
}

function cell(value: string): string {
  return value.replaceAll("|", String.raw`\|`).replaceAll("\n", " ");
}

function fxNote(observation: HistoricalValuationObservation): string {
  if (observation.fxConversion === undefined) {
    return "";
  }
  const pair = observation.fxConversion.pair.replace(/^([A-Z]{3})([A-Z]{3})=X$/u, "$1/$2");
  return `; converted at ${pair} ${observation.fxConversion.rate.toFixed(4)} on ${observation.fxConversion.rateDate}`;
}

export function observationBasisLabel(observation: HistoricalValuationObservation): string {
  const basis = observation.basis.toUpperCase();
  return observation.periodMonths === undefined
    ? basis
    : `${basis} (${String(observation.periodMonths)} months)`;
}

// A null price can also mean a missing quote currency; trust the metric reason, not price alone.
export function hasNoPriceHistory(observation: HistoricalValuationObservation): boolean {
  return (
    observation.price === null &&
    Object.values(observation.metrics).some(
      (metric) => metric.status === "missing" && metric.reason === "price-history-unavailable",
    )
  );
}

// Cited like Metric Section rows: missing and not-applicable cells render a reason only.
export function observationSourceIds(observation: HistoricalValuationObservation): string[] {
  return [
    ...new Set(
      Object.values(observation.metrics)
        .filter(({ status }) => status === "value" || status === "not-meaningful")
        .flatMap(({ sourceIds }) => sourceIds),
    ),
  ];
}

function unpricedPeriodsLine(
  observations: readonly HistoricalValuationObservation[],
): string | undefined {
  const unpriced = observations.filter((observation) => hasNoPriceHistory(observation));
  if (unpriced.length === 0) {
    return undefined;
  }
  const periods = unpriced
    .map((observation) => `${observationBasisLabel(observation)} ${observation.periodEnd}`)
    .join(", ");
  return `- ${String(unpriced.length)} period${unpriced.length === 1 ? "" : "s"} without price history: ${periods}.`;
}

function historicalRow(
  observation: HistoricalValuationObservation,
  report: ResearchReport,
): string {
  const price =
    observation.price === null
      ? "—"
      : `${observation.price.close.toFixed(2)} ${observation.price.currency} (${observation.price.sessionDate}${fxNote(observation)})`;
  return `${[
    observationBasisLabel(observation),
    observation.periodEnd,
    observation.publicAt,
    price,
    valuationMetricDisplay(observation.metrics.priceToEarnings),
    valuationMetricDisplay(observation.metrics.priceToSales),
    valuationMetricDisplay(observation.metrics.enterpriseValueToRevenue),
    valuationMetricDisplay(observation.metrics.priceToFreeCashFlow),
  ]
    .map((value) => cell(value))
    .join(" | ")} | ${
    sourceRefs(knownSourceIds(report, observationSourceIds(observation))) || "—"
  }`;
}

function peerRole(row: ValuationCompsRow, targetSymbol: string): string {
  if (row.symbol === targetSymbol) {
    return "target";
  }
  return row.role ?? "peer";
}

function rowPriceAsOf(row: ValuationCompsRow): MarketSnapshotPriceAsOf | undefined {
  return resolveRowPriceAsOf(row.priceAsOf, row.quoteObservedAt);
}

function priceAsOfLabel(priceAsOf: MarketSnapshotPriceAsOf | undefined): string | undefined {
  if (priceAsOf === undefined) {
    return undefined;
  }
  return `${priceAsOf.kind === "quote-time" ? "quote time" : "fetch time"} ${priceAsOf.instant}`;
}

function peerRow(
  row: ValuationCompsRow,
  comps: ValuationCompsArtifact,
  report: ResearchReport,
): string {
  const multiple = compsRowRevenueMultipleLabel(row, comps.target.symbol, comps.generatedAt);
  const priceDate = priceAsOfLabel(rowPriceAsOf(row));
  const dates = [
    ...(priceDate === undefined ? [] : [priceDate]),
    ...(row.revenuePeriodEnd === undefined ? [] : [`revenue ${row.revenuePeriodEnd}`]),
    ...[compsCashLabel(row)].filter((label) => label !== undefined),
    ...(row.debtPeriodEnd === undefined ? [] : [`debt ${row.debtPeriodEnd}`]),
  ].join("; ");
  return [
    ...[
      row.symbol,
      peerRole(row, comps.target.symbol),
      row.usable ? "usable" : "excluded",
      multiple,
      row.quoteCurrency ?? "—",
      dates || "—",
    ].map((value) => cell(value)),
    sourceRefs(knownSourceIds(report, row.sourceIds)) || "—",
  ].join(" | ");
}

export function peerRowSourceIds(
  artifact: ValuationWorkbenchArtifact | undefined,
): readonly string[] {
  if (artifact?.peerComparison.status !== "available") {
    return [];
  }
  const { target, peers } = artifact.peerComparison.valuationComps;
  return [target, ...peers].flatMap((row) => stringArrayValue(row.sourceIds));
}

function peerSection(artifact: ValuationWorkbenchArtifact, report: ResearchReport): string {
  if (artifact.peerComparison.status === "suppressed") {
    return ["### Peer comparison", "", `- Suppressed: ${artifact.peerComparison.detail}`].join(
      "\n",
    );
  }
  const { valuationComps } = artifact.peerComparison;
  const rows = [valuationComps.target, ...valuationComps.peers].map((row) =>
    peerRow(row, valuationComps, report),
  );
  const rangeLine = peerReferenceRangeLine(
    valuationComps.impliedPriceRange,
    rowPriceAsOf(valuationComps.target),
  );
  const excluded =
    valuationComps.excludedPeers.length === 0
      ? "- Excluded peers: none."
      : `- Excluded peers: ${valuationComps.excludedPeers
          .map((peer) => `${peer.symbol} (${peer.reason})`)
          .join("; ")}.`;
  return [
    "### Peer comparison",
    "",
    `- Supportability: ${valuationComps.summary.valuationSupportability}.`,
    rangeLine,
    excluded,
    "",
    "Symbol | Role | Screen status | EV/revenue | Quote currency | Input dates | Sources",
    "--- | --- | --- | ---: | --- | --- | ---",
    ...rows,
  ].join("\n");
}

function peerReferenceRangeLine(
  referenceRange: PeerImpliedRange | undefined,
  priceAsOf: MarketSnapshotPriceAsOf | undefined,
): string {
  if (referenceRange === undefined) {
    return "- Reference range: suppressed (range output unavailable).";
  }
  if (referenceRange.status === "suppressed") {
    return `- Reference range: suppressed (${referenceRange.suppressedReason}).`;
  }
  const priceDate =
    priceAsOfLabel(priceAsOf) ??
    (referenceRange.inputs.quoteObservedAt === null
      ? "price time unavailable"
      : `fetch time ${referenceRange.inputs.quoteObservedAt}`);
  return `- Reference range: ${referenceRange.low.toFixed(2)}–${referenceRange.high.toFixed(2)} ${referenceRange.inputs.quoteCurrency}; midpoint ${referenceRange.mid.toFixed(2)}; observed position ${referenceRange.position}; ${priceDate}.`;
}

function inputScopeDisclosure(
  observations: readonly HistoricalValuationObservation[],
  key: "freeCashFlow" | "dilutedEps" | "debt",
  prefix: string,
): string | undefined {
  const scoped = observations.flatMap((observation) => {
    const scope = observation.inputs[key]?.scope;
    return scope === undefined
      ? []
      : [{ scope, period: `${observation.basis} ${observation.periodEnd}` }];
  });
  const [first] = scoped;
  return first === undefined
    ? undefined
    : `${prefix} (${first.scope}) for ${scoped.map(({ period }) => period).join(", ")}`;
}

function freeCashFlowScopeDisclosure(
  observations: readonly HistoricalValuationObservation[],
): string | undefined {
  const disclosure = inputScopeDisclosure(
    observations,
    "freeCashFlow",
    "P/FCF uses free cash flow proxy",
  );
  return disclosure === undefined ? undefined : `${disclosure}; ${CAPEX_SCOPE_CAVEAT}`;
}

function sharePeriodDisclosure(
  observations: readonly HistoricalValuationObservation[],
): string | undefined {
  const periods = observations.flatMap(({ basis, periodEnd, inputs }) =>
    basis === "ttm" && inputs.dilutedShares?.derivation?.startsWith("filed ") === true
      ? [`ttm ${periodEnd} (${inputs.dilutedShares.derivation})`]
      : [],
  );
  return periods.length === 0
    ? undefined
    : `TTM market cap uses the latest filed period's diluted weighted-average shares, a proxy for a trailing-year count when shorter than a fiscal year, for ${periods.join(", ")}`;
}

export function valuationScopeDisclosure(
  observations: readonly HistoricalValuationObservation[],
): string | undefined {
  const parts = [
    inputScopeDisclosure(observations, "dilutedEps", "P/E uses diluted EPS"),
    freeCashFlowScopeDisclosure(observations),
    inputScopeDisclosure(observations, "debt", "EV/revenue uses debt"),
    sharePeriodDisclosure(observations),
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join("; ");
}

export function renderValuationWorkbenchMarkdown(
  artifact: ValuationWorkbenchArtifact | undefined,
  report: ResearchReport,
): string {
  if (artifact === undefined) {
    return "";
  }
  const { observations } = artifact.historicalMultiples;
  const renderableObservations = observations.filter(
    (observation) => !hasNoPriceHistory(observation),
  );
  let historical: readonly string[] = [];
  if (observations.length === 0) {
    historical = [
      `- Suppressed: ${artifact.historicalMultiples.suppressionReasons.join("; ") || "no historical basis available"}.`,
    ];
  } else if (renderableObservations.length > 0) {
    historical = [
      "Basis | Statement period | First public date | First eligible close | P/E | P/S | EV/revenue | P/FCF proxy | Sources",
      "--- | --- | --- | --- | ---: | ---: | ---: | ---: | ---",
      ...renderableObservations.map((observation) => historicalRow(observation, report)),
    ];
  }
  const unpricedLine = unpricedPeriodsLine(observations);
  const scopeDisclosure = valuationScopeDisclosure(observations);
  const basis = artifact.historicalMultiples.trailingBasis;
  const trailing =
    basis.status === "available"
      ? [
          `- Trailing basis: ${basis.fiscalYearLabel ?? "reconciled TTM"} through ${basis.periodEnd}, public ${basis.publicAt}.`,
          "",
        ]
      : [];
  return [
    "",
    "## Valuation Workbench",
    "",
    `Annual rows are priced at the period's first annual report (the earliest 10-K, 20-F or 40-F filing a fiscal-year figure for it) and withhold any input first filed after it; TTM rows use the selected fundamentals, with publicAt the first filing that reported each selected value. Both are priced at the ${artifact.historicalMultiples.priceSelectionRule}; statement period ends do not establish public availability. Reporting currency: ${artifact.reportingCurrency ?? "unavailable"}. Quote currency: ${artifact.quoteCurrency ?? "unavailable"}.`,
    "",
    ...trailing,
    ...(scopeDisclosure === undefined ? [] : [`- ${scopeDisclosure}.`, ""]),
    ...historical,
    ...(unpricedLine === undefined ? [] : [unpricedLine]),
    "",
    peerSection(artifact, report),
    "",
  ].join("\n");
}
