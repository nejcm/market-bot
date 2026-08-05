import type { FundamentalHistoryPoint } from "../../src/sources/extended-evidence/fundamental-history";
import {
  aliasPoints,
  CANONICAL_DURATION_DEFINITIONS,
  expectedCanonicalUnit,
  expectedSelectedConcept,
  pointsExactlyAgree,
  RAW_HISTORY_DEFINITIONS,
  type HistorySide,
} from "./offline-financial-history-facts";
import type { OfflineCorpusExecution } from "./offline-financial-statements-corpus";

// Revenue-alias interchangeability oracle: whether the concept the roster selected was the only one that could have been selected, or an alternate legacy/canonical revenue concept would have produced a superset of the same periods with identical values on every shared period.

export type AliasRejectionReason = "not-a-superset" | "disagrees-on-shared-periods";

export type AliasVerdict =
  | {
      readonly kind: "alias-substitutable";
      readonly candidateConcept: string;
      readonly addedPeriodEnds: readonly string[];
    }
  | {
      readonly kind: "rejected";
      readonly candidateConcept: string;
      readonly reasons: readonly AliasRejectionReason[];
    }
  | { readonly kind: "no-alternative-concept-with-facts" }
  | { readonly kind: "no-selected-concept" };

interface RevenueAliasContext {
  readonly selectedConcept: string;
  readonly selectedUnit: string;
  readonly candidateConcepts: readonly string[];
}

function revenueAliasContext(
  execution: OfflineCorpusExecution,
  side: HistorySide,
): RevenueAliasContext | undefined {
  const definition = RAW_HISTORY_DEFINITIONS.find((candidate) => candidate.key === "revenue")!;
  const selectedConcept = expectedSelectedConcept(execution, definition, side);
  const taxonomy = side === "legacy" ? "us-gaap" : execution.artifact.taxonomy;
  if (taxonomy === undefined || selectedConcept === undefined) {
    return undefined;
  }
  const canonicalDefinition = CANONICAL_DURATION_DEFINITIONS.find(
    (candidate) => candidate.key === "revenue",
  )!;
  const concepts =
    side === "legacy" ? definition.legacyConcepts : canonicalDefinition.concepts[taxonomy];
  const selectedUnit =
    side === "legacy"
      ? definition.legacyUnit
      : expectedCanonicalUnit(canonicalDefinition, execution.artifact.reportingCurrency!);
  return {
    selectedConcept,
    selectedUnit,
    candidateConcepts: concepts.filter(
      (concept) =>
        concept !== selectedConcept &&
        aliasPoints(execution, side, concept, selectedUnit).length > 0,
    ),
  };
}

export function detectEligibleRevenueAliasAlternatives(
  execution: OfflineCorpusExecution,
): ReadonlyMap<string, readonly string[] | undefined> {
  return new Map(
    (["canonical", "legacy"] as const).map((side) => {
      const context = revenueAliasContext(execution, side);
      return [`${side}.revenue`, context?.candidateConcepts] as const;
    }),
  );
}

function aliasVerdictForSide(execution: OfflineCorpusExecution, side: HistorySide): AliasVerdict {
  const context = revenueAliasContext(execution, side);
  if (context === undefined) {
    return { kind: "no-selected-concept" };
  }
  const [candidateConcept] = context.candidateConcepts;
  if (candidateConcept === undefined) {
    return { kind: "no-alternative-concept-with-facts" };
  }

  const selectedPoints = aliasPoints(
    execution,
    side,
    context.selectedConcept,
    context.selectedUnit,
  );
  const candidatePoints = aliasPoints(execution, side, candidateConcept, context.selectedUnit);

  const reasons: AliasRejectionReason[] = [];
  const selectedByKey = new Map<string, FundamentalHistoryPoint>(
    selectedPoints.map((point) => [point.key, point.point]),
  );
  const candidateByKey = new Map<string, FundamentalHistoryPoint>(
    candidatePoints.map((point) => [point.key, point.point]),
  );
  const isStrictSuperset =
    candidateByKey.size > selectedByKey.size &&
    [...selectedByKey.keys()].every((key) => candidateByKey.has(key));
  if (!isStrictSuperset) {
    reasons.push("not-a-superset");
  }
  const sharedPointsAgree = [...selectedByKey].every(([key, selectedPoint]) => {
    const candidatePoint = candidateByKey.get(key);
    return candidatePoint === undefined || pointsExactlyAgree(selectedPoint, candidatePoint);
  });
  if (!sharedPointsAgree) {
    reasons.push("disagrees-on-shared-periods");
  }
  if (reasons.length > 0) {
    return { kind: "rejected", candidateConcept, reasons };
  }
  return {
    kind: "alias-substitutable",
    candidateConcept,
    addedPeriodEnds: candidatePoints
      .filter((point) => !selectedByKey.has(point.key))
      .map((point) => point.point.periodEnd)
      .toSorted(),
  };
}

export function detectInterchangeableAliasCandidates(
  execution: OfflineCorpusExecution,
): ReadonlyMap<string, AliasVerdict> {
  return new Map(
    (["canonical", "legacy"] as const).map((side) => [
      `${side}.revenue`,
      aliasVerdictForSide(execution, side),
    ]),
  );
}
