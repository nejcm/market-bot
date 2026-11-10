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
