import { gateProfileFor, revenueMultipleMeaningful } from "./valuation-comps-rows";
import type { SourceGap } from "../../domain/types";
import type { PeerUniverse } from "../../research/peer-universe";
import {
  MIN_USABLE_PEERS,
  MIXED_PERIOD_METRIC,
  type ExcludedValuationPeer,
  type PeerImpliedRange,
  type PeerImpliedRangeDerivedInputs,
  type PeerImpliedRangeInputs,
  type PeerImpliedRangePosition,
  type PeerImpliedRangeSuppressedReason,
  type ValuationCompsArtifact,
  type ValuationCompsRow,
  type ValuationSupportability,
} from "./valuation-comps-contract";

import { isFreshDate, isFreshPeriodEnd, percentile, unique } from "./valuation-comps-support";

export function buildArtifact(
  generatedAt: string,
  target: ValuationCompsRow,
  peers: readonly ValuationCompsRow[],
  excludedPeers: readonly ExcludedValuationPeer[],
  universe: PeerUniverse | undefined,
  gaps: readonly SourceGap[],
  peerSourceIds: readonly string[],
): ValuationCompsArtifact {
  const usablePeers = peers.filter((peer) => peer.usable);
  const multiples = usablePeers.flatMap((peer) =>
    peer.evToAnnualizedRevenue === undefined ? [] : [peer.evToAnnualizedRevenue],
  );
  const supportability = supportabilityFor(target, usablePeers.length);
  const peerPercentiles =
    multiples.length >= MIN_USABLE_PEERS
      ? {
          p25: percentile(multiples, 0.25),
          median: percentile(multiples, 0.5),
          p75: percentile(multiples, 0.75),
        }
      : undefined;
  const impliedPriceRange = derivePeerImpliedRange({
    supportability,
    usablePeerCount: usablePeers.length,
    ...(peerPercentiles !== undefined
      ? {
          peerP25EvToAnnualizedRevenue: peerPercentiles.p25,
          peerMedianEvToAnnualizedRevenue: peerPercentiles.median,
          peerP75EvToAnnualizedRevenue: peerPercentiles.p75,
        }
      : {}),
    ...(target.annualizedRevenue !== undefined
      ? { annualizedRevenue: target.annualizedRevenue }
      : {}),
    ...(target.netDebt !== undefined ? { netDebt: target.netDebt } : {}),
    ...(target.sharesOutstanding !== undefined
      ? { sharesOutstanding: target.sharesOutstanding }
      : {}),
    ...(target.currentPrice !== undefined ? { currentPrice: target.currentPrice } : {}),
    ...(target.quoteCurrency !== undefined ? { quoteCurrency: target.quoteCurrency } : {}),
    ...(target.quoteObservedAt !== undefined ? { quoteObservedAt: target.quoteObservedAt } : {}),
  });
  return {
    version: 1,
    generatedAt,
    target,
    peers,
    excludedPeers,
    ...(universe !== undefined ? { provenance: universe.provenance } : {}),
    peerUniverseSourceIds: universe?.sources.map((source) => source.sourceId) ?? [],
    summary: {
      corePeerCount: usablePeers.filter((peer) => peer.role === "core").length,
      secondaryPeerCount: usablePeers.filter((peer) => peer.role === "secondary").length,
      usablePeerCount: usablePeers.length,
      ...(target.evToAnnualizedRevenue !== undefined
        ? { targetEvToAnnualizedRevenue: target.evToAnnualizedRevenue }
        : {}),
      ...(peerPercentiles !== undefined
        ? {
            peerMedianEvToAnnualizedRevenue: peerPercentiles.median,
            peerP25EvToAnnualizedRevenue: peerPercentiles.p25,
            peerP75EvToAnnualizedRevenue: peerPercentiles.p75,
          }
        : {}),
      valuationSupportability: supportability,
      ...(universe !== undefined
        ? { gateProfile: gateProfileFor(universe.provenance, target) }
        : {}),
    },
    impliedPriceRange,
    sourceIds: unique([
      ...target.sourceIds,
      ...peers.flatMap((peer) => peer.sourceIds),
      ...peerSourceIds,
    ]),
    freshnessFlags: {
      targetQuoteFresh:
        target.quoteObservedAt !== undefined && isFreshDate(target.quoteObservedAt, generatedAt),
      targetSecFresh:
        target.revenuePeriodEnd !== undefined &&
        isFreshPeriodEnd(target.revenuePeriodEnd, generatedAt),
      peerQuoteFresh:
        peers.length > 0 &&
        peers.every(
          (peer) =>
            peer.quoteObservedAt !== undefined && isFreshDate(peer.quoteObservedAt, generatedAt),
        ),
      peerSecFresh:
        peers.length > 0 &&
        peers.every(
          (peer) =>
            peer.revenuePeriodEnd !== undefined &&
            isFreshPeriodEnd(peer.revenuePeriodEnd, generatedAt),
        ),
    },
  };
}

interface DerivePeerImpliedRangeInput {
  readonly supportability: ValuationSupportability;
  readonly usablePeerCount: number;
  readonly peerP25EvToAnnualizedRevenue?: number;
  readonly peerMedianEvToAnnualizedRevenue?: number;
  readonly peerP75EvToAnnualizedRevenue?: number;
  readonly annualizedRevenue?: number;
  readonly netDebt?: number | typeof MIXED_PERIOD_METRIC;
  readonly sharesOutstanding?: number;
  readonly currentPrice?: number;
  readonly quoteCurrency?: string;
  readonly quoteObservedAt?: string;
}

export function derivePeerImpliedRange(input: DerivePeerImpliedRangeInput): PeerImpliedRange {
  const {
    supportability,
    usablePeerCount,
    peerP25EvToAnnualizedRevenue,
    peerMedianEvToAnnualizedRevenue,
    peerP75EvToAnnualizedRevenue,
    annualizedRevenue,
    netDebt,
    sharesOutstanding,
    currentPrice,
    quoteCurrency,
  } = input;
  const inputs: PeerImpliedRangeInputs = {
    peerP25EvToAnnualizedRevenue: peerP25EvToAnnualizedRevenue ?? null,
    peerMedianEvToAnnualizedRevenue: peerMedianEvToAnnualizedRevenue ?? null,
    peerP75EvToAnnualizedRevenue: peerP75EvToAnnualizedRevenue ?? null,
    annualizedRevenue: annualizedRevenue ?? null,
    netDebt: netDebt ?? null,
    sharesOutstanding: sharesOutstanding ?? null,
    currentPrice: currentPrice ?? null,
    quoteCurrency: quoteCurrency ?? null,
    quoteObservedAt: input.quoteObservedAt ?? null,
  };
  const base = {
    label: "peer-implied price reference range" as const,
    basis: "peer EV/annualized revenue percentiles applied to target annualized revenue" as const,
    formula: "impliedPrice(m) = (m × annualizedRevenue − netDebt) / sharesOutstanding" as const,
    inputs,
  };
  const suppressed = (suppressedReason: PeerImpliedRangeSuppressedReason): PeerImpliedRange => ({
    ...base,
    status: "suppressed",
    suppressedReason,
  });

  if (supportability !== "supported") {
    return suppressed("peer supportability is not supported");
  }
  if (usablePeerCount < MIN_USABLE_PEERS) {
    return suppressed("fewer than 3 usable peers");
  }
  if (annualizedRevenue === undefined || annualizedRevenue <= 0) {
    return suppressed("annualized revenue is not positive");
  }
  if (netDebt === undefined) {
    return suppressed("net debt is unavailable");
  }
  if (netDebt === MIXED_PERIOD_METRIC) {
    return suppressed("net debt uses mixed reporting periods");
  }
  if (sharesOutstanding === undefined || sharesOutstanding <= 0) {
    return suppressed("shares outstanding is not positive");
  }
  if (quoteCurrency !== "USD") {
    return suppressed("quote currency is not USD");
  }

  if (
    peerP25EvToAnnualizedRevenue === undefined ||
    peerMedianEvToAnnualizedRevenue === undefined ||
    peerP75EvToAnnualizedRevenue === undefined
  ) {
    return suppressed("peer percentile inputs are unavailable");
  }
  const low = (peerP25EvToAnnualizedRevenue * annualizedRevenue - netDebt) / sharesOutstanding;
  const mid = (peerMedianEvToAnnualizedRevenue * annualizedRevenue - netDebt) / sharesOutstanding;
  const high = (peerP75EvToAnnualizedRevenue * annualizedRevenue - netDebt) / sharesOutstanding;
  const prices = [low, mid, high];
  if (prices.some((price) => !Number.isFinite(price) || price <= 0)) {
    return suppressed("one or more implied prices are not positive");
  }
  if (currentPrice === undefined) {
    return suppressed("current price is unavailable");
  }

  let position: PeerImpliedRangePosition = "within-range";
  if (currentPrice < low) {
    position = "below-range";
  } else if (currentPrice > high) {
    position = "above-range";
  }
  const derivedInputs: PeerImpliedRangeDerivedInputs = {
    peerP25EvToAnnualizedRevenue,
    peerMedianEvToAnnualizedRevenue,
    peerP75EvToAnnualizedRevenue,
    annualizedRevenue,
    netDebt,
    sharesOutstanding,
    currentPrice,
    quoteCurrency,
    quoteObservedAt: input.quoteObservedAt ?? null,
  };
  return { ...base, inputs: derivedInputs, status: "derived", low, mid, high, position };
}

function supportabilityFor(
  target: ValuationCompsRow,
  usablePeerCount: number,
): ValuationSupportability {
  if (!revenueMultipleMeaningful(target)) {
    return "not-meaningful";
  }
  if (!target.usable) {
    return "not-supportable";
  }
  return usablePeerCount >= MIN_USABLE_PEERS ? "supported" : "screening-only";
}
