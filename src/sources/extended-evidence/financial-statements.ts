import { isRecord, readNumber, readString } from "../../guards";
import {
  ENTERPRISE_VALUE_BRIDGE_CONCEPTS,
  TEMPORARY_EQUITY_CONCEPT_PRIORITY,
  trimToMezzaninePeriods,
} from "./enterprise-value-bridge";
import { sourceGap } from "../../domain/source-gaps";
import type { ExtendedEvidenceItem } from "../../domain/evidence";
import type { SourceGap } from "../../domain/sources";
import {
  DA_CASH_FLOW_FACT_PREFIX,
  EXTENSION_CAPEX_CHECKED_KEY,
  EXTENSION_CAPEX_FACT_PREFIX,
} from "../sec-segment-facts";
import {
  CAP_FOLLOWER_SERIES,
  CASH_FLOW_DEPRECIATION_AND_AMORTIZATION_LINES,
  DEPRECIATION_AND_AMORTIZATION_COMPONENTS,
  DISCONTINUED_OPERATIONS_CONCEPTS,
  NONCONTROLLING_INCOME_CONCEPTS,
  TOTAL_NONCONTROLLING_INCOME_CONCEPTS,
  DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE,
  FINANCIAL_STATEMENT_SERIES_DEFINITIONS,
  MIN_ANNUAL_DURATION_MONTHS,
  MAX_ANNUAL_DURATION_MONTHS,
  isDebtPresenceConcept,
  isRevenueConceptInRecencyBucket,
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
  incompleteFinancialStatementNotes,
  latestFinancialStatementFact,
  earlierShareBasisPeriods,
  touchesEarlierShareBasis,
  compareFinancialStatementRevisions,
} from "./financial-statement-selection";
import {
  type DebtFactReader,
  debtAliasesTagged,
  factsForDebt,
  withheldGrossPrincipalDebt,
} from "./sec-debt";
import { calendarYearFromPeriodEnd } from "./financial-statement-period-identity";
import {
  COMPOSITE_STATEMENT_FACT_FORMULA,
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
  readonly sourceIds?: readonly string[];
}

export interface ParsedFact {
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
  readonly sourceIds?: readonly string[];
  readonly proofSourceIds?: readonly string[];
  readonly faceLeases?: readonly string[];
  readonly composite?: {
    readonly formula: typeof COMPOSITE_STATEMENT_FACT_FORMULA;
    readonly components: readonly ParsedCompositeComponent[];
  };
}

export interface SelectedSeries {
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
  readonly secFilings?: readonly ExtendedEvidenceItem[];
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
        ...(fact.sourceIds === undefined ? {} : { sourceIds: fact.sourceIds }),
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

function componentTolerance(value: number): number {
  return Math.abs(value) * DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE;
}

// `<accession>|<concept>|<start>|<end>` -> whether that filing's cash-flow table shows the fact beside intangible amortization.
function depreciationPresentation(
  filings: readonly ExtendedEvidenceItem[],
): ReadonlyMap<string, boolean> {
  return new Map(
    filings.flatMap(({ metrics }) =>
      Object.entries(metrics ?? {}).flatMap(([key, value]) =>
        key.startsWith(DA_CASH_FLOW_FACT_PREFIX)
          ? [
              [
                `${String(metrics?.accessionNumber)}|${key.slice(DA_CASH_FLOW_FACT_PREFIX.length)}`,
                value === 1,
              ] as const,
            ]
          : [],
      ),
    ),
  );
}

function factsForDepreciationAndAmortization(
  payload: unknown,
  definition: FinancialStatementSeriesDefinition,
  eligible: (fact: ParsedFact) => boolean,
  filings: readonly ExtendedEvidenceItem[],
): { readonly facts: readonly ParsedFact[]; readonly notes: readonly FinancialStatementNote[] } {
  const root = taxonomyRoot(payload, "us-gaap");
  if (root === undefined) {
    return { facts: [], notes: [] };
  }
  const presentation = depreciationPresentation(filings);
  const totals = definition.concepts["us-gaap"];
  const concepts = [
    ...totals,
    ...DEPRECIATION_AND_AMORTIZATION_COMPONENTS.flat(),
    ...CASH_FLOW_DEPRECIATION_AND_AMORTIZATION_LINES,
  ];
  const periods = new Map<string, ParsedFact[]>();
  for (const fact of concepts.flatMap((concept) => unitFacts("us-gaap", root, concept))) {
    const key = `${fact.periodStart ?? "instant"}|${fact.periodEnd}|${fact.unit}|${periodType(fact, definition)}`;
    periods.set(key, [...(periods.get(key) ?? []), fact]);
  }
  const [depreciationConcepts = [], amortizationConcepts = []] =
    DEPRECIATION_AND_AMORTIZATION_COMPONENTS;
  const filingColumns = (periodFacts: readonly ParsedFact[]) =>
    [...new Set(periodFacts.map((fact) => fact.accessionNumber))].map((accessionNumber) =>
      [...new Set(periodFacts.map((fact) => fact.concept))].flatMap((concept) => {
        const [fact] = periodFacts
          .filter(
            (candidate) =>
              candidate.accessionNumber === accessionNumber &&
              candidate.concept === concept &&
              eligible(candidate),
          )
          .toSorted(compareFinancialStatementFacts);
        return fact === undefined ? [] : [fact];
      }),
    );
  // DDA above same-column depreciation already carries amortization, so a larger amortization tag is a scope or tagging mismatch (GPN, ANET).
  const containsAmortization = (total: ParsedFact, column: readonly ParsedFact[]) =>
    column.some(
      (fact) =>
        depreciationConcepts.includes(fact.concept) &&
        total.value - fact.value > componentTolerance(total.value),
    );
  // Fallback without a parsed primary document: DDA below intangible amortization in any column of its filing (LTRX FY2025).
  const partialTotalFilings = new Set(
    [...periods.values()].flatMap((periodFacts) =>
      filingColumns(periodFacts).flatMap((column) =>
        column
          .filter(
            (total) =>
              totals.includes(total.concept) &&
              total.value !== 0 &&
              !containsAmortization(total, column) &&
              column.some(
                (component) =>
                  amortizationConcepts.includes(component.concept) &&
                  component.value - total.value > componentTolerance(component.value),
              ),
          )
          .map((total) => `${total.concept}|${total.accessionNumber}`),
      ),
    ),
  );
  const partialTotalNote = (total: ParsedFact, periodFacts: readonly ParsedFact[]) => {
    const sibling = presentation.get(
      `${String(total.accessionNumber)}|${total.concept}|${total.periodStart ?? "instant"}|${total.periodEnd}`,
    );
    if (sibling === true) {
      return `the cash-flow statement in filing ${String(total.accessionNumber)} tags ${total.concept} (${String(total.value)}) beside a separate AmortizationOfIntangibleAssets line, so it is not total D&A`;
    }
    if (
      sibling === false ||
      !partialTotalFilings.has(`${total.concept}|${total.accessionNumber}`)
    ) {
      return undefined;
    }
    const column = filingColumns(periodFacts).find((facts) => facts.includes(total)) ?? [];
    return containsAmortization(total, column)
      ? undefined
      : `${total.concept} (${String(total.value)}) in filing ${total.accessionNumber} is below a same-filing component in another period, so it is not proven total D&A (no parsed cash-flow statement in this filing shows the line)`;
  };
  const notes: FinancialStatementNote[] = [];
  const resolvedFacts = [...periods.values()].flatMap((periodFacts) => {
    // A zero combined caption is a reclassified line (PYPL 2018); a zero component is a real zero (HRMN, LTRX).
    const facts = periodFacts.filter((fact) => fact.value !== 0 || !totals.includes(fact.concept));
    const candidates = facts.filter((fact) => eligible(fact));
    const latest = (concept: string) =>
      candidates
        .filter((fact) => fact.concept === concept && fact.periodStart !== undefined)
        .toSorted(compareFinancialStatementFacts)[0];
    const totalFacts = totals.flatMap((concept) => {
      const fact = latest(concept);
      return fact === undefined ? [] : [fact];
    });
    const cashFlowLines = CASH_FLOW_DEPRECIATION_AND_AMORTIZATION_LINES.flatMap((concept) => {
      const fact = latest(concept);
      return fact === undefined ? [] : [fact];
    });
    const cashFlowSum = cashFlowLines.reduce((sum, fact) => sum + fact.value, 0);
    const contradicted = (value: number, period: ParsedFact): boolean => {
      if (cashFlowLines.length === 0 || cashFlowSum - value <= componentTolerance(cashFlowSum)) {
        return false;
      }
      notes.push({
        code: "incomplete-composite-series",
        seriesKey: definition.key,
        periodKey: periodKey(period),
        message: `SEC depreciation and amortization for ${period.periodStart ?? "instant"} to ${period.periodEnd} omitted: the selected value (${String(value)}) is below the filed cash-flow D&A lines (${String(cashFlowSum)})`,
      });
      return true;
    };
    // DDOG/CRM/EBAY tag PP&E-only DDA beside a higher DA total; the reverse split (AAPL, AMGN) is not proof.
    const belowOtherTotal = (period: ParsedFact): boolean => {
      const higher = totalFacts.find(
        (fact) =>
          fact.concept !== period.concept &&
          fact.value - period.value > componentTolerance(fact.value),
      );
      if (higher === undefined) {
        return false;
      }
      notes.push({
        code: "incomplete-composite-series",
        seriesKey: definition.key,
        periodKey: periodKey(period),
        message: `SEC depreciation and amortization for ${period.periodStart ?? "instant"} to ${period.periodEnd} omitted: ${period.concept} (${String(period.value)}) is below the same-period ${higher.concept} (${String(higher.value)})`,
      });
      return true;
    };
    // AMD FY2020-22, HLIT FY2025: a filed component or cash-flow line proves D&A exists, so a partial set is a gap, not "not filed".
    const incompleteComponentsNote = (
      present: readonly ParsedFact[],
      lines: readonly ParsedFact[],
    ): void => {
      const period = present[0] ?? lines[0];
      if (period === undefined || periodType(period, definition) !== "annual") {
        return;
      }
      const missing = DEPRECIATION_AND_AMORTIZATION_COMPONENTS.filter(
        (aliases) => !present.some((fact) => aliases.includes(fact.concept)),
      ).map((aliases) => aliases[0]);
      const filed = lines.map((fact) => `${fact.concept} ${String(fact.value)}`).join(", ");
      const reason =
        lines.length === 0
          ? "no filed fact proves the filed components are total D&A"
          : `the filed cash-flow line (${filed}) is not proven to be total D&A`;
      notes.push({
        code: "incomplete-composite-series",
        seriesKey: definition.key,
        periodKey: periodKey(period),
        message: `SEC depreciation and amortization for ${period.periodStart ?? "instant"} to ${period.periodEnd} omitted: no combined fact and no ${missing.join(", ")} component; ${reason}`,
      });
    };
    const totalConcept = totalFacts[0]?.concept;
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
      const partial = partialTotalNote(total, periodFacts);
      if (partial !== undefined) {
        notes.push({
          code: "incomplete-composite-series",
          seriesKey: definition.key,
          periodKey: periodKey(total),
          message: `SEC depreciation and amortization for ${total.periodStart ?? "instant"} to ${total.periodEnd} omitted: ${partial}`,
        });
        return [];
      }
      return contradicted(total.value, total) || belowOtherTotal(total)
        ? []
        : facts.filter((fact) => fact.concept === totalConcept);
    }
    if (contributors.length !== DEPRECIATION_AND_AMORTIZATION_COMPONENTS.length) {
      if (total !== undefined) {
        notes.push({
          code: "incomplete-composite-series",
          seriesKey: definition.key,
          periodKey: periodKey(total),
          message: `SEC depreciation and amortization for ${total.periodStart ?? "instant"} to ${total.periodEnd} omitted: the combined fact is more than ${String(DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE * 100)}% below a same-period component and the matching component set is incomplete`,
        });
      } else {
        incompleteComponentsNote(contributors, cashFlowLines);
      }
      return [];
    }
    const [depreciation, amortization] = contributors as [ParsedFact, ParsedFact];
    const sameFilingAmortization =
      cashFlowLines.length === 1 &&
      cashFlowLines[0]!.concept === "AdjustmentForAmortization" &&
      cashFlowLines[0]!.accessionNumber === amortization.accessionNumber
        ? cashFlowLines[0]
        : undefined;
    const amortizationGap =
      sameFilingAmortization === undefined ? 0 : sameFilingAmortization.value - amortization.value;
    // MRK FY2025: the note rounds intangible amortization (2.8B); the cash-flow line carries the filed 2,793M.
    const faceAmortization =
      Math.abs(amortizationGap) <= componentTolerance(sameFilingAmortization?.value ?? 0)
        ? sameFilingAmortization
        : undefined;
    const [faceDepreciation, faceAdjustment] = cashFlowLines;
    // AMD FY2023-25: the face D&A line plus a same-filing intangible add-back is total D&A; a higher add-back may be contract costs (DDOG).
    const facePair =
      cashFlowLines.length === 2 &&
      faceDepreciation!.accessionNumber === faceAdjustment!.accessionNumber &&
      depreciation.value + amortization.value - cashFlowSum <= componentTolerance(cashFlowSum) &&
      faceAdjustment!.value - amortization.value <= componentTolerance(amortization.value) &&
      !cashFlowLines.some((line) =>
        candidates.some(
          (fact) =>
            fact.concept === line.concept &&
            fact.accessionNumber === line.accessionNumber &&
            fact.value !== line.value,
        ),
      )
        ? cashFlowLines
        : undefined;
    const selected =
      facePair ??
      (faceAmortization === undefined ? contributors : [depreciation, faceAmortization]);
    if (
      contradicted(
        selected.reduce((sum, fact) => sum + fact.value, 0),
        selected[0]!,
      )
    ) {
      return [];
    }
    if (selected === contributors) {
      notes.push({
        code: "unchecked-component-sum",
        seriesKey: definition.key,
        periodKey: periodKey(depreciation),
        message: `SEC depreciation and amortization for ${String(depreciation.periodStart)} to ${depreciation.periodEnd} is depreciation + intangible amortization, not checked against the filed cash-flow statement`,
      });
    }
    if (amortizationGap > componentTolerance(sameFilingAmortization?.value ?? 0)) {
      notes.push({
        code: "unreconciled-component",
        seriesKey: definition.key,
        periodKey: periodKey(amortization),
        message: `SEC depreciation and amortization for ${amortization.periodStart ?? "instant"} to ${amortization.periodEnd} uses AmortizationOfIntangibleAssets (${String(amortization.value)}); the same-filing cash-flow AdjustmentForAmortization (${String(sameFilingAmortization!.value)}) is higher and is not proven to be intangible amortization`,
      });
    }
    return [
      withCompositeFirstPublicAt(
        compositeFromContributors(selected),
        definition,
        candidates,
        new Set(),
      ),
    ];
  });
  return { facts: resolvedFacts, notes };
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

const TOTAL_OPERATING_CASH_FLOW_CONCEPT = "NetCashProvidedByUsedInOperatingActivities";
const CONTINUING_OPERATING_CASH_FLOW_CONCEPT =
  "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations";
const DISCONTINUED_OPERATING_CASH_FLOW_CONCEPT =
  "CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations";

// ASC 205-20: continuing OCF where tagged; a total amount stands in only for a period with no discontinued operations.
function scopeAlignedOperatingCashFlow(
  payload: unknown,
  definition: FinancialStatementSeriesDefinition,
  eligible: (fact: ParsedFact) => boolean,
): DerivedSeriesFacts & { readonly datingAliases?: readonly ParsedFact[] } {
  const root = taxonomyRoot(payload, "us-gaap");
  if (root === undefined) {
    return NO_DERIVED_FACTS;
  }
  const lastFiled = (facts: readonly ParsedFact[]) => {
    const filed = new Map<string, ParsedFact>();
    for (const fact of facts) {
      const key = periodKey(fact);
      const current = filed.get(key);
      if (current === undefined || compareFinancialStatementRevisions(fact, current) < 0) {
        filed.set(key, fact);
      }
    }
    return filed;
  };
  const continuing = unitFacts("us-gaap", root, CONTINUING_OPERATING_CASH_FLOW_CONCEPT).filter(
    eligible,
  );
  const total = unitFacts("us-gaap", root, TOTAL_OPERATING_CASH_FLOW_CONCEPT).filter(eligible);
  const continuingFiled = lastFiled(continuing);
  const totalFiled = lastFiled(total);
  const discontinued = new Set(
    DISCONTINUED_OPERATIONS_CONCEPTS.flatMap((concept) => unitFacts("us-gaap", root, concept))
      .filter((fact) => eligible(fact) && fact.value !== 0)
      .map((fact) => periodKey(fact)),
  );
  // An equal total keeps its earlier date when no DISCONTINUED_OPERATIONS_CONCEPTS fact is nonzero.
  const useContinuing = (key: string) => {
    const [current, totalCurrent] = [continuingFiled.get(key), totalFiled.get(key)];
    return (
      current !== undefined &&
      (totalCurrent === undefined ||
        (current.filedAt >= totalCurrent.filedAt &&
          (current.value !== totalCurrent.value || discontinued.has(key))))
    );
  };
  const facts = continuing.filter((fact) => useContinuing(periodKey(fact)));
  const discontinuedCash = unitFacts(
    "us-gaap",
    root,
    DISCONTINUED_OPERATING_CASH_FLOW_CONCEPT,
  ).filter(eligible);
  const subtracted = new Set([DISCONTINUED_OPERATING_CASH_FLOW_CONCEPT]);
  const withheld: WithheldDerivation[] = [];
  for (const fact of total) {
    const key = periodKey(fact);
    if (useContinuing(key)) {
      continue;
    }
    // ASC 230-10-45-24: total minus discontinued OCF, both from the newest filing for the period (a recast supersedes).
    const component = discontinuedCash.find(
      (candidate) =>
        fact === totalFiled.get(key) &&
        filingContextKey(candidate) !== undefined &&
        filingContextKey(candidate) === filingContextKey(fact),
    );
    if (discontinued.has(key) && component !== undefined) {
      facts.push(
        withCompositeFirstPublicAt(
          compositeFromContributors([fact, { ...component, value: -component.value }], subtracted),
          definition,
          [...total, ...discontinuedCash],
          subtracted,
        ),
      );
      continue;
    }
    if (discontinued.has(key)) {
      if (!withheld.some((period) => period.periodKey === key)) {
        withheld.push(
          withheldPeriod(
            fact,
            "discontinued operations are reported for the period and no continuing-operations operating cash flow is tagged",
          ),
        );
      }
      continue;
    }
    facts.push(fact);
  }
  const derived = new Set(facts.map((fact) => periodKey(fact)));
  return {
    facts,
    withheld: withheld.filter((period) => !derived.has(period.periodKey)),
    datingAliases: continuing.filter((fact) => !discontinued.has(periodKey(fact))),
  };
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

// Revenue is a continuing line; total net income for a period with discontinued operations has no margin partner.
function untaggedContinuingIncomeNotes(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy | undefined,
  analysisAsOf: string,
  income: FinancialStatementsArtifact["statements"]["incomeStatement"],
): readonly FinancialStatementNote[] {
  const root = taxonomy === "us-gaap" ? taxonomyRoot(payload, taxonomy) : undefined;
  if (root === undefined) {
    return [];
  }
  const discontinued = new Set(
    DISCONTINUED_OPERATIONS_CONCEPTS.flatMap((concept) => unitFacts("us-gaap", root, concept))
      .filter((fact) => fact.value !== 0 && isObservable(fact, analysisAsOf))
      .map((fact) => periodKey(fact)),
  );
  const continuing = new Set(
    financialStatementFacts(income.continuingIncome).map((f) => f.periodKey),
  );
  return financialStatementFacts(income.netIncome)
    .filter((fact) => discontinued.has(fact.periodKey) && !continuing.has(fact.periodKey))
    .map((fact) => ({
      code: "withheld-derivation" as const,
      seriesKey: "continuingIncome" as const,
      periodKey: fact.periodKey,
      message: `SEC net margin is withheld for ${fact.periodStart ?? "instant"} to ${fact.periodEnd}: discontinued operations are reported and no continuing-operations income is tagged`,
    }));
}

function periodKeys(series: FinancialStatementSeries): ReadonlySet<string> {
  return new Set(financialStatementFacts(series).map((fact) => fact.periodKey));
}

// Net margin needs income including NCI; parent-attributed income stands in only for a period with no NCI income.
function untaggedConsolidatedIncomeNotes(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy | undefined,
  analysisAsOf: string,
  income: FinancialStatementsArtifact["statements"]["incomeStatement"],
): readonly FinancialStatementNote[] {
  const root = taxonomy === undefined ? undefined : taxonomyRoot(payload, taxonomy);
  if (taxonomy === undefined || root === undefined) {
    return [];
  }
  const observable = (concept: string) =>
    unitFacts(taxonomy, root, concept).filter((fact) => isObservable(fact, analysisAsOf));
  const ifrsParent = new Map(
    observable("ProfitLossAttributableToOwnersOfParent").map((fact) => [
      periodKey(fact),
      fact.value,
    ]),
  );
  // IFRS netIncome is ProfitLoss, so a parent share that differs from it marks NCI.
  const ifrsDivergent =
    taxonomy === "ifrs-full"
      ? observable("ProfitLoss")
          .filter((fact) => {
            const parent = ifrsParent.get(periodKey(fact));
            return parent !== undefined && parent !== fact.value;
          })
          .map((fact) => periodKey(fact))
      : [];
  const noncontrolling = new Set([
    ...(taxonomy === "ifrs-full"
      ? ["ProfitLossAttributableToNoncontrollingInterests"]
      : NONCONTROLLING_INCOME_CONCEPTS
    )
      .flatMap(observable)
      .filter((fact) => fact.value !== 0)
      .map((fact) => periodKey(fact)),
    ...ifrsDivergent,
  ]);
  const consolidatedValues = new Map(
    financialStatementFacts(income.consolidatedNetIncome).map((fact) => [
      fact.periodKey,
      fact.value,
    ]),
  );
  const consolidated = periodKeys(income.consolidatedNetIncome);
  const consolidatedContinuing = periodKeys(income.consolidatedContinuingIncome);
  const continuing = periodKeys(income.continuingIncome);
  return financialStatementFacts(income.netIncome).flatMap((fact): FinancialStatementNote[] => {
    const span = `${fact.periodStart ?? "instant"} to ${fact.periodEnd}`;
    const consolidatedValue = consolidatedValues.get(fact.periodKey);
    if (
      !noncontrolling.has(fact.periodKey) &&
      (consolidatedValue === undefined || consolidatedValue === fact.value)
    ) {
      return [];
    }
    if (continuing.has(fact.periodKey) && !consolidatedContinuing.has(fact.periodKey)) {
      return [
        {
          code: "withheld-derivation" as const,
          seriesKey: "consolidatedContinuingIncome" as const,
          periodKey: fact.periodKey,
          message: `SEC continuing net margin is withheld for ${span}: noncontrolling interest income is reported and continuing income is tagged only as attributable to parent`,
        },
      ];
    }
    return taxonomy === "ifrs-full" || consolidated.has(fact.periodKey)
      ? []
      : [
          {
            code: "withheld-derivation" as const,
            seriesKey: "consolidatedNetIncome" as const,
            periodKey: fact.periodKey,
            message: `SEC net margin is withheld for ${span}: noncontrolling interest income is reported and no consolidated net income including NCI is tagged`,
          },
        ];
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
            [
              ...DEPRECIATION_AND_AMORTIZATION_COMPONENTS.flat(),
              ...CASH_FLOW_DEPRECIATION_AND_AMORTIZATION_LINES,
            ].some((concept) => filed(taxonomy, concept))
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

function withFirstPublicAt(
  winner: ParsedFact,
  candidates: readonly ParsedFact[],
  aliasFacts: readonly ParsedFact[] = [],
): DatedFact {
  const peers = candidates.filter((fact) => periodKey(fact) === periodKey(winner));
  const restatedFrom =
    winner.composite === undefined ? restatedFromOriginalFiling(winner.value, peers) : undefined;
  // An alias tag that filed the same figure dates it with its full history (A -> B -> A holds);
  // An alias that never matched may be another scope, so it is ignored.
  const aliasPeers = aliasFacts.filter((fact) => periodKey(fact) === periodKey(winner));
  const matchingAliases = new Set(
    aliasPeers.filter((fact) => fact.value === winner.value).map((fact) => fact.concept),
  );
  const datingPeers = [...peers, ...aliasPeers.filter((fact) => matchingAliases.has(fact.concept))];
  return {
    ...winner,
    firstPublicAt:
      winner.firstPublicAt ?? firstPublicDate(winner.value, winner.filedAt, [datingPeers]),
    ...(restatedFrom === undefined ? {} : { restatedFrom }),
  };
}

function toSelectedFact(
  fact: DatedFact,
  definition: FinancialStatementSeriesDefinition,
  currency: string,
  sourceId: string,
): FinancialStatementFact {
  const sourceIds = [
    ...new Set([
      sourceId,
      ...(fact.proofSourceIds ?? []),
      ...(fact.composite?.components.flatMap((component) => component.sourceIds ?? []) ?? []),
    ]),
  ];
  const composite =
    fact.composite === undefined
      ? undefined
      : {
          formula: fact.composite.formula,
          components: fact.composite.components.map((component) => ({
            ...component,
            sourceIds: component.sourceIds ?? [sourceId],
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
    ...(fact.faceLeases === undefined ? {} : { faceLeases: fact.faceLeases }),
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
  aliasFacts: readonly ParsedFact[],
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
    return withFirstPublicAt(winner, matches, aliasFacts);
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
  aliasFacts: readonly ParsedFact[],
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
    aliasFacts,
  );
  const interimSelection = selectRestatements(
    compatible.filter((fact) => periodType(fact, definition) === "interim"),
    definition.key,
    aliasFacts,
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

function aliasConceptFacts(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  definition: FinancialStatementSeriesDefinition,
  selected: readonly ParsedFact[],
  eligible: (fact: ParsedFact) => boolean,
): readonly ParsedFact[] {
  const root = taxonomyRoot(payload, taxonomy);
  const selectedConcepts = new Set(selected.map((fact) => fact.concept));
  return root === undefined
    ? []
    : definition.concepts[taxonomy]
        .filter((concept) => !selectedConcepts.has(concept))
        .flatMap((concept) => unitFacts(taxonomy, root, concept).filter(eligible));
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
  const debtReader: DebtFactReader = {
    root: (candidate) => taxonomyRoot(payload, candidate),
    unitFacts,
    composite: (contributors, subtracted, candidates) =>
      withCompositeFirstPublicAt(
        compositeFromContributors(contributors, subtracted),
        definition,
        candidates,
        subtracted,
      ),
  };
  const debt =
    definition.key === "debt"
      ? factsForDebt(debtReader, taxonomy, eligible, input.secFilings ?? [])
      : undefined;
  const depreciationAndAmortization =
    definition.key === "depreciationAndAmortization" && taxonomy === "us-gaap"
      ? factsForDepreciationAndAmortization(payload, definition, eligible, input.secFilings ?? [])
      : undefined;
  const operatingCashFlow =
    definition.key === "operatingCashFlow" && taxonomy === "us-gaap"
      ? scopeAlignedOperatingCashFlow(payload, definition, eligible)
      : undefined;
  const reported =
    debt?.facts ??
    depreciationAndAmortization?.facts ??
    operatingCashFlow?.facts ??
    factsForDefinition(payload, taxonomy, definition, eligible);
  const derived =
    operatingCashFlow !== undefined
      ? { facts: [], withheld: operatingCashFlow.withheld }
      : taxonomy === "us-gaap"
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
    operatingCashFlow !== undefined
      ? (operatingCashFlow.datingAliases ?? [])
      : debt === undefined && depreciationAndAmortization === undefined
        ? aliasConceptFacts(payload, taxonomy, definition, facts, eligible)
        : [],
  );
  if (debt === undefined) {
    return {
      ...selected,
      ...(derived === undefined ? {} : { withheld: derived.withheld }),
      omissionNotes: [
        ...selected.omissionNotes,
        ...(depreciationAndAmortization?.notes ?? []),
        ...(operatingCashFlow === undefined
          ? staleConceptHistoryNotes(payload, taxonomy, definition, facts, eligible)
          : []),
        ...declarationSpanNotes(
          declarationSpans.filter((fact) => eligible(fact)),
          definition,
        ),
      ],
    };
  }
  const withGross =
    taxonomy === "us-gaap" ? withheldGrossPrincipalDebt(debtReader, selected, eligible) : selected;
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
  if (
    debt !== undefined &&
    !debtAliasesTagged(
      { root: (candidate) => taxonomyRoot(payload, candidate), unitFacts },
      taxonomy === undefined ? TAXONOMIES : [taxonomy],
    )
  ) {
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
      consolidatedContinuingIncome: get("consolidatedContinuingIncome"),
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

// IREN FY2026: hardware carried in PP&E is paid on an extension line beside the standard capex line.
function withheldExtensionCapex(
  selected: SelectedSeries,
  filings: readonly ExtendedEvidenceItem[],
): SelectedSeries {
  const { ttm, ...series } = selected.series;
  const facts = [...series.annual, ...series.interim];
  if (series.key !== "capitalExpenditure" || facts.length === 0) {
    return selected;
  }
  const periodic = filings.filter(
    ({ metrics }) => metrics?.[EXTENSION_CAPEX_CHECKED_KEY] === "true",
  );
  if (periodic.length === 0) {
    return {
      ...selected,
      omissionNotes: [
        ...selected.omissionNotes,
        {
          code: "unchecked-extension-capex",
          seriesKey: "capitalExpenditure",
          message:
            "SEC capital expenditure is the standard PP&E payments tag only; no 10-K or 10-Q primary document was checked, so issuer-extension investing lines were not checked",
        },
      ],
    };
  }
  const checkedThrough = periodic
    .map(({ metrics }) => metrics?.reportDate)
    .filter((date): date is string => typeof date === "string")
    .toSorted()
    .at(-1);
  const unchecked = [...facts, ...(ttm === undefined ? [] : [ttm])].filter(
    ({ periodEnd }) => checkedThrough === undefined || periodEnd > checkedThrough,
  );
  const uncheckedNotes =
    unchecked.length === 0
      ? []
      : [
          {
            code: "unchecked-extension-capex" as const,
            seriesKey: "capitalExpenditure" as const,
            message: `SEC capital expenditure ending after ${checkedThrough ?? "the parsed filings"} is the standard PP&E payments tag only; no 10-K or 10-Q primary document covering it was parsed, so issuer-extension investing lines were not checked`,
          },
        ];
  const lines = periodic.flatMap(({ metrics, sourceIds }) =>
    Object.entries(metrics ?? {}).flatMap(([key, value]) => {
      const [concept, start, end, unit] = key.slice(EXTENSION_CAPEX_FACT_PREFIX.length).split("|");
      const matched = facts.find((fact) => fact.periodStart === start && fact.periodEnd === end);
      return key.startsWith(EXTENSION_CAPEX_FACT_PREFIX) &&
        typeof value === "number" &&
        matched !== undefined
        ? [{ concept, start: start!, end: end!, unit, value, matched, metrics, sourceIds }]
        : [];
    }),
  );
  if (lines.length === 0) {
    return { ...selected, omissionNotes: [...selected.omissionNotes, ...uncheckedNotes] };
  }
  const overlaps = (fact: { readonly periodStart?: string; readonly periodEnd: string }) =>
    lines.some(
      ({ start, end }) => (fact.periodStart ?? fact.periodEnd) < end && fact.periodEnd > start,
    );
  const annual = series.annual.filter((fact) => !overlaps(fact));
  const interim = series.interim.filter((fact) => !overlaps(fact));
  const kept = new Set([...annual, ...interim]);
  const ttmKept =
    ttm !== undefined &&
    !overlaps(ttm) &&
    Object.values(ttm.components).every((fact) => kept.has(fact));
  return {
    ...selected,
    series: { ...series, annual, interim, ...(ttmKept ? { ttm } : {}) },
    omissionNotes: [
      ...selected.omissionNotes,
      ...uncheckedNotes,
      ...lines.map(({ concept, start, end, unit, value, matched, metrics, sourceIds }) => ({
        code: "incomplete-composite-series" as const,
        seriesKey: "capitalExpenditure" as const,
        periodKey: matched.periodKey,
        message: `SEC capital expenditure for ${start} to ${end} omitted: ${String(metrics?.form)} ${String(metrics?.accessionNumber)} (${sourceIds.join(", ")}) also tags issuer-extension PP&E-like investing payment ${String(concept)} ${String(value)} ${String(unit)} beside the standard PP&E line (${String(matched.value)} ${matched.unit}), so neither is proven to be total capex`,
      })),
    ],
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
          withheldExtensionCapex(
            selectSeries(payload, taxonomy, reportingCurrency, definition, input),
            input.secFilings ?? [],
          ),
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
    omissionNotes: withinRetainedWindow(series, [
      ...selected.flatMap((item) => item.omissionNotes),
      ...capNotes,
      ...withheldDerivationNotes(selected, statements.incomeStatement),
      ...untaggedContinuingIncomeNotes(
        payload,
        taxonomy,
        input.analysisAsOf,
        statements.incomeStatement,
      ),
      ...untaggedConsolidatedIncomeNotes(
        payload,
        taxonomy,
        input.analysisAsOf,
        statements.incomeStatement,
      ),
      ...instantSeriesOmissionNotes(series, interimCadence, payload, taxonomy),
      ...shareBasisNotes,
    ]),
    structuredFinancialGaps: structuredFinancialGaps(
      taxonomy,
      reportingCurrency,
      supportedSixKFacts(payload, input.analysisAsOf),
      currentAnnual,
      input,
    ),
  };
}

function noteShape(key: string): "instant" | "duration" {
  return key.startsWith("instant|") ? "instant" : "duration";
}

function noteCadences(key: string): readonly ("annual" | "interim")[] {
  if (key.startsWith("duration:12|")) {
    return ["annual"];
  }
  return /^duration:(3|6|9)\|/u.test(key) ? ["interim"] : ["annual", "interim"];
}

// Dividends per share has its own cap, so each note is judged against its series' cap scope.
function capScope(key: FinancialStatementSeriesKey | undefined): "dividends" | "core" {
  return key === "dividendsPerShare" ? "dividends" : "core";
}

// Outside the window: on no retained period, and older than what every cadence it may belong to shows, with at least one cadence capped.
export function withinRetainedWindow(
  series: readonly FinancialStatementSeries[],
  notes: readonly FinancialStatementNote[],
): readonly FinancialStatementNote[] {
  const capNotes = notes.filter(
    (note) =>
      note.code === "history-cap" &&
      (note.seriesKey === undefined || note.seriesKey === "dividendsPerShare"),
  );
  const window = (scope: "dividends" | "core") => {
    const scoped = series.filter((item) => capScope(item.key) === scope);
    const scopedCaps = capNotes.filter((note) => capScope(note.seriesKey) === scope);
    return {
      retained: new Set(
        scoped.flatMap((item) => financialStatementFacts(item).map((fact) => fact.periodKey)),
      ),
      emptySeries: new Set(
        scoped.filter((item) => financialStatementFacts(item).length === 0).map((item) => item.key),
      ),
      cadence: (period: "annual" | "interim", shape: string) => {
        const ends = scoped
          .flatMap((item) => item[period])
          .filter((fact) => noteShape(fact.periodKey) === shape)
          .map((fact) => fact.periodEnd)
          .toSorted();
        if (ends.length === 0) {
          return undefined;
        }
        const [dropped] = scopedCaps
          .flatMap((note) =>
            note.periodKey?.startsWith(`${period}|`)
              ? [note.periodKey.slice(period.length + 1)]
              : [],
          )
          .filter((key) => noteShape(key) === shape)
          .map((key) => key.split("|").at(-1)!)
          .toSorted()
          .toReversed();
        return {
          capped: dropped !== undefined,
          shows: (end: string) => (dropped === undefined ? end >= ends[0]! : end > dropped),
        };
      },
    };
  };
  const windows = { dividends: window("dividends"), core: window("core") };
  return notes.filter((note) => {
    const key = note.periodKey;
    const scoped = windows[capScope(note.seriesKey)];
    if (
      note.code === "history-cap" ||
      key === undefined ||
      scoped.retained.has(key) ||
      (note.seriesKey !== undefined && scoped.emptySeries.has(note.seriesKey))
    ) {
      return true;
    }
    const end = key.split("|").at(-1)!;
    const cadences = noteCadences(key).flatMap((period) => {
      const cadence = scoped.cadence(period, noteShape(key));
      return cadence === undefined ? [] : [cadence];
    });
    return (
      !cadences.some((cadence) => cadence.capped) || cadences.some((cadence) => cadence.shows(end))
    );
  });
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
          (note.seriesKey === "depreciationAndAmortization" ||
            note.seriesKey === "capitalExpenditure")),
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
