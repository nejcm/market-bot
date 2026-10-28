import {
  conceptScope,
  CAPEX_SCOPE_CAVEAT,
  netMarginNumerator,
  NEGATIVE_CAPEX_REASON,
  scopedLabel,
  TOTAL_OPERATIONS_SCOPE,
} from "./financial-statement-definitions";
import type { AnnualReportForm, OriginalFiling } from "./financial-statements-contract";

export type FundamentalHistorySeriesKey =
  | "revenue"
  | "grossProfit"
  | "operatingIncome"
  | "netIncome"
  | "dilutedEps"
  | "operatingCashFlow"
  | "capex"
  | "freeCashFlowProxy"
  | "grossMargin"
  | "operatingMargin"
  | "netMargin";

export interface FundamentalHistoryPoint {
  readonly value: number;
  readonly form: AnnualReportForm | "TTM";
  readonly fy: number;
  readonly fp: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly periodMonths: number;
  readonly filedAt: string;
  readonly currency: string;
  readonly restatedFrom?: OriginalFiling;
}

export interface FundamentalHistoryCagr {
  readonly percent: number;
  readonly years: number;
  readonly periodStart: string;
  readonly periodEnd: string;
}

interface FundamentalHistoryMarginChange {
  readonly percentagePoints: number;
  readonly years: number;
  readonly periodStart: string;
  readonly periodEnd: string;
}

export interface FundamentalHistorySeries {
  readonly key: FundamentalHistorySeriesKey;
  readonly label: string;
  readonly unit: "currency" | "per-share" | "ratio";
  readonly concept?: string;
  readonly scope?: string;
  readonly annual: readonly FundamentalHistoryPoint[];
  readonly ttm?: FundamentalHistoryPoint;
  readonly cagr?: FundamentalHistoryCagr;
  readonly marginChange?: FundamentalHistoryMarginChange;
  readonly notes: readonly string[];
}

export interface FundamentalHistoryArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly symbol: string;
  readonly sourceId: string;
  readonly sourceUrl?: string;
  readonly series: Readonly<Record<FundamentalHistorySeriesKey, FundamentalHistorySeries>>;
}

export const CONTINUING_INCOME_HISTORY = {
  key: "netIncome",
  label: "Income from continuing operations",
  unit: "currency",
} as const;

const MAX_CAGR_YEARS = 5;
const DAYS_PER_YEAR = 365.2425;
export const MIN_CAGR_ANNUAL_POINTS = 3;

function daysBetween(start: string, end: string): number | undefined {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return undefined;
  }
  return (endMs - startMs) / 86_400_000;
}

export function negativeCapexTtmNote(periodEnd: string): string {
  return `ttm:negative-capex: ${periodEnd} omitted; ${NEGATIVE_CAPEX_REASON}`;
}

const FISCAL_YEAR_END_TOLERANCE_DAYS = 7;

// 52/53-week fiscal years drift up to a week; a larger offset means the fiscal year end moved.
function fiscalYearsBetween(start: string, end: string): number | undefined {
  const days = daysBetween(start, end);
  if (days === undefined) {
    return undefined;
  }
  const years = Math.round(days / DAYS_PER_YEAR);
  return Math.abs(days - years * DAYS_PER_YEAR) <= FISCAL_YEAR_END_TOLERANCE_DAYS
    ? years
    : undefined;
}

export function fundamentalHistoryCagr(
  annual: readonly FundamentalHistoryPoint[],
  notes: string[],
): FundamentalHistoryCagr | undefined {
  const latest = annual.at(-1);
  if (latest === undefined) {
    notes.push("cagr:insufficient-points: no annual points");
    return undefined;
  }
  const maxSpanDays = MAX_CAGR_YEARS * DAYS_PER_YEAR + FISCAL_YEAR_END_TOLERANCE_DAYS;
  const window = annual.filter((point) => {
    const days = daysBetween(point.periodEnd, latest.periodEnd);
    return days !== undefined && days >= 0 && days <= maxSpanDays;
  });
  if (window.some((point) => fiscalYearsBetween(point.periodEnd, latest.periodEnd) === undefined)) {
    notes.push(
      "cagr:fiscal-year-transition: annual period ends in the window are not fiscal-year aligned",
    );
    return undefined;
  }
  if (window.length < MIN_CAGR_ANNUAL_POINTS) {
    notes.push(
      `cagr:insufficient-points: ${String(window.length)} annual point(s) in the <=5 FY window`,
    );
    return undefined;
  }
  const first = window[0]!;
  const years = fiscalYearsBetween(first.periodEnd, latest.periodEnd) ?? 0;
  if (years <= 0) {
    notes.push("cagr:invalid-span: annual endpoint dates do not define a positive span");
    return undefined;
  }
  if (first.periodMonths !== 12 || latest.periodMonths !== 12) {
    notes.push(
      "cagr:incomplete-fiscal-year: an annual endpoint does not span a complete fiscal year",
    );
    return undefined;
  }
  if (first.value <= 0 || latest.value <= 0) {
    notes.push("cagr:non-positive-endpoint: both annual endpoints must be greater than zero");
    return undefined;
  }
  if (first.currency !== latest.currency) {
    notes.push("cagr:currency-mismatch: annual endpoints do not use the same unit");
    return undefined;
  }
  return {
    percent: ((latest.value / first.value) ** (1 / years) - 1) * 100,
    years,
    periodStart: first.periodEnd,
    periodEnd: latest.periodEnd,
  };
}

function derivedPoint(
  left: FundamentalHistoryPoint,
  right: FundamentalHistoryPoint,
  value: number,
): FundamentalHistoryPoint {
  return {
    value,
    form: left.form,
    fy: left.fy,
    fp: left.fp,
    periodStart: left.periodStart,
    periodEnd: left.periodEnd,
    periodMonths: left.periodMonths,
    filedAt: [left.filedAt, right.filedAt].toSorted().at(-1)!,
    currency: left.currency,
  };
}

function pairSeries(
  key: "freeCashFlowProxy" | "grossMargin" | "operatingMargin" | "netMargin",
  label: string,
  left: FundamentalHistorySeries,
  right: FundamentalHistorySeries,
  operation: (leftValue: number, rightValue: number) => number | undefined,
): FundamentalHistorySeries {
  const notes = [...left.notes, ...right.notes].filter((note) => note.startsWith("derived:"));
  const rightByEnd = new Map(right.annual.map((point) => [point.periodEnd, point]));
  const annual = left.annual.flatMap((leftPoint) => {
    const rightPoint = rightByEnd.get(leftPoint.periodEnd);
    if (rightPoint === undefined) {
      notes.push(
        `annual:unmatched-period: ${leftPoint.periodEnd} has no matching ${right.key} point`,
      );
      return [];
    }
    if (leftPoint.currency !== rightPoint.currency) {
      notes.push(`annual:currency-mismatch: ${leftPoint.periodEnd} omitted`);
      return [];
    }
    if (key === "freeCashFlowProxy" && rightPoint.value < 0) {
      notes.push(`annual:negative-capex: ${leftPoint.periodEnd} omitted; ${NEGATIVE_CAPEX_REASON}`);
      return [];
    }
    const value = operation(leftPoint.value, rightPoint.value);
    if (value === undefined) {
      notes.push(`annual:invalid-denominator: ${leftPoint.periodEnd} omitted`);
      return [];
    }
    return [derivedPoint(leftPoint, rightPoint, value)];
  });
  const leftEnds = new Set(left.annual.map((point) => point.periodEnd));
  for (const rightPoint of right.annual) {
    if (!leftEnds.has(rightPoint.periodEnd)) {
      notes.push(
        `annual:unmatched-period: ${rightPoint.periodEnd} has no matching ${left.key} point`,
      );
    }
  }

  let ttm: FundamentalHistoryPoint | undefined = undefined;
  const negativeCapexTtm = right.notes.find(
    (note) => key === "freeCashFlowProxy" && note.startsWith("ttm:negative-capex:"),
  );
  if (negativeCapexTtm !== undefined) {
    notes.push(negativeCapexTtm);
  } else if (left.ttm === undefined || right.ttm === undefined) {
    notes.push("ttm:missing-component: both component TTM points are required");
  } else if (
    left.ttm.periodEnd !== right.ttm.periodEnd ||
    left.ttm.periodStart !== right.ttm.periodStart
  ) {
    notes.push("ttm:period-misaligned: component TTM periods do not match");
  } else if (left.ttm.currency !== right.ttm.currency) {
    notes.push("ttm:currency-mismatch: component TTM units do not match");
  } else {
    const value = operation(left.ttm.value, right.ttm.value);
    if (value === undefined) {
      notes.push("ttm:invalid-denominator: component TTM denominator is zero");
    } else {
      ttm = derivedPoint(left.ttm, right.ttm, value);
    }
  }

  if (key === "freeCashFlowProxy") {
    const growth = fundamentalHistoryCagr(annual, notes);
    return {
      key,
      label,
      unit: "currency",
      annual,
      ...(ttm !== undefined ? { ttm } : {}),
      ...(growth !== undefined ? { cagr: growth } : {}),
      notes,
    };
  }

  let marginChange: FundamentalHistoryMarginChange | undefined = undefined;
  const [first] = annual;
  const latest = annual.at(-1);
  if (first === undefined || latest === undefined || first === latest) {
    notes.push(
      "margin-change:insufficient-points: at least two matched annual points are required",
    );
  } else {
    const years = fiscalYearsBetween(first.periodEnd, latest.periodEnd) ?? 0;
    if (years <= 0) {
      notes.push("margin-change:invalid-span: annual endpoint dates do not define a positive span");
    } else {
      marginChange = {
        percentagePoints: (latest.value - first.value) * 100,
        years,
        periodStart: first.periodEnd,
        periodEnd: latest.periodEnd,
      };
    }
  }
  return {
    key,
    label,
    unit: "ratio",
    annual,
    ...(ttm !== undefined ? { ttm } : {}),
    ...(marginChange !== undefined ? { marginChange } : {}),
    notes,
  };
}

// Total earnings carry a scope only while a continuing counterpart is as current as they are.
export function totalOperationsScopes(
  latestEnd: (key: EarningsHistoryKey) => string | undefined,
): FundamentalHistoryEarningsScopes {
  const scope = (total: EarningsHistoryKey, continuing: EarningsHistoryKey) => {
    const totalEnd = latestEnd(total);
    const continuingEnd = latestEnd(continuing);
    return totalEnd !== undefined && continuingEnd !== undefined && continuingEnd >= totalEnd
      ? TOTAL_OPERATIONS_SCOPE
      : undefined;
  };
  const netIncome = scope("netIncome", "continuingIncome");
  const dilutedEps = scope("dilutedEps", "continuingDilutedEps");
  return {
    ...(netIncome === undefined ? {} : { netIncome }),
    ...(dilutedEps === undefined ? {} : { dilutedEps }),
  };
}

type EarningsHistoryKey = "netIncome" | "dilutedEps" | "continuingIncome" | "continuingDilutedEps";

export type FundamentalHistoryEarningsScopes = Partial<Record<"netIncome" | "dilutedEps", string>>;

function withEarningsScope(
  series: FundamentalHistorySeries,
  scope: string | undefined,
): FundamentalHistorySeries {
  return scope === undefined
    ? series
    : { ...series, label: scopedLabel(series.label, scope), scope };
}

export type FundamentalHistoryRawSeries = Readonly<
  Record<
    | "revenue"
    | "grossProfit"
    | "operatingIncome"
    | "netIncome"
    | "dilutedEps"
    | "operatingCashFlow"
    | "capex",
    FundamentalHistorySeries
  >
>;

export function endsWithin(ends: readonly string[]): (point: FundamentalHistoryPoint) => boolean {
  return (point) => ends.some((end) => end > point.periodStart && end <= point.periodEnd);
}

function samePeriod(left: FundamentalHistoryPoint, right: FundamentalHistoryPoint): boolean {
  return left.periodStart === right.periodStart && left.periodEnd === right.periodEnd;
}

export interface NetMarginIncomeHistory {
  readonly continuing: FundamentalHistorySeries;
  readonly consolidatedContinuing: FundamentalHistorySeries;
  readonly consolidated: FundamentalHistorySeries;
  readonly reportsDiscontinued: (point: FundamentalHistoryPoint) => boolean;
  readonly reportsNoncontrolling: (point: FundamentalHistoryPoint) => boolean;
}

function netMarginIncome(
  total: FundamentalHistorySeries,
  inputs: NetMarginIncomeHistory,
): { readonly series: FundamentalHistorySeries; readonly continuing: boolean } {
  const continuingPoints = new Set<FundamentalHistoryPoint>();
  const pick = (
    point: FundamentalHistoryPoint,
    find: (series: FundamentalHistorySeries) => FundamentalHistoryPoint | undefined,
  ) => {
    const consolidatedContinuing = find(inputs.consolidatedContinuing);
    const continuing = find(inputs.continuing);
    const consolidated = find(inputs.consolidated);
    const picked = netMarginNumerator({
      consolidatedContinuing,
      continuing,
      consolidated,
      total: point,
      discontinued: inputs.reportsDiscontinued(point),
      noncontrolling:
        inputs.reportsNoncontrolling(point) ||
        (consolidated !== undefined && consolidated.value !== point.value),
    });
    if (picked !== undefined && (picked === consolidatedContinuing || picked === continuing)) {
      continuingPoints.add(picked);
    }
    return picked;
  };
  const annual = total.annual.flatMap((point) => {
    const picked = pick(point, (series) =>
      series.annual.find((candidate) => samePeriod(candidate, point)),
    );
    return picked === undefined ? [] : [picked];
  });
  const ttm =
    total.ttm === undefined
      ? undefined
      : pick(total.ttm, (series) =>
          series.ttm !== undefined && samePeriod(series.ttm, total.ttm!) ? series.ttm : undefined,
        );
  const series =
    annual.length === total.annual.length &&
    annual.every((point, index) => point === total.annual[index]) &&
    ttm === total.ttm
      ? total
      : { ...withoutTtm(total), annual, ...(ttm === undefined ? {} : { ttm }) };
  return { series, continuing: continuingPoints.size > 0 };
}

function withoutTtm({ ttm: _ttm, ...series }: FundamentalHistorySeries): FundamentalHistorySeries {
  return series;
}

function withCashFlowScope(
  series: FundamentalHistorySeries,
  scope: string | undefined,
): FundamentalHistorySeries {
  return scope === undefined ? series : { ...series, label: scopedLabel(series.label, scope) };
}

export function buildFundamentalHistorySeries(
  raw: FundamentalHistoryRawSeries,
  scopes: FundamentalHistoryEarningsScopes,
  netMarginInputs: NetMarginIncomeHistory,
): FundamentalHistoryArtifact["series"] {
  const cashFlowScope = conceptScope(raw.operatingCashFlow.concept);
  const scopedOperatingCashFlow = withCashFlowScope(raw.operatingCashFlow, cashFlowScope);
  const netMarginNumerators = netMarginIncome(raw.netIncome, netMarginInputs);
  const freeCashFlowPairs = pairSeries(
    "freeCashFlowProxy",
    scopedLabel("Free cash flow proxy", cashFlowScope),
    scopedOperatingCashFlow,
    raw.capex,
    (operatingCashFlow, capex) => operatingCashFlow - capex,
  );
  const freeCashFlowProxy =
    cashFlowScope === undefined
      ? freeCashFlowPairs
      : {
          ...freeCashFlowPairs,
          notes: [...freeCashFlowPairs.notes, `scope:capex-unscoped: ${CAPEX_SCOPE_CAVEAT}`],
        };
  const grossMargin = pairSeries(
    "grossMargin",
    "Gross margin",
    raw.grossProfit,
    raw.revenue,
    (grossProfit, revenue) => (revenue === 0 ? undefined : grossProfit / revenue),
  );
  const operatingMargin = pairSeries(
    "operatingMargin",
    "Operating margin",
    raw.operatingIncome,
    raw.revenue,
    (operatingIncome, revenue) => (revenue === 0 ? undefined : operatingIncome / revenue),
  );
  const netMargin = pairSeries(
    "netMargin",
    netMarginNumerators.continuing ? "Net margin (continuing operations)" : "Net margin",
    netMarginNumerators.series,
    raw.revenue,
    (netIncome, revenue) => (revenue === 0 ? undefined : netIncome / revenue),
  );

  return {
    revenue: raw.revenue,
    grossProfit: raw.grossProfit,
    operatingIncome: raw.operatingIncome,
    netIncome: withEarningsScope(raw.netIncome, scopes.netIncome),
    dilutedEps: withEarningsScope(raw.dilutedEps, scopes.dilutedEps),
    operatingCashFlow: scopedOperatingCashFlow,
    capex: raw.capex,
    freeCashFlowProxy,
    grossMargin,
    operatingMargin,
    netMargin,
  };
}
