import { yearsBetween } from "./fiscal-years";
import {
  type FundamentalHistoryCagr,
  type FundamentalHistorySeries,
} from "../../src/sources/extended-evidence/fundamental-history";

interface ProjectedHistorySeries {
  readonly concept: string | null;
  readonly annual: FundamentalHistorySeries["annual"];
  readonly ttm: FundamentalHistorySeries["ttm"] | null;
  readonly cagr: FundamentalHistorySeries["cagr"] | null;
  readonly marginChange: FundamentalHistorySeries["marginChange"] | null;
}

interface ProjectedConsumers {
  readonly fundamentalHistory: Readonly<Record<string, ProjectedHistorySeries>>;
}

interface ProjectedStatementTtm {
  readonly value: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: string;
}

interface HistoryPropertyExecution {
  readonly projection: {
    readonly statements: Readonly<Record<string, { readonly ttm: ProjectedStatementTtm | null }>>;
    readonly canonical: ProjectedConsumers;
  };
}

function historySummarySpanMatches(
  annual: FundamentalHistorySeries["annual"],
  summary: Pick<FundamentalHistoryCagr, "periodStart" | "periodEnd" | "years">,
): boolean {
  const first = annual.find((point) => point.periodEnd === summary.periodStart);
  const last = annual.find((point) => point.periodEnd === summary.periodEnd);
  if (first === undefined || last === undefined || first === last) {
    return false;
  }
  const years = yearsBetween(first.periodEnd, last.periodEnd);
  return years > 0 && summary.years > 0 && Math.abs(summary.years - years) < 1e-12;
}

function historyCagrMatches(series: ProjectedHistorySeries): boolean {
  const summary = series.cagr;
  if (summary === null || summary === undefined) {
    return false;
  }
  const first = series.annual.find((point) => point.periodEnd === summary.periodStart);
  const last = series.annual.find((point) => point.periodEnd === summary.periodEnd);
  if (
    first === undefined ||
    last === undefined ||
    first.value <= 0 ||
    last.value <= 0 ||
    first.currency !== last.currency ||
    !historySummarySpanMatches(series.annual, summary)
  ) {
    return false;
  }
  const years = yearsBetween(first.periodEnd, last.periodEnd);
  const expected = ((last.value / first.value) ** (1 / years) - 1) * 100;
  return (
    Math.sign(summary.percent) === Math.sign(expected) &&
    Math.abs(summary.percent - expected) <=
      Math.max(1, Math.abs(summary.percent), Math.abs(expected)) * 1e-12
  );
}

function historyMarginChangeMatches(series: ProjectedHistorySeries): boolean {
  const summary = series.marginChange;
  const first = series.annual.at(0);
  const last = series.annual.at(-1);
  if (summary === null || summary === undefined || first === undefined || last === undefined) {
    return false;
  }
  return (
    historySummarySpanMatches(series.annual, summary) &&
    summary.periodStart === first.periodEnd &&
    summary.periodEnd === last.periodEnd &&
    Math.sign(summary.percentagePoints) === Math.sign(last.value - first.value)
  );
}

const TTM_MARGIN_COMPONENTS: Readonly<Record<string, readonly [string, string]>> = {
  grossMargin: ["grossProfit", "revenue"],
  netMargin: ["netIncome", "revenue"],
  operatingMargin: ["operatingIncome", "revenue"],
};

const RAW_TTM_MARGIN_DEPENDENTS: Readonly<Record<string, readonly string[]>> = {
  grossProfit: ["grossMargin"],
  netIncome: ["netMargin"],
  operatingIncome: ["operatingMargin"],
  revenue: ["grossMargin", "netMargin", "operatingMargin"],
};

function historyTtmShapeMatches(series: ProjectedHistorySeries): boolean {
  const { ttm } = series;
  const latestAnnual = series.annual.at(-1);
  return (
    ttm !== null &&
    ttm !== undefined &&
    latestAnnual !== undefined &&
    ttm.form === "TTM" &&
    ttm.periodMonths === 12 &&
    ttm.periodEnd > latestAnnual.periodEnd
  );
}

function historyMarginTtmMatches(consumers: ProjectedConsumers, seriesKey: string): boolean {
  const series = consumers.fundamentalHistory[seriesKey];
  const components = TTM_MARGIN_COMPONENTS[seriesKey];
  if (
    series === undefined ||
    !historyTtmShapeMatches(series) ||
    components === undefined ||
    series.ttm === null ||
    series.ttm === undefined
  ) {
    return false;
  }
  const left = consumers.fundamentalHistory[components[0]]?.ttm;
  const right = consumers.fundamentalHistory[components[1]]?.ttm;
  return (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    right.value !== 0 &&
    left.periodStart === right.periodStart &&
    left.periodEnd === right.periodEnd &&
    left.currency === right.currency &&
    series.ttm.periodStart === left.periodStart &&
    series.ttm.periodEnd === left.periodEnd &&
    series.ttm.value === left.value / right.value
  );
}

function historyRawMarginComponentTtmMatches(
  consumers: ProjectedConsumers,
  seriesKey: string,
): boolean {
  const dependents = RAW_TTM_MARGIN_DEPENDENTS[seriesKey];
  return (
    dependents !== undefined &&
    dependents
      .filter((dependent) => consumers.fundamentalHistory[dependent]?.ttm != null)
      .every((dependent) => historyMarginTtmMatches(consumers, dependent))
  );
}

function historyFreeCashFlowTtmMatches(consumers: ProjectedConsumers): boolean | undefined {
  const operatingCashFlow = consumers.fundamentalHistory.operatingCashFlow?.ttm;
  const capex = consumers.fundamentalHistory.capex?.ttm;
  const freeCashFlow = consumers.fundamentalHistory.freeCashFlowProxy?.ttm;
  const siblingCount = [capex, freeCashFlow].filter(
    (value) => value !== null && value !== undefined,
  ).length;
  if (siblingCount === 0) {
    return undefined;
  }
  return (
    operatingCashFlow !== null &&
    operatingCashFlow !== undefined &&
    capex !== null &&
    capex !== undefined &&
    freeCashFlow !== null &&
    freeCashFlow !== undefined &&
    operatingCashFlow.periodStart === capex.periodStart &&
    operatingCashFlow.periodEnd === capex.periodEnd &&
    operatingCashFlow.currency === capex.currency &&
    freeCashFlow.periodStart === operatingCashFlow.periodStart &&
    freeCashFlow.periodEnd === operatingCashFlow.periodEnd &&
    freeCashFlow.currency === operatingCashFlow.currency &&
    freeCashFlow.value === operatingCashFlow.value - capex.value
  );
}

function historyOperatingCashFlowTtmMatches(
  execution: HistoryPropertyExecution,
  consumers: ProjectedConsumers,
  series: ProjectedHistorySeries,
): boolean {
  const freeCashFlowMatches = historyFreeCashFlowTtmMatches(consumers);
  if (freeCashFlowMatches === false) {
    return false;
  }
  const statementTtm = execution.projection.statements.operatingCashFlow?.ttm;
  return (
    statementTtm !== null &&
    statementTtm !== undefined &&
    series.ttm !== null &&
    series.ttm !== undefined &&
    series.ttm.value === statementTtm.value &&
    series.ttm.periodStart === statementTtm.periodStart &&
    series.ttm.periodEnd === statementTtm.periodEnd &&
    series.ttm.currency === statementTtm.currency
  );
}

function historyTtmMatches(
  execution: HistoryPropertyExecution,
  consumers: ProjectedConsumers,
  seriesKey: string,
): boolean {
  const series = consumers.fundamentalHistory[seriesKey];
  if (series === undefined || !historyTtmShapeMatches(series)) {
    return false;
  }
  if (seriesKey === "dilutedEps") {
    // Diluted EPS has no sibling TTM identity; only its production-emitted shape is re-derivable.
    return true;
  }
  if (seriesKey === "capex" || seriesKey === "freeCashFlowProxy") {
    return historyFreeCashFlowTtmMatches(consumers) === true;
  }
  if (seriesKey === "operatingCashFlow") {
    return historyOperatingCashFlowTtmMatches(execution, consumers, series);
  }
  if (RAW_TTM_MARGIN_DEPENDENTS[seriesKey] !== undefined) {
    // These raw values are checked through every margin TTM that production derives from them.
    return historyRawMarginComponentTtmMatches(consumers, seriesKey);
  }
  return historyMarginTtmMatches(consumers, seriesKey);
}

export function canonicalHistoryPropertyFailures(execution: HistoryPropertyExecution): string[] {
  const consumers = execution.projection.canonical;
  return Object.entries(consumers.fundamentalHistory).flatMap(([seriesKey, series]) => [
    ...(series.cagr != null && !historyCagrMatches(series)
      ? [`fundamentalHistory.${seriesKey}.cagr`]
      : []),
    ...(series.marginChange != null && !historyMarginChangeMatches(series)
      ? [`fundamentalHistory.${seriesKey}.marginChange`]
      : []),
    ...(series.ttm != null && !historyTtmMatches(execution, consumers, seriesKey)
      ? [`fundamentalHistory.${seriesKey}.ttm`]
      : []),
  ]);
}
