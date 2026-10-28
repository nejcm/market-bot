import { isInstrumentCommand, type InstrumentCommand, type ResearchCommand } from "../../cli/args";
import type { ExtendedEvidence, ExtendedEvidenceItem } from "../../domain/evidence";
import {
  marketCapAsOfPhrase,
  resolveMarketSnapshotPriceAsOf,
  type MarketSnapshot,
  type MarketSnapshotPriceAsOf,
} from "../../domain/market-data";
import type { SourceGap } from "../../domain/sources";
import { sourceGap } from "../../domain/source-gaps";
import { clampRoundedZero, formatRatioPercent } from "./percent-format";
import { scaleCurrency } from "./value-format";
import { depositoryIssuerSic, depositoryNetDebtReason } from "./industry-classification";
import { readNumberMetric, readStringMetric } from "./utils";
import { DEBT_MAY_INCLUDE_FINANCE_LEASES } from "./sec-fundamentals-format";
import {
  bridgeIncompleteReasons,
  copyBridgeMetrics,
  CURRENT_EQUITY_NOTE,
  isCurrentEquityConcept,
  ENTERPRISE_VALUE_BASIS,
  enterpriseValueFromMetrics,
  netDebtFromMetrics,
} from "./enterprise-value-bridge";
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

function percent(value: number | undefined): string {
  return value === undefined ? "n/a" : formatRatioPercent(value);
}

// Balance-sheet guards run after classification and may re-add EV/net-debt markers or replace the summary.
function depositoryValuationItem(
  item: ExtendedEvidenceItem,
  rawSummary: string,
  sic: string,
): ExtendedEvidenceItem {
  const {
    enterpriseValue: _enterpriseValue,
    netDebt: _netDebt,
    evToAnnualizedRevenue: _evToAnnualizedRevenue,
    netDebtToMarketCap: _netDebtToMarketCap,
    ...metrics
  } = item.metrics ?? {};
  return {
    ...item,
    summary:
      item.summary === rawSummary
        ? item.summary
        : `Valuation Evidence: enterprise value and net debt not applicable (${depositoryNetDebtReason(sic)}); debt/market cap ${metrics.debtToMarketCap === undefined ? "withheld (see the balance-sheet source gap)" : "retained"}. Raw market cap, cash, ${metrics.debt === undefined ? "" : "debt, "}and revenue metrics are retained.`,
    metrics,
  };
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
  return `$${scaleCurrency(value)}`;
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
  const withheldDebtPeriodEnd = readStringMetric(secItem?.metrics, "debtIncompletePeriodEnd");
  const missing = [
    ...(marketCap === undefined ? ["marketCap"] : []),
    ...REQUIRED_SEC_METRICS.filter(
      (metric) =>
        readNumberMetric(secItem?.metrics, metric) === undefined &&
        !(metric === "debt" && withheldDebtPeriodEnd !== undefined),
    ),
  ];

  if (
    snapshot === undefined ||
    secItem === undefined ||
    marketCap === undefined ||
    revenue === undefined ||
    cash === undefined ||
    (debt === undefined && withheldDebtPeriodEnd === undefined)
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

  const revenuePeriodMonths = readNumberMetric(secItem.metrics, "revenuePeriodMonths");
  const revenuePeriodEnd = readStringMetric(secItem.metrics, "revenuePeriodEnd");
  const cashPeriodEnd = readStringMetric(secItem.metrics, "cashPeriodEnd");
  const debtPeriodEnd = readStringMetric(secItem.metrics, "debtPeriodEnd");
  const debtLeaseScopeText =
    readStringMetric(secItem.metrics, "debtLeaseScope") === DEBT_MAY_INCLUDE_FINANCE_LEASES
      ? "enterprise value uses an SEC debt aggregate that may include finance leases"
      : "enterprise value is borrowing-based and excludes finance leases";
  const currentEquityText = isCurrentEquityConcept(
    readStringMetric(secItem.metrics, "shortTermInvestmentsConcept"),
  )
    ? `; ${CURRENT_EQUITY_NOTE}`
    : "";
  const quoteObservedAt = snapshot.observedAt;
  const priceAsOf = resolveMarketSnapshotPriceAsOf(snapshot);
  const sic = readStringMetric(secItem.metrics, "sic");
  const sicDescription = readStringMetric(secItem.metrics, "sicDescription");
  // Peers carry the same TTM basis; a partial period is never annualized into a multiple.
  const annualizedRevenue = readNumberMetric(secItem.metrics, "revenueTtm");
  // This item is the source the peer comps and the reverse DCF read enterprise value from, so
  // Withholding it here is what stops an EV escaping into the prose, the peer table, the peer
  // Reference range and the DCF grid. See industry-classification.ts for why EV has no defensible
  // Definition for a deposit-funded issuer.
  const depositorySic = depositoryIssuerSic(extendedEvidence);
  const netDebtWithheld = bridgeIncompleteReasons(secItem.metrics, ["shortTermInvestments"]);
  const enterpriseValueWithheld = bridgeIncompleteReasons(secItem.metrics);
  const enterpriseValue =
    depositorySic === undefined
      ? enterpriseValueFromMetrics(marketCap, secItem.metrics)
      : undefined;
  const evToAnnualizedRevenue =
    enterpriseValue === undefined || annualizedRevenue === undefined
      ? undefined
      : ratio(enterpriseValue, annualizedRevenue);
  const marketCapToAnnualizedRevenue =
    annualizedRevenue === undefined ? undefined : ratio(marketCap, annualizedRevenue);
  const debtCurrent = isCurrentBalanceSheetPeriod(secItem.metrics, debtPeriodEnd, analysisAsOf);
  const cashCurrent = isCurrentBalanceSheetPeriod(secItem.metrics, cashPeriodEnd, analysisAsOf);
  const debtToMarketCap = debtCurrent && debt !== undefined ? ratio(debt, marketCap) : undefined;
  const netDebt = depositorySic === undefined ? netDebtFromMetrics(secItem.metrics) : undefined;
  const netDebtToMarketCap =
    debtCurrent && cashCurrent && netDebt !== undefined ? ratio(netDebt, marketCap) : undefined;
  const staleBalances = [
    ...(debtCurrent || debt === undefined ? [] : [["debt", debtPeriodEnd] as const]),
    ...(cashCurrent ? [] : [["cash", cashPeriodEnd] as const]),
  ];
  const latestRevenuePeriod = `latest ${revenuePeriodMonths === undefined ? "" : `${String(revenuePeriodMonths)}-month `}revenue ${formatUsd(revenue)}${revenuePeriodEnd === undefined ? "" : ` through ${revenuePeriodEnd}`}`;
  const revenueText =
    annualizedRevenue === undefined
      ? `${latestRevenuePeriod} does not reconcile to TTM revenue, revenue multiples withheld`
      : `TTM revenue ${formatUsd(annualizedRevenue)}${revenuePeriodEnd === undefined ? "" : ` through ${revenuePeriodEnd}`}`;
  const bridgeWithheld = depositorySic === undefined && enterpriseValueWithheld.length > 0;
  const enterpriseValueText =
    debt === undefined
      ? `enterprise value withheld (debt incomplete as of ${withheldDebtPeriodEnd ?? "an undated period"})`
      : depositorySic !== undefined
        ? `enterprise value not applicable (depository issuer, SIC ${depositorySic}: deposits and borrowings fund operations rather than sitting on top of them)`
        : enterpriseValue === undefined
          ? `enterprise value withheld (${enterpriseValueWithheld.join("; ")})`
          : `enterprise value ${formatUsd(enterpriseValue)}`;
  const evToRevenueText =
    debt === undefined || bridgeWithheld
      ? "EV/TTM revenue withheld"
      : enterpriseValue === undefined
        ? "EV/TTM revenue not applicable"
        : `EV/TTM revenue ${fixed(evToAnnualizedRevenue)}`;
  const rawItem: ExtendedEvidenceItem = {
    category: "valuation",
    title: `${command.symbol} Valuation Evidence`,
    summary: `Valuation Evidence: market cap ${formatUsd(marketCap)}, ${enterpriseValueText}, ${revenueText}, ${evToRevenueText}, market cap/TTM revenue ${fixed(marketCapToAnnualizedRevenue)}, debt/market cap ${percent(debtToMarketCap)}, ${depositorySic === undefined ? `net debt/market cap ${percent(netDebtToMarketCap)}` : `net debt not applicable (${depositoryNetDebtReason(depositorySic)})`}; ${valuationDateBasis(priceAsOf, cashPeriodEnd, debtPeriodEnd)}; ${debtLeaseScopeText}${currentEquityText}; EV bridge: ${ENTERPRISE_VALUE_BASIS}.`,
    sourceIds: [snapshot.sourceId, ...secItem.sourceIds],
    observedAt: snapshot.observedAt > secItem.observedAt ? snapshot.observedAt : secItem.observedAt,
    metrics: {
      marketCap,
      cash,
      ...copyBridgeMetrics(secItem.metrics),
      ...(debt === undefined ? {} : { debt }),
      ...(netDebt === undefined ? {} : { netDebt }),
      ...(enterpriseValue === undefined ? {} : { enterpriseValue }),
      latestPeriodRevenue: revenue,
      ...(annualizedRevenue !== undefined ? { annualizedRevenue } : {}),
      quoteObservedAt,
      ...(snapshot.quoteTimeUtc !== undefined ? { quoteTimeUtc: snapshot.quoteTimeUtc } : {}),
      ...(revenuePeriodMonths !== undefined ? { revenuePeriodMonths } : {}),
      ...(revenuePeriodEnd !== undefined ? { revenuePeriodEnd } : {}),
      ...(cashPeriodEnd !== undefined ? { cashPeriodEnd } : {}),
      ...(debtPeriodEnd !== undefined ? { debtPeriodEnd } : {}),
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
  const item =
    depositorySic === undefined
      ? incompleteDebt.item
      : depositoryValuationItem(incompleteDebt.item, rawItem.summary, depositorySic);
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
    ...(divergence === undefined || depositorySic !== undefined
      ? []
      : [mixedPeriodValuationGap(command.symbol, divergence)]),
    ...incompleteDebt.gaps,
    ...(debt === undefined || depositorySic !== undefined || enterpriseValueWithheld.length === 0
      ? []
      : [
          sourceGap({
            source: "valuation",
            message: `SEC EV bridge incomplete for ${command.symbol} at cash period end ${cashPeriodEnd ?? "undated"}: ${enterpriseValueWithheld.join("; ")}; enterprise value${netDebtWithheld.length > 0 ? ", net debt" : ""} and dependent multiples withheld`,
            symbol: command.symbol.toUpperCase(),
            provider: "market-bot",
            capability: "extended-evidence",
            cause: "provider-data-missing",
            evidenceQualityImpact: "no-cap",
          }),
        ]),
    ...(annualizedRevenue === undefined
      ? [
          sourceGap({
            source: "valuation",
            message: `TTM revenue unavailable for ${command.symbol}: ${latestRevenuePeriod} has no reconciling fiscal-year and prior-year SEC facts; revenue multiples withheld`,
            symbol: command.symbol.toUpperCase(),
            provider: "market-bot",
            capability: "extended-evidence",
            cause: "provider-data-missing",
            evidenceQualityImpact: "no-cap",
          }),
        ]
      : []),
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
