import { isRecord } from "../../guards";
import type { CollectContext } from "../types";
import { readArray } from "./utils";
import {
  SEC_METRIC_DEFINITIONS,
  fetchSecCompanyFactsForSymbol,
  isFactObservableAsOf,
  periodMonths,
  readSecFactValue,
  type SecFactValue,
  type SecMetricDefinition,
} from "./sec-edgar";

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
  readonly form: "10-K" | "TTM";
  readonly fy: number;
  readonly fp: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly periodMonths: number;
  readonly filedAt: string;
  readonly currency: string;
}

export interface FundamentalHistoryCagr {
  readonly percent: number;
  readonly years: number;
  readonly periodStart: string;
  readonly periodEnd: string;
}

export interface FundamentalHistoryMarginChange {
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

export interface FundamentalHistoryDeriveInput {
  readonly symbol: string;
  readonly generatedAt: string;
  readonly analysisAsOf?: string;
  readonly sourceId: string;
  readonly sourceUrl?: string;
}

interface SelectedFacts {
  readonly concept: string;
  readonly currency: string;
  readonly facts: readonly SecFactValue[];
}

interface FactWithPeriod extends SecFactValue {
  readonly fp: string;
  readonly fy: number;
  readonly filed: string;
  readonly start: string;
  readonly end: string;
  readonly months: number;
}

interface RawSeriesDefinition {
  readonly key:
    | "revenue"
    | "grossProfit"
    | "operatingIncome"
    | "netIncome"
    | "dilutedEps"
    | "operatingCashFlow"
    | "capex";
  readonly label: string;
  readonly unit: "currency" | "per-share";
}

const RAW_SERIES: readonly RawSeriesDefinition[] = [
  { key: "revenue", label: "Revenue", unit: "currency" },
  { key: "grossProfit", label: "Gross profit", unit: "currency" },
  { key: "operatingIncome", label: "Operating income", unit: "currency" },
  { key: "netIncome", label: "Net income", unit: "currency" },
  { key: "dilutedEps", label: "Diluted EPS", unit: "per-share" },
  { key: "operatingCashFlow", label: "Operating cash flow", unit: "currency" },
  { key: "capex", label: "Capital expenditure", unit: "currency" },
];

const MAX_ANNUAL_POINTS = 10;
const MAX_CAGR_YEARS = 5;
const DAYS_PER_YEAR = 365.2425;
const ALIGNMENT_MIN_DAYS = 350;
const ALIGNMENT_MAX_DAYS = 380;
const FY_BOUNDARY_TOLERANCE_DAYS = 10;
const EPS_TTM_APPROXIMATION_NOTE =
  "ttm:eps-approximation: diluted EPS TTM adds per-share periods and does not reweight diluted shares";

function metricDefinition(key: RawSeriesDefinition["key"]): SecMetricDefinition {
  const definition = SEC_METRIC_DEFINITIONS.find((candidate) => candidate.key === key);
  if (definition === undefined) {
    throw new Error(`Missing SEC metric definition for ${key}`);
  }
  return definition;
}

function selectFacts(payload: unknown, definition: SecMetricDefinition): SelectedFacts | undefined {
  if (!isRecord(payload) || !isRecord(payload.facts) || !isRecord(payload.facts["us-gaap"])) {
    return undefined;
  }
  const gaap = payload.facts["us-gaap"];
  for (const concept of definition.concepts) {
    const fact = isRecord(gaap[concept]) ? gaap[concept] : undefined;
    const units = fact !== undefined && isRecord(fact.units) ? fact.units : undefined;
    if (units === undefined) {
      continue;
    }
    for (const currency of definition.unitKeys) {
      const facts = readArray(units, currency).flatMap((value) => {
        const parsed = readSecFactValue(value);
        return parsed === undefined ? [] : [parsed];
      });
      if (facts.length > 0) {
        return { concept, currency, facts };
      }
    }
  }
  return undefined;
}

function factSignature(fact: SecFactValue): string {
  return `${fact.end ?? "unknown-end"}@${fact.filed ?? "unknown-filed"}`;
}

function completeFact(fact: SecFactValue): FactWithPeriod | undefined {
  const months = periodMonths(fact);
  if (
    fact.fp === undefined ||
    fact.fy === undefined ||
    fact.filed === undefined ||
    fact.start === undefined ||
    fact.end === undefined ||
    months === undefined
  ) {
    return undefined;
  }
  return {
    ...fact,
    fp: fact.fp,
    fy: fact.fy,
    filed: fact.filed,
    start: fact.start,
    end: fact.end,
    months,
  };
}

function compareLatestFiled(left: FactWithPeriod, right: FactWithPeriod): number {
  const filed = right.filed.localeCompare(left.filed);
  if (filed !== 0) {
    return filed;
  }
  return factSignature(right).localeCompare(factSignature(left));
}

function dedupeFactsByPeriodEnd(facts: readonly FactWithPeriod[]): readonly FactWithPeriod[] {
  const byPeriodEnd = new Map<string, FactWithPeriod[]>();
  for (const fact of facts) {
    byPeriodEnd.set(fact.end, [...(byPeriodEnd.get(fact.end) ?? []), fact]);
  }
  return [...byPeriodEnd.values()].map((matches) => matches.toSorted(compareLatestFiled)[0]!);
}

function dedupeQuarterlyFacts(facts: readonly FactWithPeriod[]): readonly FactWithPeriod[] {
  const byPeriod = new Map<string, FactWithPeriod[]>();
  for (const fact of facts) {
    const key = `${fact.start}|${fact.end}|${fact.fp}|${String(fact.fy)}`;
    byPeriod.set(key, [...(byPeriod.get(key) ?? []), fact]);
  }
  return [...byPeriod.values()].map((matches) => matches.toSorted(compareLatestFiled)[0]!);
}

function annualPoint(fact: FactWithPeriod, currency: string): FundamentalHistoryPoint {
  return {
    value: fact.val,
    form: "10-K",
    fy: fact.fy,
    fp: fact.fp,
    periodStart: fact.start,
    periodEnd: fact.end,
    periodMonths: fact.months,
    filedAt: fact.filed,
    currency,
  };
}

function daysBetween(start: string, end: string): number | undefined {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return undefined;
  }
  return (endMs - startMs) / 86_400_000;
}

function isYearAligned(prior: string, latest: string): boolean {
  const days = daysBetween(prior, latest);
  return days !== undefined && days >= ALIGNMENT_MIN_DAYS && days <= ALIGNMENT_MAX_DAYS;
}

function nextDay(value: string): string {
  const parsed = Date.parse(value);
  return new Date(parsed + 86_400_000).toISOString().slice(0, 10);
}

function ttmPoint(
  annual: readonly FundamentalHistoryPoint[],
  observableFacts: readonly SecFactValue[],
  currency: string,
  notes: string[],
): FundamentalHistoryPoint | undefined {
  const fullFy = annual.at(-1);
  if (fullFy === undefined) {
    notes.push("ttm:missing-full-fy: no eligible 10-K annual point");
    return undefined;
  }

  const completeQuarterly = observableFacts
    .filter((fact) => fact.form === "10-Q")
    .flatMap((fact) => {
      const complete = completeFact(fact);
      return complete === undefined || complete.months >= 10 ? [] : [complete];
    });
  const [latestYtd] = dedupeQuarterlyFacts(completeQuarterly)
    .filter((fact) => fact.end > fullFy.periodEnd)
    .toSorted((left, right) => {
      const periodEnd = right.end.localeCompare(left.end);
      if (periodEnd !== 0) {
        return periodEnd;
      }
      const leftBoundary = Math.abs(daysBetween(fullFy.periodEnd, left.start) ?? Infinity);
      const rightBoundary = Math.abs(daysBetween(fullFy.periodEnd, right.start) ?? Infinity);
      return leftBoundary - rightBoundary || compareLatestFiled(left, right);
    });
  if (latestYtd === undefined) {
    notes.push("ttm:missing-latest-ytd: no complete post-FY 10-Q duration fact");
    return undefined;
  }

  const [priorYtd] = dedupeQuarterlyFacts(completeQuarterly)
    .filter((fact) => fact.fy === latestYtd.fy - 1 && fact.end < fullFy.periodEnd)
    .toSorted((left, right) => {
      const leftEndAlignment = Math.abs(
        (daysBetween(left.end, latestYtd.end) ?? Infinity) - DAYS_PER_YEAR,
      );
      const rightEndAlignment = Math.abs(
        (daysBetween(right.end, latestYtd.end) ?? Infinity) - DAYS_PER_YEAR,
      );
      const leftStartAlignment = Math.abs(daysBetween(fullFy.periodStart, left.start) ?? Infinity);
      const rightStartAlignment = Math.abs(
        daysBetween(fullFy.periodStart, right.start) ?? Infinity,
      );
      return (
        leftEndAlignment - rightEndAlignment ||
        leftStartAlignment - rightStartAlignment ||
        compareLatestFiled(left, right)
      );
    });
  if (priorYtd === undefined) {
    notes.push("ttm:missing-prior-ytd: no prior-fiscal-year 10-Q duration fact");
    return undefined;
  }
  if (
    latestYtd.fp !== priorYtd.fp ||
    latestYtd.months !== priorYtd.months ||
    !isYearAligned(priorYtd.start, latestYtd.start) ||
    !isYearAligned(priorYtd.end, latestYtd.end)
  ) {
    notes.push("ttm:ytd-period-misaligned: latest and prior-year YTD periods do not align");
    return undefined;
  }

  const startAlignment = Math.abs(daysBetween(fullFy.periodStart, priorYtd.start) ?? Infinity);
  const boundaryAlignment = Math.abs(daysBetween(fullFy.periodEnd, latestYtd.start) ?? Infinity);
  if (
    fullFy.fy !== priorYtd.fy ||
    startAlignment > FY_BOUNDARY_TOLERANCE_DAYS ||
    boundaryAlignment > FY_BOUNDARY_TOLERANCE_DAYS ||
    priorYtd.end >= fullFy.periodEnd
  ) {
    notes.push(
      "ttm:fy-ytd-period-misaligned: full FY does not contain prior YTD and precede latest YTD",
    );
    return undefined;
  }
  if (fullFy.currency !== currency) {
    notes.push("ttm:currency-mismatch: FY and YTD facts do not use the same unit");
    return undefined;
  }

  return {
    value: fullFy.value + latestYtd.val - priorYtd.val,
    form: "TTM",
    fy: latestYtd.fy,
    fp: "TTM",
    periodStart: nextDay(priorYtd.end),
    periodEnd: latestYtd.end,
    periodMonths: 12,
    filedAt: [fullFy.filedAt, latestYtd.filed, priorYtd.filed].toSorted().at(-1)!,
    currency,
  };
}

function cagr(
  annual: readonly FundamentalHistoryPoint[],
  notes: string[],
): FundamentalHistoryCagr | undefined {
  const latest = annual.at(-1);
  if (latest === undefined) {
    notes.push("cagr:insufficient-points: no annual points");
    return undefined;
  }
  const window = annual.filter((point) => {
    const days = daysBetween(point.periodEnd, latest.periodEnd);
    return days !== undefined && days >= 0 && days / DAYS_PER_YEAR <= MAX_CAGR_YEARS;
  });
  if (window.length < 3) {
    notes.push(
      `cagr:insufficient-points: ${String(window.length)} annual point(s) in the <=5 FY window`,
    );
    return undefined;
  }
  const first = window[0]!;
  const years = (daysBetween(first.periodEnd, latest.periodEnd) ?? 0) / DAYS_PER_YEAR;
  if (years <= 0) {
    notes.push("cagr:invalid-span: annual endpoint dates do not define a positive span");
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

function rawSeries(
  payload: unknown,
  definition: RawSeriesDefinition,
  analysisAsOf?: string,
): FundamentalHistorySeries {
  const selected = selectFacts(payload, metricDefinition(definition.key));
  const notes: string[] = [];
  if (selected === undefined) {
    notes.push("annual:missing-concept: no SEC facts found for the ordered concept list");
    const annual: readonly FundamentalHistoryPoint[] = [];
    ttmPoint(annual, [], "", notes);
    const growth = cagr(annual, notes);
    return {
      ...definition,
      annual,
      ...(growth !== undefined ? { cagr: growth } : {}),
      notes,
    };
  }

  const observableFacts = selected.facts.filter((fact) => isFactObservableAsOf(fact, analysisAsOf));
  const excludedAsOf = selected.facts.length - observableFacts.length;
  if (excludedAsOf > 0) {
    notes.push(
      `annual:excluded-as-of: ${String(excludedAsOf)} fact(s) were not observable at the cutoff`,
    );
  }

  const annualCandidates: FactWithPeriod[] = [];
  for (const fact of observableFacts.filter((candidate) => candidate.form === "10-K")) {
    const complete = completeFact(fact);
    if (complete === undefined) {
      notes.push(`annual:incomplete-metadata: ${factSignature(fact)} omitted`);
      continue;
    }
    if (complete.months < 10 || complete.months > 14) {
      notes.push(
        `annual:transition-period: ${complete.end} (${String(complete.months)} months) omitted`,
      );
      continue;
    }
    annualCandidates.push(complete);
  }

  const deduped = dedupeFactsByPeriodEnd(annualCandidates);
  for (const fact of annualCandidates) {
    const winner = deduped.find((candidate) => candidate.end === fact.end)!;
    if (winner !== fact) {
      notes.push(
        `annual:restatement-superseded: ${fact.end} filed ${fact.filed} omitted for filed ${winner.filed}`,
      );
    }
  }
  const chronological = deduped.toSorted((left, right) => left.end.localeCompare(right.end));
  const omittedByCap = Math.max(0, chronological.length - MAX_ANNUAL_POINTS);
  if (omittedByCap > 0) {
    notes.push(`annual:history-cap: ${String(omittedByCap)} older annual point(s) omitted`);
  }
  const annual = chronological
    .slice(-MAX_ANNUAL_POINTS)
    .map((fact) => annualPoint(fact, selected.currency));
  const ttm = ttmPoint(annual, observableFacts, selected.currency, notes);
  if (definition.key === "dilutedEps" && ttm !== undefined) {
    notes.push(EPS_TTM_APPROXIMATION_NOTE);
  }
  const growth = cagr(annual, notes);
  return {
    ...definition,
    concept: selected.concept,
    annual,
    ...(ttm !== undefined ? { ttm } : {}),
    ...(growth !== undefined ? { cagr: growth } : {}),
    notes,
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
  const notes: string[] = [];
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
  if (left.ttm === undefined || right.ttm === undefined) {
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
    const growth = cagr(annual, notes);
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
    const years = (daysBetween(first.periodEnd, latest.periodEnd) ?? 0) / DAYS_PER_YEAR;
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

export function deriveFundamentalHistory(
  payload: unknown,
  input: FundamentalHistoryDeriveInput,
): FundamentalHistoryArtifact {
  const raw = Object.fromEntries(
    RAW_SERIES.map((definition) => [
      definition.key,
      rawSeries(payload, definition, input.analysisAsOf),
    ]),
  ) as Record<RawSeriesDefinition["key"], FundamentalHistorySeries>;
  const freeCashFlowProxy = pairSeries(
    "freeCashFlowProxy",
    "Free cash flow proxy",
    raw.operatingCashFlow,
    raw.capex,
    (operatingCashFlow, capex) => operatingCashFlow - capex,
  );
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
    "Net margin",
    raw.netIncome,
    raw.revenue,
    (netIncome, revenue) => (revenue === 0 ? undefined : netIncome / revenue),
  );

  return {
    version: 1,
    generatedAt: input.generatedAt,
    symbol: input.symbol.toUpperCase(),
    sourceId: input.sourceId,
    ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
    series: {
      revenue: raw.revenue,
      grossProfit: raw.grossProfit,
      operatingIncome: raw.operatingIncome,
      netIncome: raw.netIncome,
      dilutedEps: raw.dilutedEps,
      operatingCashFlow: raw.operatingCashFlow,
      capex: raw.capex,
      freeCashFlowProxy,
      grossMargin,
      operatingMargin,
      netMargin,
    },
  };
}

export async function collectFundamentalHistory(
  context: CollectContext,
  symbol: string,
): Promise<FundamentalHistoryArtifact | undefined> {
  const facts = await fetchSecCompanyFactsForSymbol(context, symbol);
  if (facts.factsPayload === undefined || facts.sourceId === undefined) {
    return undefined;
  }
  return deriveFundamentalHistory(facts.factsPayload, {
    symbol,
    generatedAt: context.fetchedAt,
    analysisAsOf: context.fetchedAt,
    sourceId: facts.sourceId,
    ...(facts.sourceUrl !== undefined ? { sourceUrl: facts.sourceUrl } : {}),
  });
}
