import { DAY_MS, isFreshPeriodEnd } from "../../config/shared";
import type { ExtendedEvidenceItem } from "../../domain/evidence";
import { itemByCategory, type FinancialLensPosture } from "./financial-lens-metrics";
import {
  financialStatementFacts,
  financialStatementPeriodMonths,
  financialStatementSeriesByKey,
  isYearAligned,
  latestFinancialStatementFact,
  staleSeriesReason,
} from "./financial-statement-selection";
import type {
  FinancialStatementFact,
  FinancialStatementSeriesKey,
} from "./financial-statements-contract";
import {
  PRICE_RELATIVE_KEYS,
  statementInput,
  type MetricContext,
  type MetricDefinition,
  type MetricInput,
  type MetricOutcome,
} from "./metric-engine";
import {
  CURRENT_EQUITY_NOTE,
  isCurrentEquityConcept,
  netDebtFromMetrics,
  bridgeContributors,
  resolveEnterpriseValueBridge,
} from "./enterprise-value-bridge";
import { depositoryIssuerSic, depositoryNetDebtReason } from "./industry-classification";
import { readNumberMetric, readStringMetric } from "./utils";
import {
  MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS,
  revenueMultipleVerdict,
} from "./valuation-comps-contract";
import {
  balanceSheetPeriodDivergence,
  isCurrentBalanceSheetPeriod,
} from "./valuation-comps-support";
import { scaleCurrency, type LensValueUnit } from "./value-format";
import {
  deltaPercent,
  MIN_MEANINGFUL_BASE_REVENUE_SHARE,
  nearZeroBase,
  summaryPriorBase,
  summarySamePeriod,
  YOY_BASE_SERIES,
} from "./sec-fundamentals-format";
import { withheldDebt } from "./sec-debt";

export type LensSeries = Extract<
  FinancialStatementSeriesKey,
  | "revenue"
  | "grossProfit"
  | "operatingIncome"
  | "netIncome"
  | "consolidatedNetIncome"
  | "consolidatedContinuingIncome"
  | "continuingIncome"
  | "continuingDilutedEps"
  | "dilutedEps"
  | "operatingCashFlow"
  | "capitalExpenditure"
  | "dividendsPaid"
  | "cash"
  | "debt"
  | "currentAssets"
  | "currentLiabilities"
  | "stockholdersEquity"
  | "totalAssets"
>;

export const SERIES_LABELS: Readonly<Record<LensSeries, string>> = {
  revenue: "revenue",
  grossProfit: "gross profit",
  operatingIncome: "operating income",
  netIncome: "net income",
  consolidatedNetIncome: "consolidated net income",
  consolidatedContinuingIncome: "continuing operations income including NCI",
  continuingIncome: "continuing operations income",
  continuingDilutedEps: "continuing operations diluted EPS",
  dilutedEps: "diluted EPS",
  operatingCashFlow: "operating cash flow",
  capitalExpenditure: "capital expenditure",
  dividendsPaid: "dividends paid",
  cash: "cash",
  debt: "debt",
  currentAssets: "current assets",
  currentLiabilities: "current liabilities",
  stockholdersEquity: "stockholders' equity",
  totalAssets: "total assets",
};

export interface MetricPeriod {
  readonly periodEnd?: string;
  readonly periodMonths?: number;
}

export const EMPTY_PERIOD: MetricPeriod = {};

export function isYearAlignedFact(fact: FinancialStatementFact): boolean {
  return fact.periodStart === undefined || isYearAligned(fact.periodStart, fact.periodEnd);
}

function seriesFacts(ctx: MetricContext, key: LensSeries): readonly FinancialStatementFact[] {
  const series =
    ctx.statements === undefined ? undefined : financialStatementSeriesByKey(ctx.statements, key);
  return series === undefined ? [] : financialStatementFacts(series);
}

export function eligibleFacts(
  ctx: MetricContext,
  key: LensSeries,
): readonly FinancialStatementFact[] {
  return seriesFacts(ctx, key).filter(
    (fact) => fact.periodType === "interim" || isYearAlignedFact(fact),
  );
}

export function latestFact(
  ctx: MetricContext,
  key: LensSeries,
): FinancialStatementFact | undefined {
  const fact = latestFinancialStatementFact(eligibleFacts(ctx, key));
  return fact === undefined || staleReason(ctx, fact, key) === undefined ? fact : undefined;
}

function staleReason(
  ctx: MetricContext,
  fact: FinancialStatementFact,
  key: LensSeries,
): string | undefined {
  return ctx.statements === undefined
    ? undefined
    : staleSeriesReason(ctx.statements, fact, key, SERIES_LABELS[key]);
}

export function samePeriodFact(
  ctx: MetricContext,
  anchor: FinancialStatementFact,
  key: LensSeries,
): FinancialStatementFact | undefined {
  return latestFinancialStatementFact(
    eligibleFacts(ctx, key).filter(
      (fact) => fact.periodKey === anchor.periodKey && fact.periodType === anchor.periodType,
    ),
  );
}

export function factInput(fact: FinancialStatementFact, key: LensSeries): MetricInput {
  return statementInput(fact, key, SERIES_LABELS[key]);
}

export function periodOf(fact: FinancialStatementFact): MetricPeriod {
  const months = financialStatementPeriodMonths(fact);
  return { periodEnd: fact.periodEnd, ...(months !== undefined ? { periodMonths: months } : {}) };
}

export function periodEndInput(periodEnd: string | undefined): MetricPeriod {
  return periodEnd === undefined ? EMPTY_PERIOD : { periodEnd };
}

export function isCurrentPeriod(ctx: MetricContext, periodEnd: string | undefined): boolean {
  if (periodEnd === undefined || ctx.asOf === undefined) {
    return false;
  }
  const { asOf } = ctx;
  if (!isFreshPeriodEnd(periodEnd, asOf)) {
    return false;
  }
  const newest = Math.max(
    ...(
      [
        "cash",
        "debt",
        "currentAssets",
        "currentLiabilities",
        "stockholdersEquity",
        "totalAssets",
      ] as const
    )
      .flatMap((key) => seriesFacts(ctx, key))
      .filter((fact) => isFreshPeriodEnd(fact.periodEnd, asOf))
      .map((fact) => Date.parse(fact.periodEnd)),
  );
  return (newest - Date.parse(periodEnd)) / DAY_MS <= MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS;
}

export const YOY_BASIS =
  "latest reported period vs the same-length period one year earlier, same concept and unit";

interface BaseCheck {
  readonly reason?: string;
  readonly note?: string;
}

// SEC revenue is continuing-scope and total ≥ continuing, so it bounds a total-scope base from below.
export function revenueShareCheck(
  label: string,
  base: number,
  revenue: number | undefined,
  unit = "",
): BaseCheck {
  if (base <= 0) {
    return {};
  }
  if (revenue === undefined) {
    return {
      note: "no same-period revenue, so the near-zero base check did not run",
    };
  }
  return nearZeroBase(base, revenue)
    ? {
        reason: `${label} is below ${String(MIN_MEANINGFUL_BASE_REVENUE_SHARE * 100)}% of same-period revenue (${yoyEndpoint(base)}${unit} of ${yoyEndpoint(revenue)}${unit})`,
      }
    : {};
}

const priorLabel = (baseKey: string) => `prior-year ${SERIES_LABELS[baseKey as LensSeries]}`;

export function summaryYearOverYear(
  ctx: MetricContext,
  key: string,
  label: string,
): MetricOutcome | undefined {
  const item = secItem(ctx);
  const latest = readNumberMetric(item?.metrics, key);
  const prior = readNumberMetric(item?.metrics, `${key}Prior`);
  if (latest === undefined || prior === undefined) {
    return undefined;
  }
  const unit = key.endsWith("Eps") ? "currency-per-share" : "currency";
  const period = summaryPeriod(ctx, key);
  const base = summaryPriorBase(item?.metrics, key);
  return yearOverYearOutcome(
    label,
    prior,
    latest,
    period,
    [
      evidenceInput(item, `${key}Prior`, label, unit, prior),
      evidenceInput(item, key, label, unit, latest, period),
    ],
    base === undefined ? {} : revenueShareCheck(priorLabel(base.baseKey), base.base, base.revenue),
  );
}

export function statementYearOverYear(
  ctx: MetricContext,
  key: FinancialStatementSeriesKey,
  label: string,
  prior: FinancialStatementFact,
  latest: FinancialStatementFact,
): MetricOutcome {
  const baseKey = YOY_BASE_SERIES[key] as LensSeries | undefined;
  const base =
    baseKey === undefined || baseKey === key ? prior : samePeriodFact(ctx, prior, baseKey);
  return yearOverYearOutcome(
    label,
    prior.value,
    latest.value,
    periodOf(latest),
    [statementInput(prior, key, label), statementInput(latest, key, label)],
    baseKey === undefined || base === undefined
      ? {}
      : revenueShareCheck(
          priorLabel(baseKey),
          base.value,
          samePeriodFact(ctx, prior, "revenue")?.value,
        ),
  );
}

function yearOverYearOutcome(
  label: string,
  prior: number,
  latest: number,
  period: MetricPeriod,
  inputs: readonly MetricInput[],
  check: BaseCheck = {},
): MetricOutcome {
  const value = deltaPercent(latest, prior);
  if (value !== undefined && check.reason === undefined) {
    return {
      status: "value",
      value,
      ...period,
      inputs,
      ...(check.note === undefined ? {} : { basis: `${YOY_BASIS}; ${check.note}` }),
    };
  }
  return {
    status: "not-meaningful",
    reason:
      (value === undefined ? undefined : check.reason) ??
      notMeaningfulYoyReason(label, prior, latest),
    ...period,
    inputs,
  };
}

export function notMeaningfulYoyReason(
  label: string,
  prior: number,
  latest: number,
  unit = "",
): string {
  const endpoint = (value: number) => `${yoyEndpoint(value)}${unit}`;
  const endpoints = `(${endpoint(prior)} to ${endpoint(latest)})`;
  if (prior === 0) {
    return `prior-year ${label} is zero`;
  }
  return prior < 0
    ? `prior-year ${label} is negative ${endpoints}`
    : `${label} turns negative ${endpoints}`;
}

// Postures and phase read a not-meaningful YoY by the direction between its two endpoints.
export function yoyDirection(
  result:
    | {
        readonly status: string;
        readonly value?: unknown;
        readonly inputs?: readonly MetricInput[];
      }
    | undefined,
): number | undefined {
  const [prior, latest] = result?.inputs ?? [];
  if (result?.status === "not-meaningful" && prior !== undefined && latest !== undefined) {
    const direction = Number(latest.value) - Number(prior.value);
    return Number.isFinite(direction) ? direction : undefined;
  }
  return result?.status === "value" && typeof result.value === "number" ? result.value : undefined;
}

function yoyEndpoint(value: number): string {
  return Math.abs(value) >= 999.5 ? scaleCurrency(value) : value.toFixed(2);
}

export function noFact(ctx: MetricContext, key: LensSeries): MetricOutcome {
  if (ctx.statements?.unfiledSeries?.includes(key) === true) {
    return {
      status: "missing",
      reason: `${SERIES_LABELS[key]} not filed by the issuer`,
      cause: "not-filed",
    };
  }
  const stale = latestFinancialStatementFact(eligibleFacts(ctx, key));
  const reason = stale === undefined ? undefined : staleReason(ctx, stale, key);
  if (stale !== undefined && reason !== undefined) {
    return { status: "missing", reason, ...periodOf(stale), inputs: [factInput(stale, key)] };
  }
  return {
    status: "missing",
    reason:
      ctx.statements === undefined
        ? "financial statements unavailable"
        : `no year-aligned annual or interim ${SERIES_LABELS[key]} fact`,
  };
}

export function missingPartner(
  ctx: MetricContext,
  key: LensSeries,
  anchor: FinancialStatementFact,
  inputs: readonly MetricInput[],
): MetricOutcome {
  const missing = noFact(ctx, key);
  return {
    ...missing,
    ...(ctx.statements?.unfiledSeries?.includes(key) === true
      ? {}
      : {
          reason: `no same-period ${SERIES_LABELS[key]} for the period ending ${anchor.periodEnd}`,
        }),
    ...periodOf(anchor),
    inputs,
  };
}

function incompleteDebtPeriod(ctx: MetricContext): string | undefined {
  return ctx.statements === undefined
    ? readStringMetric(secItem(ctx)?.metrics, "debtIncompletePeriodEnd")
    : withheldDebt(ctx.statements)?.periodEnd;
}

export function withCompleteDebt(definition: MetricDefinition): MetricDefinition {
  return {
    ...definition,
    compute: (ctx) => {
      const incomplete = incompleteDebtPeriod(ctx);
      return incomplete === undefined
        ? definition.compute(ctx)
        : { status: "missing", reason: `incomplete debt as of ${incomplete}` };
    },
  };
}

export function annualize(value: number, periodMonths: number | undefined): number {
  return periodMonths !== undefined && periodMonths > 0 ? value * (12 / periodMonths) : value;
}

export function positiveOf(value: number | undefined): boolean | undefined {
  return value === undefined ? undefined : value > 0;
}

export function atOrBelow(value: number | undefined, threshold: number): boolean | undefined {
  return value === undefined ? undefined : value <= threshold;
}

export function postureFrom(
  criteria: readonly (boolean | undefined)[],
  requiredCount = 1,
): FinancialLensPosture {
  const known = criteria.filter((value): value is boolean => value !== undefined);
  if (known.length < requiredCount || known.length === 0) {
    return "insufficient-data";
  }
  const supported = known.filter(Boolean).length;
  if (supported === known.length) {
    return "criteria-supported";
  }
  return supported === 0 ? "criteria-not-supported" : "criteria-mixed";
}

export function secItem(ctx: MetricContext): ExtendedEvidenceItem | undefined {
  return itemByCategory(ctx.evidence, "sec-edgar");
}

export function valuationItem(ctx: MetricContext): ExtendedEvidenceItem | undefined {
  return itemByCategory(ctx.evidence, "valuation");
}

// Valuation evidence also cites every peer; a target figure cites only its filing and quote.
export function targetValuationIds(
  ctx: MetricContext,
  priceRelative: boolean,
): readonly string[] | undefined {
  const filed =
    ctx.statements === undefined ? (secItem(ctx)?.sourceIds ?? []) : [ctx.statements.sourceId];
  const quote = ctx.snapshot?.sourceId;
  if (filed.length === 0 || (priceRelative && quote === undefined)) {
    return undefined;
  }
  return priceRelative && quote !== undefined ? [quote, ...filed] : filed;
}

export function valuationOutcome(
  ctx: MetricContext,
  key: string,
  label: string,
  unit: LensValueUnit,
  period: MetricPeriod,
): MetricOutcome {
  const valuation = valuationItem(ctx);
  const value = readNumberMetric(valuation?.metrics, key);
  const sourceIds = targetValuationIds(ctx, PRICE_RELATIVE_KEYS.has(key));
  if (value === undefined) {
    return { status: "missing", reason: `no ${key} input` };
  }
  return sourceIds === undefined
    ? { status: "missing", reason: `no cited ${label} source` }
    : {
        status: "value",
        value,
        inputs: [{ ...evidenceInput(valuation, key, label, unit, value, period), sourceIds }],
        ...period,
      };
}

export function withRevenueMultipleVerdict(
  compute: (ctx: MetricContext) => MetricOutcome,
): (ctx: MetricContext) => MetricOutcome {
  return (ctx) => {
    const outcome = compute(ctx);
    const metrics = valuationItem(ctx)?.metrics;
    const verdict = revenueMultipleVerdict(
      {
        annualizedRevenue: readNumberMetric(metrics, "annualizedRevenue"),
        marketCap: readNumberMetric(metrics, "marketCap"),
        evToAnnualizedRevenue: readNumberMetric(metrics, "evToAnnualizedRevenue"),
        revenuePeriodEnd: readStringMetric(metrics, "revenuePeriodEnd"),
      },
      ctx.asOf,
    );
    return outcome.status !== "value" || verdict === undefined
      ? outcome
      : {
          ...verdict,
          ...(outcome.periodEnd === undefined ? {} : { periodEnd: outcome.periodEnd }),
          ...(outcome.periodMonths === undefined ? {} : { periodMonths: outcome.periodMonths }),
          inputs: outcome.inputs,
        };
  };
}

export function yahooItem(ctx: MetricContext): ExtendedEvidenceItem | undefined {
  return itemByCategory(ctx.evidence, "yahoo-fundamentals");
}

export function evidenceInput(
  item: ExtendedEvidenceItem | undefined,
  key: string,
  label: string,
  unit: LensValueUnit,
  value: number | string,
  period: MetricPeriod = EMPTY_PERIOD,
): MetricInput & { readonly value: number | string } {
  return {
    label,
    value,
    artifact: "evidence",
    category: item?.category ?? "sec-edgar",
    key,
    unit,
    sourceIds: item?.sourceIds ?? [],
    ...(period.periodEnd !== undefined ? { periodEnd: period.periodEnd } : {}),
  };
}

export function evidenceOutcome(
  item: ExtendedEvidenceItem | undefined,
  key: string,
  label: string,
  unit: LensValueUnit,
  period: MetricPeriod = EMPTY_PERIOD,
): MetricOutcome {
  const value = readNumberMetric(item?.metrics, key);
  return value === undefined
    ? { status: "missing", reason: `no ${key} input` }
    : {
        status: "value",
        value,
        inputs: [evidenceInput(item, key, label, unit, value, period)],
        ...period,
      };
}

export function summaryPeriod(ctx: MetricContext, fallback: string): MetricPeriod {
  const item = secItem(ctx);
  const periodEnd = readStringMetric(item?.metrics, `${fallback}PeriodEnd`);
  const periodMonths = readNumberMetric(item?.metrics, `${fallback}PeriodMonths`);
  return {
    ...(periodEnd !== undefined ? { periodEnd } : {}),
    ...(periodMonths !== undefined ? { periodMonths } : {}),
  };
}

export function summaryPeriodsMatch(ctx: MetricContext, left: string, right: string): boolean {
  return summarySamePeriod(secItem(ctx)?.metrics, left, right);
}

export function chosenInput(
  item: ExtendedEvidenceItem | undefined,
  key: string,
  label: string,
  period: MetricPeriod,
): readonly MetricInput[] {
  const value = readNumberMetric(item?.metrics, key);
  return value === undefined ? [] : [evidenceInput(item, key, label, "currency", value, period)];
}

const SUMMARY_STALENESS: Readonly<Record<string, { readonly series: readonly LensSeries[] }>> = {
  netDebt: { series: ["debt", "cash"] },
  currentRatio: { series: ["currentAssets", "currentLiabilities"] },
  debtToEquity: { series: ["debt", "stockholdersEquity"] },
  debtToMarketCap: { series: ["debt"] },
  netDebtToMarketCap: { series: ["debt", "cash"] },
};

export function summaryCurrentness(
  ctx: MetricContext,
  id: string,
): { readonly current: boolean; readonly periodEnd?: string } {
  const spec = SUMMARY_STALENESS[id];
  const item = secItem(ctx);
  const { asOf } = ctx;
  if (spec === undefined || asOf === undefined) {
    return { current: false };
  }
  const periods = spec.series.map((key) => readStringMetric(item?.metrics, `${key}PeriodEnd`));
  const staleIndex = periods.findIndex(
    (periodEnd) =>
      periodEnd === undefined || !isCurrentBalanceSheetPeriod(item?.metrics, periodEnd, asOf),
  );
  if (staleIndex === -1) {
    return { current: true };
  }
  const stale = periods[staleIndex];
  return { current: false, ...(stale !== undefined ? { periodEnd: stale } : {}) };
}

function netDebtInapplicable(ctx: MetricContext): string | undefined {
  const sic = depositoryIssuerSic(ctx.evidence);
  return sic === undefined ? undefined : depositoryNetDebtReason(sic);
}

export function withNetDebtApplicability(definition: MetricDefinition): MetricDefinition {
  return { ...definition, applicable: netDebtInapplicable };
}

function evidenceGuardedNetDebt(ctx: MetricContext): number | undefined {
  const item = secItem(ctx);
  return netDebtInapplicable(ctx) !== undefined ||
    balanceSheetPeriodDivergence(item?.metrics) !== undefined
    ? undefined
    : netDebtFromMetrics(item?.metrics);
}

export function shortTermInvestmentsAt(
  ctx: MetricContext,
  cash: FinancialStatementFact,
): { readonly value?: number; readonly inputs: readonly MetricInput[]; readonly reason?: string } {
  const part = resolveEnterpriseValueBridge(
    ctx.statements?.enterpriseValueBridge,
    cash,
  ).shortTermInvestments;
  if (part.status === "incomplete") {
    return { inputs: [], reason: part.reason };
  }
  if (part.status === "untagged") {
    return { value: 0, inputs: [] };
  }
  return {
    value: part.value,
    inputs: bridgeContributors(part).map(({ fact, value, label }) => {
      const { series: _series, ...input } = statementInput(
        fact,
        "cash",
        `short-term investments (${label})`,
      );
      return {
        ...input,
        value,
        key: fact.concept,
        ...(isCurrentEquityConcept(fact.concept) ? { derivation: CURRENT_EQUITY_NOTE } : {}),
      };
    }),
  };
}

// Only an evidence item's own bridge concept may annotate the value read from it.
export function withCurrentEquityNote(definition: MetricDefinition): MetricDefinition {
  return {
    ...definition,
    compute: (ctx) => {
      const outcome = definition.compute(ctx);
      const inputs = outcome.inputs ?? [];
      const included =
        !inputs.some((input) => input.artifact === "statements") &&
        inputs.some(
          (input) =>
            input.artifact === "evidence" &&
            input.category !== undefined &&
            isCurrentEquityConcept(
              readStringMetric(
                itemByCategory(ctx.evidence, input.category)?.metrics,
                "shortTermInvestmentsConcept",
              ),
            ),
        );
      return included
        ? { ...outcome, basis: `${outcome.basis ?? definition.basis}; ${CURRENT_EQUITY_NOTE}` }
        : outcome;
    },
  };
}

export function evidenceDisplayNetDebt(ctx: MetricContext): number | undefined {
  const valuation = valuationItem(ctx);
  if (valuation === undefined) {
    return evidenceGuardedNetDebt(ctx);
  }
  const valuationNetDebt = valuation.metrics?.netDebt;
  return typeof valuationNetDebt === "number" ? valuationNetDebt : undefined;
}

export function summaryValue(
  ctx: MetricContext,
  key: string,
  value: number | undefined,
  label: string,
  unit: LensValueUnit,
  periodSeries: LensSeries,
): MetricOutcome {
  const item = secItem(ctx);
  const period = summaryPeriod(ctx, periodSeries);
  return value === undefined
    ? { status: "missing", reason: `no SEC ${label}` }
    : {
        status: "value",
        value,
        inputs: [evidenceInput(item, key, label, unit, value, period)],
        ...period,
      };
}

export function marketCapInput(ctx: MetricContext): MetricInput | undefined {
  if (ctx.snapshot?.marketCap !== undefined) {
    return {
      label: "market cap",
      value: ctx.snapshot.marketCap,
      artifact: "quote",
      series: "marketCap",
      currency: quoteCurrencyOf(ctx),
      unit: "currency",
      sourceIds: [ctx.snapshot.sourceId],
    };
  }
  return undefined;
}

export const CURRENCY_MISMATCH_REASON =
  "filed amounts and quote market cap have incompatible currency";

export function currencyMismatch(
  marketCap: MetricInput,
  facts: readonly (FinancialStatementFact | undefined)[],
): boolean {
  return (
    typeof marketCap.currency === "string" &&
    facts.some((fact) => typeof fact?.currency === "string" && fact.currency !== marketCap.currency)
  );
}

export function quoteCurrencyOf(ctx: MetricContext): string {
  return ctx.snapshot?.identity?.quoteCurrency ?? "USD";
}
