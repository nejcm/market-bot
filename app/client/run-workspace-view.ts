import type { RunDetail } from "../types";
import { readGapTriage, type GapTriage } from "../../src/report/gap-triage";
import {
  normalizePredictionShortfallReport,
  predictionShortfallCompactText,
  readPredictionShortfall,
} from "../../src/report/prediction-shortfall";
import { resolveMarketSnapshotPriceAsOf, type MarketSnapshot } from "../../src/domain/types";
import type {
  EquityReaderAppendixCompleteness,
  EquityReaderFinancialCoreStatus,
} from "../../src/report/equity-reader";
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
  businessFrameworkView,
  extendedEvidenceItems,
  forecastGroups,
  forecastRollup,
  historicalContextAuditView,
  horizonMarkers,
  predictionTargetHealth,
  scenarios,
  scoredForecasts,
  sources,
  stringArray,
  textItems,
  tradingViewUrl,
  verifiedSnapshotValue,
  webSubjectProfileView,
  type BusinessFrameworkView,
  type HistoricalContextAuditView,
  type SnapshotView,
  type WebSubjectProfileView,
} from "./view-model";
import {
  financialLensGroupViews,
  matchingMarketSnapshot,
  priceAsOfLabel,
  projectEquityReaderForDetail,
  reportCaseSections,
  type RunWorkspaceCaseSection,
  type RunWorkspaceFinancialLensGroup,
  type RunWorkspaceTextItem,
} from "./run-workspace-detail";
import { equityHeaderView, type RunWorkspaceEquityHeaderView } from "./run-workspace-equity-header";
import {
  peerImpliedRangeFromProjection,
  reverseDcfView,
  valuationWorkbenchView,
  type RunWorkspacePeerImpliedRangeView,
  type RunWorkspaceReverseDcfView,
  type RunWorkspaceValuationWorkbenchView,
} from "./run-workspace-valuation";
import {
  analystEstimateDistributionsFromProjection,
  balanceSheetHistoryFromProjection,
  earningsConsensusFromProjection,
  financialPositionFromProjection,
  financialTrendFromProjection,
  fundamentalHistoryView,
  type RunWorkspaceAnalystEstimateDistribution,
  type RunWorkspaceBalanceSheetHistoryView,
  type RunWorkspaceEarningsConsensusView,
  type RunWorkspaceFinancialPositionView,
  type RunWorkspaceFinancialTrendView,
  type RunWorkspaceFundamentalHistoryView,
} from "./run-workspace-financials";
import {
  composeEquitySnapshot,
  simpleKeyMetrics,
  type RunWorkspaceEquitySnapshotFinancialLensDrivers,
  type RunWorkspaceEquitySnapshotKeyMetrics,
  type RunWorkspaceEquitySnapshotMetric,
  type RunWorkspaceEquitySnapshotMiniCharts,
  type RunWorkspaceEquitySnapshotPricePerformance,
  type RunWorkspaceEquitySnapshotReferenceRange,
} from "./run-workspace-snapshot";

export {
  COMPLETENESS_REASON_CODE_LABELS,
  completenessReasonCodeLabel,
} from "./run-workspace-completeness";

export type {
  RunWorkspaceCaseKey,
  RunWorkspaceCaseSection,
  RunWorkspaceFinancialLensGroup,
} from "./run-workspace-detail";

export { equityHeaderView };

export {
  peerImpliedRangeView,
  type RunWorkspaceExcludedValuationPeerRow,
  type RunWorkspacePeerImpliedRangeGeometry,
} from "./run-workspace-valuation";

export {
  reverseDcfView,
  valuationWorkbenchView,
  type RunWorkspacePeerImpliedRangeView,
  type RunWorkspaceReverseDcfView,
  type RunWorkspaceValuationWorkbenchView,
};

export type {
  RunWorkspaceAnalystEstimateDistribution,
  RunWorkspaceBalanceSheetHistoryView,
  RunWorkspaceFundamentalHistoryView,
  RunWorkspaceSparklineGeometry,
} from "./run-workspace-financials";

export { equitySnapshotView } from "./run-workspace-snapshot";

export type {
  RunWorkspaceEquitySnapshotFinancialLensDrivers,
  RunWorkspaceEquitySnapshotKeyMetrics,
  RunWorkspaceEquitySnapshotMiniCharts,
} from "./run-workspace-snapshot";

interface RunWorkspaceReportView {
  readonly summary: string;
  readonly financialLensGroups: readonly RunWorkspaceFinancialLensGroup[];
  readonly findings: readonly RunWorkspaceTextItem[];
  readonly cases: readonly RunWorkspaceCaseSection[];
  readonly scenarios: readonly ScenarioView[];
  readonly markdown?: string;
}

interface RunWorkspaceForecastsView {
  readonly items: readonly ScoredForecast[];
  readonly groups: readonly ForecastGroup[];
  readonly stats: ForecastRollup;
  readonly horizons: readonly number[];
  readonly targetHealth?: PredictionTargetHealth;
  readonly visible: boolean;
}

interface RunWorkspaceEvidenceView {
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

interface RunWorkspaceSourcesView {
  readonly items: readonly SourceView[];
}

interface RunWorkspaceSnapshotView {
  readonly value: SnapshotView;
  readonly tradingViewUrl: string;
}

export type RunWorkspaceSectionKey =
  | "summary"
  | "findings"
  | "cases"
  | "snapshot"
  | "forecasts"
  | "scenarios"
  | "valuationWorkbench"
  | "reverseDcf"
  | "peerImpliedRange"
  | "financialLensStats"
  | "fundamentalHistory"
  | "extendedEvidence"
  | "webSubjectProfile"
  | "businessFramework"
  | "history"
  | "gaps"
  | "equityOverview"
  | "researchSummary"
  | "financialTrends"
  | "financialPosition"
  | "earningsConsensus"
  | "equityMetrics"
  | "balanceSheetHistory"
  | "analystEstimateDistributions"
  | "equityCompleteness"
  | "rawMarkdown";

/* Section components take this to register their element for the nav and to
   stamp `data-section`. Named once so the callback shape stays a single edit. */
export type BindSection = (key: RunWorkspaceSectionKey) => (el: HTMLElement) => void;

export interface RunWorkspaceTableOfContentsEntry {
  readonly key: RunWorkspaceSectionKey;
  readonly label: string;
  readonly advancedOnly: boolean;
}

/* A table-of-contents entry before the visibility filter drops it. */
type TableOfContentsDraft = RunWorkspaceTableOfContentsEntry & { readonly visible: boolean };

export interface RunWorkspaceEquityPresentationView {
  readonly defaultView: {
    readonly pricePerformance: RunWorkspaceEquitySnapshotPricePerformance;
    readonly researchSummary: string;
    readonly companySummary: RunWorkspaceTextItem;
    readonly financialTrends?: RunWorkspaceFinancialTrendView;
    readonly financialPosition?: RunWorkspaceFinancialPositionView;
    readonly keyMetrics: readonly RunWorkspaceEquitySnapshotMetric[];
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
    readonly scenarios: readonly ScenarioView[];
  };
}

export interface RunWorkspaceView {
  readonly equityHeader?: RunWorkspaceEquityHeaderView;
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

function snapshotView(detail: RunDetail): RunWorkspaceSnapshotView | undefined {
  const { jobType } = detail.summary;
  if (jobType !== "equity" && jobType !== "crypto") {
    return undefined;
  }

  const value = verifiedSnapshotValue(detail.verifiedMarketSnapshot);
  return value === undefined ? undefined : { value, tradingViewUrl: tradingViewUrl(value.symbol) };
}

export function buildRunWorkspaceView(detail: RunDetail): RunWorkspaceView {
  const report = normalizePredictionShortfallReport(detail.report);
  const isEquityPresentation =
    detail.summary.jobType === "equity" &&
    (detail.summary.assetClass === undefined || detail.summary.assetClass === "equity");
  const readerProjection = projectEquityReaderForDetail({
    ...detail,
    ...(report === undefined ? {} : { report }),
  });
  const summary = typeof report?.summary === "string" ? report.summary : "";
  const financialLensGroups = financialLensGroupViews(detail);
  const findings = textItems(report, "keyFindings");
  const cases = reportCaseSections(report);
  const scenarioItems = scenarios(report);

  const forecastItems = scoredForecasts(report, detail.score, detail.missAutopsy);
  const targetHealth = predictionTargetHealth(detail.analytics, report);
  const predictionShortfall = readPredictionShortfall(report?.predictionShortfall);
  const projectedGaps = isEquityPresentation
    ? [...readerProjection.defaultView.materialGaps, ...readerProjection.appendix.diagnosticGaps]
    : stringArray(report, "dataGaps");
  const splitGaps = isEquityPresentation
    ? { shortfalls: [], otherGaps: projectedGaps }
    : {
        shortfalls:
          predictionShortfall === undefined
            ? []
            : [predictionShortfallCompactText(predictionShortfall)],
        otherGaps: projectedGaps,
      };
  const equityShortfallDisclosed = isEquityPresentation && predictionShortfall !== undefined;
  const reportSymbol = typeof report?.symbol === "string" ? report.symbol : detail.summary.symbol;
  const triagedGaps = (isEquityPresentation ? projectedGaps : splitGaps.otherGaps).map((gap) => ({
    text: gap,
    triage: readGapTriage(gap, detail.sourceGaps, reportSymbol),
  }));
  const forecastsVisible =
    forecastItems.length > 0 ||
    splitGaps.shortfalls.length > 0 ||
    equityShortfallDisclosed ||
    targetHealth !== undefined;

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
  const financialPosition = financialPositionFromProjection(
    readerProjection.defaultView.financialPosition,
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
        ...(peerImpliedRange === undefined ? {} : { peerImpliedRange }),
        ...(fundamentalHistory === undefined ? {} : { fundamentalHistory }),
        financialLensGroups,
        cases,
      })
    : undefined;
  const materialGaps = isEquityPresentation
    ? readerProjection.defaultView.materialGaps
    : triagedGaps.filter((gap) => gap.triage === "material").map((gap) => gap.text);
  const diagnosticGaps = isEquityPresentation
    ? readerProjection.appendix.diagnosticGaps
    : triagedGaps.filter((gap) => gap.triage === "diagnostic").map((gap) => gap.text);
  const description = readerProjection.defaultView.companyDescription;
  const equityPresentation: RunWorkspaceEquityPresentationView | undefined =
    equitySnapshot === undefined
      ? undefined
      : {
          defaultView: {
            pricePerformance: equitySnapshot.pricePerformance,
            researchSummary: summary,
            companySummary: { text: description.text, sourceIds: description.sourceIds },
            ...(financialTrends === undefined ? {} : { financialTrends }),
            ...(financialPosition === undefined ? {} : { financialPosition }),
            keyMetrics: simpleKeyMetrics(equitySnapshot.keyDatedMetrics),
            valuationContext: {
              ...equitySnapshot.peerReferenceRange,
              label: "Valuation context",
            },
            findings,
            cases: ["risks", "catalysts", "bullCase", "bearCase"].flatMap((key) =>
              cases.filter((section) => section.key === key),
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
            scenarios: scenarioItems,
          },
        };
  const gapsVisible = splitGaps.shortfalls.length > 0 || triagedGaps.length > 0;

  const tableOfContentsDraft: readonly TableOfContentsDraft[] =
    equityPresentation === undefined
      ? [
          { key: "summary", label: "Summary", visible: summary !== "", advancedOnly: false },
          {
            key: "findings",
            label: "Key findings",
            visible: findings.length > 0,
            advancedOnly: false,
          },
          { key: "cases", label: "Cases & risks", visible: cases.length > 0, advancedOnly: false },
          {
            key: "snapshot",
            label: "Market snapshot",
            visible: snapshot !== undefined,
            advancedOnly: false,
          },
          { key: "forecasts", label: "Forecasts", visible: forecastsVisible, advancedOnly: false },
          {
            key: "scenarios",
            label: "Scenarios",
            visible: scenarioItems.length > 0,
            advancedOnly: false,
          },
          {
            key: "valuationWorkbench",
            label: "Valuation workbench",
            visible: valuationWorkbench !== undefined,
            advancedOnly: false,
          },
          {
            key: "reverseDcf",
            label: "Reverse DCF input sensitivity",
            visible: reverseDcf !== undefined,
            advancedOnly: false,
          },
          {
            key: "peerImpliedRange",
            label: "Peer-implied price reference range",
            visible: peerImpliedRange !== undefined,
            advancedOnly: false,
          },
          {
            key: "financialLensStats",
            label: "Financial lens stats",
            visible: financialLensGroups.length > 0,
            advancedOnly: false,
          },
          {
            key: "fundamentalHistory",
            label: "Fundamental history",
            visible: fundamentalHistory !== undefined,
            advancedOnly: false,
          },
          {
            key: "extendedEvidence",
            label: "Extended evidence",
            visible: extendedItems.length > 0,
            advancedOnly: false,
          },
          {
            key: "webSubjectProfile",
            label: "Web Subject Profile",
            visible: webSubjectProfile !== undefined,
            advancedOnly: false,
          },
          {
            key: "businessFramework",
            label: "Business framework",
            visible: businessFramework !== undefined,
            advancedOnly: false,
          },
          {
            key: "history",
            label: "Historical context",
            visible: historicalContext !== undefined,
            advancedOnly: false,
          },
          { key: "gaps", label: "Data gaps", visible: gapsVisible, advancedOnly: false },
        ]
      : [
          { key: "equityOverview", label: "Price", visible: true, advancedOnly: false },
          {
            key: "researchSummary",
            label: "Research summary",
            visible: summary !== "",
            advancedOnly: false,
          },
          { key: "summary", label: "Company summary", visible: true, advancedOnly: false },
          {
            key: "financialTrends",
            label: "Financial trends",
            visible: financialTrends !== undefined,
            advancedOnly: false,
          },
          {
            key: "financialPosition",
            label: "Financial position",
            visible: equityPresentation.defaultView.financialPosition !== undefined,
            advancedOnly: false,
          },
          {
            key: "findings",
            label: "Key findings",
            visible: findings.length > 0,
            advancedOnly: false,
          },
          {
            key: "cases",
            label: "Cases",
            visible: equityPresentation.defaultView.cases.length > 0,
            advancedOnly: false,
          },
          {
            key: "snapshot",
            label: "Market snapshot",
            visible: snapshot !== undefined,
            advancedOnly: false,
          },
          { key: "forecasts", label: "Forecasts", visible: forecastsVisible, advancedOnly: false },
          {
            key: "scenarios",
            label: "Scenarios",
            visible: scenarioItems.length > 0,
            advancedOnly: true,
          },
          {
            key: "valuationWorkbench",
            label: "Valuation workbench",
            visible: valuationWorkbench !== undefined,
            advancedOnly: true,
          },
          {
            key: "reverseDcf",
            label: "Reverse DCF input sensitivity",
            visible: reverseDcf !== undefined,
            advancedOnly: true,
          },
          {
            key: "peerImpliedRange",
            /* Short enough to sit in the ledger nav strip; the section itself
               spells the full name out. */
            label: "Peer-implied range",
            visible: peerImpliedRange !== undefined,
            advancedOnly: true,
          },
          {
            key: "earningsConsensus",
            label: "Earnings & consensus",
            visible: true,
            advancedOnly: false,
          },
          {
            key: "equityMetrics",
            label: "Detailed equity metrics",
            visible: true,
            advancedOnly: true,
          },
          {
            key: "financialLensStats",
            label: "Financial lens stats",
            visible: financialLensGroups.length > 0,
            advancedOnly: true,
          },
          {
            key: "fundamentalHistory",
            label: "Fundamental history",
            visible: fundamentalHistory !== undefined,
            advancedOnly: true,
          },
          {
            key: "balanceSheetHistory",
            label: "Balance sheet & share count",
            visible: balanceSheetHistory !== undefined,
            advancedOnly: true,
          },
          {
            key: "analystEstimateDistributions",
            label: "Analyst estimate distributions",
            visible: analystEstimateDistributions.length > 0,
            advancedOnly: true,
          },
          {
            key: "extendedEvidence",
            label: "Extended evidence",
            visible: extendedItems.length > 0,
            advancedOnly: true,
          },
          {
            key: "webSubjectProfile",
            label: "Web Subject Profile",
            visible: webSubjectProfile !== undefined,
            advancedOnly: true,
          },
          {
            key: "businessFramework",
            label: "Business framework",
            visible: businessFramework !== undefined,
            advancedOnly: true,
          },
          {
            key: "equityCompleteness",
            label: "Completeness diagnostics",
            visible: equityPresentation.advanced.completeness !== undefined,
            advancedOnly: true,
          },
          {
            key: "history",
            label: "Historical context",
            visible: historicalContext !== undefined,
            advancedOnly: true,
          },
          {
            key: "gaps",
            label: "Coverage & material gaps",
            visible: true,
            advancedOnly: false,
          },
          {
            key: "rawMarkdown",
            label: "Raw markdown",
            visible: detail.markdown !== undefined,
            advancedOnly: true,
          },
        ];

  const tableOfContents = tableOfContentsDraft
    .filter((entry) => entry.visible)
    .map(({ key, label, advancedOnly }) => ({ key, label, advancedOnly }));

  return {
    ...(equityHeader !== undefined ? { equityHeader } : {}),
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
