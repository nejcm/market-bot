import type { RunDetail } from "../types";
import { readGapTriage, type GapTriage } from "../../src/report/gap-triage";
import {
  resolveMarketSnapshotPriceAsOf,
  type EquityAnalysisDimensionStatus,
  type MarketSnapshot,
  type MarketSnapshotPriceAsOf,
} from "../../src/domain/types";
import { isRecord } from "../../src/guards";
import type {
  FinancialLensName,
  FinancialLensPosture,
} from "../../src/sources/extended-evidence/financial-lens";
import type {
  FundamentalHistoryArtifact,
  FundamentalHistoryPoint,
  FundamentalHistorySeriesKey,
} from "../../src/sources/extended-evidence/fundamental-history";
import {
  companyDescription,
  periodLabel,
  projectEquityReader,
  type EquityReaderAnalystEstimateDistribution,
  type EquityReaderAppendixCompleteness,
  type EquityReaderBalanceSheetHistory,
  type EquityReaderConsensusItem,
  type EquityReaderFinancialCoreStatus,
  type EquityReaderProjection,
  type EquityReaderValuationContext,
} from "../../src/report/equity-reader";
import type {
  PeerImpliedRange,
  ValuationCompsRow,
} from "../../src/sources/extended-evidence/valuation-comps";
import type {
  ValuationMetricResult,
  ValuationWorkbenchArtifact,
} from "../../src/sources/extended-evidence/valuation-workbench-contract";
import type { ReverseDcfArtifact } from "../../src/sources/extended-evidence/reverse-dcf";
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
  readonly sourceIds: readonly string[];
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
  readonly triagedGaps: readonly {
    readonly text: string;
    readonly triage: GapTriage;
  }[];
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
  readonly key:
    | "marketCap"
    | "trailingPE"
    | "forwardPE"
    | "forwardEPS"
    | "dividendYield"
    | "sharesOutstanding";
  readonly label: string;
  readonly value: string;
  readonly caption: string;
  readonly sourceIds: readonly string[];
}

export interface RunWorkspaceEquityHeaderView {
  readonly displayName: string;
  readonly symbol: string;
  readonly price?: string;
  readonly quoteCurrency?: string;
  readonly dailyChange?: string;
  readonly changeDirection?: "positive" | "negative" | "flat";
  readonly observedAt?: string;
  readonly priceAsOf?: MarketSnapshotPriceAsOf;
  readonly sourceIds: readonly string[];
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
  readonly sourceIds: readonly string[];
  readonly basis: "annual" | "ttm";
  readonly periodEnd: string;
  readonly filedAt: string;
  readonly pointCount: number;
  readonly disclosure?: string;
  readonly geometry: RunWorkspaceSparklineGeometry;
}

export interface RunWorkspaceFundamentalHistoryView {
  readonly cards: readonly RunWorkspaceFundamentalHistoryCard[];
}

export interface RunWorkspaceFinancialTrendRow {
  readonly period: string;
  readonly revenue: string;
  readonly netIncome: string;
  readonly operatingMargin: string;
  readonly freeCashFlow: string;
}

export interface RunWorkspaceFinancialTrendView {
  readonly columns: readonly ["Period", "Revenue", "Net income", "Operating margin", "FCF"];
  readonly reportingCurrency?: string;
  readonly sourceIds: readonly string[];
  readonly rows: readonly RunWorkspaceFinancialTrendRow[];
}

export interface RunWorkspaceBalanceSheetHistoryRow {
  readonly period: string;
  readonly cash: string;
  readonly debt: string;
  readonly dilutedShares: string;
}

export interface RunWorkspaceBalanceSheetHistoryView {
  readonly reportingCurrency?: string;
  readonly sourceIds: readonly string[];
  readonly rows: readonly RunWorkspaceBalanceSheetHistoryRow[];
}

export interface RunWorkspaceEarningsConsensusItem {
  readonly label: string;
  readonly value: string;
  readonly sourceIds: readonly string[];
}

export interface RunWorkspaceEarningsConsensusView {
  readonly items: readonly RunWorkspaceEarningsConsensusItem[];
}

export interface RunWorkspaceAnalystEstimateDistribution {
  readonly title: string;
  readonly period?: string;
  readonly mean: string;
  readonly median: string;
  readonly high: string;
  readonly low: string;
  readonly count: string;
  readonly sourceIds: readonly string[];
}

export interface RunWorkspaceCompletenessDimension {
  readonly key:
    | "primaryFinancials"
    | "valuation"
    | "expectations"
    | "capitalOwnership"
    | "operatingKpis";
  readonly label: string;
  readonly status: EquityAnalysisDimensionStatus;
  readonly reasonCodes: readonly string[];
  readonly asOf: string;
  readonly sourceIds: readonly string[];
}

export interface RunWorkspaceEquityCompletenessView {
  readonly financialCoreStatus: "complete" | "partial" | "blocked";
  readonly coverageLevel: "comprehensive" | "substantial" | "limited";
  readonly asOf: string;
  readonly dimensions: readonly RunWorkspaceCompletenessDimension[];
}

export interface RunWorkspacePeerImpliedRangeGeometry {
  readonly mid: number;
  readonly current: number;
}

export type RunWorkspacePeerImpliedRangeView =
  | {
      readonly status: "derived";
      readonly label: string;
      readonly sourceIds: readonly string[];
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
      readonly sourceIds: readonly string[];
      readonly suppressionReason: string;
      readonly message: string;
    };

export type RunWorkspaceEquitySnapshotState = "available" | "partial" | "unavailable";

export type RunWorkspaceEquitySnapshotDetailSectionKey =
  | "snapshot"
  | "equityCompleteness"
  | "peerImpliedRange"
  | "fundamentalHistory"
  | "financialLensStats"
  | "cases";

export interface RunWorkspaceEquitySnapshotCard {
  readonly key: string;
  readonly label: string;
  readonly state: RunWorkspaceEquitySnapshotState;
  readonly detailSectionKey: RunWorkspaceEquitySnapshotDetailSectionKey;
  readonly detailSectionMounted: boolean;
  readonly sourceIds: readonly string[];
}

export interface RunWorkspaceEquitySnapshotPricePerformance extends RunWorkspaceEquitySnapshotCard {
  readonly key: "pricePerformance";
  readonly price?: string;
  readonly change24h?: string;
  readonly changeDirection?: "positive" | "negative" | "flat";
  readonly quoteCurrency?: string;
  readonly observedAt?: string;
  readonly priceAsOf?: MarketSnapshotPriceAsOf;
}

export interface RunWorkspaceEquitySnapshotCompletenessDimension extends Omit<
  RunWorkspaceCompletenessDimension,
  "reasonCodes"
> {
  readonly reasons: readonly string[];
}

export interface RunWorkspaceEquitySnapshotCompleteness extends RunWorkspaceEquitySnapshotCard {
  readonly key: "analysisCompleteness";
  readonly financialCoreStatus?: RunWorkspaceEquityCompletenessView["financialCoreStatus"];
  readonly coverageLevel?: RunWorkspaceEquityCompletenessView["coverageLevel"];
  readonly asOf?: string;
  readonly dimensions: readonly RunWorkspaceEquitySnapshotCompletenessDimension[];
}

export interface RunWorkspaceEquitySnapshotReferenceRange extends RunWorkspaceEquitySnapshotCard {
  readonly key: "peerReferenceRange";
  readonly display: string;
  readonly positionLabel?: string;
  readonly disclosure: string;
}

export interface RunWorkspaceEquitySnapshotMetric {
  readonly key:
    | "ttmRevenue"
    | "ttmFreeCashFlowProxy"
    | "ttmDilutedEps"
    | "ttmOperatingMargin"
    | "forwardPE"
    | "forwardEPS"
    | "marketCap"
    | "trailingPE"
    | "dividendYield"
    | "sharesOutstanding";
  readonly label: string;
  readonly state: "available" | "unavailable";
  readonly value?: string;
  readonly dateBasis?: string;
  readonly sourceIds: readonly string[];
}

export interface RunWorkspaceEquitySnapshotKeyMetrics extends RunWorkspaceEquitySnapshotCard {
  readonly key: "keyDatedMetrics";
  readonly metrics: readonly RunWorkspaceEquitySnapshotMetric[];
  readonly foldedYahooMetrics: readonly RunWorkspaceEquitySnapshotMetric[];
}

export interface RunWorkspaceEquitySnapshotMiniChart extends RunWorkspaceEquitySnapshotCard {
  readonly key: "revenue" | "freeCashFlowProxy" | "operatingMargin" | "dilutedEps";
  readonly value?: string;
  readonly period?: string;
  readonly geometry?: RunWorkspaceSparklineGeometry;
}

export interface RunWorkspaceEquitySnapshotMiniCharts {
  readonly key: "miniCharts";
  readonly label: string;
  readonly state: RunWorkspaceEquitySnapshotState;
  readonly charts: readonly RunWorkspaceEquitySnapshotMiniChart[];
}

export interface RunWorkspaceEquitySnapshotLensPosture {
  readonly lens: FinancialLensName;
  readonly posture: FinancialLensPosture;
  readonly postureLabel: string;
  readonly sourceIds: readonly string[];
}

export interface RunWorkspaceEquitySnapshotDriverCard extends RunWorkspaceEquitySnapshotCard {
  readonly key: "bullCaseDrivers" | "bearCaseDrivers";
  readonly items: readonly RunWorkspaceTextItem[];
}

export interface RunWorkspaceEquitySnapshotFinancialLensDrivers {
  readonly key: "financialLensDrivers";
  readonly label: string;
  readonly state: RunWorkspaceEquitySnapshotState;
  readonly postures: RunWorkspaceEquitySnapshotCard & {
    readonly key: "lensPostures";
    readonly items: readonly RunWorkspaceEquitySnapshotLensPosture[];
  };
  readonly bullCase: RunWorkspaceEquitySnapshotDriverCard;
  readonly bearCase: RunWorkspaceEquitySnapshotDriverCard;
}

export interface RunWorkspaceEquitySnapshotView {
  readonly pricePerformance: RunWorkspaceEquitySnapshotPricePerformance;
  readonly analysisCompleteness: RunWorkspaceEquitySnapshotCompleteness;
  readonly peerReferenceRange: RunWorkspaceEquitySnapshotReferenceRange;
  readonly keyDatedMetrics: RunWorkspaceEquitySnapshotKeyMetrics;
  readonly miniCharts: RunWorkspaceEquitySnapshotMiniCharts;
  readonly financialLensDrivers: RunWorkspaceEquitySnapshotFinancialLensDrivers;
}

export interface RunWorkspaceValuationMetricCell {
  readonly display: string;
  readonly status: ValuationMetricResult["status"];
  readonly detail?: string;
}

export interface RunWorkspaceHistoricalValuationRow {
  readonly basis: string;
  readonly periodEnd: string;
  readonly publicAt: string;
  readonly price: string;
  readonly priceToEarnings: RunWorkspaceValuationMetricCell;
  readonly priceToSales: RunWorkspaceValuationMetricCell;
  readonly enterpriseValueToRevenue: RunWorkspaceValuationMetricCell;
  readonly priceToFreeCashFlow: RunWorkspaceValuationMetricCell;
}

export interface RunWorkspaceValuationPeerRow {
  readonly symbol: string;
  readonly role: string;
  readonly status: string;
  readonly multiple: string;
  readonly currency: string;
  readonly inputDates: string;
}

export interface RunWorkspaceExcludedValuationPeerRow {
  readonly symbol: string;
  readonly role: string;
  readonly reason: string;
  readonly sourceIds: readonly string[];
}

export interface RunWorkspaceValuationWorkbenchView {
  readonly reportingCurrency: string;
  readonly quoteCurrency: string;
  readonly priceSelectionRule: string;
  readonly trailingDisclosure: string;
  readonly rows: readonly RunWorkspaceHistoricalValuationRow[];
  readonly suppressionReasons: readonly string[];
  readonly peerSupportability: string;
  readonly peerSuppression?: string;
  readonly peerRows: readonly RunWorkspaceValuationPeerRow[];
  readonly excludedPeerRows: readonly RunWorkspaceExcludedValuationPeerRow[];
}

export type RunWorkspaceReverseDcfView =
  | {
      readonly status: "computed";
      readonly startingFcf: string;
      readonly startingFcfDates: string;
      readonly enterpriseValue: string;
      readonly enterpriseValueDate: string;
      readonly horizonYears: number;
      readonly terminalGrowthRatesPct: readonly number[];
      readonly rows: readonly {
        readonly discountRatePct: number;
        readonly cells: readonly string[];
      }[];
    }
  | {
      readonly status: "suppressed";
      readonly message: string;
    };

export interface RunWorkspaceTableOfContentsEntry {
  readonly key: string;
  readonly label: string;
}

export interface RunWorkspaceEquityPresentationView {
  readonly defaultView: {
    readonly pricePerformance: RunWorkspaceEquitySnapshotPricePerformance;
    readonly companySummary: RunWorkspaceTextItem;
    readonly financialTrends?: RunWorkspaceFinancialTrendView;
    readonly valuationContext: RunWorkspaceEquitySnapshotReferenceRange;
    readonly findings: readonly RunWorkspaceTextItem[];
    readonly cases: readonly RunWorkspaceCaseSection[];
    readonly earningsConsensus: RunWorkspaceEarningsConsensusView;
    readonly financialCoreStatus?: EquityReaderFinancialCoreStatus;
    readonly materialGaps: readonly string[];
  };
  readonly advanced: {
    readonly completeness?: EquityReaderAppendixCompleteness;
    readonly financialLensDrivers: RunWorkspaceEquitySnapshotFinancialLensDrivers;
    readonly financialLensGroups: readonly RunWorkspaceFinancialLensGroup[];
    readonly keyDatedMetrics: RunWorkspaceEquitySnapshotKeyMetrics;
    readonly miniCharts: RunWorkspaceEquitySnapshotMiniCharts;
    readonly valuationWorkbench?: RunWorkspaceValuationWorkbenchView;
    readonly reverseDcf?: RunWorkspaceReverseDcfView;
    readonly peerImpliedRange?: RunWorkspacePeerImpliedRangeView;
    readonly analystEstimateDistributions: readonly RunWorkspaceAnalystEstimateDistribution[];
    readonly extendedItems: readonly ExtendedEvidenceItemView[];
    readonly diagnosticGaps: readonly string[];
    readonly balanceSheetHistory?: RunWorkspaceBalanceSheetHistoryView;
    readonly cases: readonly RunWorkspaceCaseSection[];
    readonly scenarios: readonly ScenarioView[];
    readonly reportSummary: string;
  };
}

export interface RunWorkspaceView {
  readonly equityPresentation?: RunWorkspaceEquityPresentationView;
  readonly fundamentalHistory?: RunWorkspaceFundamentalHistoryView;
  readonly valuationWorkbench?: RunWorkspaceValuationWorkbenchView;
  readonly reverseDcf?: RunWorkspaceReverseDcfView;
  readonly peerImpliedRange?: RunWorkspacePeerImpliedRangeView;
  readonly report: RunWorkspaceReportView;
  readonly forecasts: RunWorkspaceForecastsView;
  readonly evidence: RunWorkspaceEvidenceView;
  readonly gaps: RunWorkspaceGapsView;
  readonly sources: RunWorkspaceSourcesView;
  readonly snapshot?: RunWorkspaceSnapshotView;
  readonly tableOfContents: readonly RunWorkspaceTableOfContentsEntry[];
}

const COMPLETENESS_DIMENSIONS: readonly {
  readonly key: RunWorkspaceCompletenessDimension["key"];
  readonly label: string;
}[] = [
  { key: "primaryFinancials", label: "Primary financials" },
  { key: "valuation", label: "Valuation" },
  { key: "expectations", label: "Expectations" },
  { key: "capitalOwnership", label: "Capital & ownership" },
  { key: "operatingKpis", label: "Operating KPIs" },
];

export const COMPLETENESS_REASON_CODE_LABELS: Readonly<Record<string, string>> = {
  "annual-as-current": "Annual statement remains current",
  "annual-history-insufficient": "Annual history is insufficient",
  "cadence-unestablished": "Reporting cadence is not established",
  "current-annual-statement-missing": "Current annual statement is missing",
  "current-primary-statements-incomplete": "Current primary statements are incomplete",
  "debt-maturity-untagged": "Debt maturity evidence is untagged",
  "diluted-share-history-missing": "Diluted-share history is missing",
  "expectations-evidence-missing": "Expectations evidence is missing",
  "expectations-inputs-incomplete": "Expectations inputs are incomplete",
  "expectations-provider-credential-missing": "Expectations provider credential is missing",
  "expectations-provider-entitlement-blocked": "Expectations provider access is restricted",
  "irregular-comparison-missing": "Comparable irregular-period evidence is missing",
  "latest-due-interim-missing": "Latest due interim statement is missing",
  "operating-kpi-not-applicable": "Operating KPIs are not applicable",
  "operating-kpi-not-applicable-evidence-missing":
    "Operating KPI non-applicability evidence is missing",
  "operating-kpi-registry-unconfigured": "Operating KPI registry is not configured",
  "operating-kpi-unverified": "Operating KPI is unverified",
  "ownership-external-context-available": "External ownership context is available",
  "ownership-provider-credential-missing": "Ownership provider credential is missing",
  "ownership-provider-entitlement-blocked": "Ownership provider access is restricted",
  "payout-evidence-missing": "Payout evidence is missing",
  "per-share-evidence-missing": "Per-share evidence is missing",
  "quarterly-periods-insufficient": "Quarterly history is insufficient",
  "reporting-currency-incompatible": "Reporting currency evidence is inconsistent",
  "reporting-currency-missing": "Reporting currency is missing",
  "sbc-history-missing": "Stock-based compensation history is missing",
  "semiannual-comparison-missing": "Comparable semiannual evidence is missing",
  "subsequent-financing-unreconciled": "Subsequent financing is unreconciled",
  "ttm-unreconciled": "Trailing twelve-month evidence is unreconciled",
  "untagged-interim-evidence": "Interim evidence is untagged",
  "valuation-evidence-missing": "Valuation evidence is missing",
  "valuation-inputs-incomplete": "Valuation inputs are incomplete",
};

function readableReasonCodeFragment(value: string): string {
  return value.replaceAll("-", " ").trim() || "Unspecified completeness detail";
}

export function completenessReasonCodeLabel(reasonCode: string): string {
  const exactLabel = COMPLETENESS_REASON_CODE_LABELS[reasonCode];
  if (exactLabel !== undefined) {
    return exactLabel;
  }
  const separatorIndex = reasonCode.indexOf(":");
  if (separatorIndex === -1) {
    return readableReasonCodeFragment(reasonCode);
  }
  const prefix = reasonCode.slice(0, separatorIndex);
  const suffix = reasonCode.slice(separatorIndex + 1);
  const prefixLabel = COMPLETENESS_REASON_CODE_LABELS[prefix] ?? readableReasonCodeFragment(prefix);
  return suffix.trim() === ""
    ? prefixLabel
    : `${prefixLabel}: ${readableReasonCodeFragment(suffix)}`;
}

function stringArrayValue(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

export function equityCompletenessView(
  detail: RunDetail,
): RunWorkspaceEquityCompletenessView | undefined {
  const completeness = detail.report?.equityAnalysisCompleteness;
  const rawDimensions = isRecord(completeness) ? completeness.dimensions : undefined;
  if (
    !isRecord(completeness) ||
    completeness.version !== 1 ||
    (completeness.financialCoreStatus !== "complete" &&
      completeness.financialCoreStatus !== "partial" &&
      completeness.financialCoreStatus !== "blocked") ||
    (completeness.coverageLevel !== "comprehensive" &&
      completeness.coverageLevel !== "substantial" &&
      completeness.coverageLevel !== "limited") ||
    typeof completeness.asOf !== "string" ||
    !isRecord(rawDimensions)
  ) {
    return undefined;
  }
  const dimensions = COMPLETENESS_DIMENSIONS.flatMap(({ key, label }) => {
    const dimension = rawDimensions[key];
    if (
      !isRecord(dimension) ||
      (dimension.status !== "complete" &&
        dimension.status !== "partial" &&
        dimension.status !== "blocked" &&
        dimension.status !== "not-applicable" &&
        dimension.status !== "not-assessed") ||
      typeof dimension.asOf !== "string"
    ) {
      return [];
    }
    const reasonCodes = stringArrayValue(dimension.reasonCodes);
    const sourceIds = stringArrayValue(dimension.sourceIds);
    if (reasonCodes === undefined || sourceIds === undefined) {
      return [];
    }
    const item: RunWorkspaceCompletenessDimension = {
      key,
      label,
      status: dimension.status,
      reasonCodes,
      asOf: dimension.asOf,
      sourceIds,
    };
    return [item];
  });
  if (dimensions.length !== COMPLETENESS_DIMENSIONS.length) {
    return undefined;
  }
  return {
    financialCoreStatus: completeness.financialCoreStatus,
    coverageLevel: completeness.coverageLevel,
    asOf: completeness.asOf,
    dimensions,
  };
}

function formatReferencePrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

const PEER_IMPLIED_RANGE_POSITION_LABELS = {
  "below-range": "Below range",
  "within-range": "Within range",
  "above-range": "Above range",
} satisfies Record<Extract<PeerImpliedRange, { status: "derived" }>["position"], string>;

const PEER_REFERENCE_RANGE_LABEL = "Peer-implied price reference range";

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

function priceAsOfLabel(priceAsOf: MarketSnapshotPriceAsOf): string {
  return `${priceAsOf.kind === "quote-time" ? "quote time" : "fetch time"} ${priceAsOf.instant}`;
}

function valuationRowPriceAsOf(row: ValuationCompsRow): MarketSnapshotPriceAsOf | undefined {
  return (
    row.priceAsOf ??
    (row.quoteObservedAt === undefined
      ? undefined
      : { kind: "fetch-time-only", instant: row.quoteObservedAt })
  );
}

function valuationTargetPriceAsOf(
  detail: RunDetail,
  fallbackFetchTime: string | null | undefined,
): MarketSnapshotPriceAsOf | undefined {
  if (detail.valuationWorkbench?.peerComparison.status === "available") {
    return valuationRowPriceAsOf(detail.valuationWorkbench.peerComparison.valuationComps.target);
  }
  return fallbackFetchTime === null || fallbackFetchTime === undefined
    ? undefined
    : { kind: "fetch-time-only", instant: fallbackFetchTime };
}

function valuationRowInputDates(row: ValuationCompsRow): string {
  const priceAsOf = valuationRowPriceAsOf(row);
  return (
    [
      ...(priceAsOf === undefined ? [] : [priceAsOfLabel(priceAsOf)]),
      ...(row.revenuePeriodEnd === undefined ? [] : [`revenue ${row.revenuePeriodEnd}`]),
      ...(row.cashPeriodEnd === undefined ? [] : [`cash ${row.cashPeriodEnd}`]),
      ...(row.debtPeriodEnd === undefined ? [] : [`debt ${row.debtPeriodEnd}`]),
    ].join(" · ") || "—"
  );
}

export function peerImpliedRangeView(
  detail: RunDetail,
): RunWorkspacePeerImpliedRangeView | undefined {
  return peerImpliedRangeFromProjection(
    projectEquityReaderForDetail(detail).defaultView.valuationContext,
  );
}

function peerImpliedRangeFromProjection(
  valuation: EquityReaderValuationContext,
): RunWorkspacePeerImpliedRangeView | undefined {
  if (valuation.kind !== "peer-range") {
    return undefined;
  }
  const { range, sourceIds } = valuation;
  const { label } = range;
  if (valuation.status === "suppressed") {
    return {
      status: "suppressed",
      label,
      sourceIds,
      suppressionReason: valuation.range.suppressedReason,
      message: `Reference range suppressed: ${valuation.range.suppressedReason}.`,
    };
  }
  const { inputs } = valuation.range;
  const { priceAsOf } = valuation;
  const priceDate = priceAsOf === undefined ? "price time unavailable" : priceAsOfLabel(priceAsOf);
  return {
    status: "derived",
    label,
    sourceIds,
    position: valuation.range.position,
    positionLabel: PEER_IMPLIED_RANGE_POSITION_LABELS[valuation.range.position],
    lowLabel: `Low ${formatReferencePrice(valuation.range.low)}`,
    midLabel: `Mid ${formatReferencePrice(valuation.range.mid)}`,
    highLabel: `High ${formatReferencePrice(valuation.range.high)}`,
    currentLabel: `Current price ${formatReferencePrice(inputs.currentPrice)}`,
    methodDisclosure: `Method: ${valuation.range.basis}; ${valuation.range.formula}. Inputs: P25 ${inputs.peerP25EvToAnnualizedRevenue.toFixed(2)}x, median ${inputs.peerMedianEvToAnnualizedRevenue.toFixed(2)}x, P75 ${inputs.peerP75EvToAnnualizedRevenue.toFixed(2)}x; annualized revenue ${formatLensValue(inputs.annualizedRevenue, "currency", "USD")}, net debt ${formatLensValue(inputs.netDebt, "currency", "USD")}, shares ${scaleCurrency(inputs.sharesOutstanding)}, current price ${formatReferencePrice(inputs.currentPrice)}, Yahoo price ${priceDate}.`,
    boundaryDisclosure: "Boundary rule: prices equal to low or high are within range.",
    geometry: rangeGeometry(valuation.range),
  };
}

function valuationMetricCell(metric: ValuationMetricResult): RunWorkspaceValuationMetricCell {
  if (metric.status === "suppressed") {
    return { display: metric.display, status: metric.status, detail: metric.detail };
  }
  if (metric.status === "not-applicable") {
    return { display: metric.display, status: metric.status, detail: metric.rationale };
  }
  if (metric.status === "not-meaningful") {
    return {
      display: metric.display,
      status: metric.status,
      detail: metric.reason.replaceAll("-", " "),
    };
  }
  return { display: metric.display, status: metric.status };
}

function valuationPeerRows(
  artifact: ValuationWorkbenchArtifact,
): readonly RunWorkspaceValuationPeerRow[] {
  if (artifact.peerComparison.status === "suppressed") {
    return [];
  }
  const { valuationComps } = artifact.peerComparison;
  return [valuationComps.target, ...valuationComps.peers].map((row) => ({
    symbol: row.symbol,
    role: row.symbol === valuationComps.target.symbol ? "target" : (row.role ?? "peer"),
    status: row.usable ? "usable" : "excluded",
    multiple:
      row.evToAnnualizedRevenue === undefined ? "N/M" : `${row.evToAnnualizedRevenue.toFixed(2)}x`,
    currency: row.quoteCurrency ?? "—",
    inputDates: valuationRowInputDates(row),
  }));
}

export function valuationWorkbenchView(
  detail: RunDetail,
): RunWorkspaceValuationWorkbenchView | undefined {
  const artifact = detail.valuationWorkbench;
  if (artifact === undefined) {
    return undefined;
  }
  const { trailingBasis } = artifact.historicalMultiples;
  const peerSupportability =
    artifact.peerComparison.status === "available"
      ? artifact.peerComparison.valuationComps.summary.valuationSupportability
      : "suppressed";
  return {
    reportingCurrency: artifact.reportingCurrency ?? "unavailable",
    quoteCurrency: artifact.quoteCurrency ?? "unavailable",
    priceSelectionRule: artifact.historicalMultiples.priceSelectionRule,
    trailingDisclosure:
      trailingBasis.status === "available"
        ? `Reconciled TTM through ${trailingBasis.periodEnd}, public ${trailingBasis.publicAt}`
        : trailingBasis.detail,
    rows: artifact.historicalMultiples.observations.map((observation) => ({
      basis: observation.basis.toUpperCase(),
      periodEnd: observation.periodEnd,
      publicAt: observation.publicAt,
      price:
        observation.price === null
          ? "—"
          : `${observation.price.close.toFixed(2)} ${observation.price.currency} · ${observation.price.sessionDate}`,
      priceToEarnings: valuationMetricCell(observation.metrics.priceToEarnings),
      priceToSales: valuationMetricCell(observation.metrics.priceToSales),
      enterpriseValueToRevenue: valuationMetricCell(observation.metrics.enterpriseValueToRevenue),
      priceToFreeCashFlow: valuationMetricCell(observation.metrics.priceToFreeCashFlow),
    })),
    suppressionReasons: artifact.historicalMultiples.suppressionReasons,
    peerSupportability,
    ...(artifact.peerComparison.status === "suppressed"
      ? { peerSuppression: artifact.peerComparison.detail }
      : {}),
    peerRows: valuationPeerRows(artifact),
    excludedPeerRows:
      artifact.peerComparison.status === "available"
        ? artifact.peerComparison.valuationComps.excludedPeers.map((peer) => ({
            symbol: peer.symbol,
            role: peer.role,
            reason: peer.reason,
            sourceIds: peer.sourceIds,
          }))
        : [],
  };
}

function formatReverseDcfAmount(value: number, currency: string): string {
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value)} ${currency}`;
}

export function reverseDcfView(detail: RunDetail): RunWorkspaceReverseDcfView | undefined {
  const artifact: ReverseDcfArtifact | undefined = detail.reverseDcf;
  if (artifact === undefined) {
    return undefined;
  }
  if (artifact.status === "suppressed") {
    return {
      status: "suppressed",
      message: `${artifact.reason}: ${artifact.detail}`,
    };
  }
  const priceAsOf = valuationTargetPriceAsOf(
    detail,
    artifact.assumptions.enterpriseValue.observedAt,
  );
  return {
    status: "computed",
    startingFcf: formatReverseDcfAmount(
      artifact.assumptions.startingFcf.value,
      artifact.assumptions.startingFcf.currency,
    ),
    startingFcfDates: `period ${artifact.assumptions.startingFcf.periodEnd} · public ${artifact.assumptions.startingFcf.publicAt}`,
    enterpriseValue: formatReverseDcfAmount(
      artifact.assumptions.enterpriseValue.value,
      artifact.assumptions.enterpriseValue.currency,
    ),
    enterpriseValueDate:
      priceAsOf === undefined
        ? `fetch time ${artifact.assumptions.enterpriseValue.observedAt}`
        : priceAsOfLabel(priceAsOf),
    horizonYears: artifact.assumptions.horizonYears,
    terminalGrowthRatesPct: artifact.assumptions.terminalGrowthRatesPct,
    rows: artifact.grid.rows.map((row) => ({
      discountRatePct: row.discountRatePct,
      cells: row.cells.map((cell) =>
        cell.status === "solved" ? `${cell.solvedFiveYearFcfGrowthPct.toFixed(2)}%` : "not solved",
      ),
    })),
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
        sourceIds: [artifact.sourceId],
        basis: latest.form === "TTM" ? ("ttm" as const) : ("annual" as const),
        periodEnd: latest.periodEnd,
        filedAt: latest.filedAt,
        pointCount: points.length,
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

export function financialTrendView(detail: RunDetail): RunWorkspaceFinancialTrendView | undefined {
  return financialTrendFromProjection(
    projectEquityReaderForDetail(detail).defaultView.financialTrends,
  );
}

function financialTrendFromProjection(
  trends: EquityReaderProjection["defaultView"]["financialTrends"],
): RunWorkspaceFinancialTrendView | undefined {
  if (trends === undefined) {
    return undefined;
  }
  return {
    columns: ["Period", "Revenue", "Net income", "Operating margin", "FCF"],
    ...(trends.reportingCurrency === undefined
      ? {}
      : { reportingCurrency: trends.reportingCurrency }),
    sourceIds: trends.sourceIds,
    rows: trends.rows,
  };
}

function statementAmount(value: number | undefined, currency: string | undefined): string {
  if (value === undefined) {
    return "—";
  }
  return currency === undefined
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)
    : formatLensValue(value, "currency", currency);
}

export function balanceSheetHistoryView(
  detail: RunDetail,
): RunWorkspaceBalanceSheetHistoryView | undefined {
  return balanceSheetHistoryFromProjection(
    projectEquityReaderForDetail(detail).appendix.balanceSheetHistory,
  );
}

function balanceSheetHistoryFromProjection(
  history: EquityReaderBalanceSheetHistory | undefined,
): RunWorkspaceBalanceSheetHistoryView | undefined {
  if (history === undefined) {
    return undefined;
  }
  return {
    ...(history.reportingCurrency === undefined
      ? {}
      : { reportingCurrency: history.reportingCurrency }),
    sourceIds: history.sourceIds,
    rows: history.rows.map((row) => ({
      period: periodLabel(row),
      cash: statementAmount(row.cash?.value, history.reportingCurrency),
      debt: statementAmount(row.debt?.value, history.reportingCurrency),
      dilutedShares: row.dilutedShares === undefined ? "—" : scaleCurrency(row.dilutedShares.value),
    })),
  };
}

function compactNumber(value: number): string {
  const absolute = Math.abs(value);
  for (const [scale, suffix] of [
    [1_000_000_000_000, "T"],
    [1_000_000_000, "B"],
    [1_000_000, "M"],
  ] as const) {
    if (absolute >= scale) {
      return `${(value / scale).toFixed(1)}${suffix}`;
    }
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export function earningsConsensusView(
  report: Record<string, unknown> | undefined,
): RunWorkspaceEarningsConsensusView {
  return earningsConsensusFromProjection(
    projectEquityReader({ report }).defaultView.earningsConsensus,
  );
}

function earningsConsensusFromProjection(
  items: readonly EquityReaderConsensusItem[],
): RunWorkspaceEarningsConsensusView {
  return {
    items: items.map((item) => {
      if (item.kind === "earnings-date") {
        return {
          label: "Upcoming earnings",
          value: `${item.date} · ${item.timing} · ${item.status}`,
          sourceIds: item.sourceIds,
        };
      }
      if (item.kind === "eps-consensus") {
        return {
          label: "EPS consensus",
          value: `${String(item.value)} · single-provider snapshot`,
          sourceIds: item.sourceIds,
        };
      }
      if (item.kind === "revenue-consensus") {
        return {
          label: "Revenue consensus",
          value: `${compactNumber(item.value)} · single-provider snapshot`,
          sourceIds: item.sourceIds,
        };
      }
      return {
        label: item.title,
        value: `Mean ${compactNumber(item.mean)}${item.period === undefined ? "" : ` for ${item.period}`}${item.count === undefined ? "" : ` · ${String(item.count)} estimates`}`,
        sourceIds: item.sourceIds,
      };
    }),
  };
}

function analystEstimateDistributionsFromProjection(
  distributions: readonly EquityReaderAnalystEstimateDistribution[],
): readonly RunWorkspaceAnalystEstimateDistribution[] {
  const value = (item: number | undefined): string =>
    item === undefined ? "—" : compactNumber(item);
  return distributions.map((distribution) => ({
    title: distribution.title,
    ...(distribution.period === undefined ? {} : { period: distribution.period }),
    mean: value(distribution.mean),
    median: value(distribution.median),
    high: value(distribution.high),
    low: value(distribution.low),
    count: distribution.count === undefined ? "—" : String(distribution.count),
    sourceIds: distribution.sourceIds,
  }));
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

function projectEquityReaderForDetail(detail: RunDetail): EquityReaderProjection {
  const marketSnapshot = matchingMarketSnapshot(detail);
  return projectEquityReader({
    report: detail.report,
    ...(marketSnapshot === undefined ? {} : { marketSnapshot }),
    ...(detail.fundamentalHistory === undefined
      ? {}
      : { fundamentalHistory: detail.fundamentalHistory }),
    ...(detail.financialStatements === undefined
      ? {}
      : { financialStatements: detail.financialStatements }),
    ...(detail.valuationWorkbench === undefined
      ? {}
      : { valuationWorkbench: detail.valuationWorkbench }),
    ...(detail.peerImpliedRange === undefined ? {} : { peerImpliedRange: detail.peerImpliedRange }),
    ...(detail.sourceGaps === undefined ? {} : { sourceGaps: detail.sourceGaps }),
  });
}

function renderedPriceSummary(
  summary: string,
  sourceIds: readonly string[],
  marketSnapshot: MarketSnapshot | undefined,
): string {
  if (marketSnapshot === undefined || !sourceIds.includes(marketSnapshot.sourceId)) {
    return summary;
  }
  const priceAsOf = resolveMarketSnapshotPriceAsOf(marketSnapshot);
  const label = priceAsOfLabel(priceAsOf);
  const fetchDate = marketSnapshot.observedAt.slice(0, 10);
  return summary
    .replaceAll(`market cap as of ${fetchDate}`, `market cap ${label}`)
    .replaceAll(`market cap (quote ${fetchDate})`, `market cap (${label})`);
}

function headerFinancials(snapshot: MarketSnapshot): readonly RunWorkspaceEquityHeaderFinancial[] {
  const quoteCurrency = snapshot.identity?.quoteCurrency;
  const priceDate = priceAsOfLabel(resolveMarketSnapshotPriceAsOf(snapshot));
  const sourceIds = snapshot.sourceId.trim() === "" ? [] : [snapshot.sourceId];
  const candidates: readonly (RunWorkspaceEquityHeaderFinancial | undefined)[] = [
    snapshot.marketCap === undefined || quoteCurrency === undefined
      ? undefined
      : {
          key: "marketCap",
          label: "Market cap",
          value: formatLensValue(snapshot.marketCap, "currency", quoteCurrency),
          caption: `Yahoo quote · point in time · ${priceDate}`,
          sourceIds,
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
          caption: `Yahoo quote · trailing 12M · ${priceDate}`,
          sourceIds,
        },
    snapshot.fundamentals?.forwardPE === undefined
      ? undefined
      : {
          key: "forwardPE",
          label: "Forward P/E",
          value: formatPeRatio(snapshot.fundamentals.forwardPE, snapshot.fundamentals.epsForward),
          caption: `Yahoo quote · forward · ${priceDate}`,
          sourceIds,
        },
    snapshot.fundamentals?.epsForward === undefined
      ? undefined
      : {
          key: "forwardEPS",
          label: "Forward EPS",
          value: (() => {
            const value = formatLensValue(snapshot.fundamentals.epsForward, "number");
            const symbol =
              quoteCurrency === undefined ? undefined : CURRENCY_SYMBOLS[quoteCurrency];
            return symbol === undefined ? value : `${symbol}${value}`;
          })(),
          caption: `Yahoo quote · forward · ${priceDate}`,
          sourceIds,
        },
    snapshot.fundamentals?.dividendYield === undefined
      ? undefined
      : {
          key: "dividendYield",
          label: "Dividend yield",
          value: formatLensValue(snapshot.fundamentals.dividendYield, "whole-percent"),
          caption: `Yahoo quote · quote snapshot · ${priceDate}`,
          sourceIds,
        },
    snapshot.fundamentals?.sharesOutstanding === undefined
      ? undefined
      : {
          key: "sharesOutstanding",
          label: "Shares outstanding",
          value: scaleCurrency(snapshot.fundamentals.sharesOutstanding),
          caption: `Yahoo quote · point in time · ${priceDate}`,
          sourceIds,
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
  const quoteCurrency = snapshot.identity?.quoteCurrency;
  const hasPrice = Number.isFinite(snapshot.price);
  const hasChange = Number.isFinite(snapshot.changePercent24h);
  const change = hasChange
    ? formatLensValue(snapshot.changePercent24h, "whole-percent")
    : undefined;
  const observedAt = snapshot.observedAt.trim() || undefined;
  const priceAsOf = resolveMarketSnapshotPriceAsOf(snapshot);
  const sourceIds = snapshot.sourceId.trim() === "" ? [] : [snapshot.sourceId];

  return {
    displayName: snapshot.identity?.displayName?.trim() || snapshot.name?.trim() || snapshot.symbol,
    symbol: snapshot.symbol,
    ...(hasPrice
      ? {
          price:
            quoteCurrency === undefined
              ? formatLensValue(snapshot.price, "number")
              : formatLensValue(snapshot.price, "currency", quoteCurrency),
        }
      : {}),
    ...(quoteCurrency === undefined ? {} : { quoteCurrency }),
    ...(change === undefined
      ? {}
      : {
          dailyChange: snapshot.changePercent24h > 0 ? `+${change}` : change,
          changeDirection: dailyChangeDirection(snapshot.changePercent24h),
        }),
    ...(observedAt === undefined ? {} : { observedAt }),
    priceAsOf,
    sourceIds,
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

function uniqueSourceIds(sourceIds: readonly string[]): readonly string[] {
  return [...new Set(sourceIds.filter((sourceId) => sourceId.trim() !== ""))];
}

function financialLensGroupViews(detail: RunDetail): readonly RunWorkspaceFinancialLensGroup[] {
  const financialLensStats = financialLensStatTiles(
    detail.financialLenses,
    detail.marketSnapshots ?? [],
  );
  return (
    detail.financialLenses?.lenses.map(
      (lens): RunWorkspaceFinancialLensGroup => ({
        lens: lens.name,
        posture: lens.posture,
        sourceIds: lens.sourceIds,
        tiles: financialLensStats.filter((tile) => tile.lens === lens.name),
      }),
    ) ?? []
  );
}

function reportCaseSections(
  report: Record<string, unknown> | undefined,
): readonly RunWorkspaceCaseSection[] {
  return CASE_SECTIONS.map((section) => ({
    ...section,
    items: textItems(report, section.key),
  })).filter((section) => section.items.length > 0);
}

interface EquitySnapshotProjectionInputs {
  readonly equityHeader?: RunWorkspaceEquityHeaderView;
  readonly equityCompleteness?: RunWorkspaceEquityCompletenessView;
  readonly peerImpliedRange?: RunWorkspacePeerImpliedRangeView;
  readonly fundamentalHistory?: RunWorkspaceFundamentalHistoryView;
  readonly financialLensGroups: readonly RunWorkspaceFinancialLensGroup[];
  readonly cases: readonly RunWorkspaceCaseSection[];
  readonly marketSnapshotMounted: boolean;
}

const SNAPSHOT_TTM_METRICS: readonly {
  readonly key: Extract<
    RunWorkspaceEquitySnapshotMetric["key"],
    "ttmRevenue" | "ttmFreeCashFlowProxy" | "ttmDilutedEps" | "ttmOperatingMargin"
  >;
  readonly historyKey: RunWorkspaceFundamentalHistoryCard["key"];
  readonly label: string;
}[] = [
  { key: "ttmRevenue", historyKey: "revenue", label: "TTM revenue" },
  {
    key: "ttmFreeCashFlowProxy",
    historyKey: "freeCashFlowProxy",
    label: "TTM FCF proxy",
  },
  { key: "ttmDilutedEps", historyKey: "dilutedEps", label: "TTM diluted EPS" },
  {
    key: "ttmOperatingMargin",
    historyKey: "operatingMargin",
    label: "TTM operating margin",
  },
];

const SNAPSHOT_CHARTS: readonly {
  readonly key: RunWorkspaceEquitySnapshotMiniChart["key"];
  readonly label: string;
}[] = [
  { key: "revenue", label: "Revenue" },
  { key: "freeCashFlowProxy", label: "FCF proxy" },
  { key: "operatingMargin", label: "Operating margin" },
  { key: "dilutedEps", label: "Diluted EPS" },
];

const FOLDED_YAHOO_METRIC_KEYS = new Set<RunWorkspaceEquityHeaderFinancial["key"]>([
  "marketCap",
  "trailingPE",
  "dividendYield",
  "sharesOutstanding",
]);

function snapshotState(
  availableCount: number,
  expectedCount: number,
): RunWorkspaceEquitySnapshotState {
  if (availableCount === 0) {
    return "unavailable";
  }
  return availableCount === expectedCount ? "available" : "partial";
}

function snapshotTtmMetric(
  definition: (typeof SNAPSHOT_TTM_METRICS)[number],
  fundamentalHistory: RunWorkspaceFundamentalHistoryView | undefined,
): RunWorkspaceEquitySnapshotMetric {
  const card = fundamentalHistory?.cards.find(
    (candidate) => candidate.key === definition.historyKey && candidate.basis === "ttm",
  );
  if (card === undefined) {
    return {
      key: definition.key,
      label: definition.label,
      state: "unavailable",
      sourceIds: [],
    };
  }
  return {
    key: definition.key,
    label: definition.label,
    state: "available",
    value: card.value,
    dateBasis: `period ${card.periodEnd} · filed ${card.filedAt}`,
    sourceIds: card.sourceIds,
  };
}

function snapshotForwardMetric(
  key: "forwardPE" | "forwardEPS",
  label: string,
  equityHeader: RunWorkspaceEquityHeaderView | undefined,
): RunWorkspaceEquitySnapshotMetric {
  const financial = equityHeader?.financials.find((candidate) => candidate.key === key);
  if (financial === undefined) {
    return { key, label, state: "unavailable", sourceIds: [] };
  }
  return {
    key,
    label,
    state: "available",
    value: financial.value,
    ...(equityHeader?.priceAsOf === undefined
      ? {}
      : { dateBasis: priceAsOfLabel(equityHeader.priceAsOf) }),
    sourceIds: financial.sourceIds,
  };
}

function foldedYahooMetric(
  financial: RunWorkspaceEquityHeaderFinancial,
): RunWorkspaceEquitySnapshotMetric {
  return {
    key: financial.key as Extract<
      RunWorkspaceEquitySnapshotMetric["key"],
      "marketCap" | "trailingPE" | "dividendYield" | "sharesOutstanding"
    >,
    label: financial.label,
    state: "available",
    value: financial.value,
    dateBasis: financial.caption,
    sourceIds: financial.sourceIds,
  };
}

function postureLabel(posture: FinancialLensPosture): string {
  const label = posture.replaceAll("-", " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function snapshotDriverCard(
  key: "bullCaseDrivers" | "bearCaseDrivers",
  label: "Bull-case driver" | "Bear-case driver",
  cases: readonly RunWorkspaceCaseSection[],
): RunWorkspaceEquitySnapshotDriverCard {
  const caseKey = key === "bullCaseDrivers" ? "bullCase" : "bearCase";
  const items =
    cases
      .find((section) => section.key === caseKey)
      ?.items.filter((item) => item.sourceIds.length > 0)
      .slice(0, 2) ?? [];
  return {
    key,
    label,
    state: items.length > 0 ? "available" : "unavailable",
    detailSectionKey: "cases",
    detailSectionMounted: cases.length > 0,
    sourceIds: uniqueSourceIds(items.flatMap((item) => item.sourceIds)),
    items,
  };
}

function snapshotReferenceRange(
  peerImpliedRange: RunWorkspacePeerImpliedRangeView | undefined,
): RunWorkspaceEquitySnapshotReferenceRange {
  const disclosure = "Peer-derived reference range for context only; not a target price.";
  if (peerImpliedRange === undefined) {
    return {
      key: "peerReferenceRange",
      label: PEER_REFERENCE_RANGE_LABEL,
      state: "unavailable",
      detailSectionKey: "peerImpliedRange",
      detailSectionMounted: false,
      sourceIds: [],
      display: "N/M — peer evidence unavailable: reference range is unavailable",
      disclosure,
    };
  }
  if (peerImpliedRange.status === "suppressed") {
    return {
      key: "peerReferenceRange",
      label: PEER_REFERENCE_RANGE_LABEL,
      state: "unavailable",
      detailSectionKey: "peerImpliedRange",
      detailSectionMounted: true,
      sourceIds: peerImpliedRange.sourceIds,
      display: `N/M — peer evidence unavailable: ${peerImpliedRange.suppressionReason}`,
      disclosure,
    };
  }
  return {
    key: "peerReferenceRange",
    label: PEER_REFERENCE_RANGE_LABEL,
    state: "available",
    detailSectionKey: "peerImpliedRange",
    detailSectionMounted: true,
    sourceIds: peerImpliedRange.sourceIds,
    display: `${peerImpliedRange.lowLabel} · ${peerImpliedRange.midLabel} · ${peerImpliedRange.highLabel}`,
    positionLabel: peerImpliedRange.positionLabel,
    disclosure,
  };
}

function composeEquitySnapshot(
  inputs: EquitySnapshotProjectionInputs,
): RunWorkspaceEquitySnapshotView {
  const {
    equityHeader,
    equityCompleteness,
    peerImpliedRange,
    fundamentalHistory,
    financialLensGroups,
    cases,
  } = inputs;
  const priceFieldCount = [
    equityHeader?.price,
    equityHeader?.dailyChange,
    equityHeader?.quoteCurrency,
    equityHeader?.priceAsOf,
    equityHeader?.sourceIds[0],
  ].filter((value) => value !== undefined).length;
  const pricePerformance: RunWorkspaceEquitySnapshotPricePerformance = {
    key: "pricePerformance",
    label: "Price",
    state: snapshotState(priceFieldCount, 5),
    detailSectionKey: "snapshot",
    detailSectionMounted: inputs.marketSnapshotMounted,
    sourceIds: equityHeader?.sourceIds ?? [],
    ...(equityHeader?.price === undefined ? {} : { price: equityHeader.price }),
    ...(equityHeader?.dailyChange === undefined ? {} : { change24h: equityHeader.dailyChange }),
    ...(equityHeader?.changeDirection === undefined
      ? {}
      : { changeDirection: equityHeader.changeDirection }),
    ...(equityHeader?.quoteCurrency === undefined
      ? {}
      : { quoteCurrency: equityHeader.quoteCurrency }),
    ...(equityHeader?.observedAt === undefined ? {} : { observedAt: equityHeader.observedAt }),
    ...(equityHeader?.priceAsOf === undefined ? {} : { priceAsOf: equityHeader.priceAsOf }),
  };

  const analysisCompleteness: RunWorkspaceEquitySnapshotCompleteness = {
    key: "analysisCompleteness",
    label: "Coverage",
    state: equityCompleteness === undefined ? "unavailable" : "available",
    detailSectionKey: "equityCompleteness",
    detailSectionMounted: equityCompleteness !== undefined,
    sourceIds: uniqueSourceIds(
      equityCompleteness?.dimensions.flatMap((dimension) => dimension.sourceIds) ?? [],
    ),
    ...(equityCompleteness === undefined
      ? {}
      : {
          financialCoreStatus: equityCompleteness.financialCoreStatus,
          coverageLevel: equityCompleteness.coverageLevel,
          asOf: equityCompleteness.asOf,
        }),
    dimensions:
      equityCompleteness?.dimensions.map(({ reasonCodes, ...dimension }) => ({
        ...dimension,
        reasons: reasonCodes.map((reasonCode) => completenessReasonCodeLabel(reasonCode)),
      })) ?? [],
  };

  const peerReferenceRange = snapshotReferenceRange(peerImpliedRange);

  const metrics = [
    ...SNAPSHOT_TTM_METRICS.map((definition) => snapshotTtmMetric(definition, fundamentalHistory)),
    snapshotForwardMetric("forwardPE", "Forward P/E", equityHeader),
    snapshotForwardMetric("forwardEPS", "Forward EPS", equityHeader),
  ];
  const foldedYahooMetrics =
    equityHeader?.financials
      .filter((financial) => FOLDED_YAHOO_METRIC_KEYS.has(financial.key))
      .map((financial) => foldedYahooMetric(financial)) ?? [];
  const keyDatedMetrics: RunWorkspaceEquitySnapshotKeyMetrics = {
    key: "keyDatedMetrics",
    label: "Key dated metrics",
    state: snapshotState(
      metrics.filter((metric) => metric.state === "available").length,
      metrics.length,
    ),
    detailSectionKey: "fundamentalHistory",
    detailSectionMounted: fundamentalHistory !== undefined,
    sourceIds: uniqueSourceIds(
      [...metrics, ...foldedYahooMetrics].flatMap((metric) => metric.sourceIds),
    ),
    metrics,
    foldedYahooMetrics,
  };

  const charts = SNAPSHOT_CHARTS.map(({ key, label }): RunWorkspaceEquitySnapshotMiniChart => {
    const card = fundamentalHistory?.cards.find((candidate) => candidate.key === key);
    if (card === undefined) {
      return {
        key,
        label,
        state: "unavailable",
        detailSectionKey: "fundamentalHistory",
        detailSectionMounted: fundamentalHistory !== undefined,
        sourceIds: [],
      };
    }
    return {
      key,
      label,
      state: card.pointCount < 2 ? "partial" : "available",
      detailSectionKey: "fundamentalHistory",
      detailSectionMounted: true,
      sourceIds: card.sourceIds,
      value: card.value,
      period: card.valuePeriod,
      geometry: card.geometry,
    };
  });
  const miniCharts: RunWorkspaceEquitySnapshotMiniCharts = {
    key: "miniCharts",
    label: "Fundamental trends",
    state: snapshotState(
      charts.filter((chart) => chart.state !== "unavailable").length,
      charts.length,
    ),
    charts,
  };

  const postures = financialLensGroups.map((group) => ({
    lens: group.lens,
    posture: group.posture,
    postureLabel: postureLabel(group.posture),
    sourceIds: group.sourceIds,
  }));
  const postureCard = {
    key: "lensPostures" as const,
    label: "Financial Lens postures",
    state: postures.length > 0 ? ("available" as const) : ("unavailable" as const),
    detailSectionKey: "financialLensStats" as const,
    detailSectionMounted: financialLensGroups.length > 0,
    sourceIds: uniqueSourceIds(postures.flatMap((posture) => posture.sourceIds)),
    items: postures,
  };
  const bullCase = snapshotDriverCard("bullCaseDrivers", "Bull-case driver", cases);
  const bearCase = snapshotDriverCard("bearCaseDrivers", "Bear-case driver", cases);
  const driverAvailableCount = [postureCard, bullCase, bearCase].filter(
    (card) => card.state === "available",
  ).length;
  const financialLensDrivers: RunWorkspaceEquitySnapshotFinancialLensDrivers = {
    key: "financialLensDrivers",
    label: "Financial Lens drivers",
    state: snapshotState(driverAvailableCount, 3),
    postures: postureCard,
    bullCase,
    bearCase,
  };

  return {
    pricePerformance,
    analysisCompleteness,
    peerReferenceRange,
    keyDatedMetrics,
    miniCharts,
    financialLensDrivers,
  };
}

export function equitySnapshotView(detail: RunDetail): RunWorkspaceEquitySnapshotView | undefined {
  if (detail.summary.jobType !== "equity") {
    return undefined;
  }
  const marketSnapshot = snapshotView(detail);
  const equityHeader = equityHeaderView(detail);
  const equityCompleteness = equityCompletenessView(detail);
  const peerImpliedRange = peerImpliedRangeView(detail);
  const fundamentalHistory = fundamentalHistoryView(detail);
  return composeEquitySnapshot({
    ...(equityHeader === undefined ? {} : { equityHeader }),
    ...(equityCompleteness === undefined ? {} : { equityCompleteness }),
    ...(peerImpliedRange === undefined ? {} : { peerImpliedRange }),
    ...(fundamentalHistory === undefined ? {} : { fundamentalHistory }),
    financialLensGroups: financialLensGroupViews(detail),
    cases: reportCaseSections(detail.report),
    marketSnapshotMounted: marketSnapshot !== undefined,
  });
}

export function buildRunWorkspaceView(detail: RunDetail): RunWorkspaceView {
  const { report } = detail;
  const isEquityPresentation =
    detail.summary.jobType === "equity" &&
    (detail.summary.assetClass === undefined || detail.summary.assetClass === "equity");
  const readerProjection = projectEquityReaderForDetail(detail);
  const summary = typeof report?.summary === "string" ? report.summary : "";
  const financialLensGroups = financialLensGroupViews(detail);
  const findings = textItems(report, "keyFindings");
  const cases = reportCaseSections(report);
  const scenarioItems = scenarios(report);

  const forecastItems = scoredForecasts(report, detail.score, detail.missAutopsy);
  const targetHealth = predictionTargetHealth(detail.analytics, report);
  const splitGaps = splitDataGaps(
    isEquityPresentation
      ? [
          ...readerProjection.defaultView.materialGaps,
          ...readerProjection.appendix.diagnosticGaps,
          ...readerProjection.appendix.predictionShortfalls,
        ]
      : stringArray(report, "dataGaps"),
  );
  const reportSymbol = typeof report?.symbol === "string" ? report.symbol : detail.summary.symbol;
  const triagedGaps = splitGaps.otherGaps.map((gap) => ({
    text: gap,
    triage: readGapTriage(gap, detail.sourceGaps, reportSymbol),
  }));
  const forecastsVisible =
    forecastItems.length > 0 || splitGaps.shortfalls.length > 0 || targetHealth !== undefined;

  const historicalContext = historicalContextAuditView(detail.trace);
  const webSubjectProfile = webSubjectProfileView(report, detail.webSubjectProfile);
  const businessFramework = businessFrameworkView(report, detail.businessFramework);
  const marketSnapshot = matchingMarketSnapshot(detail);
  const extendedItems = extendedEvidenceItems(report).map((item) => ({
    ...item,
    summary: renderedPriceSummary(item.summary, item.sourceIds, marketSnapshot),
  }));
  const snapshot = snapshotView(detail);
  const equityHeader = equityHeaderView(detail);
  const equityCompleteness = equityCompletenessView(detail);
  const fundamentalHistory = fundamentalHistoryView(detail);
  const valuationWorkbench = valuationWorkbenchView(detail);
  const reverseDcf = reverseDcfView(detail);
  const peerImpliedRange = peerImpliedRangeFromProjection(
    readerProjection.defaultView.valuationContext,
  );
  const financialTrends = financialTrendFromProjection(
    readerProjection.defaultView.financialTrends,
  );
  const balanceSheetHistory = balanceSheetHistoryFromProjection(
    readerProjection.appendix.balanceSheetHistory,
  );
  const earningsConsensus = earningsConsensusFromProjection(
    readerProjection.defaultView.earningsConsensus,
  );
  const analystEstimateDistributions = analystEstimateDistributionsFromProjection(
    readerProjection.appendix.analystEstimateDistributions,
  );
  const equitySnapshot = isEquityPresentation
    ? composeEquitySnapshot({
        ...(equityHeader === undefined ? {} : { equityHeader }),
        ...(equityCompleteness === undefined ? {} : { equityCompleteness }),
        ...(peerImpliedRange === undefined ? {} : { peerImpliedRange }),
        ...(fundamentalHistory === undefined ? {} : { fundamentalHistory }),
        financialLensGroups,
        cases,
        marketSnapshotMounted: snapshot !== undefined,
      })
    : undefined;
  const materialGaps = isEquityPresentation
    ? readerProjection.defaultView.materialGaps
    : triagedGaps.filter((gap) => gap.triage === "material").map((gap) => gap.text);
  const diagnosticGaps = isEquityPresentation
    ? readerProjection.appendix.diagnosticGaps
    : triagedGaps.filter((gap) => gap.triage === "diagnostic").map((gap) => gap.text);
  const description = companyDescription(report ?? {});
  const equityPresentation: RunWorkspaceEquityPresentationView | undefined =
    equitySnapshot === undefined
      ? undefined
      : {
          defaultView: {
            pricePerformance: equitySnapshot.pricePerformance,
            companySummary: description,
            ...(financialTrends === undefined ? {} : { financialTrends }),
            valuationContext: {
              ...equitySnapshot.peerReferenceRange,
              label: "Valuation context",
            },
            findings,
            cases: cases.filter(
              (section) => section.key === "catalysts" || section.key === "risks",
            ),
            earningsConsensus,
            ...(readerProjection.defaultView.financialCoreStatus === undefined
              ? {}
              : { financialCoreStatus: readerProjection.defaultView.financialCoreStatus }),
            materialGaps,
          },
          advanced: {
            ...(readerProjection.appendix.completeness === undefined
              ? {}
              : { completeness: readerProjection.appendix.completeness }),
            financialLensDrivers: equitySnapshot.financialLensDrivers,
            financialLensGroups,
            keyDatedMetrics: equitySnapshot.keyDatedMetrics,
            miniCharts: equitySnapshot.miniCharts,
            ...(valuationWorkbench === undefined ? {} : { valuationWorkbench }),
            ...(reverseDcf === undefined ? {} : { reverseDcf }),
            ...(peerImpliedRange === undefined ? {} : { peerImpliedRange }),
            analystEstimateDistributions,
            extendedItems,
            diagnosticGaps,
            ...(balanceSheetHistory === undefined ? {} : { balanceSheetHistory }),
            cases: cases.filter(
              (section) => section.key === "bullCase" || section.key === "bearCase",
            ),
            scenarios: scenarioItems,
            reportSummary: summary,
          },
        };
  const gapsVisible = splitGaps.shortfalls.length > 0 || triagedGaps.length > 0;

  const tableOfContents = (
    equityPresentation === undefined
      ? [
          { key: "summary", label: "Summary", visible: summary !== "" },
          {
            key: "equityCompleteness",
            label: "Analysis completeness",
            visible: equityCompleteness !== undefined,
          },
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
            key: "valuationWorkbench",
            label: "Valuation workbench",
            visible: valuationWorkbench !== undefined,
          },
          {
            key: "reverseDcf",
            label: "Reverse DCF input sensitivity",
            visible: reverseDcf !== undefined,
          },
          {
            key: "peerImpliedRange",
            label: "Peer-implied price reference range",
            visible: peerImpliedRange !== undefined,
          },
          {
            key: "history",
            label: "Historical context",
            visible: historicalContext !== undefined,
          },
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
      : [
          { key: "equityOverview", label: "Price", visible: true },
          { key: "summary", label: "Company summary", visible: true },
          {
            key: "financialTrends",
            label: "Financial trends",
            visible: financialTrends !== undefined,
          },
          { key: "findings", label: "Key findings", visible: findings.length > 0 },
          {
            key: "cases",
            label: "Catalysts & risks",
            visible: equityPresentation.defaultView.cases.length > 0,
          },
          {
            key: "earningsConsensus",
            label: "Earnings & consensus",
            visible: earningsConsensus.items.length > 0,
          },
          {
            key: "gaps",
            label: "Coverage & material gaps",
            visible: true,
          },
          { key: "advanced", label: "Advanced", visible: true },
        ]
  )
    .filter((entry) => entry.visible)
    .map(({ key, label }) => ({ key, label }));

  return {
    ...(equityPresentation !== undefined ? { equityPresentation } : {}),
    ...(fundamentalHistory !== undefined ? { fundamentalHistory } : {}),
    ...(valuationWorkbench !== undefined ? { valuationWorkbench } : {}),
    ...(reverseDcf !== undefined ? { reverseDcf } : {}),
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
    gaps: { ...splitGaps, triagedGaps, visible: gapsVisible },
    sources: { items: sources(report) },
    ...(snapshot !== undefined ? { snapshot } : {}),
    tableOfContents,
  };
}
