import type {
  HistoricalValuationObservation,
  ValuationWorkbenchArtifact,
} from "../sources/extended-evidence/valuation-workbench-contract";
import type {
  PeerImpliedRange,
  ValuationCompsRow,
} from "../sources/extended-evidence/valuation-comps";
import type { MarketSnapshotPriceAsOf, ResearchReport } from "../domain/types";
import { metricCell } from "./equity-reader-trends";
import { knownSourceIds, sourceRefs } from "./markdown-primitives";
import { stringArrayValue } from "../guards";

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

function historicalRow(observation: HistoricalValuationObservation): string {
  const price =
    observation.price === null
      ? "—"
      : `${observation.price.close.toFixed(2)} ${observation.price.currency} (${observation.price.sessionDate}${fxNote(observation)})`;
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

function rowPriceAsOf(row: ValuationCompsRow): MarketSnapshotPriceAsOf | undefined {
  return (
    row.priceAsOf ??
    (row.quoteObservedAt === undefined
      ? undefined
      : { kind: "fetch-time-only", instant: row.quoteObservedAt })
  );
}

function priceAsOfLabel(priceAsOf: MarketSnapshotPriceAsOf | undefined): string | undefined {
  if (priceAsOf === undefined) {
    return undefined;
  }
  return `${priceAsOf.kind === "quote-time" ? "quote time" : "fetch time"} ${priceAsOf.instant}`;
}

function peerRow(row: ValuationCompsRow, targetSymbol: string, report: ResearchReport): string {
  const multiple =
    typeof row.evToAnnualizedRevenue === "number"
      ? `${row.evToAnnualizedRevenue.toFixed(2)}x`
      : "N/M";
  const priceDate = priceAsOfLabel(rowPriceAsOf(row));
  const dates = [
    ...(priceDate === undefined ? [] : [priceDate]),
    ...(row.revenuePeriodEnd === undefined ? [] : [`revenue ${row.revenuePeriodEnd}`]),
    ...(row.cashPeriodEnd === undefined ? [] : [`cash ${row.cashPeriodEnd}`]),
    ...(row.debtPeriodEnd === undefined
      ? []
      : [
          `debt ${row.debtPeriodEnd}${row.debtBasis === "gross-principal" ? " (gross principal)" : ""}`,
        ]),
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
    .concat(sourceRefs(knownSourceIds(report, row.sourceIds)) || "—")
    .join(" | ");
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
    peerRow(row, valuationComps.target.symbol, report),
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
  key: "freeCashFlow" | "dilutedEps",
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

export function valuationScopeDisclosure(
  observations: readonly HistoricalValuationObservation[],
): string | undefined {
  const parts = [
    inputScopeDisclosure(observations, "dilutedEps", "P/E uses diluted EPS"),
    inputScopeDisclosure(observations, "freeCashFlow", "P/FCF uses free cash flow proxy"),
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
  const historical =
    observations.length === 0
      ? `- Suppressed: ${artifact.historicalMultiples.suppressionReasons.join("; ") || "no historical basis available"}.`
      : [
          "Basis | Statement period | Public date | First eligible close | P/E | P/S | EV/revenue | P/FCF",
          "--- | --- | --- | --- | ---: | ---: | ---: | ---:",
          ...observations.map((observation) => historicalRow(observation)),
        ].join("\n");
  const scopeDisclosure = valuationScopeDisclosure(observations);
  const trailing =
    artifact.historicalMultiples.trailingBasis.status === "available"
      ? [
          `- Trailing basis: reconciled TTM through ${artifact.historicalMultiples.trailingBasis.periodEnd}, public ${artifact.historicalMultiples.trailingBasis.publicAt}.`,
          "",
        ]
      : [];
  return [
    "",
    "## Valuation Workbench",
    "",
    `Historical multiples use the selected (possibly restated) fundamentals, with publicAt the first filing that reported each selected value, priced at the ${artifact.historicalMultiples.priceSelectionRule}; statement period ends do not establish public availability. Reporting currency: ${artifact.reportingCurrency ?? "unavailable"}. Quote currency: ${artifact.quoteCurrency ?? "unavailable"}.`,
    "",
    ...trailing,
    ...(scopeDisclosure === undefined ? [] : [`- ${scopeDisclosure}.`, ""]),
    historical,
    "",
    peerSection(artifact, report),
    "",
  ].join("\n");
}
