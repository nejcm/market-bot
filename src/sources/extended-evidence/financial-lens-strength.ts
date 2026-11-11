import { type MetricContext, type MetricDefinition, type MetricOutcome } from "./metric-engine";
import { NET_DEBT_BASIS } from "./enterprise-value-bridge";
import { readNumberMetric, readStringMetric } from "./utils";
import { isFreshPeriodEnd } from "./valuation-comps-support";
import {
  type LensSeries,
  SERIES_LABELS,
  latestFact,
  samePeriodFact,
  factInput,
  periodOf,
  periodEndInput,
  isCurrentPeriod,
  noFact,
  missingPartner,
  secItem,
  valuationItem,
  targetValuationIds,
  valuationOutcome,
  yahooItem,
  quoteCurrencyOf,
  evidenceInput,
  evidenceOutcome,
  summaryPeriod,
  summaryPeriodsMatch,
  chosenInput,
  summaryCurrentness,
  shortTermInvestmentsAt,
  evidenceDisplayNetDebt,
  marketCapInput,
  CURRENCY_MISMATCH_REASON,
  currencyMismatch,
} from "./financial-lens-inputs";

export function instantDefinition(id: string, key: LensSeries, label: string): MetricDefinition {
  return {
    id,
    label,
    unit: "currency",
    basis: "latest reported balance-sheet instant",
    compute: (ctx) => {
      const outcome = latestInstantOutcome(ctx, key, label);
      return outcome.status !== "value" ||
        ctx.asOf === undefined ||
        (outcome.periodEnd !== undefined && isFreshPeriodEnd(outcome.periodEnd, ctx.asOf))
        ? outcome
        : {
            status: "missing",
            reason: `stale ${key} as of ${outcome.periodEnd ?? "an undated period"}`,
            ...(outcome.periodEnd === undefined ? {} : { periodEnd: outcome.periodEnd }),
            inputs: outcome.inputs,
          };
    },
  };
}

function latestInstantOutcome(ctx: MetricContext, key: LensSeries, label: string): MetricOutcome {
  if (ctx.statements === undefined) {
    return evidenceOutcome(secItem(ctx), key, label, "currency", summaryPeriod(ctx, key));
  }
  const fact = latestFact(ctx, key);
  if (fact === undefined) {
    return noFact(ctx, key);
  }
  return {
    status: "value",
    value: fact.value,
    ...periodOf(fact),
    ...(fact.currency !== null ? { currency: fact.currency } : {}),
    inputs: [factInput(fact, key)],
  };
}

export function netDebtDefinition(): MetricDefinition {
  return {
    id: "netDebt",
    label: "Net debt",
    unit: "currency",
    basis: `${NET_DEBT_BASIS} at one balance-sheet instant; long-term investments excluded`,
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const period = summaryPeriod(ctx, "debt");
        const currentness = summaryCurrentness(ctx, "netDebt");
        const value = evidenceDisplayNetDebt(ctx);
        const item = secItem(ctx);
        const valuation = valuationItem(ctx);
        const valuationNetDebt = valuation?.metrics?.netDebt;
        const valuationIds = targetValuationIds(ctx, false);
        const inputs =
          typeof valuationNetDebt === "number" && valuationIds !== undefined
            ? [
                {
                  ...evidenceInput(
                    valuation,
                    "netDebt",
                    "net debt",
                    "currency",
                    valuationNetDebt,
                    period,
                  ),
                  sourceIds: valuationIds,
                },
              ]
            : [
                ...chosenInput(item, "debt", "debt", period),
                ...chosenInput(item, "cash", "cash", period),
                ...chosenInput(item, "shortTermInvestments", "short-term investments", period),
              ];
        if (!currentness.current) {
          return {
            status: "missing",
            reason: `stale net debt as of ${currentness.periodEnd ?? "an undated period"}`,
            ...period,
            inputs,
          };
        }
        const withheld = readStringMetric(item?.metrics, "shortTermInvestmentsIncompleteReason");
        return value === undefined
          ? { status: "missing", reason: withheld ?? "no SEC net debt", ...period, inputs }
          : { status: "value", value, inputs, ...period };
      }
      const anchor = latestFact(ctx, "debt");
      if (anchor === undefined) {
        return noFact(ctx, "debt");
      }
      const cash = samePeriodFact(ctx, anchor, "cash");
      if (cash === undefined) {
        return missingPartner(ctx, "cash", anchor, [factInput(anchor, "debt")]);
      }
      const shortTermInvestments = shortTermInvestmentsAt(ctx, cash);
      const inputs = [
        factInput(anchor, "debt"),
        factInput(cash, "cash"),
        ...shortTermInvestments.inputs,
      ];
      if (!isCurrentPeriod(ctx, anchor.periodEnd)) {
        return {
          status: "missing",
          reason: `stale debt as of ${anchor.periodEnd}`,
          ...periodOf(anchor),
          inputs,
        };
      }
      if (shortTermInvestments.value === undefined) {
        return {
          status: "missing",
          reason: shortTermInvestments.reason ?? "short-term investments unavailable",
          ...periodOf(anchor),
          inputs,
        };
      }
      return {
        status: "value",
        value: anchor.value - cash.value - shortTermInvestments.value,
        ...periodOf(anchor),
        ...(anchor.currency !== null ? { currency: anchor.currency } : {}),
        inputs,
      };
    },
  };
}

export function currentRatioDefinition(): MetricDefinition {
  return {
    id: "currentRatio",
    label: "Current ratio",
    unit: "ratio",
    basis: "current assets / current liabilities at the latest balance-sheet instant",
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const currentAssets = readNumberMetric(secItem(ctx)?.metrics, "currentAssets");
        const currentLiabilities = readNumberMetric(secItem(ctx)?.metrics, "currentLiabilities");
        if (!summaryPeriodsMatch(ctx, "currentAssets", "currentLiabilities")) {
          return { status: "missing", reason: "no same-period SEC current ratio" };
        }
        const value =
          currentAssets === undefined ||
          currentLiabilities === undefined ||
          currentLiabilities === 0
            ? undefined
            : currentAssets / currentLiabilities;
        const period = summaryPeriod(ctx, "currentAssets");
        if (value === undefined) {
          return { status: "missing", reason: "no financial lens current ratio" };
        }
        const currentness = summaryCurrentness(ctx, "currentRatio");
        if (!currentness.current) {
          return {
            status: "missing",
            reason: `stale current ratio as of ${currentness.periodEnd ?? "an undated period"}`,
            ...period,
          };
        }
        return {
          status: "value",
          value,
          inputs: [
            ...chosenInput(secItem(ctx), "currentAssets", "current assets", period),
            ...chosenInput(secItem(ctx), "currentLiabilities", "current liabilities", period),
          ],
          ...period,
        };
      }
      const anchor = latestFact(ctx, "currentAssets");
      if (anchor === undefined) {
        return noFact(ctx, "currentAssets");
      }
      const liabilities = samePeriodFact(ctx, anchor, "currentLiabilities");
      if (liabilities === undefined) {
        return missingPartner(ctx, "currentLiabilities", anchor, [
          factInput(anchor, "currentAssets"),
        ]);
      }
      const inputs = [
        factInput(anchor, "currentAssets"),
        factInput(liabilities, "currentLiabilities"),
      ];
      if (!isCurrentPeriod(ctx, anchor.periodEnd)) {
        return {
          status: "missing",
          reason: `stale current ratio as of ${anchor.periodEnd}`,
          ...periodOf(anchor),
          inputs,
        };
      }
      return liabilities.value <= 0
        ? {
            status: "not-meaningful",
            reason: `${SERIES_LABELS.currentLiabilities} is not positive`,
            ...periodOf(anchor),
            inputs,
          }
        : {
            status: "value",
            value: anchor.value / liabilities.value,
            ...periodOf(anchor),
            inputs,
          };
    },
  };
}

export function debtToEquityDefinition(): MetricDefinition {
  return {
    id: "debtToEquity",
    label: "Debt/equity",
    unit: "ratio",
    basis: "debt / stockholders' equity at the latest balance-sheet instant",
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const debt = readNumberMetric(secItem(ctx)?.metrics, "debt");
        const equity = readNumberMetric(secItem(ctx)?.metrics, "stockholdersEquity");
        if (!summaryPeriodsMatch(ctx, "debt", "stockholdersEquity")) {
          return { status: "missing", reason: "no same-period SEC debt/equity" };
        }
        const value =
          debt === undefined || equity === undefined || equity === 0 ? undefined : debt / equity;
        const period = summaryPeriod(ctx, "debt");
        if (value === undefined) {
          return { status: "missing", reason: "no SEC debt/equity" };
        }
        const currentness = summaryCurrentness(ctx, "debtToEquity");
        if (!currentness.current) {
          return {
            status: "missing",
            reason: `stale debt/equity as of ${currentness.periodEnd ?? "an undated period"}`,
            ...period,
          };
        }
        return {
          status: "value",
          value,
          inputs: [
            ...chosenInput(secItem(ctx), "debt", "debt", period),
            ...chosenInput(secItem(ctx), "stockholdersEquity", "stockholders' equity", period),
          ],
          ...period,
        };
      }
      const anchor = latestFact(ctx, "debt");
      if (anchor === undefined) {
        return noFact(ctx, "debt");
      }
      const equity = samePeriodFact(ctx, anchor, "stockholdersEquity");
      if (equity === undefined) {
        return missingPartner(ctx, "stockholdersEquity", anchor, [factInput(anchor, "debt")]);
      }
      const inputs = [factInput(anchor, "debt"), factInput(equity, "stockholdersEquity")];
      if (!isCurrentPeriod(ctx, anchor.periodEnd)) {
        return {
          status: "missing",
          reason: `stale debt as of ${anchor.periodEnd}`,
          ...periodOf(anchor),
          inputs,
        };
      }
      return equity.value <= 0
        ? {
            status: "not-meaningful",
            reason: `${SERIES_LABELS.stockholdersEquity} is not positive`,
            ...periodOf(anchor),
            inputs,
          }
        : {
            status: "value",
            value: anchor.value / equity.value,
            ...periodOf(anchor),
            inputs,
          };
    },
  };
}

export function marketLeverageDefinition(
  id: "debtToMarketCap" | "netDebtToMarketCap",
): MetricDefinition {
  return {
    id,
    label: id === "debtToMarketCap" ? "Debt/market cap" : "Net debt/market cap",
    unit: "ratio-percent",
    basis:
      id === "debtToMarketCap"
        ? "debt at the latest balance-sheet instant / quote market cap"
        : "net debt at the latest balance-sheet instant / quote market cap",
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const value = readNumberMetric(valuationItem(ctx)?.metrics, id);
        const period = summaryPeriod(ctx, "debt");
        if (value === undefined) {
          return { status: "missing", reason: `no valuation ${id}` };
        }
        const currentness = summaryCurrentness(ctx, id);
        if (!currentness.current) {
          return {
            status: "missing",
            reason: `stale ${id} as of ${currentness.periodEnd ?? "an undated period"}`,
            ...period,
          };
        }
        return valuationOutcome(ctx, id, id, "ratio-percent", period);
      }
      const marketCap = marketCapInput(ctx);
      const anchor = latestFact(ctx, "debt");
      if (anchor === undefined) {
        return noFact(ctx, "debt");
      }
      const cash = id === "netDebtToMarketCap" ? samePeriodFact(ctx, anchor, "cash") : undefined;
      const shortTermInvestments =
        cash === undefined ? undefined : shortTermInvestmentsAt(ctx, cash);
      const netDebt =
        cash === undefined || shortTermInvestments?.value === undefined
          ? undefined
          : anchor.value - cash.value - shortTermInvestments.value;
      const numerator = id === "debtToMarketCap" ? anchor.value : netDebt;
      const inputs = [
        ...(marketCap === undefined ? [] : [marketCap]),
        factInput(anchor, "debt"),
        ...(cash === undefined ? [] : [factInput(cash, "cash")]),
        ...(shortTermInvestments?.inputs ?? []),
      ];
      if (numerator === undefined && shortTermInvestments?.reason !== undefined) {
        return {
          status: "missing",
          reason: shortTermInvestments.reason,
          ...periodOf(anchor),
          inputs,
        };
      }
      if (numerator === undefined) {
        return missingPartner(ctx, "cash", anchor, inputs);
      }
      if (!isCurrentPeriod(ctx, anchor.periodEnd)) {
        return {
          status: "missing",
          reason: `stale debt as of ${anchor.periodEnd}`,
          ...periodOf(anchor),
          inputs,
        };
      }
      if (marketCap === undefined || typeof marketCap.value !== "number" || marketCap.value <= 0) {
        return {
          status: "missing",
          reason: "no quote market cap",
          ...periodOf(anchor),
          inputs,
        };
      }
      if (currencyMismatch(marketCap, [anchor, cash])) {
        return {
          status: "missing",
          reason: CURRENCY_MISMATCH_REASON,
          ...periodOf(anchor),
          inputs,
        };
      }
      return {
        status: "value",
        value: numerator / marketCap.value,
        ...periodOf(anchor),
        inputs,
      };
    },
  };
}

export function payoutRatioDefinition(): MetricDefinition {
  return {
    id: "payoutRatio",
    label: "Payout ratio",
    unit: "ratio-percent",
    basis: "dividends paid / net income of the same period, or a Yahoo fallback",
    compute: (ctx) => {
      const yahoo = yahooItem(ctx);
      const yahooRate = readNumberMetric(yahoo?.metrics, "trailingAnnualDividendRate");
      const yahooEps = readNumberMetric(yahoo?.metrics, "epsTrailingTwelveMonths");
      const yahooPeriod = periodEndInput(yahoo?.observedAt);
      const quoteCurrency = quoteCurrencyOf(ctx);
      const rateCurrency = readStringMetric(yahoo?.metrics, "financialCurrency");
      const yahooInputs =
        yahoo === undefined || yahooRate === undefined || yahooEps === undefined
          ? undefined
          : [
              {
                ...evidenceInput(
                  yahoo,
                  "trailingAnnualDividendRate",
                  "trailing dividend rate",
                  "currency",
                  yahooRate,
                  yahooPeriod,
                ),
                currency: rateCurrency ?? quoteCurrency,
              },
              {
                ...evidenceInput(
                  yahoo,
                  "epsTrailingTwelveMonths",
                  "trailing EPS",
                  "number",
                  yahooEps,
                  yahooPeriod,
                ),
                currency: quoteCurrency,
              },
            ];
      const yahooOutcome = ((): MetricOutcome | undefined => {
        if (yahooInputs === undefined || yahooRate === undefined || yahooEps === undefined) {
          return undefined;
        }
        if (rateCurrency !== undefined && rateCurrency !== quoteCurrency) {
          return {
            status: "missing",
            reason: `Yahoo trailing dividend rate is in ${rateCurrency} and trailing EPS in ${quoteCurrency}; not divided across currencies`,
            inputs: yahooInputs,
            ...yahooPeriod,
          };
        }
        if (yahooEps <= 0) {
          return {
            status: "not-meaningful",
            reason: "Yahoo trailing EPS is zero or negative",
            inputs: yahooInputs,
            ...yahooPeriod,
          };
        }
        return {
          status: "value",
          value: yahooRate / yahooEps,
          inputs: yahooInputs,
          ...yahooPeriod,
        };
      })();
      if (ctx.statements === undefined) {
        const item = secItem(ctx);
        const dividendsPaid = readNumberMetric(item?.metrics, "dividendsPaid");
        const netIncome = readNumberMetric(item?.metrics, "netIncome");
        if (
          dividendsPaid !== undefined &&
          netIncome !== undefined &&
          !summaryPeriodsMatch(ctx, "dividendsPaid", "netIncome")
        ) {
          return { status: "missing", reason: "no same-period SEC payout ratio" };
        }
        const nonPositiveIncomePeriodEnd =
          dividendsPaid !== undefined && netIncome !== undefined && netIncome <= 0
            ? (readStringMetric(item?.metrics, "netIncomePeriodEnd") ?? "undated")
            : undefined;
        const value =
          dividendsPaid === undefined || netIncome === undefined || netIncome <= 0
            ? undefined
            : Math.abs(dividendsPaid) / netIncome;
        const period = summaryPeriod(ctx, "dividendsPaid");
        const stale =
          period.periodEnd !== undefined &&
          ctx.asOf !== undefined &&
          !isFreshPeriodEnd(period.periodEnd, ctx.asOf);
        if (value !== undefined && nonPositiveIncomePeriodEnd === undefined && !stale) {
          return {
            status: "value",
            value,
            inputs: [
              ...chosenInput(item, "dividendsPaid", "dividends paid", period),
              ...chosenInput(item, "netIncome", "net income", period),
            ],
            ...period,
          };
        }
        if (yahooOutcome !== undefined) {
          return yahooOutcome;
        }
        const inputs = [
          ...chosenInput(item, "dividendsPaid", "dividends paid", period),
          ...chosenInput(item, "netIncome", "net income", period),
        ];
        if (stale) {
          return {
            status: "missing",
            reason: `stale payout ratio as of ${period.periodEnd ?? "an undated period"}`,
            ...period,
            inputs,
          };
        }
        return nonPositiveIncomePeriodEnd === undefined
          ? { status: "missing", reason: "no payout ratio inputs", ...period, inputs }
          : {
              status: "not-meaningful",
              reason: `net income is zero or negative for the period ending ${nonPositiveIncomePeriodEnd}`,
              ...period,
              inputs,
            };
      }
      const dividend = latestFact(ctx, "dividendsPaid");
      if (dividend === undefined) {
        return yahooOutcome ?? noFact(ctx, "dividendsPaid");
      }
      const income = samePeriodFact(ctx, dividend, "netIncome");
      const inputs = [
        factInput(dividend, "dividendsPaid"),
        ...(income === undefined ? [] : [factInput(income, "netIncome")]),
      ];
      if (income === undefined) {
        return yahooOutcome ?? missingPartner(ctx, "netIncome", dividend, inputs);
      }
      if (ctx.asOf !== undefined && !isFreshPeriodEnd(dividend.periodEnd, ctx.asOf)) {
        return (
          yahooOutcome ?? {
            status: "missing",
            reason: `stale payout ratio as of ${dividend.periodEnd}`,
            ...periodOf(dividend),
            inputs,
          }
        );
      }
      if (income.value <= 0) {
        return (
          yahooOutcome ?? {
            status: "not-meaningful",
            reason: `net income is zero or negative for the period ending ${dividend.periodEnd}`,
            ...periodOf(dividend),
            inputs,
          }
        );
      }
      return {
        status: "value",
        value: Math.abs(dividend.value) / income.value,
        ...periodOf(dividend),
        inputs,
      };
    },
  };
}

export function dividendYieldDefinition(): MetricDefinition {
  return {
    id: "dividendYield",
    label: "Dividend yield",
    unit: "whole-percent",
    basis: "Yahoo Finance forward indicated dividend yield",
    compute: (ctx) =>
      evidenceOutcome(
        yahooItem(ctx),
        "dividendYield",
        "dividend yield",
        "whole-percent",
        periodEndInput(yahooItem(ctx)?.observedAt),
      ),
  };
}

export function financingCurrentnessDefinitions(ctx: MetricContext): readonly MetricDefinition[] {
  const unreconciled = ctx.subsequentFinancing?.events.filter((event) => !event.reconciled) ?? [];
  if (unreconciled.length === 0) {
    return [];
  }
  const [first] = unreconciled;
  return [
    {
      id: "unreconciledFinancingEvents",
      label: "Unreconciled post-period financing events",
      unit: "number",
      basis: "post-period financing events not yet reconciled to a later filed statement",
      compute: () => ({
        status: "value",
        value: unreconciled.length,
        inputs: [
          {
            label: "unreconciled financing events",
            value: unreconciled.length,
            artifact: "subsequentFinancing",
            key: "events",
            unit: "number",
            ...(first !== undefined ? { periodEnd: first.eventDate } : {}),
            sourceIds: ctx.subsequentFinancing?.sourceIds ?? [],
          },
        ],
        ...(first !== undefined ? { periodEnd: first.eventDate } : {}),
      }),
    },
  ];
}
