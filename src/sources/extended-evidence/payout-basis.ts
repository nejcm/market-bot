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

function noncontrollingIncome(
  artifact: FinancialStatementsArtifact,
  income: FinancialStatementFact,
): boolean {
  const series = financialStatementSeriesByKey(artifact, "consolidatedNetIncome");
  const consolidated = latestFinancialStatementFact(
    (series === undefined ? [] : financialStatementFacts(series)).filter(
      (fact) => fact.periodKey === income.periodKey,
    ),
  );
  if (consolidated !== undefined) {
    return consolidated.value !== income.value;
  }
  return artifact.validationNotes.some(
    (note) => note.seriesKey === "consolidatedNetIncome" && note.periodKey === income.periodKey,
  );
}

// Payout divides by parent net income, so the dividend total must not carry NCI distributions (Accounting Scope).
export function payoutScopeReason(
  artifact: FinancialStatementsArtifact,
  dividends: FinancialStatementFact,
  income: FinancialStatementFact,
): string | undefined {
  // US GAAP netIncome is NetIncomeLoss, or ProfitLoss only where no NCI income was proven; IFRS ProfitLoss includes NCI.
  if (income.taxonomy !== "us-gaap") {
    return `net income is IFRS ${income.concept}, which includes noncontrolling interests; profit attributable to the parent is not in the statements`;
  }
  if (
    COMMON_DIVIDENDS_PAID_CONCEPTS.has(dividends.concept) ||
    !noncontrollingIncome(artifact, income)
  ) {
    return undefined;
  }
  return `noncontrolling interests earned income and ${dividends.concept} can include distributions to them; dividends and parent net income are not proven to share one scope`;
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
