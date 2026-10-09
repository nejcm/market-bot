import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementTtm,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";
import {
  conceptScope,
  FINANCIAL_STATEMENT_SERIES_DEFINITIONS,
  scopedLabel,
  TOTAL_OPERATIONS_SCOPE,
} from "./financial-statement-definitions";
import {
  deriveFinancialStatementTtm,
  financialStatementFactForPeriod,
  financialStatementFacts,
  financialStatementTtmsAreCompatible,
  financialStatementTtmsSharePeriod,
  latestFinancialStatementFact,
} from "./financial-statement-selection";
import type {
  ValuationFundamentalInput,
  ValuationObservationBasis,
} from "./valuation-workbench-contract";

export interface ValuationPeriodInputs {
  readonly basis: ValuationObservationBasis;
  readonly periodEnd: string;
  readonly revenue?: ValuationFundamentalInput;
  readonly netIncome?: ValuationFundamentalInput;
  readonly dilutedEps?: ValuationFundamentalInput;
  readonly dilutedShares?: ValuationFundamentalInput;
  readonly freeCashFlow?: ValuationFundamentalInput;
  readonly cash?: ValuationFundamentalInput;
  readonly debt?: ValuationFundamentalInput;
}

export function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function latest(values: readonly string[]): string {
  return values.toSorted().at(-1) ?? "";
}

function withScope(
  label: string,
  concept: string,
  totalOperations = false,
): Pick<ValuationFundamentalInput, "label" | "scope"> {
  const scope = conceptScope(concept) ?? (totalOperations ? TOTAL_OPERATIONS_SCOPE : undefined);
  return { label: scopedLabel(label, scope), ...(scope !== undefined ? { scope } : {}) };
}

function factInput(
  label: string,
  fact: FinancialStatementFact,
  totalOperations = false,
): ValuationFundamentalInput {
  return {
    value: fact.value,
    ...withScope(
      fact.basis === "gross-principal" ? `${label} (gross principal)` : label,
      fact.concept,
      totalOperations,
    ),
    periodEnd: fact.periodEnd,
    publicAt: fact.firstPublicAt,
    currency: fact.currency,
    unit: fact.unit,
    sourceIds: fact.sourceIds,
  };
}

function ttmInput(
  label: string,
  ttm: FinancialStatementTtm,
  totalOperations = false,
): ValuationFundamentalInput {
  return {
    value: ttm.value,
    ...withScope(label, ttm.components.fiscalYear.concept, totalOperations),
    periodEnd: ttm.periodEnd,
    publicAt: latest(Object.values(ttm.components).map((fact) => fact.firstPublicAt)),
    currency: ttm.currency,
    unit: ttm.unit,
    sourceIds: ttm.sourceIds,
    derivation: ttm.formula,
  };
}

function fcfInput(
  operatingCashFlow: ValuationFundamentalInput | undefined,
  capitalExpenditure: ValuationFundamentalInput | undefined,
): ValuationFundamentalInput | undefined {
  if (operatingCashFlow === undefined || capitalExpenditure === undefined) {
    return undefined;
  }
  if (
    operatingCashFlow.periodEnd !== capitalExpenditure.periodEnd ||
    operatingCashFlow.currency !== capitalExpenditure.currency ||
    operatingCashFlow.unit !== capitalExpenditure.unit
  ) {
    return undefined;
  }
  return {
    value: operatingCashFlow.value - capitalExpenditure.value,
    label: scopedLabel("Free cash flow proxy", operatingCashFlow.scope),
    ...(operatingCashFlow.scope !== undefined ? { scope: operatingCashFlow.scope } : {}),
    periodEnd: operatingCashFlow.periodEnd,
    publicAt: latest([operatingCashFlow.publicAt, capitalExpenditure.publicAt]),
    currency: operatingCashFlow.currency,
    unit: operatingCashFlow.unit,
    sourceIds: unique([...operatingCashFlow.sourceIds, ...capitalExpenditure.sourceIds]),
    derivation: "operating cash flow - capital expenditure",
  };
}

function deriveShares(
  netIncome: ValuationFundamentalInput | undefined,
  dilutedEps: ValuationFundamentalInput | undefined,
): ValuationFundamentalInput | undefined {
  if (
    netIncome === undefined ||
    dilutedEps === undefined ||
    dilutedEps.value === 0 ||
    netIncome.periodEnd !== dilutedEps.periodEnd ||
    netIncome.currency === null ||
    netIncome.currency !== dilutedEps.currency ||
    netIncome.unit !== netIncome.currency ||
    dilutedEps.unit !== `${netIncome.currency}/shares` ||
    !Number.isFinite(netIncome.value / dilutedEps.value)
  ) {
    return undefined;
  }
  return {
    value: netIncome.value / dilutedEps.value,
    label: "Diluted weighted-average shares",
    periodEnd: netIncome.periodEnd,
    publicAt: latest([netIncome.publicAt, dilutedEps.publicAt]),
    currency: null,
    unit: "shares",
    sourceIds: unique([...netIncome.sourceIds, ...dilutedEps.sourceIds]),
    derivation: "net income / diluted EPS",
  };
}

// Older complete debt cannot stand in once a newer incomplete instant up to the cash instant is public.
function debtInput(
  artifact: FinancialStatementsArtifact,
  debtFact: FinancialStatementFact | undefined,
  cashFact: FinancialStatementFact | undefined,
  publicAt: string,
): { readonly debt?: ValuationFundamentalInput } {
  if (debtFact === undefined) {
    return {};
  }
  const masked = artifact.omissionNotes.some((note) => {
    const periodEnd = note.periodKey?.replace(/^instant\|/u, "");
    return (
      note.code === "incomplete-composite-series" &&
      note.seriesKey === "debt" &&
      periodEnd !== undefined &&
      periodEnd > debtFact.periodEnd &&
      periodEnd <= (cashFact?.periodEnd ?? debtFact.periodEnd) &&
      (note.publicAt ?? "") <= publicAt
    );
  });
  return masked ? {} : { debt: factInput("Debt", debtFact) };
}

function annualInputs(
  artifact: FinancialStatementsArtifact,
  revenueFact: FinancialStatementFact,
): ValuationPeriodInputs {
  const { incomeStatement, balanceSheet, cashFlowStatement, perShare } = artifact.statements;
  const { periodEnd, periodKey, periodType } = revenueFact;
  const revenue = factInput("Revenue", revenueFact);
  const netIncomeFact = financialStatementFactForPeriod(
    financialStatementFacts(incomeStatement.netIncome),
    periodKey,
    periodType,
  );
  const dilutedEpsFact = financialStatementFactForPeriod(
    financialStatementFacts(perShare.dilutedEps),
    periodKey,
    periodType,
  );
  const dilutedSharesFact = financialStatementFactForPeriod(
    financialStatementFacts(perShare.dilutedShares),
    periodKey,
    periodType,
  );
  const operatingCashFlowFact = financialStatementFactForPeriod(
    financialStatementFacts(cashFlowStatement.operatingCashFlow),
    periodKey,
    periodType,
  );
  const capitalExpenditureFact = financialStatementFactForPeriod(
    financialStatementFacts(cashFlowStatement.capitalExpenditure),
    periodKey,
    periodType,
  );
  const hasContinuing = (series: FinancialStatementSeries) =>
    financialStatementFactForPeriod(financialStatementFacts(series), periodKey, periodType) !==
    undefined;
  const netIncome =
    netIncomeFact === undefined
      ? undefined
      : factInput("Net income", netIncomeFact, hasContinuing(incomeStatement.continuingIncome));
  const dilutedEps =
    dilutedEpsFact === undefined
      ? undefined
      : factInput("Diluted EPS", dilutedEpsFact, hasContinuing(perShare.continuingDilutedEps));
  const directShares =
    dilutedSharesFact === undefined
      ? undefined
      : factInput("Diluted weighted-average shares", dilutedSharesFact);
  const operatingCashFlow =
    operatingCashFlowFact === undefined
      ? undefined
      : factInput("Operating cash flow", operatingCashFlowFact);
  const capitalExpenditure =
    capitalExpenditureFact === undefined
      ? undefined
      : factInput("Capital expenditure", capitalExpenditureFact);
  const publicAt = latest(
    [revenue, netIncome, dilutedEps, directShares, operatingCashFlow, capitalExpenditure].flatMap(
      (input) => (input === undefined ? [] : [input.publicAt]),
    ),
  );
  const cashFact = latestFinancialStatementFact(
    financialStatementFacts(balanceSheet.cash).filter(
      (fact) => fact.periodEnd <= periodEnd && fact.firstPublicAt <= publicAt,
    ),
  );
  const debtFact = latestFinancialStatementFact(
    financialStatementFacts(balanceSheet.debt).filter(
      (fact) => fact.periodEnd <= periodEnd && fact.firstPublicAt <= publicAt,
    ),
  );
  const dilutedShares = directShares ?? deriveShares(netIncome, dilutedEps);
  const freeCashFlow = fcfInput(operatingCashFlow, capitalExpenditure);
  return {
    basis: "annual",
    periodEnd,
    revenue,
    ...(netIncome !== undefined ? { netIncome } : {}),
    ...(dilutedEps !== undefined ? { dilutedEps } : {}),
    ...(dilutedShares !== undefined ? { dilutedShares } : {}),
    ...(freeCashFlow !== undefined ? { freeCashFlow } : {}),
    ...(cashFact !== undefined ? { cash: factInput("Cash", cashFact) } : {}),
    ...debtInput(artifact, debtFact, cashFact, publicAt),
  };
}

interface ValuationTtmInputs {
  readonly revenue: FinancialStatementTtm;
  readonly netIncome?: FinancialStatementTtm;
  readonly dilutedEps?: FinancialStatementTtm;
  readonly continuingIncome?: FinancialStatementTtm;
  readonly continuingDilutedEps?: FinancialStatementTtm;
  readonly operatingCashFlow?: FinancialStatementTtm;
  readonly capitalExpenditure?: FinancialStatementTtm;
}

function sharesTtmPeriod(
  total: FinancialStatementTtm,
  continuing: FinancialStatementTtm | undefined,
): boolean {
  return continuing !== undefined && financialStatementTtmsSharePeriod([total, continuing]);
}

function periodInputsFromTtm(
  artifact: FinancialStatementsArtifact,
  values: ValuationTtmInputs,
): ValuationPeriodInputs {
  const { balanceSheet } = artifact.statements;
  const revenue = ttmInput("Revenue", values.revenue);
  const compatibleNetIncome =
    values.netIncome !== undefined &&
    financialStatementTtmsAreCompatible([values.revenue, values.netIncome])
      ? values.netIncome
      : undefined;
  const compatibleDilutedEps =
    values.dilutedEps !== undefined &&
    financialStatementTtmsSharePeriod([values.revenue, values.dilutedEps]) &&
    values.dilutedEps.currency === values.revenue.currency &&
    values.dilutedEps.unit === `${values.revenue.currency}/shares`
      ? values.dilutedEps
      : undefined;
  const compatibleOperatingCashFlow =
    values.operatingCashFlow !== undefined &&
    financialStatementTtmsAreCompatible([values.revenue, values.operatingCashFlow])
      ? values.operatingCashFlow
      : undefined;
  const compatibleCapitalExpenditure =
    values.capitalExpenditure !== undefined &&
    financialStatementTtmsAreCompatible([values.revenue, values.capitalExpenditure])
      ? values.capitalExpenditure
      : undefined;
  const netIncome =
    compatibleNetIncome === undefined
      ? undefined
      : ttmInput(
          "Net income",
          compatibleNetIncome,
          sharesTtmPeriod(compatibleNetIncome, values.continuingIncome),
        );
  const dilutedEps =
    compatibleDilutedEps === undefined
      ? undefined
      : ttmInput(
          "Diluted EPS",
          compatibleDilutedEps,
          sharesTtmPeriod(compatibleDilutedEps, values.continuingDilutedEps),
        );
  const operatingCashFlow =
    compatibleOperatingCashFlow === undefined
      ? undefined
      : ttmInput("Operating cash flow", compatibleOperatingCashFlow);
  const capitalExpenditure =
    compatibleCapitalExpenditure === undefined
      ? undefined
      : ttmInput("Capital expenditure", compatibleCapitalExpenditure);
  const dilutedShares = deriveShares(netIncome, dilutedEps);
  const freeCashFlow = fcfInput(operatingCashFlow, capitalExpenditure);
  const publicAt = latest(
    [revenue, netIncome, dilutedEps, dilutedShares, freeCashFlow].flatMap((input) =>
      input === undefined ? [] : [input.publicAt],
    ),
  );
  const cashFact = latestFinancialStatementFact(
    financialStatementFacts(balanceSheet.cash).filter(
      (fact) => fact.periodEnd <= revenue.periodEnd && fact.firstPublicAt <= publicAt,
    ),
  );
  const debtFact = latestFinancialStatementFact(
    financialStatementFacts(balanceSheet.debt).filter(
      (fact) => fact.periodEnd <= revenue.periodEnd && fact.firstPublicAt <= publicAt,
    ),
  );
  return {
    basis: "ttm",
    periodEnd: revenue.periodEnd,
    revenue,
    ...(netIncome !== undefined ? { netIncome } : {}),
    ...(dilutedEps !== undefined ? { dilutedEps } : {}),
    ...(dilutedShares !== undefined ? { dilutedShares } : {}),
    ...(freeCashFlow !== undefined ? { freeCashFlow } : {}),
    ...(cashFact !== undefined ? { cash: factInput("Cash", cashFact) } : {}),
    ...debtInput(artifact, debtFact, cashFact, publicAt),
  };
}

function ttmInputs(artifact: FinancialStatementsArtifact): ValuationPeriodInputs | undefined {
  const { incomeStatement, cashFlowStatement, perShare } = artifact.statements;
  const revenue = incomeStatement.revenue.ttm;
  if (revenue === undefined) {
    return undefined;
  }
  return periodInputsFromTtm(artifact, {
    revenue,
    ...(incomeStatement.netIncome.ttm !== undefined
      ? { netIncome: incomeStatement.netIncome.ttm }
      : {}),
    ...(perShare.dilutedEps.ttm !== undefined ? { dilutedEps: perShare.dilutedEps.ttm } : {}),
    ...(incomeStatement.continuingIncome.ttm !== undefined
      ? { continuingIncome: incomeStatement.continuingIncome.ttm }
      : {}),
    ...(perShare.continuingDilutedEps.ttm !== undefined
      ? { continuingDilutedEps: perShare.continuingDilutedEps.ttm }
      : {}),
    ...(cashFlowStatement.operatingCashFlow.ttm !== undefined
      ? { operatingCashFlow: cashFlowStatement.operatingCashFlow.ttm }
      : {}),
    ...(cashFlowStatement.capitalExpenditure.ttm !== undefined
      ? { capitalExpenditure: cashFlowStatement.capitalExpenditure.ttm }
      : {}),
  });
}

function derivedTtmAt(
  artifact: FinancialStatementsArtifact,
  series: FinancialStatementSeries,
  cutoff: string,
): FinancialStatementTtm | undefined {
  const definition = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    (candidate) => candidate.key === series.key,
  );
  if (definition === undefined || artifact.reportingCurrency === undefined) {
    return undefined;
  }
  return deriveFinancialStatementTtm(
    definition,
    series.annual.filter((fact) => fact.firstPublicAt <= cutoff),
    series.interim.filter((fact) => fact.firstPublicAt <= cutoff),
    artifact.reportingCurrency,
  ).ttm;
}

function historicalTtmInputs(
  artifact: FinancialStatementsArtifact,
): readonly ValuationPeriodInputs[] {
  const { incomeStatement, cashFlowStatement, perShare } = artifact.statements;
  const cutoffs = [
    ...new Set(incomeStatement.revenue.interim.map((fact) => fact.firstPublicAt)),
  ].toSorted();
  return cutoffs.flatMap((cutoff) => {
    const revenue = derivedTtmAt(artifact, incomeStatement.revenue, cutoff);
    if (revenue === undefined) {
      return [];
    }
    const netIncome = derivedTtmAt(artifact, incomeStatement.netIncome, cutoff);
    const dilutedEps = derivedTtmAt(artifact, perShare.dilutedEps, cutoff);
    const continuingIncome = derivedTtmAt(artifact, incomeStatement.continuingIncome, cutoff);
    const continuingDilutedEps = derivedTtmAt(artifact, perShare.continuingDilutedEps, cutoff);
    const operatingCashFlow = derivedTtmAt(artifact, cashFlowStatement.operatingCashFlow, cutoff);
    const capitalExpenditure = derivedTtmAt(artifact, cashFlowStatement.capitalExpenditure, cutoff);
    return [
      periodInputsFromTtm(artifact, {
        revenue,
        ...(netIncome !== undefined ? { netIncome } : {}),
        ...(dilutedEps !== undefined ? { dilutedEps } : {}),
        ...(continuingIncome !== undefined ? { continuingIncome } : {}),
        ...(continuingDilutedEps !== undefined ? { continuingDilutedEps } : {}),
        ...(operatingCashFlow !== undefined ? { operatingCashFlow } : {}),
        ...(capitalExpenditure !== undefined ? { capitalExpenditure } : {}),
      }),
    ];
  });
}

function uniquePeriodInputs(
  values: readonly ValuationPeriodInputs[],
): readonly ValuationPeriodInputs[] {
  const byKey = new Map<string, ValuationPeriodInputs>();
  for (const value of values) {
    byKey.set(`${value.basis}|${value.periodEnd}|${periodPublicAt(value)}`, value);
  }
  return [...byKey.values()].toSorted(
    (left, right) =>
      left.periodEnd.localeCompare(right.periodEnd) ||
      periodPublicAt(left).localeCompare(periodPublicAt(right)),
  );
}

export function periodPublicAt(inputs: ValuationPeriodInputs): string {
  return latest(
    Object.values(inputs).flatMap((input) =>
      typeof input === "object" && input !== null && "publicAt" in input
        ? [input.publicAt as string]
        : [],
    ),
  );
}

// The reconciled TTM period is returned alongside the deduplicated series because the workbench
// Needs it twice: once as the trailing basis and once as the last entry of the observation set.
export function valuationPeriodInputs(artifact: FinancialStatementsArtifact): {
  readonly ttm: ValuationPeriodInputs | undefined;
  readonly periods: readonly ValuationPeriodInputs[];
} {
  const ttm = ttmInputs(artifact);
  return {
    ttm,
    periods: uniquePeriodInputs([
      ...artifact.statements.incomeStatement.revenue.annual.map((fact) =>
        annualInputs(artifact, fact),
      ),
      ...historicalTtmInputs(artifact),
      ...(ttm === undefined ? [] : [ttm]),
    ]),
  };
}
