import { FINANCIAL_STATEMENT_SERIES_DEFINITIONS } from "./financial-statement-definitions";
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

export const ALL_PARENT_CLASSES_BASIS = "dividends paid cover all parent equity classes, as filed";

const TOTAL_DIVIDENDS_PAID_CONCEPTS: ReadonlySet<string> = new Set([
  "PaymentsOfDividends",
  "PaymentsForDividends",
  "DividendsPaid",
]);

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

const byPeriod = (fact: FinancialStatementFact) => fact.periodKey;
const byInstant = (fact: FinancialStatementFact) => fact.periodEnd;

// Two filed figures for one period that differ by the NCI share.
function divergent(
  parent: readonly FinancialStatementFact[],
  consolidated: readonly FinancialStatementFact[],
  sameAs: (fact: FinancialStatementFact) => string,
  within: (date: string) => boolean,
): boolean {
  const values = new Map(parent.map((fact) => [sameAs(fact), fact.value]));
  return consolidated.some(
    (fact) =>
      within(fact.periodEnd) && values.has(sameAs(fact)) && values.get(sameAs(fact)) !== fact.value,
  );
}

function noncontrollingReported(
  artifact: FinancialStatementsArtifact,
  start: string,
  end: string,
): boolean {
  const within = (date: string) => date >= start && date <= end;
  const facts = (
    key:
      | "netIncome"
      | "consolidatedNetIncome"
      | "continuingIncome"
      | "consolidatedContinuingIncome",
  ) => {
    const series = financialStatementSeriesByKey(artifact, key);
    return series === undefined ? [] : financialStatementFacts(series);
  };
  const stack = artifact.equityStack;
  const income =
    divergent(facts("netIncome"), facts("consolidatedNetIncome"), byPeriod, within) ||
    divergent(facts("continuingIncome"), facts("consolidatedContinuingIncome"), byPeriod, within);
  const withheld = [...artifact.validationNotes, ...artifact.omissionNotes].some(
    (note) =>
      note.code === "withheld-derivation" &&
      note.seriesKey !== undefined &&
      NONCONTROLLING_NOTE_SERIES.has(note.seriesKey) &&
      noteEnds(note).some(within),
  );
  const equity =
    [
      ...(stack?.minorityInterest ?? []),
      ...(artifact.enterpriseValueBridge?.noncontrollingInterest ?? []),
      ...[
        ...(stack?.temporaryEquity ?? []),
        ...(artifact.enterpriseValueBridge?.temporaryEquity ?? []),
      ].filter((fact) => fact.concept.startsWith("RedeemableNoncontrollingInterest")),
    ].some((fact) => fact.value !== 0 && within(fact.periodEnd)) ||
    divergent(
      stack?.stockholdersEquity ?? [],
      stack?.stockholdersEquityIncludingNoncontrollingInterest ?? [],
      byInstant,
      within,
    );
  return income || withheld || equity;
}

// Dividends are parent scope only as a filed total from an issuer that reports no NCI in the span (Accounting Scope).
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
  // A class-tagged series can be the elected component of a larger filed total (TDG FY2025: 159M common vs 9,629M).
  const component = years.find(
    ({ dividend }) => !TOTAL_DIVIDENDS_PAID_CONCEPTS.has(dividend.concept),
  );
  if (component !== undefined) {
    return `dividends are filed only by holder class (${component.dividend.concept}); total distributions are not proven`;
  }
  return noncontrollingReported(artifact, span.periodStart, span.periodEnd)
    ? `${years[0]!.dividend.concept} is a dividend total that may include distributions to noncontrolling interests, which the issuer reports; the parent-scope amount is not proven`
    : undefined;
}
