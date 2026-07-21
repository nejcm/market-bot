import type { RunDetail } from "../types";
import type {
  FinancialLensName,
  FinancialLensPosture,
} from "../../src/sources/extended-evidence/financial-lens";
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

export interface RunWorkspaceTableOfContentsEntry {
  readonly key: string;
  readonly label: string;
}

export interface RunWorkspaceView {
  readonly report: RunWorkspaceReportView;
  readonly forecasts: RunWorkspaceForecastsView;
  readonly evidence: RunWorkspaceEvidenceView;
  readonly gaps: RunWorkspaceGapsView;
  readonly sources: RunWorkspaceSourcesView;
  readonly snapshot?: RunWorkspaceSnapshotView;
  readonly tableOfContents: readonly RunWorkspaceTableOfContentsEntry[];
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
