import {
  type Gate,
  inputsOf,
  type JoinSeries,
  joinedMetric,
  SERIES_LABELS,
  statementInput,
} from "./capital-return";
import { NEGATIVE_CAPEX_REASON } from "./financial-statement-definitions";
import { shortTermInvestmentsAt } from "./financial-lens-sections";
import type { SecIssuerRegistration } from "./industry-classification";
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
  type MetricInput,
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

// A filed input at or below the bound makes the ratio not meaningful.
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

// Balance-sheet inputs are the instants at the flow anchor's own period end, never a nearby one.
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

const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(
    " ",
  ),
);

type StatutoryRate =
  | { readonly rate: number; readonly basis: string; readonly input: MetricInput }
  | { readonly reason: string };

const REIT_SIC = "6798";
const NON_CORPORATE_NAME = /\b(?:L\.?P\.?|L\.?L\.?C\.?|TRUST|PARTNERS)$/iu;

function passThroughReason(issuer: SecIssuerRegistration | undefined): string | undefined {
  if (issuer?.sic === REIT_SIC) {
    return "the issuer files under SIC 6798 (REIT), so corporate tax treatment is unverified";
  }
  const name = issuer?.entityName?.replace(/\s*\/[A-Z]{2}\/?\s*$/u, "").replace(/[\s,.]+$/u, "");
  return name !== undefined && NON_CORPORATE_NAME.test(name)
    ? `the issuer name (${issuer!.entityName}) indicates a partnership, LLC or trust`
    : undefined;
}

function corporateIssuerReason(issuer: SecIssuerRegistration | undefined): string | undefined {
  const state = issuer?.stateOfIncorporation;
  if (state === undefined) {
    return "state of incorporation was not collected";
  }
  if (!US_STATES.has(state)) {
    return `the issuer is not incorporated in a US state (${state})`;
  }
  if (issuer?.sic === undefined) {
    return "SIC was not collected, so corporate tax treatment is unverified";
  }
  if (issuer.entityName === undefined) {
    return "the issuer name was not collected, so corporate tax treatment is unverified";
  }
  return passThroughReason(issuer);
}

// The filer's own reconciliation rate for the same fiscal year beats an inferred federal rate.
function taggedStatutoryRateOf(
  ctx: MetricContext,
  anchor: FinancialStatementFact,
  prefix: string,
): StatutoryRate | undefined {
  const tagged = ctx.statements?.statutoryTaxRate?.find(
    (fact) => fact.periodKey === anchor.periodKey,
  );
  if (tagged === undefined) {
    return undefined;
  }
  const passThrough = passThroughReason(ctx.secIssuer);
  if (tagged.value <= 0 || tagged.value >= 1 || passThrough !== undefined) {
    return {
      reason: `${prefix} ${passThrough ?? `the filer-tagged statutory rate (${String(tagged.value)}) is not between 0 and 1`}`,
    };
  }
  const percent = String(Math.round(tagged.value * 1000) / 10);
  return {
    rate: tagged.value,
    basis: `NOPAT at the ${percent}% statutory rate the filer tags in its tax rate reconciliation (accession ${tagged.accessionNumber ?? "unknown"}) because the effective tax rate is outside 0-100%`,
    input: {
      label: "statutory income tax rate",
      value: tagged.value,
      artifact: "statements",
      key: "statutoryTaxRate",
      periodType: "annual",
      ...(tagged.periodStart === undefined ? {} : { periodStart: tagged.periodStart }),
      periodEnd: tagged.periodEnd,
      periodKey: tagged.periodKey,
      unit: tagged.unit,
      sourceIds: tagged.sourceIds,
    },
  };
}

// A 52/53-week year is deemed to begin on the nearest month's first day (Treas. Reg. 1.441-2(e)).
function usStatutoryRateFor(start: string, end: string): number | undefined {
  if (start >= "2017-12-25") {
    return 0.21;
  }
  return end <= "2018-01-07" && start >= "1993-01-01" ? 0.35 : undefined;
}

// Damodaran: NOPAT uses the marginal rate when the effective rate is distorted; TCJA set 21% for tax years beginning after 2017.
function usStatutoryRateOf(ctx: MetricContext, anchor: FinancialStatementFact): StatutoryRate {
  const prefix = "effective tax rate is outside 0-100% and";
  const tagged = taggedStatutoryRateOf(ctx, anchor, prefix);
  if (tagged !== undefined) {
    return tagged;
  }
  const ineligible = corporateIssuerReason(ctx.secIssuer);
  if (ineligible !== undefined) {
    return { reason: `${prefix} ${ineligible}` };
  }
  const rate = usStatutoryRateFor(anchor.periodStart ?? "", anchor.periodEnd);
  if (rate === undefined) {
    return { reason: `${prefix} the fiscal year has no single US federal statutory rate` };
  }
  const state = ctx.secIssuer!.stateOfIncorporation!;
  return {
    rate,
    basis: `NOPAT at the ${String(rate * 100)}% US federal statutory rate (issuer incorporated in ${state}) because the effective tax rate is outside 0-100%`,
    input: {
      label: "state of incorporation",
      value: state,
      artifact: "evidence",
      category: "sec-edgar",
      key: "stateOfIncorporation",
      unit: "text",
      sourceIds: ctx.secIssuer!.sourceIds,
    },
  };
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
  const statutory =
    taxRate !== undefined && (taxRate < 0 || taxRate > 1)
      ? usStatutoryRateOf(ctx, anchor)
      : undefined;
  if (statutory !== undefined && "reason" in statutory) {
    return notMeaningful(statutory.reason, facts, keys);
  }
  const filed = INVESTED_CAPITAL.filter((key) => !seriesNotFiled(ctx, key));
  const instants = filed.map((key) => instantAt(ctx, key, anchor.periodEnd));
  const found = instants.flatMap((fact, index) =>
    fact === undefined ? [] : [statementInput(fact, filed[index]!)],
  );
  const inputs = [...inputsOf(facts, keys), ...found];
  const absent = filed.filter((_key, index) => instants[index] === undefined);
  const heldForSale = ctx.statements?.omissionNotes.some(
    (note) =>
      note.code === "debt-held-for-sale" && note.periodKey === `instant|${anchor.periodEnd}`,
  );
  if (absent.includes("debt") && heldForSale === true) {
    return {
      status: "missing",
      reason: `debt at the fiscal year end ${anchor.periodEnd} is not separable from liabilities held for sale, so continuing-operations invested capital is unproven`,
      periodEnd: anchor.periodEnd,
      inputs,
    };
  }
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
  if (unfiled.length > 0) {
    return undefined;
  }
  const shortTermInvestments = shortTermInvestmentsAt(ctx, cash!);
  if (shortTermInvestments.value === undefined) {
    return {
      status: "missing",
      reason: shortTermInvestments.reason ?? "short-term investments unresolved",
      periodEnd: anchor.periodEnd,
      inputs,
    };
  }
  return equity!.value + debt!.value - cash!.value - shortTermInvestments.value <= 0
    ? {
        status: "not-meaningful",
        reason: `invested capital is zero or negative at the fiscal year end ${anchor.periodEnd}`,
        periodEnd: anchor.periodEnd,
        inputs: [...inputs, ...shortTermInvestments.inputs],
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
    const shortTermInvestments = shortTermInvestmentsAt(ctx, cash!);
    const effective = effectiveTaxRateOf(facts, ROIC_FLOWS)!;
    const statutory =
      effective < 0 || effective > 1 ? usStatutoryRateOf(ctx, operatingIncome!) : undefined;
    const taxRate = statutory !== undefined && "rate" in statutory ? statutory.rate : effective;
    return {
      status: "value",
      ...(statutory !== undefined && "basis" in statutory
        ? { basis: `${ROIC_BASIS}; ${statutory.basis}` }
        : {}),
      value:
        (operatingIncome!.value * (1 - taxRate)) /
        (equity!.value + debt!.value - cash!.value - shortTermInvestments.value!),
      periodEnd: operatingIncome!.periodEnd,
      inputs: [
        ...inputsOf(facts, ROIC_FLOWS),
        ...instants.map((fact, index) => statementInput(fact, INVESTED_CAPITAL[index]!)),
        ...shortTermInvestments.inputs,
        ...(statutory !== undefined && "input" in statutory ? [statutory.input] : []),
      ],
    };
  })(ctx);
}

const FISCAL_YEAR = "all from one year-aligned fiscal year";
const ROIC_BASIS = `operating income x (1 - income tax expense / pretax income), ${FISCAL_YEAR}, / (stockholders' equity + debt - cash and cash equivalents - short-term investments) at that fiscal year end, long-term investments excluded; an effective tax rate outside 0-100% uses the filer-tagged statutory rate of its tax rate reconciliation for that fiscal year (withheld when not between 0 and 1, or under SIC 6798 or a partnership, LLC or trust name), else the US federal statutory rate (21% for fiscal years beginning 2018 or later, 35% for those ending by 2017) when the issuer is incorporated in a US state or DC, its SIC is collected and not 6798 (REIT), and its name has no LP, LLC, trust or partners suffix, otherwise not meaningful; pretax income or invested capital at or below zero is not meaningful`;
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
        : { ...outcome, basis: `${outcome.basis ?? basis}; pretax income is ${pretax.label}` };
    },
  };
}

const OPERATING_RATIO_METRICS: readonly MetricDefinition[] = [
  {
    id: "freeCashFlowMargin",
    label: "Free cash flow margin",
    unit: "ratio-percent",
    basis: `(operating cash flow - capital expenditure) / revenue, ${FISCAL_YEAR}; revenue at or below zero or negative-filed capex is not meaningful`,
    applicable: depository("operating cash flow is not a free cash flow basis"),
    compute: (ctx) => {
      const outcome = ratioOf(
        ([operatingCashFlow, capitalExpenditure]) =>
          operatingCashFlow!.value - capitalExpenditure!.value,
        ["operatingCashFlow", "capitalExpenditure", "revenue"],
        (context, facts, keys) =>
          boundGate("capitalExpenditure", NEGATIVE_CAPEX_REASON, false)(context, facts, keys) ??
          boundGate("revenue", "revenue is zero or negative")(context, facts, keys),
      )(ctx);
      const operatingCashFlow = outcome.inputs?.find(
        (input) => input.series === "operatingCashFlow",
      );
      return operatingCashFlow === undefined ||
        operatingCashFlow.label === SERIES_LABELS.operatingCashFlow
        ? outcome
        : {
            ...outcome,
            label: `Free cash flow margin${operatingCashFlow.label.slice(SERIES_LABELS.operatingCashFlow.length)}`,
            basis: `(${operatingCashFlow.label} - capital expenditure) / revenue, ${FISCAL_YEAR}; capital expenditure carries no operations-scope tag and is used as reported; revenue at or below zero or negative-filed capex is not meaningful`,
          };
    },
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
              basis: `${EBITDA_PROXY_BASIS}; D&A basis: ${
                facts[1]!.composite.components.some(
                  ({ concept }) => concept === "OtherDepreciationAndAmortization",
                )
                  ? "cash-flow depreciation and amortization + amortization add-back"
                  : "depreciation + intangible amortization"
              }`,
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
    label: "ROIC (operating income after tax / period-end invested capital)",
    unit: "ratio-percent",
    ...withPretaxScope(ROIC_BASIS, roic),
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
