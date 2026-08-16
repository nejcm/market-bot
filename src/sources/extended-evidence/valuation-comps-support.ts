import type { InstrumentCommand } from "../../cli/args";
import { DAY_MS, SEC_FRESHNESS_DAYS } from "../../config/shared";
import { sourceGap } from "../../domain/source-gaps";
import type { ExtendedEvidence, ExtendedEvidenceItem, Source, SourceGap } from "../../domain/types";
import { evidenceSource } from "./common";
import {
  REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
  SUPPORTABILITY_SUPPRESSION_CAUSE,
  SUPPRESSION_CAUSE,
  type PeerPacket,
  type ValuationCompsArtifact,
} from "./valuation-comps-contract";

export function enrichValuationItem(
  item: ExtendedEvidenceItem,
  artifact: ValuationCompsArtifact,
): ExtendedEvidenceItem {
  const { summary } = artifact;
  const applicabilityCaveat =
    summary.valuationSupportability === "not-meaningful"
      ? ` ${REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT}`
      : "";
  const peerReadThrough =
    summary.peerMedianEvToAnnualizedRevenue === undefined
      ? ` Peer comps supportability: ${summary.valuationSupportability}; ${summary.usablePeerCount} usable peers.${applicabilityCaveat}`
      : ` Peer comps supportability: ${summary.valuationSupportability}; median EV/annualized revenue ${summary.peerMedianEvToAnnualizedRevenue.toFixed(2)}x, IQR ${summary.peerP25EvToAnnualizedRevenue?.toFixed(2)}x-${summary.peerP75EvToAnnualizedRevenue?.toFixed(2)}x.${applicabilityCaveat}`;
  const provenanceNote =
    artifact.provenance === "model-proposed-validated"
      ? " Peer set provenance: model-proposed (LLM-proposed, code-validated against SEC directory + US-listing; cached)."
      : "";
  return {
    ...item,
    summary: `${item.summary}${peerReadThrough}${provenanceNote}`,
    sourceIds: unique([...item.sourceIds, ...artifact.sourceIds]),
    metrics: {
      ...item.metrics,
      corePeerCount: summary.corePeerCount,
      ...(summary.peerMedianEvToAnnualizedRevenue !== undefined
        ? { peerMedianEvToAnnualizedRevenue: summary.peerMedianEvToAnnualizedRevenue }
        : {}),
      ...(summary.peerP25EvToAnnualizedRevenue !== undefined
        ? { peerP25EvToAnnualizedRevenue: summary.peerP25EvToAnnualizedRevenue }
        : {}),
      ...(summary.peerP75EvToAnnualizedRevenue !== undefined
        ? { peerP75EvToAnnualizedRevenue: summary.peerP75EvToAnnualizedRevenue }
        : {}),
      valuationSupportability: summary.valuationSupportability,
      ...(summary.valuationSupportability === "not-meaningful"
        ? { valuationCaveat: REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT }
        : {}),
    },
  };
}

export function replaceValuationItem(
  evidence: ExtendedEvidence,
  valuationItem: ExtendedEvidenceItem,
  gaps: readonly SourceGap[],
): ExtendedEvidence {
  return {
    ...evidence,
    items: evidence.items.map((item) => (item.category === "valuation" ? valuationItem : item)),
    gaps: [...evidence.gaps, ...gaps],
  };
}

export function sourcesForPeer(command: InstrumentCommand, entry: PeerPacket): readonly Source[] {
  const quoteSource =
    entry.quote === undefined
      ? undefined
      : {
          id: entry.quote.sourceId,
          title: `${entry.peer.symbol} Yahoo valuation peer quote`,
          fetchedAt: entry.quote.observedAt,
          kind: "market-data" as const,
          assetClass: "equity" as const,
          symbol: entry.peer.symbol,
          provider: "yahoo",
          ...(entry.quote.identity !== undefined ? { identity: entry.quote.identity } : {}),
        };
  const secSource =
    entry.sec.sourceId !== undefined && entry.sec.fetchedAt !== undefined
      ? evidenceSource(
          entry.sec.sourceId,
          `${entry.peer.symbol} SEC fundamentals`,
          "sec-edgar",
          { ...command, symbol: entry.peer.symbol },
          entry.sec.fetchedAt,
          entry.sec.sourceUrl,
          entry.sec.identity,
        )
      : undefined;
  // Mirrors the SIC gate in peerRow: every submissions source id referenced by
  // A row must resolve to an emitted Source.
  const submissionsSource =
    entry.sec.sicClassification !== undefined &&
    entry.sec.submissionsSourceId !== undefined &&
    entry.sec.submissionsFetchedAt !== undefined
      ? evidenceSource(
          entry.sec.submissionsSourceId,
          `${entry.peer.symbol} SEC filings`,
          "sec-edgar",
          { ...command, symbol: entry.peer.symbol },
          entry.sec.submissionsFetchedAt,
          entry.sec.submissionsUrl,
          entry.sec.identity,
        )
      : undefined;
  return [quoteSource, secSource, submissionsSource].filter(
    (source): source is Source => source !== undefined,
  );
}

export function isFreshDate(observedAt: string | undefined, generatedAt: string): boolean {
  return observedAt !== undefined && observedAt.slice(0, 10) === generatedAt.slice(0, 10);
}

export function isFreshPeriodEnd(periodEnd: string, generatedAt: string): boolean {
  const periodMs = Date.parse(periodEnd);
  const generatedMs = Date.parse(generatedAt);
  if (!Number.isFinite(periodMs) || !Number.isFinite(generatedMs)) {
    return false;
  }
  const ageMs = generatedMs - periodMs;
  return ageMs >= 0 && ageMs <= SEC_FRESHNESS_DAYS * DAY_MS;
}

export function percentile(values: readonly number[], p: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * weight;
}

export function valuationCompsGap(
  message: string,
  cause: SourceGap["cause"] = "provider-data-missing",
  source = "valuation",
  symbol?: string,
): SourceGap {
  return sourceGap({
    source,
    message,
    ...(symbol !== undefined ? { symbol } : {}),
    provider: "market-bot",
    capability: "extended-evidence",
    cause,
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

export function valuationCompsSkippedGap(symbol: string): SourceGap {
  return valuationCompsGap(
    `Valuation peer comps skipped for ${symbol}: target valuation unavailable`,
    "provider-data-missing",
    "valuation-peers",
    symbol.toUpperCase(),
  );
}

export function peerImpliedRangeSuppressionGaps(
  artifact: ValuationCompsArtifact,
): readonly SourceGap[] {
  const range = artifact.impliedPriceRange;
  if (range?.status !== "suppressed") {
    return [];
  }
  return [
    sourceGap({
      source: "valuation",
      message: `Peer-implied price reference range suppressed for ${artifact.target.symbol}: ${range.suppressedReason}`,
      symbol: artifact.target.symbol,
      provider: "market-bot",
      capability: "extended-evidence",
      cause:
        range.suppressedReason === "peer supportability is not supported"
          ? SUPPORTABILITY_SUPPRESSION_CAUSE[artifact.summary.valuationSupportability]
          : SUPPRESSION_CAUSE[range.suppressedReason],
      evidenceQualityImpact: "no-cap",
    }),
  ];
}

export function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
