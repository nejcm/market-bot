import type { FundamentalHistoryPoint } from "../../src/sources/extended-evidence/fundamental-history";
import {
  CANONICAL_DURATION_DEFINITIONS,
  canonicalEligiblePoints,
  canonicalUnion,
  expectedCanonicalUnit,
  expectedSelectedConcept,
  legacyEligiblePoints,
  MAX_ANNUAL_POINTS,
  RAW_HISTORY_DEFINITIONS,
  rosterTuple,
  type EligibleCanonicalPoint,
  type HistorySeries,
  type HistorySide,
  type RawHistoryDefinition,
} from "./offline-financial-history-facts";
import type { OfflineCorpusExecution } from "./offline-financial-statements-corpus";

// Roster verification: whether the emitted annual history for each raw/derived series exactly matches (or, for canonical series, admissibly cap-displaces) what the selection policy in offline-financial-history-facts.ts would have produced from the raw source facts.

export {
  detectEligibleRevenueAliasAlternatives,
  detectInterchangeableAliasCandidates,
  type AliasRejectionReason,
  type AliasVerdict,
} from "./offline-financial-history-aliases";

export type RosterVerdict =
  | { readonly kind: "verified-exact" }
  | {
      readonly kind: "verified-cap-displaced";
      readonly droppedPeriodEnds: readonly string[];
      readonly newerUnionPeriods: number;
    }
  | { readonly kind: "vacuous-empty" }
  | { readonly kind: "unanchored-empty" }
  | { readonly kind: "failed"; readonly reason: string };

interface DerivedDefinition {
  readonly key: "freeCashFlowProxy" | "grossMargin" | "operatingMargin" | "netMargin";
  readonly left: RawHistoryDefinition["key"];
  readonly right: RawHistoryDefinition["key"];
  readonly operation: "difference" | "ratio";
}

const MAX_ANNUAL_PERIODS_PER_SHAPE = 10;

const DERIVED_DEFINITIONS: readonly DerivedDefinition[] = [
  {
    key: "freeCashFlowProxy",
    left: "operatingCashFlow",
    right: "capex",
    operation: "difference",
  },
  { key: "grossMargin", left: "grossProfit", right: "revenue", operation: "ratio" },
  {
    key: "operatingMargin",
    left: "operatingIncome",
    right: "revenue",
    operation: "ratio",
  },
  { key: "netMargin", left: "netIncome", right: "revenue", operation: "ratio" },
];

function rosterMismatchReason(
  side: HistorySide,
  seriesKey: string,
  expected: readonly FundamentalHistoryPoint[],
  emitted: readonly FundamentalHistoryPoint[],
): string | undefined {
  const expectedTuples = expected.map((point) => rosterTuple(point));
  const emittedTuples = emitted.map((point) => rosterTuple(point));
  if (JSON.stringify(expectedTuples) === JSON.stringify(emittedTuples)) {
    return undefined;
  }
  const emittedCounts = new Map<string, number>();
  for (const tuple of emittedTuples) {
    const key = JSON.stringify(tuple);
    emittedCounts.set(key, (emittedCounts.get(key) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const tuple of expectedTuples) {
    const key = JSON.stringify(tuple);
    const count = emittedCounts.get(key) ?? 0;
    if (count === 0) {
      missing.push(tuple.periodEnd);
    } else {
      emittedCounts.set(key, count - 1);
    }
  }
  const expectedCounts = new Map<string, number>();
  for (const tuple of expectedTuples) {
    const key = JSON.stringify(tuple);
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  }
  const extra: string[] = [];
  for (const tuple of emittedTuples) {
    const key = JSON.stringify(tuple);
    const count = expectedCounts.get(key) ?? 0;
    if (count === 0) {
      extra.push(tuple.periodEnd);
    } else {
      expectedCounts.set(key, count - 1);
    }
  }
  return `${side}.${seriesKey} annual roster mismatch; missingPeriodEnds=${JSON.stringify(missing)} extraPeriodEnds=${JSON.stringify(extra)}`;
}

function verifyLegacyRaw(
  execution: OfflineCorpusExecution,
  definition: RawHistoryDefinition,
  series: HistorySeries,
): RosterVerdict {
  if (series.concept === null) {
    if (series.annual.length > 0) {
      return {
        kind: "failed",
        reason: `legacy.${definition.key} emitted annual points without a concept`,
      };
    }
    const eligibleAcrossDefinitions = definition.legacyConcepts.flatMap((concept) =>
      legacyEligiblePoints(execution, concept, definition.legacyUnit),
    );
    return eligibleAcrossDefinitions.length === 0
      ? { kind: "unanchored-empty" }
      : {
          kind: "failed",
          reason: `legacy.${definition.key} selected no concept despite ${String(eligibleAcrossDefinitions.length)} eligible source point(s)`,
        };
  }
  const expectedConcept = expectedSelectedConcept(execution, definition, "legacy");
  if (series.concept !== expectedConcept) {
    return {
      kind: "failed",
      reason: `legacy.${definition.key} emitted concept ${series.concept} but selection policy yields ${String(expectedConcept)}`,
    };
  }
  const eligible = legacyEligiblePoints(execution, series.concept, definition.legacyUnit);
  if (eligible.length === 0 && series.annual.length === 0) {
    return { kind: "vacuous-empty" };
  }
  const expected = eligible.slice(-MAX_ANNUAL_POINTS);
  const reason = rosterMismatchReason("legacy", definition.key, expected, series.annual);
  return reason === undefined ? { kind: "verified-exact" } : { kind: "failed", reason };
}

function verifyCanonicalRaw(
  execution: OfflineCorpusExecution,
  definition: RawHistoryDefinition,
  series: HistorySeries,
  union: readonly EligibleCanonicalPoint[],
): RosterVerdict {
  const canonicalDefinition = CANONICAL_DURATION_DEFINITIONS.find(
    (candidate) => candidate.key === definition.canonicalKey,
  )!;
  const { taxonomy, reportingCurrency } = execution.artifact;
  if (series.concept === null) {
    if (series.annual.length > 0) {
      return {
        kind: "failed",
        reason: `canonical.${definition.key} emitted annual points without a concept`,
      };
    }
    if (taxonomy === undefined || reportingCurrency === undefined) {
      return { kind: "unanchored-empty" };
    }
    const unit = expectedCanonicalUnit(canonicalDefinition, reportingCurrency);
    const eligibleAcrossDefinitions = canonicalDefinition.concepts[taxonomy].flatMap((concept) =>
      canonicalEligiblePoints(execution, concept, unit),
    );
    return eligibleAcrossDefinitions.length === 0
      ? { kind: "unanchored-empty" }
      : {
          kind: "failed",
          reason: `canonical.${definition.key} selected no concept despite ${String(eligibleAcrossDefinitions.length)} eligible source point(s)`,
        };
  }
  if (taxonomy === undefined || reportingCurrency === undefined) {
    return {
      kind: "failed",
      reason: `canonical.${definition.key} selected a concept without taxonomy/currency`,
    };
  }
  const expectedConcept = expectedSelectedConcept(execution, definition, "canonical");
  if (series.concept !== expectedConcept) {
    return {
      kind: "failed",
      reason: `canonical.${definition.key} emitted concept ${series.concept} but selection policy yields ${String(expectedConcept)}`,
    };
  }
  const unit = expectedCanonicalUnit(canonicalDefinition, reportingCurrency);
  const eligible = canonicalEligiblePoints(execution, series.concept, unit);
  if (eligible.length === 0 && series.annual.length === 0) {
    return { kind: "vacuous-empty" };
  }
  const allowedPeriodKeys = new Set(
    union.slice(-MAX_ANNUAL_PERIODS_PER_SHAPE).map((point) => point.periodKey),
  );
  const retained = eligible.filter((point) => allowedPeriodKeys.has(point.periodKey));
  const dropped = eligible.filter((point) => !allowedPeriodKeys.has(point.periodKey));
  const reason = rosterMismatchReason(
    "canonical",
    definition.key,
    retained.map((point) => point.point),
    series.annual,
  );
  if (reason !== undefined) {
    return {
      kind: "failed",
      reason: `${reason}; admissibleCapDisplacedPeriodEnds=${JSON.stringify(dropped.map((point) => point.point.periodEnd))}`,
    };
  }
  if (dropped.length === 0) {
    return { kind: "verified-exact" };
  }
  const newerCounts = dropped.map((point) => {
    const index = union.findIndex((candidate) => candidate.periodKey === point.periodKey);
    return index === -1 ? 0 : union.length - index - 1;
  });
  if (newerCounts.some((count) => count < MAX_ANNUAL_PERIODS_PER_SHAPE)) {
    return {
      kind: "failed",
      reason: `canonical.${definition.key} cap displacement lacks ${String(MAX_ANNUAL_PERIODS_PER_SHAPE)} newer union periods`,
    };
  }
  return {
    kind: "verified-cap-displaced",
    droppedPeriodEnds: dropped.map((point) => point.point.periodEnd),
    newerUnionPeriods: Math.min(...newerCounts),
  };
}

function ratioValue(numerator: number, denominator: number): number | undefined {
  return denominator === 0 ? undefined : numerator / denominator;
}

function derivedExpected(
  consumers: OfflineCorpusExecution["projection"][HistorySide],
  definition: DerivedDefinition,
): readonly FundamentalHistoryPoint[] {
  const left = consumers.fundamentalHistory[definition.left]?.annual ?? [];
  const right = consumers.fundamentalHistory[definition.right]?.annual ?? [];
  const rightByEnd = new Map(right.map((point) => [point.periodEnd, point]));
  return left.flatMap((leftPoint) => {
    const rightPoint = rightByEnd.get(leftPoint.periodEnd);
    if (rightPoint === undefined || leftPoint.currency !== rightPoint.currency) {
      return [];
    }
    const value =
      definition.operation === "difference"
        ? leftPoint.value - rightPoint.value
        : ratioValue(leftPoint.value, rightPoint.value);
    return value === undefined
      ? []
      : [
          {
            ...leftPoint,
            value,
            filedAt: [leftPoint.filedAt, rightPoint.filedAt].toSorted().at(-1)!,
          },
        ];
  });
}

function verifyDerived(
  side: HistorySide,
  consumers: OfflineCorpusExecution["projection"][HistorySide],
  definition: DerivedDefinition,
): RosterVerdict {
  const series = consumers.fundamentalHistory[definition.key];
  if (series === undefined) {
    return { kind: "failed", reason: `${side}.${definition.key} is missing` };
  }
  const expected = derivedExpected(consumers, definition);
  if (expected.length === 0 && series.annual.length === 0) {
    return { kind: "vacuous-empty" };
  }
  const reason = rosterMismatchReason(side, definition.key, expected, series.annual);
  return reason === undefined ? { kind: "verified-exact" } : { kind: "failed", reason };
}

function verifyRaw(
  execution: OfflineCorpusExecution,
  side: HistorySide,
  definition: RawHistoryDefinition,
  union: readonly EligibleCanonicalPoint[],
): RosterVerdict {
  const series = execution.projection[side].fundamentalHistory[definition.key];
  if (series === undefined) {
    return { kind: "failed", reason: `${side}.${definition.key} is missing` };
  }
  return side === "canonical"
    ? verifyCanonicalRaw(execution, definition, series, union)
    : verifyLegacyRaw(execution, definition, series);
}

export function verifyHistoryAnnualRosters(
  execution: OfflineCorpusExecution,
): ReadonlyMap<string, RosterVerdict> {
  const verdicts = new Map<string, RosterVerdict>();
  const union = canonicalUnion(execution);
  for (const side of ["canonical", "legacy"] as const) {
    const consumers = execution.projection[side];
    for (const definition of RAW_HISTORY_DEFINITIONS) {
      verdicts.set(`${side}.${definition.key}`, verifyRaw(execution, side, definition, union));
    }
    for (const definition of DERIVED_DEFINITIONS) {
      verdicts.set(`${side}.${definition.key}`, verifyDerived(side, consumers, definition));
    }
  }
  return verdicts;
}
