import {
  conceptScope,
  scopedLabel,
  TOTAL_OPERATIONS_SCOPE,
} from "./financial-statement-definitions";
import { priorComparable } from "./financial-lens-canonical";
import {
  earlierShareBasisPeriods,
  financialStatementSeriesByKey,
} from "./financial-statement-selection";
import type { FinancialStatementFact } from "./financial-statements-contract";
import { type MetricContext, type MetricDefinition } from "./metric-engine";
import { readNumberMetric, readStringMetric } from "./utils";
import {
  type LensSeries,
  SERIES_LABELS,
  isYearAlignedFact,
  latestFact,
  factInput,
  periodOf,
  noFact,
  secItem,
  summaryPeriod,
  chosenInput,
  YOY_BASIS,
  statementYearOverYear,
  summaryYearOverYear,
} from "./financial-lens-inputs";

const YOY_CHANGE = { over: "YoY" };

export function yoyLabel(ctx: MetricContext, key: LensSeries): string {
  if (ctx.statements === undefined) {
    return scopedLabel(yoyBaseLabel(key), readStringMetric(secItem(ctx)?.metrics, `${key}Scope`));
  }
  const anchor = latestFact(ctx, key);
  switch (key) {
    case "netIncome":
    case "dilutedEps": {
      return scopedLabel(
        yoyBaseLabel(key),
        anchor === undefined
          ? undefined
          : scopeOfTotal(
              ctx,
              anchor,
              key === "netIncome" ? "continuingIncome" : "continuingDilutedEps",
            ),
      );
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
    case "netIncome": {
      return "Net income (attrib.) YoY";
    }
    case "continuingIncome": {
      return "Income YoY";
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

export function yearOverYearDefinition(
  key: LensSeries,
  label: string,
  metricKey: string = key,
  outflow = false,
): MetricDefinition {
  const negativeOutflow = {
    status: "not-meaningful",
    reason: `${SERIES_LABELS[key]} filed as a negative amount; outflow sign is ambiguous`,
  } as const;
  return {
    id: `${metricKey}DeltaPercent`,
    label,
    unit: "whole-percent",
    basis: YOY_BASIS,
    change: YOY_CHANGE,
    ...(key === "operatingCashFlow" || key === "capitalExpenditure"
      ? { cashFlowBased: true as const }
      : {}),
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const item = secItem(ctx);
        const period = summaryPeriod(ctx, metricKey);
        if (
          outflow &&
          [metricKey, `${metricKey}Prior`].some(
            (input) => (readNumberMetric(item?.metrics, input) ?? 0) < 0,
          )
        ) {
          return {
            ...negativeOutflow,
            ...period,
            inputs: chosenInput(item, metricKey, SERIES_LABELS[key], period),
          };
        }
        return (
          summaryYearOverYear(ctx, metricKey, SERIES_LABELS[key]) ?? {
            status: "missing",
            reason: `no SEC ${SERIES_LABELS[key]} YoY`,
          }
        );
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
      if (outflow && (prior.value < 0 || anchor.value < 0)) {
        const inputs = [factInput(prior, key), factInput(anchor, key)];
        return { ...negativeOutflow, ...periodOf(anchor), inputs };
      }
      return statementYearOverYear(ctx, key, SERIES_LABELS[key], prior, anchor);
    },
  };
}
