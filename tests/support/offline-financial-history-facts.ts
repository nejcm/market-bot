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

// Shared fact-lookup primitives for the offline history roster/alias oracles: concept-unit lookups, eligible-point derivation for both legacy (SEC us-gaap) and canonical (financial-statements) sides, and the selection-policy replicas (expectedSelectedConcept, canonicalUnion) both oracles depend on.

export type HistorySide = "canonical" | "legacy";
export type HistorySeries =
  OfflineCorpusExecution["projection"][HistorySide]["fundamentalHistory"][string];

export interface RawHistoryDefinition {
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

export interface CanonicalDurationDefinition {
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

export interface EligibleCanonicalPoint {
  readonly periodKey: string;
  readonly point: FundamentalHistoryPoint;
}

export const MAX_ANNUAL_POINTS = 10;
const DAY_MS = 86_400_000;
const REVENUE_CONCEPT_RECENCY_BUCKET_DAYS = 100;
export const RAW_HISTORY_DEFINITIONS: readonly RawHistoryDefinition[] = [
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

export const CANONICAL_DURATION_DEFINITIONS: readonly CanonicalDurationDefinition[] = [
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

export function legacyEligiblePoints(
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

export function canonicalEligiblePoints(
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

export function expectedCanonicalUnit(
  definition: CanonicalDurationDefinition,
  reportingCurrency: string,
): string {
  if (definition.unitKind === "shares") {
    return "shares";
  }
  return definition.unitKind === "per-share" ? `${reportingCurrency}/shares` : reportingCurrency;
}

export function expectedSelectedConcept(
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

export function canonicalUnion(
  execution: OfflineCorpusExecution,
): readonly EligibleCanonicalPoint[] {
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

export function rosterTuple(point: FundamentalHistoryPoint): RosterTuple {
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

export function aliasPoints(
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

export function pointsExactlyAgree(
  left: FundamentalHistoryPoint,
  right: FundamentalHistoryPoint,
): boolean {
  return JSON.stringify(rosterTuple(left)) === JSON.stringify(rosterTuple(right));
}
