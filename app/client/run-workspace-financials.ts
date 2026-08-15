import type { RunDetail } from "../types";
import type {
  FundamentalHistoryArtifact,
  FundamentalHistoryPoint,
  FundamentalHistorySeriesKey,
} from "../../src/sources/extended-evidence/fundamental-history";
import type {
  EquityReaderAnalystEstimateDistribution,
  EquityReaderConsensusItem,
  EquityReaderProjection,
} from "../../src/report/equity-reader";
import type {
  EquityReaderBalanceSheetHistory,
  EquityReaderFinancialPosition,
} from "../../src/report/equity-reader-statements";
import { compactNumber } from "../../src/report/equity-reader-trends";
import {
  CURRENCY_SYMBOLS,
  formatLensValue,
  scaleCurrency,
} from "../../src/sources/extended-evidence/value-format";

interface RunWorkspaceSparklineBar {
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

interface RunWorkspaceFinancialTrendRow {
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

interface RunWorkspaceBalanceSheetHistoryRow {
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

interface RunWorkspaceFinancialPositionMetric {
  readonly label: "Cash" | "Debt" | "Diluted shares";
  readonly value: string;
  readonly dateBasis: string;
  readonly sourceIds: readonly string[];
}

export interface RunWorkspaceFinancialPositionView {
  readonly reportingCurrency?: string;
  readonly metrics: readonly RunWorkspaceFinancialPositionMetric[];
}

interface RunWorkspaceEarningsConsensusItem {
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

export function financialTrendFromProjection(
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

export function balanceSheetHistoryFromProjection(
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
      period: row.period,
      cash: statementAmount(row.cash?.value, history.reportingCurrency),
      debt: statementAmount(row.debt?.value, history.reportingCurrency),
      dilutedShares: row.dilutedShares === undefined ? "—" : scaleCurrency(row.dilutedShares.value),
    })),
  };
}

export function financialPositionFromProjection(
  position: EquityReaderFinancialPosition | undefined,
): RunWorkspaceFinancialPositionView | undefined {
  if (position === undefined) {
    return undefined;
  }
  const metrics: RunWorkspaceFinancialPositionMetric[] = [];
  for (const [label, item] of [
    ["Cash", position.cash],
    ["Debt", position.debt],
    ["Diluted shares", position.dilutedShares],
  ] as const) {
    if (item === undefined) {
      continue;
    }
    metrics.push({
      label,
      value:
        label === "Diluted shares"
          ? scaleCurrency(item.value)
          : statementAmount(item.value, position.reportingCurrency),
      dateBasis: `period ${item.periodEnd} · filed ${item.filedAt}`,
      sourceIds: item.sourceIds,
    });
  }
  return {
    ...(position.reportingCurrency === undefined
      ? {}
      : { reportingCurrency: position.reportingCurrency }),
    metrics,
  };
}

export function earningsConsensusFromProjection(
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

function compactOrDash(item: number | undefined): string {
  return item === undefined ? "—" : compactNumber(item);
}

export function analystEstimateDistributionsFromProjection(
  distributions: readonly EquityReaderAnalystEstimateDistribution[],
): readonly RunWorkspaceAnalystEstimateDistribution[] {
  return distributions.map((distribution) => ({
    title: distribution.title,
    ...(distribution.period === undefined ? {} : { period: distribution.period }),
    mean: compactOrDash(distribution.mean),
    median: compactOrDash(distribution.median),
    high: compactOrDash(distribution.high),
    low: compactOrDash(distribution.low),
    count: distribution.count === undefined ? "—" : String(distribution.count),
    sourceIds: distribution.sourceIds,
  }));
}
