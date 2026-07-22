import type { ExtendedEvidence, ExtendedEvidenceItem } from "../../domain/types";
import { isRecord } from "../../guards";
import type { CollectContext } from "../types";
import { fetchSecCompanyFactsForSymbol } from "./sec-edgar";
import type {
  FinancialStatementFact,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";

export type SubsequentFinancingInstrument =
  | "common-equity"
  | "preferred-equity"
  | "convertible-debt"
  | "debt"
  | "credit-facility";

export interface SubsequentFinancingAmount {
  readonly amount: number;
  readonly currency: string;
  readonly basis: "gross" | "net" | "cost";
}

export interface SubsequentFinancingEvent {
  readonly disclosureDate: string;
  readonly eventDate: string;
  readonly instrument: SubsequentFinancingInstrument;
  readonly proceeds: SubsequentFinancingAmount;
  readonly costs: SubsequentFinancingAmount | null;
  readonly sourceIds: readonly string[];
  readonly reconciled: false;
}

export interface SubsequentFinancingBridgeArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly symbol: string;
  readonly statementPeriodEnd: string;
  readonly events: readonly SubsequentFinancingEvent[];
  readonly sourceIds: readonly string[];
}

interface FinancingConcept {
  readonly taxonomy: "us-gaap" | "ifrs-full";
  readonly concept: string;
  readonly instrument: SubsequentFinancingInstrument;
  readonly basis: "gross" | "net";
}

interface CostConcept {
  readonly taxonomy: "us-gaap" | "ifrs-full";
  readonly concept: string;
}

interface CurrentReportFact {
  readonly value: number;
  readonly currency: string;
  readonly filedAt: string;
  readonly periodStart?: string;
  readonly periodEnd: string;
  readonly accessionNumber?: string;
}

const FINANCING_CONCEPTS: readonly FinancingConcept[] = [
  {
    taxonomy: "us-gaap",
    concept: "ProceedsFromIssuanceOfCommonStock",
    instrument: "common-equity",
    basis: "gross",
  },
  {
    taxonomy: "us-gaap",
    concept: "ProceedsFromIssuanceOfPreferredStockAndPreferenceStock",
    instrument: "preferred-equity",
    basis: "gross",
  },
  {
    taxonomy: "us-gaap",
    concept: "ProceedsFromIssuanceOfConvertibleDebt",
    instrument: "convertible-debt",
    basis: "gross",
  },
  {
    taxonomy: "us-gaap",
    concept: "ProceedsFromIssuanceOfLongTermDebt",
    instrument: "debt",
    basis: "gross",
  },
  {
    taxonomy: "us-gaap",
    concept: "ProceedsFromIssuanceOfDebtNetOfIssuanceCosts",
    instrument: "debt",
    basis: "net",
  },
  {
    taxonomy: "us-gaap",
    concept: "ProceedsFromRevolvingLineOfCredit",
    instrument: "credit-facility",
    basis: "gross",
  },
  {
    taxonomy: "ifrs-full",
    concept: "ProceedsFromIssuingShares",
    instrument: "common-equity",
    basis: "gross",
  },
  {
    taxonomy: "ifrs-full",
    concept: "ProceedsFromBorrowings",
    instrument: "debt",
    basis: "gross",
  },
];

const COST_CONCEPTS: readonly CostConcept[] = [
  { taxonomy: "us-gaap", concept: "PaymentsOfDebtIssuanceFees" },
  { taxonomy: "us-gaap", concept: "PaymentsOfStockIssuanceFees" },
  { taxonomy: "ifrs-full", concept: "TransactionCostsOfAnEquityTransaction" },
];

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function statementFacts(artifact: FinancialStatementsArtifact): readonly FinancialStatementFact[] {
  return Object.values(artifact.statements.balanceSheet).flatMap((series) => [
    ...series.annual,
    ...series.interim,
  ]);
}

function latestStatementPeriodEnd(artifact: FinancialStatementsArtifact): string | undefined {
  return statementFacts(artifact)
    .map((fact) => fact.periodEnd)
    .toSorted((left, right) => right.localeCompare(left))[0];
}

function currentReportFacts(
  payload: unknown,
  taxonomy: FinancingConcept["taxonomy"],
  concept: string,
  reportingCurrency: string,
  statementPeriodEnd: string,
): readonly CurrentReportFact[] {
  if (!isRecord(payload) || !isRecord(payload.facts)) {
    return [];
  }
  const taxonomyFacts = payload.facts[taxonomy];
  if (!isRecord(taxonomyFacts) || !isRecord(taxonomyFacts[concept])) {
    return [];
  }
  const { units } = taxonomyFacts[concept];
  if (!isRecord(units) || !Array.isArray(units[reportingCurrency])) {
    return [];
  }
  return units[reportingCurrency].flatMap((fact): readonly CurrentReportFact[] => {
    if (
      !isRecord(fact) ||
      (fact.form !== "8-K" &&
        fact.form !== "8-K/A" &&
        fact.form !== "6-K" &&
        fact.form !== "6-K/A") ||
      typeof fact.val !== "number" ||
      !Number.isFinite(fact.val) ||
      fact.val <= 0 ||
      typeof fact.filed !== "string" ||
      typeof fact.end !== "string" ||
      fact.filed <= statementPeriodEnd ||
      fact.end <= statementPeriodEnd ||
      (fact.start !== undefined &&
        (typeof fact.start !== "string" || fact.start < statementPeriodEnd))
    ) {
      return [];
    }
    return [
      {
        value: fact.val,
        currency: reportingCurrency,
        filedAt: fact.filed,
        ...(typeof fact.start === "string" ? { periodStart: fact.start } : {}),
        periodEnd: fact.end,
        ...(typeof fact.accn === "string" ? { accessionNumber: fact.accn } : {}),
      },
    ];
  });
}

function matchingCost(
  payload: unknown,
  event: CurrentReportFact,
  taxonomy: FinancingConcept["taxonomy"],
  statementPeriodEnd: string,
): SubsequentFinancingAmount | null {
  for (const definition of COST_CONCEPTS.filter((candidate) => candidate.taxonomy === taxonomy)) {
    const cost = currentReportFacts(
      payload,
      definition.taxonomy,
      definition.concept,
      event.currency,
      statementPeriodEnd,
    ).find(
      (fact) =>
        fact.periodEnd === event.periodEnd &&
        fact.filedAt === event.filedAt &&
        (event.accessionNumber === undefined || fact.accessionNumber === event.accessionNumber),
    );
    if (cost !== undefined) {
      return { amount: Math.abs(cost.value), currency: cost.currency, basis: "cost" };
    }
  }
  return null;
}

export function deriveSubsequentFinancingBridge(
  payload: unknown,
  financialStatements: FinancialStatementsArtifact,
): SubsequentFinancingBridgeArtifact | undefined {
  const statementPeriodEnd = latestStatementPeriodEnd(financialStatements);
  const { reportingCurrency } = financialStatements;
  if (statementPeriodEnd === undefined || reportingCurrency === undefined) {
    return undefined;
  }
  const seen = new Set<string>();
  const events = FINANCING_CONCEPTS.flatMap((definition): readonly SubsequentFinancingEvent[] =>
    currentReportFacts(
      payload,
      definition.taxonomy,
      definition.concept,
      reportingCurrency,
      statementPeriodEnd,
    ).flatMap((fact) => {
      const key = [
        fact.accessionNumber ?? fact.filedAt,
        fact.periodEnd,
        definition.instrument,
      ].join(":");
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [
        {
          disclosureDate: fact.filedAt,
          eventDate: fact.periodEnd,
          instrument: definition.instrument,
          proceeds: {
            amount: fact.value,
            currency: fact.currency,
            basis: definition.basis,
          },
          costs: matchingCost(payload, fact, definition.taxonomy, statementPeriodEnd),
          sourceIds: [financialStatements.sourceId],
          reconciled: false,
        },
      ];
    }),
  ).toSorted(
    (left, right) =>
      right.eventDate.localeCompare(left.eventDate) ||
      right.disclosureDate.localeCompare(left.disclosureDate),
  );
  if (events.length === 0) {
    return undefined;
  }
  return {
    version: 1,
    generatedAt: financialStatements.generatedAt,
    symbol: financialStatements.symbol,
    statementPeriodEnd,
    events,
    sourceIds: unique(events.flatMap((event) => event.sourceIds)),
  };
}

export async function collectSubsequentFinancingBridge(
  context: CollectContext,
  symbol: string,
  financialStatements: FinancialStatementsArtifact,
): Promise<SubsequentFinancingBridgeArtifact | undefined> {
  const facts = await fetchSecCompanyFactsForSymbol(context, symbol);
  return facts.factsPayload === undefined
    ? undefined
    : deriveSubsequentFinancingBridge(facts.factsPayload, financialStatements);
}

function amountText(amount: SubsequentFinancingAmount): string {
  return `${amount.currency} ${String(amount.amount)} ${amount.basis}`;
}

export function withSubsequentFinancingEvidence(
  evidence: ExtendedEvidence | undefined,
  bridge: SubsequentFinancingBridgeArtifact | undefined,
): ExtendedEvidence | undefined {
  if (bridge === undefined) {
    return evidence;
  }
  const item: ExtendedEvidenceItem = {
    category: "subsequent-events",
    title: `${bridge.symbol} Subsequent Financing Bridge`,
    summary: `Post-period financing disclosures remain unreconciled to a later filed statement: ${bridge.events
      .map(
        (event) =>
          `${event.eventDate} ${event.instrument}, proceeds ${amountText(event.proceeds)}, costs ${
            event.costs === null ? "not separately disclosed" : amountText(event.costs)
          }`,
      )
      .join("; ")}. Filed cash and debt remain unchanged.`,
    sourceIds: bridge.sourceIds,
    observedAt: bridge.events[0]?.disclosureDate ?? bridge.generatedAt,
    metrics: {
      unreconciledEventCount: bridge.events.length,
      statementPeriodEnd: bridge.statementPeriodEnd,
      currentFinancialStrengthStatus: "partial",
    },
  };
  return {
    ...(evidence?.instrument !== undefined ? { instrument: evidence.instrument } : {}),
    ...(evidence?.subject !== undefined ? { subject: evidence.subject } : {}),
    items: [...(evidence?.items ?? []), item],
    gaps: evidence?.gaps ?? [],
  };
}
