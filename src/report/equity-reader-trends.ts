import type {
  FundamentalHistoryArtifact,
  FundamentalHistoryPoint,
  FundamentalHistorySeries,
} from "../sources/extended-evidence/fundamental-history";
import type { ValuationMetricSuppressionReason } from "../sources/extended-evidence/valuation-workbench-contract";
import { periodLabel } from "./equity-reader-statements";
import { metricCell } from "./valuation-workbench-markdown";

interface TrendPeriod {
  readonly kind: "annual" | "ttm";
  readonly periodEnd: string;
  readonly filedAt: string;
}

interface FinancialTrendRow {
  readonly period: string;
  readonly revenue: string;
  readonly netIncome: string;
  readonly operatingMargin: string;
  readonly freeCashFlow: string;
}

export interface EquityReaderFinancialTrends {
  readonly reportingCurrency?: string;
  readonly sourceIds: readonly string[];
  readonly rows: readonly FinancialTrendRow[];
}

const TREND_SERIES_KEYS = ["revenue", "netIncome", "operatingMargin", "freeCashFlowProxy"] as const;

function trendPeriods(history: FundamentalHistoryArtifact): readonly TrendPeriod[] {
  const annual = new Map<string, TrendPeriod>();
  for (const key of TREND_SERIES_KEYS) {
    const series = history.series[key];
    for (const point of series.annual) {
      const existing = annual.get(point.periodEnd);
      if (existing === undefined || point.filedAt > existing.filedAt) {
        annual.set(point.periodEnd, {
          kind: "annual",
          periodEnd: point.periodEnd,
          filedAt: point.filedAt,
        });
      }
    }
  }

  const annualRows = [...annual.values()]
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    .slice(-5);
  let ttm: TrendPeriod | undefined = undefined;
  for (const key of TREND_SERIES_KEYS) {
    const series = history.series[key];
    const point = series.ttm;
    if (
      point !== undefined &&
      (ttm === undefined ||
        point.periodEnd > ttm.periodEnd ||
        (point.periodEnd === ttm.periodEnd && point.filedAt > ttm.filedAt))
    ) {
      ttm = {
        kind: "ttm",
        periodEnd: point.periodEnd,
        filedAt: point.filedAt,
      };
    }
  }
  return ttm === undefined ? annualRows : [...annualRows, ttm];
}

export function financialTrendGaps(history: FundamentalHistoryArtifact): readonly string[] {
  const missingRevenuePeriods = trendPeriods(history).filter(
    (period) => historyPoint(history.series.revenue, period.periodEnd, period.kind) === undefined,
  ).length;
  if (missingRevenuePeriods === 0) {
    return [];
  }
  return [
    `fundamental-history-revenue: SEC revenue history is unavailable for ${String(missingRevenuePeriods)} rendered period(s); affected revenue and derived operating-margin values are shown as unavailable`,
  ];
}

function historyPoint(
  series: FundamentalHistorySeries,
  periodEnd: string,
  kind: TrendPeriod["kind"],
): FundamentalHistoryPoint | undefined {
  if (kind === "ttm") {
    return series.ttm?.periodEnd === periodEnd ? series.ttm : undefined;
  }
  return series.annual.find((point) => point.periodEnd === periodEnd);
}

// Reader/report compact ladder (T/B/M, 1 dp). Distinct from value-format.ts:scaleCurrency
// (K tier, toFixed(0), currency prefix).
export function compactNumber(value: number): string {
  const absolute = Math.abs(value);
  const units = [
    [1_000_000_000_000, "T"],
    [1_000_000_000, "B"],
    [1_000_000, "M"],
  ] as const;
  for (const [scale, suffix] of units) {
    if (absolute >= scale) {
      return `${(value / scale).toFixed(1)}${suffix}`;
    }
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function trendValue(
  history: FundamentalHistoryArtifact,
  key: keyof FundamentalHistoryArtifact["series"],
  period: TrendPeriod,
): number | undefined {
  return historyPoint(history.series[key], period.periodEnd, period.kind)?.value;
}

function formatTrendAmount(value: number | undefined): string {
  return value === undefined ? "—" : compactNumber(value);
}

function formatTrendPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function suppressedTrendMetric(reason: ValuationMetricSuppressionReason) {
  return { status: "suppressed" as const, display: "—", reason };
}

// Whole-column verdicts for a depository issuer, decided once from the issuer's SIC rather than
// Per empty cell: a bank with capex tagged in one year and untagged in the next would otherwise
// Print a real number in one row and "inapplicable" in the next row of the same column.
// A depository issuer reports no operating income in the industrial sense, and its cash flow
// Statement carries no capex line that a free-cash-flow proxy can subtract.
function notApplicableTrendMetric(rationale: string) {
  return { status: "not-applicable" as const, display: "not applicable", rationale };
}

const DEPOSITORY_OPERATING_MARGIN_RATIONALE =
  "depository issuer; no operating income in the industrial sense";
const DEPOSITORY_FREE_CASH_FLOW_RATIONALE =
  "depository issuer; capex-based free cash flow is not defined";

function financialTrendRows(
  history: FundamentalHistoryArtifact,
  depositoryIssuer: boolean,
): readonly FinancialTrendRow[] {
  // Both whole-column cells are resolved here, outside the per-period map, so a depository issuer
  // Renders the same verdict on every row whatever any single period happens to have tagged.
  const inapplicableOperatingMargin = depositoryIssuer
    ? metricCell(notApplicableTrendMetric(DEPOSITORY_OPERATING_MARGIN_RATIONALE))
    : undefined;
  const inapplicableFreeCashFlow = depositoryIssuer
    ? metricCell(notApplicableTrendMetric(DEPOSITORY_FREE_CASH_FLOW_RATIONALE))
    : undefined;
  return trendPeriods(history).map((period) => {
    const revenue = trendValue(history, "revenue", period);
    const netIncome = trendValue(history, "netIncome", period);
    const operatingMargin = trendValue(history, "operatingMargin", period);
    const freeCashFlow = trendValue(history, "freeCashFlowProxy", period);
    return {
      period: periodLabel(period),
      revenue:
        revenue === undefined
          ? metricCell(suppressedTrendMetric("revenue-unavailable"))
          : formatTrendAmount(revenue),
      netIncome:
        netIncome === undefined
          ? metricCell(suppressedTrendMetric("earnings-unavailable"))
          : formatTrendAmount(netIncome),
      operatingMargin:
        inapplicableOperatingMargin ??
        (operatingMargin === undefined
          ? metricCell(
              suppressedTrendMetric(
                revenue === undefined || revenue === 0
                  ? "revenue-unavailable"
                  : "numerator-unavailable",
              ),
            )
          : formatTrendPercent(operatingMargin)),
      freeCashFlow:
        inapplicableFreeCashFlow ??
        (freeCashFlow === undefined
          ? metricCell(suppressedTrendMetric("free-cash-flow-unavailable"))
          : formatTrendAmount(freeCashFlow)),
    };
  });
}

function financialTrendCurrency(history: FundamentalHistoryArtifact): string | undefined {
  return history.series.revenue.ttm?.currency ?? history.series.revenue.annual.at(-1)?.currency;
}

export function financialTrends(
  history: FundamentalHistoryArtifact | undefined,
  depositoryIssuer: boolean,
): EquityReaderFinancialTrends | undefined {
  if (history === undefined) {
    return undefined;
  }
  const rows = financialTrendRows(history, depositoryIssuer);
  if (rows.length === 0) {
    return undefined;
  }
  const reportingCurrency = financialTrendCurrency(history);
  return {
    ...(reportingCurrency === undefined ? {} : { reportingCurrency }),
    sourceIds: [history.sourceId],
    rows,
  };
}
