import type {
  PeerUniverse,
  PeerUniverseFallbackContext,
  PeerUniverseMapping,
  PeerUniversePeer,
} from "../../research/peer-universe";
import type {
  ExtendedEvidence,
  MarketSnapshot,
  MarketSnapshotPriceAsOf,
  Source,
  SourceGap,
  SourceGapCause,
} from "../../domain/types";
import type { RawSourceSnapshot } from "../types";
import type { ResearchSubjectRegistryEntry } from "../../research/subject-registry";
import type { fetchSecCompanyFactsForSymbol } from "./sec-edgar";

export const MIN_USABLE_PEERS = 3;
export const MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS = 92;
export const MIXED_PERIOD_METRIC = "mixed-period" as const;

// Deterministic peer-comparability size gate: a peer qualifies for the primary
// Aggregate only when its market cap and annualized revenue are inclusively
// Within 0.2x-5x of the target's.
export const SIZE_GATE_MIN_RATIO = 0.2;
export const SIZE_GATE_MAX_RATIO = 5;

// Revenue-multiple applicability gate: above 50x, current revenue is too
// De-minimis relative to enterprise value for EV/revenue to be a meaningful
// Target valuation basis.
export const MAX_MEANINGFUL_EV_TO_ANNUALIZED_REVENUE = 50;

// Revenue-multiple applicability fallback: below 2% of market cap, current
// Revenue is de-minimis even when EV/revenue is unavailable.
export const MIN_MEANINGFUL_ANNUALIZED_REVENUE_TO_MARKET_CAP = 0.02;

export const REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT =
  "Revenue multiples are not a valid basis for this issuer; the peer set is size/sector-comparable only.";

export type ValuationSupportability =
  | "screening-only"
  | "supported"
  | "not-supportable"
  | "not-meaningful";

export interface ValuationCompsRow {
  readonly symbol: string;
  readonly name?: string;
  readonly role?: PeerUniversePeer["role"];
  readonly rationale?: string;
  readonly sic?: string;
  readonly sicDescription?: string;
  readonly marketCap?: number;
  readonly cash?: number;
  readonly debt?: number;
  readonly cashPeriodEnd?: string;
  readonly debtPeriodEnd?: string;
  readonly netDebt?: number | typeof MIXED_PERIOD_METRIC;
  readonly enterpriseValue?: number | typeof MIXED_PERIOD_METRIC;
  readonly latestPeriodRevenue?: number;
  readonly revenuePeriodMonths?: number;
  readonly revenuePeriodEnd?: string;
  readonly annualizedRevenue?: number;
  readonly evToAnnualizedRevenue?: number;
  readonly sharesOutstanding?: number;
  readonly currentPrice?: number;
  readonly quoteCurrency?: string;
  readonly quoteObservedAt?: string;
  readonly priceAsOf?: MarketSnapshotPriceAsOf;
  readonly sourceIds: readonly string[];
  readonly usable: boolean;
}

export type PeerImpliedRangePosition = "below-range" | "within-range" | "above-range";

export type PeerImpliedRangeSuppressedReason =
  | "peer supportability is not supported"
  | "fewer than 3 usable peers"
  | "annualized revenue is not positive"
  | "net debt is unavailable"
  | "net debt uses mixed reporting periods"
  | "shares outstanding is not positive"
  | "quote currency is not USD"
  | "peer percentile inputs are unavailable"
  | "one or more implied prices are not positive"
  | "current price is unavailable";

export const SUPPRESSION_CAUSE = {
  // Never read: this reason collapses three supportability states, so it resolves
  // Through SUPPORTABILITY_SUPPRESSION_CAUSE instead. Kept for satisfies exhaustiveness.
  "peer supportability is not supported": "suppressed-by-design",
  // Guard order makes this unreachable from collectValuationComps, but the exported derivation can emit it.
  "fewer than 3 usable peers": "provider-data-missing",
  "annualized revenue is not positive": "provider-data-missing",
  "net debt is unavailable": "provider-data-missing",
  "net debt uses mixed reporting periods": "validation-failed",
  "shares outstanding is not positive": "provider-data-missing",
  "quote currency is not USD": "unsupported-coverage",
  "peer percentile inputs are unavailable": "provider-data-missing",
  "one or more implied prices are not positive": "validation-failed",
  "current price is unavailable": "provider-data-missing",
} satisfies Record<PeerImpliedRangeSuppressedReason, SourceGapCause>;

export const SUPPORTABILITY_SUPPRESSION_CAUSE = {
  "screening-only": "provider-data-missing",
  supported: "validation-failed",
  "not-supportable": "provider-data-missing",
  "not-meaningful": "suppressed-by-design",
} satisfies Record<ValuationSupportability, SourceGapCause>;

export type ValuationGateProfile = "curated-no-sic" | "full" | "revenue-exempt";

export interface PeerImpliedRangeInputs {
  readonly peerP25EvToAnnualizedRevenue: number | null;
  readonly peerMedianEvToAnnualizedRevenue: number | null;
  readonly peerP75EvToAnnualizedRevenue: number | null;
  readonly annualizedRevenue: number | null;
  readonly netDebt: number | typeof MIXED_PERIOD_METRIC | null;
  readonly sharesOutstanding: number | null;
  readonly currentPrice: number | null;
  readonly quoteCurrency: string | null;
  readonly quoteObservedAt: string | null;
}

export interface PeerImpliedRangeDerivedInputs extends PeerImpliedRangeInputs {
  readonly peerP25EvToAnnualizedRevenue: number;
  readonly peerMedianEvToAnnualizedRevenue: number;
  readonly peerP75EvToAnnualizedRevenue: number;
  readonly annualizedRevenue: number;
  readonly netDebt: number;
  readonly sharesOutstanding: number;
  readonly currentPrice: number;
  readonly quoteCurrency: "USD";
}

interface PeerImpliedRangeBase<TInputs extends PeerImpliedRangeInputs> {
  readonly label: "peer-implied price reference range";
  readonly basis: "peer EV/annualized revenue percentiles applied to target annualized revenue";
  readonly formula: "impliedPrice(m) = (m × annualizedRevenue − netDebt) / sharesOutstanding";
  readonly inputs: TInputs;
}

export type PeerImpliedRange =
  | (PeerImpliedRangeBase<PeerImpliedRangeDerivedInputs> & {
      readonly status: "derived";
      readonly low: number;
      readonly mid: number;
      readonly high: number;
      readonly position: PeerImpliedRangePosition;
    })
  | (PeerImpliedRangeBase<PeerImpliedRangeInputs> & {
      readonly status: "suppressed";
      readonly suppressedReason: PeerImpliedRangeSuppressedReason;
    });

export interface ExcludedValuationPeer {
  readonly symbol: string;
  readonly role: PeerUniversePeer["role"];
  readonly reason: string;
  readonly sourceIds: readonly string[];
}

export interface ValuationCompsArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly target: ValuationCompsRow;
  readonly peers: readonly ValuationCompsRow[];
  readonly excludedPeers: readonly ExcludedValuationPeer[];
  readonly provenance?: PeerUniverse["provenance"];
  readonly peerUniverseSourceIds: readonly string[];
  readonly summary: {
    readonly corePeerCount: number;
    readonly secondaryPeerCount: number;
    readonly usablePeerCount: number;
    readonly targetEvToAnnualizedRevenue?: number;
    readonly peerMedianEvToAnnualizedRevenue?: number;
    readonly peerP25EvToAnnualizedRevenue?: number;
    readonly peerP75EvToAnnualizedRevenue?: number;
    readonly valuationSupportability: ValuationSupportability;
    readonly gateProfile?: ValuationGateProfile;
  };
  readonly impliedPriceRange?: PeerImpliedRange;
  readonly sourceIds: readonly string[];
  readonly freshnessFlags: {
    readonly targetQuoteFresh: boolean;
    readonly targetSecFresh: boolean;
    readonly peerQuoteFresh: boolean;
    readonly peerSecFresh: boolean;
  };
}

export interface ValuationCompsResult {
  readonly extendedEvidence: ExtendedEvidence;
  readonly artifact: ValuationCompsArtifact;
  readonly sources: readonly Source[];
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly gaps: readonly SourceGap[];
}

export interface ValuationCompsOptions {
  readonly peerUniverseMappings?: PeerUniverseMapping;
  readonly subjectRegistry?: readonly ResearchSubjectRegistryEntry[];
  readonly peerUniverseFallback?: PeerUniverseFallbackContext;
  readonly secTickerPayload?: unknown;
}

export interface PeerPacket {
  readonly peer: PeerUniversePeer;
  readonly provenance: PeerUniverse["provenance"];
  readonly quote: MarketSnapshot | undefined;
  readonly sec: Awaited<ReturnType<typeof fetchSecCompanyFactsForSymbol>>;
}
