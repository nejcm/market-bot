import { isRecord, readNumber } from "../../guards";
import {
  CASH_FLOW_DEPRECIATION_AND_AMORTIZATION_LINES,
  DEPRECIATION_AND_AMORTIZATION_COMPONENTS,
  FINANCIAL_STATEMENT_SERIES_DEFINITIONS,
  MIN_ANNUAL_DURATION_MONTHS,
  MAX_ANNUAL_DURATION_MONTHS,
  isDebtPresenceConcept,
} from "./financial-statement-definitions";
import { financialStatementPeriodMonths } from "./financial-statement-selection";
import {
  canonicalizeSecForm,
  isAnnualReportForm,
  isCalendarDate,
  type FinancialStatementFact,
  type FinancialStatementSeriesKey,
  type FinancialStatementTaxonomy,
  type FirstAnnualReport,
  type StructuredFinancialGap,
} from "./financial-statements-contract";
import {
  type ParsedFact,
  type FinancialStatementsDeriveInput,
  TAXONOMIES,
  taxonomyRoot,
  unitFacts,
  allFactsForDefinition,
  rawConceptRows,
  isObservable,
  periodKey,
} from "./financial-statement-facts";
import { ELECTING_DEFINITIONS } from "./financial-statement-taxonomy";

interface SubmissionFiling {
  readonly form: "6-K" | "6-K/A";
  readonly filedAt: string;
  readonly accessionNumber?: string;
  readonly reportDate?: string;
}

// Taxonomy switches and restatements re-file a period later, so no selected fact can date its first report;
// A duration ending after its filing date is forward-looking (CLSK, LLY), not that period's report.
export function firstAnnualReports(
  payload: unknown,
  analysisAsOf: string,
): readonly FirstAnnualReport[] {
  const earliest = new Map<string, FirstAnnualReport>();
  for (const taxonomy of TAXONOMIES) {
    const root = taxonomyRoot(payload, taxonomy) ?? {};
    for (const fact of Object.keys(root).flatMap((concept) => unitFacts(taxonomy, root, concept))) {
      const months = financialStatementPeriodMonths(fact);
      const key = periodKey(fact);
      const current = earliest.get(key);
      if (
        isAnnualReportForm(fact.canonicalForm) &&
        isObservable(fact, analysisAsOf) &&
        [fact.periodStart ?? "", fact.periodEnd, fact.filedAt].every(isCalendarDate) &&
        fact.periodEnd < fact.filedAt &&
        months !== undefined &&
        months >= MIN_ANNUAL_DURATION_MONTHS &&
        months <= MAX_ANNUAL_DURATION_MONTHS &&
        (current === undefined || fact.filedAt < current.filedAt)
      ) {
        earliest.set(key, {
          periodStart: fact.periodStart!,
          periodEnd: fact.periodEnd,
          filedAt: fact.filedAt,
          accessionNumber: fact.accessionNumber,
          form: fact.form,
        });
      }
    }
  }
  return [...earliest.values()].toSorted(
    (left, right) =>
      left.periodEnd.localeCompare(right.periodEnd) ||
      left.periodStart.localeCompare(right.periodStart),
  );
}

// Span filtering, alias ranking and caps must not manufacture a non-payer.
export function dividendPaymentFiled(
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
export function unfiledSeries(
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

export function supportedSixKFacts(payload: unknown, analysisAsOf: string): readonly ParsedFact[] {
  return TAXONOMIES.flatMap((taxonomy) =>
    ELECTING_DEFINITIONS.flatMap((definition) =>
      allFactsForDefinition(payload, taxonomy, definition),
    ),
  ).filter((fact) => fact.canonicalForm === "6-K" && isObservable(fact, analysisAsOf));
}

export function structuredFinancialGaps(
  taxonomy: FinancialStatementTaxonomy | undefined,
  election: { readonly currency: string | undefined; readonly candidates: readonly string[] },
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
  if (taxonomy !== undefined && election.currency === undefined && election.candidates.length > 1) {
    gaps.push({
      code: "ambiguous-reporting-currency",
      message: `Standard monetary facts are filed in ${election.candidates.join(", ")}; the filed facts do not establish which is the reporting currency`,
      forms: [],
      sourceIds: [input.sourceId],
    });
  } else if (taxonomy !== undefined && election.currency === undefined) {
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
