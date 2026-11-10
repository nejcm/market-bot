import {
  NONCONTROLLING_INCOME_CONCEPTS,
  TOTAL_NONCONTROLLING_INCOME_CONCEPTS,
  FINANCIAL_STATEMENT_SERIES_DEFINITIONS,
  type FinancialStatementSeriesDefinition,
} from "./financial-statement-definitions";
import {
  compareFinancialStatementFacts,
  restatedFromOriginalFiling,
  compareFinancialStatementRevisions,
} from "./financial-statement-selection";
import { type FinancialStatementNote } from "./financial-statements-contract";
import {
  type ParsedFact,
  taxonomyRoot,
  unitFacts,
  factsForLatestPeriodConcept,
  factsForDefinition,
  compositeFromContributors,
  withCompositeFirstPublicAt,
  type WithheldDerivation,
  periodType,
  periodKey,
  firstPublicDate,
} from "./financial-statement-facts";

const GROSS_PROFIT_COST_CONCEPTS = ["CostOfRevenue", "CostOfGoodsAndServicesSold"];
const CONSOLIDATED_NET_INCOME_CONCEPT = "ProfitLoss";
const PRETAX_INCOME_COMPONENT_CONCEPTS = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesForeign",
] as const;

export interface DerivedSeriesFacts {
  readonly facts: readonly ParsedFact[];
  readonly withheld: readonly WithheldDerivation[];
  readonly superseded?: ReadonlySet<string>;
  readonly notes?: readonly FinancialStatementNote[];
}

export const NO_DERIVED_FACTS: DerivedSeriesFacts = { facts: [], withheld: [] };

export function filingContextKey(fact: ParsedFact): string | undefined {
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

export function withheldPeriod(fact: ParsedFact, reason: string): WithheldDerivation {
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

export function derivedSeriesFacts(
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
