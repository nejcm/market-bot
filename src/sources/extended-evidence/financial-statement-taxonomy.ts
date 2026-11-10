import {
  CAP_FOLLOWER_SERIES,
  FINANCIAL_STATEMENT_SERIES_DEFINITIONS,
} from "./financial-statement-definitions";
import {
  isAnnualReportForm,
  type FinancialStatementTaxonomy,
} from "./financial-statements-contract";
import {
  type ParsedFact,
  TAXONOMIES,
  allFactsForDefinition,
  isObservable,
  currencyForUnit,
  periodType,
} from "./financial-statement-facts";

export const ELECTING_DEFINITIONS = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.filter(
  (definition) => !CAP_FOLLOWER_SERIES.has(definition.key),
);

export function taxonomyScore(
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

export function selectTaxonomy(
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

export function selectReportingCurrency(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  analysisAsOf: string,
): { readonly currency: string | undefined; readonly candidates: readonly string[] } {
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
  const candidates = [
    ...new Set(pool.flatMap((fact) => currencyForUnit(fact.unit) ?? [])),
  ].toSorted();
  if (candidates.length <= 1) {
    return { currency: candidates[0], candidates };
  }
  const annual = revenueFacts.filter(
    (fact) => periodType(fact, revenue) === "annual" && currencyForUnit(fact.unit) !== undefined,
  );
  const latestEnd = annual
    .map((fact) => fact.periodEnd)
    .toSorted()
    .at(-1);
  const latestFilings = new Set(
    annual.filter((fact) => fact.periodEnd === latestEnd).map((fact) => filingOf(fact)),
  );
  const named = [...latestFilings].map((filing) =>
    namedCurrency(annual.filter((fact) => filingOf(fact) === filing)),
  );
  const [elected] = named;
  return {
    currency:
      elected !== undefined && named.every((name) => name === elected) ? elected : undefined,
    candidates,
  };
}

function filingOf(fact: ParsedFact): string {
  return fact.accessionNumber ?? fact.filedAt;
}

// The currency whose literal annual periods strictly contain every other currency's in one filing.
function namedCurrency(filingFacts: readonly ParsedFact[]): string | undefined {
  const periods = new Map<string, Set<string>>();
  for (const fact of filingFacts) {
    const currency = currencyForUnit(fact.unit) ?? "";
    periods.set(
      currency,
      (periods.get(currency) ?? new Set()).add(`${fact.periodStart ?? ""}|${fact.periodEnd}`),
    );
  }
  const entries = [...periods.entries()];
  return entries.find(([, own]) =>
    entries.every(
      ([, other]) =>
        own === other || (other.size < own.size && [...other].every((key) => own.has(key))),
    ),
  )?.[0];
}
