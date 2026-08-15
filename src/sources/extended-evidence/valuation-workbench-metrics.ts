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
  const enterpriseValue =
    depositorySic !== undefined ||
    marketCap === undefined ||
    inputs.cash === undefined ||
    inputs.debt === undefined
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
    // A depository issuer files no capex line for the proxy to subtract, so P/FCF is inapplicable
    // For exactly the reason Financial Trends gives for the FCF column. Rendering 20.00x here
    // While the trend column calls the same proxy undefined would contradict the same report.
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

// Enterprise value assumes a clean operating/financing split, and a depository issuer has none:
// Deposits and borrowings are the raw material the business transforms, not a capital structure
// Layered on top of operations, and there is no defensible line between the two.
// Including deposits yields an EV dominated by the deposit base; excluding them yields something
// That is not enterprise value in any conventional sense — and both render as a plausible
// Multiple, which is a confident wrong number rather than a visible failure.
// "Revenue" is ambiguous here too (gross interest income against net interest income plus fees),
// So the denominator compounds the numerator's problem.
// Depository issuers are valued on P/B, P/TBV and P/E, all of which stay computed; only the
// EV-based multiple is declared inapplicable.
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
