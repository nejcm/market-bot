import {
  balanceSheetPeriodDivergence,
  type BalanceSheetPeriodDivergence,
} from "../../../src/sources/extended-evidence/valuation-comps-support";
import { unique, type ValuationPeriodInputs } from "./valuation-workbench-inputs";
import type {
  ValuationFundamentalInput,
  ValuationMetricKey,
  ValuationMetricResult,
  ValuationMetricSuppressionReason,
  ValuationPriceInput,
} from "./valuation-workbench-contract";

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
      "No verified close is available within 7 calendar days on or after the public filing date.",
      input.sourceIds,
    );
  }
  if (input.price.currency !== input.reportingCurrency) {
    return suppression(
      "fx-rate-unavailable",
      `No FX close is available to convert ${input.price.currency} into ${input.reportingCurrency} on or before ${input.price.sessionDate}.`,
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

export function metricResults(
  inputs: ValuationPeriodInputs,
  price: ValuationPriceInput | null,
  reportingCurrency: string | undefined,
  quoteCurrency: string | undefined,
  depositorySic: string | undefined,
  additionalSourceIds: readonly string[] = [],
): Readonly<Record<ValuationMetricKey, ValuationMetricResult>> {
  const shares = inputs.dilutedShares?.value;
  const marketCap = price === null || shares === undefined ? undefined : price.close * shares;
  const mixedPeriod =
    inputs.cash === undefined || inputs.debt === undefined
      ? undefined
      : balanceSheetPeriodDivergence({
          cashPeriodEnd: inputs.cash.periodEnd,
          debtPeriodEnd: inputs.debt.periodEnd,
        });
  const enterpriseValue =
    depositorySic !== undefined ||
    marketCap === undefined ||
    inputs.cash === undefined ||
    inputs.debt === undefined ||
    mixedPeriod !== undefined
      ? undefined
      : marketCap + inputs.debt.value - inputs.cash.value;
  const commonSourceIds = Object.values(inputs).flatMap((input) =>
    typeof input === "object" && input !== null && "sourceIds" in input
      ? (input.sourceIds as readonly string[])
      : [],
  );
  const metricSourceIds = [...commonSourceIds, ...additionalSourceIds];
  const priceToEarningsNumerator = price?.close;
  const priceToEarningsDenominator = inputs.dilutedEps;
  const sharesUnavailable =
    inputs.dilutedShares === undefined
      ? suppression(
          "diluted-shares-unavailable",
          "As-reported diluted weighted-average shares are unavailable.",
          metricSourceIds,
        )
      : undefined;
  const enterpriseValueToRevenue = enterpriseValueToRevenueMetric({
    depositorySic,
    cash: inputs.cash,
    debt: inputs.debt,
    mixedPeriod,
    dilutedShares: inputs.dilutedShares,
    enterpriseValue,
    revenue: inputs.revenue,
    price,
    reportingCurrency,
    quoteCurrency,
    sourceIds: metricSourceIds,
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
      sourceIds: metricSourceIds,
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
        sourceIds: metricSourceIds,
      }),
    enterpriseValueToRevenue,
    priceToFreeCashFlow:
      depositoryMetric(
        depositorySic,
        DEPOSITORY_FREE_CASH_FLOW_RULE,
        DEPOSITORY_FREE_CASH_FLOW_RATIONALE,
        metricSourceIds,
      ) ??
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
        sourceIds: metricSourceIds,
      }),
  };
}
const DEPOSITORY_ENTERPRISE_VALUE_RULE =
  "Enterprise value is not computed for depository issuers: deposits and borrowings fund operations rather than sitting on top of them, so no defensible operating/financing split exists.";
const DEPOSITORY_ENTERPRISE_VALUE_RATIONALE =
  "deposit-funded issuer; enterprise value is not defined";
const DEPOSITORY_FREE_CASH_FLOW_RULE =
  "Capex-based free cash flow is not computed for depository issuers: they file no capital-expenditure line for the operating-cash-flow-less-capex proxy to subtract.";
const DEPOSITORY_FREE_CASH_FLOW_RATIONALE =
  "depository issuer; capex-based free cash flow is not defined";

function depositoryMetric(
  depositorySic: string | undefined,
  rule: string,
  rationale: string,
  sourceIds: readonly string[],
): ValuationMetricResult | undefined {
  return depositorySic === undefined
    ? undefined
    : {
        status: "not-applicable",
        display: "not applicable",
        rule,
        inputs: { sic: depositorySic },
        rationale,
        sourceIds: unique(sourceIds),
      };
}

function enterpriseValueToRevenueMetric(input: {
  readonly depositorySic: string | undefined;
  readonly cash: ValuationFundamentalInput | undefined;
  readonly debt: ValuationFundamentalInput | undefined;
  readonly mixedPeriod: BalanceSheetPeriodDivergence | undefined;
  readonly dilutedShares: ValuationFundamentalInput | undefined;
  readonly enterpriseValue: number | undefined;
  readonly revenue: ValuationFundamentalInput | undefined;
  readonly price: ValuationPriceInput | null;
  readonly reportingCurrency: string | undefined;
  readonly quoteCurrency: string | undefined;
  readonly sourceIds: readonly string[];
}): ValuationMetricResult {
  const depository = depositoryMetric(
    input.depositorySic,
    DEPOSITORY_ENTERPRISE_VALUE_RULE,
    DEPOSITORY_ENTERPRISE_VALUE_RATIONALE,
    input.sourceIds,
  );
  if (depository !== undefined) {
    return depository;
  }
  if (input.cash === undefined) {
    return suppression("cash-unavailable", "As-reported cash is unavailable.", input.sourceIds);
  }
  if (input.debt === undefined) {
    return suppression("debt-unavailable", "As-reported debt is unavailable.", input.sourceIds);
  }
  if (input.mixedPeriod !== undefined) {
    const { cashPeriodEnd, debtPeriodEnd, divergenceDays } = input.mixedPeriod;
    return suppression(
      "mixed-period-balance-sheet",
      `Cash (${cashPeriodEnd}) and debt (${debtPeriodEnd}) period ends diverge by ${String(Math.round(divergenceDays))} days.`,
      input.sourceIds,
    );
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
