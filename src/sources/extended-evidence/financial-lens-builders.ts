import {
  annualize,
  atOrBelow,
  metric,
  observedPeriod,
  peIsClean,
  peMetricValue,
  percentChange,
  positive,
  postureFrom,
  ratio,
  readMetric,
  readSecMetric,
  readStringMetric,
  secPeriod,
  selectedDerivedPeriod,
  selectedRatioLabel,
  valuationDateBasisMetric,
  type FinancialLens,
  type FinancialLensMetric,
} from "./financial-lens-metrics";
import type {
  ExtendedEvidenceItem,
  MarketSnapshot,
  VerifiedMarketSnapshot,
} from "../../domain/types";
import { verifiedSnapshotSourceId } from "../../research/verified-snapshot-contract";
import { selectedFinancialLensDerivedMetric } from "./financial-lens-canonical";
import { MIXED_PERIOD_METRIC, REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT } from "./valuation-comps";
import type { SubsequentFinancingBridgeArtifact } from "./subsequent-financing";

export function qualityLens(secItem: ExtendedEvidenceItem | undefined): FinancialLens {
  const sourceIds = secItem?.sourceIds ?? [];
  const revenue = readSecMetric(secItem?.metrics, "revenue");
  const grossProfit = readSecMetric(secItem?.metrics, "grossProfit");
  const operatingIncome = readSecMetric(secItem?.metrics, "operatingIncome");
  const netIncome = readSecMetric(secItem?.metrics, "netIncome");
  const consolidatedNetIncome = readSecMetric(secItem?.metrics, "consolidatedNetIncome");
  const netIncomePeriodMonths = readSecMetric(secItem?.metrics, "netIncomePeriodMonths");
  const operatingCashFlow = readSecMetric(secItem?.metrics, "operatingCashFlow");
  const capex = readSecMetric(secItem?.metrics, "capex");
  const stockholdersEquity = readSecMetric(secItem?.metrics, "stockholdersEquity");
  const assets = readSecMetric(secItem?.metrics, "assets");
  const grossMargin = selectedFinancialLensDerivedMetric(
    secItem,
    "grossMargin",
    ratio(grossProfit, revenue),
  );
  const operatingMargin = selectedFinancialLensDerivedMetric(
    secItem,
    "operatingMargin",
    ratio(operatingIncome, revenue),
  );
  const netMargin = selectedFinancialLensDerivedMetric(
    secItem,
    "netMargin",
    ratio(netIncome, revenue),
  );
  const freeCashFlowProxy = selectedFinancialLensDerivedMetric(
    secItem,
    "freeCashFlowProxy",
    operatingCashFlow === undefined || capex === undefined ? undefined : operatingCashFlow - capex,
  );
  const cashConversion = selectedFinancialLensDerivedMetric(
    secItem,
    "cashConversion",
    ratio(operatingCashFlow, netIncome),
  );
  // ROE/ROA are industry-relative (display-only): no universal threshold, no posture.
  // Annualized by net income's own periodMonths so a partial-year filing does not
  // Understate the return. See plan revision 2 / Q6.
  const annualizedNetIncome = annualize(netIncome, netIncomePeriodMonths);
  const roe = selectedFinancialLensDerivedMetric(
    secItem,
    "roe",
    ratio(annualizedNetIncome, stockholdersEquity),
  );
  const roa = selectedFinancialLensDerivedMetric(
    secItem,
    "roa",
    ratio(annualizedNetIncome, assets),
  );
  const hasDistinctConsolidatedNetIncome =
    netIncome !== undefined &&
    consolidatedNetIncome !== undefined &&
    consolidatedNetIncome !== netIncome;
  const metrics = [
    ...metric(
      "grossMargin",
      "Gross margin",
      grossMargin,
      "ratio-percent",
      sourceIds,
      selectedDerivedPeriod(secItem, "grossMargin", "revenue"),
    ),
    ...metric(
      "operatingMargin",
      "Operating margin",
      operatingMargin,
      "ratio-percent",
      sourceIds,
      selectedDerivedPeriod(secItem, "operatingMargin", "revenue"),
    ),
    ...metric(
      "netMargin",
      "Net margin",
      netMargin,
      "ratio-percent",
      sourceIds,
      selectedDerivedPeriod(secItem, "netMargin", "revenue"),
    ),
    ...metric(
      "freeCashFlowProxy",
      "FCF proxy",
      freeCashFlowProxy,
      "currency",
      sourceIds,
      selectedDerivedPeriod(secItem, "freeCashFlowProxy", "operatingCashFlow"),
    ),
    ...metric(
      "cashConversion",
      "Cash conversion",
      cashConversion,
      "ratio",
      sourceIds,
      selectedDerivedPeriod(secItem, "cashConversion", "operatingCashFlow"),
    ),
    ...metric(
      "roe",
      selectedRatioLabel("ROE", secItem, "roe", "netIncome", "stockholdersEquity", "equity"),
      roe,
      "ratio-percent",
      sourceIds,
      selectedDerivedPeriod(secItem, "roe", "netIncome"),
    ),
    ...metric(
      "roa",
      selectedRatioLabel("ROA", secItem, "roa", "netIncome", "assets", "assets"),
      roa,
      "ratio-percent",
      sourceIds,
      selectedDerivedPeriod(secItem, "roa", "netIncome"),
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
      positive(grossMargin),
      positive(operatingMargin),
      positive(netMargin),
      positive(freeCashFlowProxy),
    ]),
    metrics,
    sourceIds,
  };
}

export function growthLens(secItem: ExtendedEvidenceItem | undefined): FinancialLens {
  const sourceIds = secItem?.sourceIds ?? [];
  const netIncomePrior = readSecMetric(secItem?.metrics, "netIncomePrior");
  const metrics = [
    ...metric(
      "revenueDeltaPercent",
      "Revenue YoY",
      readSecMetric(secItem?.metrics, "revenueDeltaPercent"),
      "whole-percent",
      sourceIds,
      secPeriod(secItem, "revenue"),
    ),
    ...metric(
      "grossProfitDeltaPercent",
      "Gross profit YoY",
      readSecMetric(secItem?.metrics, "grossProfitDeltaPercent"),
      "whole-percent",
      sourceIds,
      secPeriod(secItem, "grossProfit"),
    ),
    ...metric(
      "operatingIncomeDeltaPercent",
      "Operating income YoY",
      readSecMetric(secItem?.metrics, "operatingIncomeDeltaPercent"),
      "whole-percent",
      sourceIds,
      secPeriod(secItem, "operatingIncome"),
    ),
    ...metric(
      "netIncomeDeltaPercent",
      netIncomePrior !== undefined && netIncomePrior < 0
        ? "Net loss (attrib.) YoY change"
        : "Net income (attrib.) YoY",
      readSecMetric(secItem?.metrics, "netIncomeDeltaPercent"),
      "whole-percent",
      sourceIds,
      secPeriod(secItem, "netIncome"),
    ),
    ...metric(
      "dilutedEpsDeltaPercent",
      "Diluted EPS YoY",
      readSecMetric(secItem?.metrics, "dilutedEpsDeltaPercent"),
      "whole-percent",
      sourceIds,
      secPeriod(secItem, "dilutedEps"),
    ),
    ...metric(
      "operatingCashFlowDeltaPercent",
      "Operating cash flow YoY",
      readSecMetric(secItem?.metrics, "operatingCashFlowDeltaPercent"),
      "whole-percent",
      sourceIds,
      secPeriod(secItem, "operatingCashFlow"),
    ),
  ];
  return {
    name: "Growth",
    posture: postureFrom(
      [
        percentChange(readSecMetric(secItem?.metrics, "revenueDeltaPercent")),
        percentChange(readSecMetric(secItem?.metrics, "grossProfitDeltaPercent")),
        percentChange(readSecMetric(secItem?.metrics, "operatingIncomeDeltaPercent")),
        percentChange(readSecMetric(secItem?.metrics, "netIncomeDeltaPercent")),
        percentChange(readSecMetric(secItem?.metrics, "dilutedEpsDeltaPercent")),
        percentChange(readSecMetric(secItem?.metrics, "operatingCashFlowDeltaPercent")),
      ],
      2,
    ),
    metrics,
    sourceIds,
  };
}

export function strengthLens(
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
  const cash = readSecMetric(secItem?.metrics, "cash");
  const debt = readSecMetric(secItem?.metrics, "debt");
  const currentAssets = readSecMetric(secItem?.metrics, "currentAssets");
  const currentLiabilities = readSecMetric(secItem?.metrics, "currentLiabilities");
  const stockholdersEquity = readSecMetric(secItem?.metrics, "stockholdersEquity");
  const netIncome = readSecMetric(secItem?.metrics, "netIncome");
  const dividendsPaid = readSecMetric(secItem?.metrics, "dividendsPaid");
  const selectedNetDebt = selectedFinancialLensDerivedMetric(
    secItem,
    "netDebt",
    debt === undefined || cash === undefined ? undefined : debt - cash,
  );
  const netDebt =
    valuationItem?.metrics?.netDebt === MIXED_PERIOD_METRIC
      ? undefined
      : (readMetric(valuationItem?.metrics, "netDebt") ?? selectedNetDebt);
  const debtToMarketCap = readMetric(valuationItem?.metrics, "debtToMarketCap");
  const netDebtToMarketCap = readMetric(valuationItem?.metrics, "netDebtToMarketCap");
  const currentRatio = selectedFinancialLensDerivedMetric(
    secItem,
    "currentRatio",
    ratio(currentAssets, currentLiabilities),
  );
  // Debt-to-equity is industry-relative (display-only): no universal threshold.
  const debtToEquity = selectedFinancialLensDerivedMetric(
    secItem,
    "debtToEquity",
    ratio(debt, stockholdersEquity),
  );
  // Dividend Payout: SEC-preferred (abs(dividendsPaid)/netIncome) contributes the
  // Forbes <= 0.8 posture criterion; the Yahoo fallback (trailingAnnualDividendRate
  // / epsTtm) is display-only so a non-US listing with no SEC data does not flip
  // Financial Strength out of insufficient-data on one Yahoo-sourced criterion.
  // See plan revisions 3 / Q4. dividendsPaid is negative in XBRL (cash outflow);
  // The lens uses abs() to handle both signs. See plan risk "Dividend Payout sign".
  const secPayout = selectedFinancialLensDerivedMetric(
    secItem,
    "payoutRatio",
    dividendsPaid !== undefined && netIncome !== undefined
      ? ratio(Math.abs(dividendsPaid), netIncome)
      : undefined,
  );
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
    ...metric(
      "netDebt",
      "Net debt",
      netDebt,
      "currency",
      sourceIds,
      selectedDerivedPeriod(secItem, "netDebt", "debt"),
    ),
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
      selectedDerivedPeriod(secItem, "currentRatio", "currentAssets"),
    ),
    ...metric(
      "debtToEquity",
      "Debt/equity",
      debtToEquity,
      "ratio",
      secItem?.sourceIds ?? [],
      selectedDerivedPeriod(secItem, "debtToEquity", "debt"),
    ),
    ...metric(
      "payoutRatio",
      "Payout ratio",
      payoutRatio,
      "ratio-percent",
      payoutSourceIds,
      payoutFromSec
        ? selectedDerivedPeriod(secItem, "payoutRatio", "dividendsPaid")
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
      selectedNetDebt === undefined ? undefined : selectedNetDebt <= 0,
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

export function applySubsequentFinancingCurrentness(
  lens: FinancialLens,
  bridge: SubsequentFinancingBridgeArtifact | undefined,
): FinancialLens {
  const unreconciled = bridge?.events.filter((event) => !event.reconciled) ?? [];
  if (unreconciled.length === 0) {
    return lens;
  }
  const sourceIds = [
    ...new Set([...lens.sourceIds, ...unreconciled.flatMap((event) => event.sourceIds)]),
  ];
  return {
    ...lens,
    metrics: [
      ...lens.metrics,
      {
        key: "unreconciledFinancingEvents",
        label: "Unreconciled post-period financing events",
        value: unreconciled.length,
        unit: "number",
        sourceIds: bridge?.sourceIds ?? [],
        ...(unreconciled[0] !== undefined ? { periodEnd: unreconciled[0].eventDate } : {}),
      },
    ],
    sourceIds,
    currentStatus: "partial",
    currentStatusReasonCodes: ["unreconciled-post-period-financing"],
  };
}

export function valueLens(
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
  // A P/E renders as a bare numeric multiple only when it is "clean": a finite,
  // Positive ratio over positive earnings. Otherwise formatPeRatio produces annotated
  // Text — the negative value plus a caveat, or N/M for non-computable earnings — which
  // Is shown as a text metric so the sign/signal is preserved without implying a
  // Normal multiple. The paired EPS line surfaces the (meaningful) loss magnitude.
  const trailingPeClean = peIsClean(trailingPe, epsTrailingTwelveMonths);
  const forwardPeClean = peIsClean(forwardPe, epsForward);
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
  const operatingCashFlow = readSecMetric(secItem?.metrics, "operatingCashFlow");
  const operatingCashFlowPeriodMonths = readSecMetric(
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
      ...valuationDateBasisMetric(valuationItem),
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
        peMetricValue(trailingPe, epsTrailingTwelveMonths, trailingPeClean),
        trailingPeClean ? "ratio" : "text",
        yahooSourceIds,
        observedPeriod(yahooFundamentalsItem?.observedAt),
      ),
      ...(trailingPe !== undefined && !trailingPeClean
        ? metric(
            "epsTrailingTwelveMonths",
            "Trailing EPS",
            epsTrailingTwelveMonths,
            "number",
            yahooSourceIds,
            observedPeriod(yahooFundamentalsItem?.observedAt),
          )
        : []),
      ...metric(
        "forwardPe",
        "Forward PE",
        peMetricValue(forwardPe, epsForward, forwardPeClean),
        forwardPeClean ? "ratio" : "text",
        yahooSourceIds,
        observedPeriod(yahooFundamentalsItem?.observedAt),
      ),
      ...(forwardPe !== undefined && !forwardPeClean
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

export function momentumLens(
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
