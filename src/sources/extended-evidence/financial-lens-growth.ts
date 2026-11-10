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
  evidenceInput,
  summaryPeriod,
  chosenInput,
} from "./financial-lens-inputs";

const YOY_CHANGE = { over: "YoY" };
const YOY_BASIS =
  "latest reported period vs the same-length period one year earlier, same concept and unit";

export function yoyLabel(ctx: MetricContext, key: LensSeries): string {
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
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const item = secItem(ctx);
        const value = readNumberMetric(item?.metrics, `${metricKey}DeltaPercent`);
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
        return value === undefined
          ? { status: "missing", reason: `no SEC ${SERIES_LABELS[key]} YoY` }
          : {
              status: "value",
              value,
              inputs: [
                evidenceInput(
                  item,
                  `${metricKey}DeltaPercent`,
                  label,
                  "whole-percent",
                  value,
                  period,
                ),
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
      if (outflow && (prior.value < 0 || anchor.value < 0)) {
        return { ...negativeOutflow, ...periodOf(anchor), inputs };
      }
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
