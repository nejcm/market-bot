import { DAY_MS } from "../../config/shared";
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
  EXTENSION_DISCONTINUED_INVESTING_PREFIX,
} from "../sec-segment-facts";
import { CAPEX_CALC_PREFIX, DA_CALC_PREFIX, DA_CALC_READ_KEY } from "../sec-calculation-linkbase";
import {
  EXTENSION_INVESTMENTS_SOURCE_INFIX,
  EXTENSION_SHORT_TERM_INVESTMENTS_PREFIX,
  EXTENSION_SHORT_TERM_INVESTMENTS_PROOF_PREFIX,
} from "../sec-extension-investments-proof";
import {
  CASH_FLOW_DEPRECIATION_AND_AMORTIZATION_LINES,
  DEPRECIATION_AND_AMORTIZATION_COMPONENTS,
  DISCONTINUED_OPERATIONS_CONCEPTS,
  NONCONTROLLING_INCOME_CONCEPTS,
  TOTAL_NONCONTROLLING_INCOME_CONCEPTS,
  DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE,
  FINANCIAL_STATEMENT_SERIES_DEFINITIONS,
  IFRS_DISCONTINUED_OPERATIONS_CONCEPTS,
  MIN_ANNUAL_DURATION_MONTHS,
  MAX_ANNUAL_DURATION_MONTHS,
  conceptScope,
  isContinuingScope,
  type FinancialStatementSeriesDefinition,
} from "./financial-statement-definitions";
import {
  capFinancialStatementPeriods,
  compareFinancialStatementFacts,
  restatedFromOriginalFiling,
  deriveFinancialStatementTtm,
  detectFinancialStatementCadence,
  financialStatementPeriodKey,
  financialStatementPeriodMonths,
  financialStatementFacts,
  incompleteFinancialStatementNotes,
  fiscalYearTtmSupersededAt,
  latestFinancialStatementFact,
  earlierShareBasisPeriods,
  touchesEarlierShareBasis,
  compareFinancialStatementRevisions,
} from "./financial-statement-selection";
import {
  type DebtFactReader,
  debtScopeUnprovenNotes,
  isUnprovenDebtNote,
  factsForDebt,
  withheldGrossPrincipalDebt,
} from "./sec-debt";
import {
  type FinancialStatementFact,
  ENTERPRISE_VALUE_BRIDGE_FACT_KEYS,
  type FinancialStatementEnterpriseValueBridge,
  type FinancialStatementEquityStack,
  type FinancialStatementNote,
  type FinancialStatementSeries,
  type FinancialStatementSeriesKey,
  type FinancialStatementSupersedingFact,
  type FinancialStatementsArtifact,
  type FinancialStatementTaxonomy,
  type OriginalFiling,
  ZERO_BORROWINGS_EXTRACTION_METHOD,
} from "./financial-statements-contract";
import {
  type ParsedFact,
  type SelectedSeries,
  type FinancialStatementsDeriveInput,
  TAXONOMIES,
  parseFact,
  taxonomyRoot,
  unitFacts,
  factsForLatestPeriodConcept,
  factsForDefinition,
  revenueConceptSwitchNotes,
  compositeFromContributors,
  withCompositeFirstPublicAt,
  type WithheldDerivation,
  isObservable,
  currencyForUnit,
  periodType,
  isStatementPeriod,
  periodKey,
  firstPublicDate,
  withFirstPublicAt,
  toSelectedFact,
  selectRestatements,
  chronological,
} from "./financial-statement-facts";
import {
  taxonomyScore,
  selectTaxonomy,
  selectReportingCurrency,
} from "./financial-statement-taxonomy";
import {
  firstAnnualReports,
  dividendPaymentFiled,
  unfiledSeries,
  supportedSixKFacts,
  structuredFinancialGaps,
} from "./financial-statement-filing-coverage";
import {
  withheldDerivationNotes,
  untaggedContinuingIncomeNotes,
  untaggedConsolidatedIncomeNotes,
  declarationSpanNotes,
  staleConceptHistoryNotes,
  instantSeriesOmissionNotes,
} from "./financial-statement-notes";

const EQUITY_INCLUDING_NONCONTROLLING_CONCEPT =
  "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest";
const MINORITY_INTEREST_CONCEPT = "MinorityInterest";
const GROSS_PROFIT_COST_CONCEPTS = ["CostOfRevenue", "CostOfGoodsAndServicesSold"];
const CONSOLIDATED_NET_INCOME_CONCEPT = "ProfitLoss";
const PRETAX_INCOME_COMPONENT_CONCEPTS = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesForeign",
] as const;
const STATUTORY_TAX_RATE_CONCEPT =
  "EffectiveIncomeTaxRateReconciliationAtFederalStatutoryIncomeTaxRate";
type EquityStackComponentKey =
  | "minorityInterest"
  | "stockholdersEquityIncludingNoncontrollingInterest"
  | "temporaryEquity";

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

// Accession -> D&A-like descendants of operating cash flow in that filing's calculation linkbase, with weights.
function depreciationCalculation(
  filings: readonly ExtendedEvidenceItem[],
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  return new Map(
    filings.flatMap(({ metrics }) =>
      metrics?.[DA_CALC_READ_KEY] === "true" || metrics?.[DA_CALC_READ_KEY] === "conflict"
        ? [
            [
              String(metrics.accessionNumber),
              new Map(
                Object.entries(metrics).flatMap(([key, value]) =>
                  key.startsWith(DA_CALC_PREFIX)
                    ? [[key.slice(DA_CALC_PREFIX.length), Number(value)] as const]
                    : [],
                ),
              ),
            ] as const,
          ]
        : [],
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
  const calculation = depreciationCalculation(filings);
  const calculationConflicts = new Set(
    filings.flatMap(({ metrics }) =>
      metrics?.[DA_CALC_READ_KEY] === "conflict" ? [String(metrics.accessionNumber)] : [],
    ),
  );
  const calculationFetchFailures = new Set(
    filings.flatMap(({ metrics }) =>
      metrics?.[DA_CALC_READ_KEY] === "fetch-failed" ? [String(metrics.accessionNumber)] : [],
    ),
  );
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
    const accession = String(selected[0]!.accessionNumber);
    const calcChildren = selected.every((fact) => String(fact.accessionNumber) === accession)
      ? calculation.get(accession)
      : undefined;
    // ORCL, ABBV, GLW, AMD FY2025: the cash-flow calculation adds exactly these two concepts into operating cash flow, so their sum is the face D&A.
    const calcProven =
      calcChildren?.size === 2 && selected.every((fact) => calcChildren.get(fact.concept) === 1);
    if (!calcProven) {
      const reason =
        calcChildren === undefined
          ? calculationFetchFailures.has(accession)
            ? `filing ${accession}'s calculation linkbase could not be fetched`
            : "no same-filing calculation linkbase was read"
          : calcChildren.size === 0 && calculationConflicts.has(accession)
            ? `filing ${accession}'s operating cash-flow calculation roles disagree`
            : `filing ${accession}'s cash-flow calculation adds ${[...calcChildren.keys()].join(", ") || "no D&A line"} into operating cash flow`;
      const [first] = selected;
      notes.push({
        code: "unchecked-component-sum",
        seriesKey: definition.key,
        periodKey: periodKey(first!),
        message: `SEC depreciation and amortization for ${String(first!.periodStart)} to ${first!.periodEnd} is ${facePair !== undefined ? "cash-flow OtherDepreciationAndAmortization + AdjustmentForAmortization" : selected === contributors ? "depreciation + intangible amortization" : "depreciation + cash-flow AdjustmentForAmortization"}, not checked against the filed cash-flow statement: ${reason}`,
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

interface DerivedSeriesFacts {
  readonly facts: readonly ParsedFact[];
  readonly withheld: readonly WithheldDerivation[];
  readonly superseded?: ReadonlySet<string>;
  readonly notes?: readonly FinancialStatementNote[];
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
const DISCONTINUED_OPERATIONS_CASH_FLOW_REASON =
  "discontinued operations are reported for the period and no continuing-operations operating cash flow is tagged";

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
        withheld.push(withheldPeriod(fact, DISCONTINUED_OPERATIONS_CASH_FLOW_REASON));
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

const IFRS_CONTINUING_OPERATING_CASH_FLOW_CONCEPT =
  "CashFlowsFromUsedInOperatingActivitiesContinuingOperations";

// IFRS 5.33(c): a period with discontinued operations, or a tagged continuing OCF that differs from total, takes
// That continuing OCF when it is as current as the total, else is withheld.
function discontinuedIfrsOperatingCashFlow(
  payload: unknown,
  definition: FinancialStatementSeriesDefinition,
  reported: readonly ParsedFact[],
  eligible: (fact: ParsedFact) => boolean,
): DerivedSeriesFacts | undefined {
  const root = taxonomyRoot(payload, "ifrs-full");
  if (definition.key !== "operatingCashFlow" || root === undefined) {
    return undefined;
  }
  const discontinued = new Set(
    [...IFRS_DISCONTINUED_OPERATIONS_CONCEPTS, ...DISCONTINUED_INVESTING_CONCEPTS["ifrs-full"]]
      .flatMap((concept) => unitFacts("ifrs-full", root, concept))
      .filter((fact) => eligible(fact) && fact.value !== 0)
      .map((fact) => periodKey(fact)),
  );
  const continuing = latestByPeriod(
    unitFacts("ifrs-full", root, IFRS_CONTINUING_OPERATING_CASH_FLOW_CONCEPT).filter(eligible),
  );
  const totals = latestByPeriod(reported.filter(eligible));
  const scoped = [...new Set([...totals.keys(), ...continuing.keys()])].filter(
    (key) =>
      discontinued.has(key) ||
      (continuing.has(key) &&
        totals.has(key) &&
        continuing.get(key)!.value !== totals.get(key)!.value),
  );
  const current = (key: string) => {
    const [flow, total] = [continuing.get(key), totals.get(key)];
    return flow !== undefined && (total === undefined || flow.filedAt >= total.filedAt);
  };
  return {
    facts: scoped.filter(current).map((key) => continuing.get(key)!),
    withheld: scoped
      .filter((key) => !current(key))
      .map((key) =>
        withheldPeriod(
          totals.get(key)!,
          continuing.has(key)
            ? "continuing-operations operating cash flow is older than the newest total for the period"
            : DISCONTINUED_OPERATIONS_CASH_FLOW_REASON,
        ),
      ),
    superseded: new Set(scoped),
  };
}

function latestByPeriod(facts: readonly ParsedFact[]): Map<string, ParsedFact> {
  const latest = new Map<string, ParsedFact>();
  for (const fact of facts) {
    const current = latest.get(periodKey(fact));
    if (current === undefined || compareFinancialStatementRevisions(fact, current) < 0) {
      latest.set(periodKey(fact), fact);
    }
  }
  return latest;
}

// Accession -> capex concepts its calculation linkbase subtracts inside the continuing-operations investing subtotal.
// Unioned per accession, so a proof-free item for the same filing (a debt face, say) never erases a proof.
function continuingInvestingCapex(
  filings: readonly ExtendedEvidenceItem[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const proven = new Map<string, Set<string>>();
  for (const { metrics } of filings) {
    for (const [key, weight] of Object.entries(metrics ?? {})) {
      if (key.startsWith(CAPEX_CALC_PREFIX) && weight === -1) {
        const accession = String(metrics!.accessionNumber);
        proven.set(
          accession,
          (proven.get(accession) ?? new Set()).add(key.slice(CAPEX_CALC_PREFIX.length)),
        );
      }
    }
  }
  return proven;
}

const DISCONTINUED_INVESTING_CONCEPTS: Readonly<
  Record<FinancialStatementTaxonomy, readonly string[]>
> = {
  "us-gaap": [
    "CapitalExpenditureDiscontinuedOperations",
    "CashProvidedByUsedInInvestingActivitiesDiscontinuedOperations",
  ],
  "ifrs-full": ["CashFlowsFromUsedInInvestingActivitiesDiscontinuedOperations"],
};

// Periods with a nonzero discontinued-operations capex or investing fact, tagged or issuer-extension, from any filing.
function discontinuedInvestingPeriods(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  observable: (fact: ParsedFact) => boolean,
  filings: readonly ExtendedEvidenceItem[],
): ReadonlySet<string> {
  const root = taxonomyRoot(payload, taxonomy);
  const tagged = (root === undefined ? [] : DISCONTINUED_INVESTING_CONCEPTS[taxonomy])
    .flatMap((concept) => unitFacts(taxonomy, root!, concept))
    .filter((fact) => observable(fact) && fact.value !== 0)
    .map((fact) => `${String(fact.periodStart)}|${fact.periodEnd}`);
  const extensions = filings.flatMap(({ metrics }) =>
    Object.entries(metrics ?? {}).flatMap(([key, value]) => {
      if (!key.startsWith(EXTENSION_DISCONTINUED_INVESTING_PREFIX) || value === 0) {
        return [];
      }
      const [, start, end] = key.slice(EXTENSION_DISCONTINUED_INVESTING_PREFIX.length).split("|");
      return [`${String(start)}|${String(end)}`];
    }),
  );
  return new Set([...tagged, ...extensions]);
}

// Beside continuing OCF: a linkbase-proven same-filing capex line is unqualified, discontinued investing evidence without that proof withholds, else the filed line carries a `capex-scope-unproven` note.
function scopeMatchedCapexFacts(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  reported: readonly ParsedFact[],
  eligible: (fact: ParsedFact) => boolean,
  observable: (fact: ParsedFact) => boolean,
  filings: readonly ExtendedEvidenceItem[],
): DerivedSeriesFacts {
  const operatingCashFlow = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    ({ key }) => key === "operatingCashFlow",
  );
  if (operatingCashFlow === undefined) {
    return NO_DERIVED_FACTS;
  }
  const flows =
    taxonomy === "us-gaap"
      ? scopeAlignedOperatingCashFlow(payload, operatingCashFlow, eligible).facts
      : (discontinuedIfrsOperatingCashFlow(
          payload,
          operatingCashFlow,
          factsForDefinition(payload, taxonomy, operatingCashFlow, eligible),
          eligible,
        )?.facts ?? []);
  const continuing = latestByPeriod(
    flows.filter((fact) => isContinuingScope(conceptScope(fact.concept))),
  );
  const proven = continuingInvestingCapex(filings);
  const gaapRoot = taxonomyRoot(payload, "us-gaap");
  // The linkbase arc binds only where the filing also tags the continuing subtotal for the same period.
  const subtotals = new Set(
    (gaapRoot === undefined
      ? []
      : unitFacts(
          "us-gaap",
          gaapRoot,
          "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations",
        )
    )
      .filter(eligible)
      .map((fact) => `${String(fact.accessionNumber)}|${periodKey(fact)}|${fact.unit}`),
  );
  const mixed = discontinuedInvestingPeriods(payload, taxonomy, observable, filings);
  const filed = latestByPeriod(
    reported.filter((fact) => eligible(fact) && continuing.has(periodKey(fact))),
  );
  const facts: ParsedFact[] = [];
  const withheld: WithheldDerivation[] = [];
  const notes: FinancialStatementNote[] = [];
  const superseded = new Set<string>();
  for (const [key, flow] of continuing) {
    const capex = reported.find(
      (fact) =>
        eligible(fact) &&
        periodKey(fact) === key &&
        fact.accessionNumber !== null &&
        fact.accessionNumber === flow.accessionNumber &&
        subtotals.has(`${fact.accessionNumber}|${key}|${fact.unit}`) &&
        proven.get(fact.accessionNumber)?.has(fact.concept) === true,
    );
    const latest = filed.get(key);
    if (capex !== undefined) {
      facts.push(capex);
      superseded.add(key);
    } else if (latest === undefined) {
      continue;
    } else if (mixed.has(`${String(latest.periodStart)}|${latest.periodEnd}`)) {
      superseded.add(key);
      withheld.push(
        withheldPeriod(
          latest,
          "operating cash flow is continuing operations, discontinued-operations investing cash flow is reported for the period, and no calculation linkbase places capital expenditure inside the continuing-operations investing subtotal",
        ),
      );
    } else {
      notes.push({
        code: "capex-scope-unproven",
        seriesKey: "capitalExpenditure",
        periodKey: key,
        message: `SEC capital expenditure for ${String(latest.periodStart)} to ${latest.periodEnd} is the filed line beside continuing-operations operating cash flow; no calculation linkbase proves it is continuing-operations only, and no discontinued-operations investing is reported for the period`,
      });
    }
  }
  return { facts, withheld, superseded, notes };
}

// A same-filing pair fills a period with no total, or restates one when its filing tags no total and is newer than every total.
function derivedPretaxIncomeFacts(
  payload: unknown,
  definition: FinancialStatementSeriesDefinition,
  reported: readonly ParsedFact[],
  eligible: (fact: ParsedFact) => boolean,
): DerivedSeriesFacts {
  const root = taxonomyRoot(payload, "us-gaap");
  if (root === undefined) {
    return NO_DERIVED_FACTS;
  }
  const totals = [
    ...reported,
    ...definition.concepts["us-gaap"].flatMap((concept) => unitFacts("us-gaap", root, concept)),
  ].filter(eligible);
  const totalsFor = (fact: ParsedFact) =>
    totals.filter((total) => periodKey(total) === periodKey(fact));
  const [domestic, foreign] = PRETAX_INCOME_COMPONENT_CONCEPTS.map((concept) =>
    unitFacts("us-gaap", root, concept).filter(
      (fact) => eligible(fact) && fact.periodStart !== undefined,
    ),
  ) as [ParsedFact[], ParsedFact[]];
  const pairs = domestic.flatMap((fact) => {
    const context = filingContextKey(fact);
    const partner = foreign.find((candidate) => filingContextKey(candidate) === context);
    return context === undefined ||
      partner === undefined ||
      totalsFor(fact).some((total) => total.accessionNumber === fact.accessionNumber)
      ? []
      : [{ ...fact, value: fact.value + partner.value }];
  });
  // Cached filings show D+F reconciling to whichever pretax total the filing tags, so a pair only stands in for the first concept.
  const [sumConcept] = definition.concepts["us-gaap"];
  const seriesConcept = reported[0]?.concept ?? sumConcept;
  const sumTotalsFor = (fact: ParsedFact) =>
    totalsFor(fact).filter((total) => total.concept === sumConcept);
  const restatesTotals = (fact: ParsedFact) =>
    seriesConcept === sumConcept &&
    pairs.some(
      (pair) =>
        periodKey(pair) === periodKey(fact) &&
        sumTotalsFor(fact).every((total) => compareFinancialStatementRevisions(pair, total) < 0),
    );
  const domesticGroups = periodGroups(domestic, definition);
  const foreignGroups = periodGroups(foreign, definition);
  const facts: ParsedFact[] = [];
  const withheld: WithheldDerivation[] = [];
  const superseded = new Set<string>();
  for (const [key, [current]] of domesticGroups) {
    const [currentForeign] = foreignGroups.get(key) ?? [];
    if (current === undefined) {
      continue;
    }
    const periodTotals = totalsFor(current);
    const periodPairs = pairs.filter((pair) => periodKey(pair) === periodKey(current));
    const history = [...periodTotals, ...periodPairs];
    if (periodTotals.length > 0 && !restatesTotals(current)) {
      const peers = reported.filter(
        (fact) => eligible(fact) && periodKey(fact) === periodKey(current),
      );
      const [standing] = peers.toSorted(compareFinancialStatementFacts);
      if (standing === undefined || periodPairs.length === 0) {
        continue;
      }
      superseded.add(periodKey(current));
      const restatedFrom = restatedFromOriginalFiling(standing.value, peers);
      facts.push({
        ...standing,
        firstPublicAt: firstPublicDate(standing.value, standing.filedAt, [history]),
        ...(restatedFrom === undefined ? {} : { restatedFrom }),
      });
      continue;
    }
    if (periodTotals.length > 0) {
      superseded.add(periodKey(current));
    }
    const context = filingContextKey(current);
    if (seriesConcept !== sumConcept) {
      withheld.push(
        withheldPeriod(
          current,
          `the series reports ${seriesConcept}, and domestic + foreign components are not proven to share its scope`,
        ),
      );
    } else if (currentForeign === undefined) {
      withheld.push(
        withheldPeriod(
          current,
          `no ${PRETAX_INCOME_COMPONENT_CONCEPTS[1]} fact is tagged for the period`,
        ),
      );
    } else if (context === undefined || context !== filingContextKey(currentForeign)) {
      withheld.push(
        withheldPeriod(
          current,
          "the current domestic and foreign pretax revisions do not share one filing, form, span, and unit",
        ),
      );
    } else {
      const composite = withCompositeFirstPublicAt(
        compositeFromContributors([current, currentForeign]),
        definition,
        [...domestic, ...foreign],
        new Set(),
      );
      if (periodTotals.length === 0) {
        facts.push(composite);
        continue;
      }
      const restatedFrom = restatedFromOriginalFiling(composite.value, [
        ...sumTotalsFor(current),
        composite,
      ]);
      facts.push({
        ...composite,
        firstPublicAt: firstPublicDate(composite.value, composite.filedAt, [
          [...sumTotalsFor(current), ...periodPairs],
        ]),
        ...(restatedFrom === undefined ? {} : { restatedFrom }),
      });
    }
  }
  for (const [key, [current]] of foreignGroups) {
    if (current !== undefined && !domesticGroups.has(key) && totalsFor(current).length === 0) {
      withheld.push(
        withheldPeriod(
          current,
          `no ${PRETAX_INCOME_COMPONENT_CONCEPTS[0]} fact is tagged for the period`,
        ),
      );
    }
  }
  const shown = new Set([...reported, ...facts].filter(eligible).map(periodKey));
  const seriesAnnualEnd = [...reported, ...facts]
    .filter((fact) => eligible(fact) && periodType(fact, definition) === "annual")
    .map((fact) => fact.periodEnd)
    .toSorted()
    .at(-1);
  for (const total of totals.filter((fact) => fact.concept !== seriesConcept)) {
    const key = periodKey(total);
    // StaleConceptHistoryNotes already declares alias annual periods past the series' last annual end.
    const staleNoted =
      periodType(total, definition) === "annual" &&
      (seriesAnnualEnd === undefined || total.periodEnd > seriesAnnualEnd);
    if (!shown.has(key) && !staleNoted && !withheld.some((period) => period.periodKey === key)) {
      withheld.push(
        withheldPeriod(
          total,
          `no ${seriesConcept} fact is tagged for the period, and its other pretax total differs in scope`,
        ),
      );
    }
  }
  return { facts, withheld, superseded };
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
  if (definition.key === "pretaxIncome") {
    return derivedPretaxIncomeFacts(payload, definition, reported, eligible);
  }
  if (definition.key === "netIncome") {
    return consolidatedNetIncomeFallbackFacts(payload, definition, reported, eligible, observable);
  }
  return undefined;
}

function expectedUnit(definition: FinancialStatementSeriesDefinition, currency: string): string {
  if (definition.unitKind === "shares") {
    return "shares";
  }
  return definition.unitKind === "per-share" ? `${currency}/shares` : currency;
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

// A short-term investments line the filing's own instance proves, dated by that filing's companyfacts AssetsCurrent.
// A proof companyfacts cannot confirm withholds its instant rather than letting it read as untagged 0.
function extensionShortTermInvestments(
  root: Record<string, unknown>,
  reportingCurrency: string,
  input: FinancialStatementsDeriveInput,
  tagged: readonly FinancialStatementFact[],
): readonly FinancialStatementFact[] {
  const definition = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    (candidate) => candidate.key === "stockholdersEquity",
  );
  if (definition === undefined) {
    return [];
  }
  const taggedPeriods = new Set(tagged.map(({ periodEnd }) => periodEnd));
  const observable = (concept: string) =>
    unitFacts("us-gaap", root, concept).filter(
      (fact) => fact.periodStart === undefined && isObservable(fact, input.analysisAsOf),
    );
  const assetsCurrent = observable("AssetsCurrent");
  const proved = (input.secFilings ?? []).flatMap(({ metrics, sourceIds }) =>
    Object.entries(metrics ?? {}).flatMap<FinancialStatementFact>(([key, value]) => {
      const [periodEnd = "", currency, concept = "", total] = key
        .slice(EXTENSION_SHORT_TERM_INVESTMENTS_PREFIX.length)
        .split("|");
      const proof = metrics?.[`${EXTENSION_SHORT_TERM_INVESTMENTS_PROOF_PREFIX}${periodEnd}`];
      if (
        !key.startsWith(EXTENSION_SHORT_TERM_INVESTMENTS_PREFIX) ||
        typeof value !== "number" ||
        typeof proof !== "string" ||
        taggedPeriods.has(periodEnd)
      ) {
        return [];
      }
      const accession = metrics?.accessionNumber;
      const filed = assetsCurrent.find(
        (fact) => fact.periodEnd === periodEnd && fact.accessionNumber === accession,
      );
      const withheld =
        currency !== reportingCurrency
          ? `the proof is in ${String(currency)}, not reporting currency ${reportingCurrency}`
          : filed === undefined
            ? `companyfacts carry no AssetsCurrent from ${String(accession)} at ${periodEnd} to confirm it`
            : filed.unit !== reportingCurrency || String(filed.value) !== total
              ? `companyfacts AssetsCurrent ${String(filed.value)} ${filed.unit} from ${String(accession)} does not match the instance total ${String(total)}`
              : undefined;
      const form = String(metrics?.form ?? "");
      const template =
        filed ??
        Object.keys(root)
          .flatMap(observable)
          .find((fact) => fact.periodEnd === periodEnd) ??
        parseFact(
          {
            val: value,
            form,
            accn: accession,
            filed: metrics?.filingDate,
            end: periodEnd,
            fp: form.startsWith("10-K") ? "FY" : "Q",
          },
          "us-gaap",
          concept,
          reportingCurrency,
        );
      if (template === undefined) {
        return [];
      }
      const filedAt =
        withheld === undefined || typeof metrics?.filingDate !== "string"
          ? template.filedAt
          : metrics.filingDate;
      return [
        {
          ...toSelectedFact(
            {
              ...template,
              ...(typeof accession === "string" ? { accessionNumber: accession } : {}),
              filedAt,
              firstPublicAt: filedAt,
              concept,
              value,
              unit: reportingCurrency,
              proofSourceIds: sourceIds.filter(
                (id, index) => index === 0 || id.includes(EXTENSION_INVESTMENTS_SOURCE_INFIX),
              ),
            },
            definition,
            reportingCurrency,
            input.sourceId,
          ),
          extractionMethod: ZERO_BORROWINGS_EXTRACTION_METHOD,
          ...(withheld === undefined
            ? { shortTermInvestmentsProof: proof }
            : {
                shortTermInvestmentsWithheld: `${concept} proven from the XBRL instance but withheld: ${withheld}`,
              }),
        },
      ];
    }),
  );
  // The latest filing wins an instant, dated from when its value first held (as compareFinancialStatementRevisions).
  const periods = new Map<string, FinancialStatementFact[]>();
  for (const fact of proved.toSorted((left, right) => left.filedAt.localeCompare(right.filedAt))) {
    periods.set(fact.periodEnd, [...(periods.get(fact.periodEnd) ?? []), fact]);
  }
  return [...periods.values()].map((facts) => {
    const latest = facts.at(-1)!;
    const same = (fact: FinancialStatementFact) =>
      fact.value === latest.value &&
      fact.shortTermInvestmentsWithheld === latest.shortTermInvestmentsWithheld;
    const changed = facts.findLastIndex((fact) => !same(fact));
    return { ...latest, firstPublicAt: facts[changed + 1]!.filedAt };
  });
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
  const selected = Object.fromEntries(
    ENTERPRISE_VALUE_BRIDGE_FACT_KEYS.map((key) => [key, select(key)]),
  ) as unknown as FinancialStatementEnterpriseValueBridge;
  return trimToMezzaninePeriods({
    ...selected,
    shortTermInvestments: [
      ...selected.shortTermInvestments,
      ...extensionShortTermInvestments(
        taxonomyRoot(payload, "us-gaap") ?? {},
        reportingCurrency,
        input,
        selected.shortTermInvestments,
      ),
    ].toSorted(chronological),
  });
}

function selectStatutoryTaxRate(
  payload: unknown,
  input: FinancialStatementsDeriveInput,
): readonly FinancialStatementFact[] {
  const root = taxonomyRoot(payload, "us-gaap");
  const definition = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    (candidate) => candidate.key === "incomeTaxExpense",
  )!;
  const annual = (
    root === undefined ? [] : unitFacts("us-gaap", root, STATUTORY_TAX_RATE_CONCEPT)
  ).filter(
    (fact) =>
      fact.unit === "pure" &&
      fact.periodStart !== undefined &&
      isObservable(fact, input.analysisAsOf) &&
      periodType(fact, definition) === "annual",
  );
  const byPeriod = new Map<string, ParsedFact[]>();
  for (const fact of annual) {
    byPeriod.set(periodKey(fact), [...(byPeriod.get(periodKey(fact)) ?? []), fact]);
  }
  return [...byPeriod.values()]
    .map((facts) => withFirstPublicAt(facts.toSorted(compareFinancialStatementFacts)[0]!, facts))
    .toSorted(chronological)
    .map((fact) => ({
      ...toSelectedFact(fact, definition, "", input.sourceId),
      currency: null,
    }));
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
      : definition.key === "capitalExpenditure"
        ? scopeMatchedCapexFacts(
            payload,
            taxonomy,
            reported,
            eligible,
            (fact) => isObservable(fact, input.analysisAsOf),
            input.secFilings ?? [],
          )
        : taxonomy === "us-gaap"
          ? derivedSeriesFacts(payload, definition, reported, eligible, (fact) =>
              isObservable(fact, input.analysisAsOf),
            )
          : discontinuedIfrsOperatingCashFlow(payload, definition, reported, eligible);
  const basis = [
    ...reported.filter((fact) => derived?.superseded?.has(periodKey(fact)) !== true),
    ...(derived?.facts ?? []),
  ];
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
        ...(derived?.notes ?? []),
        ...revenueConceptSwitchNotes(payload, taxonomy, definition, eligible),
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
  const withNotes = { ...withGross, omissionNotes: [...withGross.omissionNotes, ...debt.notes] };
  return {
    ...withNotes,
    omissionNotes: [
      ...withNotes.omissionNotes,
      ...debtScopeUnprovenNotes(debtReader, taxonomy, eligible, withNotes),
    ],
  };
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

function filedDurationFacts(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  analysisAsOf: string,
): readonly ParsedFact[] {
  const root = taxonomyRoot(payload, taxonomy);
  return root === undefined
    ? []
    : Object.keys(root)
        .flatMap((concept) => unitFacts(taxonomy, root, concept))
        .filter((fact) => fact.periodStart !== undefined && isObservable(fact, analysisAsOf))
        .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd));
}

const FISCAL_YEAR_BOUNDARY_DAYS = 10;

type FiscalYearFiling = Pick<FinancialStatementFact, "periodEnd" | "accessionNumber" | "amendment">;

// Only an original annual filing's own fact that cannot open the next fiscal year (a subsequent event) is exempt.
function isSubsequentEventFact(fact: ParsedFact, fiscalYear: FiscalYearFiling): boolean {
  return (
    fiscalYear.accessionNumber !== null &&
    fact.accessionNumber === fiscalYear.accessionNumber &&
    !fiscalYear.amendment &&
    !(
      (Date.parse(fact.periodStart!) - Date.parse(fiscalYear.periodEnd)) / DAY_MS <=
      FISCAL_YEAR_BOUNDARY_DAYS
    )
  );
}

// A later period tagged under any concept (e.g. a newer revenue tag) means the FY is no longer trailing.
function isSupersedingFact(fact: ParsedFact, fiscalYear: FiscalYearFiling): boolean {
  return fact.periodEnd > fiscalYear.periodEnd && !isSubsequentEventFact(fact, fiscalYear);
}

function factPublicAt(fact: ParsedFact): string {
  return fact.firstPublicAt ?? fact.filedAt;
}

function supersedingFact(fact: ParsedFact): FinancialStatementSupersedingFact {
  return {
    concept: fact.concept,
    periodStart: fact.periodStart!,
    periodEnd: fact.periodEnd,
    firstPublicAt: factPublicAt(fact),
    form: fact.form,
    accessionNumber: fact.accessionNumber,
  };
}

function supersedingDurationFacts(
  fiscalYear: FiscalYearFiling,
  durationFacts: readonly ParsedFact[],
): readonly FinancialStatementSupersedingFact[] {
  return durationFacts
    .filter((fact) => isSupersedingFact(fact, fiscalYear))
    .map((fact) => supersedingFact(fact));
}

function withoutSupersededFiscalYearTtm(
  series: FinancialStatementSeries,
  supersedingFacts: readonly FinancialStatementSupersedingFact[],
  analysisAsOf: string,
): { readonly series: FinancialStatementSeries; readonly note?: FinancialStatementNote } {
  const { ttm, ...rest } = series;
  const blocking = fiscalYearTtmSupersededAt(ttm, supersedingFacts, analysisAsOf);
  const seriesConcepts = new Set([...series.annual, ...series.interim].map((fact) => fact.concept));
  const named = blocking.findLast((fact) => seriesConcepts.has(fact.concept)) ?? blocking.at(-1);
  return named === undefined || ttm === undefined
    ? { series }
    : {
        series: rest,
        note: {
          code: "unreconciled-ttm",
          seriesKey: series.key,
          message: `The latest fiscal year ends ${ttm.periodEnd}, but ${named.concept} for ${named.periodStart} to ${named.periodEnd} is filed outside this series (${named.form} accession ${named.accessionNumber ?? "undisclosed"})`,
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
  const durationFacts =
    taxonomy === undefined ? [] : filedDurationFacts(payload, taxonomy, input.analysisAsOf);
  const annualConcepts = new Set(
    retained.flatMap(({ annual }) => annual.map(({ concept }) => concept)),
  );
  const filedFacts = new Map(
    durationFacts
      .filter((fact) => annualConcepts.has(fact.concept))
      .map((fact) => [
        `${fact.concept}|${periodKey(fact)}|${fact.filedAt}|${String(fact.value)}`,
        fact,
      ]),
  );
  // A re-filed year keeps a later comparative's accession; its subsequent events sit in the first filing.
  const firstPublicFiling = (fiscalYear: FinancialStatementFact) =>
    filedFacts.get(
      `${fiscalYear.concept}|${financialStatementPeriodKey(fiscalYear)}|${fiscalYear.firstPublicAt}|${String(fiscalYear.value)}`,
    ) ?? fiscalYear;
  const byFirstPublic = durationFacts.toSorted((left, right) =>
    factPublicAt(left) < factPublicAt(right)
      ? -1
      : Number(factPublicAt(left) > factPublicAt(right)),
  );
  // Per fiscal year only the earliest-public superseding fact decides eligibility at any cutoff.
  const earliestByFiscalYear = new Map<string, FinancialStatementSupersedingFact | undefined>();
  const earliestSupersedingFact = (fiscalYear: FinancialStatementFact) => {
    const filing = firstPublicFiling(fiscalYear);
    const key = `${filing.periodEnd}|${filing.accessionNumber}|${String(filing.amendment)}`;
    if (!earliestByFiscalYear.has(key)) {
      const first = byFirstPublic.find((fact) => isSupersedingFact(fact, filing));
      earliestByFiscalYear.set(key, first === undefined ? undefined : supersedingFact(first));
    }
    return earliestByFiscalYear.get(key);
  };
  const shareBasisTtm = retained.map((item) => {
    const shareBasis = withoutMixedShareBasisTtm(item, shareBasisNotes);
    const { ttm } = shareBasis.series;
    const checked =
      shareBasis.note === undefined && ttm?.formula === "FY"
        ? withoutSupersededFiscalYearTtm(
            shareBasis.series,
            supersedingDurationFacts(firstPublicFiling(ttm.components.fiscalYear), durationFacts),
            input.analysisAsOf,
          )
        : shareBasis;
    const earliest = [
      ...new Map(
        item.annual.flatMap((fiscalYear) => {
          const first = earliestSupersedingFact(fiscalYear);
          return first === undefined ? [] : [[JSON.stringify(first), first] as const];
        }),
      ).values(),
    ];
    return { ...checked, series: { ...checked.series, supersedingFacts: earliest } };
  });
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
      ? {
          enterpriseValueBridge: selectEnterpriseValueBridge(payload, reportingCurrency, input),
          statutoryTaxRate: selectStatutoryTaxRate(payload, input),
        }
      : {}),
    ...(taxonomy !== undefined
      ? {
          dividendPaymentFiled: dividendPaymentFiled(payload, taxonomy, input.analysisAsOf),
          unfiledSeries: unfiledSeries(payload, input.analysisAsOf),
          firstAnnualReports: firstAnnualReports(payload, input.analysisAsOf),
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
    omissionNotes: withRetainedDebtScopeNotes(
      statements.balanceSheet.debt,
      withinRetainedWindow(series, [
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
    ),
    structuredFinancialGaps: structuredFinancialGaps(
      taxonomy,
      reportingCurrency,
      supportedSixKFacts(payload, input.analysisAsOf),
      currentAnnual,
      input,
    ),
  };
}

// A scope note stands only on a published debt fact filed before the recast.
function withRetainedDebtScopeNotes(
  debt: FinancialStatementSeries,
  notes: readonly FinancialStatementNote[],
): readonly FinancialStatementNote[] {
  const facts = financialStatementFacts(debt);
  return notes.filter(
    (note) =>
      note.code !== "debt-scope-unproven" || facts.some((fact) => isUnprovenDebtNote(note, fact)),
  );
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
