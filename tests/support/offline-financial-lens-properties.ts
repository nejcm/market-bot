import { isRecord } from "../../src/guards";
import {
  financialStatementFacts,
  financialStatementFactsAreCompatible,
  financialStatementPeriodMonths,
  financialStatementPeriodsYearAligned,
  financialStatementSeriesByKey,
  latestCommonFinancialStatementFacts,
  latestCommonFinancialStatementPeriodEndFacts,
  latestFinancialStatementFact,
} from "../../src/sources/extended-evidence/financial-statement-selection";
import type {
  FinancialStatementFact,
  FinancialStatementSeriesKey,
} from "../../src/sources/extended-evidence/financial-statements-contract";
import type {
  OfflineCorpusAllowance,
  OfflineCorpusDifference,
  OfflineCorpusExecution,
  OfflineFinancialStatementInput,
} from "./offline-financial-statements-corpus";

function sourceContainsFact(input: OfflineFinancialStatementInput, fact: FinancialStatementFact) {
  if (!isRecord(input.companyFacts) || !isRecord(input.companyFacts.facts)) {
    return false;
  }
  const taxonomy = input.companyFacts.facts[fact.taxonomy];
  if (!isRecord(taxonomy)) {
    return false;
  }
  const concept = taxonomy[fact.concept];
  if (!isRecord(concept)) {
    return false;
  }
  const { units } = concept;
  const values = isRecord(units) ? units[fact.unit] : undefined;
  return (
    Array.isArray(values) &&
    values.some(
      (value) =>
        isRecord(value) &&
        value.val === fact.value &&
        value.form === fact.form &&
        value.filed === fact.filedAt &&
        value.start === fact.periodStart &&
        value.end === fact.periodEnd &&
        (value.accn ?? null) === fact.accessionNumber,
    )
  );
}

const EXACT_PERIOD_METRICS: Readonly<
  Record<
    string,
    readonly [FinancialStatementSeriesKey, FinancialStatementSeriesKey, "ratio" | "difference"]
  >
> = {
  grossMargin: ["grossProfit", "revenue", "ratio"],
  operatingMargin: ["operatingIncome", "revenue", "ratio"],
  netMargin: ["netIncome", "revenue", "ratio"],
  cashConversion: ["operatingCashFlow", "netIncome", "ratio"],
  freeCashFlowProxy: ["operatingCashFlow", "capitalExpenditure", "difference"],
  currentRatio: ["currentAssets", "currentLiabilities", "ratio"],
};

const EXACT_PERIOD_DELTAS: Readonly<Record<string, FinancialStatementSeriesKey>> = {
  revenueDeltaPercent: "revenue",
  grossProfitDeltaPercent: "grossProfit",
  operatingIncomeDeltaPercent: "operatingIncome",
  netIncomeDeltaPercent: "netIncome",
  dilutedEpsDeltaPercent: "dilutedEps",
  operatingCashFlowDeltaPercent: "operatingCashFlow",
};

const END_ALIGNED_BALANCE_RATIOS: Readonly<
  Record<string, readonly [FinancialStatementSeriesKey, FinancialStatementSeriesKey]>
> = {
  roa: ["netIncome", "totalAssets"],
  roe: ["netIncome", "stockholdersEquity"],
};

export function verifyExactPeriodMetric(
  execution: OfflineCorpusExecution,
  allowance: OfflineCorpusAllowance,
  difference: OfflineCorpusDifference,
): boolean {
  const metricKey = allowance.path.split(".").at(-1);
  const definition = metricKey === undefined ? undefined : EXACT_PERIOD_METRICS[metricKey];
  if (metricKey === undefined || !isRecord(difference.canonical)) {
    return false;
  }
  const { value, periodEnd, periodMonths } = difference.canonical;
  if (typeof value !== "number" || typeof periodEnd !== "string") {
    return false;
  }
  const deltaSeriesKey = EXACT_PERIOD_DELTAS[metricKey];
  if (deltaSeriesKey !== undefined) {
    const series = financialStatementSeriesByKey(execution.artifact, deltaSeriesKey);
    const latest =
      series === undefined
        ? undefined
        : latestFinancialStatementFact(financialStatementFacts(series));
    if (latest === undefined) {
      return false;
    }
    const months = financialStatementPeriodMonths(latest);
    const prior = latestFinancialStatementFact(
      financialStatementFacts(series!).filter(
        (fact) =>
          fact.periodEnd < latest.periodEnd &&
          financialStatementPeriodMonths(fact) === months &&
          financialStatementPeriodsYearAligned(fact, latest) &&
          financialStatementFactsAreCompatible([fact, latest]),
      ),
    );
    if (prior === undefined || prior.value === 0) {
      return false;
    }
    const expected = ((latest.value - prior.value) / Math.abs(prior.value)) * 100;
    return (
      Math.abs(value - expected) <= Math.max(1, Math.abs(value), Math.abs(expected)) * 1e-12 &&
      periodEnd === latest.periodEnd &&
      (periodMonths === undefined || periodMonths === months) &&
      sourceContainsFact(execution.input, latest) &&
      sourceContainsFact(execution.input, prior)
    );
  }
  const balanceRatio = END_ALIGNED_BALANCE_RATIOS[metricKey];
  if (balanceRatio !== undefined) {
    const [flowKey, instantKey] = balanceRatio;
    const facts = latestCommonFinancialStatementPeriodEndFacts([
      financialStatementSeriesByKey(execution.artifact, flowKey),
      financialStatementSeriesByKey(execution.artifact, instantKey),
    ]);
    const flow = facts?.[0];
    const instant = facts?.[1];
    const months = flow === undefined ? undefined : financialStatementPeriodMonths(flow);
    const expected =
      flow === undefined ||
      instant === undefined ||
      instant.value === 0 ||
      months === undefined ||
      flow.periodEnd !== instant.periodEnd
        ? undefined
        : (flow.value * (12 / months)) / instant.value;
    return (
      expected !== undefined &&
      Math.abs(value - expected) <= Math.max(1, Math.abs(value), Math.abs(expected)) * 1e-12 &&
      periodEnd === flow!.periodEnd &&
      (periodMonths === undefined || periodMonths === months) &&
      sourceContainsFact(execution.input, flow!) &&
      sourceContainsFact(execution.input, instant!)
    );
  }
  if (definition === undefined) {
    return false;
  }
  const [leftKey, rightKey, operation] = definition;
  const facts = latestCommonFinancialStatementFacts([
    financialStatementSeriesByKey(execution.artifact, leftKey),
    financialStatementSeriesByKey(execution.artifact, rightKey),
  ]);
  if (facts === undefined || facts[0] === undefined || facts[1] === undefined) {
    return false;
  }
  if (operation === "ratio" && facts[1].value === 0) {
    return false;
  }
  const expectedValue =
    operation === "ratio" ? facts[0].value / facts[1].value : facts[0].value - facts[1].value;
  return (
    Math.abs(value - expectedValue) <=
      Math.max(1, Math.abs(value), Math.abs(expectedValue)) * 1e-12 &&
    periodEnd === facts[0].periodEnd &&
    (periodMonths === undefined || periodMonths === financialStatementPeriodMonths(facts[0])) &&
    facts.every((fact) => sourceContainsFact(execution.input, fact))
  );
}
