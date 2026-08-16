import { excludedPeer, peerRow, targetRow } from "./valuation-comps-rows";
import { buildArtifact } from "./valuation-comps-range";
import {
  enrichValuationItem,
  peerImpliedRangeSuppressionGaps,
  replaceValuationItem,
  sourcesForPeer,
  valuationCompsGap,
} from "./valuation-comps-support";
import {
  MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS,
  MIXED_PERIOD_METRIC,
  REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
  type ValuationCompsOptions,
  type ValuationCompsResult,
} from "./valuation-comps-contract";

import type { InstrumentCommand } from "../../cli/args";
import { DAY_MS } from "../../config/shared";
import { sourceGapWithContext } from "../../domain/source-gaps";
import {
  type ExtendedEvidence,
  type ExtendedEvidenceItem,
  type MarketSnapshot,
} from "../../domain/types";
import { resolvePeerUniverseWithFallback } from "../../research/peer-universe";
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
      : [
          valuationCompsGap(
            `Mixed-period valuation inputs for ${command.symbol}: cash period end ${targetPeriodDivergence.cashPeriodEnd} and debt period end ${targetPeriodDivergence.debtPeriodEnd} diverge by ${String(targetPeriodDivergence.divergenceDays)} days; enterprise value and net debt flagged as mixed-period`,
            "provider-data-missing",
            "valuation",
            command.symbol.toUpperCase(),
          ),
        ];

  const targetSnapshot = marketSnapshots.find(
    (snapshot) =>
      snapshot.assetClass === "equity" &&
      snapshot.symbol.toUpperCase() === command.symbol.toUpperCase(),
  );
  const target = targetRow(command.symbol, guardedValuationItem, targetSnapshot, ctx.fetchedAt);
  const resolution = await resolvePeerUniverseWithFallback(
    command.symbol,
    options.peerUniverseFallback,
    options.peerUniverseMappings,
    options.subjectRegistry,
  );
  if (resolution.status !== "resolved" || resolution.universe === undefined) {
    const gap = valuationCompsGap(
      `Peer Universe unavailable for ${command.symbol}: ${resolution.reason}`,
      "unsupported-coverage",
      "valuation-peers",
      command.symbol.toUpperCase(),
    );
    const baseGaps = [...mixedPeriodGaps, gap];
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
  const peerSources = peerSecResults.flatMap((entry) => sourcesForPeer(command, entry));
  const peers = peerSecResults.map((entry) => peerRow(entry, ctx.fetchedAt, target));
  const excludedPeers = peers.flatMap((row) =>
    excludedPeer(row, universe.peers, universe.provenance, ctx.fetchedAt, target),
  );
  const peerGaps = [
    ...mixedPeriodGaps,
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
        "provider-data-missing",
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
  const supportabilityGaps =
    artifact.summary.valuationSupportability === "supported"
      ? []
      : [
          valuationCompsGap(
            artifact.summary.valuationSupportability === "not-meaningful"
              ? `Valuation peer comps not-meaningful for ${command.symbol}: ${REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT} ${String(artifact.summary.usablePeerCount)} usable peers passed the applicable gates`
              : `Valuation peer comps ${artifact.summary.valuationSupportability} for ${command.symbol}: ${artifact.summary.usablePeerCount} usable peers`,
            "provider-data-missing",
            "valuation",
            command.symbol.toUpperCase(),
          ),
        ];
  const allGaps = [
    ...peerGaps,
    ...supportabilityGaps,
    ...peerImpliedRangeSuppressionGaps(artifact),
  ];
  return {
    extendedEvidence: replaceValuationItem(
      extendedEvidence,
      enrichValuationItem(guardedValuationItem, artifact),
      allGaps,
    ),
    artifact,
    sources: peerSources,
    rawSnapshots: [
      ...(isFetchJsonResult(quoteResult) ? [quoteResult.rawSnapshot] : []),
      ...peerSecResults.flatMap((entry) => entry.sec.rawSnapshots),
    ],
    gaps: allGaps,
  };
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

interface BalanceSheetPeriodDivergence {
  readonly cashPeriodEnd: string;
  readonly debtPeriodEnd: string;
  readonly divergenceDays: number;
}

function balanceSheetPeriodDivergence(
  metrics: Readonly<Record<string, number | string>> | undefined,
): BalanceSheetPeriodDivergence | undefined {
  const cashPeriodEnd = readStringMetric(metrics, "cashPeriodEnd");
  const debtPeriodEnd = readStringMetric(metrics, "debtPeriodEnd");
  if (cashPeriodEnd === undefined || debtPeriodEnd === undefined) {
    return undefined;
  }
  const cashPeriodMs = Date.parse(cashPeriodEnd);
  const debtPeriodMs = Date.parse(debtPeriodEnd);
  if (!Number.isFinite(cashPeriodMs) || !Number.isFinite(debtPeriodMs)) {
    return undefined;
  }
  const divergenceDays = Math.abs(cashPeriodMs - debtPeriodMs) / DAY_MS;
  return divergenceDays > MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS
    ? { cashPeriodEnd, debtPeriodEnd, divergenceDays }
    : undefined;
}

function targetBalanceSheetPeriodDivergence(
  evidence: ExtendedEvidence,
  valuationItem: ExtendedEvidenceItem,
): BalanceSheetPeriodDivergence | undefined {
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

function guardMixedPeriodValuationItem(
  item: ExtendedEvidenceItem,
  divergence: BalanceSheetPeriodDivergence | undefined,
): ExtendedEvidenceItem {
  if (divergence === undefined) {
    return item;
  }
  const retainedMetrics = Object.fromEntries(
    Object.entries(item.metrics ?? {}).filter(
      ([key]) => key !== "evToAnnualizedRevenue" && key !== "netDebtToMarketCap",
    ),
  );
  return {
    ...item,
    summary: `Valuation Evidence: cash period end ${divergence.cashPeriodEnd} and debt period end ${divergence.debtPeriodEnd} diverge by ${String(divergence.divergenceDays)} days; enterprise value and net debt are mixed-period. Raw market cap, cash, debt, and revenue metrics are retained.`,
    metrics: {
      ...retainedMetrics,
      cashPeriodEnd: divergence.cashPeriodEnd,
      debtPeriodEnd: divergence.debtPeriodEnd,
      netDebt: MIXED_PERIOD_METRIC,
      enterpriseValue: MIXED_PERIOD_METRIC,
    },
  };
}
