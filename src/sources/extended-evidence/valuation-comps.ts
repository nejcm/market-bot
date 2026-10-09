import {
  excludedPeer,
  peerRow,
  revenueMultipleMeaningful,
  targetRow,
} from "./valuation-comps-rows";
import { buildArtifact } from "./valuation-comps-range";
import {
  balanceSheetPeriodDivergence,
  mixedPeriodValuationGap,
  enrichValuationItem,
  guardMixedPeriodValuationItem,
  peerImpliedRangeSuppressionGaps,
  replaceValuationItem,
  sourcesForPeer,
  usablePeersLabel,
  valuationCompsGap,
} from "./valuation-comps-support";
import {
  REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
  SUPPORTABILITY_SUPPRESSION_CAUSE,
  type ValuationCompsOptions,
  type ValuationCompsResult,
} from "./valuation-comps-contract";

import type { InstrumentCommand } from "../../cli/args";
import { sourceGapWithContext } from "../../domain/source-gaps";
import {
  type ExtendedEvidence,
  type ExtendedEvidenceItem,
  type MarketSnapshot,
  type SourceGap,
} from "../../domain/types";
import {
  hasPeerBandInputs,
  resolvePeerUniverseWithFallback,
  type PeerUniverseRefreshNote,
  type PeerUniverseTargetInputs,
} from "../../research/peer-universe";
import { isFetchJsonResult, type CollectContext } from "../types";
import {
  normalizeYahooQuotePayload,
  requestJsonWithQuoteFallback,
  yahooQuoteSourceRequest,
} from "../yahoo";
import { fetchSecCompanyFactsForSymbol } from "./sec-edgar";
import { readStringMetric } from "./utils";

export {
  MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS,
  MIXED_PERIOD_METRIC,
  REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
  type PeerImpliedRange,
  type PeerImpliedRangeSuppressedReason,
  type ValuationCompsArtifact,
  type ValuationCompsOptions,
  type ValuationCompsRow,
} from "./valuation-comps-contract";
export { derivePeerImpliedRange } from "./valuation-comps-range";
export {
  peerImpliedRangeSuppressionGaps,
  valuationCompsSkippedGap,
} from "./valuation-comps-support";

export async function collectValuationComps(
  ctx: CollectContext,
  command: InstrumentCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedEvidence: ExtendedEvidence,
  options: ValuationCompsOptions = {},
): Promise<ValuationCompsResult> {
  const valuationItem = valuationEvidenceItem(extendedEvidence);
  if (valuationItem === undefined) {
    return emptyResult(ctx, command, extendedEvidence, "missing valuation item");
  }
  const targetPeriodDivergence = targetBalanceSheetPeriodDivergence(
    extendedEvidence,
    valuationItem,
  );
  const guardedValuationItem = guardMixedPeriodValuationItem(valuationItem, targetPeriodDivergence);
  const mixedPeriodGaps =
    targetPeriodDivergence === undefined
      ? []
      : [mixedPeriodValuationGap(command.symbol, targetPeriodDivergence)];

  const targetSnapshot = marketSnapshots.find(
    (snapshot) =>
      snapshot.assetClass === "equity" &&
      snapshot.symbol.toUpperCase() === command.symbol.toUpperCase(),
  );
  const target = targetRow(command.symbol, guardedValuationItem, targetSnapshot, ctx.fetchedAt);
  const targetInputs: PeerUniverseTargetInputs = {
    ...(target.marketCap !== undefined ? { marketCap: target.marketCap } : {}),
    ...(target.sic !== undefined ? { sic: target.sic } : {}),
    ...(target.annualizedRevenue !== undefined && revenueMultipleMeaningful(target)
      ? { annualizedRevenue: target.annualizedRevenue }
      : {}),
  };
  const resolution = await resolvePeerUniverseWithFallback(
    command.symbol,
    options.peerUniverseFallback,
    options.peerUniverseMappings,
    options.subjectRegistry,
    targetInputs,
  );
  const refreshGaps =
    resolution.refresh === undefined
      ? []
      : [
          peerUniverseRefreshGap(
            command.symbol,
            resolution.refresh,
            resolution.status === "resolved",
          ),
        ];
  if (resolution.status !== "resolved" || resolution.universe === undefined) {
    const gap = valuationCompsGap(
      `Peer Universe unavailable for ${command.symbol}: ${resolution.reason}`,
      "unsupported-coverage",
      "valuation-peers",
      command.symbol.toUpperCase(),
    );
    const baseGaps = [...mixedPeriodGaps, ...refreshGaps, gap];
    const artifact = buildArtifact(ctx.fetchedAt, target, [], [], undefined, baseGaps, []);
    const allGaps = [...baseGaps, ...peerImpliedRangeSuppressionGaps(artifact)];
    return {
      extendedEvidence: replaceValuationItem(
        extendedEvidence,
        enrichValuationItem(guardedValuationItem, artifact),
        allGaps,
      ),
      artifact,
      sources: [],
      rawSnapshots: [],
      gaps: allGaps,
    };
  }

  const { universe } = resolution;
  const quoteResult = await requestJsonWithQuoteFallback(
    ctx,
    yahooQuoteSourceRequest(
      universe.peers.map((peer) => peer.symbol),
      "yahoo-valuation-peers",
    ),
  );
  const quoteSnapshots = isFetchJsonResult(quoteResult)
    ? normalizeYahooQuotePayload(quoteResult.payload, "equity", quoteResult.rawSnapshot.fetchedAt)
    : [];
  const quoteBySymbol = new Map(quoteSnapshots.map((snapshot) => [snapshot.symbol, snapshot]));
  const quoteGap = !isFetchJsonResult(quoteResult)
    ? [
        sourceGapWithContext(quoteResult, {
          capability: "market-data",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ]
    : [];
  const peerSecResults = await Promise.all(
    universe.peers.map(async (peer) => ({
      peer,
      provenance: universe.provenance,
      quote: quoteBySymbol.get(peer.symbol),
      sec: await fetchSecCompanyFactsForSymbol(ctx, peer.symbol, options.secTickerPayload),
    })),
  );
  const peers = peerSecResults.map((entry) => peerRow(entry, ctx.fetchedAt, target));
  const excludedPeers = peers.flatMap((row, index) =>
    excludedPeer(
      row,
      universe.peers,
      universe.provenance,
      ctx.fetchedAt,
      target,
      peerSecResults[index]?.sec,
    ),
  );
  const peerSources = peerSecResults.flatMap((entry) =>
    sourcesForPeer(
      command,
      entry,
      excludedPeers.flatMap((peer) => (peer.symbol === entry.peer.symbol ? peer.sourceIds : [])),
    ),
  );
  const peerGaps = [
    ...mixedPeriodGaps,
    ...refreshGaps,
    ...quoteGap,
    ...peerSecResults.flatMap((entry) =>
      // Every SEC gap here comes from fetching this peer's facts, so it is owned
      // By the peer — overwrite unconditionally so stale attribution cannot
      // Survive and collide with the target or another peer during dedupe.
      entry.sec.gaps.map((gap) => ({ ...gap, symbol: entry.peer.symbol })),
    ),
    ...excludedPeers.map((peer) =>
      valuationCompsGap(
        `Peer ${peer.symbol} excluded from valuation comps: ${peer.reason}`,
        peer.cause,
        "valuation-peers",
        peer.symbol,
      ),
    ),
  ];
  const artifact = buildArtifact(
    ctx.fetchedAt,
    target,
    peers,
    excludedPeers,
    universe,
    peerGaps,
    peerSources.map((source) => source.id),
  );
  const { valuationSupportability, usablePeerCount } = artifact.summary;
  const rawSnapshots = [
    ...(isFetchJsonResult(quoteResult) ? [quoteResult.rawSnapshot] : []),
    ...peerSecResults.flatMap((entry) => entry.sec.rawSnapshots),
  ];
  // A stale fallback withholds its payload, so its peers read as missing data rather than an outage.
  if (
    resolution.learnedGeneration !== undefined &&
    hasPeerBandInputs(targetInputs) &&
    !peerGaps.some((gap) => isTransientFetchGap(gap)) &&
    !rawSnapshots.some((snapshot) => snapshot.cacheStatus === "stale-fallback")
  ) {
    await options.peerUniverseFallback
      ?.recordEvaluation?.(
        command.symbol,
        resolution.learnedGeneration,
        usablePeerCount,
        excludedPeers.map(({ symbol, cause }) => ({ symbol, cause })),
      )
      .catch(() => {});
  }
  const usablePeers = usablePeersLabel(usablePeerCount);
  const supportabilityGaps =
    valuationSupportability === "supported"
      ? []
      : [
          valuationCompsGap(
            valuationSupportability === "not-meaningful"
              ? `Valuation peer comps not-meaningful for ${command.symbol}: ${REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT} ${usablePeers} passed the applicable gates`
              : `Valuation peer comps ${valuationSupportability} for ${command.symbol}: ${usablePeers}`,
            SUPPORTABILITY_SUPPRESSION_CAUSE[valuationSupportability],
            "valuation",
            command.symbol.toUpperCase(),
          ),
        ];
  const allGaps = [
    ...peerGaps,
    ...supportabilityGaps,
    // A suppressed range only restates the supportability gap, which stays the material one.
    ...peerImpliedRangeSuppressionGaps(artifact).map((gap) =>
      supportabilityGaps.length === 0 ? gap : { ...gap, triage: "diagnostic" as const },
    ),
  ];
  return {
    extendedEvidence: replaceValuationItem(
      extendedEvidence,
      enrichValuationItem(guardedValuationItem, artifact),
      allGaps,
    ),
    artifact,
    sources: peerSources,
    rawSnapshots,
    gaps: allGaps,
  };
}

const REFRESH_NOTES: Record<
  PeerUniverseRefreshNote["outcome"],
  { readonly text: string; readonly cause: SourceGap["cause"] }
> = {
  insufficient: {
    text: "the re-proposal did not yield a valid peer set",
    cause: "validation-failed",
  },
  "claim-lost": {
    text: "the refresh was not claimed by this run (already claimed or no longer due)",
    cause: "suppressed-by-design",
  },
  "claim-error": {
    text: "the refresh claim could not be persisted; allowance not consumed",
    cause: "provider-data-missing",
  },
  "allowance-used": {
    text: "the one refresh allowed per TTL window is already used",
    cause: "suppressed-by-design",
  },
  unavailable: {
    text: "the re-proposal could not run because the peer directory or model was unavailable",
    cause: "provider-data-missing",
  },
  "missing-target-inputs": {
    text: "target market cap or SIC is unavailable, so the re-proposal is deferred",
    cause: "suppressed-by-design",
  },
};

function peerUniverseRefreshGap(
  symbol: string,
  refresh: PeerUniverseRefreshNote,
  reusedLearnedPeers: boolean,
): SourceGap {
  const note = REFRESH_NOTES[refresh.outcome];
  const audit =
    refresh.audit === undefined
      ? ""
      : ` (${String(refresh.audit.survived)} of ${String(refresh.audit.proposed)} proposed peers validated${reusedLearnedPeers ? "; allowance consumed" : ""})`;
  const release =
    refresh.allowanceReleased === undefined
      ? ""
      : `; allowance ${refresh.allowanceReleased ? "released" : "not released"}`;
  const reuse = reusedLearnedPeers ? "; the previously learned peers were used" : "";
  return {
    ...valuationCompsGap(
      `Peer Universe refresh for ${symbol}: ${note.text}${audit}${release}${reuse}`,
      note.cause,
      "valuation-peers",
      symbol.toUpperCase(),
    ),
    triage: "diagnostic",
  };
}

function isTransientFetchGap(gap: SourceGap): boolean {
  return (
    gap.cause === "fetch-failed" ||
    gap.cause === "circuit-open" ||
    gap.cause === "malformed-response"
  );
}

function emptyResult(
  ctx: CollectContext,
  command: InstrumentCommand,
  extendedEvidence: ExtendedEvidence,
  reason: string,
): ValuationCompsResult {
  const target = {
    symbol: command.symbol.toUpperCase(),
    sourceIds: [],
    usable: false,
  };
  const gap = valuationCompsGap(
    `Valuation peer comps unavailable for ${command.symbol}: ${reason}`,
    "provider-data-missing",
    "valuation-peers",
    command.symbol.toUpperCase(),
  );
  const artifact = buildArtifact(ctx.fetchedAt, target, [], [], undefined, [gap], []);
  const allGaps = [gap, ...peerImpliedRangeSuppressionGaps(artifact)];
  return {
    extendedEvidence: { ...extendedEvidence, gaps: [...extendedEvidence.gaps, ...allGaps] },
    artifact,
    sources: [],
    rawSnapshots: [],
    gaps: allGaps,
  };
}

function valuationEvidenceItem(evidence: ExtendedEvidence): ExtendedEvidenceItem | undefined {
  return evidence.items.find((item) => item.category === "valuation");
}

function targetBalanceSheetPeriodDivergence(
  evidence: ExtendedEvidence,
  valuationItem: ExtendedEvidenceItem,
) {
  const valuationCashPeriodEnd = readStringMetric(valuationItem.metrics, "cashPeriodEnd");
  const valuationDebtPeriodEnd = readStringMetric(valuationItem.metrics, "debtPeriodEnd");
  if (valuationCashPeriodEnd !== undefined && valuationDebtPeriodEnd !== undefined) {
    return balanceSheetPeriodDivergence(valuationItem.metrics);
  }
  const secItem = evidence.items.find(
    (item) =>
      item.category === "sec-edgar" &&
      readStringMetric(item.metrics, "cashPeriodEnd") !== undefined &&
      readStringMetric(item.metrics, "debtPeriodEnd") !== undefined,
  );
  return balanceSheetPeriodDivergence(secItem?.metrics);
}
