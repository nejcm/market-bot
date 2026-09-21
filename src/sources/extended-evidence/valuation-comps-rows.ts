import {
  resolveMarketSnapshotPriceAsOf,
  type ExtendedEvidenceItem,
  type MarketSnapshot,
} from "../../domain/types";
import type { PeerUniverse, PeerUniversePeer } from "../../research/peer-universe";
import {
  MAX_MEANINGFUL_EV_TO_ANNUALIZED_REVENUE,
  MIN_MEANINGFUL_ANNUALIZED_REVENUE_TO_MARKET_CAP,
  MIXED_PERIOD_METRIC,
  SIZE_GATE_MAX_RATIO,
  SIZE_GATE_MIN_RATIO,
  type ExcludedValuationPeer,
  type PeerPacket,
  type ValuationCompsRow,
  type ValuationGateProfile,
} from "./valuation-comps-contract";

import { readNumberMetric, readStringMetric } from "./utils";
import { FINANCIAL_STATEMENT_SERIES_DEFINITIONS } from "./financial-statement-definitions";
import { incompleteCompositeNote, isCompleteComposite } from "./financial-statement-selection";
import type { SecDebtComposite } from "./sec-edgar";
import {
  balanceSheetPeriodDivergence,
  isFreshDate,
  isFreshPeriodEnd,
  mixedPeriodMetrics,
  unique,
} from "./valuation-comps-support";

export function targetRow(
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
    ...(snapshot !== undefined ? { priceAsOf: resolveMarketSnapshotPriceAsOf(snapshot) } : {}),
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

export function revenueMultipleMeaningful(
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

export function gateProfileFor(
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

export function peerRow(
  entry: PeerPacket,
  generatedAt: string,
  target: ValuationCompsRow,
): ValuationCompsRow {
  const { peer, quote, sec } = entry;
  const { metrics } = sec;
  const marketCap = quote?.marketCap;
  const cash = readNumberMetric(metrics, "cash");
  const debt = readNumberMetric(metrics, "debt");
  const cashPeriodEnd = readStringMetric(metrics, "cashPeriodEnd");
  const debtPeriodEnd = readStringMetric(metrics, "debtPeriodEnd");
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
  const computedEnterpriseValue =
    marketCap !== undefined && cash !== undefined && debt !== undefined
      ? marketCap + debt - cash
      : undefined;
  const computedNetDebt = cash !== undefined && debt !== undefined ? debt - cash : undefined;
  const computedEvToAnnualizedRevenue =
    computedEnterpriseValue !== undefined &&
    annualizedRevenue !== undefined &&
    annualizedRevenue > 0
      ? computedEnterpriseValue / annualizedRevenue
      : undefined;
  const periodDivergence = balanceSheetPeriodDivergence(metrics);
  const unverifiableVintage =
    cashPeriodEnd === undefined ||
    debtPeriodEnd === undefined ||
    !isExactCalendarPeriodEnd(cashPeriodEnd) ||
    !isExactCalendarPeriodEnd(debtPeriodEnd) ||
    !isFreshPeriodEnd(cashPeriodEnd, generatedAt) ||
    !isFreshPeriodEnd(debtPeriodEnd, generatedAt);
  const guardedMetrics =
    periodDivergence === undefined
      ? undefined
      : mixedPeriodMetrics(
          {
            ...(computedEnterpriseValue !== undefined
              ? { enterpriseValue: computedEnterpriseValue }
              : {}),
            ...(computedNetDebt !== undefined ? { netDebt: computedNetDebt } : {}),
            ...(computedEvToAnnualizedRevenue !== undefined
              ? { evToAnnualizedRevenue: computedEvToAnnualizedRevenue }
              : {}),
            ...(cashPeriodEnd !== undefined ? { cashPeriodEnd } : {}),
            ...(debtPeriodEnd !== undefined ? { debtPeriodEnd } : {}),
          },
          periodDivergence,
        );
  const mixedPeriod =
    guardedMetrics?.enterpriseValue === MIXED_PERIOD_METRIC ||
    guardedMetrics?.netDebt === MIXED_PERIOD_METRIC;
  const incompleteDebtBasis = isIncompleteDebtComposite(sec.debtComposite);
  let enterpriseValue: number | typeof MIXED_PERIOD_METRIC | undefined = computedEnterpriseValue;
  let netDebt: number | typeof MIXED_PERIOD_METRIC | undefined = computedNetDebt;
  let evToAnnualizedRevenue = computedEvToAnnualizedRevenue;
  if (mixedPeriod) {
    enterpriseValue = MIXED_PERIOD_METRIC;
    netDebt = MIXED_PERIOD_METRIC;
    evToAnnualizedRevenue = undefined;
  } else if (unverifiableVintage || incompleteDebtBasis) {
    enterpriseValue = undefined;
    evToAnnualizedRevenue = undefined;
  }
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
    Number.isFinite(evToAnnualizedRevenue) &&
    !unverifiableVintage &&
    !mixedPeriod &&
    !incompleteDebtBasis;
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
    ...(cashPeriodEnd !== undefined ? { cashPeriodEnd } : {}),
    ...(debtPeriodEnd !== undefined ? { debtPeriodEnd } : {}),
    ...(netDebt !== undefined ? { netDebt } : {}),
    ...(enterpriseValue !== undefined ? { enterpriseValue } : {}),
    ...(revenue !== undefined ? { latestPeriodRevenue: revenue } : {}),
    ...(revenuePeriodMonths !== undefined ? { revenuePeriodMonths } : {}),
    ...(revenuePeriodEnd !== undefined ? { revenuePeriodEnd } : {}),
    ...(annualizedRevenue !== undefined ? { annualizedRevenue } : {}),
    ...(evToAnnualizedRevenue !== undefined ? { evToAnnualizedRevenue } : {}),
    ...(quote?.observedAt !== undefined ? { quoteObservedAt: quote.observedAt } : {}),
    ...(quote !== undefined ? { priceAsOf: resolveMarketSnapshotPriceAsOf(quote) } : {}),
    sourceIds,
  };
  return {
    ...row,
    usable:
      inputsUsable &&
      comparabilityFailure(row, target, gateProfileFor(entry.provenance, target)) === undefined,
  };
}

export function excludedPeer(
  row: ValuationCompsRow,
  peers: readonly PeerUniversePeer[],
  provenance: PeerUniverse["provenance"],
  generatedAt: string,
  target: ValuationCompsRow,
  debtComposite?: SecDebtComposite,
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
      reason: exclusionReason(row, provenance, generatedAt, target, debtComposite),
      sourceIds: row.sourceIds,
    },
  ];
}

function exclusionReason(
  row: ValuationCompsRow,
  provenance: PeerUniverse["provenance"],
  generatedAt: string,
  target: ValuationCompsRow,
  debtComposite?: SecDebtComposite,
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
  const vintageReason = peerVintageExclusionReason(row, generatedAt);
  if (vintageReason !== undefined) {
    return vintageReason;
  }
  const incompleteReason = incompleteDebtBasisReason(debtComposite);
  if (incompleteReason !== undefined) {
    return incompleteReason;
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

const SEC_PERIOD_END_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function isExactCalendarPeriodEnd(periodEnd: string): boolean {
  if (SEC_PERIOD_END_PATTERN.exec(periodEnd) === null) {
    return false;
  }
  const ms = Date.parse(periodEnd);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === periodEnd;
}

function periodEndReasonLabel(periodEnd: string | undefined): string {
  if (periodEnd === undefined) {
    return "missing";
  }
  if (!isExactCalendarPeriodEnd(periodEnd)) {
    return `${periodEnd} unparseable`;
  }
  return periodEnd;
}

function peerVintageExclusionReason(
  row: ValuationCompsRow,
  generatedAt: string,
): string | undefined {
  const { cashPeriodEnd, debtPeriodEnd } = row;
  if (
    cashPeriodEnd === undefined ||
    debtPeriodEnd === undefined ||
    !isExactCalendarPeriodEnd(cashPeriodEnd) ||
    !isExactCalendarPeriodEnd(debtPeriodEnd)
  ) {
    return `SEC cash/debt period ends unavailable (cash ${periodEndReasonLabel(cashPeriodEnd)}; debt ${periodEndReasonLabel(debtPeriodEnd)})`;
  }
  const divergence = balanceSheetPeriodDivergence({
    cashPeriodEnd,
    debtPeriodEnd,
  });
  if (divergence !== undefined) {
    return `cash period end ${divergence.cashPeriodEnd} and debt period end ${divergence.debtPeriodEnd} diverge by ${String(divergence.divergenceDays)} days; enterprise value flagged as mixed-period`;
  }
  if (
    !isFreshPeriodEnd(cashPeriodEnd, generatedAt) ||
    !isFreshPeriodEnd(debtPeriodEnd, generatedAt)
  ) {
    return `SEC cash/debt period ends stale (cash ${cashPeriodEnd}; debt ${debtPeriodEnd})`;
  }
  return undefined;
}

function isIncompleteDebtComposite(
  composite: SecDebtComposite | undefined,
): composite is SecDebtComposite {
  return (
    composite !== undefined &&
    !isCompleteComposite(composite.componentCount, composite.componentSlotCount)
  );
}

function incompleteDebtBasisReason(composite: SecDebtComposite | undefined): string | undefined {
  if (!isIncompleteDebtComposite(composite)) {
    return undefined;
  }
  const definition = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find((item) => item.key === "debt");
  const { periodEnd, selectedConcepts } = composite;
  if (definition === undefined || periodEnd === undefined) {
    return "incomplete SEC debt basis";
  }
  const note = incompleteCompositeNote(definition, "us-gaap", periodEnd, selectedConcepts);
  return note === undefined
    ? "incomplete SEC debt basis"
    : `incomplete SEC debt basis: ${note.message}`;
}
