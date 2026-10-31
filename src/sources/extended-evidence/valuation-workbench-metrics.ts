import { balanceSheetPeriodDivergence } from "./valuation-comps-support";
import { isYearAligned } from "./financial-statement-selection";
import {
  evaluateMetricSection,
  type MetricDefinition,
  type MetricInput,
  type MetricOutcome,
} from "./metric-engine";
import type {
  FinancialStatementsArtifact,
  FinancialStatementSeriesKey,
} from "./financial-statements-contract";
import { periodPublicAt, type ValuationPeriodInputs } from "./valuation-workbench-inputs";
import type {
  ValuationFundamentalInput,
  ValuationMetricKey,
  ValuationPriceInput,
} from "./valuation-workbench-contract";

const DENOMINATOR_LABELS = {
  dilutedEps: "earnings",
  freeCashFlow: "free-cash-flow",
  revenue: "revenue",
} as const;

function notMeaningfulReason(value: number) {
  if (!Number.isFinite(value)) {
    return "non-finite-denominator";
  }
  return value === 0 ? "zero-denominator" : "negative-denominator";
}

const METRICS = [
  ["priceToEarnings", "P/E", "close / diluted EPS", "dilutedEps"],
  ["priceToSales", "P/S", "(close × diluted shares) / revenue", "revenue"],
  [
    "enterpriseValueToRevenue",
    "EV/revenue",
    "((close × diluted shares) + debt + preferred stock + noncontrolling interest + temporary equity - cash - short-term investments) / revenue",
    "revenue",
  ],
  [
    "priceToFreeCashFlow",
    "P/FCF proxy",
    "(close × diluted shares) / free cash flow",
    "freeCashFlow",
  ],
] as const;

export function valuationMetricSection(input: {
  readonly symbol: string;
  readonly period: ValuationPeriodInputs;
  readonly price: ValuationPriceInput | null;
  readonly outsidePriceHistoryWindow?: boolean;
  readonly reportingCurrency?: string | undefined;
  readonly quoteCurrency?: string | undefined;
  readonly depositorySic?: string | undefined;
  readonly statements?: FinancialStatementsArtifact | undefined;
  readonly fx?: {
    readonly rate: number;
    readonly date: string;
    readonly pair: string;
    readonly sourceId: string;
  };
}): ReturnType<typeof evaluateMetricSection> {
  const { period, price, reportingCurrency, quoteCurrency, fx } = input;
  const publicAt = periodPublicAt(period);
  const priceBasis = `first verified close within 7 calendar days on or after publicAt ${publicAt}${price === null ? " (unavailable)" : `; close ${price.sessionDate} ${price.currency}`}${fx === undefined ? "" : `; ${fx.pair} ${fx.rate} on ${fx.date}`}`;
  const definitions: readonly MetricDefinition[] = METRICS.map(
    ([id, label, formula, denominatorKey]) => ({
      id,
      label,
      unit: "ratio",
      basis: `${period.basis.toUpperCase()}; ${formula}; ${priceBasis}`,
      ...(id === "enterpriseValueToRevenue" || id === "priceToFreeCashFlow"
        ? {
            applicable: () => {
              if (input.depositorySic === undefined) {
                return undefined;
              }
              return id === "enterpriseValueToRevenue"
                ? `deposit-funded issuer; enterprise value is not defined (SIC ${input.depositorySic})`
                : `depository issuer; capex-based free cash flow is not defined (SIC ${input.depositorySic})`;
            },
          }
        : {}),
      compute: (): MetricOutcome => {
        const needsShares = id !== "priceToEarnings";
        const fundamentals: readonly (ValuationFundamentalInput | undefined)[] = [
          ...(denominatorKey === "freeCashFlow"
            ? [period.operatingCashFlow, period.capitalExpenditure]
            : [period[denominatorKey]]),
          ...(needsShares ? [period.dilutedShares] : []),
          ...(id === "enterpriseValueToRevenue"
            ? [period.cash, period.debt, period.enterpriseValueBridge]
            : []),
        ];
        const lineage: readonly MetricInput[] = [
          ...fundamentals.flatMap((value) => value?.lineage ?? []),
          ...(price === null
            ? []
            : [
                {
                  label: "Verified close",
                  value: price.close,
                  artifact: "priceHistory" as const,
                  key: "close",
                  unit: price.currency,
                  currency: price.currency,
                  periodEnd: price.sessionDate,
                  sourceIds: [price.sourceId],
                },
              ]),
          ...(fx === undefined
            ? []
            : [
                {
                  label: fx.pair,
                  value: fx.rate,
                  artifact: "fx" as const,
                  key: fx.pair,
                  unit: "ratio",
                  periodEnd: fx.date,
                  sourceIds: [fx.sourceId],
                },
              ]),
        ];
        const missing = (
          reason: string,
          keys: readonly FinancialStatementSeriesKey[] = [],
        ): MetricOutcome => ({
          status: "missing",
          reason,
          periodEnd: period.periodEnd,
          inputs: lineage,
          ...(keys.length > 0 && keys.every((key) => input.statements?.unfiledSeries?.includes(key))
            ? { cause: "not-filed" as const }
            : {}),
        });
        if (id === "enterpriseValueToRevenue") {
          if (period.cash === undefined) {
            return missing("cash-unavailable", ["cash"]);
          }
          if (period.debtScopeMismatch) {
            return missing("mixed-scope-debt");
          }
          if (period.debt === undefined) {
            return missing("debt-unavailable", ["debt"]);
          }
          if (period.enterpriseValueBridgeIncomplete) {
            return missing("ev-bridge-incomplete");
          }
          const mixed = balanceSheetPeriodDivergence({
            cashPeriodEnd: period.cash.periodEnd,
            debtPeriodEnd: period.debt.periodEnd,
          });
          if (mixed !== undefined || period.debtBehindIncompleteInstant) {
            return missing("mixed-period-balance-sheet");
          }
        }
        if (needsShares && period.dilutedShares === undefined) {
          const unfiledPartner = ["netIncome", "dilutedEps"].find((key) =>
            input.statements?.unfiledSeries?.includes(key as FinancialStatementSeriesKey),
          );
          return missing("diluted-shares-unavailable", [
            "dilutedShares",
            ...(unfiledPartner === undefined
              ? (["netIncome", "dilutedEps"] as const)
              : [unfiledPartner as FinancialStatementSeriesKey]),
          ]);
        }
        if (reportingCurrency === undefined) {
          return missing("reporting-currency-unavailable");
        }
        if (quoteCurrency === undefined) {
          return missing("quote-currency-unavailable");
        }
        if (price === null) {
          return {
            ...missing("price-history-unavailable"),
            ...(input.outsidePriceHistoryWindow
              ? { cause: "outside-price-history-window" as const }
              : {}),
          };
        }
        if (price.currency !== reportingCurrency && fx === undefined) {
          return missing("fx-rate-unavailable");
        }
        const denominator = period[denominatorKey];
        if (denominator === undefined) {
          const keys: readonly FinancialStatementSeriesKey[] =
            denominatorKey === "freeCashFlow"
              ? ["operatingCashFlow", "capitalExpenditure"]
              : [denominatorKey];
          const absent = keys.filter((key) => !lineage.some((row) => row.series === key));
          return missing(`${DENOMINATOR_LABELS[denominatorKey]}-unavailable`, absent);
        }
        if (
          (period.basis === "annual" || period.revenue?.derivation === "FY") &&
          lineage.some(
            (row) =>
              row.artifact === "statements" &&
              !row.periodKey?.startsWith("instant|") &&
              (row.periodStart === undefined ||
                !isYearAligned(row.periodStart, row.periodEnd ?? "")),
          )
        ) {
          return missing("annual input outside 350–380 days");
        }
        if (!Number.isFinite(denominator.value) || denominator.value <= 0) {
          return {
            status: "not-meaningful",
            reason: notMeaningfulReason(denominator.value),
            periodEnd: period.periodEnd,
            inputs: lineage,
          };
        }
        if (
          fundamentals.some(
            (value) => typeof value?.currency === "string" && value.currency !== reportingCurrency,
          )
        ) {
          return missing("incompatible currency");
        }
        const close = price.close * (fx?.rate ?? 1);
        const marketCap = close * (period.dilutedShares?.value ?? 1);
        let numerator = marketCap;
        if (id === "priceToEarnings") {
          numerator = close;
        } else if (id === "enterpriseValueToRevenue") {
          numerator =
            marketCap +
            (period.debt?.value ?? 0) -
            (period.cash?.value ?? 0) +
            (period.enterpriseValueBridge?.value ?? 0);
        }
        const value = numerator / denominator.value;
        return Number.isFinite(value)
          ? { status: "value", value, periodEnd: period.periodEnd, inputs: lineage }
          : missing("non-finite numerator");
      },
    }),
  );
  return evaluateMetricSection(
    `valuation-workbench-${period.basis}-${period.periodEnd}-${publicAt}`,
    `Valuation Workbench ${period.basis.toUpperCase()} ${period.periodEnd} public ${publicAt}`,
    definitions,
    { symbol: input.symbol },
  );
}

export function workbenchMetricRecord(
  section: ReturnType<typeof valuationMetricSection>["section"],
): Readonly<Record<ValuationMetricKey, (typeof section.metrics)[number]>> {
  return Object.fromEntries(section.metrics.map((metric) => [metric.id, metric])) as Readonly<
    Record<ValuationMetricKey, (typeof section.metrics)[number]>
  >;
}
