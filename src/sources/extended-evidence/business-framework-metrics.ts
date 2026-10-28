import { ENTERPRISE_VALUE_BASIS } from "./enterprise-value-bridge";
import type { ExtendedEvidenceCategory, ExtendedEvidenceItem } from "../../domain/evidence";
import type { SourceGap } from "../../domain/sources";
import type {
  BusinessFrameworkPosture,
  BusinessFrameworkSectionName,
  BusinessLifecyclePhase,
} from "./business-framework";
import { priorComparable } from "./financial-lens-canonical";
import {
  itemByCategory,
  secFundamentalItem,
  secPeriod as secItemPeriod,
  secScope,
} from "./financial-lens-metrics";
import { isCurrentBalanceSheetPeriod } from "./valuation-comps-support";
import { depositoryIssuerSic } from "./industry-classification";
import { SEC_METRIC_DEFINITIONS } from "./sec-fundamentals-format";
import {
  conceptScope,
  scopedLabel,
  TOTAL_OPERATIONS_SCOPE,
} from "./financial-statement-definitions";
import {
  earlierShareBasisPeriods,
  financialStatementFacts,
  financialStatementFactsAreCompatible,
  financialStatementPeriodMonths,
  financialStatementSeriesByKey,
  isYearAligned,
  latestFinancialStatementFact,
} from "./financial-statement-selection";
import type { FinancialStatementFact } from "./financial-statements-contract";
import {
  evaluateMetricSection,
  statementInput,
  type MetricContext,
  type MetricDefinition,
  type MetricInput,
  type MetricOutcome,
  type MetricResult,
  type MetricSection,
  seriesNotFiled,
} from "./metric-engine";
import { readNumberMetric, readStringMetric } from "./utils";
import { REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT } from "./valuation-comps";
import type { LensValueUnit } from "./value-format";

type FrameworkSeries =
  | "revenue"
  | "grossProfit"
  | "operatingIncome"
  | "netIncome"
  | "continuingIncome"
  | "operatingCashFlow"
  | "dividendsPaid"
  | "shareRepurchases";

const SERIES_LABELS: Readonly<Record<FrameworkSeries, string>> = {
  revenue: "revenue",
  grossProfit: "gross profit",
  operatingIncome: "operating income",
  netIncome: "net income",
  continuingIncome: "continuing operations income",
  operatingCashFlow: "operating cash flow",
  dividendsPaid: "dividends paid",
  shareRepurchases: "share repurchases",
};

const LATEST_PERIOD_BASIS = "latest reported period: a year-aligned annual or an interim filing";
const YOY_CHANGE = { over: "YoY" };
const YOY_BASIS =
  "latest reported period vs the same-length period one year earlier, same concept and unit";

interface PhaseClassificationInput {
  readonly revenueDeltaPercent?: number | undefined;
  readonly operatingIncome?: number | undefined;
  readonly operatingIncomeDeltaPercent?: number | undefined;
  readonly netIncome?: number | undefined;
  readonly netIncomeDeltaPercent?: number | undefined;
  readonly dividendsPaid?: number | undefined;
  readonly shareRepurchases?: number | undefined;
  readonly dividendYield?: number | undefined;
}

function hasCapitalReturn(input: PhaseClassificationInput): boolean {
  return (
    (input.dividendsPaid !== undefined && Math.abs(input.dividendsPaid) > 0) ||
    (input.shareRepurchases !== undefined && Math.abs(input.shareRepurchases) > 0) ||
    (input.dividendYield !== undefined && input.dividendYield > 0)
  );
}

export function classifyBusinessLifecyclePhase(
  input: PhaseClassificationInput,
): BusinessLifecyclePhase {
  if (
    input.revenueDeltaPercent !== undefined &&
    input.revenueDeltaPercent < 0 &&
    (input.operatingIncomeDeltaPercent ?? input.netIncomeDeltaPercent ?? -1) < 0
  ) {
    return "decline";
  }
  if (input.revenueDeltaPercent !== undefined && input.revenueDeltaPercent >= 30) {
    return "hyper-growth";
  }
  if (hasCapitalReturn(input) && (input.revenueDeltaPercent ?? 0) <= 15) {
    return "capital-return";
  }
  if (
    input.operatingIncome !== undefined &&
    input.operatingIncome <= 0 &&
    (input.netIncome === undefined || input.netIncome <= 0)
  ) {
    return "startup";
  }
  return "operating-leverage";
}

function isYearAlignedFact(fact: FinancialStatementFact): boolean {
  return fact.periodStart !== undefined && isYearAligned(fact.periodStart, fact.periodEnd);
}

// For latest-period metrics, an annual fact counts only when it spans 350-380 days.
function eligibleFacts(
  ctx: MetricContext,
  key: FrameworkSeries,
): readonly FinancialStatementFact[] {
  const series =
    ctx.statements === undefined ? undefined : financialStatementSeriesByKey(ctx.statements, key);
  return series === undefined
    ? []
    : financialStatementFacts(series).filter(
        (fact) => fact.periodType === "interim" || isYearAlignedFact(fact),
      );
}

function latestFact(ctx: MetricContext, key: FrameworkSeries): FinancialStatementFact | undefined {
  return latestFinancialStatementFact(eligibleFacts(ctx, key));
}

function factInput(fact: FinancialStatementFact, key: FrameworkSeries): MetricInput {
  return statementInput(fact, key, SERIES_LABELS[key]);
}

function noFact(ctx: MetricContext, key: FrameworkSeries): MetricOutcome {
  if (seriesNotFiled(ctx, key)) {
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

function periodOf(fact: FinancialStatementFact): {
  readonly periodEnd: string;
  readonly periodMonths?: number;
} {
  const months = financialStatementPeriodMonths(fact);
  return { periodEnd: fact.periodEnd, ...(months !== undefined ? { periodMonths: months } : {}) };
}

// Evidence items publish each value's period beside it as `${key}PeriodEnd` / `${key}PeriodMonths`.
function keyPeriod(
  item: ExtendedEvidenceItem | undefined,
  key: string,
): { readonly periodEnd?: string; readonly periodMonths?: number } {
  const periodEnd = readStringMetric(item?.metrics, `${key}PeriodEnd`);
  const periodMonths = readNumberMetric(item?.metrics, `${key}PeriodMonths`);
  return {
    ...(periodEnd !== undefined ? { periodEnd } : {}),
    ...(periodMonths !== undefined ? { periodMonths } : {}),
  };
}

function secPeriod(ctx: MetricContext, key: string) {
  return keyPeriod(itemByCategory(ctx.evidence, "sec-edgar"), key);
}

function secInput(ctx: MetricContext, key: string, label: string, unit: LensValueUnit) {
  return ctx.statements === undefined
    ? evidenceInput(ctx, "sec-edgar", key, label, unit)
    : undefined;
}

function secSummaryCurrency(key: FrameworkSeries): string | undefined {
  return SEC_METRIC_DEFINITIONS.find((definition) => definition.key === key)?.unitKeys[0];
}

function secAmount(ctx: MetricContext, key: FrameworkSeries): MetricOutcome {
  const found = secInput(ctx, key, SERIES_LABELS[key], "currency");
  if (found === undefined) {
    return noFact(ctx, key);
  }
  const currency = secSummaryCurrency(key);
  return {
    status: "value",
    value: found.value,
    ...(currency !== undefined ? { currency } : {}),
    ...secPeriod(ctx, key),
    inputs: [found],
  };
}

function latestAmount(key: FrameworkSeries) {
  return (ctx: MetricContext): MetricOutcome => {
    if (ctx.statements === undefined) {
      return secAmount(ctx, key);
    }
    const fact = latestFact(ctx, key);
    if (fact === undefined) {
      return noFact(ctx, key);
    }
    return {
      status: "value",
      value: fact.value,
      ...(fact.currency !== null ? { currency: fact.currency } : {}),
      ...periodOf(fact),
      inputs: [factInput(fact, key)],
    };
  };
}

function yearOverYear(ctx: MetricContext, key: FrameworkSeries): MetricOutcome {
  if (ctx.statements === undefined) {
    const found = secInput(ctx, `${key}DeltaPercent`, `${SERIES_LABELS[key]} YoY`, "whole-percent");
    return found === undefined
      ? noFact(ctx, key)
      : { status: "value", value: found.value, ...secPeriod(ctx, key), inputs: [found] };
  }
  const latest = latestFact(ctx, key);
  const series =
    ctx.statements === undefined ? undefined : financialStatementSeriesByKey(ctx.statements, key);
  if (latest === undefined || series === undefined || ctx.statements === undefined) {
    return noFact(ctx, key);
  }
  const prior = priorComparable(
    { ...series, annual: series.annual.filter(isYearAlignedFact) },
    latest,
    earlierShareBasisPeriods(ctx.statements.omissionNotes, key),
  );
  const label = SERIES_LABELS[key];
  if (prior === undefined) {
    return {
      status: "missing",
      reason: `no prior-year ${label} fact comparable to the period ending ${latest.periodEnd}`,
      ...periodOf(latest),
      inputs: [factInput(latest, key)],
    };
  }
  const inputs = [factInput(prior, key), factInput(latest, key)];
  if (prior.value === 0) {
    return {
      status: "not-meaningful",
      reason: `prior-year ${label} is zero`,
      ...periodOf(latest),
      inputs,
    };
  }
  return {
    status: "value",
    value: ((latest.value - prior.value) / Math.abs(prior.value)) * 100,
    ...periodOf(latest),
    inputs,
  };
}

function secMargin(
  ctx: MetricContext,
  numeratorKey: FrameworkSeries,
  denominatorKey: FrameworkSeries,
): MetricOutcome {
  const numerator = secInput(ctx, numeratorKey, SERIES_LABELS[numeratorKey], "currency");
  const denominator = secInput(ctx, denominatorKey, SERIES_LABELS[denominatorKey], "currency");
  if (numerator === undefined || denominator === undefined) {
    return noFact(ctx, numerator === undefined ? numeratorKey : denominatorKey);
  }
  const inputs = [numerator, denominator];
  // The sec-edgar flow anchor skips the start check when revenue is undated, so prove the span here.
  const period = secPeriod(ctx, numeratorKey);
  const denominatorPeriod = secPeriod(ctx, denominatorKey);
  if (
    period.periodEnd === undefined ||
    period.periodMonths === undefined ||
    period.periodEnd !== denominatorPeriod.periodEnd ||
    period.periodMonths !== denominatorPeriod.periodMonths
  ) {
    return {
      status: "missing",
      reason: `no same-period SEC ${SERIES_LABELS[numeratorKey]} and ${SERIES_LABELS[denominatorKey]}`,
      inputs,
    };
  }
  return denominator.value <= 0
    ? {
        status: "not-meaningful",
        reason: `${SERIES_LABELS[denominatorKey]} is not positive`,
        ...period,
        inputs,
      }
    : { status: "value", value: numerator.value / denominator.value, ...period, inputs };
}

// An unfiled numerator is a wildcard: the filed denominator still runs its own fact and sign gates first.
function unanchoredMargin(
  ctx: MetricContext,
  numeratorKey: FrameworkSeries,
  denominatorKey: FrameworkSeries,
): MetricOutcome {
  const numerator = noFact(ctx, numeratorKey);
  if (numerator.status !== "missing" || numerator.cause !== "not-filed") {
    return numerator;
  }
  const denominator = latestFact(ctx, denominatorKey);
  if (denominator === undefined) {
    return noFact(ctx, denominatorKey);
  }
  const inputs = [factInput(denominator, denominatorKey)];
  return denominator.value <= 0
    ? {
        status: "not-meaningful",
        reason: `${SERIES_LABELS[denominatorKey]} is not positive`,
        ...periodOf(denominator),
        inputs,
      }
    : { ...numerator, ...periodOf(denominator), inputs };
}

// The numerator anchors the period; the denominator must share its exact period identity.
function margin(numeratorKey: FrameworkSeries, denominatorKey: FrameworkSeries) {
  return (ctx: MetricContext): MetricOutcome => {
    if (ctx.statements === undefined) {
      return secMargin(ctx, numeratorKey, denominatorKey);
    }
    const anchor = latestFact(ctx, numeratorKey);
    if (anchor === undefined) {
      return unanchoredMargin(ctx, numeratorKey, denominatorKey);
    }
    const denominator = latestFinancialStatementFact(
      eligibleFacts(ctx, denominatorKey).filter(
        (fact) => fact.periodKey === anchor.periodKey && fact.periodType === anchor.periodType,
      ),
    );
    const denominatorLabel = SERIES_LABELS[denominatorKey];
    if (denominator === undefined) {
      const notFiled = seriesNotFiled(ctx, denominatorKey);
      return {
        status: "missing",
        reason: notFiled
          ? `${denominatorLabel} not filed by the issuer`
          : `no same-period ${denominatorLabel} for the period ending ${anchor.periodEnd}`,
        ...(notFiled ? { cause: "not-filed" as const } : {}),
        ...periodOf(anchor),
        inputs: [factInput(anchor, numeratorKey)],
      };
    }
    const inputs = [factInput(anchor, numeratorKey), factInput(denominator, denominatorKey)];
    if (!financialStatementFactsAreCompatible([anchor, denominator])) {
      return {
        status: "missing",
        reason: `${denominatorLabel} currency or unit differs for the period ending ${anchor.periodEnd}`,
        ...periodOf(anchor),
        inputs,
      };
    }
    if (denominator.value <= 0) {
      return {
        status: "not-meaningful",
        reason: `${denominatorLabel} is not positive`,
        ...periodOf(anchor),
        inputs,
      };
    }
    return {
      status: "value",
      value: anchor.value / denominator.value,
      ...periodOf(anchor),
      inputs,
    };
  };
}

function evidenceInput(
  ctx: MetricContext,
  category: ExtendedEvidenceCategory,
  key: string,
  label: string,
  unit: LensValueUnit,
): (MetricInput & { readonly value: number }) | undefined {
  const item = itemByCategory(ctx.evidence, category);
  const value = readNumberMetric(item?.metrics, key);
  return item === undefined || value === undefined
    ? undefined
    : { label, value, artifact: "evidence", category, key, unit, sourceIds: item.sourceIds };
}

function evidenceValue(
  category: ExtendedEvidenceCategory,
  key: string,
  label: string,
  unit: LensValueUnit,
  period: (item: ExtendedEvidenceItem | undefined) => ReturnType<typeof keyPeriod> = (item) =>
    keyPeriod(item, key),
) {
  return (ctx: MetricContext): MetricOutcome => {
    const found = evidenceInput(ctx, category, key, label, unit);
    if (
      found === undefined &&
      category === "financial-lens" &&
      key === "debtToMarketCap" &&
      seriesNotFiled(ctx, "debt")
    ) {
      return { status: "missing", reason: "debt not filed by the issuer", cause: "not-filed" };
    }
    return found === undefined
      ? { status: "missing", reason: `no ${category} ${label}` }
      : {
          status: "value",
          value: found.value,
          ...period(itemByCategory(ctx.evidence, category)),
          inputs: [found],
        };
  };
}

// Provider quotes carry no reporting period; date them by observation, as the financial lens does.
function observedPeriod(item: ExtendedEvidenceItem | undefined) {
  return item === undefined ? {} : { periodEnd: item.observedAt };
}

function depositoryEnterpriseValue(ctx: MetricContext): string | undefined {
  const sic = depositoryIssuerSic(ctx.evidence);
  return sic === undefined
    ? undefined
    : `depository issuer (SIC ${sic}): enterprise value is not an operating basis`;
}

function valueOf(outcome: MetricOutcome): number | undefined {
  return outcome.status === "value" && typeof outcome.value === "number"
    ? outcome.value
    : undefined;
}

function phaseInputs(ctx: MetricContext): {
  readonly classification: PhaseClassificationInput;
  readonly inputs: readonly MetricInput[];
} {
  const outcomes = {
    revenueDeltaPercent: yearOverYear(ctx, "revenue"),
    operatingIncome: latestAmount("operatingIncome")(ctx),
    operatingIncomeDeltaPercent: yearOverYear(ctx, "operatingIncome"),
    netIncome: latestAmount("netIncome")(ctx),
    netIncomeDeltaPercent: yearOverYear(ctx, "netIncome"),
    dividendsPaid: latestAmount("dividendsPaid")(ctx),
    // Only the companyfacts summary carries repurchases; the canonical statement path never fed them.
    ...(ctx.statements === undefined
      ? { shareRepurchases: secAmount(ctx, "shareRepurchases") }
      : {}),
  };
  const dividendYield = evidenceInput(
    ctx,
    "yahoo-fundamentals",
    "dividendYield",
    "dividend yield",
    "whole-percent",
  );
  const used = Object.values(outcomes).filter((outcome) => valueOf(outcome) !== undefined);
  return {
    classification: {
      ...Object.fromEntries(
        Object.entries(outcomes).map(([key, outcome]) => [key, valueOf(outcome)]),
      ),
      dividendYield: dividendYield?.value,
    },
    inputs: [
      ...new Map(
        used
          .flatMap((outcome) => outcome.inputs ?? [])
          .map((item) => [
            `${String(item.series ?? item.key)}|${String(item.periodKey)}|${String(item.periodType)}`,
            item,
          ]),
      ).values(),
      ...(dividendYield === undefined ? [] : [dividendYield]),
    ],
  };
}

function netIncomeYoyLabel(ctx: MetricContext): string {
  if (ctx.statements === undefined) {
    return scopedLabel(
      "Net income YoY",
      secScope(itemByCategory(ctx.evidence, "sec-edgar"), "netIncome"),
    );
  }
  const netIncome = latestFact(ctx, "netIncome");
  const continuing = latestFact(ctx, "continuingIncome");
  const continuingReported =
    continuing !== undefined &&
    (netIncome === undefined || continuing.periodEnd >= netIncome.periodEnd);
  return scopedLabel(
    "Net income YoY",
    conceptScope(netIncome?.concept) ?? (continuingReported ? TOTAL_OPERATIONS_SCOPE : undefined),
  );
}

function currentRatio(ctx: MetricContext): MetricOutcome {
  const found = evidenceInput(ctx, "financial-lens", "currentRatio", "current ratio", "ratio");
  if (found === undefined) {
    const unfiled = ["currentAssets", "currentLiabilities"] as const;
    const key = unfiled.find((series) => seriesNotFiled(ctx, series));
    return key === undefined
      ? { status: "missing", reason: "no financial-lens current ratio" }
      : {
          status: "missing",
          reason: `${key === "currentAssets" ? "current assets" : "current liabilities"} not filed by the issuer`,
          cause: "not-filed",
        };
  }
  const periodEnd = readStringMetric(
    itemByCategory(ctx.evidence, "financial-lens")?.metrics,
    "currentRatioPeriodEnd",
  );
  // A balance sheet past its next filing due date is withheld, never shown as current.
  if (
    ctx.asOf === undefined ||
    !currentRatioIsCurrent(secFundamentalItem(ctx.evidence), ctx.asOf)
  ) {
    return {
      status: "missing",
      reason: `stale current ratio as of ${periodEnd ?? "an undated balance sheet"}`,
      inputs: [found],
    };
  }
  return {
    status: "value",
    value: found.value,
    ...(periodEnd !== undefined ? { periodEnd } : {}),
    inputs: [found],
  };
}

// Pass-through lens values cite the lens metric's own inputs, never the lens bundle.
function citedByLens(
  lensMetrics: readonly MetricResult[],
  id: string,
  compute: (ctx: MetricContext) => MetricOutcome,
): (ctx: MetricContext) => MetricOutcome {
  return (ctx) => {
    const outcome = compute(ctx);
    const lens = lensMetrics.find(
      (metric) => metric.id === id && metric.status === "value" && metric.sourceIds.length > 0,
    );
    if (lens === undefined && outcome.status === "value") {
      return {
        status: "missing",
        reason: `no cited financial-lens ${outcome.inputs[0]?.label ?? id}`,
      };
    }
    return { ...outcome, inputs: lens?.inputs ?? [] };
  };
}

function valuationSupportability(ctx: MetricContext): string | number | undefined {
  return itemByCategory(ctx.evidence, "valuation")?.metrics?.valuationSupportability;
}

function valuationCaveat(ctx: MetricContext): readonly MetricDefinition[] {
  const item = itemByCategory(ctx.evidence, "valuation");
  if (item === undefined || valuationSupportability(ctx) !== "not-meaningful") {
    return [];
  }
  return [
    {
      id: "valuationCaveat",
      label: "Valuation caveat",
      unit: "text",
      basis: "valuation evidence marks revenue multiples not meaningful for this issuer",
      compute: () => ({
        status: "value",
        value: REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
        inputs: [
          {
            label: "valuation supportability",
            value: "not-meaningful",
            artifact: "evidence",
            category: "valuation",
            key: "valuationSupportability",
            unit: "text",
            sourceIds: item.sourceIds,
          },
        ],
      }),
    },
  ];
}

const REVENUE_YOY: MetricDefinition = {
  id: "revenueDeltaPercent",
  label: "Revenue YoY",
  unit: "whole-percent",
  basis: YOY_BASIS,
  change: YOY_CHANGE,
  compute: (ctx) => yearOverYear(ctx, "revenue"),
};

function amount(id: FrameworkSeries, label: string): MetricDefinition {
  return { id, label, unit: "currency", basis: LATEST_PERIOD_BASIS, compute: latestAmount(id) };
}

function sectionDefinitions(
  ctx: MetricContext,
  lensMetrics: readonly MetricResult[],
): Readonly<Partial<Record<BusinessFrameworkSectionName, readonly MetricDefinition[]>>> {
  return {
    Business: [
      amount("revenue", "Revenue"),
      amount("grossProfit", "Gross profit"),
      amount("operatingIncome", "Operating income"),
    ],
    Phase: [
      {
        id: "phase",
        label: "Phase",
        unit: "text",
        basis:
          "lifecycle rule over revenue, income and their YoY changes, dividends paid and dividend yield",
        compute: (context) => {
          const { classification, inputs } = phaseInputs(context);
          return inputs.some((input) => input.sourceIds.length > 0)
            ? { status: "value", value: classifyBusinessLifecyclePhase(classification), inputs }
            : { status: "missing", reason: "no cited lifecycle classification inputs", inputs };
        },
      },
      REVENUE_YOY,
      {
        id: "dividendYield",
        label: "Dividend yield",
        unit: "whole-percent",
        basis: "Yahoo Finance trailing dividend yield",
        compute: evidenceValue(
          "yahoo-fundamentals",
          "dividendYield",
          "dividend yield",
          "whole-percent",
          observedPeriod,
        ),
      },
      ...(ctx.statements === undefined ? [amount("shareRepurchases", "Share repurchases")] : []),
    ],
    Moat: [
      {
        id: "grossMargin",
        label: "Gross margin",
        unit: "ratio-percent",
        basis: "gross profit / revenue for the latest gross profit period",
        compute: margin("grossProfit", "revenue"),
      },
      {
        id: "operatingMargin",
        label: "Operating margin",
        unit: "ratio-percent",
        basis: "operating income / revenue for the latest operating income period",
        compute: margin("operatingIncome", "revenue"),
      },
    ],
    Growth: [
      REVENUE_YOY,
      {
        id: "operatingIncomeDeltaPercent",
        label: "Operating income YoY",
        unit: "whole-percent",
        basis: YOY_BASIS,
        change: YOY_CHANGE,
        compute: (context) => yearOverYear(context, "operatingIncome"),
      },
      {
        id: "netIncomeDeltaPercent",
        label: netIncomeYoyLabel(ctx),
        unit: "whole-percent",
        basis: YOY_BASIS,
        change: YOY_CHANGE,
        compute: (context) => yearOverYear(context, "netIncome"),
      },
    ],
    Risk: [
      {
        id: "currentRatio",
        label: "Current ratio",
        unit: "ratio",
        basis: "financial lens current assets / current liabilities at the latest balance sheet",
        compute: citedByLens(lensMetrics, "currentRatio", currentRatio),
      },
      {
        id: "debtToMarketCap",
        label: "Debt/market cap",
        unit: "ratio-percent",
        basis: "financial lens debt / quote market cap",
        compute: citedByLens(
          lensMetrics,
          "debtToMarketCap",
          evidenceValue("financial-lens", "debtToMarketCap", "debt/market cap", "ratio-percent"),
        ),
      },
    ],
    Valuation: [
      ...valuationCaveat(ctx),
      {
        id: "trailingPE",
        label: "Trailing PE",
        unit: "ratio",
        basis: "Yahoo Finance trailing price/earnings",
        compute: evidenceValue(
          "yahoo-fundamentals",
          "trailingPE",
          "trailing PE",
          "ratio",
          observedPeriod,
        ),
      },
      {
        id: "forwardPE",
        label: "Forward PE",
        unit: "ratio",
        basis: "Yahoo Finance forward price/earnings",
        compute: evidenceValue(
          "yahoo-fundamentals",
          "forwardPE",
          "forward PE",
          "ratio",
          observedPeriod,
        ),
      },
      {
        id: "evToAnnualizedRevenue",
        label: "EV/revenue",
        unit: "ratio",
        basis: `valuation evidence enterprise value / TTM revenue; ${ENTERPRISE_VALUE_BASIS}`,
        applicable: depositoryEnterpriseValue,
        compute: citedByLens(
          lensMetrics,
          "evToAnnualizedRevenue",
          evidenceValue("valuation", "evToAnnualizedRevenue", "EV/revenue", "ratio", (item) => {
            // TTM revenue: date by its end only, as the financial lens does.
            const { periodEnd } = keyPeriod(item, "revenue");
            return periodEnd === undefined ? {} : { periodEnd };
          }),
        ),
      },
    ],
  };
}

function criteriaPosture(
  criteria: readonly (boolean | undefined)[],
  requiredCount = 1,
): BusinessFrameworkPosture {
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

function meets(
  value: number | undefined,
  criterion: (value: number) => boolean,
): boolean | undefined {
  return value === undefined ? undefined : criterion(value);
}

function postures(
  ctx: MetricContext,
  sections: Readonly<Partial<Record<BusinessFrameworkSectionName, MetricSection>>>,
): Readonly<Record<BusinessFrameworkSectionName, BusinessFrameworkPosture>> {
  const valueIn = (name: BusinessFrameworkSectionName, id: string): number | undefined => {
    const result = sections[name]?.metrics.find((metric) => metric.id === id);
    return result?.status === "value" && typeof result.value === "number"
      ? result.value
      : undefined;
  };
  const present = (id: string) => meets(valueIn("Business", id), () => true);
  const positive = (id: string) => meets(valueIn("Growth", id), (value) => value > 0);
  const revenueDelta = valueIn("Growth", "revenueDeltaPercent");
  const supportability = valuationSupportability(ctx);
  const { classification } = phaseInputs(ctx);
  return {
    Business: criteriaPosture(
      [present("revenue"), present("grossProfit"), present("operatingIncome")],
      2,
    ),
    Phase:
      revenueDelta === undefined && !hasCapitalReturn(classification)
        ? "insufficient-data"
        : "criteria-supported",
    Moat: criteriaPosture([
      meets(valueIn("Moat", "grossMargin"), (value) => value >= 0.4),
      meets(valueIn("Moat", "operatingMargin"), (value) => value > 0),
    ]),
    Growth: criteriaPosture(
      [
        positive("revenueDeltaPercent"),
        positive("operatingIncomeDeltaPercent"),
        positive("netIncomeDeltaPercent"),
        meets(valueOf(yearOverYear(ctx, "operatingCashFlow")), (value) => value > 0),
      ],
      2,
    ),
    Management: "insufficient-data",
    Risk: criteriaPosture([
      meets(valueIn("Risk", "currentRatio"), (value) => value >= 1),
      meets(valueIn("Risk", "debtToMarketCap"), (value) => value <= 0.5),
      meets(revenueDelta, (value) => value >= 0),
    ]),
    Valuation: criteriaPosture([
      supportability === undefined || supportability === "not-meaningful"
        ? undefined
        : supportability === "supported",
    ]),
  };
}

export function businessFrameworkMetricSectionId(name: BusinessFrameworkSectionName): string {
  return `business-framework-${name.toLowerCase()}`;
}

// Framework metrics as one Metric Section per framework section; postures read their values.
export function businessFrameworkMetrics(
  ctx: MetricContext,
  lensMetrics: readonly MetricResult[] = [],
): {
  readonly sections: Readonly<Partial<Record<BusinessFrameworkSectionName, MetricSection>>>;
  readonly postures: Readonly<Record<BusinessFrameworkSectionName, BusinessFrameworkPosture>>;
  readonly phase: BusinessLifecyclePhase;
  readonly sourceGaps: readonly SourceGap[];
} {
  const evaluated = Object.entries(sectionDefinitions(ctx, lensMetrics)).map(
    ([name, definitions]) =>
      [
        name,
        evaluateMetricSection(
          businessFrameworkMetricSectionId(name as BusinessFrameworkSectionName),
          `Business Framework: ${name}`,
          definitions,
          ctx,
        ),
      ] as const,
  );
  const sections = Object.fromEntries(
    evaluated.map(([name, result]) => [name, result.section]),
  ) as Partial<Record<BusinessFrameworkSectionName, MetricSection>>;
  return {
    sections,
    postures: postures(ctx, sections),
    phase: classifyBusinessLifecyclePhase(phaseInputs(ctx).classification),
    sourceGaps: evaluated.flatMap(([, result]) => result.sourceGaps),
  };
}

function currentRatioIsCurrent(
  secItem: ExtendedEvidenceItem | undefined,
  analysisAsOf: string,
): boolean {
  return (["currentAssets", "currentLiabilities"] as const).every((input) =>
    isCurrentBalanceSheetPeriod(
      secItem?.metrics,
      secItemPeriod(secItem, input).periodEnd,
      analysisAsOf,
    ),
  );
}
