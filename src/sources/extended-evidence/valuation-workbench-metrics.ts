import { balanceSheetPeriodDivergence } from "./valuation-comps-support";
import { revenueMultipleNotMeaningfulReason } from "./valuation-comps-contract";
import { isYearAligned } from "./financial-statement-selection";
import { DEBT_SCOPE_CAVEAT } from "./financial-statement-definitions";
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
import {
  periodPublicAt,
  transitionMonths,
  type ValuationPeriodInputs,
} from "./valuation-workbench-inputs";
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

const EV_WITHHELD_SERIES: Readonly<Record<string, readonly FinancialStatementSeriesKey[]>> = {
  "cash-unavailable": ["cash"],
  "debt-unavailable": ["debt"],
};

function withheldReason(
  period: ValuationPeriodInputs,
  keys: readonly FinancialStatementSeriesKey[],
):
  | "earlier-share-basis"
  | "restated-after-first-filing"
  | "first-annual-report-unavailable"
  | undefined {
  if (
    keys.some((key) => (period.earlierShareBasis as readonly string[] | undefined)?.includes(key))
  ) {
    return "earlier-share-basis";
  }
  if (period.firstAnnualReportUnavailable === true) {
    return "first-annual-report-unavailable";
  }
  return keys.some((key) => period.restatedAfterFirstFiling?.includes(key))
    ? "restated-after-first-filing"
    : undefined;
}

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
    "((close × diluted shares) + debt + preferred stock + noncontrolling interest + temporary equity - cash - short-term investments) / revenue; preferred, noncontrolling interest and temporary equity at carrying amount",
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
  const sharesBasis =
    period.basis === "ttm" && period.dilutedShares?.derivation !== undefined
      ? `; diluted shares: ${period.dilutedShares.derivation} weighted average, a proxy for a trailing-year count when shorter than a fiscal year`
      : "";
  const enterpriseValueWithheld = (): string | undefined => {
    if (period.cash === undefined) {
      return "cash-unavailable";
    }
    if (period.debtScopeMismatch) {
      return "mixed-scope-debt";
    }
    if (period.debt === undefined) {
      return "debt-unavailable";
    }
    if (period.enterpriseValueBridgeIncomplete) {
      return "ev-bridge-incomplete";
    }
    const mixed = balanceSheetPeriodDivergence({
      cashPeriodEnd: period.cash.periodEnd,
      debtPeriodEnd: period.debt.periodEnd,
    });
    const laggingRow = balanceSheetPeriodDivergence({
      cashPeriodEnd: [period.cash.periodEnd, period.debt.periodEnd].toSorted()[0]!,
      debtPeriodEnd: period.periodEnd,
    });
    return mixed !== undefined || laggingRow !== undefined || period.debtBehindIncompleteInstant
      ? "mixed-period-balance-sheet"
      : undefined;
  };
  const definitions: readonly MetricDefinition[] = METRICS.map(
    ([id, label, formula, denominatorKey]) => ({
      id,
      label,
      unit: "ratio",
      basis: `${period.basis.toUpperCase()}; ${formula}${id === "priceToEarnings" ? "" : sharesBasis}; ${priceBasis}${id === "enterpriseValueToRevenue" && period.debtScopeUnproven ? `; ${DEBT_SCOPE_CAVEAT}` : ""}`,
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
        const evWithheld = enterpriseValueWithheld();
        if (id === "enterpriseValueToRevenue" && evWithheld !== undefined) {
          return missing(evWithheld, EV_WITHHELD_SERIES[evWithheld]);
        }
        const sharesWithheld =
          needsShares && period.dilutedShares === undefined
            ? withheldReason(period, ["dilutedShares"])
            : undefined;
        if (needsShares && period.dilutedShares === undefined && sharesWithheld === undefined) {
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
        if (sharesWithheld !== undefined) {
          return missing(sharesWithheld);
        }
        const denominator = period[denominatorKey];
        if (denominator === undefined) {
          const keys: readonly FinancialStatementSeriesKey[] =
            denominatorKey === "freeCashFlow"
              ? ["operatingCashFlow", "capitalExpenditure"]
              : [denominatorKey];
          const withheld = withheldReason(period, keys);
          if (withheld !== undefined) {
            return missing(withheld);
          }
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
        // One verdict per observation: P/S also yields when the same row's valid EV breaches the ceiling.
        const evAvailable =
          input.depositorySic === undefined &&
          evWithheld === undefined &&
          [period.cash, period.debt, period.enterpriseValueBridge].every(
            (row) => typeof row?.currency !== "string" || row.currency === reportingCurrency,
          );
        const enterpriseValue = evAvailable
          ? marketCap +
            (period.debt?.value ?? 0) -
            (period.cash?.value ?? 0) +
            (period.enterpriseValueBridge?.value ?? 0)
          : undefined;
        let numerator = marketCap;
        if (id === "priceToEarnings") {
          numerator = close;
        } else if (id === "enterpriseValueToRevenue") {
          if (enterpriseValue === undefined) {
            return missing("incompatible currency");
          }
          numerator = enterpriseValue;
        }
        const value = numerator / denominator.value;
        if (!Number.isFinite(value)) {
          return missing("non-finite numerator");
        }
        if (denominatorKey !== "revenue") {
          return { status: "value", value, periodEnd: period.periodEnd, inputs: lineage };
        }
        const floorReason = revenueMultipleNotMeaningfulReason({
          annualizedRevenue: denominator.value,
          marketCap,
        });
        const ceilingReason =
          floorReason === undefined && enterpriseValue !== undefined
            ? revenueMultipleNotMeaningfulReason({
                evToAnnualizedRevenue: enterpriseValue / denominator.value,
              })
            : undefined;
        const revenueMultipleReason = floorReason ?? ceilingReason;
        if (revenueMultipleReason === undefined) {
          return { status: "value", value, periodEnd: period.periodEnd, inputs: lineage };
        }
        return {
          status: "not-meaningful",
          reason: revenueMultipleReason,
          periodEnd: period.periodEnd,
          // P/S yielding to the EV ceiling cites the debt, cash and bridge facts that decided it.
          inputs:
            ceilingReason !== undefined && id === "priceToSales"
              ? [
                  ...lineage,
                  ...[period.cash, period.debt, period.enterpriseValueBridge].flatMap(
                    (row) => row?.lineage ?? [],
                  ),
                ]
              : lineage,
        };
      },
    }),
  );
  const span = transitionMonths(period);
  return evaluateMetricSection(
    `valuation-workbench-${period.basis}-${period.periodEnd}-${publicAt}${span === undefined ? "" : `-${span}m`}`,
    `Valuation Workbench ${period.basis.toUpperCase()} ${period.periodEnd}${span === undefined ? "" : ` (${span} months)`} public ${publicAt}`,
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
