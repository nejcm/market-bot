import type { MarketSnapshot } from "../domain/market-data";
import type {
  FinancialStatementsArtifact,
  FinancialStatementTtm,
} from "../sources/extended-evidence/financial-statements-contract";
import {
  fiscalYearTtmLabel,
  latestFiscalYearTrailingBasis,
} from "../sources/extended-evidence/financial-statement-selection";

export interface EquityReaderEarningsBasis {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

function eps(value: number): string {
  return value.toFixed(2);
}

function comparison(
  providerEps: number,
  quoteCurrency: string | undefined,
  filingCurrency: string,
  filed: readonly (readonly [string, string, FinancialStatementTtm])[],
): string {
  if (quoteCurrency !== filingCurrency) {
    return `The provider quote currency (${quoteCurrency ?? "undisclosed"}) differs from the ${filingCurrency} filing currency, so the values are not compared.`;
  }
  const matched = filed.find((entry) => eps(entry[2].value) === eps(providerEps));
  if (matched !== undefined) {
    return `The provider value matches the SEC ${matched[0]} value at two decimals.`;
  }
  return `The provider value matches ${filed.length === 1 ? "no SEC value" : "neither SEC value"} at two decimals, and the supplied evidence does not reconcile the difference.`;
}

function fiscalYearClause(ttm: FinancialStatementTtm): string {
  return ttm.formula === "FY" ? ` (${fiscalYearTtmLabel(ttm.components.fiscalYear)})` : "";
}

// Yahoo does not state the accounting scope or period behind its trailing EPS, so both observations stay side by side.
export function earningsBasis(
  marketSnapshot: MarketSnapshot | undefined,
  financialStatements: FinancialStatementsArtifact | undefined,
): EquityReaderEarningsBasis | undefined {
  const providerEps = marketSnapshot?.fundamentals?.epsTrailingTwelveMonths;
  if (marketSnapshot === undefined || providerEps === undefined || !Number.isFinite(providerEps)) {
    return undefined;
  }
  const provider = `Provider trailing EPS ${eps(providerEps)} (Yahoo; accounting scope and period basis undisclosed).`;
  const perShare = financialStatements?.statements.perShare;
  const total = perShare?.dilutedEps.ttm;
  const continuing = perShare?.continuingDilutedEps.ttm;
  const filed: readonly (readonly [string, string, FinancialStatementTtm])[] = [
    ...(total === undefined
      ? []
      : [
          [
            continuing === undefined ? "diluted EPS TTM" : "total-operations",
            `SEC diluted EPS TTM ${eps(total.value)} ${total.currency} through ${total.periodEnd}${fiscalYearClause(total)}${continuing === undefined ? "" : " (total operations)"}`,
            total,
          ] as const,
        ]),
    ...(continuing === undefined
      ? []
      : [
          [
            "continuing-operations",
            `SEC diluted EPS TTM from continuing operations ${eps(continuing.value)} ${continuing.currency} through ${continuing.periodEnd}${fiscalYearClause(continuing)}`,
            continuing,
          ] as const,
        ]),
  ];
  const [first] = filed;
  if (financialStatements === undefined || first === undefined) {
    const fiscalYearBasis = latestFiscalYearTrailingBasis(
      financialStatements?.statements.incomeStatement.revenue,
    );
    return fiscalYearBasis === undefined || financialStatements === undefined
      ? {
          text: `${provider} No SEC diluted EPS TTM is available to compare.`,
          sourceIds: [marketSnapshot.sourceId],
        }
      : {
          text: `${provider} No SEC diluted EPS TTM is available to compare. ${fiscalYearBasis}`,
          sourceIds: [marketSnapshot.sourceId, financialStatements.sourceId],
        };
  }
  const added = filed.filter(([, , ttm]) => ttm.formula !== "FY").length;
  const approximation =
    added === 0
      ? ""
      : ` ${added === 1 ? `The ${filed.length === 1 ? "" : "interim-derived "}SEC value is an approximation that adds` : "Both SEC values are approximations that add"} per-share periods without reweighting diluted shares.`;
  const sec = `${filed.map(([, clause]) => `${clause}.`).join(" ")}${approximation}`;
  return {
    text: `${provider} ${sec} ${comparison(providerEps, marketSnapshot.identity?.quoteCurrency, first[2].currency, filed)}`,
    sourceIds: [marketSnapshot.sourceId, financialStatements.sourceId],
  };
}
