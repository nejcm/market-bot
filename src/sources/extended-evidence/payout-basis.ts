import { COMMON_DIVIDENDS_PAID_CONCEPTS } from "./financial-statement-definitions";
import {
  financialStatementFacts,
  financialStatementSeriesByKey,
  latestFinancialStatementFact,
} from "./financial-statement-selection";
import type {
  FinancialStatementFact,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";

export const PAYOUT_CEILING = 0.8;

// "bounded": generic dividends beside NCI earnings, so the same-scope ratio lies between the parent and consolidated bases.
export type PayoutScope =
  | { readonly status: "same"; readonly consolidated?: FinancialStatementFact }
  | { readonly status: "withheld"; readonly reason: string }
  | { readonly status: "bounded"; readonly consolidated: FinancialStatementFact };

export function payoutScopeAmbiguity(dividendsConcept: string): string {
  return `noncontrolling interests earned income and ${dividendsConcept} can include distributions to them; dividends and parent net income are not proven to share one scope`;
}

// Payout divides by parent net income, so the dividend total must not carry NCI distributions (Accounting Scope).
export function payoutScope(
  artifact: FinancialStatementsArtifact,
  dividends: FinancialStatementFact,
  income: FinancialStatementFact,
): PayoutScope {
  // US GAAP netIncome is NetIncomeLoss, or ProfitLoss only where no NCI income was proven; IFRS ProfitLoss includes NCI.
  if (income.taxonomy !== "us-gaap") {
    return {
      status: "withheld",
      reason: `net income is IFRS ${income.concept}, which includes noncontrolling interests; profit attributable to the parent is not in the statements`,
    };
  }
  if (COMMON_DIVIDENDS_PAID_CONCEPTS.has(dividends.concept)) {
    return { status: "same" };
  }
  const series = financialStatementSeriesByKey(artifact, "consolidatedNetIncome");
  const consolidated = latestFinancialStatementFact(
    (series === undefined ? [] : financialStatementFacts(series)).filter(
      (fact) => fact.periodKey === income.periodKey,
    ),
  );
  if (consolidated !== undefined) {
    return consolidated.value === income.value
      ? { status: "same", consolidated }
      : { status: "bounded", consolidated };
  }
  return artifact.validationNotes.some(
    (note) => note.seriesKey === "consolidatedNetIncome" && note.periodKey === income.periodKey,
  )
    ? { status: "withheld", reason: payoutScopeAmbiguity(dividends.concept) }
    : { status: "same" };
}

interface PayoutRow {
  readonly id?: string;
  readonly status?: string;
  readonly cause?: string;
  readonly periodEnd?: string;
  readonly periodMonths?: number;
}

// The latest-year payout decides the check only for an issuer with under 3 filed fiscal years, and only as that annual year.
export function payoutFallbackApplies(rows: readonly PayoutRow[]): boolean {
  const cumulative = rows.find((row) => row.id === "payoutRatio3y");
  const latest = rows.find((row) => row.id === "payoutRatio");
  return (
    cumulative?.status === "missing" &&
    cumulative.cause === "insufficient-history" &&
    latest?.status === "value" &&
    latest.periodMonths === 12 &&
    latest.periodEnd === cumulative.periodEnd
  );
}
