import { DAY_MS } from "../../config/shared";
import { fiscalYearTtmSupersededAt } from "./financial-statement-selection";
import {
  type FinancialStatementFact,
  type FinancialStatementNote,
  type FinancialStatementSeries,
  type FinancialStatementSupersedingFact,
  type FinancialStatementTaxonomy,
} from "./financial-statements-contract";
import {
  type ParsedFact,
  taxonomyRoot,
  unitFacts,
  isObservable,
} from "./financial-statement-facts";

export function filedDurationFacts(
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
// A period not yet ended when filed (a forward schedule) cannot prove a later period is public.
export function isSupersedingFact(fact: ParsedFact, fiscalYear: FiscalYearFiling): boolean {
  return (
    fact.periodEnd > fiscalYear.periodEnd &&
    fact.periodEnd < factPublicAt(fact) &&
    !isSubsequentEventFact(fact, fiscalYear)
  );
}

export function factPublicAt(fact: ParsedFact): string {
  return fact.firstPublicAt ?? fact.filedAt;
}

export function supersedingFact(fact: ParsedFact): FinancialStatementSupersedingFact {
  return {
    concept: fact.concept,
    periodStart: fact.periodStart!,
    periodEnd: fact.periodEnd,
    firstPublicAt: factPublicAt(fact),
    form: fact.form,
    accessionNumber: fact.accessionNumber,
  };
}

export function supersedingDurationFacts(
  fiscalYear: FiscalYearFiling,
  durationFacts: readonly ParsedFact[],
): readonly FinancialStatementSupersedingFact[] {
  return durationFacts
    .filter((fact) => isSupersedingFact(fact, fiscalYear))
    .map((fact) => supersedingFact(fact));
}

export function withoutSupersededFiscalYearTtm(
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
