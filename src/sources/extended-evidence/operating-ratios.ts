import {
  type Gate,
  inputsOf,
  type JoinSeries,
  joinedMetric,
  SERIES_LABELS,
  statementInput,
} from "./capital-return";
import type { FinancialStatementFact } from "./financial-statements-contract";
import {
  financialStatementFactForPeriod,
  financialStatementFacts,
  financialStatementSeriesByKey,
} from "./financial-statement-selection";
import {
  evaluateMetricSection,
  type MetricContext,
  type MetricDefinition,
  type MetricOutcome,
  seriesNotFiled,
} from "./metric-engine";

type InvestedCapitalSeries = "stockholdersEquity" | "debt" | "cash";

const ROIC_FLOWS = ["operatingIncome", "incomeTaxExpense", "pretaxIncome"] as const;
const INVESTED_CAPITAL: readonly InvestedCapitalSeries[] = ["stockholdersEquity", "debt", "cash"];

function factOf(
  facts: readonly FinancialStatementFact[],
  keys: readonly JoinSeries[],
  key: JoinSeries,
): FinancialStatementFact | undefined {
  const index = keys.indexOf(key);
  return index === -1 ? undefined : facts[index];
}

function notMeaningful(
  reason: string,
  facts: readonly FinancialStatementFact[],
  keys: readonly JoinSeries[],
): MetricOutcome {
  return {
    status: "not-meaningful",
    reason: `${reason} for the fiscal year ending ${facts[0]!.periodEnd}`,
    periodEnd: facts[0]!.periodEnd,
    inputs: inputsOf(facts, keys),
  };
}

// R2: a filed input at or below the bound makes the ratio not meaningful.
function boundGate(key: JoinSeries, reason: string, inclusive = true): Gate {
  return (_ctx, facts, keys) => {
    const fact = factOf(facts, keys, key);
    return fact !== undefined && (inclusive ? fact.value <= 0 : fact.value < 0)
      ? notMeaningful(reason, facts, keys)
      : undefined;
  };
}

function ratioOf(
  numerator: (facts: readonly FinancialStatementFact[]) => number,
  keys: readonly [JoinSeries, ...JoinSeries[]],
  gate: Gate,
) {
  return joinedMetric(keys, gate, (_ctx, facts) => ({
    status: "value",
    value: numerator(facts) / facts.at(-1)!.value,
    periodEnd: facts[0]!.periodEnd,
    inputs: inputsOf(facts, keys),
  }));
}

function depository(reason: string) {
  return (ctx: MetricContext): string | undefined =>
    ctx.depositorySic === undefined
      ? undefined
      : `depository issuer (SIC ${ctx.depositorySic}): ${reason}`;
}

// R1b: balance-sheet inputs are the instants at the flow anchor's own period end, never a nearby one.
function instantAt(
  ctx: MetricContext,
  key: InvestedCapitalSeries,
  periodEnd: string,
): FinancialStatementFact | undefined {
  const series =
    ctx.statements === undefined ? undefined : financialStatementSeriesByKey(ctx.statements, key);
  const facts = series === undefined ? [] : financialStatementFacts(series);
  const periodKey = `instant|${periodEnd}`;
  return (
    financialStatementFactForPeriod(facts, periodKey, "annual") ??
    financialStatementFactForPeriod(facts, periodKey, "interim")
  );
}

function effectiveTaxRateOf(
  facts: readonly FinancialStatementFact[],
  keys: readonly JoinSeries[],
): number | undefined {
  const tax = factOf(facts, keys, "incomeTaxExpense");
  const pretax = factOf(facts, keys, "pretaxIncome");
  return tax === undefined || pretax === undefined ? undefined : tax.value / pretax.value;
}

const roicGate: Gate = (ctx, facts, keys) => {
  const [anchor] = facts;
  if (anchor === undefined) {
    return undefined;
  }
  const pretaxGate = boundGate("pretaxIncome", "pretax income is zero or negative")(
    ctx,
    facts,
    keys,
  );
  if (pretaxGate !== undefined) {
    return pretaxGate;
  }
  const taxRate = effectiveTaxRateOf(facts, keys);
  if (taxRate !== undefined && (taxRate < 0 || taxRate > 1)) {
    return notMeaningful("effective tax rate is outside 0-100%", facts, keys);
  }
  const filed = INVESTED_CAPITAL.filter((key) => !seriesNotFiled(ctx, key));
  const instants = filed.map((key) => instantAt(ctx, key, anchor.periodEnd));
  const found = instants.flatMap((fact, index) =>
    fact === undefined ? [] : [statementInput(fact, filed[index]!)],
  );
  const inputs = [...inputsOf(facts, keys), ...found];
  const absent = filed.filter((_key, index) => instants[index] === undefined);
  if (absent.length > 0) {
    return {
      status: "missing",
      reason: `no ${absent.map((key) => SERIES_LABELS[key]).join(" or ")} at the fiscal year end ${anchor.periodEnd}`,
      periodEnd: anchor.periodEnd,
      inputs,
    };
  }
  const unfiled = [...ROIC_FLOWS, ...INVESTED_CAPITAL].filter((key) => seriesNotFiled(ctx, key));
  if (unfiled.some((key) => (INVESTED_CAPITAL as readonly string[]).includes(key))) {
    return {
      status: "missing",
      reason: `${unfiled.map((key) => SERIES_LABELS[key]).join(" and ")} not filed by the issuer`,
      cause: "not-filed",
      periodEnd: anchor.periodEnd,
      inputs,
    };
  }
  const [equity, debt, cash] = instants as readonly FinancialStatementFact[];
  return equity!.value + debt!.value - cash!.value <= 0
    ? {
        status: "not-meaningful",
        reason: `invested capital is zero or negative at the fiscal year end ${anchor.periodEnd}`,
        periodEnd: anchor.periodEnd,
        inputs,
      }
    : undefined;
};

function roic(ctx: MetricContext): MetricOutcome {
  return joinedMetric(ROIC_FLOWS, roicGate, (_ctx, facts) => {
    const [operatingIncome] = facts;
    const instants = INVESTED_CAPITAL.map(
      (key) => instantAt(ctx, key, operatingIncome!.periodEnd)!,
    );
    const [equity, debt, cash] = instants;
    return {
      status: "value",
      value:
        (operatingIncome!.value * (1 - effectiveTaxRateOf(facts, ROIC_FLOWS)!)) /
        (equity!.value + debt!.value - cash!.value),
      periodEnd: operatingIncome!.periodEnd,
      inputs: [
        ...inputsOf(facts, ROIC_FLOWS),
        ...instants.map((fact, index) => statementInput(fact, INVESTED_CAPITAL[index]!)),
      ],
    };
  })(ctx);
}

const FISCAL_YEAR = "all from one year-aligned fiscal year";
const EBITDA_PROXY_BASIS = `operating income + depreciation and amortization as filed (an add-back is positive), ${FISCAL_YEAR}; negative depreciation and amortization is not meaningful`;

// A scoped pretax label marks the fallback concept, which excludes equity-method income.
function withPretaxScope(
  basis: string,
  compute: (ctx: MetricContext) => MetricOutcome,
): Pick<MetricDefinition, "basis" | "compute"> {
  return {
    basis,
    compute: (ctx) => {
      const outcome = compute(ctx);
      const pretax = outcome.inputs?.find(
        (input) => input.series === "pretaxIncome" && input.label !== SERIES_LABELS.pretaxIncome,
      );
      return pretax === undefined
        ? outcome
        : { ...outcome, basis: `${basis}; pretax income is ${pretax.label}` };
    },
  };
}

const OPERATING_RATIO_METRICS: readonly MetricDefinition[] = [
  {
    id: "freeCashFlowMargin",
    label: "Free cash flow margin",
    unit: "ratio-percent",
    basis: `(operating cash flow - absolute capital expenditure) / revenue, ${FISCAL_YEAR}; revenue at or below zero is not meaningful`,
    applicable: depository("operating cash flow is not a free cash flow basis"),
    compute: ratioOf(
      ([operatingCashFlow, capitalExpenditure]) =>
        operatingCashFlow!.value - Math.abs(capitalExpenditure!.value),
      ["operatingCashFlow", "capitalExpenditure", "revenue"],
      boundGate("revenue", "revenue is zero or negative"),
    ),
  },
  {
    id: "interestCoverage",
    label: "Interest coverage (operating income / interest expense)",
    unit: "ratio",
    basis: `operating income / interest expense as filed (an expense is positive), ${FISCAL_YEAR}; interest expense at or below zero is not meaningful, an operating loss gives a negative ratio`,
    applicable: depository("interest is an operating cost, not a financing charge"),
    compute: ratioOf(
      ([operatingIncome]) => operatingIncome!.value,
      ["operatingIncome", "interestExpense"],
      boundGate("interestExpense", "interest expense is zero or negative"),
    ),
  },
  {
    id: "ebitdaProxy",
    label: "Operating income + D&A (EBITDA proxy)",
    unit: "currency",
    basis: EBITDA_PROXY_BASIS,
    compute: joinedMetric(
      ["operatingIncome", "depreciationAndAmortization"],
      boundGate("depreciationAndAmortization", "depreciation and amortization is negative", false),
      (_ctx, facts) => ({
        status: "value",
        value: facts[0]!.value + facts[1]!.value,
        ...(facts[0]!.currency !== null ? { currency: facts[0]!.currency } : {}),
        periodEnd: facts[0]!.periodEnd,
        inputs: inputsOf(facts, ["operatingIncome", "depreciationAndAmortization"]),
        ...(facts[1]!.composite === undefined
          ? {}
          : {
              basis: `${EBITDA_PROXY_BASIS}; D&A basis: depreciation + intangible amortization`,
            }),
      }),
    ),
  },
  {
    id: "effectiveTaxRate",
    label: "Effective tax rate",
    unit: "ratio-percent",
    ...withPretaxScope(
      `income tax expense (a benefit is negative) / pretax income from continuing operations, ${FISCAL_YEAR}; not clamped, pretax income at or below zero is not meaningful`,
      ratioOf(
        ([tax]) => tax!.value,
        ["incomeTaxExpense", "pretaxIncome"],
        boundGate("pretaxIncome", "pretax income is zero or negative"),
      ),
    ),
  },
  {
    id: "roic",
    label: "ROIC (operating income after effective tax / period-end invested capital)",
    unit: "ratio-percent",
    ...withPretaxScope(
      `operating income x (1 - income tax expense / pretax income), ${FISCAL_YEAR}, / (stockholders' equity + debt - cash and cash equivalents) at that fiscal year end; an effective tax rate outside 0-100% or invested capital at or below zero is not meaningful`,
      roic,
    ),
    applicable: depository("debt and cash are operating balances, not invested capital"),
  },
];

export function operatingRatiosSection(
  ctx: MetricContext,
): ReturnType<typeof evaluateMetricSection> {
  return evaluateMetricSection(
    "operating-ratios",
    "Operating Ratios",
    OPERATING_RATIO_METRICS,
    ctx,
  );
}
