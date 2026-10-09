import { isInstrumentCommand, type InstrumentCommand, type ResearchCommand } from "../../cli/args";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  MarketSnapshot,
  MarketSnapshotPriceAsOf,
  SourceGap,
} from "../../domain/types";
import { marketCapAsOfPhrase, resolveMarketSnapshotPriceAsOf } from "../../domain/types";
import { sourceGap } from "../../domain/source-gaps";
import { clampRoundedZero } from "./percent-format";
import { depositoryIssuerSic } from "./industry-classification";
import { readNumberMetric, readStringMetric } from "./utils";
import { DEBT_MAY_INCLUDE_FINANCE_LEASES } from "./sec-edgar";
import {
  balanceSheetPeriodDivergence,
  guardIncompleteDebtValuationItem,
  guardMixedPeriodValuationItem,
  isCurrentBalanceSheetPeriod,
  mixedPeriodValuationGap,
} from "./valuation-comps-support";
import { SEC_FRESHNESS_DAYS } from "../../config/shared";
import { MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS } from "./valuation-comps-contract";

interface ValuationEvidenceResult {
  readonly extendedEvidence?: ExtendedEvidence;
  readonly sourceGaps: readonly SourceGap[];
}

const REQUIRED_SEC_METRICS = ["revenue", "cash", "debt"] as const;

function tickerSnapshot(
  command: InstrumentCommand,
  marketSnapshots: readonly MarketSnapshot[],
): MarketSnapshot | undefined {
  const symbol = command.symbol.toUpperCase();
  return marketSnapshots.find(
    (snapshot) =>
      snapshot.assetClass === command.assetClass && snapshot.symbol.toUpperCase() === symbol,
  );
}

function valuationGap(command: InstrumentCommand, missing: readonly string[]): SourceGap {
  return sourceGap({
    source: "valuation",
    message: `Valuation Evidence unavailable for ${command.symbol}: missing ${missing.join(", ")}`,
    provider: "market-bot",
    capability: "extended-evidence",
    cause: "provider-data-missing",
    evidenceQualityImpact: "no-cap",
  });
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator > 0 ? numerator / denominator : undefined;
}

function fixed(value: number | undefined): string {
  return value === undefined ? "n/a" : `${clampRoundedZero(value, 2).toFixed(2)}x`;
}

function nonCurrentBalanceSheetGap(
  symbol: string,
  analysisAsOf: string,
  stale: readonly (readonly [string, string | undefined])[],
  withheld: readonly string[],
): SourceGap {
  const periods = stale
    .map(([label, periodEnd]) => `${label} period end ${periodEnd ?? "undated"}`)
    .join(", ");
  return sourceGap({
    source: "valuation",
    message: `Non-current SEC balance-sheet inputs for ${symbol}: ${periods} not within ${String(SEC_FRESHNESS_DAYS)} days before analysis cutoff ${analysisAsOf.slice(0, 10)} and ${String(MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS)} days of the newest balance-sheet period end; ${withheld.join(" and ")} withheld`,
    symbol: symbol.toUpperCase(),
    provider: "market-bot",
    capability: "extended-evidence",
    cause: "provider-data-missing",
    evidenceQualityImpact: "no-cap",
  });
}

function valuationDateBasis(
  priceAsOf: MarketSnapshotPriceAsOf,
  cashPeriodEnd: string | undefined,
  debtPeriodEnd: string | undefined,
): string {
  const marketCapAsOf = marketCapAsOfPhrase(priceAsOf);
  if (cashPeriodEnd !== undefined && cashPeriodEnd === debtPeriodEnd) {
    return `${marketCapAsOf}; cash/debt as of ${cashPeriodEnd}`;
  }
  return [
    marketCapAsOf,
    ...(cashPeriodEnd !== undefined ? [`cash as of ${cashPeriodEnd}`] : []),
    ...(debtPeriodEnd !== undefined ? [`debt as of ${debtPeriodEnd}`] : []),
  ].join("; ");
}

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (abs >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toFixed(0)}`;
}

function hasRequiredSecMetrics(
  metrics: Readonly<Record<string, number | string>> | undefined,
): boolean {
  return REQUIRED_SEC_METRICS.every((metric) => readNumberMetric(metrics, metric) !== undefined);
}

export function addValuationEvidence(
  command: ResearchCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedEvidence: ExtendedEvidence | undefined,
  analysisAsOf: string,
): ValuationEvidenceResult {
  if (!isInstrumentCommand(command) || command.assetClass !== "equity") {
    return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
  }

  const snapshot = tickerSnapshot(command, marketSnapshots);
  // Prefer a sec-edgar item that actually carries fundamentals; multiple sec-edgar
  // Items can coexist (e.g. a filing-excerpt item alongside the fundamentals item),
  // So picking the first unconditionally could miss the metrics-bearing one.
  const secItems = extendedEvidence?.items.filter((item) => item.category === "sec-edgar") ?? [];
  const secItem = secItems.find((item) => hasRequiredSecMetrics(item.metrics)) ?? secItems[0];
  const marketCap = snapshot?.marketCap;
  const revenue = readNumberMetric(secItem?.metrics, "revenue");
  const cash = readNumberMetric(secItem?.metrics, "cash");
  const debt = readNumberMetric(secItem?.metrics, "debt");
  const missing = [
    ...(marketCap === undefined ? ["marketCap"] : []),
    ...REQUIRED_SEC_METRICS.filter(
      (metric) => readNumberMetric(secItem?.metrics, metric) === undefined,
    ),
  ];

  if (
    snapshot === undefined ||
    secItem === undefined ||
    marketCap === undefined ||
    revenue === undefined ||
    cash === undefined ||
    debt === undefined
  ) {
    const gaps = [valuationGap(command, missing.length > 0 ? missing : ["SEC fundamentals"])];
    const mergedEvidence: ExtendedEvidence = {
      instrument: extendedEvidence?.instrument ?? {
        symbol: command.symbol,
        assetClass: command.assetClass,
      },
      items: extendedEvidence?.items ?? [],
      gaps: [...(extendedEvidence?.gaps ?? []), ...gaps],
    };
    return { extendedEvidence: mergedEvidence, sourceGaps: gaps };
  }

  // Annualize the latest reported revenue by its actual period length, not a blanket
  // X4: SEC fundamentals report the latest filed fact regardless of duration, so the
  // Value can be a full-year 10-K, a year-to-date 10-Q, or a single quarter. Without
  // A known period we treat it as already annual rather than risk ~4x inflation.
  const revenuePeriodMonths = readNumberMetric(secItem.metrics, "revenuePeriodMonths");
  const revenuePeriodEnd = readStringMetric(secItem.metrics, "revenuePeriodEnd");
  const cashPeriodEnd = readStringMetric(secItem.metrics, "cashPeriodEnd");
  const debtPeriodEnd = readStringMetric(secItem.metrics, "debtPeriodEnd");
  const grossPrincipalDebt = readStringMetric(secItem.metrics, "debtBasis") === "gross-principal";
  const debtLeaseScopeText =
    readStringMetric(secItem.metrics, "debtLeaseScope") === DEBT_MAY_INCLUDE_FINANCE_LEASES
      ? "enterprise value uses an SEC debt aggregate that may include finance leases"
      : "enterprise value is borrowing-based and excludes finance leases";
  const quoteObservedAt = snapshot.observedAt;
  const priceAsOf = resolveMarketSnapshotPriceAsOf(snapshot);
  const sic = readStringMetric(secItem.metrics, "sic");
  const sicDescription = readStringMetric(secItem.metrics, "sicDescription");
  const annualizationFactor =
    revenuePeriodMonths !== undefined && revenuePeriodMonths > 0 ? 12 / revenuePeriodMonths : 1;
  const annualizedRevenue = revenue * annualizationFactor;
  // This item is the source the peer comps and the reverse DCF read enterprise value from, so
  // Withholding it here is what stops an EV escaping into the prose, the peer table, the peer
  // Reference range and the DCF grid. See industry-classification.ts for why EV has no defensible
  // Definition for a deposit-funded issuer.
  const depositorySic = depositoryIssuerSic(extendedEvidence);
  const enterpriseValue = depositorySic === undefined ? marketCap + debt - cash : undefined;
  const evToAnnualizedRevenue =
    enterpriseValue === undefined ? undefined : ratio(enterpriseValue, annualizedRevenue);
  const marketCapToAnnualizedRevenue = ratio(marketCap, annualizedRevenue);
  const debtCurrent = isCurrentBalanceSheetPeriod(secItem.metrics, debtPeriodEnd, analysisAsOf);
  const cashCurrent = isCurrentBalanceSheetPeriod(secItem.metrics, cashPeriodEnd, analysisAsOf);
  const debtToMarketCap = debtCurrent ? ratio(debt, marketCap) : undefined;
  const netDebt = debt - cash;
  const netDebtToMarketCap = debtCurrent && cashCurrent ? ratio(netDebt, marketCap) : undefined;
  const staleBalances = [
    ...(debtCurrent ? [] : [["debt", debtPeriodEnd] as const]),
    ...(cashCurrent ? [] : [["cash", cashPeriodEnd] as const]),
  ];
  const revenuePeriodLabel =
    revenuePeriodMonths !== undefined
      ? `${revenuePeriodMonths}-month revenue ${formatUsd(revenue)}, `
      : "";
  const enterpriseValueText =
    enterpriseValue === undefined
      ? `enterprise value not applicable (depository issuer, SIC ${depositorySic ?? "unknown"}: deposits and borrowings fund operations rather than sitting on top of them)`
      : `enterprise value ${formatUsd(enterpriseValue)}`;
  const evToRevenueText =
    enterpriseValue === undefined
      ? "EV/annualized revenue not applicable"
      : `EV/annualized revenue ${fixed(evToAnnualizedRevenue)}`;
  const rawItem: ExtendedEvidenceItem = {
    category: "valuation",
    title: `${command.symbol} Valuation Evidence`,
    summary: `Valuation Evidence: market cap ${formatUsd(marketCap)}, ${enterpriseValueText}, ${revenuePeriodLabel}annualized revenue ${formatUsd(annualizedRevenue)}, ${evToRevenueText}, market cap/annualized revenue ${fixed(marketCapToAnnualizedRevenue)}, debt/market cap ${fixed(debtToMarketCap)}, net debt/market cap ${fixed(netDebtToMarketCap)}; ${valuationDateBasis(priceAsOf, cashPeriodEnd, debtPeriodEnd)}${grossPrincipalDebt ? "; debt is gross principal" : ""}; ${debtLeaseScopeText}.`,
    sourceIds: [snapshot.sourceId, ...secItem.sourceIds],
    observedAt: snapshot.observedAt > secItem.observedAt ? snapshot.observedAt : secItem.observedAt,
    metrics: {
      marketCap,
      cash,
      debt,
      netDebt,
      ...(enterpriseValue === undefined ? {} : { enterpriseValue }),
      latestPeriodRevenue: revenue,
      annualizedRevenue,
      quoteObservedAt,
      ...(snapshot.quoteTimeUtc !== undefined ? { quoteTimeUtc: snapshot.quoteTimeUtc } : {}),
      ...(revenuePeriodMonths !== undefined ? { revenuePeriodMonths } : {}),
      ...(revenuePeriodEnd !== undefined ? { revenuePeriodEnd } : {}),
      ...(cashPeriodEnd !== undefined ? { cashPeriodEnd } : {}),
      ...(debtPeriodEnd !== undefined ? { debtPeriodEnd } : {}),
      ...(grossPrincipalDebt ? { debtBasis: "gross-principal" } : {}),
      ...(sic !== undefined ? { sic } : {}),
      ...(sicDescription !== undefined ? { sicDescription } : {}),
      ...(evToAnnualizedRevenue !== undefined ? { evToAnnualizedRevenue } : {}),
      ...(marketCapToAnnualizedRevenue !== undefined ? { marketCapToAnnualizedRevenue } : {}),
      ...(debtToMarketCap !== undefined ? { debtToMarketCap } : {}),
      ...(netDebtToMarketCap !== undefined ? { netDebtToMarketCap } : {}),
    },
    ...(secItem.identity !== undefined ? { identity: secItem.identity } : {}),
  };
  const divergence = balanceSheetPeriodDivergence(rawItem.metrics);
  const incompleteDebt = guardIncompleteDebtValuationItem(
    guardMixedPeriodValuationItem(rawItem, divergence),
    command.symbol,
    secItem.metrics,
  );
  const { item } = incompleteDebt;
  const sourceGaps = [
    ...(staleBalances.length === 0
      ? []
      : [
          nonCurrentBalanceSheetGap(
            command.symbol,
            analysisAsOf,
            staleBalances,
            debtCurrent ? ["net debt/market cap"] : ["debt/market cap", "net debt/market cap"],
          ),
        ]),
    ...(divergence === undefined ? [] : [mixedPeriodValuationGap(command.symbol, divergence)]),
    ...incompleteDebt.gaps,
  ];

  return {
    extendedEvidence: {
      instrument: extendedEvidence?.instrument ?? {
        symbol: command.symbol,
        assetClass: command.assetClass,
      },
      items: [...(extendedEvidence?.items ?? []), item],
      gaps: [...(extendedEvidence?.gaps ?? []), ...sourceGaps],
    },
    sourceGaps,
  };
}
