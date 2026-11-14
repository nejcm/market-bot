import {
  CAPEX_SCOPE_CAVEAT,
  conceptScope,
  isContinuingScope,
  NEGATIVE_CAPEX_REASON,
  netMarginNumerator,
  scopedLabel,
  TOTAL_OPERATIONS_SCOPE,
} from "./financial-statement-definitions";
import {
  financialStatementFactsAreCompatible,
  latestFinancialStatementFact,
} from "./financial-statement-selection";
import type { FinancialStatementFact } from "./financial-statements-contract";
import {
  type MetricContext,
  type MetricDefinition,
  type MetricInput,
  type MetricOutcome,
} from "./metric-engine";
import { readNumberMetric, readStringMetric } from "./utils";
import {
  type LensSeries,
  SERIES_LABELS,
  eligibleFacts,
  latestFact,
  samePeriodFact,
  factInput,
  periodOf,
  noFact,
  missingPartner,
  annualize,
  annualizeSummary,
  secItem,
  evidenceOutcome,
  summaryPeriod,
  summaryPeriodsMatch,
  chosenInput,
  summaryValue,
  revenueShareCheck,
  type MetricPeriod,
} from "./financial-lens-inputs";

const LATEST_PERIOD_BASIS = "latest reported period: a year-aligned annual or an interim filing";

type NetMarginIncome =
  | { readonly key: LensSeries; readonly fact?: FinancialStatementFact }
  | { readonly reason: string; readonly periodEnd?: string };

const UNTAGGED_CONTINUING_REASON =
  "discontinued operations are reported and no continuing-operations income is tagged";
const UNTAGGED_CONSOLIDATED_REASON =
  "noncontrolling interest income is reported and no income including NCI is tagged";
const CONTINUING_INCOME_KEYS = new Set<LensSeries>([
  "continuingIncome",
  "consolidatedContinuingIncome",
]);

function legacyNetMarginIncome(ctx: MetricContext): NetMarginIncome {
  const metrics = secItem(ctx)?.metrics;
  const end = readStringMetric(metrics, "netIncomePeriodEnd");
  const at = (key: LensSeries) =>
    readNumberMetric(metrics, key) !== undefined &&
    readStringMetric(metrics, `${key}PeriodEnd`) === end
      ? key
      : undefined;
  const consolidated = at("consolidatedNetIncome");
  const discontinued =
    end !== undefined && readStringMetric(metrics, "netIncomeDiscontinuedPeriodEnd") === end;
  const key = netMarginNumerator<LensSeries>({
    consolidatedContinuing: at("consolidatedContinuingIncome"),
    continuing: at("continuingIncome"),
    consolidated,
    total: "netIncome",
    discontinued,
    noncontrolling:
      (end !== undefined &&
        readStringMetric(metrics, "netIncomeNoncontrollingPeriodEnd") === end) ||
      (consolidated !== undefined &&
        readNumberMetric(metrics, consolidated) !== readNumberMetric(metrics, "netIncome")),
  });
  return key !== undefined
    ? { key }
    : {
        reason: `${discontinued ? UNTAGGED_CONTINUING_REASON : UNTAGGED_CONSOLIDATED_REASON} for the period ending ${end}`,
        ...(end === undefined ? {} : { periodEnd: end }),
      };
}

function netMarginIncome(ctx: MetricContext, anchor: FinancialStatementFact): NetMarginIncome {
  const flagged = (key: LensSeries) =>
    ctx.statements?.omissionNotes.some(
      (note) => note.seriesKey === key && note.periodKey === anchor.periodKey,
    ) === true;
  const tagged = (key: LensSeries) => {
    const fact = samePeriodFact(ctx, anchor, key);
    return fact === undefined ? undefined : { key, fact };
  };
  const discontinued = flagged("continuingIncome");
  const picked = netMarginNumerator({
    consolidatedContinuing: tagged("consolidatedContinuingIncome"),
    continuing: tagged("continuingIncome"),
    consolidated: tagged("consolidatedNetIncome"),
    total: { key: "netIncome" as LensSeries, fact: anchor },
    discontinued,
    noncontrolling: flagged("consolidatedNetIncome") || flagged("consolidatedContinuingIncome"),
  });
  return (
    picked ?? {
      reason: `${discontinued ? UNTAGGED_CONTINUING_REASON : UNTAGGED_CONSOLIDATED_REASON} for the period ending ${anchor.periodEnd}`,
    }
  );
}

export function netMarginLabel(ctx: MetricContext): string {
  const anchor = ctx.statements === undefined ? undefined : latestFact(ctx, "netIncome");
  const income =
    ctx.statements === undefined
      ? legacyNetMarginIncome(ctx)
      : anchor && netMarginIncome(ctx, anchor);
  return income !== undefined && "key" in income && CONTINUING_INCOME_KEYS.has(income.key)
    ? "Net margin (continuing operations)"
    : "Net margin";
}

function operatingCashFlowScope(ctx: MetricContext): string | undefined {
  return ctx.statements === undefined
    ? readStringMetric(secItem(ctx)?.metrics, "operatingCashFlowScope")
    : conceptScope(latestFact(ctx, "operatingCashFlow")?.concept);
}

export function marginDefinition(
  id: string,
  numerator: LensSeries,
  denominator: LensSeries,
  label: string,
  consolidatedIncome = false,
): MetricDefinition {
  return {
    id,
    label,
    unit: "ratio-percent",
    basis: consolidatedIncome
      ? `consolidated income including NCI / ${SERIES_LABELS[denominator]} for the latest ${SERIES_LABELS[numerator]} period; continuing-operations income replaces total income when tagged, keeping revenue's continuing scope; parent-attributed income stands in only for a period with no noncontrolling interest income; a period with discontinued operations and no continuing income, or with NCI income and no income including NCI, is withheld`
      : `${SERIES_LABELS[numerator]} / ${SERIES_LABELS[denominator]} for the latest ${SERIES_LABELS[numerator]} period`,
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const income = consolidatedIncome ? legacyNetMarginIncome(ctx) : { key: numerator };
        if ("reason" in income) {
          return { status: "missing", ...income };
        }
        const numeratorKey = income.key;
        const numeratorValue = readNumberMetric(secItem(ctx)?.metrics, numeratorKey);
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
      const income = consolidatedIncome
        ? netMarginIncome(ctx, anchor)
        : { key: numerator, fact: anchor };
      if ("reason" in income) {
        return {
          status: "missing",
          reason: income.reason,
          ...periodOf(anchor),
          inputs: [factInput(anchor, numerator)],
        };
      }
      const numeratorFact = income.fact ?? anchor;
      const numeratorInput = factInput(numeratorFact, income.key);
      const partner = samePeriodFact(ctx, anchor, denominator);
      const denominatorLabel = SERIES_LABELS[denominator];
      if (partner === undefined) {
        return missingPartner(ctx, denominator, anchor, [numeratorInput]);
      }
      const inputs = [numeratorInput, factInput(partner, denominator)];
      if (!financialStatementFactsAreCompatible([numeratorFact, partner])) {
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
        value: numeratorFact.value / partner.value,
        ...periodOf(anchor),
        inputs,
      };
    },
  };
}

export function freeCashFlowDefinition(context: MetricContext): MetricDefinition {
  return {
    id: "freeCashFlowProxy",
    label: scopedLabel("FCF proxy", operatingCashFlowScope(context)),
    unit: "currency",
    basis: `operating cash flow less capital expenditure for the latest operating cash flow period; ${CAPEX_SCOPE_CAVEAT}`,
    cashFlowBased: true,
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const operatingCashFlow = readNumberMetric(secItem(ctx)?.metrics, "operatingCashFlow");
        const capex = readNumberMetric(secItem(ctx)?.metrics, "capex");
        if (!summaryPeriodsMatch(ctx, "operatingCashFlow", "capex")) {
          return { status: "missing", reason: "no same-period SEC FCF proxy" };
        }
        if (
          readStringMetric(secItem(ctx)?.metrics, "operatingCashFlowScope") ===
          TOTAL_OPERATIONS_SCOPE
        ) {
          return {
            status: "missing",
            reason:
              "operating cash flow includes discontinued operations and capital expenditure is not tagged on the same scope",
            ...summaryPeriod(ctx, "operatingCashFlow"),
          };
        }
        if (capex !== undefined && capex < 0) {
          const period = summaryPeriod(ctx, "operatingCashFlow");
          return {
            status: "not-meaningful",
            reason: NEGATIVE_CAPEX_REASON,
            ...period,
            inputs: [
              ...chosenInput(
                secItem(ctx),
                "operatingCashFlow",
                SERIES_LABELS.operatingCashFlow,
                period,
              ),
              ...chosenInput(secItem(ctx), "capex", SERIES_LABELS.capitalExpenditure, period),
            ],
          };
        }
        return summaryValue(
          ctx,
          "freeCashFlowProxy",
          operatingCashFlow === undefined || capex === undefined
            ? undefined
            : operatingCashFlow - capex,
          scopedLabel("FCF proxy", operatingCashFlowScope(context)),
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
      const inputs = [
        factInput(anchor, "operatingCashFlow"),
        factInput(capex, "capitalExpenditure"),
      ];
      if (capex.value < 0) {
        return {
          status: "not-meaningful",
          reason: NEGATIVE_CAPEX_REASON,
          ...periodOf(anchor),
          inputs,
        };
      }
      return {
        status: "value",
        value: anchor.value - capex.value,
        ...periodOf(anchor),
        ...(anchor.currency !== null ? { currency: anchor.currency } : {}),
        inputs,
      };
    },
  };
}

const CASH_CONVERSION_BASIS =
  "operating cash flow / income of the same operations scope for the same period";

export function cashConversionDefinition(): MetricDefinition {
  return {
    id: "cashConversion",
    label: "Cash conversion",
    unit: "ratio",
    basis: CASH_CONVERSION_BASIS,
    cashFlowBased: true,
    compute: (ctx) => {
      if (ctx.statements === undefined) {
        const item = secItem(ctx);
        const incomeKey: LensSeries = isContinuingScope(
          readStringMetric(item?.metrics, "operatingCashFlowScope"),
        )
          ? "continuingIncome"
          : "netIncome";
        const operatingCashFlow = readNumberMetric(item?.metrics, "operatingCashFlow");
        const income = readNumberMetric(item?.metrics, incomeKey);
        if (
          !summaryPeriodsMatch(ctx, "operatingCashFlow", incomeKey) ||
          operatingCashFlow === undefined ||
          income === undefined
        ) {
          return { status: "missing", reason: "no same-period SEC Cash conversion" };
        }
        const period = summaryPeriod(ctx, "operatingCashFlow");
        return cashConversionOutcome(
          incomeKey,
          operatingCashFlow,
          income,
          summaryPeriodsMatch(ctx, "operatingCashFlow", "revenue")
            ? readNumberMetric(item?.metrics, "revenue")
            : undefined,
          period,
          [
            ...chosenInput(item, "operatingCashFlow", SERIES_LABELS.operatingCashFlow, period),
            ...chosenInput(item, incomeKey, SERIES_LABELS[incomeKey], period),
          ],
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
      return cashConversionOutcome(
        incomeKey,
        anchor.value,
        income.value,
        samePeriodFact(ctx, anchor, "revenue")?.value,
        periodOf(anchor),
        [factInput(anchor, "operatingCashFlow"), factInput(income, incomeKey)],
      );
    },
  };
}

function cashConversionOutcome(
  incomeKey: LensSeries,
  operatingCashFlow: number,
  income: number,
  revenue: number | undefined,
  period: MetricPeriod,
  inputs: readonly MetricInput[],
): MetricOutcome {
  const { reason, note } =
    income <= 0
      ? { reason: `${SERIES_LABELS[incomeKey]} is not positive`, note: undefined }
      : revenueShareCheck(SERIES_LABELS[incomeKey], income, revenue);
  return reason === undefined
    ? {
        status: "value",
        value: operatingCashFlow / income,
        ...period,
        inputs,
        ...(note === undefined ? {} : { basis: `${CASH_CONVERSION_BASIS}; ${note}` }),
      }
    : { status: "not-meaningful", reason, ...period, inputs };
}

export function returnOnLabel(
  ctx: MetricContext,
  id: "roe" | "roa",
  denominator: LensSeries,
): string {
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

export function returnOnDefinition(
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
        return summaryValue(
          ctx,
          id,
          netIncome === undefined || base === undefined || base === 0
            ? undefined
            : annualizeSummary(ctx, "netIncome", netIncome) / base,
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
            value: annualize(anchor.value, anchor) / instant.value,
            ...periodOf(anchor),
            inputs,
          };
    },
  };
}

export function consolidatedIncomeDefinitions(ctx: MetricContext): readonly MetricDefinition[] {
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
