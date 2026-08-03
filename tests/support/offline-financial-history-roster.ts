import { isRecord, readNumber, readString } from "../../src/guards";
import { financialStatementPeriodMonths } from "../../src/sources/extended-evidence/financial-statement-selection";
import type { FundamentalHistoryPoint } from "../../src/sources/extended-evidence/fundamental-history";
import {
  isFactObservableAsOf,
  periodMonths,
  readSecFactValue,
  type SecFactValue,
} from "../../src/sources/extended-evidence/sec-edgar";
import type { OfflineCorpusExecution } from "./offline-financial-statements-corpus";

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

type HistorySide = "canonical" | "legacy";
type HistorySeries =
  OfflineCorpusExecution["projection"][HistorySide]["fundamentalHistory"][string];

interface RawHistoryDefinition {
  readonly key:
    | "revenue"
    | "grossProfit"
    | "operatingIncome"
    | "netIncome"
    | "dilutedEps"
    | "operatingCashFlow"
    | "capex";
  readonly canonicalKey:
    | "revenue"
    | "grossProfit"
    | "operatingIncome"
    | "netIncome"
    | "dilutedEps"
    | "operatingCashFlow"
    | "capitalExpenditure";
  readonly legacyConcepts: readonly string[];
  readonly legacyUnit: string;
}

interface CanonicalDurationDefinition {
  readonly key: string;
  readonly unitKind: "monetary" | "per-share" | "shares";
  readonly concepts: Readonly<Record<"us-gaap" | "ifrs-full", readonly string[]>>;
}

interface CompleteLegacyFact extends SecFactValue {
  readonly fp: string;
  readonly fy: number;
  readonly filed: string;
  readonly start: string;
  readonly end: string;
  readonly months: number;
}

interface CanonicalFact {
  readonly value: number;
  readonly canonicalForm: "10-K" | "10-Q" | "20-F" | "6-K";
  readonly amendment: boolean;
  readonly accessionNumber: string | null;
  readonly filedAt: string;
  readonly periodStart?: string;
  readonly periodEnd: string;
  readonly fiscalYear: number;
  readonly fiscalPeriod: string;
  readonly concept: string;
  readonly unit: string;
}

interface EligibleCanonicalPoint {
  readonly periodKey: string;
  readonly point: FundamentalHistoryPoint;
}

interface DerivedDefinition {
  readonly key: "freeCashFlowProxy" | "grossMargin" | "operatingMargin" | "netMargin";
  readonly left: RawHistoryDefinition["key"];
  readonly right: RawHistoryDefinition["key"];
  readonly operation: "difference" | "ratio";
}

const MAX_ANNUAL_POINTS = 10;
const MAX_ANNUAL_PERIODS_PER_SHAPE = 10;
const DAY_MS = 86_400_000;
const REVENUE_CONCEPT_RECENCY_BUCKET_DAYS = 100;
const RAW_HISTORY_DEFINITIONS: readonly RawHistoryDefinition[] = [
  {
    key: "revenue",
    canonicalKey: "revenue",
    legacyConcepts: [
      "Revenues",
      "SalesRevenueNet",
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
    ],
    legacyUnit: "USD",
  },
  {
    key: "grossProfit",
    canonicalKey: "grossProfit",
    legacyConcepts: ["GrossProfit"],
    legacyUnit: "USD",
  },
  {
    key: "operatingIncome",
    canonicalKey: "operatingIncome",
    legacyConcepts: ["OperatingIncomeLoss"],
    legacyUnit: "USD",
  },
  {
    key: "netIncome",
    canonicalKey: "netIncome",
    legacyConcepts: ["NetIncomeLoss"],
    legacyUnit: "USD",
  },
  {
    key: "dilutedEps",
    canonicalKey: "dilutedEps",
    legacyConcepts: ["EarningsPerShareDiluted"],
    legacyUnit: "USD/shares",
  },
  {
    key: "operatingCashFlow",
    canonicalKey: "operatingCashFlow",
    legacyConcepts: ["NetCashProvidedByUsedInOperatingActivities"],
    legacyUnit: "USD",
  },
  {
    key: "capex",
    canonicalKey: "capitalExpenditure",
    legacyConcepts: ["PaymentsToAcquirePropertyPlantAndEquipment"],
    legacyUnit: "USD",
  },
];

const CANONICAL_DURATION_DEFINITIONS: readonly CanonicalDurationDefinition[] = [
  {
    key: "revenue",
    unitKind: "monetary",
    concepts: {
      "us-gaap": [
        "Revenues",
        "SalesRevenueNet",
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
      ],
      "ifrs-full": ["Revenue"],
    },
  },
  {
    key: "grossProfit",
    unitKind: "monetary",
    concepts: { "us-gaap": ["GrossProfit"], "ifrs-full": ["GrossProfit"] },
  },
  {
    key: "operatingIncome",
    unitKind: "monetary",
    concepts: {
      "us-gaap": ["OperatingIncomeLoss"],
      "ifrs-full": ["ProfitLossFromOperatingActivities"],
    },
  },
  {
    key: "netIncome",
    unitKind: "monetary",
    concepts: { "us-gaap": ["NetIncomeLoss"], "ifrs-full": ["ProfitLoss"] },
  },
  {
    key: "operatingCashFlow",
    unitKind: "monetary",
    concepts: {
      "us-gaap": ["NetCashProvidedByUsedInOperatingActivities"],
      "ifrs-full": ["CashFlowsFromUsedInOperatingActivities"],
    },
  },
  {
    key: "capitalExpenditure",
    unitKind: "monetary",
    concepts: {
      "us-gaap": ["PaymentsToAcquirePropertyPlantAndEquipment"],
      "ifrs-full": ["PurchaseOfPropertyPlantAndEquipment"],
    },
  },
  {
    key: "dividendsPaid",
    unitKind: "monetary",
    concepts: {
      "us-gaap": ["PaymentsForDividends", "DividendsPaid"],
      "ifrs-full": ["DividendsPaidClassifiedAsFinancingActivities"],
    },
  },
  {
    key: "shareRepurchases",
    unitKind: "monetary",
    concepts: {
      "us-gaap": ["PaymentsForRepurchaseOfCommonStock", "PaymentsForRepurchaseOfEquity"],
      "ifrs-full": ["PaymentsToAcquireOrRedeemEntitysShares"],
    },
  },
  {
    key: "dilutedEps",
    unitKind: "per-share",
    concepts: {
      "us-gaap": ["EarningsPerShareDiluted"],
      "ifrs-full": ["DilutedEarningsLossPerShare"],
    },
  },
  {
    key: "dilutedShares",
    unitKind: "shares",
    concepts: {
      "us-gaap": ["WeightedAverageNumberOfDilutedSharesOutstanding"],
      "ifrs-full": ["AdjustedWeightedAverageShares"],
    },
  },
];

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

function conceptUnitValues(
  payload: unknown,
  taxonomy: string,
  concept: string,
  unit: string,
): readonly unknown[] {
  if (!isRecord(payload) || !isRecord(payload.facts)) {
    return [];
  }
  const taxonomyRoot = payload.facts[taxonomy];
  if (!isRecord(taxonomyRoot)) {
    return [];
  }
  const fact = taxonomyRoot[concept];
  if (!isRecord(fact) || !isRecord(fact.units)) {
    return [];
  }
  const values = fact.units[unit];
  return Array.isArray(values) ? values : [];
}

function isInRevenueRecencyBucket(periodEnd: string, latestPeriodEnd: string): boolean {
  const ageDays = (Date.parse(latestPeriodEnd) - Date.parse(periodEnd)) / DAY_MS;
  return Number.isFinite(ageDays) && ageDays >= 0 && ageDays <= REVENUE_CONCEPT_RECENCY_BUCKET_DAYS;
}

function completeLegacyFact(fact: SecFactValue): CompleteLegacyFact | undefined {
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

function legacyEligiblePoints(
  execution: OfflineCorpusExecution,
  concept: string,
  unit: string,
): readonly FundamentalHistoryPoint[] {
  const candidates = conceptUnitValues(execution.input.companyFacts, "us-gaap", concept, unit)
    .flatMap((value) => {
      const fact = readSecFactValue(value);
      return fact === undefined ? [] : [fact];
    })
    .filter(
      (fact) => fact.form === "10-K" && isFactObservableAsOf(fact, execution.input.analysisAsOf),
    )
    .flatMap((fact) => {
      const complete = completeLegacyFact(fact);
      return complete !== undefined && complete.months >= 10 && complete.months <= 14
        ? [complete]
        : [];
    });
  const byPeriodEnd = new Map<string, CompleteLegacyFact[]>();
  for (const fact of candidates) {
    byPeriodEnd.set(fact.end, [...(byPeriodEnd.get(fact.end) ?? []), fact]);
  }
  return [...byPeriodEnd.values()]
    .map(
      (matches) =>
        matches.toSorted(
          (left, right) =>
            right.filed.localeCompare(left.filed) ||
            `${right.end}@${right.filed}`.localeCompare(`${left.end}@${left.filed}`),
        )[0]!,
    )
    .toSorted((left, right) => left.end.localeCompare(right.end))
    .map((fact) => ({
      value: fact.val,
      form: "10-K",
      fy: fact.fy,
      fp: fact.fp,
      periodStart: fact.start,
      periodEnd: fact.end,
      periodMonths: fact.months,
      filedAt: fact.filed,
      currency: unit,
    }));
}

function parseCanonicalForm(value: string): CanonicalFact["canonicalForm"] | undefined {
  const canonical = value.endsWith("/A") ? value.slice(0, -2) : value;
  return canonical === "10-K" || canonical === "10-Q" || canonical === "20-F" || canonical === "6-K"
    ? canonical
    : undefined;
}

function readFiscalYear(value: Readonly<Record<string, unknown>>): number | undefined {
  const numeric = readNumber(value, "fy");
  if (numeric !== undefined) {
    return numeric;
  }
  const text = readString(value, "fy");
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCanonicalFact(
  value: unknown,
  concept: string,
  unit: string,
): CanonicalFact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const factValue = readNumber(value, "val");
  const formValue = readString(value, "form");
  const canonicalForm = formValue === undefined ? undefined : parseCanonicalForm(formValue);
  const filedAt = readString(value, "filed");
  const periodEnd = readString(value, "end");
  const fiscalYear = readFiscalYear(value);
  const fiscalPeriod = readString(value, "fp");
  if (
    factValue === undefined ||
    formValue === undefined ||
    canonicalForm === undefined ||
    filedAt === undefined ||
    periodEnd === undefined ||
    fiscalYear === undefined ||
    fiscalPeriod === undefined
  ) {
    return undefined;
  }
  const periodStart = readString(value, "start");
  return {
    value: factValue,
    canonicalForm,
    amendment: formValue.endsWith("/A"),
    accessionNumber: readString(value, "accn") ?? null,
    filedAt,
    ...(periodStart !== undefined ? { periodStart } : {}),
    periodEnd,
    fiscalYear,
    fiscalPeriod,
    concept,
    unit,
  };
}

function canonicalDurationDays(fact: CanonicalFact): number {
  if (fact.periodStart === undefined) {
    return 0;
  }
  const days = (Date.parse(fact.periodEnd) - Date.parse(fact.periodStart)) / 86_400_000;
  return Number.isFinite(days) ? days : 0;
}

function compareCanonicalFacts(left: CanonicalFact, right: CanonicalFact): number {
  return (
    right.periodEnd.localeCompare(left.periodEnd) ||
    canonicalDurationDays(right) - canonicalDurationDays(left) ||
    right.filedAt.localeCompare(left.filedAt) ||
    Number(right.amendment) - Number(left.amendment) ||
    (right.accessionNumber ?? "").localeCompare(left.accessionNumber ?? "")
  );
}

function canonicalPeriodKey(fact: CanonicalFact): string {
  return `${fact.periodStart ?? "instant"}|${fact.periodEnd}`;
}

function canonicalEligiblePoints(
  execution: OfflineCorpusExecution,
  concept: string,
  unit: string,
): readonly EligibleCanonicalPoint[] {
  const { taxonomy } = execution.artifact;
  if (taxonomy === undefined) {
    return [];
  }
  const cutoff = execution.input.analysisAsOf.slice(0, 10);
  const candidates = conceptUnitValues(execution.input.companyFacts, taxonomy, concept, unit)
    .flatMap((value) => {
      const fact = parseCanonicalFact(value, concept, unit);
      return fact === undefined ? [] : [fact];
    })
    .filter((fact) => fact.periodEnd <= cutoff && fact.filedAt <= cutoff)
    .filter((fact) => fact.canonicalForm === "10-K" || fact.canonicalForm === "20-F")
    .filter((fact) => {
      const months = financialStatementPeriodMonths(fact);
      return months !== undefined && months >= 10 && months <= 14;
    });
  const byPeriod = new Map<string, CanonicalFact[]>();
  for (const fact of candidates) {
    const key = canonicalPeriodKey(fact);
    byPeriod.set(key, [...(byPeriod.get(key) ?? []), fact]);
  }
  return [...byPeriod.entries()]
    .map(([key, matches]) => [key, matches.toSorted(compareCanonicalFacts)[0]!] as const)
    .toSorted(
      (left, right) =>
        left[1].periodEnd.localeCompare(right[1].periodEnd) || left[0].localeCompare(right[0]),
    )
    .map(([key, fact]) => ({
      periodKey: key,
      point: {
        value: fact.value,
        form: fact.canonicalForm as "10-K" | "20-F",
        fy: fact.fiscalYear,
        fp: fact.fiscalPeriod,
        periodStart: fact.periodStart!,
        periodEnd: fact.periodEnd,
        periodMonths: financialStatementPeriodMonths(fact)!,
        filedAt: fact.filedAt,
        currency: fact.unit,
      },
    }));
}

function expectedCanonicalUnit(
  definition: CanonicalDurationDefinition,
  reportingCurrency: string,
): string {
  if (definition.unitKind === "shares") {
    return "shares";
  }
  return definition.unitKind === "per-share" ? `${reportingCurrency}/shares` : reportingCurrency;
}

function expectedSelectedConcept(
  execution: OfflineCorpusExecution,
  definition: RawHistoryDefinition,
  side: HistorySide,
): string | undefined {
  if (side === "legacy") {
    if (definition.key !== "revenue") {
      return definition.legacyConcepts.find((concept) =>
        conceptUnitValues(
          execution.input.companyFacts,
          "us-gaap",
          concept,
          definition.legacyUnit,
        ).some((value) => readSecFactValue(value) !== undefined),
      );
    }
    const ranked = definition.legacyConcepts.flatMap((concept) => {
      const [latest] = conceptUnitValues(
        execution.input.companyFacts,
        "us-gaap",
        concept,
        definition.legacyUnit,
      )
        .flatMap((value) => {
          const fact = readSecFactValue(value);
          return fact === undefined ? [] : [fact];
        })
        .filter((fact) => isFactObservableAsOf(fact, execution.input.analysisAsOf))
        .toSorted(
          (left, right) =>
            (right.end ?? "").localeCompare(left.end ?? "") ||
            (right.filed ?? "").localeCompare(left.filed ?? ""),
        );
      return latest?.end === undefined ? [] : [{ concept, latestPeriodEnd: latest.end }];
    });
    const latestPeriodEnd = ranked
      .map((candidate) => candidate.latestPeriodEnd)
      .toSorted()
      .at(-1);
    return latestPeriodEnd === undefined
      ? undefined
      : ranked.find((candidate) =>
          isInRevenueRecencyBucket(candidate.latestPeriodEnd, latestPeriodEnd),
        )?.concept;
  }

  const { taxonomy, reportingCurrency } = execution.artifact;
  if (taxonomy === undefined || reportingCurrency === undefined) {
    return undefined;
  }
  const canonicalDefinition = CANONICAL_DURATION_DEFINITIONS.find(
    (candidate) => candidate.key === definition.canonicalKey,
  )!;
  const concepts = canonicalDefinition.concepts[taxonomy];
  const unit = expectedCanonicalUnit(canonicalDefinition, reportingCurrency);
  const eligibleFacts = (concept: string): readonly CanonicalFact[] => {
    const cutoff = execution.input.analysisAsOf.slice(0, 10);
    return conceptUnitValues(execution.input.companyFacts, taxonomy, concept, unit)
      .flatMap((value) => {
        const fact = parseCanonicalFact(value, concept, unit);
        return fact === undefined ? [] : [fact];
      })
      .filter((fact) => fact.periodEnd <= cutoff && fact.filedAt <= cutoff);
  };
  if (definition.key !== "revenue") {
    return concepts.find((concept) => eligibleFacts(concept).length > 0);
  }
  const ranked = concepts.flatMap((concept) => {
    const [latest] = eligibleFacts(concept).toSorted(compareCanonicalFacts);
    return latest === undefined ? [] : [{ concept, latestPeriodEnd: latest.periodEnd }];
  });
  const latestPeriodEnd = ranked
    .map((candidate) => candidate.latestPeriodEnd)
    .toSorted()
    .at(-1);
  return latestPeriodEnd === undefined
    ? undefined
    : ranked.find((candidate) =>
        isInRevenueRecencyBucket(candidate.latestPeriodEnd, latestPeriodEnd),
      )?.concept;
}

function canonicalUnion(execution: OfflineCorpusExecution): readonly EligibleCanonicalPoint[] {
  const { reportingCurrency } = execution.artifact;
  if (reportingCurrency === undefined) {
    return [];
  }
  const union = new Map<string, EligibleCanonicalPoint>();
  for (const definition of CANONICAL_DURATION_DEFINITIONS) {
    const concept = execution.projection.statements[definition.key]?.selectedConcept;
    if (concept === null || concept === undefined) {
      continue;
    }
    const unit = expectedCanonicalUnit(definition, reportingCurrency);
    for (const point of canonicalEligiblePoints(execution, concept, unit)) {
      union.set(point.periodKey, point);
    }
  }
  return [...union.values()].toSorted(
    (left, right) =>
      left.point.periodEnd.localeCompare(right.point.periodEnd) ||
      left.periodKey.localeCompare(right.periodKey),
  );
}

type RosterTuple = {
  readonly [Field in keyof FundamentalHistoryPoint]-?: FundamentalHistoryPoint[Field];
};

function rosterTuple(point: FundamentalHistoryPoint): RosterTuple {
  const {
    value,
    form,
    fy,
    fp,
    periodStart,
    periodEnd,
    periodMonths: pointPeriodMonths,
    filedAt,
    currency,
  } = point;
  return {
    value,
    form,
    fy,
    fp,
    periodStart,
    periodEnd,
    periodMonths: pointPeriodMonths,
    filedAt,
    currency,
  };
}

interface AliasPoint {
  readonly key: string;
  readonly point: FundamentalHistoryPoint;
}

interface RevenueAliasContext {
  readonly selectedConcept: string;
  readonly selectedUnit: string;
  readonly candidateConcepts: readonly string[];
}

function aliasPoints(
  execution: OfflineCorpusExecution,
  side: HistorySide,
  concept: string,
  unit: string,
): readonly AliasPoint[] {
  return side === "legacy"
    ? legacyEligiblePoints(execution, concept, unit).map((point) => ({
        key: point.periodEnd,
        point,
      }))
    : canonicalEligiblePoints(execution, concept, unit).map(({ periodKey: key, point }) => ({
        key,
        point,
      }));
}

function pointsExactlyAgree(
  left: FundamentalHistoryPoint,
  right: FundamentalHistoryPoint,
): boolean {
  return JSON.stringify(rosterTuple(left)) === JSON.stringify(rosterTuple(right));
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
  const selectedByKey = new Map(selectedPoints.map((point) => [point.key, point.point]));
  const candidateByKey = new Map(candidatePoints.map((point) => [point.key, point.point]));
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

function ratioValue(numerator: number, denominator: number): number | undefined {
  return denominator === 0 ? undefined : numerator / denominator;
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
