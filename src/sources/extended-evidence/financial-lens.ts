import { isInstrumentCommand, type InstrumentCommand, type ResearchCommand } from "../../cli/args";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  MarketSnapshot,
  SourceGap,
  VerifiedMarketSnapshot,
} from "../../domain/types";
import { sourceGap } from "../../domain/source-gaps";
import { verifiedSnapshotSourceId } from "../../research/verified-snapshot-contract";
import { MIXED_PERIOD_METRIC, REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT } from "./valuation-comps";
import {
  formatLensValue,
  formatPeRatio,
  PE_NOT_MEANINGFUL,
  type LensValueUnit,
} from "./value-format";

export type FinancialLensName = "Quality" | "Growth" | "Financial Strength" | "Value" | "Momentum";

export type FinancialLensPosture =
  | "criteria-supported"
  | "criteria-mixed"
  | "criteria-not-supported"
  | "insufficient-data";

export interface FinancialLensMetric {
  readonly key: string;
  readonly label: string;
  readonly value: number | string;
  // "ratio-percent": value is a ratio (0.42 → 42%). "whole-percent": value already in percent (12 → 12%).
  // "currency": monetary value in `currency` (defaults to USD); GBp is a Yahoo pence pseudo-code.
  readonly unit: LensValueUnit;
  readonly sourceIds: readonly string[];
  readonly currency?: string;
  readonly periodEnd?: string;
  readonly periodMonths?: number;
}

export interface FinancialLens {
  readonly name: FinancialLensName;
  readonly posture: FinancialLensPosture;
  readonly metrics: readonly FinancialLensMetric[];
  readonly sourceIds: readonly string[];
}

export interface FinancialLensArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly symbol: string;
  readonly lenses: readonly FinancialLens[];
  readonly sourceIds: readonly string[];
}

interface FinancialLensResult {
  readonly extendedEvidence?: ExtendedEvidence;
  readonly artifact?: FinancialLensArtifact;
  readonly sourceGaps: readonly SourceGap[];
}

const SEC_KEYS = [
  "revenue",
  "grossProfit",
  "operatingIncome",
  "netIncome",
  "operatingCashFlow",
  "capex",
  "cash",
  "debt",
  "currentAssets",
  "currentLiabilities",
] as const;

function readMetric(
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
  return typeof value === "string" ? value : undefined;
}

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

function itemByCategory(
  extendedEvidence: ExtendedEvidence | undefined,
  category: ExtendedEvidenceItem["category"],
): ExtendedEvidenceItem | undefined {
  return extendedEvidence?.items.find((item) => item.category === category);
}

function secFundamentalItem(
  extendedEvidence: ExtendedEvidence | undefined,
): ExtendedEvidenceItem | undefined {
  const items = extendedEvidence?.items.filter((item) => item.category === "sec-edgar") ?? [];
  return items.find((item) => SEC_KEYS.some((key) => readMetric(item.metrics, key) !== undefined));
}

function ratio(numerator: number | undefined, denominator: number | undefined): number | undefined {
  return numerator !== undefined && denominator !== undefined && denominator !== 0
    ? numerator / denominator
    : undefined;
}

// Annualizes a flow-fact value by its own reporting-period length (months),
// Matching valuation.ts revenue annualization. Undefined period -> already
// Annual (factor 1); period > 0 -> 12/period. Used for ROE/ROA/PCF so a 9-month
// 10-Q netIncome is scaled to a year before dividing by an instant balance, and
// Crucially uses netIncome's own periodMonths, not revenue's. See plan revision 2.
function annualize(
  value: number | undefined,
  periodMonths: number | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const factor = periodMonths !== undefined && periodMonths > 0 ? 12 / periodMonths : 1;
  return value * factor;
}

function positive(value: number | undefined): boolean | undefined {
  return value === undefined ? undefined : value > 0;
}

function atOrBelow(value: number | undefined, threshold: number): boolean | undefined {
  return value === undefined ? undefined : value <= threshold;
}

function postureFrom(
  values: readonly (boolean | undefined)[],
  requiredCount = 1,
): FinancialLensPosture {
  const known = values.filter((value): value is boolean => value !== undefined);
  if (known.length < requiredCount || known.length === 0) {
    return "insufficient-data";
  }
  const supported = known.filter(Boolean).length;
  if (supported === known.length) {
    return "criteria-supported";
  }
  if (supported === 0) {
    return "criteria-not-supported";
  }
  return "criteria-mixed";
}

function metric(
  key: string,
  label: string,
  value: number | string | undefined,
  unit: FinancialLensMetric["unit"],
  sourceIds: readonly string[],
  metadata: Pick<FinancialLensMetric, "currency" | "periodEnd" | "periodMonths"> = {},
): readonly FinancialLensMetric[] {
  return value === undefined ? [] : [{ key, label, value, unit, sourceIds, ...metadata }];
}

function secPeriod(
  item: ExtendedEvidenceItem | undefined,
  key: string,
): Pick<FinancialLensMetric, "periodEnd" | "periodMonths"> {
  const periodEnd = readStringMetric(item?.metrics, `${key}PeriodEnd`);
  const periodMonths = readMetric(item?.metrics, `${key}PeriodMonths`);
  return {
    ...(periodEnd !== undefined ? { periodEnd } : {}),
    ...(periodMonths !== undefined ? { periodMonths } : {}),
  };
}

function observedPeriod(observedAt: string | undefined): Pick<FinancialLensMetric, "periodEnd"> {
  return observedAt === undefined ? {} : { periodEnd: observedAt };
}

function percentChange(value: number | undefined): boolean | undefined {
  return value === undefined ? undefined : value > 0;
}

function qualityLens(secItem: ExtendedEvidenceItem | undefined): FinancialLens {
  const sourceIds = secItem?.sourceIds ?? [];
  const revenue = readMetric(secItem?.metrics, "revenue");
  const grossProfit = readMetric(secItem?.metrics, "grossProfit");
  const operatingIncome = readMetric(secItem?.metrics, "operatingIncome");
  const netIncome = readMetric(secItem?.metrics, "netIncome");
  const consolidatedNetIncome = readMetric(secItem?.metrics, "consolidatedNetIncome");
  const netIncomePeriodMonths = readMetric(secItem?.metrics, "netIncomePeriodMonths");
  const operatingCashFlow = readMetric(secItem?.metrics, "operatingCashFlow");
  const capex = readMetric(secItem?.metrics, "capex");
  const stockholdersEquity = readMetric(secItem?.metrics, "stockholdersEquity");
  const assets = readMetric(secItem?.metrics, "assets");
  const freeCashFlowProxy =
    operatingCashFlow === undefined || capex === undefined ? undefined : operatingCashFlow - capex;
  // ROE/ROA are industry-relative (display-only): no universal threshold, no posture.
  // Annualized by net income's own periodMonths so a partial-year filing does not
  // Understate the return. See plan revision 2 / Q6.
  const annualizedNetIncome = annualize(netIncome, netIncomePeriodMonths);
  const hasDistinctConsolidatedNetIncome =
    netIncome !== undefined &&
    consolidatedNetIncome !== undefined &&
    consolidatedNetIncome !== netIncome;
  const metrics = [
    ...metric(
      "grossMargin",
      "Gross margin",
      ratio(grossProfit, revenue),
      "ratio-percent",
      sourceIds,
      secPeriod(secItem, "revenue"),
    ),
    ...metric(
      "operatingMargin",
      "Operating margin",
      ratio(operatingIncome, revenue),
      "ratio-percent",
      sourceIds,
      secPeriod(secItem, "revenue"),
    ),
    ...metric(
      "netMargin",
      "Net margin",
      ratio(netIncome, revenue),
      "ratio-percent",
      sourceIds,
      secPeriod(secItem, "revenue"),
    ),
    ...metric(
      "freeCashFlowProxy",
      "FCF proxy",
      freeCashFlowProxy,
      "currency",
      sourceIds,
      secPeriod(secItem, "operatingCashFlow"),
    ),
    ...metric(
      "cashConversion",
      "Cash conversion",
      ratio(operatingCashFlow, netIncome),
      "ratio",
      sourceIds,
      secPeriod(secItem, "operatingCashFlow"),
    ),
    ...metric(
      "roe",
      "ROE",
      ratio(annualizedNetIncome, stockholdersEquity),
      "ratio-percent",
      sourceIds,
      secPeriod(secItem, "netIncome"),
    ),
    ...metric(
      "roa",
      "ROA",
      ratio(annualizedNetIncome, assets),
      "ratio-percent",
      sourceIds,
      secPeriod(secItem, "netIncome"),
    ),
    ...(hasDistinctConsolidatedNetIncome
      ? metric(
          "consolidatedNetIncome",
          "Net income (consolidated incl. NCI)",
          consolidatedNetIncome,
          "currency",
          sourceIds,
          secPeriod(secItem, "consolidatedNetIncome"),
        )
      : []),
  ];
  return {
    name: "Quality",
    posture: postureFrom([
      positive(ratio(grossProfit, revenue)),
      positive(ratio(operatingIncome, revenue)),
      positive(ratio(netIncome, revenue)),
      positive(freeCashFlowProxy),
    ]),
    metrics,
    sourceIds,
  };
}

function growthLens(secItem: ExtendedEvidenceItem | undefined): FinancialLens {
  const sourceIds = secItem?.sourceIds ?? [];
  const netIncomePrior = readMetric(secItem?.metrics, "netIncomePrior");
  const metrics = [
    ...metric(
      "revenueDeltaPercent",
      "Revenue YoY",
      readMetric(secItem?.metrics, "revenueDeltaPercent"),
      "whole-percent",
      sourceIds,
      secPeriod(secItem, "revenue"),
    ),
    ...metric(
      "grossProfitDeltaPercent",
      "Gross profit YoY",
      readMetric(secItem?.metrics, "grossProfitDeltaPercent"),
      "whole-percent",
      sourceIds,
      secPeriod(secItem, "grossProfit"),
    ),
    ...metric(
      "operatingIncomeDeltaPercent",
      "Operating income YoY",
      readMetric(secItem?.metrics, "operatingIncomeDeltaPercent"),
      "whole-percent",
      sourceIds,
      secPeriod(secItem, "operatingIncome"),
    ),
    ...metric(
      "netIncomeDeltaPercent",
      netIncomePrior !== undefined && netIncomePrior < 0
        ? "Net loss (attrib.) YoY change"
        : "Net income (attrib.) YoY",
      readMetric(secItem?.metrics, "netIncomeDeltaPercent"),
      "whole-percent",
      sourceIds,
      secPeriod(secItem, "netIncome"),
    ),
    ...metric(
      "dilutedEpsDeltaPercent",
      "Diluted EPS YoY",
      readMetric(secItem?.metrics, "dilutedEpsDeltaPercent"),
      "whole-percent",
      sourceIds,
      secPeriod(secItem, "dilutedEps"),
    ),
    ...metric(
      "operatingCashFlowDeltaPercent",
      "Operating cash flow YoY",
      readMetric(secItem?.metrics, "operatingCashFlowDeltaPercent"),
      "whole-percent",
      sourceIds,
      secPeriod(secItem, "operatingCashFlow"),
    ),
  ];
  return {
    name: "Growth",
    posture: postureFrom(
      [
        percentChange(readMetric(secItem?.metrics, "revenueDeltaPercent")),
        percentChange(readMetric(secItem?.metrics, "grossProfitDeltaPercent")),
        percentChange(readMetric(secItem?.metrics, "operatingIncomeDeltaPercent")),
        percentChange(readMetric(secItem?.metrics, "netIncomeDeltaPercent")),
        percentChange(readMetric(secItem?.metrics, "dilutedEpsDeltaPercent")),
        percentChange(readMetric(secItem?.metrics, "operatingCashFlowDeltaPercent")),
      ],
      2,
    ),
    metrics,
    sourceIds,
  };
}

function strengthLens(
  secItem: ExtendedEvidenceItem | undefined,
  valuationItem: ExtendedEvidenceItem | undefined,
  yahooFundamentalsItem: ExtendedEvidenceItem | undefined,
): FinancialLens {
  const sourceIds = [
    ...new Set([
      ...(secItem?.sourceIds ?? []),
      ...(valuationItem?.sourceIds ?? []),
      ...(yahooFundamentalsItem?.sourceIds ?? []),
    ]),
  ];
  const cash = readMetric(secItem?.metrics, "cash");
  const debt = readMetric(secItem?.metrics, "debt");
  const currentAssets = readMetric(secItem?.metrics, "currentAssets");
  const currentLiabilities = readMetric(secItem?.metrics, "currentLiabilities");
  const stockholdersEquity = readMetric(secItem?.metrics, "stockholdersEquity");
  const netIncome = readMetric(secItem?.metrics, "netIncome");
  const dividendsPaid = readMetric(secItem?.metrics, "dividendsPaid");
  const fallbackNetDebt = debt === undefined || cash === undefined ? undefined : debt - cash;
  const netDebt =
    valuationItem?.metrics?.netDebt === MIXED_PERIOD_METRIC
      ? undefined
      : (readMetric(valuationItem?.metrics, "netDebt") ?? fallbackNetDebt);
  const debtToMarketCap = readMetric(valuationItem?.metrics, "debtToMarketCap");
  const netDebtToMarketCap = readMetric(valuationItem?.metrics, "netDebtToMarketCap");
  const currentRatio = ratio(currentAssets, currentLiabilities);
  // Debt-to-equity is industry-relative (display-only): no universal threshold.
  const debtToEquity = ratio(debt, stockholdersEquity);
  // Dividend Payout: SEC-preferred (abs(dividendsPaid)/netIncome) contributes the
  // Forbes <= 0.8 posture criterion; the Yahoo fallback (trailingAnnualDividendRate
  // / epsTtm) is display-only so a non-US listing with no SEC data does not flip
  // Financial Strength out of insufficient-data on one Yahoo-sourced criterion.
  // See plan revisions 3 / Q4. dividendsPaid is negative in XBRL (cash outflow);
  // The lens uses abs() to handle both signs. See plan risk "Dividend Payout sign".
  const secPayout =
    dividendsPaid !== undefined && netIncome !== undefined
      ? ratio(Math.abs(dividendsPaid), netIncome)
      : undefined;
  const yahooDividendRate = readMetric(
    yahooFundamentalsItem?.metrics,
    "trailingAnnualDividendRate",
  );
  const yahooEpsTtm = readMetric(yahooFundamentalsItem?.metrics, "epsTrailingTwelveMonths");
  const yahooPayout = ratio(yahooDividendRate, yahooEpsTtm);
  const payoutFromSec = secPayout !== undefined;
  const payoutRatio = payoutFromSec ? secPayout : yahooPayout;
  const payoutSourceIds = payoutFromSec
    ? (secItem?.sourceIds ?? [])
    : (yahooFundamentalsItem?.sourceIds ?? []);
  // Dividend yield is whole-percent (verified against captured RR.L/AAPL fixtures).
  const dividendYield = readMetric(yahooFundamentalsItem?.metrics, "dividendYield");
  const metrics = [
    ...metric(
      "cash",
      "Cash",
      cash,
      "currency",
      secItem?.sourceIds ?? [],
      secPeriod(secItem, "cash"),
    ),
    ...metric(
      "debt",
      "Debt",
      debt,
      "currency",
      secItem?.sourceIds ?? [],
      secPeriod(secItem, "debt"),
    ),
    ...metric("netDebt", "Net debt", netDebt, "currency", sourceIds, secPeriod(secItem, "debt")),
    ...metric(
      "debtToMarketCap",
      "Debt/market cap",
      debtToMarketCap,
      "ratio-percent",
      sourceIds,
      secPeriod(secItem, "debt"),
    ),
    ...metric(
      "netDebtToMarketCap",
      "Net debt/market cap",
      netDebtToMarketCap,
      "ratio-percent",
      sourceIds,
      secPeriod(secItem, "debt"),
    ),
    ...metric(
      "currentRatio",
      "Current ratio",
      currentRatio,
      "ratio",
      secItem?.sourceIds ?? [],
      secPeriod(secItem, "currentAssets"),
    ),
    ...metric(
      "debtToEquity",
      "Debt/equity",
      debtToEquity,
      "ratio",
      secItem?.sourceIds ?? [],
      secPeriod(secItem, "debt"),
    ),
    ...metric(
      "payoutRatio",
      "Payout ratio",
      payoutRatio,
      "ratio-percent",
      payoutSourceIds,
      payoutFromSec
        ? secPeriod(secItem, "dividendsPaid")
        : observedPeriod(yahooFundamentalsItem?.observedAt),
    ),
    ...metric(
      "dividendYield",
      "Dividend yield",
      dividendYield,
      "whole-percent",
      yahooFundamentalsItem?.sourceIds ?? [],
      observedPeriod(yahooFundamentalsItem?.observedAt),
    ),
  ];
  return {
    name: "Financial Strength",
    posture: postureFrom([
      cash === undefined || debt === undefined ? undefined : cash >= debt,
      netDebtToMarketCap === undefined ? undefined : netDebtToMarketCap <= 0.25,
      debtToMarketCap === undefined ? undefined : debtToMarketCap <= 0.5,
      currentRatio === undefined ? undefined : currentRatio >= 1,
      // SEC-derived payout only: <= 0.8 supports (Forbes "below 80%"). Yahoo-fallback
      // Payout is display-only and contributes no criterion (revision 3).
      payoutFromSec ? atOrBelow(payoutRatio, 0.8) : undefined,
    ]),
    metrics,
    sourceIds,
  };
}

function valueLens(
  valuationItem: ExtendedEvidenceItem | undefined,
  secItem: ExtendedEvidenceItem | undefined,
  yahooFundamentalsItem: ExtendedEvidenceItem | undefined,
  snapshot: MarketSnapshot | undefined,
): FinancialLens {
  const sourceIds = [
    ...new Set([...(valuationItem?.sourceIds ?? []), ...(yahooFundamentalsItem?.sourceIds ?? [])]),
  ];
  const supportability = valuationItem?.metrics?.valuationSupportability;
  const supportabilityCriterion =
    supportability === undefined || supportability === "not-meaningful"
      ? undefined
      : supportability === "supported";
  const yahooSourceIds = yahooFundamentalsItem?.sourceIds ?? [];
  const revenuePeriodMonths = readMetric(valuationItem?.metrics, "revenuePeriodMonths");
  const trailingPe = readMetric(yahooFundamentalsItem?.metrics, "trailingPE");
  const forwardPe = readMetric(yahooFundamentalsItem?.metrics, "forwardPE");
  const epsTrailingTwelveMonths = readMetric(
    yahooFundamentalsItem?.metrics,
    "epsTrailingTwelveMonths",
  );
  const epsForward = readMetric(yahooFundamentalsItem?.metrics, "epsForward");
  const trailingPeSuppressed =
    trailingPe !== undefined &&
    formatPeRatio(trailingPe, epsTrailingTwelveMonths) === PE_NOT_MEANINGFUL;
  const forwardPeSuppressed =
    forwardPe !== undefined && formatPeRatio(forwardPe, epsForward) === PE_NOT_MEANINGFUL;
  const valuationRevenuePeriod: Pick<FinancialLensMetric, "periodEnd" | "periodMonths"> = {
    ...observedPeriod(readStringMetric(valuationItem?.metrics, "revenuePeriodEnd")),
    ...(revenuePeriodMonths !== undefined ? { periodMonths: revenuePeriodMonths } : {}),
  };
  // PCF = marketCap / annualized operating cash flow. marketCap comes from the
  // Ticker snapshot (market data) or, failing that, the valuation item; the cash
  // Flow comes from SEC, annualized by its own periodMonths. Display-only
  // (industry-relative). Provenance is derived from the actual inputs: SEC (for the
  // Cash flow) plus the source that supplied marketCap — not the valuation item's
  // IDs unconditionally, which would be empty when PCF computes without a valuation
  // Item (US listing with SEC cash flow but no valuation comps).
  const marketCap = snapshot?.marketCap ?? readMetric(valuationItem?.metrics, "marketCap");
  const operatingCashFlow = readMetric(secItem?.metrics, "operatingCashFlow");
  const operatingCashFlowPeriodMonths = readMetric(
    secItem?.metrics,
    "operatingCashFlowPeriodMonths",
  );
  const pcfRatio = ratio(marketCap, annualize(operatingCashFlow, operatingCashFlowPeriodMonths));
  const marketCapSourceIds =
    snapshot?.marketCap !== undefined ? [snapshot.sourceId] : (valuationItem?.sourceIds ?? []);
  const pcfSourceIds = [...new Set([...(secItem?.sourceIds ?? []), ...marketCapSourceIds])];
  // New Value metrics are appended AFTER the existing EV metrics so summarizeLens's
  // First-4 slice keeps EV/revenue in the summary text (plan revision 6).
  return {
    name: "Value",
    // Research-only: posture reports peer supportability, not a cheap/expensive judgement.
    // PE/Forward PE/PBV/PCF are display-only (industry-relative, no threshold).
    posture: postureFrom([supportabilityCriterion]),
    metrics: [
      ...(supportability === "not-meaningful"
        ? metric(
            "valuationCaveat",
            "Valuation caveat",
            REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
            "text",
            valuationItem?.sourceIds ?? [],
            valuationRevenuePeriod,
          )
        : []),
      ...metric(
        "enterpriseValue",
        "Enterprise value",
        readMetric(valuationItem?.metrics, "enterpriseValue"),
        "currency",
        valuationItem?.sourceIds ?? [],
        observedPeriod(snapshot?.observedAt),
      ),
      ...metric(
        "annualizedRevenue",
        "Annualized revenue",
        readMetric(valuationItem?.metrics, "annualizedRevenue"),
        "currency",
        valuationItem?.sourceIds ?? [],
        valuationRevenuePeriod,
      ),
      ...metric(
        "evToAnnualizedRevenue",
        "EV/revenue",
        readMetric(valuationItem?.metrics, "evToAnnualizedRevenue"),
        "ratio",
        valuationItem?.sourceIds ?? [],
        valuationRevenuePeriod,
      ),
      ...metric(
        "marketCapToAnnualizedRevenue",
        "Market cap/revenue",
        readMetric(valuationItem?.metrics, "marketCapToAnnualizedRevenue"),
        "ratio",
        valuationItem?.sourceIds ?? [],
        valuationRevenuePeriod,
      ),
      ...metric(
        "valuationSupportability",
        "Peer supportability",
        typeof supportability === "string" ? supportability : undefined,
        "text",
        valuationItem?.sourceIds ?? [],
        valuationRevenuePeriod,
      ),
      ...metric(
        "peRatio",
        "PE",
        trailingPeSuppressed ? PE_NOT_MEANINGFUL : trailingPe,
        trailingPeSuppressed ? "text" : "ratio",
        yahooSourceIds,
        observedPeriod(yahooFundamentalsItem?.observedAt),
      ),
      ...metric(
        "forwardPe",
        "Forward PE",
        forwardPeSuppressed ? PE_NOT_MEANINGFUL : forwardPe,
        forwardPeSuppressed ? "text" : "ratio",
        yahooSourceIds,
        observedPeriod(yahooFundamentalsItem?.observedAt),
      ),
      ...(forwardPeSuppressed
        ? metric(
            "epsForward",
            "Forward EPS",
            epsForward,
            "number",
            yahooSourceIds,
            observedPeriod(yahooFundamentalsItem?.observedAt),
          )
        : []),
      ...metric(
        "priceToBook",
        "Price/book",
        readMetric(yahooFundamentalsItem?.metrics, "priceToBook"),
        "ratio",
        yahooSourceIds,
        observedPeriod(yahooFundamentalsItem?.observedAt),
      ),
      ...metric(
        "pcfRatio",
        "PCF",
        pcfRatio,
        "ratio",
        pcfSourceIds,
        secPeriod(secItem, "operatingCashFlow"),
      ),
    ],
    sourceIds,
  };
}

function momentumLens(
  snapshot: VerifiedMarketSnapshot | undefined,
  quoteCurrency: string,
): FinancialLens {
  const sourceIds = snapshot === undefined ? [] : [verifiedSnapshotSourceId(snapshot.symbol)];
  const indicators = snapshot?.indicators;
  const sma50 = indicators?.sma50 ?? undefined;
  const sma200 = indicators?.sma200 ?? undefined;
  const rsi14 = indicators?.rsi14 ?? undefined;
  const macdHistogram = indicators?.macdHistogram ?? undefined;
  const close = snapshot?.ohlcv.close;
  return {
    name: "Momentum",
    posture: postureFrom([
      close === undefined || sma50 === undefined ? undefined : close > sma50,
      sma50 === undefined || sma200 === undefined ? undefined : sma50 > sma200,
      rsi14 === undefined ? undefined : rsi14 >= 40 && rsi14 <= 70,
      macdHistogram === undefined ? undefined : macdHistogram >= 0,
    ]),
    metrics: [
      ...metric("latestClose", "Latest close", close, "currency", sourceIds, {
        currency: quoteCurrency,
        ...observedPeriod(snapshot?.fetchedAt),
      }),
      ...metric(
        "sma50",
        "SMA50",
        sma50 ?? undefined,
        "number",
        sourceIds,
        observedPeriod(snapshot?.fetchedAt),
      ),
      ...metric(
        "sma200",
        "SMA200",
        sma200 ?? undefined,
        "number",
        sourceIds,
        observedPeriod(snapshot?.fetchedAt),
      ),
      ...metric(
        "rsi14",
        "RSI14",
        rsi14 ?? undefined,
        "number",
        sourceIds,
        observedPeriod(snapshot?.fetchedAt),
      ),
      ...metric(
        "macdHistogram",
        "MACD histogram",
        macdHistogram ?? undefined,
        "number",
        sourceIds,
        observedPeriod(snapshot?.fetchedAt),
      ),
    ],
    sourceIds,
  };
}

function summarizeLens(lens: FinancialLens): string {
  const metricText = lens.metrics
    .slice(0, 4)
    .map((item) => `${item.label} ${formatValue(item)}`)
    .join(", ");
  return `${lens.name} ${lens.posture}${metricText === "" ? "" : ` (${metricText})`}`;
}

function formatValue(lensMetric: FinancialLensMetric): string {
  if (typeof lensMetric.value === "string") {
    return lensMetric.value;
  }
  return formatLensValue(lensMetric.value, lensMetric.unit, lensMetric.currency);
}

function financialLensGap(symbol: string, missing: readonly string[]): SourceGap {
  return sourceGap({
    source: "financial-lens",
    message: `Financial Lens Evidence partial for ${symbol}: missing ${missing.join(", ")}`,
    provider: "market-bot",
    capability: "extended-evidence",
    cause: "provider-data-missing",
    evidenceQualityImpact: "no-cap",
  });
}

function postureMetricKey(name: FinancialLensName): string {
  if (name === "Financial Strength") {
    return "financialStrengthPosture";
  }
  return `${name.toLowerCase()}Posture`;
}

export function addFinancialLensEvidence(
  command: ResearchCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedEvidence: ExtendedEvidence | undefined,
  verifiedMarketSnapshot: VerifiedMarketSnapshot | undefined,
  generatedAt: string,
): FinancialLensResult {
  if (!isInstrumentCommand(command) || command.assetClass !== "equity") {
    return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
  }

  const secItem = secFundamentalItem(extendedEvidence);
  const valuationItem = itemByCategory(extendedEvidence, "valuation");
  const yahooFundamentalsItem = itemByCategory(extendedEvidence, "yahoo-fundamentals");
  const snapshot = tickerSnapshot(command, marketSnapshots);
  const quoteCurrency = snapshot?.identity?.quoteCurrency ?? "USD";
  const lenses = [
    qualityLens(secItem),
    growthLens(secItem),
    strengthLens(secItem, valuationItem, yahooFundamentalsItem),
    valueLens(valuationItem, secItem, yahooFundamentalsItem, snapshot),
    momentumLens(verifiedMarketSnapshot, quoteCurrency),
  ];
  const sourceIds = [
    ...new Set(lenses.flatMap((lens) => lens.sourceIds).filter((sourceId) => sourceId !== "")),
  ];
  const item: ExtendedEvidenceItem = {
    category: "financial-lens",
    title: `${command.symbol} Financial Lens Evidence`,
    summary: `Financial Lens Evidence: ${lenses.map((lens) => summarizeLens(lens)).join("; ")}.`,
    sourceIds,
    observedAt:
      [
        snapshot?.observedAt,
        secItem?.observedAt,
        valuationItem?.observedAt,
        verifiedMarketSnapshot?.fetchedAt,
      ]
        .filter((value): value is string => value !== undefined)
        .toSorted()
        .at(-1) ?? generatedAt,
    metrics: Object.fromEntries(
      lenses.flatMap((lens) => [
        [postureMetricKey(lens.name), lens.posture],
        ...lens.metrics.map((metricValue) => [metricValue.key, metricValue.value] as const),
      ]),
    ),
    ...(secItem?.identity !== undefined ? { identity: secItem.identity } : {}),
  };
  const artifact: FinancialLensArtifact = {
    version: 1,
    generatedAt,
    symbol: command.symbol.toUpperCase(),
    lenses,
    sourceIds,
  };
  const missing = [
    ...(secItem === undefined ? ["SEC fundamentals"] : []),
    ...(valuationItem === undefined ? ["valuation evidence"] : []),
    ...(verifiedMarketSnapshot === undefined ? ["verified market snapshot"] : []),
  ];
  const gaps = missing.length === 0 ? [] : [financialLensGap(command.symbol, missing)];
  const mergedEvidence: ExtendedEvidence = {
    instrument: extendedEvidence?.instrument ?? {
      symbol: command.symbol,
      assetClass: command.assetClass,
    },
    items: [...(extendedEvidence?.items ?? []), item],
    gaps: [...(extendedEvidence?.gaps ?? []), ...gaps],
  };
  return { extendedEvidence: mergedEvidence, artifact, sourceGaps: gaps };
}
