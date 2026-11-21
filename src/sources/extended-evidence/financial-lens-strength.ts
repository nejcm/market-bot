import {
  sameCurrency,
  type MetricContext,
  type MetricDefinition,
  type MetricOutcome,
} from "./metric-engine";
import { NET_DEBT_BASIS } from "./enterprise-value-bridge";
import { readNumberMetric, readStringMetric } from "./utils";
import { isFreshPeriodEnd } from "../../config/shared";
import {
  type LensSeries,
  SERIES_LABELS,
  latestFact,
  eligibleFacts,
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
  evidenceInput,
  evidenceOutcome,
  summaryPeriod,
  summaryPeriodsMatch,
  chosenInput,
  summaryCurrentness,
  shortTermInvestmentsAt,
  evidenceDisplayNetDebt,
  marketCapInput,
  currencyMismatchReason,
  annualFlow,
  annualizeSummary,
} from "./financial-lens-inputs";
import { operatingCashFlowScope } from "./financial-lens-quality";
import {
  conceptScope,
  isContinuingScope,
  scopedLabel,
  SPECIAL_DIVIDENDS_BASIS,
} from "./financial-statement-definitions";
import { isYearAligned, latestFinancialStatementFact } from "./financial-statement-selection";
import type { FinancialStatementFact } from "./financial-statements-contract";
import { staleAnchor } from "./capital-return";
import { REIT_SIC } from "./industry-classification";
import { PAYOUT_CEILING, payoutScope, payoutScopeAmbiguity } from "./payout-basis";
import { formatRatioPercent } from "./percent-format";

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

const LIQUIDITY_BASIS =
  "cash and cash equivalents + short-term investments at the latest balance-sheet instant; long-term investments excluded";
const OPERATING_CASH_FLOW_BASIS = "annual or reconciled TTM operating cash flow";
const NO_ANNUAL_FLOW_REASON =
  "latest operating cash flow is neither a full fiscal year nor a reconciled TTM";
const RUNWAY_BASIS =
  "years of cash + short-term investments at the trailing operating cash outflow, both ending on one date; a derived observation at the reported rate, not a forecast of spending or financing";

function summaryLiquidityOutcome(ctx: MetricContext): MetricOutcome {
  const item = secItem(ctx);
  const cash = readNumberMetric(item?.metrics, "cash");
  const shortTermInvestments = readNumberMetric(item?.metrics, "shortTermInvestments");
  const period = summaryPeriod(ctx, "cash");
  const inputs = [
    ...chosenInput(item, "cash", "cash", period),
    ...chosenInput(item, "shortTermInvestments", "short-term investments", period),
  ];
  if (cash === undefined) {
    return { status: "missing", reason: "no SEC cash", ...period, inputs };
  }
  const currentness = summaryCurrentness(ctx, "liquidity");
  if (!currentness.current) {
    return {
      status: "missing",
      reason: `stale cash as of ${currentness.periodEnd ?? "an undated period"}`,
      ...period,
      inputs,
    };
  }
  if (shortTermInvestments === undefined) {
    return {
      status: "missing",
      reason:
        readStringMetric(item?.metrics, "shortTermInvestmentsIncompleteReason") ??
        "no SEC short-term investments",
      ...period,
      inputs,
    };
  }
  // Summary SEC metrics read USD-unit facts only.
  return {
    status: "value",
    value: cash + shortTermInvestments,
    currency: "USD",
    ...period,
    inputs,
  };
}

function liquidityOutcome(ctx: MetricContext): MetricOutcome {
  if (ctx.statements === undefined) {
    return summaryLiquidityOutcome(ctx);
  }
  const cash = latestFact(ctx, "cash");
  if (cash === undefined) {
    return noFact(ctx, "cash");
  }
  const shortTermInvestments = shortTermInvestmentsAt(ctx, cash);
  const inputs = [factInput(cash, "cash"), ...shortTermInvestments.inputs];
  if (!isCurrentPeriod(ctx, cash.periodEnd)) {
    return {
      status: "missing",
      reason: `stale cash as of ${cash.periodEnd}`,
      ...periodOf(cash),
      inputs,
    };
  }
  if (shortTermInvestments.value === undefined) {
    return {
      status: "missing",
      reason: shortTermInvestments.reason ?? "short-term investments unavailable",
      ...periodOf(cash),
      inputs,
    };
  }
  if (shortTermInvestments.inputs.some(({ currency }) => !sameCurrency(currency, cash.currency))) {
    return {
      status: "missing",
      reason: `short-term investments are not filed in cash's currency ${cash.currency ?? "(undeclared)"} at ${cash.periodEnd}`,
      ...periodOf(cash),
      inputs,
    };
  }
  return {
    status: "value",
    value: cash.value + shortTermInvestments.value,
    ...periodOf(cash),
    ...(cash.currency !== null ? { currency: cash.currency } : {}),
    inputs,
  };
}

function summaryOperatingCashFlowOutcome(ctx: MetricContext): MetricOutcome {
  const item = secItem(ctx);
  const value = readNumberMetric(item?.metrics, "operatingCashFlow");
  if (value === undefined) {
    return { status: "missing", reason: "no SEC operating cash flow" };
  }
  const period = summaryPeriod(ctx, "operatingCashFlow");
  const inputs = [
    evidenceInput(item, "operatingCashFlow", "operating cash flow", "currency", value, period),
  ];
  const currentness = summaryCurrentness(ctx, "trailingOperatingCashFlow");
  if (!currentness.current) {
    return {
      status: "missing",
      reason: `stale operating cash flow as of ${currentness.periodEnd ?? "an undated period"}`,
      ...period,
      inputs,
    };
  }
  const annual = annualizeSummary(ctx, "operatingCashFlow", value);
  if (annual === undefined || annual.annualizedFrom !== undefined) {
    return { status: "missing", reason: NO_ANNUAL_FLOW_REASON, ...period, inputs };
  }
  // Summary SEC metrics read USD-unit facts only.
  return { status: "value", value, currency: "USD", ...period, inputs };
}

function trailingOperatingCashFlowOutcome(ctx: MetricContext): MetricOutcome {
  if (ctx.statements === undefined) {
    return summaryOperatingCashFlowOutcome(ctx);
  }
  const anchor = latestFact(ctx, "operatingCashFlow");
  if (anchor === undefined) {
    return noFact(ctx, "operatingCashFlow");
  }
  const flow = annualFlow(ctx, anchor, "operatingCashFlow");
  // A span that merely rounds to 12 months is not a fiscal year; only a filed FY or a reconciled TTM is.
  if (
    flow === undefined ||
    flow.annualizedFrom !== undefined ||
    (flow.ttmComponents === undefined && anchor.periodType !== "annual")
  ) {
    return {
      status: "missing",
      reason: NO_ANNUAL_FLOW_REASON,
      ...periodOf(anchor),
      inputs: [factInput(anchor, "operatingCashFlow")],
    };
  }
  const legScopes = new Set(flow.ttmComponents?.map(({ concept }) => conceptScope(concept)));
  if (legScopes.size > 1) {
    return {
      status: "missing",
      reason: "TTM operating cash flow legs mix continuing-operations and total-operations scope",
      ...flow.period,
      inputs: [flow.input],
    };
  }
  if (!isCurrentPeriod(ctx, anchor.periodEnd)) {
    return {
      status: "missing",
      reason: `stale operating cash flow as of ${anchor.periodEnd}`,
      ...flow.period,
      inputs: [flow.input],
    };
  }
  return {
    status: "value",
    value: flow.value,
    ...flow.period,
    ...(anchor.currency !== null ? { currency: anchor.currency } : {}),
    inputs: [flow.input],
  };
}

export function liquidityDefinition(): MetricDefinition {
  return {
    id: "liquidity",
    label: "Cash + short-term investments",
    unit: "currency",
    basis: LIQUIDITY_BASIS,
    compute: liquidityOutcome,
  };
}

export function trailingOperatingCashFlowDefinition(ctx: MetricContext): MetricDefinition {
  const scope = operatingCashFlowScope(ctx);
  return {
    id: "trailingOperatingCashFlow",
    label: scopedLabel(
      "Operating cash flow (trailing)",
      isContinuingScope(scope) ? scope : undefined,
    ),
    unit: "currency",
    basis: OPERATING_CASH_FLOW_BASIS,
    cashFlowBased: true,
    compute: trailingOperatingCashFlowOutcome,
  };
}

// Runway exists only while operating cash flow burns; a self-funding issuer gets no row.
export function cashRunwayDefinitions(ctx: MetricContext): readonly MetricDefinition[] {
  const flow = trailingOperatingCashFlowOutcome(ctx);
  if (flow.status !== "value" || typeof flow.value !== "number" || flow.value >= 0) {
    return [];
  }
  const burn = -flow.value;
  const period = periodEndInput(flow.periodEnd);
  return [
    {
      id: "cashRunwayYears",
      label: "Cash runway at trailing operating cash outflow (years)",
      unit: "number",
      basis: RUNWAY_BASIS,
      cashFlowBased: true,
      compute: () => {
        const liquidity = liquidityOutcome(ctx);
        const inputs = [...(liquidity.inputs ?? []), ...flow.inputs];
        if (liquidity.status !== "value" || typeof liquidity.value !== "number") {
          return { ...liquidity, inputs };
        }
        if (isContinuingScope(operatingCashFlowScope(ctx))) {
          return {
            status: "missing",
            reason:
              "operating cash flow covers continuing operations only while cash + short-term investments is issuer-wide",
            ...period,
            inputs,
          };
        }
        if (liquidity.periodEnd !== flow.periodEnd) {
          return {
            status: "missing",
            reason: `cash and short-term investments (${liquidity.periodEnd ?? "undated"}) and operating cash flow (${flow.periodEnd ?? "undated"}) end on different dates`,
            ...period,
            inputs,
          };
        }
        if (!sameCurrency(liquidity.currency, flow.currency)) {
          return {
            status: "missing",
            reason: "cash and operating cash flow have different or undeclared currencies",
            ...period,
            inputs,
          };
        }
        return { status: "value", value: liquidity.value / burn, ...period, inputs };
      },
    },
  ];
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
      const mismatch = currencyMismatchReason(marketCap.currency, [
        anchor.currency,
        ...(cash === undefined ? [] : [cash.currency]),
      ]);
      if (mismatch !== undefined) {
        return {
          status: "missing",
          reason: mismatch,
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

const PAYOUT_WINDOW_YEARS = 3;

function scopeGap(periodEnd: string, reason: string | undefined): string | undefined {
  return reason === undefined ? undefined : `fiscal year ending ${periodEnd}: ${reason}`;
}

function annualFacts(ctx: MetricContext, key: "dividendsPaid" | "netIncome") {
  return eligibleFacts(ctx, key).filter((fact) => fact.periodType === "annual");
}

function factAt(facts: readonly FinancialStatementFact[], periodEnd: string) {
  return latestFinancialStatementFact(facts.filter((fact) => fact.periodEnd === periodEnd));
}

// The window is the latest filed fiscal year and the two before it; a year without a dividend fact is a gap, never skipped.
function cumulativePayoutOutcome(ctx: MetricContext): MetricOutcome {
  const { statements } = ctx;
  if (statements === undefined || eligibleFacts(ctx, "dividendsPaid").length === 0) {
    return noFact(ctx, "dividendsPaid");
  }
  const dividends = annualFacts(ctx, "dividendsPaid");
  const incomes = annualFacts(ctx, "netIncome");
  const fiscalYears = [...dividends, ...incomes];
  const anchor = latestFinancialStatementFact(fiscalYears);
  if (anchor === undefined) {
    return { status: "missing", reason: "no annual dividends paid or net income filed" };
  }
  const window = [anchor];
  for (let later = anchor; window.length < PAYOUT_WINDOW_YEARS; ) {
    const prior = latestFinancialStatementFact(
      fiscalYears.filter((fact) => isYearAligned(fact.periodEnd, later.periodEnd)),
    );
    if (prior === undefined) {
      break;
    }
    window.push(prior);
    later = prior;
  }
  const years = window.map(({ periodEnd }) => {
    const dividend = factAt(dividends, periodEnd);
    const income = factAt(incomes, periodEnd);
    return {
      periodEnd,
      dividend,
      income,
      scope:
        dividend === undefined || income === undefined
          ? undefined
          : payoutScope(statements, dividend, income),
    };
  });
  const anyBounded = years.some(({ scope }) => scope?.status === "bounded");
  const inputs = years.flatMap(({ dividend, income, scope }) => [
    ...(dividend === undefined ? [] : [factInput(dividend, "dividendsPaid")]),
    ...(income === undefined ? [] : [factInput(income, "netIncome")]),
    ...(anyBounded && scope?.status !== "withheld" && scope?.consolidated !== undefined
      ? [factInput(scope.consolidated, "consolidatedNetIncome")]
      : []),
  ]);
  const period = periodOf(anchor);
  const missing = (reason: string, cause?: "insufficient-history"): MetricOutcome => ({
    status: "missing",
    reason,
    ...(cause === undefined ? {} : { cause }),
    ...period,
    inputs,
  });
  const stale = staleAnchor(ctx, "fiscal year", anchor.periodEnd);
  if (stale !== undefined) {
    return missing(stale);
  }
  const yearGap = (year: (typeof years)[number] | undefined) => {
    if (year === undefined) {
      return undefined;
    }
    if (year.dividend === undefined) {
      return `no annual dividends paid for the fiscal year ending ${year.periodEnd}`;
    }
    if (year.income === undefined) {
      return `no same-period net income for the fiscal year ending ${year.periodEnd}`;
    }
    return year.scope?.status === "withheld"
      ? scopeGap(year.periodEnd, year.scope.reason)
      : undefined;
  };
  // Both scope bounds must land on the same side of the ceiling, or the check cannot be judged.
  const bounds = (span: typeof years) => {
    const paid = span.reduce((sum, { dividend }) => sum + Math.abs(dividend!.value), 0);
    const parent = span.reduce((sum, { income }) => sum + income!.value, 0);
    const consolidated = span.reduce(
      (sum, { income, scope }) =>
        sum + (scope?.status === "bounded" ? scope.consolidated.value : income!.value),
      0,
    );
    const bounded = span.find(({ scope }) => scope?.status === "bounded");
    if (bounded === undefined || paid === 0 || parent <= 0) {
      return { basis: undefined, gap: undefined };
    }
    const alternate = consolidated > 0 ? paid / consolidated : undefined;
    if (
      alternate === undefined ||
      paid / parent <= PAYOUT_CEILING !== alternate <= PAYOUT_CEILING
    ) {
      return {
        basis: undefined,
        gap: scopeGap(bounded.periodEnd, payoutScopeAmbiguity(bounded.dividend!.concept)),
      };
    }
    return {
      basis: `dividends as filed under ${bounded.dividend!.concept}, which may include distributions to noncontrolling interests; ${formatRatioPercent(alternate)} against consolidated net income`,
      gap: undefined,
    };
  };
  if (new Set(fiscalYears.map((fact) => fact.periodEnd)).size < PAYOUT_WINDOW_YEARS) {
    const latestGap = yearGap(years[0]);
    const latestBounds = latestGap === undefined ? bounds(years.slice(0, 1)) : undefined;
    const gap = latestGap ?? latestBounds?.gap;
    const alone = `the payout check reads the fiscal year ending ${anchor.periodEnd} alone`;
    return gap === undefined
      ? missing(
          [
            `fewer than ${String(PAYOUT_WINDOW_YEARS)} filed fiscal years`,
            alone,
            latestBounds?.basis,
          ]
            .filter((part) => part !== undefined)
            .join("; "),
          "insufficient-history",
        )
      : missing(`fewer than ${String(PAYOUT_WINDOW_YEARS)} filed fiscal years; ${gap}`);
  }
  if (years.length < PAYOUT_WINDOW_YEARS) {
    return missing(`no annual statements for the fiscal year before ${years.at(-1)!.periodEnd}`);
  }
  const gap = yearGap(
    years.find(({ dividend }) => dividend === undefined) ??
      years.find(({ income }) => income === undefined),
  );
  if (gap !== undefined) {
    return missing(gap);
  }
  const paid = years.reduce((sum, { dividend }) => sum + Math.abs(dividend!.value), 0);
  if (paid === 0) {
    return { status: "value", value: 0, ...period, inputs };
  }
  const scope = years.map(yearGap).find((reason) => reason !== undefined);
  if (scope !== undefined) {
    return missing(scope);
  }
  const loss = years.find(({ income }) => income!.value <= 0);
  if (loss !== undefined) {
    return {
      status: "not-meaningful",
      reason: `net income is zero or negative for the fiscal year ending ${loss.periodEnd}`,
      ...period,
      inputs,
    };
  }
  const scopeBounds = bounds(years);
  if (scopeBounds.gap !== undefined) {
    return missing(scopeBounds.gap);
  }
  const earned = years.reduce((sum, { income }) => sum + income!.value, 0);
  return {
    status: "value",
    value: paid / earned,
    ...period,
    inputs,
    ...(scopeBounds.basis === undefined
      ? {}
      : { basis: `${CUMULATIVE_PAYOUT_BASIS}; ${scopeBounds.basis}` }),
  };
}

const CUMULATIVE_PAYOUT_BASIS = `sum of dividends paid / sum of net income attributable to the parent over the ${String(PAYOUT_WINDOW_YEARS)} year-aligned fiscal years ending with the latest filed one; dividends paid ${SPECIAL_DIVIDENDS_BASIS}; withheld where noncontrolling distributions cannot be excluded`;

export function cumulativePayoutRatioDefinition(): MetricDefinition {
  return {
    id: "payoutRatio3y",
    label: "Payout ratio (3y cumulative)",
    unit: "ratio-percent",
    basis: CUMULATIVE_PAYOUT_BASIS,
    applicable: (ctx) =>
      ctx.secIssuer?.sic === REIT_SIC
        ? `REIT issuer (SIC ${REIT_SIC}): payout is measured against FFO/AFFO, not net income; not assessed`
        : undefined,
    compute: cumulativePayoutOutcome,
  };
}

export function payoutRatioDefinition(): MetricDefinition {
  return {
    id: "payoutRatio",
    label: "Payout ratio",
    unit: "ratio-percent",
    basis: `dividends paid / net income of the same period, or a Yahoo fallback; ${SPECIAL_DIVIDENDS_BASIS}`,
    compute: (ctx) => {
      const yahoo = yahooItem(ctx);
      const yahooRate = readNumberMetric(yahoo?.metrics, "trailingAnnualDividendRate");
      const yahooEps = readNumberMetric(yahoo?.metrics, "epsTrailingTwelveMonths");
      const yahooPeriod = periodEndInput(yahoo?.observedAt);
      const quoteCurrency = ctx.snapshot?.identity?.quoteCurrency;
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
                ...(rateCurrency === undefined ? {} : { currency: rateCurrency }),
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
                ...(quoteCurrency === undefined ? {} : { currency: quoteCurrency }),
              },
            ];
      const yahooOutcome = ((): MetricOutcome | undefined => {
        if (yahooInputs === undefined || yahooRate === undefined || yahooEps === undefined) {
          return undefined;
        }
        if (!sameCurrency(rateCurrency, quoteCurrency)) {
          return {
            status: "missing",
            reason: `Yahoo trailing dividend rate is in ${rateCurrency ?? "an undeclared currency"} and trailing EPS in ${quoteCurrency ?? "an undeclared currency"}; not divided across currencies`,
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
