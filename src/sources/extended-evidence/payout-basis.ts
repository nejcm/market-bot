import {
  COMMON_DIVIDENDS_PAID_CONCEPTS,
  FINANCIAL_STATEMENT_SERIES_DEFINITIONS,
} from "./financial-statement-definitions";
import {
  financialStatementFacts,
  financialStatementSeriesByKey,
} from "./financial-statement-selection";
import type {
  FinancialStatementFact,
  FinancialStatementNote,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";

export const PAYOUT_CEILING = 0.8;

const ALL_PARENT_CLASSES_BASIS = "dividends paid cover all parent equity classes, as filed";

interface FiscalYear {
  readonly periodStart: string;
  readonly periodEnd: string;
}

// The years an annual report was filed for, independent of which payout inputs survived normalization.
export function annualFilingCalendar(
  artifact: FinancialStatementsArtifact,
  cutoff: string,
): readonly FiscalYear[] {
  const day = cutoff.slice(0, 10);
  const filed =
    artifact.firstAnnualReports ??
    FINANCIAL_STATEMENT_SERIES_DEFINITIONS.flatMap(({ key }) => {
      const series = financialStatementSeriesByKey(artifact, key);
      return (series === undefined ? [] : financialStatementFacts(series)).flatMap((fact) =>
        fact.periodType === "annual" && fact.periodStart !== undefined
          ? [{ periodStart: fact.periodStart, periodEnd: fact.periodEnd, filedAt: fact.filedAt }]
          : [],
      );
    });
  const byEnd = new Map(
    filed
      .filter((report) => report.filedAt.slice(0, 10) <= day)
      .map((report) => [
        report.periodEnd,
        { periodStart: report.periodStart, periodEnd: report.periodEnd },
      ]),
  );
  return [...byEnd.values()].toSorted((left, right) =>
    left.periodEnd.localeCompare(right.periodEnd),
  );
}

const NONCONTROLLING_NOTE_SERIES = new Set([
  "consolidatedNetIncome",
  "consolidatedContinuingIncome",
]);

function noteEnds(note: FinancialStatementNote): readonly string[] {
  return [
    ...(note.periodKey === undefined ? [] : [note.periodKey.split("|").at(-1) ?? ""]),
    ...(note.periods ?? []).map((period) => period.end),
  ];
}

function noncontrollingReported(
  artifact: FinancialStatementsArtifact,
  start: string,
  end: string,
): boolean {
  const within = (date: string) => date >= start && date <= end;
  const facts = (key: "netIncome" | "consolidatedNetIncome") => {
    const series = financialStatementSeriesByKey(artifact, key);
    return series === undefined ? [] : financialStatementFacts(series);
  };
  const parent = new Map(facts("netIncome").map((fact) => [fact.periodKey, fact.value]));
  const income = facts("consolidatedNetIncome").some(
    (fact) =>
      within(fact.periodEnd) &&
      parent.has(fact.periodKey) &&
      parent.get(fact.periodKey) !== fact.value,
  );
  const withheld = [...artifact.validationNotes, ...artifact.omissionNotes].some(
    (note) =>
      note.code === "withheld-derivation" &&
      note.seriesKey !== undefined &&
      NONCONTROLLING_NOTE_SERIES.has(note.seriesKey) &&
      noteEnds(note).some(within),
  );
  const equity = [
    ...(artifact.equityStack?.minorityInterest ?? []),
    ...(artifact.enterpriseValueBridge?.noncontrollingInterest ?? []),
  ].some((fact) => fact.value !== 0 && within(fact.periodEnd));
  return income || withheld || equity;
}

// Dividends are parent-scope only when filed by holder class or when the issuer reports no NCI in the span (Accounting Scope).
export function payoutScopeReason(
  artifact: FinancialStatementsArtifact,
  years: readonly {
    readonly dividend: FinancialStatementFact;
    readonly income: FinancialStatementFact;
  }[],
  span: FiscalYear,
): string | undefined {
  const ifrs = years.find(({ income }) => income.taxonomy !== "us-gaap");
  if (ifrs !== undefined) {
    return `net income is IFRS ${ifrs.income.concept}, which includes noncontrolling interests; profit attributable to the parent is not in the statements`;
  }
  const total = years.find(({ dividend }) => !COMMON_DIVIDENDS_PAID_CONCEPTS.has(dividend.concept));
  return total !== undefined && noncontrollingReported(artifact, span.periodStart, span.periodEnd)
    ? `${total.dividend.concept} is a dividend total that may include distributions to noncontrolling interests, which the issuer reports; the parent-scope amount is not proven`
    : undefined;
}

export function dividendClassBasis(
  dividends: readonly FinancialStatementFact[],
): string | undefined {
  return dividends.some((fact) => !COMMON_DIVIDENDS_PAID_CONCEPTS.has(fact.concept))
    ? ALL_PARENT_CLASSES_BASIS
    : undefined;
}
