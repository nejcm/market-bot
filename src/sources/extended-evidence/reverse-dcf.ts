import { isRecord, readNumber, readString, readStringArray } from "../../guards";
import type { ValuationWorkbenchArtifact } from "./valuation-workbench-contract";

export const REVERSE_DCF_DISCOUNT_RATES_PCT = [8, 9, 10, 11, 12, 13, 14, 15, 16] as const;
export const REVERSE_DCF_TERMINAL_GROWTH_RATES_PCT = [0, 1, 2, 3, 4] as const;
export const REVERSE_DCF_HORIZON_YEARS = 5;

const MIN_SOLVED_GROWTH = -0.99;
const MAX_SOLVED_GROWTH = 5;
const SOLVER_ITERATIONS = 160;
const PERCENT_SCALE = 100;
const RESULT_DECIMAL_PLACES = 4;
const SUPPRESSION_REASONS = new Set<ReverseDcfSuppressionReason>([
  "reconciled-ttm-fcf-unavailable",
  "starting-fcf-not-positive",
  "enterprise-value-unavailable",
  "enterprise-value-not-positive",
  "input-date-unavailable",
  "input-currency-unavailable",
  "input-currency-mismatch",
]);

export interface ReverseDcfStartingFcfAssumption {
  readonly value: number;
  readonly currency: string;
  readonly periodEnd: string;
  readonly publicAt: string;
  readonly sourceIds: readonly string[];
}

export interface ReverseDcfEnterpriseValueAssumption {
  readonly value: number;
  readonly currency: string;
  readonly observedAt: string;
  readonly sourceIds: readonly string[];
}

export type ReverseDcfGridCell =
  | {
      readonly status: "solved";
      readonly terminalGrowthRatePct: number;
      readonly solvedFiveYearFcfGrowthPct: number;
    }
  | {
      readonly status: "not-solved";
      readonly terminalGrowthRatePct: number;
      readonly reason: "outside-solver-bounds";
    };

export interface ReverseDcfGridRow {
  readonly discountRatePct: number;
  readonly cells: readonly ReverseDcfGridCell[];
}

export type ReverseDcfSuppressionReason =
  | "reconciled-ttm-fcf-unavailable"
  | "starting-fcf-not-positive"
  | "enterprise-value-unavailable"
  | "enterprise-value-not-positive"
  | "input-date-unavailable"
  | "input-currency-unavailable"
  | "input-currency-mismatch";

interface ReverseDcfArtifactBase {
  readonly version: 1;
  readonly generatedAt: string;
  readonly symbol: string;
  readonly sourceIds: readonly string[];
}

export type ReverseDcfArtifact =
  | (ReverseDcfArtifactBase & {
      readonly status: "computed";
      readonly assumptions: {
        readonly startingFcf: ReverseDcfStartingFcfAssumption;
        readonly enterpriseValue: ReverseDcfEnterpriseValueAssumption;
        readonly horizonYears: 5;
        readonly discountRatesPct: readonly number[];
        readonly terminalGrowthRatesPct: readonly number[];
      };
      readonly grid: {
        readonly value: "solved five-year FCF growth";
        readonly unit: "percent";
        readonly rows: readonly ReverseDcfGridRow[];
      };
    })
  | (ReverseDcfArtifactBase & {
      readonly status: "suppressed";
      readonly reason: ReverseDcfSuppressionReason;
      readonly detail: string;
    });

export interface BuildReverseDcfInput {
  readonly generatedAt: string;
  readonly symbol: string;
  readonly valuationWorkbench?: ValuationWorkbenchArtifact;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function suppressed(
  input: BuildReverseDcfInput,
  reason: ReverseDcfSuppressionReason,
  detail: string,
  sourceIds: readonly string[],
): ReverseDcfArtifact {
  return {
    version: 1,
    generatedAt: input.generatedAt,
    symbol: input.symbol,
    status: "suppressed",
    reason,
    detail,
    sourceIds: unique(sourceIds),
  };
}

function discountedFcfTotal(input: {
  readonly startingFcf: number;
  readonly annualGrowth: number;
  readonly discountRate: number;
  readonly terminalGrowthRate: number;
}): number {
  let total = 0;
  let yearFcf = input.startingFcf;
  for (let year = 1; year <= REVERSE_DCF_HORIZON_YEARS; year += 1) {
    yearFcf *= 1 + input.annualGrowth;
    total += yearFcf / (1 + input.discountRate) ** year;
  }
  const terminal =
    (yearFcf * (1 + input.terminalGrowthRate)) / (input.discountRate - input.terminalGrowthRate);
  return total + terminal / (1 + input.discountRate) ** REVERSE_DCF_HORIZON_YEARS;
}

function solveGrowth(input: {
  readonly startingFcf: number;
  readonly enterpriseValue: number;
  readonly discountRate: number;
  readonly terminalGrowthRate: number;
}): number | undefined {
  const projectedAtMinimum = discountedFcfTotal({
    ...input,
    annualGrowth: MIN_SOLVED_GROWTH,
  });
  const projectedAtMaximum = discountedFcfTotal({
    ...input,
    annualGrowth: MAX_SOLVED_GROWTH,
  });
  if (input.enterpriseValue < projectedAtMinimum || input.enterpriseValue > projectedAtMaximum) {
    return undefined;
  }
  let lower = MIN_SOLVED_GROWTH;
  let upper = MAX_SOLVED_GROWTH;
  for (let iteration = 0; iteration < SOLVER_ITERATIONS; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    const discountedTotal = discountedFcfTotal({ ...input, annualGrowth: midpoint });
    if (discountedTotal < input.enterpriseValue) {
      lower = midpoint;
    } else {
      upper = midpoint;
    }
  }
  return (lower + upper) / 2;
}

function gridCell(input: {
  readonly startingFcf: number;
  readonly enterpriseValue: number;
  readonly discountRatePct: number;
  readonly terminalGrowthRatePct: number;
}): ReverseDcfGridCell {
  const solved = solveGrowth({
    startingFcf: input.startingFcf,
    enterpriseValue: input.enterpriseValue,
    discountRate: input.discountRatePct / PERCENT_SCALE,
    terminalGrowthRate: input.terminalGrowthRatePct / PERCENT_SCALE,
  });
  if (solved === undefined) {
    return {
      status: "not-solved",
      terminalGrowthRatePct: input.terminalGrowthRatePct,
      reason: "outside-solver-bounds",
    };
  }
  return {
    status: "solved",
    terminalGrowthRatePct: input.terminalGrowthRatePct,
    solvedFiveYearFcfGrowthPct: Number((solved * PERCENT_SCALE).toFixed(RESULT_DECIMAL_PLACES)),
  };
}

export function buildReverseDcf(input: BuildReverseDcfInput): ReverseDcfArtifact {
  const workbench = input.valuationWorkbench;
  const trailing = workbench?.historicalMultiples.observations
    .filter((observation) => observation.basis === "ttm")
    .toSorted((left, right) => right.publicAt.localeCompare(left.publicAt))
    .at(0);
  const startingFcf = trailing?.inputs.freeCashFlow;
  if (startingFcf === undefined) {
    return suppressed(
      input,
      "reconciled-ttm-fcf-unavailable",
      "A reconciled TTM free-cash-flow input is unavailable.",
      workbench?.sourceIds ?? [],
    );
  }
  if (startingFcf.value <= 0) {
    return suppressed(
      input,
      "starting-fcf-not-positive",
      "The reconciled TTM free-cash-flow input is not positive.",
      startingFcf.sourceIds,
    );
  }
  if (workbench?.peerComparison.status !== "available") {
    return suppressed(
      input,
      "enterprise-value-unavailable",
      "Observed enterprise value is unavailable.",
      startingFcf.sourceIds,
    );
  }
  const { target } = workbench.peerComparison.valuationComps;
  const { enterpriseValue } = target;
  if (typeof enterpriseValue !== "number") {
    return suppressed(
      input,
      "enterprise-value-unavailable",
      "Observed enterprise value is unavailable.",
      [...startingFcf.sourceIds, ...target.sourceIds],
    );
  }
  if (enterpriseValue <= 0) {
    return suppressed(
      input,
      "enterprise-value-not-positive",
      "Observed enterprise value is not positive.",
      [...startingFcf.sourceIds, ...target.sourceIds],
    );
  }
  if (target.quoteObservedAt === undefined) {
    return suppressed(
      input,
      "input-date-unavailable",
      "The enterprise-value observation date is unavailable.",
      [...startingFcf.sourceIds, ...target.sourceIds],
    );
  }
  if (startingFcf.currency === null || target.quoteCurrency === undefined) {
    return suppressed(
      input,
      "input-currency-unavailable",
      "A required input currency is unavailable.",
      [...startingFcf.sourceIds, ...target.sourceIds],
    );
  }
  if (startingFcf.currency !== target.quoteCurrency) {
    return suppressed(
      input,
      "input-currency-mismatch",
      "Starting FCF and enterprise value use different currencies.",
      [...startingFcf.sourceIds, ...target.sourceIds],
    );
  }
  const sourceIds = unique([...startingFcf.sourceIds, ...target.sourceIds]);
  const rows = REVERSE_DCF_DISCOUNT_RATES_PCT.map(
    (discountRatePct): ReverseDcfGridRow => ({
      discountRatePct,
      cells: REVERSE_DCF_TERMINAL_GROWTH_RATES_PCT.map((terminalGrowthRatePct) =>
        gridCell({
          startingFcf: startingFcf.value,
          enterpriseValue,
          discountRatePct,
          terminalGrowthRatePct,
        }),
      ),
    }),
  );
  return {
    version: 1,
    generatedAt: input.generatedAt,
    symbol: input.symbol,
    status: "computed",
    assumptions: {
      startingFcf: {
        value: startingFcf.value,
        currency: startingFcf.currency,
        periodEnd: startingFcf.periodEnd,
        publicAt: startingFcf.publicAt,
        sourceIds: startingFcf.sourceIds,
      },
      enterpriseValue: {
        value: enterpriseValue,
        currency: target.quoteCurrency,
        observedAt: target.quoteObservedAt,
        sourceIds: target.sourceIds,
      },
      horizonYears: REVERSE_DCF_HORIZON_YEARS,
      discountRatesPct: REVERSE_DCF_DISCOUNT_RATES_PCT,
      terminalGrowthRatesPct: REVERSE_DCF_TERMINAL_GROWTH_RATES_PCT,
    },
    grid: { value: "solved five-year FCF growth", unit: "percent", rows },
    sourceIds,
  };
}

function hasGridCellShape(value: unknown): boolean {
  if (
    !isRecord(value) ||
    readNumber(value, "terminalGrowthRatePct") === undefined ||
    (value.status !== "solved" && value.status !== "not-solved")
  ) {
    return false;
  }
  return value.status === "solved"
    ? hasExactKeys(value, ["solvedFiveYearFcfGrowthPct", "status", "terminalGrowthRatePct"]) &&
        readNumber(value, "solvedFiveYearFcfGrowthPct") !== undefined
    : hasExactKeys(value, ["reason", "status", "terminalGrowthRatePct"]) &&
        value.reason === "outside-solver-bounds";
}

function hasComputedShape(value: Record<string, unknown>): boolean {
  if (
    !isRecord(value.assumptions) ||
    !isRecord(value.assumptions.startingFcf) ||
    !isRecord(value.assumptions.enterpriseValue) ||
    value.assumptions.horizonYears !== REVERSE_DCF_HORIZON_YEARS ||
    !Array.isArray(value.assumptions.discountRatesPct) ||
    !Array.isArray(value.assumptions.terminalGrowthRatesPct) ||
    !isRecord(value.grid) ||
    value.grid.value !== "solved five-year FCF growth" ||
    value.grid.unit !== "percent" ||
    !Array.isArray(value.grid.rows)
  ) {
    return false;
  }
  const { startingFcf, enterpriseValue } = value.assumptions;
  return (
    hasExactKeys(value, [
      "assumptions",
      "generatedAt",
      "grid",
      "sourceIds",
      "status",
      "symbol",
      "version",
    ]) &&
    hasExactKeys(value.assumptions, [
      "discountRatesPct",
      "enterpriseValue",
      "horizonYears",
      "startingFcf",
      "terminalGrowthRatesPct",
    ]) &&
    hasExactKeys(startingFcf, ["currency", "periodEnd", "publicAt", "sourceIds", "value"]) &&
    hasExactKeys(enterpriseValue, ["currency", "observedAt", "sourceIds", "value"]) &&
    hasExactKeys(value.grid, ["rows", "unit", "value"]) &&
    readNumber(startingFcf, "value") !== undefined &&
    readString(startingFcf, "currency") !== undefined &&
    readString(startingFcf, "periodEnd") !== undefined &&
    readString(startingFcf, "publicAt") !== undefined &&
    readStringArray(startingFcf, "sourceIds") !== undefined &&
    readNumber(enterpriseValue, "value") !== undefined &&
    readString(enterpriseValue, "currency") !== undefined &&
    readString(enterpriseValue, "observedAt") !== undefined &&
    readStringArray(enterpriseValue, "sourceIds") !== undefined &&
    value.assumptions.discountRatesPct.length === REVERSE_DCF_DISCOUNT_RATES_PCT.length &&
    value.assumptions.discountRatesPct.every(
      (rate, index) => rate === REVERSE_DCF_DISCOUNT_RATES_PCT[index],
    ) &&
    value.assumptions.terminalGrowthRatesPct.length ===
      REVERSE_DCF_TERMINAL_GROWTH_RATES_PCT.length &&
    value.assumptions.terminalGrowthRatesPct.every(
      (rate, index) => rate === REVERSE_DCF_TERMINAL_GROWTH_RATES_PCT[index],
    ) &&
    value.grid.rows.length === REVERSE_DCF_DISCOUNT_RATES_PCT.length &&
    value.grid.rows.every(
      (row, rowIndex) =>
        isRecord(row) &&
        hasExactKeys(row, ["cells", "discountRatePct"]) &&
        row.discountRatePct === REVERSE_DCF_DISCOUNT_RATES_PCT[rowIndex] &&
        Array.isArray(row.cells) &&
        row.cells.length === REVERSE_DCF_TERMINAL_GROWTH_RATES_PCT.length &&
        row.cells.every(
          (cell, cellIndex) =>
            hasGridCellShape(cell) &&
            isRecord(cell) &&
            cell.terminalGrowthRatePct === REVERSE_DCF_TERMINAL_GROWTH_RATES_PCT[cellIndex],
        ),
    )
  );
}

export function readReverseDcfArtifact(value: unknown): ReverseDcfArtifact | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    readString(value, "generatedAt") === undefined ||
    readString(value, "symbol") === undefined ||
    readStringArray(value, "sourceIds") === undefined
  ) {
    return undefined;
  }
  if (value.status === "computed" && hasComputedShape(value)) {
    return value as unknown as ReverseDcfArtifact;
  }
  if (
    value.status === "suppressed" &&
    hasExactKeys(value, [
      "detail",
      "generatedAt",
      "reason",
      "sourceIds",
      "status",
      "symbol",
      "version",
    ]) &&
    SUPPRESSION_REASONS.has(value.reason as ReverseDcfSuppressionReason) &&
    readString(value, "detail") !== undefined
  ) {
    return value as unknown as ReverseDcfArtifact;
  }
  return undefined;
}
