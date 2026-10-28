import { isRecord, readNumber, readString } from "../../guards";
import {
  ENTERPRISE_VALUE_BRIDGE_CONCEPTS,
  TEMPORARY_EQUITY_CONCEPT_PRIORITY,
  trimToMezzaninePeriods,
} from "./enterprise-value-bridge";
import { sourceGap } from "../../domain/source-gaps";
import type { SourceGap } from "../../domain/sources";
import type { CollectContext } from "../types";
import {
  fetchSecCompanyFactsForSymbol,
  grossPrincipalDebtGap,
  leaseInclusiveDebtGap,
  withheldDebtGap,
  type SecCompanyFactsResult,
} from "./sec-edgar";
import {
  CAP_FOLLOWER_SERIES,
  DEPRECIATION_AND_AMORTIZATION_COMPONENTS,
  DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE,
  FINANCIAL_STATEMENT_SERIES_DEFINITIONS,
  MIN_ANNUAL_DURATION_MONTHS,
  MAX_ANNUAL_DURATION_MONTHS,
  isDebtPresenceConcept,
  isRevenueConceptInRecencyBucket,
  US_GAAP_DEBT_DUE_WITHIN_YEAR_CONCEPTS,
  US_GAAP_PRINCIPAL_DUE_WITHIN_YEAR_CONCEPT,
  type FinancialStatementSeriesDefinition,
} from "./financial-statement-definitions";
import {
  capFinancialStatementPeriods,
  compareFinancialStatementFacts,
  compositeStatementIdentity,
  restatedFromOriginalFiling,
  deriveFinancialStatementTtm,
  detectFinancialStatementCadence,
  financialStatementPeriodKey,
  financialStatementPeriodMonths,
  isYearAligned,
  financialStatementFacts,
  debtCandidateConcepts,
  incompleteDebtNote,
  unadjustedLeaseInclusiveDebt,
  unsupersededDebtResolutions,
  incompleteFinancialStatementNotes,
  latestFinancialStatementFact,
  recognizedDebtConcepts,
  resolveDebtAtInstant,
  earlierShareBasisPeriods,
  touchesEarlierShareBasis,
  withheldDebt,
} from "./financial-statement-selection";
import {
  calendarYearFromPeriodEnd,
  grossPrincipalDebtFallbackApplies,
  statementFiscalPeriodKey,
} from "./financial-statement-period-identity";
import {
  COMPOSITE_STATEMENT_FACT_FORMULA,
  GROSS_PRINCIPAL_DEBT_CONCEPT,
  SEC_COMPANYFACTS_UNIT_SCALE,
  canonicalizeSecForm,
  isAnnualReportForm,
  readSecFactPeriodMetadata,
  type CanonicalSecForm,
  type FinancialStatementFact,
  ENTERPRISE_VALUE_BRIDGE_FACT_KEYS,
  type FinancialStatementEnterpriseValueBridge,
  type FinancialStatementEquityStack,
  type FinancialStatementNote,
  type FinancialStatementSeries,
  type FinancialStatementSeriesKey,
  type FinancialStatementsArtifact,
  type FinancialStatementTaxonomy,
  type InterimCadence,
  type OriginalFiling,
  type StructuredFinancialGap,
  type SupportedSecForm,
} from "./financial-statements-contract";

interface ParsedCompositeComponent {
  readonly concept: string;
  readonly value: number;
  readonly accessionNumber: string | null;
  readonly filedAt: string;
  readonly periodEnd: string;
}

interface ParsedFact {
  readonly value: number;
  readonly form: SupportedSecForm;
  readonly canonicalForm: CanonicalSecForm;
  readonly amendment: boolean;
  readonly accessionNumber: string | null;
  readonly filedAt: string;
  readonly periodStart?: string;
  readonly periodEnd: string;
  readonly fiscalYear: number;
  readonly fiscalPeriod: string;
  readonly taxonomy: FinancialStatementTaxonomy;
  readonly concept: string;
  readonly unit: string;
  readonly firstPublicAt?: string;
  readonly lineScope?: true;
  readonly composite?: {
    readonly formula: typeof COMPOSITE_STATEMENT_FACT_FORMULA;
    readonly components: readonly ParsedCompositeComponent[];
  };
}

interface SelectedSeries {
  readonly series: FinancialStatementSeries;
  readonly validationNotes: readonly FinancialStatementNote[];
  readonly omissionNotes: readonly FinancialStatementNote[];
  readonly withheld?: readonly WithheldDerivation[];
}

interface SubmissionFiling {
  readonly form: "6-K" | "6-K/A";
  readonly filedAt: string;
  readonly accessionNumber?: string;
  readonly reportDate?: string;
}

export interface FinancialStatementsDeriveInput {
  readonly symbol: string;
  readonly generatedAt: string;
  readonly analysisAsOf: string;
  readonly sourceId: string;
  readonly sourceUrl?: string;
  readonly submissionsPayload?: unknown;
  readonly submissionsSourceId?: string;
}

const TAXONOMIES: readonly FinancialStatementTaxonomy[] = ["us-gaap", "ifrs-full"];
const STATEMENT_DURATION_MONTHS = new Set([3, 6, 9, 12]);
const DAY_MS = 86_400_000;
const QUARTERLY_REPORTING_PERIOD_DAYS = 120;
const SEMIANNUAL_REPORTING_PERIOD_DAYS = 200;
const ANNUAL_REPORTING_PERIOD_DAYS = 400;
const EQUITY_INCLUDING_NONCONTROLLING_CONCEPT =
  "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest";
const MINORITY_INTEREST_CONCEPT = "MinorityInterest";
const GROSS_PROFIT_COST_CONCEPTS = ["CostOfRevenue", "CostOfGoodsAndServicesSold"];
const CONSOLIDATED_NET_INCOME_CONCEPT = "ProfitLoss";
const TOTAL_NONCONTROLLING_INCOME_CONCEPTS = new Set([
  "NetIncomeLossAttributableToNoncontrollingInterest",
]);
const NONCONTROLLING_INCOME_CONCEPTS = [
  ...TOTAL_NONCONTROLLING_INCOME_CONCEPTS,
  "NetIncomeLossAttributableToNonredeemableNoncontrollingInterest",
  "NetIncomeLossAttributableToRedeemableNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsAttributableToNoncontrollingEntity",
  "MinorityInterestInNetIncomeLossLimitedPartnerships",
  "ComprehensiveIncomeNetOfTaxAttributableToNoncontrollingInterest",
];
type EquityStackComponentKey =
  | "minorityInterest"
  | "stockholdersEquityIncludingNoncontrollingInterest"
  | "temporaryEquity";

function parseFact(
  value: unknown,
  taxonomy: FinancialStatementTaxonomy,
  concept: string,
  unit: string,
): ParsedFact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const numericValue = readNumber(value, "val");
  const formValue = readString(value, "form");
  const form = formValue === undefined ? undefined : canonicalizeSecForm(formValue);
  const accessionNumber = readString(value, "accn");
  const period = readSecFactPeriodMetadata(value);
  if (numericValue === undefined || form === undefined || period === undefined) {
    return undefined;
  }
  const { filed: filedAt, end: periodEnd, fp: fiscalPeriod } = period;
  const fiscalYear = calendarYearFromPeriodEnd(periodEnd);
  if (fiscalYear === undefined) {
    return undefined;
  }
  const periodStart = readString(value, "start");
  return {
    value: numericValue,
    ...form,
    accessionNumber: accessionNumber ?? null,
    filedAt,
    ...(periodStart !== undefined ? { periodStart } : {}),
    periodEnd,
    fiscalYear,
    fiscalPeriod,
    taxonomy,
    concept,
    unit,
  };
}

function factsRoot(payload: unknown): Record<string, unknown> | undefined {
  return isRecord(payload) && isRecord(payload.facts) ? payload.facts : undefined;
}

function taxonomyRoot(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
): Record<string, unknown> | undefined {
  const root = factsRoot(payload);
  return root !== undefined && isRecord(root[taxonomy]) ? root[taxonomy] : undefined;
}

function unitFacts(
  taxonomy: FinancialStatementTaxonomy,
  root: Record<string, unknown>,
  concept: string,
): readonly ParsedFact[] {
  const fact = isRecord(root[concept]) ? root[concept] : undefined;
  const units = fact !== undefined && isRecord(fact.units) ? fact.units : undefined;
  if (units === undefined) {
    return [];
  }
  return Object.entries(units).flatMap(([unit, values]) =>
    (Array.isArray(values) ? values : []).flatMap((value) => {
      const parsed = parseFact(value, taxonomy, concept, unit);
      return parsed === undefined ? [] : [parsed];
    }),
  );
}

function factsForLatestPeriodConcept(
  taxonomy: FinancialStatementTaxonomy,
  root: Record<string, unknown>,
  concepts: readonly string[],
  eligible: (fact: ParsedFact) => boolean,
): readonly ParsedFact[] {
  const ranked = concepts
    .map((concept, priority) => {
      const facts = unitFacts(taxonomy, root, concept);
      const latestPeriodEnd = facts
        .filter((fact) => eligible(fact))
        .map((fact) => fact.periodEnd)
        .toSorted()
        .at(-1);
      return { facts, latestPeriodEnd, priority };
    })
    .filter(
      (
        candidate,
      ): candidate is {
        readonly facts: readonly ParsedFact[];
        readonly latestPeriodEnd: string;
        readonly priority: number;
      } => candidate.latestPeriodEnd !== undefined,
    );
  const latestPeriodEnd = ranked
    .map((candidate) => candidate.latestPeriodEnd)
    .toSorted()
    .at(-1);
  if (latestPeriodEnd === undefined) {
    return [];
  }
  return (
    ranked
      .filter((candidate) => candidate.latestPeriodEnd === latestPeriodEnd)
      .toSorted((left, right) => left.priority - right.priority)[0]?.facts ?? []
  );
}

function factsForDefinition(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  definition: FinancialStatementSeriesDefinition,
  eligible: (fact: ParsedFact) => boolean = () => true,
): readonly ParsedFact[] {
  const root = taxonomyRoot(payload, taxonomy);
  if (root === undefined) {
    return [];
  }
  const concepts = definition.concepts[taxonomy];
  if (definition.key === "dividendsPerShare") {
    // Declarations are annual-anchored; a newer interim cash-paid tag must not hide declared annual history.
    const annualBasis = factsForLatestPeriodConcept(
      taxonomy,
      root,
      concepts,
      (fact) =>
        eligible(fact) &&
        fact.periodStart !== undefined &&
        isYearAligned(fact.periodStart, fact.periodEnd) &&
        periodType(fact, definition) === "annual",
    );
    const statementBasis =
      annualBasis.length > 0
        ? annualBasis
        : factsForLatestPeriodConcept(
            taxonomy,
            root,
            concepts,
            (fact) => eligible(fact) && isStatementPeriod(fact, definition),
          );
    // Spans-only issuers still surface their declarations as omission evidence.
    return statementBasis.length > 0
      ? statementBasis
      : factsForLatestPeriodConcept(taxonomy, root, concepts, eligible);
  }
  if (definition.key !== "revenue") {
    return factsForLatestPeriodConcept(taxonomy, root, concepts, eligible);
  }
  const ranked = concepts
    .map((concept, priority) => {
      const facts = unitFacts(taxonomy, root, concept);
      const [latest] = facts
        .filter((fact) => eligible(fact))
        .toSorted(compareFinancialStatementFacts);
      return { facts, latest, priority };
    })
    .filter(
      (
        candidate,
      ): candidate is {
        readonly facts: readonly ParsedFact[];
        readonly latest: ParsedFact;
        readonly priority: number;
      } => candidate.latest !== undefined,
    );
  const latestPeriodEnd = ranked
    .map((candidate) => candidate.latest.periodEnd)
    .toSorted()
    .at(-1);
  if (latestPeriodEnd === undefined) {
    return [];
  }
  return (
    ranked
      .filter((candidate) =>
        isRevenueConceptInRecencyBucket(candidate.latest.periodEnd, latestPeriodEnd),
      )
      .toSorted(
        (left, right) =>
          left.priority - right.priority ||
          left.latest.concept.localeCompare(right.latest.concept) ||
          left.latest.unit.localeCompare(right.latest.unit),
      )[0]?.facts ?? []
  );
}

function compositeFromContributors(
  contributors: readonly ParsedFact[],
  subtracted: ReadonlySet<string> = new Set(),
): ParsedFact {
  const [anchor] = contributors;
  if (anchor === undefined) {
    throw new Error("compositeFromContributors requires at least one contributor");
  }
  const identity = compositeStatementIdentity(contributors);
  return {
    value: identity.value,
    form: anchor.form,
    canonicalForm: anchor.canonicalForm,
    amendment: anchor.amendment,
    accessionNumber: identity.accessionNumber,
    filedAt: identity.filedAt,
    ...(anchor.periodStart !== undefined ? { periodStart: anchor.periodStart } : {}),
    periodEnd: anchor.periodEnd,
    fiscalYear: anchor.fiscalYear,
    fiscalPeriod: anchor.fiscalPeriod,
    taxonomy: anchor.taxonomy,
    concept: contributors
      .map((fact) => `${subtracted.has(fact.concept) ? "-" : "+"}${fact.concept}`)
      .join("")
      .slice(1),
    unit: anchor.unit,
    composite: {
      formula: COMPOSITE_STATEMENT_FACT_FORMULA,
      components: contributors.map((fact) => ({
        concept: fact.concept,
        value: fact.value,
        accessionNumber: fact.accessionNumber,
        filedAt: fact.filedAt,
        periodEnd: fact.periodEnd,
      })),
    },
  };
}

function withCompositeFirstPublicAt(
  composite: ParsedFact,
  definition: FinancialStatementSeriesDefinition,
  candidates: readonly ParsedFact[],
  subtracted: ReadonlySet<string>,
): ParsedFact {
  const histories = (composite.composite?.components ?? []).map((component) =>
    candidates
      .filter(
        (fact) =>
          fact.concept === component.concept &&
          periodKey(fact) === periodKey(composite) &&
          periodType(fact, definition) === periodType(composite, definition),
      )
      .map((fact) => (subtracted.has(fact.concept) ? { ...fact, value: -fact.value } : fact)),
  );
  return {
    ...composite,
    firstPublicAt: firstPublicDate(composite.value, composite.filedAt, histories),
  };
}

function factsForDepreciationAndAmortization(
  payload: unknown,
  definition: FinancialStatementSeriesDefinition,
  eligible: (fact: ParsedFact) => boolean,
): { readonly facts: readonly ParsedFact[]; readonly notes: readonly FinancialStatementNote[] } {
  const root = taxonomyRoot(payload, "us-gaap");
  if (root === undefined) {
    return { facts: [], notes: [] };
  }
  const totals = definition.concepts["us-gaap"];
  const concepts = [...totals, ...DEPRECIATION_AND_AMORTIZATION_COMPONENTS.flat()];
  const periods = new Map<string, ParsedFact[]>();
  for (const fact of concepts.flatMap((concept) => unitFacts("us-gaap", root, concept))) {
    const key = `${fact.periodStart ?? "instant"}|${fact.periodEnd}|${fact.unit}|${periodType(fact, definition)}`;
    periods.set(key, [...(periods.get(key) ?? []), fact]);
  }
  const notes: FinancialStatementNote[] = [];
  const resolvedFacts = [...periods.values()].flatMap((facts) => {
    const candidates = facts.filter((fact) => eligible(fact));
    const totalConcept = totals.find((concept) =>
      candidates.some((fact) => fact.concept === concept),
    );
    const [total] = candidates
      .filter((fact) => fact.concept === totalConcept)
      .toSorted(compareFinancialStatementFacts);
    const contributors = DEPRECIATION_AND_AMORTIZATION_COMPONENTS.flatMap((aliases) => {
      const concept = aliases.find((alias) => candidates.some((fact) => fact.concept === alias));
      const [selected] = candidates
        .filter((fact) => fact.concept === concept && fact.periodStart !== undefined)
        .toSorted(compareFinancialStatementFacts);
      return selected === undefined ? [] : [selected];
    });
    if (
      total !== undefined &&
      !contributors.some(
        (fact) =>
          fact.value - total.value >
          Math.abs(fact.value) * DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE,
      )
    ) {
      return facts.filter((fact) => fact.concept === totalConcept);
    }
    if (contributors.length !== DEPRECIATION_AND_AMORTIZATION_COMPONENTS.length) {
      if (total !== undefined) {
        notes.push({
          code: "incomplete-composite-series",
          seriesKey: definition.key,
          periodKey: periodKey(total),
          message: `SEC depreciation and amortization for ${total.periodStart ?? "instant"} to ${total.periodEnd} omitted: the combined fact is more than ${String(DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE * 100)}% below a same-period component and the matching component set is incomplete`,
        });
      }
      return [];
    }
    return [
      withCompositeFirstPublicAt(
        compositeFromContributors(contributors),
        definition,
        candidates,
        new Set(),
      ),
    ];
  });
  return { facts: resolvedFacts, notes };
}

function debtRestatements(
  fact: ParsedFact | undefined,
  basis: "total" | "components",
  candidates: readonly ParsedFact[],
): readonly ParsedFact[] {
  if (fact === undefined || basis === "components") {
    return fact === undefined ? [] : [fact];
  }
  const key = statementFiscalPeriodKey(fact);
  return candidates.filter(
    (candidate) =>
      candidate.concept === fact.concept && statementFiscalPeriodKey(candidate) === key,
  );
}

function factsForDebt(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  definition: FinancialStatementSeriesDefinition,
  eligible: (fact: ParsedFact) => boolean,
): { readonly facts: readonly ParsedFact[]; readonly notes: readonly FinancialStatementNote[] } {
  const root = taxonomyRoot(payload, taxonomy);
  if (root === undefined) {
    return { facts: [], notes: [] };
  }
  const recognized = recognizedDebtConcepts(taxonomy);
  const candidates = debtCandidateConcepts(taxonomy, root)
    .flatMap((concept) => unitFacts(taxonomy, root, concept))
    .filter(
      (fact) => eligible(fact) && (fact.periodStart === undefined || recognized.has(fact.concept)),
    );
  const instants = new Map<string, Map<string, ParsedFact>>();
  for (const fact of candidates.toSorted(compareFinancialStatementFacts)) {
    const key = statementFiscalPeriodKey(fact);
    const tagged = instants.get(key) ?? new Map<string, ParsedFact>();
    if (!tagged.has(fact.concept)) {
      tagged.set(fact.concept, fact);
    }
    instants.set(key, tagged);
  }
  const history = candidates.map(({ concept, periodEnd, filedAt, value, amendment }) => ({
    concept,
    amendment,
    periodEnd,
    filedAt,
    value,
  }));
  const principalFacts = Object.fromEntries(
    (
      [
        ["dueWithinYear", US_GAAP_PRINCIPAL_DUE_WITHIN_YEAR_CONCEPT],
        ["total", GROSS_PRINCIPAL_DEBT_CONCEPT],
        ["unamortized", "DebtInstrumentUnamortizedDiscountPremiumAndDebtIssuanceCostsNet"],
      ] as const
    ).map(([key, concept]) => [
      key,
      taxonomy === "us-gaap"
        ? unitFacts(taxonomy, root, concept).filter(
            (fact) => fact.periodStart === undefined && eligible(fact),
          )
        : [],
    ]),
  );
  const resolved = [...instants.values()].map((tagged) => {
    const facts = [...tagged.values()];
    const instant = {
      periodEnd: facts[0]?.periodEnd ?? "",
      filedAt:
        facts
          .map((fact) => fact.filedAt)
          .toSorted()
          .at(-1) ?? "",
    };
    const resolution = resolveDebtAtInstant(
      taxonomy,
      instant,
      tagged,
      history,
      (fact) => fact.value,
      (fact) => fact.filedAt,
      Object.fromEntries(
        Object.entries(principalFacts).map(([key, values]) => [
          key,
          values
            .filter(
              (fact) => fact.periodEnd === instant.periodEnd && fact.filedAt <= instant.filedAt,
            )
            .toSorted(compareFinancialStatementFacts)
            .at(0)?.value,
        ]),
      ),
    );
    const subtracted = new Set(
      resolution.contributors.flatMap((contributor) =>
        contributor.subtract === true ? [contributor.concept] : [],
      ),
    );
    const contributors = resolution.contributors.map(({ fact, subtract }) =>
      subtract === true ? { ...fact, value: -fact.value } : fact,
    );
    const [anchor] = contributors;
    const incomplete = resolution.incompleteReason !== undefined || anchor === undefined;
    const resolveFact = (): ParsedFact | undefined => {
      if (incomplete) {
        return undefined;
      }
      return resolution.basis === "total"
        ? anchor
        : withCompositeFirstPublicAt(
            compositeFromContributors(contributors, subtracted),
            definition,
            candidates,
            subtracted,
          );
    };
    const fact = resolveFact();
    return {
      ...instant,
      fact,
      restatements: debtRestatements(fact, resolution.basis, candidates),
      incomplete,
      incompleteReason: resolution.incompleteReason,
      basis: resolution.basis,
      lineScope: resolution.lineScope === true,
    };
  });
  const current = unsupersededDebtResolutions(resolved);
  const [latest] = current
    .flatMap((entry) => (entry.fact === undefined ? [] : [{ ...entry, fact: entry.fact }]))
    .toSorted((left, right) => compareFinancialStatementFacts(left.fact, right.fact));
  const notes = new Map(
    current.flatMap(({ periodEnd, filedAt, incompleteReason }) =>
      incompleteReason === undefined
        ? []
        : [[periodEnd, incompleteDebtNote(periodEnd, incompleteReason, filedAt)] as const],
    ),
  );
  const ineligible = (latest?.fact.concept.split(/[+-]/u) ?? []).flatMap((concept) =>
    unitFacts(taxonomy, root, concept).filter((fact) => !eligible(fact)),
  );
  const kept = new Set(current.flatMap((entry) => (entry.incomplete ? [] : entry.restatements)));
  const lineScoped = new Set(
    current.flatMap((entry) => (!entry.incomplete && entry.lineScope ? entry.restatements : [])),
  );
  return {
    facts: [
      ...candidates.filter((fact) => kept.has(fact)),
      ...[...kept].filter((fact) => fact.composite !== undefined),
      ...ineligible,
    ].map((fact) => (lineScoped.has(fact) ? { ...fact, lineScope: true as const } : fact)),
    notes: [...notes.values()],
  };
}

interface WithheldDerivation {
  readonly periodKey: string;
  readonly periodStart?: string;
  readonly periodEnd: string;
  readonly reason: string;
}

interface DerivedSeriesFacts {
  readonly facts: readonly ParsedFact[];
  readonly withheld: readonly WithheldDerivation[];
}

const NO_DERIVED_FACTS: DerivedSeriesFacts = { facts: [], withheld: [] };

function filingContextKey(fact: ParsedFact): string | undefined {
  return fact.periodStart === undefined || fact.accessionNumber === null
    ? undefined
    : `${fact.accessionNumber}|${fact.form}|${fact.periodStart}|${fact.periodEnd}|${fact.unit}`;
}

function periodGroups(
  facts: readonly ParsedFact[],
  definition: FinancialStatementSeriesDefinition,
): Map<string, readonly ParsedFact[]> {
  const groups = new Map<string, ParsedFact[]>();
  for (const fact of facts) {
    const key = `${periodType(fact, definition)}|${periodKey(fact)}`;
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  return new Map(
    [...groups].map(([key, group]) => [key, group.toSorted(compareFinancialStatementFacts)]),
  );
}

function withheldPeriod(fact: ParsedFact, reason: string): WithheldDerivation {
  return {
    periodKey: periodKey(fact),
    ...(fact.periodStart !== undefined ? { periodStart: fact.periodStart } : {}),
    periodEnd: fact.periodEnd,
    reason,
  };
}

// Pairs only each period's current revenue and cost revisions, so a restatement never meets a stale cost.
function derivedGrossProfitFacts(
  payload: unknown,
  definition: FinancialStatementSeriesDefinition,
  eligible: (fact: ParsedFact) => boolean,
): DerivedSeriesFacts {
  const root = taxonomyRoot(payload, "us-gaap");
  const revenueDefinition = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    (candidate) => candidate.key === "revenue",
  );
  if (root === undefined || revenueDefinition === undefined) {
    return NO_DERIVED_FACTS;
  }
  const revenue = factsForDefinition(payload, "us-gaap", revenueDefinition, eligible).filter(
    (fact) => eligible(fact) && fact.periodStart !== undefined,
  );
  const cost = factsForLatestPeriodConcept(
    "us-gaap",
    root,
    GROSS_PROFIT_COST_CONCEPTS,
    eligible,
  ).filter((fact) => eligible(fact) && fact.periodStart !== undefined);
  const costConcept = cost[0]?.concept;
  if (revenue.length === 0 || costConcept === undefined) {
    return NO_DERIVED_FACTS;
  }
  const costGroups = periodGroups(cost, definition);
  const subtracted = new Set([costConcept]);
  const facts: ParsedFact[] = [];
  const withheld: WithheldDerivation[] = [];
  for (const [key, [current]] of periodGroups(revenue, definition)) {
    const [currentCost] = costGroups.get(key) ?? [];
    if (current === undefined) {
      continue;
    }
    const context = filingContextKey(current);
    if (currentCost === undefined) {
      withheld.push(withheldPeriod(current, `no ${costConcept} fact is tagged for the period`));
    } else if (context === undefined || context !== filingContextKey(currentCost)) {
      withheld.push(
        withheldPeriod(
          current,
          `the current revenue and ${costConcept} revisions do not share one filing, form, span, and unit`,
        ),
      );
    } else {
      facts.push(
        withCompositeFirstPublicAt(
          compositeFromContributors(
            [current, { ...currentCost, value: -currentCost.value }],
            subtracted,
          ),
          definition,
          [...revenue, ...cost],
          subtracted,
        ),
      );
    }
  }
  return { facts, withheld };
}

function consolidatedNetIncomeFallbackFacts(
  payload: unknown,
  definition: FinancialStatementSeriesDefinition,
  parent: readonly ParsedFact[],
  eligible: (fact: ParsedFact) => boolean,
  observable: (fact: ParsedFact) => boolean,
): DerivedSeriesFacts {
  const root = taxonomyRoot(payload, "us-gaap");
  if (root === undefined) {
    return NO_DERIVED_FACTS;
  }
  const eligibleParent = parent.filter((fact) => eligible(fact));
  const covered = new Set(eligibleParent.map((fact) => periodKey(fact)));
  const noncontrolling = NONCONTROLLING_INCOME_CONCEPTS.flatMap((concept) =>
    unitFacts("us-gaap", root, concept),
  ).filter((fact) => observable(fact));
  const withNoncontrollingInterest = new Set(noncontrolling.map((fact) => periodKey(fact)));
  const withNonzeroNoncontrolling = new Set(
    noncontrolling.filter((fact) => fact.value !== 0).map((fact) => periodKey(fact)),
  );
  const withPartialNoncontrolling = new Set(
    noncontrolling
      .filter((fact) => !TOTAL_NONCONTROLLING_INCOME_CONCEPTS.has(fact.concept))
      .map((fact) => periodKey(fact)),
  );
  const totalZeroNoncontrollingContexts = new Set(
    noncontrolling.flatMap((fact) =>
      fact.value === 0 && TOTAL_NONCONTROLLING_INCOME_CONCEPTS.has(fact.concept)
        ? (filingContextKey(fact) ?? [])
        : [],
    ),
  );
  const consolidated = unitFacts("us-gaap", root, CONSOLIDATED_NET_INCOME_CONCEPT).filter(
    (fact) => eligible(fact) && fact.periodStart !== undefined,
  );
  const consolidatedByContext = new Map(
    consolidated.flatMap((fact) => {
      const key = filingContextKey(fact);
      return key === undefined ? [] : [[key, fact] as const];
    }),
  );
  const [newestPair] = eligibleParent
    .flatMap((fact) => {
      const key = filingContextKey(fact);
      const peer = key === undefined ? undefined : consolidatedByContext.get(key);
      return peer === undefined || withNonzeroNoncontrolling.has(periodKey(fact))
        ? []
        : [{ fact, peer }];
    })
    .toSorted((left, right) => compareFinancialStatementFacts(left.fact, right.fact));
  const divergent =
    newestPair !== undefined && newestPair.peer.value !== newestPair.fact.value
      ? newestPair.fact
      : undefined;
  const facts: ParsedFact[] = [];
  const withheld: WithheldDerivation[] = [];
  for (const group of periodGroups(
    consolidated.filter((fact) => !covered.has(periodKey(fact))),
    definition,
  ).values()) {
    const [current] = group;
    if (current === undefined) {
      continue;
    }
    if (divergent !== undefined) {
      withheld.push(
        withheldPeriod(
          current,
          `${CONSOLIDATED_NET_INCOME_CONCEPT} differs from NetIncomeLoss in the same filing for the period ending ${divergent.periodEnd}`,
        ),
      );
    } else if (withNonzeroNoncontrolling.has(periodKey(current))) {
      withheld.push(
        withheldPeriod(
          current,
          "a nonzero noncontrolling-interest income fact is tagged for the period",
        ),
      );
    } else if (
      withNoncontrollingInterest.has(periodKey(current)) &&
      !group.some(
        (fact) =>
          fact.value === current.value &&
          totalZeroNoncontrollingContexts.has(filingContextKey(fact) ?? ""),
      )
    ) {
      withheld.push(
        withheldPeriod(
          current,
          withPartialNoncontrolling.has(periodKey(current))
            ? "a noncontrolling-interest income fact other than total net income attribution is tagged for the period"
            : `a zero noncontrolling-interest income fact is tagged without a same-filing ${CONSOLIDATED_NET_INCOME_CONCEPT} of the current value`,
        ),
      );
    } else {
      facts.push(
        ...group.map((fact) =>
          withCompositeFirstPublicAt(
            compositeFromContributors([fact]),
            definition,
            group,
            new Set(),
          ),
        ),
      );
    }
  }
  return { facts, withheld };
}

function derivedSeriesFacts(
  payload: unknown,
  definition: FinancialStatementSeriesDefinition,
  reported: readonly ParsedFact[],
  eligible: (fact: ParsedFact) => boolean,
  observable: (fact: ParsedFact) => boolean,
): DerivedSeriesFacts | undefined {
  if (definition.key === "grossProfit" && reported.length === 0) {
    return derivedGrossProfitFacts(payload, definition, eligible);
  }
  if (definition.key === "netIncome") {
    return consolidatedNetIncomeFallbackFacts(payload, definition, reported, eligible, observable);
  }
  return undefined;
}

// One note per series and reason, limited to periods its input series retains after the cap.
function withheldDerivationNotes(
  selected: readonly SelectedSeries[],
  income: FinancialStatementsArtifact["statements"]["incomeStatement"],
): readonly FinancialStatementNote[] {
  return selected.flatMap(({ series, withheld = [] }) => {
    const input = series.key === "netIncome" ? income.consolidatedNetIncome : income.revenue;
    const retained = new Set(financialStatementFacts(input).map((fact) => fact.periodKey));
    const byReason = new Map<string, string[]>();
    for (const period of withheld.filter((item) => retained.has(item.periodKey))) {
      const span = `${period.periodStart ?? "instant"} to ${period.periodEnd}`;
      byReason.set(period.reason, [...(byReason.get(period.reason) ?? []), span]);
    }
    return [...byReason].map(([reason, spans]) => ({
      code: "withheld-derivation" as const,
      seriesKey: series.key,
      message: `SEC ${series.label.toLowerCase()} is not derived for ${[...new Set(spans)].toSorted().join(", ")}: ${reason}`,
    }));
  });
}

function allFactsForDefinition(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  definition: FinancialStatementSeriesDefinition,
): readonly ParsedFact[] {
  const root = taxonomyRoot(payload, taxonomy);
  return root === undefined
    ? []
    : definition.concepts[taxonomy].flatMap((concept) => unitFacts(taxonomy, root, concept));
}

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

// Raw, pre-selection rows: only point-in-time observability, never form, fp, span or value shape.
function rawConceptRows(
  root: Record<string, unknown> | undefined,
  concept: string,
  analysisAsOf: string,
): readonly unknown[] {
  const cutoff = analysisAsOf.slice(0, 10);
  const units = isRecord(root?.[concept]) ? root[concept].units : undefined;
  return (isRecord(units) ? Object.values(units) : [])
    .flatMap((values) => (Array.isArray(values) ? values : []))
    .filter((fact) => {
      const filed = isRecord(fact) ? readString(fact, "filed") : undefined;
      return filed === undefined || !isCalendarDate(filed) || filed <= cutoff;
    });
}

// Span filtering, alias ranking and caps must not manufacture a non-payer.
function dividendPaymentFiled(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  analysisAsOf: string,
): boolean {
  const root = taxonomyRoot(payload, taxonomy);
  return FINANCIAL_STATEMENT_SERIES_DEFINITIONS.some(
    (definition) =>
      (definition.key === "dividendsPerShare" || definition.key === "dividendsPaid") &&
      definition.concepts[taxonomy].some((concept) =>
        rawConceptRows(root, concept, analysisAsOf).some((fact) => {
          const value = isRecord(fact) ? readNumber(fact, "val") : undefined;
          return (
            value !== undefined && (definition.key === "dividendsPaid" ? value !== 0 : value > 0)
          );
        }),
      ),
  );
}

// Any raw row, even malformed, counts as filed.
function unfiledSeries(
  payload: unknown,
  analysisAsOf: string,
): readonly FinancialStatementSeriesKey[] {
  const filed = (taxonomy: FinancialStatementTaxonomy, concept: string) =>
    rawConceptRows(taxonomyRoot(payload, taxonomy), concept, analysisAsOf).length > 0;
  return FINANCIAL_STATEMENT_SERIES_DEFINITIONS.filter((definition) =>
    TAXONOMIES.every((taxonomy) =>
      definition.key === "debt"
        ? !Object.keys(taxonomyRoot(payload, taxonomy) ?? {}).some(
            (concept) => isDebtPresenceConcept(taxonomy, concept) && filed(taxonomy, concept),
          )
        : !definition.concepts[taxonomy].some((concept) => filed(taxonomy, concept)) &&
          !(
            definition.key === "depreciationAndAmortization" &&
            taxonomy === "us-gaap" &&
            DEPRECIATION_AND_AMORTIZATION_COMPONENTS.every((aliases) =>
              aliases.some((concept) => filed(taxonomy, concept)),
            )
          ),
    ),
  ).map((definition) => definition.key);
}

function isObservable(fact: ParsedFact, analysisAsOf: string): boolean {
  const cutoff = analysisAsOf.slice(0, 10);
  return fact.periodEnd <= cutoff && fact.filedAt <= cutoff;
}

const ELECTING_DEFINITIONS = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.filter(
  (definition) => !CAP_FOLLOWER_SERIES.has(definition.key),
);

function taxonomyScore(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  analysisAsOf: string,
): readonly [number, string, number, number] {
  const seriesFacts = ELECTING_DEFINITIONS.map((definition) =>
    allFactsForDefinition(payload, taxonomy, definition).filter((fact) =>
      isObservable(fact, analysisAsOf),
    ),
  );
  const revenueIndex = ELECTING_DEFINITIONS.findIndex((definition) => definition.key === "revenue");
  if (revenueIndex === -1) {
    throw new Error("Financial statement definitions must include revenue");
  }
  const revenueAnnual = seriesFacts[revenueIndex]?.filter((fact) =>
    isAnnualReportForm(fact.canonicalForm),
  );
  const latestAnnual =
    revenueAnnual
      ?.map((fact) => fact.periodEnd)
      .toSorted()
      .at(-1) ?? "";
  return [
    Number((revenueAnnual?.length ?? 0) > 0),
    latestAnnual,
    seriesFacts.filter((facts) => facts.length > 0).length,
    seriesFacts.flat().length,
  ];
}

function compareTaxonomyScores(
  left: readonly [number, string, number, number],
  right: readonly [number, string, number, number],
): number {
  return (
    left[0] - right[0] ||
    left[1].localeCompare(right[1]) ||
    left[2] - right[2] ||
    left[3] - right[3]
  );
}

function selectTaxonomy(
  payload: unknown,
  analysisAsOf: string,
): FinancialStatementTaxonomy | undefined {
  return TAXONOMIES.map((taxonomy) => ({
    taxonomy,
    score: taxonomyScore(payload, taxonomy, analysisAsOf),
  }))
    .filter(({ score }) => score[3] > 0)
    .toSorted(
      (left, right) =>
        compareTaxonomyScores(right.score, left.score) ||
        TAXONOMIES.indexOf(left.taxonomy) - TAXONOMIES.indexOf(right.taxonomy),
    )[0]?.taxonomy;
}

function currencyForUnit(unit: string): string | undefined {
  const currency = unit.endsWith("/shares") ? unit.slice(0, -7) : unit;
  return /^[A-Z]{3}$/u.test(currency) ? currency : undefined;
}

function selectReportingCurrency(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  analysisAsOf: string,
): string | undefined {
  const revenue = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    (definition) => definition.key === "revenue",
  );
  if (revenue === undefined) {
    throw new Error("Financial statement definitions must include revenue");
  }
  const revenueFacts = allFactsForDefinition(payload, taxonomy, revenue).filter(
    (fact) => isObservable(fact, analysisAsOf) && isAnnualReportForm(fact.canonicalForm),
  );
  const pool =
    revenueFacts.length > 0
      ? revenueFacts
      : ELECTING_DEFINITIONS.filter((definition) => definition.unitKind === "monetary")
          .flatMap((definition) => allFactsForDefinition(payload, taxonomy, definition))
          .filter((fact) => isObservable(fact, analysisAsOf));
  const byCurrency = new Map<string, ParsedFact[]>();
  for (const fact of pool) {
    const currency = currencyForUnit(fact.unit);
    if (currency !== undefined) {
      byCurrency.set(currency, [...(byCurrency.get(currency) ?? []), fact]);
    }
  }
  return [...byCurrency.entries()]
    .map(([currency, facts]) => ({
      currency,
      latestEnd:
        facts
          .map((fact) => fact.periodEnd)
          .toSorted()
          .at(-1) ?? "",
      latestFiled:
        facts
          .map((fact) => fact.filedAt)
          .toSorted()
          .at(-1) ?? "",
      count: facts.length,
    }))
    .toSorted(
      (left, right) =>
        right.latestEnd.localeCompare(left.latestEnd) ||
        right.latestFiled.localeCompare(left.latestFiled) ||
        right.count - left.count ||
        left.currency.localeCompare(right.currency),
    )[0]?.currency;
}

function expectedUnit(definition: FinancialStatementSeriesDefinition, currency: string): string {
  if (definition.unitKind === "shares") {
    return "shares";
  }
  return definition.unitKind === "per-share" ? `${currency}/shares` : currency;
}

function periodType(
  fact: ParsedFact,
  definition: FinancialStatementSeriesDefinition,
): "annual" | "interim" {
  if (!isAnnualReportForm(fact.canonicalForm)) {
    return "interim";
  }
  if (definition.kind === "instant") {
    return "annual";
  }
  const months = financialStatementPeriodMonths(fact);
  return months !== undefined &&
    months >= MIN_ANNUAL_DURATION_MONTHS &&
    months <= MAX_ANNUAL_DURATION_MONTHS
    ? "annual"
    : "interim";
}

function isStatementPeriod(
  fact: ParsedFact,
  definition: FinancialStatementSeriesDefinition,
): boolean {
  return (
    periodType(fact, definition) === "annual" ||
    STATEMENT_DURATION_MONTHS.has(financialStatementPeriodMonths(fact) ?? -1)
  );
}

// Dropped declaration-date spans stay visible so a non-zero one still counts as dividend history.
function declarationSpanNotes(
  spans: readonly ParsedFact[],
  definition: FinancialStatementSeriesDefinition,
): readonly FinancialStatementNote[] {
  const declared = spans.filter((fact) => fact.value !== 0);
  const latest = declared.toSorted((a, b) => a.periodEnd.localeCompare(b.periodEnd)).at(-1);
  return latest === undefined
    ? []
    : [
        {
          code: "declaration-span",
          seriesKey: definition.key,
          periodKey: periodKey(latest),
          message: `SEC ${definition.label.toLowerCase()} has ${String(declared.length)} non-zero declaration-date facts (latest ${periodKey(latest)}) omitted because their spans are not statement periods`,
        },
      ];
}

function periodKey(fact: ParsedFact): string {
  return financialStatementPeriodKey(fact);
}

type DatedFact = ParsedFact & {
  readonly firstPublicAt: string;
  readonly restatedFrom?: OriginalFiling;
};

// Earliest filing date from which the selected value stayed effective, so A -> B -> A dates to the later A.
function firstPublicDate(
  value: number,
  filedAt: string,
  slots: readonly (readonly ParsedFact[])[],
): string {
  const valueAt = (date: string) =>
    slots.reduce<number | undefined>((sum, slot) => {
      const [effective] = slot
        .filter((fact) => fact.filedAt <= date)
        .toSorted(compareFinancialStatementFacts);
      return sum === undefined || effective === undefined ? undefined : sum + effective.value;
    }, 0);
  const dates = [...new Set(slots.flat().map((fact) => fact.filedAt))]
    .filter((date) => date <= filedAt)
    .toSorted();
  const supersededAt = dates.findLast((date) => valueAt(date) !== value) ?? "";
  return dates.find((date) => date > supersededAt) ?? filedAt;
}

function withFirstPublicAt(winner: ParsedFact, candidates: readonly ParsedFact[]): DatedFact {
  const peers = candidates.filter((fact) => periodKey(fact) === periodKey(winner));
  const restatedFrom =
    winner.composite === undefined ? restatedFromOriginalFiling(winner.value, peers) : undefined;
  return {
    ...winner,
    firstPublicAt: winner.firstPublicAt ?? firstPublicDate(winner.value, winner.filedAt, [peers]),
    ...(restatedFrom === undefined ? {} : { restatedFrom }),
  };
}

function toSelectedFact(
  fact: DatedFact,
  definition: FinancialStatementSeriesDefinition,
  currency: string,
  sourceId: string,
): FinancialStatementFact {
  const sourceIds = [sourceId];
  const composite =
    fact.composite === undefined
      ? undefined
      : {
          formula: fact.composite.formula,
          components: fact.composite.components.map((component) => ({
            ...component,
            sourceIds,
          })),
        };
  return {
    value: fact.value,
    periodKey: periodKey(fact),
    periodType: periodType(fact, definition),
    form: fact.form,
    canonicalForm: fact.canonicalForm,
    amendment: fact.amendment,
    accessionNumber: fact.accessionNumber,
    filedAt: fact.filedAt,
    firstPublicAt: fact.firstPublicAt,
    ...(fact.restatedFrom !== undefined ? { restatedFrom: fact.restatedFrom } : {}),
    ...(fact.periodStart !== undefined ? { periodStart: fact.periodStart } : {}),
    periodEnd: fact.periodEnd,
    fiscalYear: fact.fiscalYear,
    fiscalPeriod: fact.fiscalPeriod,
    taxonomy: fact.taxonomy,
    concept: fact.concept,
    currency: fact.unit === "shares" ? null : currency,
    unit: fact.unit,
    unitScale: SEC_COMPANYFACTS_UNIT_SCALE,
    extractionMethod: composite === undefined ? "sec-companyfacts" : "derived-sec-companyfacts",
    sourceIds,
    ...(fact.lineScope === true ? { lineScope: true as const } : {}),
    ...(composite !== undefined ? { composite } : {}),
  };
}

function equityStackConcepts(
  root: Record<string, unknown>,
  component: EquityStackComponentKey,
): readonly string[] {
  if (component === "minorityInterest") {
    return [MINORITY_INTEREST_CONCEPT];
  }
  if (component === "stockholdersEquityIncludingNoncontrollingInterest") {
    return [EQUITY_INCLUDING_NONCONTROLLING_CONCEPT];
  }
  const discovered = Object.keys(root).filter(
    (concept) =>
      concept.startsWith("TemporaryEquity") ||
      concept.startsWith("RedeemableNoncontrollingInterest"),
  );
  return [
    ...TEMPORARY_EQUITY_CONCEPT_PRIORITY,
    ...discovered
      .filter(
        (concept) => !TEMPORARY_EQUITY_CONCEPT_PRIORITY.some((candidate) => candidate === concept),
      )
      .toSorted(),
  ];
}

function selectInstantComponent(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  reportingCurrency: string,
  concepts: (root: Record<string, unknown>) => readonly string[],
  preferredAccessions: ReadonlyMap<string, string>,
  input: FinancialStatementsDeriveInput,
): readonly FinancialStatementFact[] {
  const root = taxonomyRoot(payload, taxonomy);
  if (root === undefined) {
    return [];
  }
  const priority = new Map(concepts(root).map((concept, index) => [concept, index]));
  const candidates = [...priority.keys()].flatMap((concept) =>
    unitFacts(taxonomy, root, concept).filter(
      (fact) =>
        fact.periodStart === undefined &&
        fact.unit === reportingCurrency &&
        isObservable(fact, input.analysisAsOf),
    ),
  );
  const byPeriodEnd = new Map<string, ParsedFact[]>();
  for (const fact of candidates) {
    byPeriodEnd.set(fact.periodEnd, [...(byPeriodEnd.get(fact.periodEnd) ?? []), fact]);
  }
  const instantDefinition = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    (definition) => definition.key === "stockholdersEquity",
  );
  if (instantDefinition === undefined) {
    throw new Error("Financial statement definitions must include stockholdersEquity");
  }
  return [...byPeriodEnd.values()]
    .map((facts) =>
      withFirstPublicAt(
        facts.toSorted(
          (left, right) =>
            Number(right.accessionNumber === preferredAccessions.get(right.periodEnd)) -
              Number(left.accessionNumber === preferredAccessions.get(left.periodEnd)) ||
            (priority.get(left.concept) ?? Number.MAX_SAFE_INTEGER) -
              (priority.get(right.concept) ?? Number.MAX_SAFE_INTEGER) ||
            compareFinancialStatementFacts(left, right),
        )[0]!,
        facts,
      ),
    )
    .toSorted(chronological)
    .map((fact) => toSelectedFact(fact, instantDefinition, reportingCurrency, input.sourceId));
}

function selectEnterpriseValueBridge(
  payload: unknown,
  reportingCurrency: string,
  input: FinancialStatementsDeriveInput,
): FinancialStatementEnterpriseValueBridge {
  const select = (key: keyof FinancialStatementEnterpriseValueBridge) =>
    selectInstantComponent(
      payload,
      "us-gaap",
      reportingCurrency,
      () => ENTERPRISE_VALUE_BRIDGE_CONCEPTS[key],
      new Map(),
      input,
    );
  return trimToMezzaninePeriods(
    Object.fromEntries(
      ENTERPRISE_VALUE_BRIDGE_FACT_KEYS.map((key) => [key, select(key)]),
    ) as unknown as FinancialStatementEnterpriseValueBridge,
  );
}

function selectEquityStack(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  reportingCurrency: string,
  selected: readonly SelectedSeries[],
  input: FinancialStatementsDeriveInput,
): {
  readonly equityStack?: FinancialStatementEquityStack;
  readonly validationNotes: readonly FinancialStatementNote[];
} {
  const identityFacts = (key: FinancialStatementSeriesKey): readonly FinancialStatementFact[] => {
    const series = selected.find((item) => item.series.key === key)?.series;
    return series === undefined ? [] : [...series.annual, ...series.interim];
  };
  const totalAssets = identityFacts("totalAssets");
  const totalLiabilities = identityFacts("totalLiabilities");
  const stockholdersEquity = identityFacts("stockholdersEquity");
  const preferredAccessions = new Map<string, string>();
  for (const asset of totalAssets) {
    const liability = totalLiabilities.find((fact) => fact.periodEnd === asset.periodEnd);
    if (asset.accessionNumber !== null && liability?.accessionNumber === asset.accessionNumber) {
      preferredAccessions.set(asset.periodEnd, asset.accessionNumber);
    }
  }
  const equityStack: FinancialStatementEquityStack = {
    totalAssets,
    totalLiabilities,
    stockholdersEquity,
    minorityInterest: selectInstantComponent(
      payload,
      taxonomy,
      reportingCurrency,
      (root) => equityStackConcepts(root, "minorityInterest"),
      preferredAccessions,
      input,
    ),
    stockholdersEquityIncludingNoncontrollingInterest: selectInstantComponent(
      payload,
      taxonomy,
      reportingCurrency,
      (root) => equityStackConcepts(root, "stockholdersEquityIncludingNoncontrollingInterest"),
      preferredAccessions,
      input,
    ),
    temporaryEquity: selectInstantComponent(
      payload,
      taxonomy,
      reportingCurrency,
      (root) => equityStackConcepts(root, "temporaryEquity"),
      preferredAccessions,
      input,
    ),
  };
  const hasComponents =
    equityStack.minorityInterest.length > 0 ||
    equityStack.stockholdersEquityIncludingNoncontrollingInterest.length > 0 ||
    equityStack.temporaryEquity.length > 0;
  if (!hasComponents) {
    return { validationNotes: [] };
  }
  const componentPeriods = new Set(
    [
      ...equityStack.minorityInterest,
      ...equityStack.stockholdersEquityIncludingNoncontrollingInterest,
      ...equityStack.temporaryEquity,
    ].map((fact) => fact.periodEnd),
  );
  const validationNotes: FinancialStatementNote[] = [];
  for (const asset of totalAssets) {
    const liability = totalLiabilities.find((fact) => fact.periodEnd === asset.periodEnd);
    if (
      liability !== undefined &&
      componentPeriods.has(asset.periodEnd) &&
      (asset.accessionNumber === null ||
        liability.accessionNumber === null ||
        asset.accessionNumber !== liability.accessionNumber)
    ) {
      validationNotes.push({
        code: "mixed-accessions",
        message: `Total assets and total liabilities for ${asset.periodEnd} do not share an SEC accession; equity-stack component selection uses standard precedence`,
        periodKey: asset.periodKey,
      });
    }
  }
  return { equityStack, validationNotes };
}

function selectRestatements(
  facts: readonly ParsedFact[],
  seriesKey: FinancialStatementSeriesKey,
): { readonly facts: readonly DatedFact[]; readonly notes: readonly FinancialStatementNote[] } {
  const groups = new Map<string, ParsedFact[]>();
  for (const fact of facts) {
    const key = periodKey(fact);
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  const notes: FinancialStatementNote[] = [];
  const selected = [...groups.entries()].map(([key, matches]) => {
    const ordered = matches.toSorted(compareFinancialStatementFacts);
    const winner = ordered[0]!;
    if (ordered.length > 1) {
      notes.push({
        code: "duplicate-superseded",
        seriesKey,
        periodKey: key,
        message: `${String(ordered.length - 1)} duplicate/restated fact(s) superseded by ${winner.accessionNumber ?? "unknown accession"} filed ${winner.filedAt}`,
      });
    }
    return withFirstPublicAt(winner, matches);
  });
  return { facts: selected, notes };
}

function chronological(left: ParsedFact, right: ParsedFact): number {
  return (
    left.periodEnd.localeCompare(right.periodEnd) ||
    (left.periodStart ?? "").localeCompare(right.periodStart ?? "") ||
    left.filedAt.localeCompare(right.filedAt) ||
    (left.accessionNumber ?? "").localeCompare(right.accessionNumber ?? "")
  );
}

function materializeBasis(
  raw: readonly ParsedFact[],
  definition: FinancialStatementSeriesDefinition,
  reportingCurrency: string,
  sourceId: string,
  analysisAsOf: string,
  unit: string,
): SelectedSeries {
  const observable = raw.filter((fact) => isObservable(fact, analysisAsOf));
  const compatible = observable.filter((fact) => fact.unit === unit);
  const validationNotes: FinancialStatementNote[] = [];
  const omissionNotes: FinancialStatementNote[] = [];
  const cutoffCount = raw.length - observable.length;
  if (cutoffCount > 0) {
    omissionNotes.push({
      code: "cutoff-exclusion",
      seriesKey: definition.key,
      message: `${String(cutoffCount)} fact(s) were excluded before dedupe at the analysis cutoff`,
    });
  }
  const missingAccessions = compatible.filter((fact) => fact.accessionNumber === null).length;
  if (missingAccessions > 0) {
    omissionNotes.push({
      code: "incomplete-metadata",
      seriesKey: definition.key,
      message: `${String(missingAccessions)} selected-candidate fact(s) lack an SEC accession number; persisted as null`,
    });
  }
  const otherCurrencies = [
    ...new Set(
      observable
        .map((fact) => currencyForUnit(fact.unit))
        .filter(
          (currency): currency is string =>
            currency !== undefined && currency !== reportingCurrency,
        ),
    ),
  ];
  if (otherCurrencies.length > 0) {
    omissionNotes.push({
      code: "mixed-currencies",
      seriesKey: definition.key,
      message: `Excluded incompatible reporting currenc${otherCurrencies.length === 1 ? "y" : "ies"}: ${otherCurrencies.join(", ")}`,
    });
  }
  const annualSelection = selectRestatements(
    compatible.filter((fact) => periodType(fact, definition) === "annual"),
    definition.key,
  );
  const interimSelection = selectRestatements(
    compatible.filter((fact) => periodType(fact, definition) === "interim"),
    definition.key,
  );
  validationNotes.push(...annualSelection.notes, ...interimSelection.notes);

  const mixedEnds = new Map<string, Set<string>>();
  for (const fact of interimSelection.facts) {
    const starts = mixedEnds.get(fact.periodEnd) ?? new Set<string>();
    starts.add(fact.periodStart ?? "instant");
    mixedEnds.set(fact.periodEnd, starts);
  }
  for (const [end, starts] of mixedEnds) {
    if (starts.size > 1) {
      validationNotes.push({
        code: "mixed-periods",
        seriesKey: definition.key,
        message: `${String(starts.size)} distinct interim spans end on ${end}; each remains a separate period key`,
      });
    }
  }

  const annual = annualSelection.facts
    .toSorted(chronological)
    .map((fact) => toSelectedFact(fact, definition, reportingCurrency, sourceId));
  const interim = interimSelection.facts
    .toSorted(chronological)
    .map((fact) => toSelectedFact(fact, definition, reportingCurrency, sourceId));
  const ttmResult = deriveFinancialStatementTtm(definition, annual, interim, reportingCurrency);
  if (ttmResult.note !== undefined) {
    validationNotes.push(ttmResult.note);
  }
  return {
    series: {
      key: definition.key,
      label: definition.label,
      statement: definition.statement,
      annual,
      interim,
      ...(ttmResult.ttm !== undefined ? { ttm: ttmResult.ttm } : {}),
    },
    validationNotes,
    omissionNotes,
  };
}

// One gross fact appended after the net history; priors never cross basis (financial-lens-canonical).
function withGrossPrincipalDebt(
  payload: unknown,
  selected: SelectedSeries,
  definition: FinancialStatementSeriesDefinition,
  reportingCurrency: string,
  input: FinancialStatementsDeriveInput,
  eligible: (fact: ParsedFact) => boolean,
): SelectedSeries {
  const root = taxonomyRoot(payload, "us-gaap");
  const net = latestFinancialStatementFact(financialStatementFacts(selected.series));
  const gross = (
    root === undefined ? [] : unitFacts("us-gaap", root, GROSS_PRINCIPAL_DEBT_CONCEPT)
  ).filter((fact) => fact.periodStart === undefined && eligible(fact));
  const [latestGross] = gross.toSorted(compareFinancialStatementFacts);
  const [grossAtNet] = gross
    .filter((fact) => fact.periodEnd === net?.periodEnd)
    .toSorted(compareFinancialStatementFacts);
  if (
    net === undefined ||
    latestGross === undefined ||
    !grossPrincipalDebtFallbackApplies(
      net,
      latestGross.periodEnd,
      grossAtNet?.value,
      US_GAAP_DEBT_DUE_WITHIN_YEAR_CONCEPTS.flatMap((concept) =>
        (root === undefined ? [] : unitFacts("us-gaap", root, concept))
          .filter(
            (fact) =>
              fact.periodStart === undefined &&
              fact.periodEnd === latestGross.periodEnd &&
              eligible(fact),
          )
          .map((fact) => fact.value),
      ),
    )
  ) {
    return selected;
  }
  const fact: FinancialStatementFact = {
    ...toSelectedFact(
      withFirstPublicAt(latestGross, gross),
      definition,
      reportingCurrency,
      input.sourceId,
    ),
    basis: "gross-principal",
    calibrationPeriodEnd: net.periodEnd,
  };
  const { series } = selected;
  return {
    ...selected,
    series:
      fact.periodType === "annual"
        ? { ...series, annual: [...series.annual, fact] }
        : { ...series, interim: [...series.interim, fact] },
  };
}

function staleConceptHistoryNotes(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  definition: FinancialStatementSeriesDefinition,
  selected: readonly ParsedFact[],
  eligible: (fact: ParsedFact) => boolean,
): readonly FinancialStatementNote[] {
  const root = taxonomyRoot(payload, taxonomy);
  const concept = selected[0]?.concept;
  if (root === undefined || concept === undefined) {
    return [];
  }
  const latestAnnualEnd = (facts: readonly ParsedFact[]) =>
    facts
      .filter((fact) => eligible(fact) && periodType(fact, definition) === "annual")
      .map((fact) => fact.periodEnd)
      .toSorted()
      .at(-1);
  const selectedEnd = latestAnnualEnd(selected);
  return definition.concepts[taxonomy].flatMap((alias): FinancialStatementNote[] => {
    const aliasEnd =
      alias === concept ? undefined : latestAnnualEnd(unitFacts(taxonomy, root, alias));
    return aliasEnd === undefined || (selectedEnd !== undefined && aliasEnd <= selectedEnd)
      ? []
      : [
          {
            code: "stale-concept-history",
            seriesKey: definition.key,
            message: `SEC ${definition.label.toLowerCase()} annual history under ${concept} ${selectedEnd === undefined ? "has no annual period" : `ends ${selectedEnd}`}, while ${alias} reports annual periods to ${aliasEnd}; the tags are not combined because their scope may differ`,
          },
        ];
  });
}

function selectSeries(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  reportingCurrency: string,
  definition: FinancialStatementSeriesDefinition,
  input: FinancialStatementsDeriveInput,
): SelectedSeries {
  const unit = expectedUnit(definition, reportingCurrency);
  const eligible = (fact: ParsedFact) =>
    isObservable(fact, input.analysisAsOf) && fact.unit === unit;
  const debt =
    definition.key === "debt" ? factsForDebt(payload, taxonomy, definition, eligible) : undefined;
  const depreciationAndAmortization =
    definition.key === "depreciationAndAmortization" && taxonomy === "us-gaap"
      ? factsForDepreciationAndAmortization(payload, definition, eligible)
      : undefined;
  const reported =
    debt?.facts ??
    depreciationAndAmortization?.facts ??
    factsForDefinition(payload, taxonomy, definition, eligible);
  const derived =
    taxonomy === "us-gaap"
      ? derivedSeriesFacts(payload, definition, reported, eligible, (fact) =>
          isObservable(fact, input.analysisAsOf),
        )
      : undefined;
  const basis = [...reported, ...(derived?.facts ?? [])];
  const declarationSpans =
    definition.key === "dividendsPerShare"
      ? basis.filter((fact) => !isStatementPeriod(fact, definition))
      : [];
  const facts = basis.filter((fact) => !declarationSpans.includes(fact));
  const selected = materializeBasis(
    facts,
    definition,
    reportingCurrency,
    input.sourceId,
    input.analysisAsOf,
    unit,
  );
  if (debt === undefined) {
    return {
      ...selected,
      ...(derived === undefined ? {} : { withheld: derived.withheld }),
      omissionNotes: [
        ...selected.omissionNotes,
        ...(depreciationAndAmortization?.notes ?? []),
        ...staleConceptHistoryNotes(payload, taxonomy, definition, facts, eligible),
        ...declarationSpanNotes(
          declarationSpans.filter((fact) => eligible(fact)),
          definition,
        ),
      ],
    };
  }
  const withGross =
    taxonomy === "us-gaap"
      ? withGrossPrincipalDebt(payload, selected, definition, reportingCurrency, input, eligible)
      : selected;
  return { ...withGross, omissionNotes: [...withGross.omissionNotes, ...debt.notes] };
}

function recentSubmissionSixKFilings(
  payload: unknown,
  analysisAsOf: string,
): readonly SubmissionFiling[] {
  if (!isRecord(payload) || !isRecord(payload.filings) || !isRecord(payload.filings.recent)) {
    return [];
  }
  const forms = Array.isArray(payload.filings.recent.form) ? payload.filings.recent.form : [];
  const filingDates = Array.isArray(payload.filings.recent.filingDate)
    ? payload.filings.recent.filingDate
    : [];
  const accessionNumbers = Array.isArray(payload.filings.recent.accessionNumber)
    ? payload.filings.recent.accessionNumber
    : [];
  const reportDates = Array.isArray(payload.filings.recent.reportDate)
    ? payload.filings.recent.reportDate
    : [];
  const cutoff = analysisAsOf.slice(0, 10);
  return forms.flatMap((value, index) => {
    const parsed = typeof value === "string" ? canonicalizeSecForm(value) : undefined;
    const filedAt = filingDates[index];
    if (
      parsed === undefined ||
      parsed.canonicalForm !== "6-K" ||
      typeof filedAt !== "string" ||
      filedAt > cutoff
    ) {
      return [];
    }
    const accessionNumber = accessionNumbers[index];
    const reportDate = reportDates[index];
    return [
      {
        form: parsed.form as "6-K" | "6-K/A",
        filedAt,
        ...(typeof accessionNumber === "string" ? { accessionNumber } : {}),
        ...(typeof reportDate === "string" && reportDate !== "" ? { reportDate } : {}),
      },
    ];
  });
}

function filingHasStructuredFact(filing: SubmissionFiling, facts: readonly ParsedFact[]): boolean {
  return facts.some((fact) => {
    if (fact.canonicalForm !== "6-K") {
      return false;
    }
    if (filing.accessionNumber !== undefined && fact.accessionNumber !== null) {
      return filing.accessionNumber === fact.accessionNumber;
    }
    return (
      filing.filedAt === fact.filedAt &&
      (filing.reportDate === undefined || filing.reportDate === fact.periodEnd)
    );
  });
}

function supportedSixKFacts(payload: unknown, analysisAsOf: string): readonly ParsedFact[] {
  return TAXONOMIES.flatMap((taxonomy) =>
    ELECTING_DEFINITIONS.flatMap((definition) =>
      allFactsForDefinition(payload, taxonomy, definition),
    ),
  ).filter((fact) => fact.canonicalForm === "6-K" && isObservable(fact, analysisAsOf));
}

function structuredFinancialGaps(
  taxonomy: FinancialStatementTaxonomy | undefined,
  reportingCurrency: string | undefined,
  taggedSixKFacts: readonly ParsedFact[],
  currentAnnual: FinancialStatementFact | undefined,
  input: FinancialStatementsDeriveInput,
): readonly StructuredFinancialGap[] {
  const gaps: StructuredFinancialGap[] = [];
  if (taxonomy === undefined) {
    gaps.push({
      code: "no-standard-taxonomy",
      message: "No supported us-gaap or ifrs-full standard concepts were available",
      forms: [],
      sourceIds: [input.sourceId],
    });
  }
  if (taxonomy !== undefined && reportingCurrency === undefined) {
    gaps.push({
      code: "no-reporting-currency",
      message: "No reporting currency could be selected for standard monetary statement series",
      forms: [],
      sourceIds: [input.sourceId],
    });
  }
  const untaggedSixK = recentSubmissionSixKFilings(
    input.submissionsPayload,
    input.analysisAsOf,
  ).filter(
    (filing) =>
      (currentAnnual === undefined ||
        filing.filedAt > currentAnnual.filedAt ||
        (filing.reportDate ?? filing.filedAt) > currentAnnual.periodEnd) &&
      !filingHasStructuredFact(filing, taggedSixKFacts),
  );
  if (untaggedSixK.length > 0) {
    gaps.push({
      code: "untagged-6-k",
      message:
        "SEC submissions include 6-K filing evidence without supported structured companyfacts; table extraction is deferred",
      forms: [...new Set(untaggedSixK.map((filing) => filing.form))],
      sourceIds:
        input.submissionsSourceId === undefined ? [input.sourceId] : [input.submissionsSourceId],
    });
  }
  return gaps;
}

function emptySeries(definition: FinancialStatementSeriesDefinition): FinancialStatementSeries {
  return {
    key: definition.key,
    label: definition.label,
    statement: definition.statement,
    annual: [],
    interim: [],
  };
}

function reportingPeriodDays(cadence: InterimCadence): number {
  if (cadence === "semiannual") {
    return SEMIANNUAL_REPORTING_PERIOD_DAYS;
  }
  if (cadence === "annual-only") {
    return ANNUAL_REPORTING_PERIOD_DAYS;
  }
  return QUARTERLY_REPORTING_PERIOD_DAYS;
}

function debtAliasesTagged(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy | undefined,
): boolean {
  const taxonomies = taxonomy === undefined ? TAXONOMIES : [taxonomy];
  return taxonomies.some((candidate) => {
    const root = taxonomyRoot(payload, candidate);
    return (
      root !== undefined &&
      [...recognizedDebtConcepts(candidate)].some(
        (concept) => unitFacts(candidate, root, concept).length > 0,
      )
    );
  });
}

function instantSeriesOmissionNotes(
  series: readonly FinancialStatementSeries[],
  cadence: InterimCadence,
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy | undefined,
): readonly FinancialStatementNote[] {
  const balanceSheet = series.filter((item) => item.statement === "balanceSheet");
  const newestEnd = balanceSheet
    .flatMap((item) => financialStatementFacts(item).map((fact) => fact.periodEnd))
    .toSorted()
    .at(-1);
  const notes: FinancialStatementNote[] = [];
  const debt = series.find((item) => item.key === "debt");
  if (debt !== undefined && !debtAliasesTagged(payload, taxonomy)) {
    notes.push({
      code: "untagged-balance-sheet-series",
      seriesKey: "debt",
      message:
        "Debt is untagged in companyfacts; no direct or current/noncurrent component facts were selected.",
    });
  }
  if (newestEnd === undefined) {
    return notes;
  }
  const lagLimitMs = reportingPeriodDays(cadence) * DAY_MS;
  for (const item of balanceSheet) {
    const latest = latestFinancialStatementFact(financialStatementFacts(item));
    if (latest === undefined) {
      continue;
    }
    const latestMs = Date.parse(latest.periodEnd);
    const newestMs = Date.parse(newestEnd);
    if (
      !Number.isFinite(latestMs) ||
      !Number.isFinite(newestMs) ||
      newestMs - latestMs <= lagLimitMs
    ) {
      continue;
    }
    notes.push({
      code: "stale-instant-series",
      seriesKey: item.key,
      message: `${item.label} latest period end ${latest.periodEnd} lags the newest balance-sheet period end ${newestEnd} by more than one reporting period.`,
    });
  }
  return notes;
}

const SPLIT_EVIDENCE_SERIES: ReadonlySet<FinancialStatementSeriesKey> = new Set([
  "dilutedEps",
  "continuingDilutedEps",
  "dilutedShares",
]);

// Dividend corrections do not corroborate or veto a split; its periods only receive the notes.
const SHARE_BASIS_SERIES: ReadonlySet<FinancialStatementSeriesKey> = new Set([
  ...SPLIT_EVIDENCE_SERIES,
  "dividendsPerShare",
]);

// Thousand-fold restatements are unit-scale corrections, not share-basis changes.
const MAX_SHARE_FACTOR = 1000;

interface ShareBasisRestatement {
  readonly key: FinancialStatementSeriesKey;
  readonly fact: FinancialStatementFact & { readonly restatedFrom: OriginalFiling };
}

interface ShareBasisChange {
  readonly at: string;
  readonly factor: number;
  readonly restatements: readonly ShareBasisRestatement[];
}

// Share-count multiplier the restatement implies: 5 for 5-for-1, -5 for 1-for-5.
function impliedShareFactor({ fact }: ShareBasisRestatement): number {
  const multiplier =
    fact.unit === "shares"
      ? fact.value / fact.restatedFrom.value
      : fact.restatedFrom.value / fact.value;
  return multiplier >= 1 ? Math.round(multiplier) : -Math.round(1 / multiplier);
}

// Tolerance covers cent rounding of both per-share values and 2% filing noise.
function matchesShareFactor(restatement: ShareBasisRestatement, factor: number): boolean {
  const values = [Math.abs(restatement.fact.value), Math.abs(restatement.fact.restatedFrom.value)];
  const [small, big] = [Math.min(...values), Math.max(...values)];
  const size = Math.abs(factor);
  return (
    (size === 1 || factor > 0 === impliedShareFactor(restatement) > 0) &&
    Math.abs(big - size * small) <= Math.max(0.02 * big, 0.005 * (size + 1))
  );
}

// Share counts must corroborate: an integer per-share restatement alone also fits an earnings correction.
// Ponytail: issuers without a restated diluted-share tag (Alphabet) get no gap; read split 8-Ks if one matters.
function shareBasisChanges(
  series: readonly FinancialStatementSeries[],
): readonly ShareBasisChange[] {
  const byDate = new Map<string, ShareBasisRestatement[]>();
  for (const item of series.filter((candidate) => SPLIT_EVIDENCE_SERIES.has(candidate.key))) {
    for (const fact of financialStatementFacts(item)) {
      const original = fact.restatedFrom;
      if (original !== undefined && fact.value * original.value > 0) {
        byDate.set(fact.firstPublicAt, [
          ...(byDate.get(fact.firstPublicAt) ?? []),
          { key: item.key, fact: { ...fact, restatedFrom: original } },
        ]);
      }
    }
  }
  const events = [...byDate].flatMap(([at, restated]): ShareBasisChange[] => {
    const changed = restated.filter((restatement) => !matchesShareFactor(restatement, 1));
    const factor = changed
      .filter((restatement) => restatement.key === "dilutedShares")
      .map((restatement) => impliedShareFactor(restatement))
      .find(
        (candidate) =>
          Math.abs(candidate) >= 2 &&
          Math.abs(candidate) < MAX_SHARE_FACTOR &&
          changed.every((restatement) => matchesShareFactor(restatement, candidate)),
      );
    return factor === undefined || changed.length < 2
      ? []
      : [{ at, factor, restatements: changed }];
  });
  return events.toSorted((left, right) => left.at.localeCompare(right.at));
}

// A period's own share count places it on the old or new basis; without one the basis is unconfirmed.
function onEarlierShareBasis(
  periodShares: number | undefined,
  periodEnd: string,
  change: ShareBasisChange,
): boolean {
  const reference = change.restatements
    .filter((restatement) => restatement.key === "dilutedShares")
    .toSorted(
      (left, right) =>
        Math.abs(Date.parse(left.fact.periodEnd) - Date.parse(periodEnd)) -
        Math.abs(Date.parse(right.fact.periodEnd) - Date.parse(periodEnd)),
    )[0]!.fact.value;
  const multiplier = change.factor > 0 ? change.factor : -1 / change.factor;
  return (
    periodShares === undefined ||
    Math.abs(Math.log((periodShares * multiplier) / reference)) <
      Math.abs(Math.log(periodShares / reference))
  );
}

function lowerFirst(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function shareFactorLabel(key: FinancialStatementSeriesKey, factor: number): string {
  const size = String(Math.abs(factor));
  return factor > 0 === (key === "dilutedShares") ? `${size}x` : `1/${size}`;
}

// Never-refiled periods stay on their filed basis; they are declared, not rescaled.
function mixedShareBasisNotes(
  uncapped: readonly FinancialStatementSeries[],
  retained: readonly FinancialStatementSeries[],
): readonly FinancialStatementNote[] {
  const changes = shareBasisChanges(uncapped);
  const change = changes.at(-1);
  if (change === undefined) {
    return [];
  }
  const sameFactor = changes.filter((candidate) => candidate.factor === change.factor);
  const citedRestatements = sameFactor.flatMap((candidate) => candidate.restatements);
  const shares = uncapped.find((item) => item.key === "dilutedShares");
  const sharesByPeriod = new Map(
    (shares === undefined ? [] : financialStatementFacts(shares)).map((fact) => [
      fact.periodKey,
      fact,
    ]),
  );
  // The share count in effect when the fact was filed: a later restatement does not re-base it.
  const sharesWhenFiled = (fact: FinancialStatementFact) => {
    const periodShares = sharesByPeriod.get(fact.periodKey);
    return periodShares !== undefined && periodShares.firstPublicAt > fact.filedAt
      ? periodShares.restatedFrom?.value
      : periodShares?.value;
  };
  return retained
    .filter((item) => SHARE_BASIS_SERIES.has(item.key))
    .flatMap((item): FinancialStatementNote[] => {
      const earlier = financialStatementFacts(item)
        .filter(
          (fact) =>
            fact.filedAt < change.at &&
            onEarlierShareBasis(sharesWhenFiled(fact), fact.periodEnd, change),
        )
        .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd));
      if (earlier.length === 0) {
        return [];
      }
      const citedKey = citedRestatements.some((restatement) => restatement.key === item.key)
        ? item.key
        : "dilutedShares";
      const cited = citedRestatements
        .filter((restatement) => restatement.key === citedKey)
        .map((restatement) => restatement.fact.periodEnd)
        .toSorted();
      const citedLabel = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
        (definition) => definition.key === citedKey,
      )!.label;
      return [
        {
          code: "mixed-share-basis",
          seriesKey: item.key,
          message: `SEC ${lowerFirst(item.label)} periods ending ${earlier[0]!.periodEnd} to ${earlier.at(-1)!.periodEnd} (${String(earlier.length)} retained) were last filed before ${change.at}, the latest filing to restate share-based history; filings restate ${lowerFirst(citedLabel)} for periods ending ${cited[0]!} to ${cited.at(-1)!} by ~${shareFactorLabel(citedKey, change.factor)}, so those periods are on an earlier or unconfirmed share basis and are not adjusted`,
        },
        ...earlier.map(
          (fact): FinancialStatementNote => ({
            code: "earlier-share-basis",
            seriesKey: item.key,
            periodKey: fact.periodKey,
            message: `${item.label} ${fact.periodKey} is on an earlier or unconfirmed share basis`,
          }),
        ),
      ];
    });
}

function withoutMixedShareBasisTtm(
  series: FinancialStatementSeries,
  notes: readonly FinancialStatementNote[],
): { readonly series: FinancialStatementSeries; readonly note?: FinancialStatementNote } {
  const { ttm, ...rest } = series;
  return ttm === undefined ||
    !touchesEarlierShareBasis(
      Object.values(ttm.components),
      earlierShareBasisPeriods(notes, series.key),
    )
    ? { series }
    : {
        series: rest,
        note: {
          code: "unreconciled-ttm",
          seriesKey: series.key,
          message:
            "FY/latest-YTD/prior-YTD facts include a period on an earlier or unconfirmed share basis",
        },
      };
}

function seriesRecord(
  series: readonly FinancialStatementSeries[],
): FinancialStatementsArtifact["statements"] {
  const byKey = Object.fromEntries(series.map((item) => [item.key, item])) as Readonly<
    Record<FinancialStatementSeriesKey, FinancialStatementSeries>
  >;
  const get = (key: FinancialStatementSeriesKey): FinancialStatementSeries =>
    byKey[key] ??
    emptySeries(
      FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find((definition) => definition.key === key)!,
    );
  return {
    incomeStatement: {
      revenue: get("revenue"),
      grossProfit: get("grossProfit"),
      operatingIncome: get("operatingIncome"),
      netIncome: get("netIncome"),
      consolidatedNetIncome: get("consolidatedNetIncome"),
      continuingIncome: get("continuingIncome"),
      interestExpense: get("interestExpense"),
      incomeTaxExpense: get("incomeTaxExpense"),
      pretaxIncome: get("pretaxIncome"),
    },
    balanceSheet: {
      cash: get("cash"),
      currentAssets: get("currentAssets"),
      currentLiabilities: get("currentLiabilities"),
      totalAssets: get("totalAssets"),
      totalLiabilities: get("totalLiabilities"),
      stockholdersEquity: get("stockholdersEquity"),
      debt: get("debt"),
    },
    cashFlowStatement: {
      operatingCashFlow: get("operatingCashFlow"),
      capitalExpenditure: get("capitalExpenditure"),
      depreciationAndAmortization: get("depreciationAndAmortization"),
      dividendsPaid: get("dividendsPaid"),
      shareRepurchases: get("shareRepurchases"),
    },
    perShare: {
      dilutedEps: get("dilutedEps"),
      continuingDilutedEps: get("continuingDilutedEps"),
      dilutedShares: get("dilutedShares"),
      dividendsPerShare: get("dividendsPerShare"),
    },
  };
}

export function deriveFinancialStatements(
  payload: unknown,
  input: FinancialStatementsDeriveInput,
): FinancialStatementsArtifact {
  const taxonomy = selectTaxonomy(payload, input.analysisAsOf);
  const reportingCurrency =
    taxonomy === undefined
      ? undefined
      : selectReportingCurrency(payload, taxonomy, input.analysisAsOf);
  const selected =
    taxonomy === undefined || reportingCurrency === undefined
      ? FINANCIAL_STATEMENT_SERIES_DEFINITIONS.map(
          (definition) =>
            ({
              series: emptySeries(definition),
              validationNotes: [],
              omissionNotes: [],
            }) satisfies SelectedSeries,
        )
      : FINANCIAL_STATEMENT_SERIES_DEFINITIONS.map((definition) =>
          selectSeries(payload, taxonomy, reportingCurrency, definition, input),
        );
  const equityStackSelection =
    taxonomy === undefined || reportingCurrency === undefined
      ? { validationNotes: [] }
      : selectEquityStack(payload, taxonomy, reportingCurrency, selected, input);
  const uncapped = selected.map((item) => item.series);
  const { series: retained, notes: capNotes } = capFinancialStatementPeriods(uncapped);
  const shareBasisNotes = mixedShareBasisNotes(uncapped, retained);
  const shareBasisTtm = retained.map((item) => withoutMixedShareBasisTtm(item, shareBasisNotes));
  const series = shareBasisTtm.map((item) => item.series);
  const statements = seriesRecord(series);
  const currentAnnual = latestFinancialStatementFact(
    statements.incomeStatement.revenue.annual.filter((fact) => {
      const months = financialStatementPeriodMonths(fact);
      return (
        months !== undefined &&
        months >= MIN_ANNUAL_DURATION_MONTHS &&
        months <= MAX_ANNUAL_DURATION_MONTHS
      );
    }),
  );
  const interimCadence = detectFinancialStatementCadence(series);
  const otherTaxonomies =
    taxonomy === undefined
      ? []
      : TAXONOMIES.filter(
          (candidate) =>
            candidate !== taxonomy && taxonomyScore(payload, candidate, input.analysisAsOf)[3] > 0,
        );
  const taxonomyNotes: FinancialStatementNote[] =
    otherTaxonomies.length === 0
      ? []
      : [
          {
            code: "mixed-taxonomies",
            message: `Selected ${taxonomy}; excluded standard facts from ${otherTaxonomies.join(", ")}`,
          },
        ];
  return {
    version: 1,
    generatedAt: input.generatedAt,
    analysisAsOf: input.analysisAsOf,
    symbol: input.symbol.toUpperCase(),
    sourceId: input.sourceId,
    ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
    ...(taxonomy !== undefined ? { taxonomy } : {}),
    ...(reportingCurrency !== undefined ? { reportingCurrency } : {}),
    interimCadence,
    extractionMethod: "sec-companyfacts",
    ...(equityStackSelection.equityStack !== undefined
      ? { equityStack: equityStackSelection.equityStack }
      : {}),
    ...(taxonomy === "us-gaap" && reportingCurrency !== undefined
      ? { enterpriseValueBridge: selectEnterpriseValueBridge(payload, reportingCurrency, input) }
      : {}),
    ...(taxonomy !== undefined
      ? {
          dividendPaymentFiled: dividendPaymentFiled(payload, taxonomy, input.analysisAsOf),
          unfiledSeries: unfiledSeries(payload, input.analysisAsOf),
        }
      : {}),
    statements,
    validationNotes: [
      ...taxonomyNotes,
      ...equityStackSelection.validationNotes,
      ...selected.flatMap((item) => item.validationNotes),
      ...shareBasisTtm.flatMap((item) => (item.note === undefined ? [] : [item.note])),
      ...incompleteFinancialStatementNotes(series),
    ],
    omissionNotes: [
      ...selected.flatMap((item) => item.omissionNotes),
      ...capNotes,
      ...withheldDerivationNotes(selected, statements.incomeStatement),
      ...instantSeriesOmissionNotes(series, interimCadence, payload, taxonomy),
      ...shareBasisNotes,
    ],
    structuredFinancialGaps: structuredFinancialGaps(
      taxonomy,
      reportingCurrency,
      supportedSixKFacts(payload, input.analysisAsOf),
      currentAnnual,
      input,
    ),
  };
}

// Same text and symbol as the legacy target gap, so dedupeSourceGaps collapses the pair.
export function financialStatementsDebtBasisGaps(
  artifact: FinancialStatementsArtifact,
): readonly SourceGap[] {
  const withheld = withheldDebt(artifact);
  if (withheld !== undefined) {
    return [{ ...withheldDebtGap(withheld.periodEnd, withheld.reason), symbol: artifact.symbol }];
  }
  const latest = latestFinancialStatementFact(
    financialStatementFacts(artifact.statements.balanceSheet.debt),
  );
  if (latest?.calibrationPeriodEnd !== undefined) {
    return [
      {
        ...grossPrincipalDebtGap(latest.periodEnd, latest.calibrationPeriodEnd),
        symbol: artifact.symbol,
      },
    ];
  }
  const leaseInclusive =
    latest === undefined ? [] : unadjustedLeaseInclusiveDebt(latest.taxonomy, latest.concept);
  return latest === undefined || leaseInclusive.length === 0
    ? []
    : [{ ...leaseInclusiveDebtGap(latest.periodEnd, leaseInclusive), symbol: artifact.symbol }];
}

export function financialStatementsHistoryGaps(
  artifact: FinancialStatementsArtifact,
): readonly SourceGap[] {
  return artifact.omissionNotes
    .filter(
      (note) =>
        note.code === "stale-concept-history" ||
        note.code === "withheld-derivation" ||
        note.code === "mixed-share-basis" ||
        note.code === "declaration-span" ||
        (note.code === "incomplete-composite-series" &&
          note.seriesKey === "depreciationAndAmortization"),
    )
    .map((note) =>
      sourceGap({
        source: "sec-edgar",
        message: note.message,
        symbol: artifact.symbol,
        provider: "sec-edgar",
        capability: "extended-evidence",
        cause: "provider-data-missing",
        evidenceQualityImpact: "no-cap",
      }),
    );
}

export interface CollectedFinancialStatements {
  readonly statements: FinancialStatementsArtifact | undefined;
  readonly companyFacts: SecCompanyFactsResult;
}

export async function collectFinancialStatements(
  context: CollectContext,
  symbol: string,
): Promise<CollectedFinancialStatements> {
  const facts = await fetchSecCompanyFactsForSymbol(context, symbol);
  if (facts.factsPayload === undefined || facts.sourceId === undefined) {
    return { statements: undefined, companyFacts: facts };
  }
  const statements = deriveFinancialStatements(facts.factsPayload, {
    symbol,
    generatedAt: context.fetchedAt,
    analysisAsOf: context.fetchedAt,
    sourceId: facts.sourceId,
    ...(facts.sourceUrl !== undefined ? { sourceUrl: facts.sourceUrl } : {}),
    ...(facts.submissionsPayload !== undefined
      ? { submissionsPayload: facts.submissionsPayload }
      : {}),
    ...(facts.submissionsSourceId !== undefined
      ? { submissionsSourceId: facts.submissionsSourceId }
      : {}),
  });
  return { statements, companyFacts: facts };
}
