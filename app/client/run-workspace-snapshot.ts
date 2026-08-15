import type { RunDetail } from "../types";
import type { MarketSnapshotPriceAsOf } from "../../src/domain/types";
import type {
  FinancialLensName,
  FinancialLensPosture,
} from "../../src/sources/extended-evidence/financial-lens";
import {
  financialLensGroupViews,
  priceAsOfLabel,
  reportCaseSections,
  uniqueSourceIds,
  type RunWorkspaceCaseSection,
  type RunWorkspaceFinancialLensGroup,
  type RunWorkspaceTextItem,
} from "./run-workspace-detail";
import {
  equityHeaderView,
  type RunWorkspaceEquityHeaderFinancial,
  type RunWorkspaceEquityHeaderView,
} from "./run-workspace-equity-header";
import {
  fundamentalHistoryView,
  type RunWorkspaceFundamentalHistoryCard,
  type RunWorkspaceFundamentalHistoryView,
  type RunWorkspaceSparklineGeometry,
} from "./run-workspace-financials";
import {
  peerImpliedRangeView,
  PEER_REFERENCE_RANGE_LABEL,
  type RunWorkspacePeerImpliedRangeView,
} from "./run-workspace-valuation";

type RunWorkspaceEquitySnapshotState = "available" | "partial" | "unavailable";

interface RunWorkspaceEquitySnapshotCard {
  readonly key: string;
  readonly label: string;
  readonly state: RunWorkspaceEquitySnapshotState;
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

interface RunWorkspaceEquitySnapshotMiniChart extends RunWorkspaceEquitySnapshotCard {
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

interface RunWorkspaceEquitySnapshotLensPosture {
  readonly lens: FinancialLensName;
  readonly posture: FinancialLensPosture;
  readonly postureLabel: string;
  readonly sourceIds: readonly string[];
}

interface RunWorkspaceEquitySnapshotDriverCard extends RunWorkspaceEquitySnapshotCard {
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
  readonly peerReferenceRange: RunWorkspaceEquitySnapshotReferenceRange;
  readonly keyDatedMetrics: RunWorkspaceEquitySnapshotKeyMetrics;
  readonly miniCharts: RunWorkspaceEquitySnapshotMiniCharts;
  readonly financialLensDrivers: RunWorkspaceEquitySnapshotFinancialLensDrivers;
}

interface EquitySnapshotProjectionInputs {
  readonly equityHeader?: RunWorkspaceEquityHeaderView;
  readonly peerImpliedRange?: RunWorkspacePeerImpliedRangeView;
  readonly fundamentalHistory?: RunWorkspaceFundamentalHistoryView;
  readonly financialLensGroups: readonly RunWorkspaceFinancialLensGroup[];
  readonly cases: readonly RunWorkspaceCaseSection[];
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

const SIMPLE_METRIC_KEYS: readonly RunWorkspaceEquitySnapshotMetric["key"][] = [
  "marketCap",
  "ttmRevenue",
  "ttmOperatingMargin",
  "ttmFreeCashFlowProxy",
];

export function simpleKeyMetrics(
  keyDatedMetrics: RunWorkspaceEquitySnapshotKeyMetrics,
): readonly RunWorkspaceEquitySnapshotMetric[] {
  const available = [...keyDatedMetrics.metrics, ...keyDatedMetrics.foldedYahooMetrics].filter(
    (metric) => metric.state === "available" && metric.value !== undefined,
  );
  const core = SIMPLE_METRIC_KEYS.flatMap((key) => {
    const metric = available.find((candidate) => candidate.key === key);
    return metric === undefined ? [] : [metric];
  });
  const valuation =
    available.find((metric) => metric.key === "forwardPE") ??
    available.find((metric) => metric.key === "trailingPE");
  return valuation === undefined ? core : [...core, valuation];
}

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
      sourceIds: peerImpliedRange.sourceIds,
      display: `N/M — peer evidence unavailable: ${peerImpliedRange.suppressionReason}`,
      disclosure,
    };
  }
  return {
    key: "peerReferenceRange",
    label: PEER_REFERENCE_RANGE_LABEL,
    state: "available",
    sourceIds: peerImpliedRange.sourceIds,
    display: `${peerImpliedRange.lowLabel} · ${peerImpliedRange.midLabel} · ${peerImpliedRange.highLabel}`,
    positionLabel: peerImpliedRange.positionLabel,
    disclosure,
  };
}

export function composeEquitySnapshot(
  inputs: EquitySnapshotProjectionInputs,
): RunWorkspaceEquitySnapshotView {
  const { equityHeader, peerImpliedRange, fundamentalHistory, financialLensGroups, cases } = inputs;
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
        sourceIds: [],
      };
    }
    return {
      key,
      label,
      state: card.pointCount < 2 ? "partial" : "available",
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
  const equityHeader = equityHeaderView(detail);
  const peerImpliedRange = peerImpliedRangeView(detail);
  const fundamentalHistory = fundamentalHistoryView(detail);
  return composeEquitySnapshot({
    ...(equityHeader === undefined ? {} : { equityHeader }),
    ...(peerImpliedRange === undefined ? {} : { peerImpliedRange }),
    ...(fundamentalHistory === undefined ? {} : { fundamentalHistory }),
    financialLensGroups: financialLensGroupViews(detail),
    cases: reportCaseSections(detail.report),
  });
}
