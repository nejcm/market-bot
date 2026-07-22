import type { RunDetail } from "../types";
import type { MarketSnapshot } from "../../src/domain/types";
import type {
  FinancialLensName,
  FinancialLensPosture,
} from "../../src/sources/extended-evidence/financial-lens";
import type {
  FundamentalHistoryArtifact,
  FundamentalHistoryPoint,
  FundamentalHistorySeriesKey,
} from "../../src/sources/extended-evidence/fundamental-history";
import type { PeerImpliedRange } from "../../src/sources/extended-evidence/valuation-comps";
import {
  CURRENCY_SYMBOLS,
  formatLensValue,
  formatPeRatio,
  scaleCurrency,
} from "../../src/sources/extended-evidence/value-format";
import type {
  ExtendedEvidenceItemView,
  ForecastGroup,
  ForecastRollup,
  PredictionTargetHealth,
  ScoredForecast,
  ScenarioView,
  SourceView,
} from "../report-artifact-view";
import {
  VERIFIED_SNAPSHOT_PATH,
  businessFrameworkView,
  extendedEvidenceItems,
  financialLensStatTiles,
  forecastGroups,
  forecastRollup,
  historicalContextAuditView,
  horizonMarkers,
  predictionTargetHealth,
  scenarios,
  scoredForecasts,
  sources,
  splitDataGaps,
  stringArray,
  textItems,
  tradingViewUrl,
  verifiedSnapshotValue,
  webSubjectProfileView,
  type BusinessFrameworkView,
  type FinancialLensStatTile,
  type HistoricalContextAuditView,
  type SnapshotView,
  type WebSubjectProfileView,
} from "./view-model";

export interface RunWorkspaceTextItem {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

export type RunWorkspaceCaseKey = "bullCase" | "bearCase" | "risks" | "catalysts";

export interface RunWorkspaceCaseSection {
  readonly key: RunWorkspaceCaseKey;
  readonly title: string;
  readonly items: readonly RunWorkspaceTextItem[];
}

export interface RunWorkspaceReportView {
  readonly summary: string;
  readonly financialLensGroups: readonly RunWorkspaceFinancialLensGroup[];
  readonly findings: readonly RunWorkspaceTextItem[];
  readonly cases: readonly RunWorkspaceCaseSection[];
  readonly scenarios: readonly ScenarioView[];
  readonly markdown?: string;
}

export interface RunWorkspaceFinancialLensGroup {
  readonly lens: FinancialLensName;
  readonly posture: FinancialLensPosture;
  readonly tiles: readonly FinancialLensStatTile[];
}

export interface RunWorkspaceForecastsView {
  readonly items: readonly ScoredForecast[];
  readonly groups: readonly ForecastGroup[];
  readonly stats: ForecastRollup;
  readonly horizons: readonly number[];
  readonly targetHealth?: PredictionTargetHealth;
  readonly visible: boolean;
}

export interface RunWorkspaceEvidenceView {
  readonly historicalContext?: HistoricalContextAuditView;
  readonly webSubjectProfile?: WebSubjectProfileView;
  readonly businessFramework?: BusinessFrameworkView;
  readonly extendedItems: readonly ExtendedEvidenceItemView[];
}

export interface RunWorkspaceGapsView {
  readonly shortfalls: readonly string[];
  readonly otherGaps: readonly string[];
  readonly visible: boolean;
}

export interface RunWorkspaceSourcesView {
  readonly items: readonly SourceView[];
}

export interface RunWorkspaceSnapshotView {
  readonly value: SnapshotView;
  readonly tradingViewUrl: string;
}

export interface RunWorkspaceEquityHeaderFinancial {
  readonly key: "marketCap" | "trailingPE" | "forwardPE" | "dividendYield" | "sharesOutstanding";
  readonly label: string;
  readonly value: string;
  readonly caption: string;
}

export interface RunWorkspaceEquityHeaderView {
  readonly displayName: string;
  readonly symbol: string;
  readonly price: string;
  readonly quoteCurrency: string;
  readonly dailyChange: string;
  readonly changeDirection: "positive" | "negative" | "flat";
  readonly asOf: string;
  readonly financials: readonly RunWorkspaceEquityHeaderFinancial[];
}

export interface RunWorkspaceSparklineBar {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RunWorkspaceSparklineGeometry {
  readonly bars: readonly RunWorkspaceSparklineBar[];
  readonly baseline: number;
}

export interface RunWorkspaceFundamentalHistoryCard {
  readonly key:
    | "revenue"
    | "freeCashFlowProxy"
    | "dilutedEps"
    | "grossMargin"
    | "operatingMargin"
    | "netMargin";
  readonly label: string;
  readonly value: string;
  readonly valuePeriod: string;
  readonly trendLabel?: string;
  readonly periodRange: string;
  readonly sourceCaption: string;
  readonly disclosure?: string;
  readonly geometry: RunWorkspaceSparklineGeometry;
}

export interface RunWorkspaceFundamentalHistoryView {
  readonly cards: readonly RunWorkspaceFundamentalHistoryCard[];
}

export interface RunWorkspacePeerImpliedRangeGeometry {
  readonly mid: number;
  readonly current: number;
}

export type RunWorkspacePeerImpliedRangeView =
  | {
      readonly status: "derived";
      readonly label: string;
      readonly position: "below-range" | "within-range" | "above-range";
      readonly positionLabel: string;
      readonly lowLabel: string;
      readonly midLabel: string;
      readonly highLabel: string;
      readonly currentLabel: string;
      readonly methodDisclosure: string;
      readonly boundaryDisclosure: string;
      readonly geometry: RunWorkspacePeerImpliedRangeGeometry;
    }
  | {
      readonly status: "suppressed";
      readonly label: string;
      readonly message: string;
    };

export interface RunWorkspaceTableOfContentsEntry {
  readonly key: string;
  readonly label: string;
}

export interface RunWorkspaceView {
  readonly equityHeader?: RunWorkspaceEquityHeaderView;
  readonly fundamentalHistory?: RunWorkspaceFundamentalHistoryView;
  readonly peerImpliedRange?: RunWorkspacePeerImpliedRangeView;
  readonly report: RunWorkspaceReportView;
  readonly forecasts: RunWorkspaceForecastsView;
  readonly evidence: RunWorkspaceEvidenceView;
  readonly gaps: RunWorkspaceGapsView;
  readonly sources: RunWorkspaceSourcesView;
  readonly snapshot?: RunWorkspaceSnapshotView;
  readonly tableOfContents: readonly RunWorkspaceTableOfContentsEntry[];
}

function formatReferencePrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

const PEER_IMPLIED_RANGE_POSITION_LABELS = {
  "below-range": "Below range",
  "within-range": "Within range",
  "above-range": "Above range",
} satisfies Record<Extract<PeerImpliedRange, { status: "derived" }>["position"], string>;

function rangeGeometry(
  range: Extract<PeerImpliedRange, { status: "derived" }>,
): RunWorkspacePeerImpliedRangeGeometry {
  const span = range.high - range.low;
  if (span <= 0) {
    return { mid: 0.5, current: 0.5 };
  }
  const { currentPrice } = range.inputs;
  return {
    mid: Math.max(0, Math.min(1, (range.mid - range.low) / span)),
    current: Math.max(0, Math.min(1, (currentPrice - range.low) / span)),
  };
}

export function peerImpliedRangeView(
  detail: RunDetail,
): RunWorkspacePeerImpliedRangeView | undefined {
  const range = detail.peerImpliedRange;
  if (range === undefined) {
    return undefined;
  }
  const { label } = range;
  if (range.status === "suppressed") {
    return {
      status: "suppressed",
      label,
      message: `Reference range suppressed: ${range.suppressedReason}.`,
    };
  }
  const { inputs } = range;
  return {
    status: "derived",
    label,
    position: range.position,
    positionLabel: PEER_IMPLIED_RANGE_POSITION_LABELS[range.position],
    lowLabel: `Low ${formatReferencePrice(range.low)}`,
    midLabel: `Mid ${formatReferencePrice(range.mid)}`,
    highLabel: `High ${formatReferencePrice(range.high)}`,
    currentLabel: `Current price ${formatReferencePrice(inputs.currentPrice)}`,
    methodDisclosure: `Method: ${range.basis}; ${range.formula}. Inputs: P25 ${inputs.peerP25EvToAnnualizedRevenue.toFixed(2)}x, median ${inputs.peerMedianEvToAnnualizedRevenue.toFixed(2)}x, P75 ${inputs.peerP75EvToAnnualizedRevenue.toFixed(2)}x; annualized revenue ${formatLensValue(inputs.annualizedRevenue, "currency", "USD")}, net debt ${formatLensValue(inputs.netDebt, "currency", "USD")}, shares ${scaleCurrency(inputs.sharesOutstanding)}, current price ${formatReferencePrice(inputs.currentPrice)}, Yahoo quote ${inputs.quoteObservedAt ?? "unavailable"}.`,
    boundaryDisclosure: "Boundary rule: prices equal to low or high are within range.",
    geometry: rangeGeometry(range),
  };
}

const FUNDAMENTAL_HISTORY_CARD_KEYS: readonly RunWorkspaceFundamentalHistoryCard["key"][] = [
  "revenue",
  "freeCashFlowProxy",
  "dilutedEps",
  "grossMargin",
  "operatingMargin",
  "netMargin",
];

function sparklineGeometry(
  points: readonly FundamentalHistoryPoint[],
): RunWorkspaceSparklineGeometry {
  const values = points.map((point) => point.value);
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const span = maximum - minimum;
  const baseline = span === 0 ? 0.5 : maximum / span;
  const slotWidth = points.length === 0 ? 1 : 1 / points.length;
  const width = Math.min(0.12, slotWidth * 0.68);
  return {
    baseline,
    bars: points.map((point, index) => {
      const valueY = span === 0 ? baseline : (maximum - point.value) / span;
      return {
        x: (index + 0.5) * slotWidth - width / 2,
        y: Math.min(valueY, baseline),
        width,
        height: Math.abs(valueY - baseline),
      };
    }),
  };
}

function historyPointValue(
  artifact: FundamentalHistoryArtifact,
  key: FundamentalHistorySeriesKey,
  point: FundamentalHistoryPoint,
): string {
  const { unit } = artifact.series[key];
  if (unit === "ratio") {
    return formatLensValue(point.value, "ratio-percent");
  }
  const [currency = point.currency] = point.currency.split("/");
  if (unit === "per-share") {
    const value = formatLensValue(point.value, "number");
    const symbol = CURRENCY_SYMBOLS[currency];
    return symbol === undefined ? `${currency} ${value}` : `${symbol}${value}`;
  }
  return formatLensValue(point.value, "currency", currency);
}

function historyTrendLabel(
  artifact: FundamentalHistoryArtifact,
  key: FundamentalHistorySeriesKey,
): string | undefined {
  const series = artifact.series[key];
  if (series.cagr !== undefined) {
    const sign = series.cagr.percent > 0 ? "+" : "";
    return `${sign}${series.cagr.percent.toFixed(1)}% CAGR · ${series.cagr.years.toFixed(1)}Y`;
  }
  if (series.marginChange !== undefined) {
    const sign = series.marginChange.percentagePoints > 0 ? "+" : "";
    return `${sign}${series.marginChange.percentagePoints.toFixed(1)}pp change · ${series.marginChange.years.toFixed(1)}Y`;
  }
  return undefined;
}

export function fundamentalHistoryView(
  detail: RunDetail,
): RunWorkspaceFundamentalHistoryView | undefined {
  const artifact = detail.fundamentalHistory;
  if (artifact === undefined) {
    return undefined;
  }
  const cards = FUNDAMENTAL_HISTORY_CARD_KEYS.flatMap((key) => {
    const series = artifact.series[key];
    const latest = series.ttm ?? series.annual.at(-1);
    const [firstAnnual] = series.annual;
    const lastAnnual = series.annual.at(-1);
    if (latest === undefined || firstAnnual === undefined || lastAnnual === undefined) {
      return [];
    }
    const points = [...series.annual, ...(series.ttm !== undefined ? [series.ttm] : [])];
    const trendLabel = historyTrendLabel(artifact, key);
    const epsTtmApproximation =
      key === "dilutedEps" && latest.form === "TTM"
        ? series.notes.find((note) => note.startsWith("ttm:eps-approximation:"))
        : undefined;
    return [
      {
        key,
        label: series.label,
        value: historyPointValue(artifact, key, latest),
        valuePeriod:
          latest.form === "TTM" ? `TTM through ${latest.periodEnd}` : `FY ${String(latest.fy)}`,
        ...(trendLabel !== undefined ? { trendLabel } : {}),
        periodRange: `FY ${String(firstAnnual.fy)}–FY ${String(lastAnnual.fy)} · ${firstAnnual.periodEnd} to ${lastAnnual.periodEnd}`,
        sourceCaption: "SEC EDGAR · companyfacts",
        ...(epsTtmApproximation !== undefined
          ? {
              disclosure:
                "Approximation: diluted EPS TTM adds per-share periods without reweighting diluted shares.",
            }
          : {}),
        geometry: sparklineGeometry(points),
      },
    ];
  });
  return cards.length === 0 ? undefined : { cards };
}

const CASE_SECTIONS: readonly {
  readonly key: RunWorkspaceCaseKey;
  readonly title: string;
}[] = [
  { key: "bullCase", title: "Bull case" },
  { key: "bearCase", title: "Bear case" },
  { key: "risks", title: "Risks" },
  { key: "catalysts", title: "Catalysts" },
];

function matchingMarketSnapshot(detail: RunDetail): MarketSnapshot | undefined {
  const { assetClass, symbol } = detail.summary;
  if (assetClass !== "equity" || symbol === undefined) {
    return undefined;
  }
  const normalizedSymbol = symbol.toUpperCase();
  return detail.marketSnapshots?.find(
    (snapshot) =>
      snapshot.assetClass === assetClass && snapshot.symbol.toUpperCase() === normalizedSymbol,
  );
}

function headerFinancials(snapshot: MarketSnapshot): readonly RunWorkspaceEquityHeaderFinancial[] {
  const quoteCurrency = snapshot.identity?.quoteCurrency ?? "USD";
  const observed = snapshot.observedAt;
  const candidates: readonly (RunWorkspaceEquityHeaderFinancial | undefined)[] = [
    snapshot.marketCap === undefined
      ? undefined
      : {
          key: "marketCap",
          label: "Market cap",
          value: formatLensValue(snapshot.marketCap, "currency", quoteCurrency),
          caption: `Yahoo quote · point in time · ${observed}`,
        },
    snapshot.fundamentals?.trailingPE === undefined
      ? undefined
      : {
          key: "trailingPE",
          label: "Trailing P/E",
          value: formatPeRatio(
            snapshot.fundamentals.trailingPE,
            snapshot.fundamentals.epsTrailingTwelveMonths,
          ),
          caption: `Yahoo quote · trailing 12M · ${observed}`,
        },
    snapshot.fundamentals?.forwardPE === undefined
      ? undefined
      : {
          key: "forwardPE",
          label: "Forward P/E",
          value: formatPeRatio(snapshot.fundamentals.forwardPE, snapshot.fundamentals.epsForward),
          caption: `Yahoo quote · forward · ${observed}`,
        },
    snapshot.fundamentals?.dividendYield === undefined
      ? undefined
      : {
          key: "dividendYield",
          label: "Dividend yield",
          value: formatLensValue(snapshot.fundamentals.dividendYield, "whole-percent"),
          caption: `Yahoo quote · quote snapshot · ${observed}`,
        },
    snapshot.fundamentals?.sharesOutstanding === undefined
      ? undefined
      : {
          key: "sharesOutstanding",
          label: "Shares outstanding",
          value: scaleCurrency(snapshot.fundamentals.sharesOutstanding),
          caption: `Yahoo quote · point in time · ${observed}`,
        },
  ];
  return candidates.filter(
    (candidate): candidate is RunWorkspaceEquityHeaderFinancial => candidate !== undefined,
  );
}

function dailyChangeDirection(changePercent24h: number): "positive" | "negative" | "flat" {
  if (changePercent24h > 0) {
    return "positive";
  }
  if (changePercent24h < 0) {
    return "negative";
  }
  return "flat";
}

export function equityHeaderView(detail: RunDetail): RunWorkspaceEquityHeaderView | undefined {
  const snapshot = matchingMarketSnapshot(detail);
  if (snapshot === undefined) {
    return undefined;
  }
  const quoteCurrency = snapshot.identity?.quoteCurrency ?? "USD";
  const change = formatLensValue(snapshot.changePercent24h, "whole-percent");

  return {
    displayName: snapshot.identity?.displayName?.trim() || snapshot.name?.trim() || snapshot.symbol,
    symbol: snapshot.symbol,
    price: formatLensValue(snapshot.price, "currency", quoteCurrency),
    quoteCurrency,
    dailyChange: snapshot.changePercent24h > 0 ? `+${change}` : change,
    changeDirection: dailyChangeDirection(snapshot.changePercent24h),
    asOf: `Yahoo quote · ${snapshot.observedAt}`,
    financials: headerFinancials(snapshot),
  };
}

function snapshotView(detail: RunDetail): RunWorkspaceSnapshotView | undefined {
  const { jobType, availableFiles } = detail.summary;
  if (
    (jobType !== "equity" && jobType !== "crypto") ||
    !availableFiles.includes(VERIFIED_SNAPSHOT_PATH)
  ) {
    return undefined;
  }

  const value = verifiedSnapshotValue(detail.verifiedMarketSnapshot);
  return value === undefined ? undefined : { value, tradingViewUrl: tradingViewUrl(value.symbol) };
}

export function buildRunWorkspaceView(detail: RunDetail): RunWorkspaceView {
  const { report } = detail;
  const summary = typeof report?.summary === "string" ? report.summary : "";
  const financialLensStats = financialLensStatTiles(detail.financialLenses);
  const financialLensGroups =
    detail.financialLenses?.lenses
      .map(
        (lens): RunWorkspaceFinancialLensGroup => ({
          lens: lens.name,
          posture: lens.posture,
          tiles: financialLensStats.filter((tile) => tile.lens === lens.name),
        }),
      )
      .filter((group) => group.tiles.length > 0) ?? [];
  const findings = textItems(report, "keyFindings");
  const cases = CASE_SECTIONS.map((section) => ({
    ...section,
    items: textItems(report, section.key),
  })).filter((section) => section.items.length > 0);
  const scenarioItems = scenarios(report);

  const forecastItems = scoredForecasts(report, detail.score, detail.missAutopsy);
  const targetHealth = predictionTargetHealth(detail.analytics, report);
  const splitGaps = splitDataGaps(stringArray(report, "dataGaps"));
  const forecastsVisible =
    forecastItems.length > 0 || splitGaps.shortfalls.length > 0 || targetHealth !== undefined;

  const historicalContext = historicalContextAuditView(detail.trace);
  const webSubjectProfile = webSubjectProfileView(report, detail.webSubjectProfile);
  const businessFramework = businessFrameworkView(report, detail.businessFramework);
  const extendedItems = extendedEvidenceItems(report);
  const snapshot = snapshotView(detail);
  const equityHeader = equityHeaderView(detail);
  const fundamentalHistory = fundamentalHistoryView(detail);
  const peerImpliedRange = peerImpliedRangeView(detail);
  const gapsVisible = splitGaps.shortfalls.length > 0 || splitGaps.otherGaps.length > 0;

  const tableOfContents = [
    { key: "summary", label: "Summary", visible: summary !== "" },
    {
      key: "financialLensStats",
      label: "Financial lens stats",
      visible: financialLensGroups.length > 0,
    },
    { key: "findings", label: "Key findings", visible: findings.length > 0 },
    { key: "cases", label: "Cases & risks", visible: cases.length > 0 },
    { key: "scenarios", label: "Scenarios", visible: scenarioItems.length > 0 },
    { key: "snapshot", label: "Market snapshot", visible: snapshot !== undefined },
    {
      key: "fundamentalHistory",
      label: "Fundamental history",
      visible: fundamentalHistory !== undefined,
    },
    {
      key: "peerImpliedRange",
      label: "Peer-implied price reference range",
      visible: peerImpliedRange !== undefined,
    },
    { key: "history", label: "Historical context", visible: historicalContext !== undefined },
    {
      key: "webSubjectProfile",
      label: "Web Subject Profile",
      visible: webSubjectProfile !== undefined,
    },
    {
      key: "businessFramework",
      label: "Business framework",
      visible: businessFramework !== undefined,
    },
    {
      key: "extendedEvidence",
      label: "Extended evidence",
      visible: extendedItems.length > 0,
    },
    { key: "forecasts", label: "Forecasts", visible: forecastsVisible },
    { key: "gaps", label: "Data gaps", visible: gapsVisible },
  ]
    .filter((entry) => entry.visible)
    .map(({ key, label }) => ({ key, label }));

  return {
    ...(equityHeader !== undefined ? { equityHeader } : {}),
    ...(fundamentalHistory !== undefined ? { fundamentalHistory } : {}),
    ...(peerImpliedRange !== undefined ? { peerImpliedRange } : {}),
    report: {
      summary,
      financialLensGroups,
      findings,
      cases,
      scenarios: scenarioItems,
      ...(detail.markdown !== undefined ? { markdown: detail.markdown } : {}),
    },
    forecasts: {
      items: forecastItems,
      groups: forecastGroups(forecastItems),
      stats: forecastRollup(forecastItems),
      horizons: horizonMarkers(forecastItems),
      ...(targetHealth !== undefined ? { targetHealth } : {}),
      visible: forecastsVisible,
    },
    evidence: {
      ...(historicalContext !== undefined ? { historicalContext } : {}),
      ...(webSubjectProfile !== undefined ? { webSubjectProfile } : {}),
      ...(businessFramework !== undefined ? { businessFramework } : {}),
      extendedItems,
    },
    gaps: { ...splitGaps, visible: gapsVisible },
    sources: { items: sources(report) },
    ...(snapshot !== undefined ? { snapshot } : {}),
    tableOfContents,
  };
}
