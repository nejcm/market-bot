import type { InstrumentCommand } from "../../cli/args";
import { DAY_MS, SEC_FRESHNESS_DAYS } from "../../config/shared";
import { sourceGap, sourceGapWithContext } from "../../domain/source-gaps";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  MarketSnapshot,
  Source,
  SourceGap,
} from "../../domain/types";
import {
  resolvePeerUniverseWithFallback,
  type PeerUniverse,
  type PeerUniverseFallbackContext,
  type PeerUniverseMapping,
  type PeerUniversePeer,
} from "../../research/peer-universe";
import type { ResearchSubjectRegistryEntry } from "../../research/subject-registry";
import { isFetchJsonResult, type CollectContext, type RawSourceSnapshot } from "../types";
import {
  normalizeYahooQuotePayload,
  requestJsonWithQuoteFallback,
  yahooQuoteSourceRequest,
} from "../yahoo";
import { evidenceSource } from "./common";
import { fetchSecCompanyFactsForSymbol } from "./sec-edgar";

const MIN_USABLE_PEERS = 3;
const MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS = 92;
export const MIXED_PERIOD_METRIC = "mixed-period" as const;

// Deterministic peer-comparability size gate: a peer qualifies for the primary
// Aggregate only when its market cap and annualized revenue are inclusively
// Within 0.2x-5x of the target's.
const SIZE_GATE_MIN_RATIO = 0.2;
const SIZE_GATE_MAX_RATIO = 5;

// Revenue-multiple applicability gate: above 50x, current revenue is too
// De-minimis relative to enterprise value for EV/revenue to be a meaningful
// Target valuation basis.
const MAX_MEANINGFUL_EV_TO_ANNUALIZED_REVENUE = 50;

// Revenue-multiple applicability fallback: below 2% of market cap, current
// Revenue is de-minimis even when EV/revenue is unavailable.
const MIN_MEANINGFUL_ANNUALIZED_REVENUE_TO_MARKET_CAP = 0.02;

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
  | "one or more implied prices are not positive"
  | "current price is unavailable";

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
}

interface PeerCollection {
  readonly peer: PeerUniversePeer;
  readonly provenance: PeerUniverse["provenance"];
  readonly quote: MarketSnapshot | undefined;
  readonly sec: Awaited<ReturnType<typeof fetchSecCompanyFactsForSymbol>>;
}

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
      sec: await fetchSecCompanyFactsForSymbol(ctx, peer.symbol),
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

function readNumberMetric(
  metrics: Readonly<Record<string, number | string>> | undefined,
  key: string,
): number | undefined {
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringMetric(
  metrics: Readonly<Record<string, number | string>> | undefined,
  key: string,
): string | undefined {
  const value = metrics?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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

function targetRow(
  symbol: string,
  item: ExtendedEvidenceItem,
  snapshot: MarketSnapshot | undefined,
  generatedAt: string,
): ValuationCompsRow {
  const marketCap = readNumberMetric(item.metrics, "marketCap");
  const cash = readNumberMetric(item.metrics, "cash");
  const debt = readNumberMetric(item.metrics, "debt");
  const revenue = readNumberMetric(item.metrics, "latestPeriodRevenue");
  const annualizedRevenue = readNumberMetric(item.metrics, "annualizedRevenue");
  const enterpriseValue = readNumberMetric(item.metrics, "enterpriseValue");
  const evToAnnualizedRevenue = readNumberMetric(item.metrics, "evToAnnualizedRevenue");
  const netDebt = readNumberMetric(item.metrics, "netDebt");
  const cashPeriodEnd = readStringMetric(item.metrics, "cashPeriodEnd");
  const debtPeriodEnd = readStringMetric(item.metrics, "debtPeriodEnd");
  const mixedPeriod =
    item.metrics?.enterpriseValue === MIXED_PERIOD_METRIC ||
    item.metrics?.netDebt === MIXED_PERIOD_METRIC;
  const guardedNetDebt = mixedPeriod ? MIXED_PERIOD_METRIC : netDebt;
  const guardedEnterpriseValue = mixedPeriod ? MIXED_PERIOD_METRIC : enterpriseValue;
  const revenuePeriodMonths = readNumberMetric(item.metrics, "revenuePeriodMonths");
  const revenuePeriodEnd = readStringMetric(item.metrics, "revenuePeriodEnd");
  const sic = readStringMetric(item.metrics, "sic");
  const sicDescription = readStringMetric(item.metrics, "sicDescription");
  const usable =
    isFreshDate(snapshot?.observedAt, generatedAt) &&
    marketCap !== undefined &&
    cash !== undefined &&
    debt !== undefined &&
    revenue !== undefined &&
    annualizedRevenue !== undefined &&
    enterpriseValue !== undefined &&
    evToAnnualizedRevenue !== undefined &&
    revenuePeriodEnd !== undefined &&
    isFreshPeriodEnd(revenuePeriodEnd, generatedAt);
  return {
    symbol: symbol.toUpperCase(),
    ...(sic !== undefined ? { sic } : {}),
    ...(sicDescription !== undefined ? { sicDescription } : {}),
    ...(marketCap !== undefined ? { marketCap } : {}),
    ...(cash !== undefined ? { cash } : {}),
    ...(debt !== undefined ? { debt } : {}),
    ...(cashPeriodEnd !== undefined ? { cashPeriodEnd } : {}),
    ...(debtPeriodEnd !== undefined ? { debtPeriodEnd } : {}),
    ...(guardedNetDebt !== undefined ? { netDebt: guardedNetDebt } : {}),
    ...(guardedEnterpriseValue !== undefined ? { enterpriseValue: guardedEnterpriseValue } : {}),
    ...(revenue !== undefined ? { latestPeriodRevenue: revenue } : {}),
    ...(revenuePeriodMonths !== undefined ? { revenuePeriodMonths } : {}),
    ...(revenuePeriodEnd !== undefined ? { revenuePeriodEnd } : {}),
    ...(annualizedRevenue !== undefined ? { annualizedRevenue } : {}),
    ...(evToAnnualizedRevenue !== undefined ? { evToAnnualizedRevenue } : {}),
    ...(snapshot?.fundamentals?.sharesOutstanding !== undefined
      ? { sharesOutstanding: snapshot.fundamentals.sharesOutstanding }
      : {}),
    ...(snapshot?.price !== undefined ? { currentPrice: snapshot.price } : {}),
    ...(snapshot?.identity?.quoteCurrency !== undefined
      ? { quoteCurrency: snapshot.identity.quoteCurrency }
      : {}),
    ...(snapshot?.observedAt !== undefined ? { quoteObservedAt: snapshot.observedAt } : {}),
    sourceIds: item.sourceIds,
    usable,
  };
}

// Two-digit SIC group of a normalized four-digit SIC code; the comparability
// Gate matches at group granularity (e.g. 3674 and 3672 both map to "36").
function sicGroup(sic: string): string {
  return sic.slice(0, 2);
}

function withinSizeGate(peerValue: number, targetValue: number): boolean {
  return (
    targetValue > 0 &&
    peerValue >= SIZE_GATE_MIN_RATIO * targetValue &&
    peerValue <= SIZE_GATE_MAX_RATIO * targetValue
  );
}

type ComparabilityInputs = Pick<ValuationCompsRow, "sic" | "marketCap" | "annualizedRevenue">;

const SIZE_GATE_LABEL = `${SIZE_GATE_MIN_RATIO}x-${SIZE_GATE_MAX_RATIO}x`;

// Which comparability gates apply to a candidate. The checked-in ticker-mapping
// Tier skips the SIC-group gate; the revenue-exempt profile instead keeps SIC
// And market-cap checks while skipping only the revenue-size band.
export type ValuationGateProfile = "curated-no-sic" | "full" | "revenue-exempt";

function revenueMultipleMeaningful(
  target: Pick<ValuationCompsRow, "annualizedRevenue" | "evToAnnualizedRevenue" | "marketCap">,
): boolean {
  const revenueDeMinimis =
    target.annualizedRevenue !== undefined &&
    (target.annualizedRevenue <= 0 ||
      (target.marketCap !== undefined &&
        target.marketCap > 0 &&
        target.annualizedRevenue <
          MIN_MEANINGFUL_ANNUALIZED_REVENUE_TO_MARKET_CAP * target.marketCap));
  return (
    !revenueDeMinimis &&
    (target.evToAnnualizedRevenue === undefined ||
      target.evToAnnualizedRevenue <= MAX_MEANINGFUL_EV_TO_ANNUALIZED_REVENUE)
  );
}

function gateProfileFor(
  provenance: PeerUniverse["provenance"],
  target: Pick<ValuationCompsRow, "annualizedRevenue" | "evToAnnualizedRevenue" | "marketCap">,
): ValuationGateProfile {
  if (!revenueMultipleMeaningful(target)) {
    return "revenue-exempt";
  }
  return provenance === "ticker-mapping" ? "curated-no-sic" : "full";
}

function comparabilityGateFailure(
  gateProfile: ValuationGateProfile,
  gate: "market-cap" | "SIC",
  reason: string,
): string {
  return gateProfile === "revenue-exempt"
    ? `${gate} gate (revenue-exempt profile): ${reason}`
    : reason;
}

// Deterministic comparability gate. The SIC-group gate is skipped only for the
// Curated-no-sic profile; the revenue-size band is skipped only for the
// Revenue-exempt profile. Returns the first failed-gate reason, or undefined
// When the candidate is comparable to the target. Business-model metadata
// (role/rationale) never overrides a failure.
function comparabilityFailure(
  row: ComparabilityInputs,
  target: ComparabilityInputs,
  gateProfile: ValuationGateProfile,
): string | undefined {
  if (gateProfile !== "curated-no-sic") {
    if (row.sic === undefined) {
      return comparabilityGateFailure(gateProfile, "SIC", "missing SIC classification");
    }
    if (target.sic === undefined) {
      return comparabilityGateFailure(gateProfile, "SIC", "target SIC classification unavailable");
    }
    if (sicGroup(row.sic) !== sicGroup(target.sic)) {
      return comparabilityGateFailure(
        gateProfile,
        "SIC",
        `SIC group mismatch (peer ${sicGroup(row.sic)} vs target ${sicGroup(target.sic)})`,
      );
    }
  }
  if (row.marketCap === undefined) {
    return comparabilityGateFailure(gateProfile, "market-cap", "missing market cap");
  }
  if (target.marketCap === undefined) {
    return comparabilityGateFailure(gateProfile, "market-cap", "target market cap unavailable");
  }
  if (target.marketCap <= 0) {
    return comparabilityGateFailure(gateProfile, "market-cap", "target market cap not positive");
  }
  if (!withinSizeGate(row.marketCap, target.marketCap)) {
    return comparabilityGateFailure(
      gateProfile,
      "market-cap",
      `market cap outside ${SIZE_GATE_LABEL} of target`,
    );
  }
  if (gateProfile === "revenue-exempt") {
    return undefined;
  }
  if (row.annualizedRevenue === undefined) {
    return "missing annualized revenue";
  }
  if (target.annualizedRevenue === undefined) {
    return "target annualized revenue unavailable";
  }
  if (target.annualizedRevenue <= 0) {
    return "target annualized revenue not positive";
  }
  if (!withinSizeGate(row.annualizedRevenue, target.annualizedRevenue)) {
    return `annualized revenue outside ${SIZE_GATE_LABEL} of target`;
  }
  return undefined;
}

function peerRow(
  entry: PeerCollection,
  generatedAt: string,
  target: ValuationCompsRow,
): ValuationCompsRow {
  const { peer, quote, sec } = entry;
  const { metrics } = sec;
  const marketCap = quote?.marketCap;
  const cash = readNumberMetric(metrics, "cash");
  const debt = readNumberMetric(metrics, "debt");
  const revenue = readNumberMetric(metrics, "revenue");
  const revenuePeriodMonths = readNumberMetric(metrics, "revenuePeriodMonths");
  const revenuePeriodEnd = readStringMetric(metrics, "revenuePeriodEnd");
  const annualizedRevenue =
    revenue !== undefined
      ? revenue *
        (revenuePeriodMonths !== undefined && revenuePeriodMonths > 0
          ? 12 / revenuePeriodMonths
          : 1)
      : undefined;
  const enterpriseValue =
    marketCap !== undefined && cash !== undefined && debt !== undefined
      ? marketCap + debt - cash
      : undefined;
  const evToAnnualizedRevenue =
    enterpriseValue !== undefined && annualizedRevenue !== undefined && annualizedRevenue > 0
      ? enterpriseValue / annualizedRevenue
      : undefined;
  // SIC provenance is the SEC submissions endpoint, not company facts, so a
  // Row carrying a SIC must reference the submissions source as well.
  const sourceIds = unique([
    ...(quote?.sourceId !== undefined ? [quote.sourceId] : []),
    ...(sec.sourceId !== undefined ? [sec.sourceId] : []),
    ...(sec.sicClassification !== undefined && sec.submissionsSourceId !== undefined
      ? [sec.submissionsSourceId]
      : []),
  ]);
  const inputsUsable =
    isFreshDate(quote?.observedAt, generatedAt) &&
    marketCap !== undefined &&
    cash !== undefined &&
    debt !== undefined &&
    revenue !== undefined &&
    revenuePeriodEnd !== undefined &&
    isFreshPeriodEnd(revenuePeriodEnd, generatedAt) &&
    evToAnnualizedRevenue !== undefined &&
    Number.isFinite(evToAnnualizedRevenue);
  const row: Omit<ValuationCompsRow, "usable"> = {
    symbol: peer.symbol,
    ...(peer.name !== undefined ? { name: peer.name } : {}),
    role: peer.role,
    rationale: peer.rationale,
    ...(sec.sicClassification !== undefined ? { sic: sec.sicClassification.sic } : {}),
    ...(sec.sicClassification?.sicDescription !== undefined
      ? { sicDescription: sec.sicClassification.sicDescription }
      : {}),
    ...(marketCap !== undefined ? { marketCap } : {}),
    ...(cash !== undefined ? { cash } : {}),
    ...(debt !== undefined ? { debt } : {}),
    ...(cash !== undefined && debt !== undefined ? { netDebt: debt - cash } : {}),
    ...(enterpriseValue !== undefined ? { enterpriseValue } : {}),
    ...(revenue !== undefined ? { latestPeriodRevenue: revenue } : {}),
    ...(revenuePeriodMonths !== undefined ? { revenuePeriodMonths } : {}),
    ...(revenuePeriodEnd !== undefined ? { revenuePeriodEnd } : {}),
    ...(annualizedRevenue !== undefined ? { annualizedRevenue } : {}),
    ...(evToAnnualizedRevenue !== undefined ? { evToAnnualizedRevenue } : {}),
    ...(quote?.observedAt !== undefined ? { quoteObservedAt: quote.observedAt } : {}),
    sourceIds,
  };
  return {
    ...row,
    usable:
      inputsUsable &&
      comparabilityFailure(row, target, gateProfileFor(entry.provenance, target)) === undefined,
  };
}

function excludedPeer(
  row: ValuationCompsRow,
  peers: readonly PeerUniversePeer[],
  provenance: PeerUniverse["provenance"],
  generatedAt: string,
  target: ValuationCompsRow,
): readonly ExcludedValuationPeer[] {
  if (row.usable) {
    return [];
  }
  const peer = peers.find((entry) => entry.symbol === row.symbol);
  if (peer === undefined) {
    return [];
  }
  return [
    {
      symbol: row.symbol,
      role: peer.role,
      reason: exclusionReason(row, provenance, generatedAt, target),
      sourceIds: row.sourceIds,
    },
  ];
}

function exclusionReason(
  row: ValuationCompsRow,
  provenance: PeerUniverse["provenance"],
  generatedAt: string,
  target: ValuationCompsRow,
): string {
  if (row.quoteObservedAt === undefined) {
    return "missing quote";
  }
  if (row.marketCap === undefined) {
    return "missing market cap";
  }
  if (row.latestPeriodRevenue === undefined) {
    return "missing SEC revenue";
  }
  if (row.cash === undefined) {
    return "missing SEC cash";
  }
  if (row.debt === undefined) {
    return "missing SEC debt";
  }
  if (row.revenuePeriodEnd === undefined) {
    return "missing SEC revenue period end";
  }
  if (row.evToAnnualizedRevenue === undefined) {
    return "missing EV/revenue multiple";
  }
  if (!isFreshDate(row.quoteObservedAt, generatedAt)) {
    return "stale quote";
  }
  if (!isFreshPeriodEnd(row.revenuePeriodEnd, generatedAt)) {
    return "stale SEC revenue period";
  }
  return comparabilityFailure(row, target, gateProfileFor(provenance, target)) ?? "not usable";
}

function buildArtifact(
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
    return suppressed("one or more implied prices are not positive");
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

function enrichValuationItem(
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

function replaceValuationItem(
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

function sourcesForPeer(command: InstrumentCommand, entry: PeerCollection): readonly Source[] {
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

function isFreshDate(observedAt: string | undefined, generatedAt: string): boolean {
  return observedAt !== undefined && observedAt.slice(0, 10) === generatedAt.slice(0, 10);
}

function isFreshPeriodEnd(periodEnd: string, generatedAt: string): boolean {
  const periodMs = Date.parse(periodEnd);
  const generatedMs = Date.parse(generatedAt);
  if (!Number.isFinite(periodMs) || !Number.isFinite(generatedMs)) {
    return false;
  }
  const ageMs = generatedMs - periodMs;
  return ageMs >= 0 && ageMs <= SEC_FRESHNESS_DAYS * DAY_MS;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * weight;
}

function valuationCompsGap(
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

function peerImpliedRangeSuppressionGaps(artifact: ValuationCompsArtifact): readonly SourceGap[] {
  const range = artifact.impliedPriceRange;
  if (range?.status !== "suppressed") {
    return [];
  }
  return [
    valuationCompsGap(
      `Peer-implied price reference range suppressed for ${artifact.target.symbol}: ${range.suppressedReason}`,
      "provider-data-missing",
      "valuation",
      artifact.target.symbol,
    ),
  ];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
