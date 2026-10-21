import { DAY_MS } from "../../config/shared";
import type { ExtendedEvidenceItem } from "../../domain/evidence";
import type { SourceGap } from "../../domain/sources";
import { verifiedSnapshotSourceId } from "../../research/verified-snapshot-contract";
import {
  conceptScope,
  isContinuingScope,
  scopedLabel,
  TOTAL_OPERATIONS_SCOPE,
} from "./financial-statement-definitions";
import { priorComparable } from "./financial-lens-canonical";
import { FINANCIAL_LENS_ORDER, financialLensMetricSectionId } from "./financial-lens-contract";
import {
  itemByCategory,
  peIsClean,
  peMetricValue,
  valuationDateBasisMetric,
  type FinancialLensName,
  type FinancialLensPosture,
} from "./financial-lens-metrics";
import {
  earlierShareBasisPeriods,
  financialStatementFacts,
  financialStatementFactsAreCompatible,
  financialStatementPeriodMonths,
  financialStatementSeriesByKey,
  isYearAligned,
  latestFinancialStatementFact,
} from "./financial-statement-selection";
import type {
  FinancialStatementFact,
  FinancialStatementSeriesKey,
} from "./financial-statements-contract";
import {
  evaluateMetricSection,
  statementInput,
  type MetricContext,
  type MetricDefinition,
  type MetricInput,
  type MetricOutcome,
  type MetricResult,
  type MetricSection,
} from "./metric-engine";
import { readNumberMetric, readStringMetric } from "./utils";
import { MIXED_PERIOD_METRIC, REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT } from "./valuation-comps";
import { MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS } from "./valuation-comps-contract";
import {
  balanceSheetPeriodDivergence,
  isCurrentBalanceSheetPeriod,
  isFreshPeriodEnd,
} from "./valuation-comps-support";
import { type LensValueUnit } from "./value-format";

type LensSeries = Extract<
  FinancialStatementSeriesKey,
  | "revenue"
  | "grossProfit"
  | "operatingIncome"
  | "netIncome"
  | "consolidatedNetIncome"
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

const SERIES_LABELS: Readonly<Record<LensSeries, string>> = {
  revenue: "revenue",
  grossProfit: "gross profit",
  operatingIncome: "operating income",
  netIncome: "net income",
  consolidatedNetIncome: "consolidated net income",
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

const LATEST_PERIOD_BASIS = "latest reported period: a year-aligned annual or an interim filing";
const YOY_BASIS =
  "latest reported period vs the same-length period one year earlier, same concept and unit";

interface MetricPeriod {
  readonly periodEnd?: string;
  readonly periodMonths?: number;
}

const EMPTY_PERIOD: MetricPeriod = {};

function isYearAlignedFact(fact: FinancialStatementFact): boolean {
  return fact.periodStart === undefined || isYearAligned(fact.periodStart, fact.periodEnd);
}

function seriesFacts(ctx: MetricContext, key: LensSeries): readonly FinancialStatementFact[] {
  const series =
    ctx.statements === undefined ? undefined : financialStatementSeriesByKey(ctx.statements, key);
  return series === undefined ? [] : financialStatementFacts(series);
}

function eligibleFacts(ctx: MetricContext, key: LensSeries): readonly FinancialStatementFact[] {
  return seriesFacts(ctx, key).filter(
    (fact) => fact.periodType === "interim" || isYearAlignedFact(fact),
  );
}

function latestFact(ctx: MetricContext, key: LensSeries): FinancialStatementFact | undefined {
  return latestFinancialStatementFact(eligibleFacts(ctx, key));
}

function samePeriodFact(
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

function factInput(fact: FinancialStatementFact, key: LensSeries): MetricInput {
  return statementInput(fact, key, SERIES_LABELS[key]);
}

function periodOf(fact: FinancialStatementFact): MetricPeriod {
  const months = financialStatementPeriodMonths(fact);
  return { periodEnd: fact.periodEnd, ...(months !== undefined ? { periodMonths: months } : {}) };
}

function periodEndInput(periodEnd: string | undefined): MetricPeriod {
  return periodEnd === undefined ? EMPTY_PERIOD : { periodEnd };
}

function isCurrentPeriod(ctx: MetricContext, periodEnd: string | undefined): boolean {
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

function noFact(ctx: MetricContext, key: LensSeries): MetricOutcome {
  if (ctx.statements?.unfiledSeries?.includes(key) === true) {
    return {
      status: "missing",
      reason: `${SERIES_LABELS[key]} not filed by the issuer`,
      cause: "not-filed",
    };
  }
  return {
    status: "missing",
    reason:
      ctx.statements === undefined
        ? "financial statements unavailable"
        : `no year-aligned annual or interim ${SERIES_LABELS[key]} fact`,
  };
}

function missingPartner(
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
  const debtEnd = latestFact(ctx, "debt")?.periodEnd;
  if (ctx.statements === undefined) {
    return readStringMetric(secItem(ctx)?.metrics, "debtIncompletePeriodEnd");
  }
  return ctx.statements.omissionNotes
    .filter((note) => note.code === "incomplete-composite-series" && note.seriesKey === "debt")
    .map((note) => note.periodKey?.replace(/^instant\|/u, ""))
    .filter((end): end is string => end !== undefined && debtEnd !== undefined && end > debtEnd)
    .toSorted()
    .at(-1);
}

function debtLabel(ctx: MetricContext): string {
  const fact = latestFact(ctx, "debt");
  const basis =
    ctx.statements === undefined
      ? readStringMetric(secItem(ctx)?.metrics, "debtBasis")
      : fact?.basis;
  const label = basis === "gross-principal" ? "Debt (gross principal)" : "Debt";
  const incomplete = incompleteDebtPeriod(ctx);
  const periodEnd = fact?.periodEnd ?? readStringMetric(secItem(ctx)?.metrics, "debtPeriodEnd");
  return incomplete === undefined
    ? label
    : `${label} as of ${periodEnd ?? "an undated period"}; incomplete as of ${incomplete}`;
}

function annualize(value: number, periodMonths: number | undefined): number {
  return periodMonths !== undefined && periodMonths > 0 ? value * (12 / periodMonths) : value;
}

function positiveOf(value: number | undefined): boolean | undefined {
  return value === undefined ? undefined : value > 0;
}

function atOrBelow(value: number | undefined, threshold: number): boolean | undefined {
  return value === undefined ? undefined : value <= threshold;
}

function postureFrom(
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

function secItem(ctx: MetricContext): ExtendedEvidenceItem | undefined {
  return itemByCategory(ctx.evidence, "sec-edgar");
}

function valuationItem(ctx: MetricContext): ExtendedEvidenceItem | undefined {
  return itemByCategory(ctx.evidence, "valuation");
}

function yahooItem(ctx: MetricContext): ExtendedEvidenceItem | undefined {
  return itemByCategory(ctx.evidence, "yahoo-fundamentals");
}

function evidenceInput(
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

function evidenceOutcome(
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

function summaryPeriod(ctx: MetricContext, fallback: LensSeries): MetricPeriod {
  const item = secItem(ctx);
  const periodEnd = readStringMetric(item?.metrics, `${fallback}PeriodEnd`);
  const periodMonths = readNumberMetric(item?.metrics, `${fallback}PeriodMonths`);
  return {
    ...(periodEnd !== undefined ? { periodEnd } : {}),
    ...(periodMonths !== undefined ? { periodMonths } : {}),
  };
}

function summaryPeriodsMatch(ctx: MetricContext, left: string, right: string): boolean {
  const metrics = secItem(ctx)?.metrics;
  const periodEnd = readStringMetric(metrics, `${left}PeriodEnd`);
  return periodEnd !== undefined && periodEnd === readStringMetric(metrics, `${right}PeriodEnd`);
}

function chosenInput(
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

function summaryCurrentness(
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

function evidenceGuardedNetDebt(ctx: MetricContext): number | undefined {
  const item = secItem(ctx);
  const debt = readNumberMetric(item?.metrics, "debt");
  const cash = readNumberMetric(item?.metrics, "cash");
  return debt === undefined ||
    cash === undefined ||
    balanceSheetPeriodDivergence(item?.metrics) !== undefined
    ? undefined
    : debt - cash;
}

function evidenceDisplayNetDebt(ctx: MetricContext): number | undefined {
  const valuationNetDebt = valuationItem(ctx)?.metrics?.netDebt;
  if (valuationNetDebt === MIXED_PERIOD_METRIC) {
    return undefined;
  }
  return typeof valuationNetDebt === "number" ? valuationNetDebt : evidenceGuardedNetDebt(ctx);
}

function summaryValue(
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

function marginDefinition(
  id: string,
  numerator: LensSeries,
  denominator: LensSeries,
  label: string,
): MetricDefinition {
  return {
    id,
    label,
    unit: "ratio-percent",
    basis: `${SERIES_LABELS[numerator]} / ${SERIES_LABELS[denominator]} for the latest ${SERIES_LABELS[numerator]} period`,
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const numeratorValue = readNumberMetric(secItem(ctx)?.metrics, numerator);
        const denominatorValue = readNumberMetric(secItem(ctx)?.metrics, denominator);
        const numeratorEnd = readStringMetric(secItem(ctx)?.metrics, `${numerator}PeriodEnd`);
        const denominatorEnd = readStringMetric(secItem(ctx)?.metrics, `${denominator}PeriodEnd`);
        if (
          numeratorEnd !== undefined &&
          denominatorEnd !== undefined &&
          numeratorEnd !== denominatorEnd
        ) {
          return { status: "missing", reason: `no same-period SEC ${label}` };
        }
        return summaryValue(
          ctx,
          id,
          numeratorValue === undefined || denominatorValue === undefined || denominatorValue === 0
            ? undefined
            : numeratorValue / denominatorValue,
          label,
          "ratio-percent",
          denominator,
        );
      }
      const anchor = latestFact(ctx, numerator);
      if (anchor === undefined) {
        return noFact(ctx, numerator);
      }
      const partner = samePeriodFact(ctx, anchor, denominator);
      const denominatorLabel = SERIES_LABELS[denominator];
      if (partner === undefined) {
        return missingPartner(ctx, denominator, anchor, [factInput(anchor, numerator)]);
      }
      const inputs = [factInput(anchor, numerator), factInput(partner, denominator)];
      if (!financialStatementFactsAreCompatible([anchor, partner])) {
        return {
          status: "missing",
          reason: `${denominatorLabel} currency or unit differs for the period ending ${anchor.periodEnd}`,
          ...periodOf(anchor),
          inputs,
        };
      }
      if (partner.value <= 0) {
        return {
          status: "not-meaningful",
          reason: `${denominatorLabel} is not positive`,
          ...periodOf(anchor),
          inputs,
        };
      }
      return {
        status: "value",
        value: anchor.value / partner.value,
        ...periodOf(anchor),
        inputs,
      };
    },
  };
}

function freeCashFlowDefinition(): MetricDefinition {
  return {
    id: "freeCashFlowProxy",
    label: "FCF proxy",
    unit: "currency",
    basis: "operating cash flow less capital expenditure for the latest operating cash flow period",
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const operatingCashFlow = readNumberMetric(secItem(ctx)?.metrics, "operatingCashFlow");
        const capex = readNumberMetric(secItem(ctx)?.metrics, "capex");
        if (!summaryPeriodsMatch(ctx, "operatingCashFlow", "capex")) {
          return { status: "missing", reason: "no same-period SEC FCF proxy" };
        }
        return summaryValue(
          ctx,
          "freeCashFlowProxy",
          operatingCashFlow === undefined || capex === undefined
            ? undefined
            : operatingCashFlow - capex,
          "FCF proxy",
          "currency",
          "operatingCashFlow",
        );
      }
      const anchor = latestFact(ctx, "operatingCashFlow");
      if (anchor === undefined) {
        return noFact(ctx, "operatingCashFlow");
      }
      const capex = samePeriodFact(ctx, anchor, "capitalExpenditure");
      if (capex === undefined) {
        return missingPartner(ctx, "capitalExpenditure", anchor, [
          factInput(anchor, "operatingCashFlow"),
        ]);
      }
      return {
        status: "value",
        value: anchor.value - capex.value,
        ...periodOf(anchor),
        ...(anchor.currency !== null ? { currency: anchor.currency } : {}),
        inputs: [factInput(anchor, "operatingCashFlow"), factInput(capex, "capitalExpenditure")],
      };
    },
  };
}

function cashConversionDefinition(): MetricDefinition {
  return {
    id: "cashConversion",
    label: "Cash conversion",
    unit: "ratio",
    basis: "operating cash flow / income of the same operations scope for the same period",
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const operatingCashFlow = readNumberMetric(secItem(ctx)?.metrics, "operatingCashFlow");
        const continuing = isContinuingScope(
          readStringMetric(secItem(ctx)?.metrics, "operatingCashFlowScope"),
        );
        const income = readNumberMetric(
          secItem(ctx)?.metrics,
          continuing ? "continuingIncome" : "netIncome",
        );
        if (
          !summaryPeriodsMatch(
            ctx,
            "operatingCashFlow",
            continuing ? "continuingIncome" : "netIncome",
          )
        ) {
          return { status: "missing", reason: "no same-period SEC Cash conversion" };
        }
        return summaryValue(
          ctx,
          "cashConversion",
          operatingCashFlow === undefined || income === undefined || income === 0
            ? undefined
            : operatingCashFlow / income,
          "Cash conversion",
          "ratio",
          "operatingCashFlow",
        );
      }
      const anchor = latestFact(ctx, "operatingCashFlow");
      if (anchor === undefined) {
        return noFact(ctx, "operatingCashFlow");
      }
      const incomeKey: LensSeries = isContinuingScope(conceptScope(anchor.concept))
        ? "continuingIncome"
        : "netIncome";
      const income = samePeriodFact(ctx, anchor, incomeKey);
      if (income === undefined) {
        return missingPartner(ctx, incomeKey, anchor, [factInput(anchor, "operatingCashFlow")]);
      }
      const inputs = [factInput(anchor, "operatingCashFlow"), factInput(income, incomeKey)];
      return income.value <= 0
        ? {
            status: "not-meaningful",
            reason: `${SERIES_LABELS[incomeKey]} is not positive`,
            ...periodOf(anchor),
            inputs,
          }
        : {
            status: "value",
            value: anchor.value / income.value,
            ...periodOf(anchor),
            inputs,
          };
    },
  };
}

function returnOnLabel(ctx: MetricContext, id: "roe" | "roa", denominator: LensSeries): string {
  const label = id.toUpperCase();
  if (ctx.statements !== undefined) {
    return label;
  }
  const item = secItem(ctx);
  const numeratorEnd = readStringMetric(item?.metrics, "netIncomePeriodEnd");
  const denominatorEnd = readStringMetric(
    item?.metrics,
    `${evidenceSeriesKey(id, denominator)}PeriodEnd`,
  );
  if (
    numeratorEnd === undefined ||
    denominatorEnd === undefined ||
    numeratorEnd === denominatorEnd
  ) {
    return label;
  }
  const scope = denominator === "stockholdersEquity" ? "equity" : "assets";
  return `${label} (${scope} at ${denominatorEnd})`;
}

function evidenceSeriesKey(id: "roe" | "roa", denominator: LensSeries): string {
  return id === "roa" ? "assets" : denominator;
}

function returnOnDefinition(
  id: "roe" | "roa",
  denominator: LensSeries,
  label: string,
): MetricDefinition {
  return {
    id,
    label,
    unit: "ratio-percent",
    basis: `net income annualized by its own period, over ${SERIES_LABELS[denominator]} at that period end`,
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const netIncome = readNumberMetric(secItem(ctx)?.metrics, "netIncome");
        const base = readNumberMetric(secItem(ctx)?.metrics, evidenceSeriesKey(id, denominator));
        const months = readNumberMetric(secItem(ctx)?.metrics, "netIncomePeriodMonths");
        return summaryValue(
          ctx,
          id,
          netIncome === undefined || base === undefined || base === 0
            ? undefined
            : annualize(netIncome, months) / base,
          id.toUpperCase(),
          "ratio-percent",
          "netIncome",
        );
      }
      const anchor = latestFact(ctx, "netIncome");
      if (anchor === undefined) {
        return noFact(ctx, "netIncome");
      }
      const instant = latestFinancialStatementFact(
        eligibleFacts(ctx, denominator).filter(
          (fact) => fact.periodKey === `instant|${anchor.periodEnd}`,
        ),
      );
      if (instant === undefined) {
        return missingPartner(ctx, denominator, anchor, [factInput(anchor, "netIncome")]);
      }
      const inputs = [factInput(anchor, "netIncome"), factInput(instant, denominator)];
      return instant.value <= 0
        ? {
            status: "not-meaningful",
            reason: `${SERIES_LABELS[denominator]} is not positive`,
            ...periodOf(anchor),
            inputs,
          }
        : {
            status: "value",
            value: annualize(anchor.value, financialStatementPeriodMonths(anchor)) / instant.value,
            ...periodOf(anchor),
            inputs,
          };
    },
  };
}

function consolidatedIncomeDefinitions(ctx: MetricContext): readonly MetricDefinition[] {
  if (ctx.statements === undefined) {
    const netIncome = readNumberMetric(secItem(ctx)?.metrics, "netIncome");
    const consolidated = readNumberMetric(secItem(ctx)?.metrics, "consolidatedNetIncome");
    if (netIncome === undefined || consolidated === undefined || consolidated === netIncome) {
      return [];
    }
    return [consolidatedIncomeDefinition()];
  }
  const anchor = latestFact(ctx, "netIncome");
  const consolidated =
    anchor === undefined ? undefined : samePeriodFact(ctx, anchor, "consolidatedNetIncome");
  return anchor === undefined || consolidated === undefined || consolidated.value === anchor.value
    ? []
    : [consolidatedIncomeDefinition()];
}

function consolidatedIncomeDefinition(): MetricDefinition {
  return {
    id: "consolidatedNetIncome",
    label: "Net income (consolidated incl. NCI)",
    unit: "currency",
    basis: LATEST_PERIOD_BASIS,
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const item = secItem(ctx);
        const consolidatedPeriodEnd = readStringMetric(
          item?.metrics,
          "consolidatedNetIncomePeriodEnd",
        );
        const consolidatedPeriodMonths = readNumberMetric(
          item?.metrics,
          "consolidatedNetIncomePeriodMonths",
        );
        return evidenceOutcome(
          item,
          "consolidatedNetIncome",
          "consolidated net income",
          "currency",
          {
            ...(consolidatedPeriodEnd !== undefined ? { periodEnd: consolidatedPeriodEnd } : {}),
            ...(consolidatedPeriodMonths !== undefined
              ? { periodMonths: consolidatedPeriodMonths }
              : {}),
          },
        );
      }
      const anchor = latestFact(ctx, "netIncome");
      const consolidated =
        anchor === undefined ? undefined : samePeriodFact(ctx, anchor, "consolidatedNetIncome");
      return consolidated === undefined
        ? noFact(ctx, "consolidatedNetIncome")
        : {
            status: "value",
            value: consolidated.value,
            ...periodOf(consolidated),
            ...(consolidated.currency !== null ? { currency: consolidated.currency } : {}),
            inputs: [factInput(consolidated, "consolidatedNetIncome")],
          };
    },
  };
}

function yoyLabel(ctx: MetricContext, key: LensSeries): string {
  const item = secItem(ctx);
  if (ctx.statements === undefined) {
    const scope = readStringMetric(item?.metrics, `${key}Scope`);
    if (key === "netIncome") {
      const prior = readNumberMetric(item?.metrics, "netIncomePrior");
      return scopedLabel(
        prior !== undefined && prior < 0
          ? "Net loss (attrib.) YoY change"
          : "Net income (attrib.) YoY",
        scope,
      );
    }
    if (key === "continuingIncome") {
      const prior = readNumberMetric(item?.metrics, "continuingIncomePrior");
      return scopedLabel(
        prior !== undefined && prior < 0 ? "Loss YoY change" : "Income YoY",
        scope,
      );
    }
    return scopedLabel(yoyBaseLabel(key), scope);
  }
  const anchor = latestFact(ctx, key);
  const prior = anchor === undefined ? undefined : comparablePrior(ctx, key, anchor);
  switch (key) {
    case "netIncome": {
      return scopedLabel(
        prior !== undefined && prior.value < 0
          ? "Net loss (attrib.) YoY change"
          : "Net income (attrib.) YoY",
        anchor === undefined ? undefined : scopeOfTotal(ctx, anchor, "continuingIncome"),
      );
    }
    case "continuingIncome": {
      return scopedLabel(
        prior !== undefined && prior.value < 0 ? "Loss YoY change" : "Income YoY",
        conceptScope(anchor?.concept),
      );
    }
    case "dilutedEps": {
      return scopedLabel(
        "Diluted EPS YoY",
        anchor === undefined ? undefined : scopeOfTotal(ctx, anchor, "continuingDilutedEps"),
      );
    }
    case "continuingDilutedEps": {
      return scopedLabel("Diluted EPS YoY", conceptScope(anchor?.concept));
    }
    default: {
      return scopedLabel(yoyBaseLabel(key), conceptScope(anchor?.concept));
    }
  }
}

function yoyBaseLabel(key: LensSeries): string {
  switch (key) {
    case "revenue": {
      return "Revenue YoY";
    }
    case "grossProfit": {
      return "Gross profit YoY";
    }
    case "operatingIncome": {
      return "Operating income YoY";
    }
    case "operatingCashFlow": {
      return "Operating cash flow YoY";
    }
    case "dilutedEps":
    case "continuingDilutedEps": {
      return "Diluted EPS YoY";
    }
    default: {
      return `${SERIES_LABELS[key]} YoY`;
    }
  }
}

function scopeOfTotal(
  ctx: MetricContext,
  fact: FinancialStatementFact,
  continuing: LensSeries,
): string | undefined {
  const explicit = conceptScope(fact.concept);
  if (explicit !== undefined) {
    return explicit;
  }
  const counterpart = latestFact(ctx, continuing);
  return counterpart !== undefined && counterpart.periodEnd >= fact.periodEnd
    ? TOTAL_OPERATIONS_SCOPE
    : undefined;
}

function comparablePrior(
  ctx: MetricContext,
  key: LensSeries,
  anchor: FinancialStatementFact,
): FinancialStatementFact | undefined {
  const series =
    ctx.statements === undefined ? undefined : financialStatementSeriesByKey(ctx.statements, key);
  if (series === undefined || ctx.statements === undefined) {
    return undefined;
  }
  return priorComparable(
    { ...series, annual: series.annual.filter(isYearAlignedFact) },
    anchor,
    earlierShareBasisPeriods(ctx.statements.omissionNotes, key),
  );
}

function yearOverYearDefinition(key: LensSeries, label: string): MetricDefinition {
  return {
    id: `${key}DeltaPercent`,
    label,
    unit: "whole-percent",
    basis: YOY_BASIS,
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const item = secItem(ctx);
        const value = readNumberMetric(item?.metrics, `${key}DeltaPercent`);
        const period = summaryPeriod(ctx, key);
        return value === undefined
          ? { status: "missing", reason: `no SEC ${SERIES_LABELS[key]} YoY` }
          : {
              status: "value",
              value,
              inputs: [
                evidenceInput(item, `${key}DeltaPercent`, label, "whole-percent", value, period),
              ],
              ...period,
            };
      }
      const anchor = latestFact(ctx, key);
      if (anchor === undefined) {
        return noFact(ctx, key);
      }
      const prior = comparablePrior(ctx, key, anchor);
      if (prior === undefined) {
        return {
          status: "missing",
          reason: `no prior-year ${SERIES_LABELS[key]} fact comparable to the period ending ${anchor.periodEnd}`,
          ...periodOf(anchor),
          inputs: [factInput(anchor, key)],
        };
      }
      const inputs = [factInput(prior, key), factInput(anchor, key)];
      if (prior.value === 0) {
        return {
          status: "not-meaningful",
          reason: `prior-year ${SERIES_LABELS[key]} is zero`,
          ...periodOf(anchor),
          inputs,
        };
      }
      return {
        status: "value",
        value: ((anchor.value - prior.value) / Math.abs(prior.value)) * 100,
        ...periodOf(anchor),
        inputs,
      };
    },
  };
}

function instantDefinition(id: string, key: LensSeries, label: string): MetricDefinition {
  return {
    id,
    label,
    unit: "currency",
    basis: "latest reported balance-sheet instant",
    compute: (ctx) => {
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
    },
  };
}

function netDebtDefinition(): MetricDefinition {
  return {
    id: "netDebt",
    label: "Net debt",
    unit: "currency",
    basis: "debt less cash at one balance-sheet instant",
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const period = summaryPeriod(ctx, "debt");
        const currentness = summaryCurrentness(ctx, "netDebt");
        const value = evidenceDisplayNetDebt(ctx);
        const item = secItem(ctx);
        const valuation = valuationItem(ctx);
        const valuationNetDebt = valuation?.metrics?.netDebt;
        const inputs =
          typeof valuationNetDebt === "number"
            ? [
                evidenceInput(
                  valuation,
                  "netDebt",
                  "net debt",
                  "currency",
                  valuationNetDebt,
                  period,
                ),
              ]
            : [
                ...chosenInput(item, "debt", "debt", period),
                ...chosenInput(item, "cash", "cash", period),
              ];
        if (!currentness.current) {
          return {
            status: "missing",
            reason: `stale net debt as of ${currentness.periodEnd ?? "an undated period"}`,
            ...period,
            inputs,
          };
        }
        return value === undefined
          ? { status: "missing", reason: "no SEC net debt", ...period, inputs }
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
      const inputs = [factInput(anchor, "debt"), factInput(cash, "cash")];
      const incomplete = incompleteDebtPeriod(ctx);
      if (incomplete !== undefined) {
        return {
          status: "missing",
          reason: `incomplete debt as of ${incomplete}`,
          ...periodOf(anchor),
          inputs,
        };
      }
      if (!isCurrentPeriod(ctx, anchor.periodEnd)) {
        return {
          status: "missing",
          reason: `stale debt as of ${anchor.periodEnd}`,
          ...periodOf(anchor),
          inputs,
        };
      }
      return {
        status: "value",
        value: anchor.value - cash.value,
        ...periodOf(anchor),
        ...(anchor.currency !== null ? { currency: anchor.currency } : {}),
        inputs,
      };
    },
  };
}

function currentRatioDefinition(): MetricDefinition {
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

function debtToEquityDefinition(): MetricDefinition {
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

function marketCapInput(ctx: MetricContext): MetricInput | undefined {
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
  const item = valuationItem(ctx);
  const value = readNumberMetric(item?.metrics, "marketCap");
  const currency = readStringMetric(item?.metrics, "quoteCurrency");
  return value === undefined
    ? undefined
    : {
        label: "market cap",
        value,
        artifact: "evidence",
        category: "valuation",
        key: "marketCap",
        ...(currency !== undefined ? { currency } : {}),
        unit: "currency",
        sourceIds: item?.sourceIds ?? [],
      };
}

function marketLeverageDefinition(id: "debtToMarketCap" | "netDebtToMarketCap"): MetricDefinition {
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
        const item = valuationItem(ctx);
        const value = readNumberMetric(item?.metrics, id);
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
        return {
          status: "value",
          value,
          inputs: [evidenceInput(item, id, id, "ratio-percent", value, period)],
          ...period,
        };
      }
      const marketCap = marketCapInput(ctx);
      const anchor = latestFact(ctx, "debt");
      if (anchor === undefined) {
        return noFact(ctx, "debt");
      }
      const cash = id === "netDebtToMarketCap" ? samePeriodFact(ctx, anchor, "cash") : undefined;
      const netDebt = cash === undefined ? undefined : anchor.value - cash.value;
      const numerator = id === "debtToMarketCap" ? anchor.value : netDebt;
      const inputs = [
        ...(marketCap === undefined ? [] : [marketCap]),
        factInput(anchor, "debt"),
        ...(cash === undefined ? [] : [factInput(cash, "cash")]),
      ];
      const incomplete = incompleteDebtPeriod(ctx);
      if (id === "netDebtToMarketCap" && incomplete !== undefined) {
        return {
          status: "missing",
          reason: `incomplete debt as of ${incomplete}`,
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
      if (
        typeof marketCap.currency === "string" &&
        [anchor, cash].some(
          (fact) => typeof fact?.currency === "string" && fact.currency !== marketCap.currency,
        )
      ) {
        return {
          status: "missing",
          reason: "filed amounts and quote market cap have incompatible currency",
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

function payoutRatioDefinition(): MetricDefinition {
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
      const yahooOutcome: MetricOutcome | undefined =
        yahoo === undefined || yahooRate === undefined || yahooEps === undefined || yahooEps === 0
          ? undefined
          : {
              status: "value",
              value: yahooRate / yahooEps,
              inputs: [
                evidenceInput(
                  yahoo,
                  "trailingAnnualDividendRate",
                  "trailing dividend rate",
                  "currency",
                  yahooRate,
                  yahooPeriod,
                ),
                evidenceInput(
                  yahoo,
                  "epsTrailingTwelveMonths",
                  "trailing EPS",
                  "number",
                  yahooEps,
                  yahooPeriod,
                ),
              ],
              ...yahooPeriod,
            };
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

function dividendYieldDefinition(): MetricDefinition {
  return {
    id: "dividendYield",
    label: "Dividend yield",
    unit: "whole-percent",
    basis: "Yahoo Finance trailing dividend yield",
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

function financingCurrentnessDefinitions(ctx: MetricContext): readonly MetricDefinition[] {
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

function peDefinitionsFor(
  ctx: MetricContext,
  yahoo: ExtendedEvidenceItem | undefined,
  yahooPeriod: MetricPeriod,
): readonly MetricDefinition[] {
  const trailingPe = readNumberMetric(yahoo?.metrics, "trailingPE");
  const forwardPe = readNumberMetric(yahoo?.metrics, "forwardPE");
  const epsTtm = readNumberMetric(yahoo?.metrics, "epsTrailingTwelveMonths");
  const epsForward = readNumberMetric(yahoo?.metrics, "epsForward");
  const trailingClean = peIsClean(trailingPe, epsTtm);
  const forwardClean = peIsClean(forwardPe, epsForward);
  return [
    {
      id: "peRatio",
      label: "PE",
      unit: trailingClean ? "ratio" : "text",
      basis: "Yahoo Finance trailing price/earnings",
      compute: () => {
        const value =
          trailingPe === undefined ? undefined : peMetricValue(trailingPe, epsTtm, trailingClean);
        return value === undefined || yahoo === undefined || trailingPe === undefined
          ? { status: "missing", reason: "no Yahoo trailing PE" }
          : {
              status: "value",
              value,
              inputs: [
                evidenceInput(yahoo, "trailingPE", "trailing PE", "ratio", trailingPe, yahooPeriod),
              ],
              ...yahooPeriod,
            };
      },
    },
    ...(trailingPe !== undefined && !trailingClean
      ? [
          {
            id: "epsTrailingTwelveMonths",
            label: "Trailing EPS",
            unit: "number" as const,
            basis: "Yahoo Finance trailing EPS",
            compute: () =>
              evidenceOutcome(
                yahoo,
                "epsTrailingTwelveMonths",
                "trailing EPS",
                "number",
                yahooPeriod,
              ),
          },
        ]
      : []),
    {
      id: "forwardPe",
      label: "Forward PE",
      unit: forwardClean ? "ratio" : "text",
      basis: "Yahoo Finance forward price/earnings",
      compute: () => {
        const value =
          forwardPe === undefined ? undefined : peMetricValue(forwardPe, epsForward, forwardClean);
        return value === undefined || yahoo === undefined || forwardPe === undefined
          ? { status: "missing", reason: "no Yahoo forward PE" }
          : {
              status: "value",
              value,
              inputs: [
                evidenceInput(yahoo, "forwardPE", "forward PE", "ratio", forwardPe, yahooPeriod),
              ],
              ...yahooPeriod,
            };
      },
    },
    ...(forwardPe !== undefined && !forwardClean
      ? [
          {
            id: "epsForward",
            label: "Forward EPS",
            unit: "number" as const,
            basis: "Yahoo Finance forward EPS",
            compute: () =>
              evidenceOutcome(yahoo, "epsForward", "forward EPS", "number", yahooPeriod),
          },
        ]
      : []),
    {
      id: "priceToBook",
      label: "Price/book",
      unit: "ratio",
      basis: "Yahoo Finance price/book",
      compute: () => evidenceOutcome(yahoo, "priceToBook", "price/book", "ratio", yahooPeriod),
    },
  ];
}

function valueDefinitions(ctx: MetricContext): readonly MetricDefinition[] {
  const valuation = valuationItem(ctx);
  const yahoo = yahooItem(ctx);
  // Annualized multiples date by revenue end only; a duration would label them as measured over it.
  const valuationPeriod = periodEndInput(readStringMetric(valuation?.metrics, "revenuePeriodEnd"));
  const yahooPeriod = periodEndInput(yahoo?.observedAt);
  const supportability = valuation?.metrics?.valuationSupportability;
  const caveat: readonly MetricDefinition[] =
    valuation !== undefined && supportability === "not-meaningful"
      ? [
          {
            id: "valuationCaveat",
            label: "Valuation caveat",
            unit: "text",
            basis: "valuation evidence marks revenue multiples not meaningful for this issuer",
            compute: () => ({
              status: "value",
              value: REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
              ...valuationPeriod,
              inputs: [
                evidenceInput(
                  valuation,
                  "valuationSupportability",
                  "valuation supportability",
                  "text",
                  "not-meaningful",
                  valuationPeriod,
                ),
              ],
            }),
          },
        ]
      : [];
  const dateBasis = valuationDateBasisMetric(valuation).map((tile): MetricDefinition => {
    const quoteObservedAt =
      readStringMetric(valuation?.metrics, "quoteObservedAt") ??
      readStringMetric(valuation?.metrics, "quoteTimeUtc");
    return {
      id: tile.key,
      label: tile.label,
      unit: tile.unit,
      basis: "market cap quote and balance sheet dates diverge",
      compute: (): MetricOutcome => ({
        status: "value",
        value: tile.value,
        ...(tile.periodEnd !== undefined ? { periodEnd: tile.periodEnd } : {}),
        inputs:
          quoteObservedAt === undefined
            ? []
            : [
                evidenceInput(
                  valuation,
                  "quoteObservedAt",
                  "EV date basis",
                  "text",
                  quoteObservedAt,
                  periodEndInput(tile.periodEnd),
                ),
              ],
      }),
    };
  });
  const peDefinitions = peDefinitionsFor(ctx, yahoo, yahooPeriod);
  return [
    ...caveat,
    ...dateBasis,
    {
      id: "enterpriseValue",
      label: "Enterprise value",
      unit: "currency",
      basis: "valuation evidence enterprise value at the quote date",
      compute: () =>
        evidenceOutcome(
          valuation,
          "enterpriseValue",
          "enterprise value",
          "currency",
          periodEndInput(
            readStringMetric(valuation?.metrics, "quoteObservedAt") ?? ctx.snapshot?.observedAt,
          ),
        ),
    },
    {
      id: "annualizedRevenue",
      label: "Annualized revenue",
      unit: "currency",
      basis: "valuation evidence revenue annualized to a year",
      compute: () =>
        evidenceOutcome(
          valuation,
          "annualizedRevenue",
          "annualized revenue",
          "currency",
          valuationPeriod,
        ),
    },
    {
      id: "evToAnnualizedRevenue",
      label: "EV/revenue",
      unit: "ratio",
      basis: "valuation evidence enterprise value / annualized revenue",
      compute: () =>
        evidenceOutcome(valuation, "evToAnnualizedRevenue", "EV/revenue", "ratio", valuationPeriod),
    },
    {
      id: "marketCapToAnnualizedRevenue",
      label: "Market cap/revenue",
      unit: "ratio",
      basis: "valuation evidence market cap / annualized revenue",
      compute: () =>
        evidenceOutcome(
          valuation,
          "marketCapToAnnualizedRevenue",
          "market cap/revenue",
          "ratio",
          valuationPeriod,
        ),
    },
    {
      id: "valuationSupportability",
      label: "Peer supportability",
      unit: "text",
      basis: "valuation evidence peer supportability",
      compute: (context) => {
        const item = valuationItem(context);
        const value = item?.metrics?.valuationSupportability;
        return typeof value !== "string"
          ? { status: "missing", reason: "no valuation supportability" }
          : {
              status: "value",
              value,
              inputs: [
                evidenceInput(
                  item,
                  "valuationSupportability",
                  "valuation supportability",
                  "text",
                  value,
                  valuationPeriod,
                ),
              ],
              ...valuationPeriod,
            };
      },
    },
    ...peDefinitions,
    {
      id: "pcfRatio",
      label: "PCF",
      unit: "ratio",
      basis: "quote market cap / operating cash flow annualized to a year",
      compute: (context) => {
        const marketCap = marketCapInput(context);
        if (context.statements === undefined) {
          const item = secItem(context);
          const operatingCashFlow = readNumberMetric(item?.metrics, "operatingCashFlow");
          const months = readNumberMetric(item?.metrics, "operatingCashFlowPeriodMonths");
          const denominator =
            operatingCashFlow === undefined ? undefined : annualize(operatingCashFlow, months);
          const period = summaryPeriod(context, "operatingCashFlow");
          return marketCap === undefined ||
            marketCap.value === undefined ||
            denominator === undefined ||
            denominator === 0
            ? { status: "missing", reason: "no SEC cash flow for PCF" }
            : {
                status: "value",
                value: Number(marketCap.value) / denominator,
                inputs: [
                  evidenceInput(
                    item,
                    "operatingCashFlow",
                    "operating cash flow",
                    "currency",
                    operatingCashFlow ?? 0,
                    period,
                  ),
                  marketCap,
                ],
                ...period,
              };
        }
        const anchor = latestFact(context, "operatingCashFlow");
        if (anchor === undefined) {
          return noFact(context, "operatingCashFlow");
        }
        const denominator = annualize(anchor.value, financialStatementPeriodMonths(anchor));
        const inputs = [
          factInput(anchor, "operatingCashFlow"),
          ...(marketCap === undefined ? [] : [marketCap]),
        ];
        if (denominator <= 0) {
          return {
            status: "not-meaningful",
            reason: "operating cash flow is not positive",
            ...periodOf(anchor),
            inputs: [factInput(anchor, "operatingCashFlow")],
          };
        }
        if (
          marketCap === undefined ||
          typeof marketCap.value !== "number" ||
          marketCap.value <= 0
        ) {
          return {
            status: "missing",
            reason: "no quote market cap",
            ...periodOf(anchor),
            inputs,
          };
        }
        return {
          status: "value",
          value: marketCap.value / denominator,
          ...periodOf(anchor),
          inputs,
        };
      },
    },
  ];
}

function verifiedInput(
  ctx: MetricContext,
  key: string,
  label: string,
  value: number,
  period: MetricPeriod,
  unit: LensValueUnit = "number",
  currency?: string,
): MetricInput {
  return {
    label,
    value,
    artifact: "verifiedSnapshot",
    key,
    unit,
    ...(currency !== undefined ? { currency } : {}),
    sourceIds:
      ctx.verifiedSnapshot === undefined
        ? []
        : [verifiedSnapshotSourceId(ctx.verifiedSnapshot.symbol)],
    ...(period.periodEnd !== undefined ? { periodEnd: period.periodEnd } : {}),
  };
}

function quoteCurrencyOf(ctx: MetricContext): string {
  return ctx.snapshot?.identity?.quoteCurrency ?? "USD";
}

function momentumDefinitions(): readonly MetricDefinition[] {
  const session = (ctx: MetricContext) => periodEndInput(ctx.verifiedSnapshot?.latestSessionDate);
  return [
    {
      id: "latestClose",
      label: "Latest close",
      unit: "currency",
      basis: "last completed session close from the verified market snapshot",
      compute: (ctx) => {
        const close = ctx.verifiedSnapshot?.ohlcv.close;
        return close === undefined
          ? { status: "missing", reason: "no verified market snapshot close" }
          : {
              status: "value",
              value: close,
              currency: quoteCurrencyOf(ctx),
              inputs: [
                verifiedInput(
                  ctx,
                  "latestClose",
                  "latest close",
                  close,
                  session(ctx),
                  "currency",
                  quoteCurrencyOf(ctx),
                ),
              ],
              ...session(ctx),
            };
      },
    },
    ...(["sma50", "sma200", "rsi14", "macdHistogram"] as const).map(
      (key): MetricDefinition => ({
        id: key,
        label: key === "macdHistogram" ? "MACD histogram" : key.toUpperCase(),
        unit: "number",
        basis: "last completed session indicator from the verified market snapshot",
        compute: (ctx) => {
          const value = ctx.verifiedSnapshot?.indicators?.[key] ?? undefined;
          return value === undefined
            ? { status: "missing", reason: `no verified ${key}` }
            : {
                status: "value",
                value,
                inputs: [verifiedInput(ctx, key, key, value, session(ctx))],
                ...session(ctx),
              };
        },
      }),
    ),
  ];
}

function filedInput(metric: MetricResult): boolean {
  return metric.inputs.some(
    (input) =>
      input.artifact === "statements" ||
      (input.artifact === "evidence" && input.category === "sec-edgar"),
  );
}

function valueOf(section: readonly MetricResult[] | undefined, id: string): number | undefined {
  const metric = section?.find((candidate) => candidate.id === id);
  return metric?.status === "value" && typeof metric.value === "number" ? metric.value : undefined;
}

function meets(
  value: number | undefined,
  criterion: (input: number) => boolean,
): boolean | undefined {
  return value === undefined ? undefined : criterion(value);
}

function filedMetric(section: readonly MetricResult[] | undefined, id: string): boolean {
  const metric = section?.find((candidate) => candidate.id === id);
  return (
    metric?.inputs.some(
      (input) =>
        input.artifact === "statements" ||
        (input.artifact === "evidence" && input.category === "sec-edgar"),
    ) === true
  );
}

function qualityPosture(section: readonly MetricResult[] | undefined): FinancialLensPosture {
  return postureFrom([
    positiveOf(valueOf(section, "grossMargin")),
    positiveOf(valueOf(section, "operatingMargin")),
    positiveOf(valueOf(section, "netMargin")),
    positiveOf(valueOf(section, "freeCashFlowProxy")),
  ]);
}

function growthPosture(section: readonly MetricResult[] | undefined): FinancialLensPosture {
  return postureFrom(
    [
      "revenueDeltaPercent",
      "grossProfitDeltaPercent",
      "operatingIncomeDeltaPercent",
      "netIncomeDeltaPercent",
      "dilutedEpsDeltaPercent",
      "operatingCashFlowDeltaPercent",
    ].map((id) => positiveOf(valueOf(section, id))),
    2,
  );
}

function summaryNetDebtCriterion(ctx: MetricContext): boolean | undefined {
  if (evidenceDisplayNetDebt(ctx) === undefined || !summaryCurrentness(ctx, "netDebt").current) {
    return undefined;
  }
  return meets(evidenceGuardedNetDebt(ctx), (value) => value <= 0);
}

function strengthPosture(
  ctx: MetricContext,
  section: readonly MetricResult[] | undefined,
): FinancialLensPosture {
  const netDebtCriterion =
    ctx.statements === undefined
      ? summaryNetDebtCriterion(ctx)
      : meets(valueOf(section, "netDebt"), (value) => value <= 0);
  return postureFrom([
    netDebtCriterion,
    meets(valueOf(section, "netDebtToMarketCap"), (value) => value <= 0.25),
    meets(valueOf(section, "debtToMarketCap"), (value) => value <= 0.5),
    meets(valueOf(section, "currentRatio"), (value) => value >= 1),
    filedMetric(section, "payoutRatio")
      ? atOrBelow(valueOf(section, "payoutRatio"), 0.8)
      : undefined,
  ]);
}

function valuePosture(ctx: MetricContext): FinancialLensPosture {
  const supportability = valuationItem(ctx)?.metrics?.valuationSupportability;
  return postureFrom([
    supportability === undefined || supportability === "not-meaningful"
      ? undefined
      : supportability === "supported",
  ]);
}

function momentumPosture(section: readonly MetricResult[] | undefined): FinancialLensPosture {
  const close = valueOf(section, "latestClose");
  const sma50 = valueOf(section, "sma50");
  const sma200 = valueOf(section, "sma200");
  const rsi14 = valueOf(section, "rsi14");
  const macdHistogram = valueOf(section, "macdHistogram");
  return postureFrom([
    close === undefined || sma50 === undefined ? undefined : close > sma50,
    sma50 === undefined || sma200 === undefined ? undefined : sma50 > sma200,
    meets(rsi14, (value) => value >= 40 && value <= 70),
    meets(macdHistogram, (value) => value >= 0),
  ]);
}

function lensDefinitions(
  ctx: MetricContext,
): Readonly<Record<FinancialLensName, readonly MetricDefinition[]>> {
  return {
    Quality: [
      marginDefinition("grossMargin", "grossProfit", "revenue", "Gross margin"),
      marginDefinition("operatingMargin", "operatingIncome", "revenue", "Operating margin"),
      marginDefinition("netMargin", "netIncome", "revenue", "Net margin"),
      freeCashFlowDefinition(),
      cashConversionDefinition(),
      returnOnDefinition(
        "roe",
        "stockholdersEquity",
        returnOnLabel(ctx, "roe", "stockholdersEquity"),
      ),
      returnOnDefinition("roa", "totalAssets", returnOnLabel(ctx, "roa", "totalAssets")),
      ...consolidatedIncomeDefinitions(ctx),
    ],
    Growth: (
      [
        "revenue",
        "grossProfit",
        "operatingIncome",
        "netIncome",
        "dilutedEps",
        "continuingIncome",
        "continuingDilutedEps",
        "operatingCashFlow",
      ] as const
    ).map((key) => yearOverYearDefinition(key, yoyLabel(ctx, key))),
    "Financial Strength": [
      instantDefinition("cash", "cash", "Cash"),
      instantDefinition("debt", "debt", debtLabel(ctx)),
      netDebtDefinition(),
      marketLeverageDefinition("debtToMarketCap"),
      marketLeverageDefinition("netDebtToMarketCap"),
      currentRatioDefinition(),
      debtToEquityDefinition(),
      payoutRatioDefinition(),
      dividendYieldDefinition(),
      ...financingCurrentnessDefinitions(ctx),
    ],
    Value: valueDefinitions(ctx),
    Momentum: momentumDefinitions(),
  };
}

export function financialLensMetrics(ctx: MetricContext): {
  readonly sections: readonly MetricSection[];
  readonly lensMetrics: Readonly<Record<FinancialLensName, readonly MetricResult[]>>;
  readonly postures: Readonly<Record<FinancialLensName, FinancialLensPosture>>;
  readonly sourceGaps: readonly SourceGap[];
} {
  const definitions = lensDefinitions(ctx);
  const evaluated = FINANCIAL_LENS_ORDER.map((name) => {
    const result = evaluateMetricSection(
      financialLensMetricSectionId(name),
      `Financial Lens: ${name}`,
      definitions[name],
      ctx,
    );
    return [name, result] as const;
  });
  const emitted = evaluated.filter(([, { section }]) => section.metrics.some(filedInput));
  const sections = emitted.map(([, { section }]) => section);
  const lensMetrics = Object.fromEntries(
    evaluated.map(([name, { section }]) => [name, section.metrics] as const),
  ) as Readonly<Record<FinancialLensName, readonly MetricResult[]>>;
  const postures: Record<FinancialLensName, FinancialLensPosture> = {
    Quality: qualityPosture(lensMetrics.Quality),
    Growth: growthPosture(lensMetrics.Growth),
    "Financial Strength": strengthPosture(ctx, lensMetrics["Financial Strength"]),
    Value: valuePosture(ctx),
    Momentum: momentumPosture(lensMetrics.Momentum),
  };
  return {
    sections,
    lensMetrics,
    postures,
    sourceGaps: emitted.flatMap(([, { sourceGaps }]) => sourceGaps),
  };
}
