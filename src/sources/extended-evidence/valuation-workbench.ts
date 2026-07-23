import type { OhlcvBar } from "../../domain/types";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementTtm,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";
import type { ValuationCompsArtifact } from "./valuation-comps";
import type {
  HistoricalValuationObservation,
  TrailingValuationBasis,
  ValuationFundamentalInput,
  ValuationMetricKey,
  ValuationMetricResult,
  ValuationMetricSuppressionReason,
  ValuationObservationBasis,
  ValuationPriceInput,
  ValuationWorkbenchArtifact,
} from "./valuation-workbench-contract";

const PRICE_SELECTION_RULE = "first verified close on or after publicAt" as const;

interface ValuationPeriodInputs {
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

export interface BuildValuationWorkbenchInput {
  readonly generatedAt: string;
  readonly symbol: string;
  readonly financialStatements?: FinancialStatementsArtifact;
  readonly valuationComps?: ValuationCompsArtifact;
  readonly priceHistory: readonly Pick<OhlcvBar, "date" | "close">[];
  readonly priceSourceId?: string;
  readonly quoteCurrency?: string;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function latest(values: readonly string[]): string {
  return values.toSorted().at(-1) ?? "";
}

function factInput(label: string, fact: FinancialStatementFact): ValuationFundamentalInput {
  return {
    value: fact.value,
    label,
    periodEnd: fact.periodEnd,
    publicAt: fact.filedAt,
    currency: fact.currency,
    unit: fact.unit,
    sourceIds: fact.sourceIds,
  };
}

function ttmInput(label: string, ttm: FinancialStatementTtm): ValuationFundamentalInput {
  return {
    value: ttm.value,
    label,
    periodEnd: ttm.periodEnd,
    publicAt: latest(Object.values(ttm.components).map((fact) => fact.filedAt)),
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
  return {
    value: operatingCashFlow.value - capitalExpenditure.value,
    label: "Free cash flow proxy",
    periodEnd: operatingCashFlow.periodEnd,
    publicAt: latest([operatingCashFlow.publicAt, capitalExpenditure.publicAt]),
    currency: operatingCashFlow.currency,
    unit: operatingCashFlow.unit,
    sourceIds: unique([...operatingCashFlow.sourceIds, ...capitalExpenditure.sourceIds]),
    derivation: "operating cash flow - capital expenditure",
  };
}

function factForPeriod(
  series: FinancialStatementSeries,
  periodEnd: string,
): FinancialStatementFact | undefined {
  return series.annual.find((fact) => fact.periodEnd === periodEnd);
}

function latestBalanceFact(
  series: FinancialStatementSeries,
  periodEnd: string,
  publicAt: string,
): FinancialStatementFact | undefined {
  return [...series.annual, ...series.interim]
    .filter((fact) => fact.periodEnd <= periodEnd && fact.filedAt <= publicAt)
    .toSorted(
      (left, right) =>
        right.periodEnd.localeCompare(left.periodEnd) || right.filedAt.localeCompare(left.filedAt),
    )
    .at(0);
}

function deriveShares(
  netIncome: ValuationFundamentalInput | undefined,
  dilutedEps: ValuationFundamentalInput | undefined,
): ValuationFundamentalInput | undefined {
  if (
    netIncome === undefined ||
    dilutedEps === undefined ||
    dilutedEps.value === 0 ||
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

function annualInputs(
  artifact: FinancialStatementsArtifact,
  revenueFact: FinancialStatementFact,
): ValuationPeriodInputs {
  const { incomeStatement, balanceSheet, cashFlowStatement, perShare } = artifact.statements;
  const { periodEnd } = revenueFact;
  const revenue = factInput("Revenue", revenueFact);
  const netIncomeFact = factForPeriod(incomeStatement.netIncome, periodEnd);
  const dilutedEpsFact = factForPeriod(perShare.dilutedEps, periodEnd);
  const dilutedSharesFact = factForPeriod(perShare.dilutedShares, periodEnd);
  const operatingCashFlowFact = factForPeriod(cashFlowStatement.operatingCashFlow, periodEnd);
  const capitalExpenditureFact = factForPeriod(cashFlowStatement.capitalExpenditure, periodEnd);
  const netIncome =
    netIncomeFact === undefined ? undefined : factInput("Net income", netIncomeFact);
  const dilutedEps =
    dilutedEpsFact === undefined ? undefined : factInput("Diluted EPS", dilutedEpsFact);
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
  const cashFact = latestBalanceFact(balanceSheet.cash, periodEnd, publicAt);
  const debtFact = latestBalanceFact(balanceSheet.debt, periodEnd, publicAt);
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
    ...(debtFact !== undefined ? { debt: factInput("Debt", debtFact) } : {}),
  };
}

function ttmInputs(artifact: FinancialStatementsArtifact): ValuationPeriodInputs | undefined {
  const { incomeStatement, balanceSheet, cashFlowStatement, perShare } = artifact.statements;
  const revenueTtm = incomeStatement.revenue.ttm;
  if (revenueTtm === undefined) {
    return undefined;
  }
  const revenue = ttmInput("Revenue", revenueTtm);
  const netIncome =
    incomeStatement.netIncome.ttm === undefined
      ? undefined
      : ttmInput("Net income", incomeStatement.netIncome.ttm);
  const dilutedEps =
    perShare.dilutedEps.ttm === undefined
      ? undefined
      : ttmInput("Diluted EPS", perShare.dilutedEps.ttm);
  const operatingCashFlow =
    cashFlowStatement.operatingCashFlow.ttm === undefined
      ? undefined
      : ttmInput("Operating cash flow", cashFlowStatement.operatingCashFlow.ttm);
  const capitalExpenditure =
    cashFlowStatement.capitalExpenditure.ttm === undefined
      ? undefined
      : ttmInput("Capital expenditure", cashFlowStatement.capitalExpenditure.ttm);
  const dilutedShares = deriveShares(netIncome, dilutedEps);
  const freeCashFlow = fcfInput(operatingCashFlow, capitalExpenditure);
  const publicAt = latest(
    [revenue, netIncome, dilutedEps, dilutedShares, freeCashFlow].flatMap((input) =>
      input === undefined ? [] : [input.publicAt],
    ),
  );
  const cashFact = latestBalanceFact(balanceSheet.cash, revenue.periodEnd, publicAt);
  const debtFact = latestBalanceFact(balanceSheet.debt, revenue.periodEnd, publicAt);
  return {
    basis: "ttm",
    periodEnd: revenue.periodEnd,
    revenue,
    ...(netIncome !== undefined ? { netIncome } : {}),
    ...(dilutedEps !== undefined ? { dilutedEps } : {}),
    ...(dilutedShares !== undefined ? { dilutedShares } : {}),
    ...(freeCashFlow !== undefined ? { freeCashFlow } : {}),
    ...(cashFact !== undefined ? { cash: factInput("Cash", cashFact) } : {}),
    ...(debtFact !== undefined ? { debt: factInput("Debt", debtFact) } : {}),
  };
}

function periodPublicAt(inputs: ValuationPeriodInputs): string {
  return latest(
    Object.values(inputs).flatMap((input) =>
      typeof input === "object" && input !== null && "publicAt" in input
        ? [input.publicAt as string]
        : [],
    ),
  );
}

function selectedPrice(
  input: BuildValuationWorkbenchInput,
  publicAt: string,
): ValuationPriceInput | null {
  if (input.priceSourceId === undefined || input.quoteCurrency === undefined) {
    return null;
  }
  const priceObservation = input.priceHistory
    .filter((price) => price.date >= publicAt && price.close > 0 && Number.isFinite(price.close))
    .toSorted((left, right) => left.date.localeCompare(right.date))
    .at(0);
  return priceObservation === undefined
    ? null
    : {
        close: priceObservation.close,
        sessionDate: priceObservation.date,
        currency: input.quoteCurrency,
        sourceId: input.priceSourceId,
      };
}

function suppression(
  reason: ValuationMetricSuppressionReason,
  detail: string,
  sourceIds: readonly string[],
): ValuationMetricResult {
  return { status: "suppressed", display: "—", reason, detail, sourceIds: unique(sourceIds) };
}

function ratioMetric(input: {
  readonly numerator: number | undefined;
  readonly denominator: ValuationFundamentalInput | undefined;
  readonly formula: string;
  readonly price: ValuationPriceInput | null;
  readonly reportingCurrency: string | undefined;
  readonly quoteCurrency: string | undefined;
  readonly missingDenominatorReason: ValuationMetricSuppressionReason;
  readonly missingDenominatorDetail: string;
  readonly sourceIds: readonly string[];
}): ValuationMetricResult {
  if (input.reportingCurrency === undefined) {
    return suppression(
      "reporting-currency-unavailable",
      "Canonical reporting currency is unavailable.",
      input.sourceIds,
    );
  }
  if (input.quoteCurrency === undefined) {
    return suppression(
      "quote-currency-unavailable",
      "Quote currency is unavailable.",
      input.sourceIds,
    );
  }
  if (input.price === null) {
    return suppression(
      "price-history-unavailable",
      "No verified close is available on or after the public filing date.",
      input.sourceIds,
    );
  }
  if (input.price.currency !== input.reportingCurrency) {
    return suppression(
      "quote-reporting-currency-mismatch",
      `Quote currency ${input.price.currency} does not match reporting currency ${input.reportingCurrency}.`,
      [...input.sourceIds, input.price.sourceId],
    );
  }
  if (input.denominator === undefined || input.numerator === undefined) {
    return suppression(
      input.denominator === undefined ? input.missingDenominatorReason : "numerator-unavailable",
      input.denominator === undefined
        ? input.missingDenominatorDetail
        : "The required as-reported numerator is unavailable.",
      [...input.sourceIds, input.price.sourceId],
    );
  }
  const denominator = input.denominator.value;
  const metricSourceIds = unique([
    ...input.sourceIds,
    ...input.denominator.sourceIds,
    input.price.sourceId,
  ]);
  if (!Number.isFinite(denominator)) {
    return {
      status: "not-meaningful",
      display: "N/M",
      reason: "non-finite-denominator",
      denominator,
      formula: input.formula,
      sourceIds: metricSourceIds,
    };
  }
  if (denominator < 0) {
    return {
      status: "not-meaningful",
      display: "N/M",
      reason: "negative-denominator",
      denominator,
      formula: input.formula,
      sourceIds: metricSourceIds,
    };
  }
  if (denominator === 0) {
    return {
      status: "not-meaningful",
      display: "N/M",
      reason: "zero-denominator",
      denominator,
      formula: input.formula,
      sourceIds: metricSourceIds,
    };
  }
  const value = input.numerator / denominator;
  return {
    status: "populated",
    value,
    display: `${value.toFixed(2)}x`,
    numerator: input.numerator,
    denominator,
    formula: input.formula,
    sourceIds: metricSourceIds,
  };
}

function metricResults(
  inputs: ValuationPeriodInputs,
  price: ValuationPriceInput | null,
  reportingCurrency: string | undefined,
  quoteCurrency: string | undefined,
): Readonly<Record<ValuationMetricKey, ValuationMetricResult>> {
  const shares = inputs.dilutedShares?.value;
  const marketCap = price === null || shares === undefined ? undefined : price.close * shares;
  const enterpriseValue =
    marketCap === undefined || inputs.cash === undefined || inputs.debt === undefined
      ? undefined
      : marketCap + inputs.debt.value - inputs.cash.value;
  const commonSourceIds = Object.values(inputs).flatMap((input) =>
    typeof input === "object" && input !== null && "sourceIds" in input
      ? (input.sourceIds as readonly string[])
      : [],
  );
  const priceToEarningsNumerator = price?.close;
  const priceToEarningsDenominator = inputs.dilutedEps;
  const sharesUnavailable =
    inputs.dilutedShares === undefined
      ? suppression(
          "diluted-shares-unavailable",
          "As-reported diluted weighted-average shares are unavailable.",
          commonSourceIds,
        )
      : undefined;
  const enterpriseValueToRevenue = enterpriseValueToRevenueMetric({
    cash: inputs.cash,
    debt: inputs.debt,
    dilutedShares: inputs.dilutedShares,
    enterpriseValue,
    revenue: inputs.revenue,
    price,
    reportingCurrency,
    quoteCurrency,
    sourceIds: commonSourceIds,
  });
  return {
    priceToEarnings: ratioMetric({
      numerator: priceToEarningsNumerator,
      denominator: priceToEarningsDenominator,
      formula: "close / diluted EPS",
      price,
      reportingCurrency,
      quoteCurrency,
      missingDenominatorReason: "earnings-unavailable",
      missingDenominatorDetail: "As-reported diluted EPS is unavailable.",
      sourceIds: commonSourceIds,
    }),
    priceToSales:
      sharesUnavailable ??
      ratioMetric({
        numerator: marketCap,
        denominator: inputs.revenue,
        formula: "(close × diluted shares) / revenue",
        price,
        reportingCurrency,
        quoteCurrency,
        missingDenominatorReason: "revenue-unavailable",
        missingDenominatorDetail: "As-reported revenue is unavailable.",
        sourceIds: commonSourceIds,
      }),
    enterpriseValueToRevenue,
    priceToFreeCashFlow:
      sharesUnavailable ??
      ratioMetric({
        numerator: marketCap,
        denominator: inputs.freeCashFlow,
        formula: "(close × diluted shares) / free cash flow",
        price,
        reportingCurrency,
        quoteCurrency,
        missingDenominatorReason: "free-cash-flow-unavailable",
        missingDenominatorDetail: "As-reported free cash flow is unavailable.",
        sourceIds: commonSourceIds,
      }),
  };
}

function enterpriseValueToRevenueMetric(input: {
  readonly cash: ValuationFundamentalInput | undefined;
  readonly debt: ValuationFundamentalInput | undefined;
  readonly dilutedShares: ValuationFundamentalInput | undefined;
  readonly enterpriseValue: number | undefined;
  readonly revenue: ValuationFundamentalInput | undefined;
  readonly price: ValuationPriceInput | null;
  readonly reportingCurrency: string | undefined;
  readonly quoteCurrency: string | undefined;
  readonly sourceIds: readonly string[];
}): ValuationMetricResult {
  if (input.cash === undefined) {
    return suppression("cash-unavailable", "As-reported cash is unavailable.", input.sourceIds);
  }
  if (input.debt === undefined) {
    return suppression("debt-unavailable", "As-reported debt is unavailable.", input.sourceIds);
  }
  if (input.dilutedShares === undefined) {
    return suppression(
      "diluted-shares-unavailable",
      "As-reported diluted weighted-average shares are unavailable.",
      input.sourceIds,
    );
  }
  return ratioMetric({
    numerator: input.enterpriseValue,
    denominator: input.revenue,
    formula: "((close × diluted shares) + debt - cash) / revenue",
    price: input.price,
    reportingCurrency: input.reportingCurrency,
    quoteCurrency: input.quoteCurrency,
    missingDenominatorReason: "revenue-unavailable",
    missingDenominatorDetail: "As-reported revenue is unavailable.",
    sourceIds: input.sourceIds,
  });
}

function observation(
  input: BuildValuationWorkbenchInput,
  periodInputs: ValuationPeriodInputs,
): HistoricalValuationObservation {
  const publicAt = periodPublicAt(periodInputs);
  const price = selectedPrice(input, publicAt);
  const inputs = {
    ...(periodInputs.revenue !== undefined ? { revenue: periodInputs.revenue } : {}),
    ...(periodInputs.netIncome !== undefined ? { netIncome: periodInputs.netIncome } : {}),
    ...(periodInputs.dilutedEps !== undefined ? { dilutedEps: periodInputs.dilutedEps } : {}),
    ...(periodInputs.dilutedShares !== undefined
      ? { dilutedShares: periodInputs.dilutedShares }
      : {}),
    ...(periodInputs.freeCashFlow !== undefined ? { freeCashFlow: periodInputs.freeCashFlow } : {}),
    ...(periodInputs.cash !== undefined ? { cash: periodInputs.cash } : {}),
    ...(periodInputs.debt !== undefined ? { debt: periodInputs.debt } : {}),
  };
  const sourceIds = unique([
    ...Object.values(inputs).flatMap((value) => value.sourceIds),
    ...(price === null ? [] : [price.sourceId]),
  ]);
  return {
    basis: periodInputs.basis,
    periodEnd: periodInputs.periodEnd,
    publicAt,
    price,
    inputs,
    metrics: metricResults(
      periodInputs,
      price,
      input.financialStatements?.reportingCurrency,
      input.quoteCurrency,
    ),
    sourceIds,
  };
}

function trailingBasis(
  artifact: FinancialStatementsArtifact | undefined,
  ttm: ValuationPeriodInputs | undefined,
): TrailingValuationBasis {
  if (artifact === undefined || ttm === undefined) {
    return {
      status: "suppressed",
      reason: "canonical-ttm-unavailable",
      detail:
        "Canonical reconciled TTM is unavailable; retained quarter-only periods are not combined into an unreconciled TTM.",
      sourceIds: artifact === undefined ? [] : [artifact.sourceId],
    };
  }
  return {
    status: "available",
    periodEnd: ttm.periodEnd,
    publicAt: periodPublicAt(ttm),
    sourceIds: unique(
      Object.values(ttm).flatMap((value) =>
        typeof value === "object" && value !== null && "sourceIds" in value
          ? (value.sourceIds as readonly string[])
          : [],
      ),
    ),
  };
}

export function buildValuationWorkbench(
  input: BuildValuationWorkbenchInput,
): ValuationWorkbenchArtifact {
  const artifact = input.financialStatements;
  const ttm = artifact === undefined ? undefined : ttmInputs(artifact);
  const periodInputs =
    artifact === undefined
      ? []
      : [
          ...artifact.statements.incomeStatement.revenue.annual.map((fact) =>
            annualInputs(artifact, fact),
          ),
          ...(ttm === undefined ? [] : [ttm]),
        ];
  const observations = periodInputs.map((period) => observation(input, period));
  const suppressionReasons = [
    ...(artifact === undefined ? ["canonical financial statements unavailable"] : []),
    ...(observations.length === 0 ? ["no annual or reconciled TTM valuation basis available"] : []),
    ...(input.priceHistory.length === 0 ? ["verified historical closes unavailable"] : []),
    ...(input.quoteCurrency === undefined ? ["quote currency unavailable"] : []),
  ];
  const sourceIds = unique([
    ...observations.flatMap((item) => item.sourceIds),
    ...(input.valuationComps?.sourceIds ?? []),
  ]);
  return {
    version: 1,
    generatedAt: input.generatedAt,
    analysisAsOf: artifact?.analysisAsOf ?? input.generatedAt,
    symbol: input.symbol,
    reportingCurrency: artifact?.reportingCurrency ?? null,
    quoteCurrency: input.quoteCurrency ?? null,
    historicalMultiples: {
      priceSelectionRule: PRICE_SELECTION_RULE,
      observations,
      trailingBasis: trailingBasis(artifact, ttm),
      suppressionReasons,
    },
    peerComparison:
      input.valuationComps === undefined
        ? {
            status: "suppressed",
            reason: "peer-data-unavailable",
            detail: "Peer comparison data is unavailable for this run.",
            sourceIds: [],
          }
        : { status: "available", valuationComps: input.valuationComps },
    sourceIds,
  };
}
