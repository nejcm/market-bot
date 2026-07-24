import type {
  HistoricalValuationObservation,
  ValuationMetricResult,
  ValuationWorkbenchArtifact,
} from "../sources/extended-evidence/valuation-workbench-contract";
import type {
  PeerImpliedRange,
  ValuationCompsRow,
} from "../sources/extended-evidence/valuation-comps";

function cell(value: string): string {
  return value.replaceAll("|", String.raw`\|`).replaceAll("\n", " ");
}

function metricCell(metric: ValuationMetricResult): string {
  if (metric.status === "populated" || metric.status === "not-meaningful") {
    return metric.display;
  }
  if (metric.status === "not-applicable") {
    return `${metric.display} (${metric.rationale})`;
  }
  return `${metric.display} (${metric.reason})`;
}

function historicalRow(observation: HistoricalValuationObservation): string {
  const price =
    observation.price === null
      ? "—"
      : `${observation.price.close.toFixed(2)} ${observation.price.currency} (${observation.price.sessionDate})`;
  return [
    observation.basis.toUpperCase(),
    observation.periodEnd,
    observation.publicAt,
    price,
    metricCell(observation.metrics.priceToEarnings),
    metricCell(observation.metrics.priceToSales),
    metricCell(observation.metrics.enterpriseValueToRevenue),
    metricCell(observation.metrics.priceToFreeCashFlow),
  ]
    .map((value) => cell(value))
    .join(" | ");
}

function peerRole(row: ValuationCompsRow, targetSymbol: string): string {
  if (row.symbol === targetSymbol) {
    return "target";
  }
  return row.role ?? "peer";
}

function peerRow(row: ValuationCompsRow, targetSymbol: string): string {
  const multiple =
    typeof row.evToAnnualizedRevenue === "number"
      ? `${row.evToAnnualizedRevenue.toFixed(2)}x`
      : "N/M";
  const dates = [
    ...(row.quoteObservedAt === undefined ? [] : [`quote ${row.quoteObservedAt}`]),
    ...(row.revenuePeriodEnd === undefined ? [] : [`revenue ${row.revenuePeriodEnd}`]),
    ...(row.cashPeriodEnd === undefined ? [] : [`cash ${row.cashPeriodEnd}`]),
    ...(row.debtPeriodEnd === undefined ? [] : [`debt ${row.debtPeriodEnd}`]),
  ].join("; ");
  return [
    row.symbol,
    peerRole(row, targetSymbol),
    row.usable ? "usable" : "excluded",
    multiple,
    row.quoteCurrency ?? "—",
    dates || "—",
  ]
    .map((value) => cell(value))
    .join(" | ");
}

function peerSection(artifact: ValuationWorkbenchArtifact): string {
  if (artifact.peerComparison.status === "suppressed") {
    return ["### Peer comparison", "", `- Suppressed: ${artifact.peerComparison.detail}`].join(
      "\n",
    );
  }
  const { valuationComps } = artifact.peerComparison;
  const rows = [valuationComps.target, ...valuationComps.peers].map((row) =>
    peerRow(row, valuationComps.target.symbol),
  );
  const rangeLine = peerReferenceRangeLine(valuationComps.impliedPriceRange);
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
    "Symbol | Role | Screen status | EV/revenue | Quote currency | Input dates",
    "--- | --- | --- | ---: | --- | ---",
    ...rows,
  ].join("\n");
}

function peerReferenceRangeLine(referenceRange: PeerImpliedRange | undefined): string {
  if (referenceRange === undefined) {
    return "- Reference range: suppressed (range output unavailable).";
  }
  if (referenceRange.status === "suppressed") {
    return `- Reference range: suppressed (${referenceRange.suppressedReason}).`;
  }
  return `- Reference range: ${referenceRange.low.toFixed(2)}–${referenceRange.high.toFixed(2)} ${referenceRange.inputs.quoteCurrency}; midpoint ${referenceRange.mid.toFixed(2)}; observed position ${referenceRange.position}; quote ${referenceRange.inputs.quoteObservedAt ?? "unavailable"}.`;
}

export function renderValuationWorkbenchMarkdown(
  artifact: ValuationWorkbenchArtifact | undefined,
): string {
  if (artifact === undefined) {
    return "";
  }
  const { observations } = artifact.historicalMultiples;
  const historical =
    observations.length === 0
      ? `- Suppressed: ${artifact.historicalMultiples.suppressionReasons.join("; ") || "no historical basis available"}.`
      : [
          "Basis | Statement period | Public date | First eligible close | P/E | P/S | EV/revenue | P/FCF",
          "--- | --- | --- | --- | ---: | ---: | ---: | ---:",
          ...observations.map((observation) => historicalRow(observation)),
        ].join("\n");
  const trailing =
    artifact.historicalMultiples.trailingBasis.status === "available"
      ? `- Trailing basis: reconciled TTM through ${artifact.historicalMultiples.trailingBasis.periodEnd}, public ${artifact.historicalMultiples.trailingBasis.publicAt}.`
      : `- Trailing basis suppressed: ${artifact.historicalMultiples.trailingBasis.detail}`;
  return [
    "",
    "## Valuation Workbench",
    "",
    `As-reported multiples use ${artifact.historicalMultiples.priceSelectionRule}; statement period ends do not establish public availability. Reporting currency: ${artifact.reportingCurrency ?? "unavailable"}. Quote currency: ${artifact.quoteCurrency ?? "unavailable"}.`,
    "",
    trailing,
    "",
    historical,
    "",
    peerSection(artifact),
    "",
  ].join("\n");
}
