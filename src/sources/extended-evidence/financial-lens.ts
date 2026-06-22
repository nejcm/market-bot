import type { ResearchCommand } from "../../cli/args";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  MarketSnapshot,
  SourceGap,
  VerifiedMarketSnapshot,
} from "../../domain/types";
import { sourceGap } from "../../domain/source-gaps";
import { verifiedSnapshotSourceId } from "../../research/verified-snapshot-contract";

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
  readonly unit: "ratio" | "percent" | "usd" | "number" | "text";
  readonly sourceIds: readonly string[];
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

function tickerSnapshot(
  command: Extract<ResearchCommand, { readonly jobType: "ticker" }>,
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

function positive(value: number | undefined): boolean {
  return value !== undefined && value > 0;
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
): readonly FinancialLensMetric[] {
  return value === undefined ? [] : [{ key, label, value, unit, sourceIds }];
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
  const operatingCashFlow = readMetric(secItem?.metrics, "operatingCashFlow");
  const capex = readMetric(secItem?.metrics, "capex");
  const freeCashFlowProxy =
    operatingCashFlow === undefined || capex === undefined ? undefined : operatingCashFlow - capex;
  const metrics = [
    ...metric("grossMargin", "Gross margin", ratio(grossProfit, revenue), "percent", sourceIds),
    ...metric(
      "operatingMargin",
      "Operating margin",
      ratio(operatingIncome, revenue),
      "percent",
      sourceIds,
    ),
    ...metric("netMargin", "Net margin", ratio(netIncome, revenue), "percent", sourceIds),
    ...metric("freeCashFlowProxy", "FCF proxy", freeCashFlowProxy, "usd", sourceIds),
    ...metric(
      "cashConversion",
      "Cash conversion",
      ratio(operatingCashFlow, netIncome),
      "ratio",
      sourceIds,
    ),
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
  const metrics = [
    ...metric(
      "revenueDeltaPercent",
      "Revenue YoY",
      readMetric(secItem?.metrics, "revenueDeltaPercent"),
      "percent",
      sourceIds,
    ),
    ...metric(
      "grossProfitDeltaPercent",
      "Gross profit YoY",
      readMetric(secItem?.metrics, "grossProfitDeltaPercent"),
      "percent",
      sourceIds,
    ),
    ...metric(
      "operatingIncomeDeltaPercent",
      "Operating income YoY",
      readMetric(secItem?.metrics, "operatingIncomeDeltaPercent"),
      "percent",
      sourceIds,
    ),
    ...metric(
      "netIncomeDeltaPercent",
      "Net income YoY",
      readMetric(secItem?.metrics, "netIncomeDeltaPercent"),
      "percent",
      sourceIds,
    ),
    ...metric(
      "dilutedEpsDeltaPercent",
      "Diluted EPS YoY",
      readMetric(secItem?.metrics, "dilutedEpsDeltaPercent"),
      "percent",
      sourceIds,
    ),
    ...metric(
      "operatingCashFlowDeltaPercent",
      "Operating cash flow YoY",
      readMetric(secItem?.metrics, "operatingCashFlowDeltaPercent"),
      "percent",
      sourceIds,
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
): FinancialLens {
  const sourceIds = [
    ...new Set([...(secItem?.sourceIds ?? []), ...(valuationItem?.sourceIds ?? [])]),
  ];
  const cash = readMetric(secItem?.metrics, "cash");
  const debt = readMetric(secItem?.metrics, "debt");
  const currentAssets = readMetric(secItem?.metrics, "currentAssets");
  const currentLiabilities = readMetric(secItem?.metrics, "currentLiabilities");
  const fallbackNetDebt = debt === undefined || cash === undefined ? undefined : debt - cash;
  const netDebt = readMetric(valuationItem?.metrics, "netDebt") ?? fallbackNetDebt;
  const debtToMarketCap = readMetric(valuationItem?.metrics, "debtToMarketCap");
  const netDebtToMarketCap = readMetric(valuationItem?.metrics, "netDebtToMarketCap");
  const currentRatio = ratio(currentAssets, currentLiabilities);
  const metrics = [
    ...metric("cash", "Cash", cash, "usd", secItem?.sourceIds ?? []),
    ...metric("debt", "Debt", debt, "usd", secItem?.sourceIds ?? []),
    ...metric("netDebt", "Net debt", netDebt, "usd", sourceIds),
    ...metric("debtToMarketCap", "Debt/market cap", debtToMarketCap, "percent", sourceIds),
    ...metric(
      "netDebtToMarketCap",
      "Net debt/market cap",
      netDebtToMarketCap,
      "percent",
      sourceIds,
    ),
    ...metric("currentRatio", "Current ratio", currentRatio, "ratio", secItem?.sourceIds ?? []),
  ];
  return {
    name: "Financial Strength",
    posture: postureFrom([
      cash === undefined || debt === undefined ? undefined : cash >= debt,
      netDebtToMarketCap === undefined ? undefined : netDebtToMarketCap <= 0.25,
      debtToMarketCap === undefined ? undefined : debtToMarketCap <= 0.5,
      currentRatio === undefined ? undefined : currentRatio >= 1,
    ]),
    metrics,
    sourceIds,
  };
}

function valueLens(valuationItem: ExtendedEvidenceItem | undefined): FinancialLens {
  const sourceIds = valuationItem?.sourceIds ?? [];
  const supportability = valuationItem?.metrics?.valuationSupportability;
  return {
    name: "Value",
    posture: postureFrom([
      readMetric(valuationItem?.metrics, "evToAnnualizedRevenue") === undefined ? undefined : true,
      readMetric(valuationItem?.metrics, "marketCapToAnnualizedRevenue") === undefined
        ? undefined
        : true,
      supportability === undefined ? undefined : supportability === "supported",
    ]),
    metrics: [
      ...metric(
        "enterpriseValue",
        "Enterprise value",
        readMetric(valuationItem?.metrics, "enterpriseValue"),
        "usd",
        sourceIds,
      ),
      ...metric(
        "annualizedRevenue",
        "Annualized revenue",
        readMetric(valuationItem?.metrics, "annualizedRevenue"),
        "usd",
        sourceIds,
      ),
      ...metric(
        "evToAnnualizedRevenue",
        "EV/revenue",
        readMetric(valuationItem?.metrics, "evToAnnualizedRevenue"),
        "ratio",
        sourceIds,
      ),
      ...metric(
        "marketCapToAnnualizedRevenue",
        "Market cap/revenue",
        readMetric(valuationItem?.metrics, "marketCapToAnnualizedRevenue"),
        "ratio",
        sourceIds,
      ),
      ...metric(
        "valuationSupportability",
        "Peer supportability",
        typeof supportability === "string" ? supportability : undefined,
        "text",
        sourceIds,
      ),
    ],
    sourceIds,
  };
}

function momentumLens(snapshot: VerifiedMarketSnapshot | undefined): FinancialLens {
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
      ...metric("latestClose", "Latest close", close, "usd", sourceIds),
      ...metric("sma50", "SMA50", sma50 ?? undefined, "number", sourceIds),
      ...metric("sma200", "SMA200", sma200 ?? undefined, "number", sourceIds),
      ...metric("rsi14", "RSI14", rsi14 ?? undefined, "number", sourceIds),
      ...metric("macdHistogram", "MACD histogram", macdHistogram ?? undefined, "number", sourceIds),
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
  if (lensMetric.unit === "percent") {
    const percent = Math.abs(lensMetric.value) > 1 ? lensMetric.value : lensMetric.value * 100;
    return `${percent.toFixed(1)}%`;
  }
  if (lensMetric.unit === "ratio") {
    return `${lensMetric.value.toFixed(2)}x`;
  }
  if (lensMetric.unit === "usd") {
    return formatUsd(lensMetric.value);
  }
  return lensMetric.value.toFixed(2);
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

export function addFinancialLensEvidence(
  command: ResearchCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedEvidence: ExtendedEvidence | undefined,
  verifiedMarketSnapshot: VerifiedMarketSnapshot | undefined,
  generatedAt: string,
): FinancialLensResult {
  if (command.jobType !== "ticker" || command.assetClass !== "equity") {
    return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
  }

  const secItem = secFundamentalItem(extendedEvidence);
  const valuationItem = itemByCategory(extendedEvidence, "valuation");
  const snapshot = tickerSnapshot(command, marketSnapshots);
  const lenses = [
    qualityLens(secItem),
    growthLens(secItem),
    strengthLens(secItem, valuationItem),
    valueLens(valuationItem),
    momentumLens(verifiedMarketSnapshot),
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
        [`${lens.name.replaceAll(" ", "").toLowerCase()}Posture`, lens.posture],
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
