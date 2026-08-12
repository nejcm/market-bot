import { isRecord } from "../../guards";
import type { CollectContext } from "../types";
import { fetchSecCompanyFactsForSymbol } from "./sec-edgar";
import type {
  FinancialStatementTaxonomy,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";
import type { SubsequentFinancingBridgeArtifact } from "./subsequent-financing";

export interface CapitalOwnershipPeriodFact {
  readonly value: number;
  readonly periodStart?: string;
  readonly periodEnd: string;
  readonly filedAt: string;
  readonly form: string;
  readonly taxonomy: FinancialStatementTaxonomy;
  readonly concept: string;
  readonly unit: string;
  readonly sourceIds: readonly string[];
}

export interface CapitalOwnershipFact {
  readonly value: number;
  readonly periodEnd: string;
  readonly filedAt: string;
  readonly taxonomy: FinancialStatementTaxonomy;
  readonly concept: string;
  readonly unit: string;
  readonly sourceIds: readonly string[];
}

export interface CapitalOwnershipArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly symbol: string;
  readonly dilutedShares: readonly CapitalOwnershipPeriodFact[];
  readonly stockBasedCompensation: readonly CapitalOwnershipPeriodFact[];
  readonly buybacks: readonly CapitalOwnershipPeriodFact[];
  readonly dividendsPaid: readonly CapitalOwnershipPeriodFact[];
  readonly debtPrincipal?: {
    readonly current?: CapitalOwnershipFact;
    readonly noncurrent?: CapitalOwnershipFact;
    readonly maturities: readonly { readonly bucket: string; readonly value: number }[];
  };
  readonly subsequentFinancing?: {
    readonly eventCount: number;
    readonly reconciled: false;
    readonly sourceIds: readonly string[];
  };
  readonly omissions: readonly { readonly code: string; readonly message: string }[];
}

interface ConceptDefinition {
  readonly taxonomy: FinancialStatementTaxonomy;
  readonly concept: string;
}

const SBC_CONCEPTS: readonly ConceptDefinition[] = [
  { taxonomy: "us-gaap", concept: "ShareBasedCompensation" },
  { taxonomy: "us-gaap", concept: "AllocatedShareBasedCompensationExpense" },
  { taxonomy: "ifrs-full", concept: "ShareBasedPayment" },
];

const DILUTED_SHARE_CONCEPTS: readonly ConceptDefinition[] = [
  { taxonomy: "us-gaap", concept: "WeightedAverageNumberOfDilutedSharesOutstanding" },
  { taxonomy: "ifrs-full", concept: "AdjustedWeightedAverageShares" },
];

const BUYBACK_CONCEPTS: readonly ConceptDefinition[] = [
  { taxonomy: "us-gaap", concept: "PaymentsForRepurchaseOfCommonStock" },
  { taxonomy: "us-gaap", concept: "PaymentsForRepurchaseOfEquity" },
  { taxonomy: "ifrs-full", concept: "PaymentsToAcquireOrRedeemEntitysShares" },
];

const DIVIDEND_CONCEPTS: readonly ConceptDefinition[] = [
  { taxonomy: "us-gaap", concept: "PaymentsOfDividends" },
  { taxonomy: "us-gaap", concept: "PaymentsForDividends" },
  { taxonomy: "us-gaap", concept: "DividendsPaid" },
  { taxonomy: "ifrs-full", concept: "DividendsPaidClassifiedAsFinancingActivities" },
];

const CURRENT_DEBT_CONCEPTS: readonly ConceptDefinition[] = [
  { taxonomy: "us-gaap", concept: "LongTermDebtCurrent" },
  { taxonomy: "ifrs-full", concept: "CurrentBorrowings" },
];

const NONCURRENT_DEBT_CONCEPTS: readonly ConceptDefinition[] = [
  { taxonomy: "us-gaap", concept: "LongTermDebtNoncurrent" },
  { taxonomy: "ifrs-full", concept: "NoncurrentBorrowings" },
];

const MATURITY_CONCEPTS: readonly (ConceptDefinition & { readonly bucket: string })[] = [
  {
    taxonomy: "us-gaap",
    concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths",
    bucket: "next-twelve-months",
  },
  {
    taxonomy: "us-gaap",
    concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo",
    bucket: "year-two",
  },
  {
    taxonomy: "us-gaap",
    concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInYearThree",
    bucket: "year-three",
  },
  {
    taxonomy: "us-gaap",
    concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFour",
    bucket: "year-four",
  },
  {
    taxonomy: "us-gaap",
    concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFive",
    bucket: "year-five",
  },
  {
    taxonomy: "us-gaap",
    concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalAfterYearFive",
    bucket: "after-year-five",
  },
];

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readSourceIds(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function readPeriodFact(value: unknown): CapitalOwnershipPeriodFact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const periodEnd = readString(value.periodEnd);
  const filedAt = readString(value.filedAt);
  const form = readString(value.form);
  const { taxonomy } = value;
  const concept = readString(value.concept);
  const unit = readString(value.unit);
  const sourceIds = readSourceIds(value.sourceIds);
  if (
    typeof value.value !== "number" ||
    !Number.isFinite(value.value) ||
    periodEnd === undefined ||
    filedAt === undefined ||
    form === undefined ||
    (taxonomy !== "us-gaap" && taxonomy !== "ifrs-full") ||
    concept === undefined ||
    unit === undefined ||
    sourceIds === undefined
  ) {
    return undefined;
  }
  const periodStart = readString(value.periodStart);
  return {
    value: value.value,
    ...(periodStart !== undefined ? { periodStart } : {}),
    periodEnd,
    filedAt,
    form,
    taxonomy,
    concept,
    unit,
    sourceIds,
  };
}

function readPeriodFacts(value: unknown): readonly CapitalOwnershipPeriodFact[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const facts = value.map((item) => readPeriodFact(item));
  return facts.every((fact) => fact !== undefined)
    ? (facts as readonly CapitalOwnershipPeriodFact[])
    : undefined;
}

export function readCapitalOwnershipArtifact(value: unknown): CapitalOwnershipArtifact | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    readString(value.generatedAt) === undefined ||
    readString(value.symbol) === undefined
  ) {
    return undefined;
  }
  const dilutedShares = readPeriodFacts(value.dilutedShares);
  const stockBasedCompensation = readPeriodFacts(value.stockBasedCompensation);
  const buybacks = readPeriodFacts(value.buybacks);
  const dividendsPaid = readPeriodFacts(value.dividendsPaid);
  if (
    dilutedShares === undefined ||
    stockBasedCompensation === undefined ||
    buybacks === undefined ||
    dividendsPaid === undefined ||
    !Array.isArray(value.omissions)
  ) {
    return undefined;
  }
  const omissions = value.omissions.flatMap((omission) =>
    isRecord(omission) &&
    readString(omission.code) !== undefined &&
    readString(omission.message) !== undefined
      ? [{ code: omission.code as string, message: omission.message as string }]
      : [],
  );
  if (omissions.length !== value.omissions.length) {
    return undefined;
  }
  return {
    version: 1,
    generatedAt: value.generatedAt as string,
    symbol: value.symbol as string,
    dilutedShares,
    stockBasedCompensation,
    buybacks,
    dividendsPaid,
    ...(isRecord(value.debtPrincipal)
      ? {
          debtPrincipal: value.debtPrincipal as NonNullable<
            CapitalOwnershipArtifact["debtPrincipal"]
          >,
        }
      : {}),
    ...(isRecord(value.subsequentFinancing)
      ? {
          subsequentFinancing: value.subsequentFinancing as NonNullable<
            CapitalOwnershipArtifact["subsequentFinancing"]
          >,
        }
      : {}),
    omissions,
  };
}

function conceptUnitFacts(
  payload: unknown,
  definition: ConceptDefinition,
  unit: string,
): readonly unknown[] {
  if (!isRecord(payload) || !isRecord(payload.facts)) {
    return [];
  }
  const taxonomy = payload.facts[definition.taxonomy];
  if (!isRecord(taxonomy) || !isRecord(taxonomy[definition.concept])) {
    return [];
  }
  const concept = taxonomy[definition.concept];
  const units = isRecord(concept) ? concept.units : undefined;
  return isRecord(units) && Array.isArray(units[unit]) ? units[unit] : [];
}

function annualConceptFacts(
  payload: unknown,
  definitions: readonly ConceptDefinition[],
  unit: string,
  analysisAsOf: string,
  sourceId: string,
): readonly CapitalOwnershipPeriodFact[] {
  for (const definition of definitions) {
    const selected = conceptUnitFacts(payload, definition, unit).flatMap(
      (fact): readonly CapitalOwnershipPeriodFact[] => {
        if (
          !isRecord(fact) ||
          (fact.form !== "10-K" &&
            fact.form !== "10-K/A" &&
            fact.form !== "20-F" &&
            fact.form !== "20-F/A") ||
          typeof fact.val !== "number" ||
          !Number.isFinite(fact.val) ||
          typeof fact.start !== "string" ||
          typeof fact.end !== "string" ||
          typeof fact.filed !== "string" ||
          fact.end > analysisAsOf.slice(0, 10) ||
          fact.filed > analysisAsOf.slice(0, 10)
        ) {
          return [];
        }
        return [
          {
            value: fact.val,
            periodStart: fact.start,
            periodEnd: fact.end,
            filedAt: fact.filed,
            form: fact.form,
            taxonomy: definition.taxonomy,
            concept: definition.concept,
            unit,
            sourceIds: [sourceId],
          },
        ];
      },
    );
    if (selected.length > 0) {
      const latestByPeriod = new Map<string, CapitalOwnershipPeriodFact>();
      for (const fact of selected.toSorted((left, right) =>
        left.filedAt.localeCompare(right.filedAt),
      )) {
        latestByPeriod.set(fact.periodEnd, fact);
      }
      return [...latestByPeriod.values()]
        .toSorted((left, right) => right.periodEnd.localeCompare(left.periodEnd))
        .slice(0, 10);
    }
  }
  return [];
}

function latestInstantFact(
  payload: unknown,
  definitions: readonly ConceptDefinition[],
  unit: string,
  analysisAsOf: string,
  sourceId: string,
): CapitalOwnershipFact | undefined {
  for (const definition of definitions) {
    const facts = conceptUnitFacts(payload, definition, unit).flatMap(
      (fact): readonly CapitalOwnershipFact[] => {
        if (
          !isRecord(fact) ||
          typeof fact.val !== "number" ||
          !Number.isFinite(fact.val) ||
          typeof fact.end !== "string" ||
          typeof fact.filed !== "string" ||
          fact.end > analysisAsOf.slice(0, 10) ||
          fact.filed > analysisAsOf.slice(0, 10)
        ) {
          return [];
        }
        return [
          {
            value: fact.val,
            periodEnd: fact.end,
            filedAt: fact.filed,
            taxonomy: definition.taxonomy,
            concept: definition.concept,
            unit,
            sourceIds: [sourceId],
          },
        ];
      },
    );
    const [latest] = facts.toSorted(
      (left, right) =>
        right.periodEnd.localeCompare(left.periodEnd) || right.filedAt.localeCompare(left.filedAt),
    );
    if (latest !== undefined) {
      return latest;
    }
  }
  return undefined;
}

export function deriveCapitalOwnershipArtifact(
  payload: unknown,
  financialStatements: FinancialStatementsArtifact,
  subsequentFinancing?: SubsequentFinancingBridgeArtifact,
): CapitalOwnershipArtifact {
  const currency = financialStatements.reportingCurrency;
  const { sourceId } = financialStatements;
  const dilutedShares = annualConceptFacts(
    payload,
    DILUTED_SHARE_CONCEPTS,
    "shares",
    financialStatements.analysisAsOf,
    sourceId,
  );
  const buybacks =
    currency === undefined
      ? []
      : annualConceptFacts(
          payload,
          BUYBACK_CONCEPTS,
          currency,
          financialStatements.analysisAsOf,
          sourceId,
        );
  const dividendsPaid =
    currency === undefined
      ? []
      : annualConceptFacts(
          payload,
          DIVIDEND_CONCEPTS,
          currency,
          financialStatements.analysisAsOf,
          sourceId,
        );
  const stockBasedCompensation =
    currency === undefined
      ? []
      : annualConceptFacts(
          payload,
          SBC_CONCEPTS,
          currency,
          financialStatements.analysisAsOf,
          sourceId,
        );
  const current =
    currency === undefined
      ? undefined
      : latestInstantFact(
          payload,
          CURRENT_DEBT_CONCEPTS,
          currency,
          financialStatements.analysisAsOf,
          sourceId,
        );
  const noncurrent =
    currency === undefined
      ? undefined
      : latestInstantFact(
          payload,
          NONCURRENT_DEBT_CONCEPTS,
          currency,
          financialStatements.analysisAsOf,
          sourceId,
        );
  const maturities =
    currency === undefined
      ? []
      : MATURITY_CONCEPTS.flatMap((definition) => {
          const fact = latestInstantFact(
            payload,
            [definition],
            currency,
            financialStatements.analysisAsOf,
            sourceId,
          );
          return fact === undefined ? [] : [{ bucket: definition.bucket, value: fact.value }];
        });
  const omissions = [
    ...(dilutedShares.length === 0
      ? [
          {
            code: "diluted-share-history-missing",
            message: "Annual diluted-share history is missing",
          },
        ]
      : []),
    ...(stockBasedCompensation.length === 0
      ? [
          {
            code: "sbc-history-missing",
            message: "Annual stock-based compensation history is missing",
          },
        ]
      : []),
    ...(buybacks.length === 0 && dividendsPaid.length === 0
      ? [
          {
            code: "payout-evidence-missing",
            message: "Filed buyback and dividend evidence is missing",
          },
        ]
      : []),
    ...((current !== undefined || noncurrent !== undefined) && maturities.length === 0
      ? [
          {
            code: "debt-maturity-untagged",
            message: "Debt principal is tagged without maturity buckets",
          },
        ]
      : []),
  ];
  return {
    version: 1,
    generatedAt: financialStatements.generatedAt,
    symbol: financialStatements.symbol,
    dilutedShares,
    stockBasedCompensation,
    buybacks,
    dividendsPaid,
    ...(current !== undefined || noncurrent !== undefined || maturities.length > 0
      ? {
          debtPrincipal: {
            ...(current !== undefined ? { current } : {}),
            ...(noncurrent !== undefined ? { noncurrent } : {}),
            maturities,
          },
        }
      : {}),
    ...(subsequentFinancing !== undefined
      ? {
          subsequentFinancing: {
            eventCount: subsequentFinancing.events.length,
            reconciled: false,
            sourceIds: subsequentFinancing.sourceIds,
          },
        }
      : {}),
    omissions,
  };
}

export async function collectCapitalOwnershipArtifact(
  context: CollectContext,
  symbol: string,
  financialStatements: FinancialStatementsArtifact,
  subsequentFinancing?: SubsequentFinancingBridgeArtifact,
): Promise<CapitalOwnershipArtifact | undefined> {
  const facts = await fetchSecCompanyFactsForSymbol(context, symbol);
  return facts.factsPayload === undefined
    ? undefined
    : deriveCapitalOwnershipArtifact(facts.factsPayload, financialStatements, subsequentFinancing);
}
