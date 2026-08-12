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

type LensName = "Quality" | "Growth" | "Financial Strength";
type LensMetricKey =
  | "cash"
  | "cashConversion"
  | "currentRatio"
  | "debt"
  | "debtToEquity"
  | "dilutedEpsDeltaPercent"
  | "freeCashFlowProxy"
  | "grossMargin"
  | "grossProfitDeltaPercent"
  | "netDebt"
  | "netIncomeDeltaPercent"
  | "netMargin"
  | "operatingCashFlowDeltaPercent"
  | "operatingIncomeDeltaPercent"
  | "operatingMargin"
  | "revenueDeltaPercent"
  | "roa"
  | "roe";
type LensMetricRelation = "direct-leaf" | "exact-period" | "instant-pair";
type LensPosture =
  | "criteria-supported"
  | "criteria-mixed"
  | "criteria-not-supported"
  | "insufficient-data";
type ProjectedConsumers = OfflineCorpusExecution["projection"]["canonical"];
type ProjectedLensMetrics = ProjectedConsumers["financialLens"][string]["metrics"];

// Series selection (concept, unit, form, accession dedupe and period) reuses production's derived artifact; sourceContainsFact proves the fact exists in raw companyFacts, not that it is the correct fact.
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

const INSTANT_PAIR_METRICS: Readonly<
  Partial<
    Record<
      LensMetricKey,
      readonly [FinancialStatementSeriesKey, FinancialStatementSeriesKey, "ratio" | "difference"]
    >
  >
> = {
  netDebt: ["debt", "cash", "difference"],
  debtToEquity: ["debt", "stockholdersEquity", "ratio"],
};

const DIRECT_LEAF_METRICS: Readonly<Partial<Record<LensMetricKey, FinancialStatementSeriesKey>>> = {
  cash: "cash",
  debt: "debt",
};

const LENS_METRIC_RELATIONS: Readonly<Record<LensMetricKey, LensMetricRelation>> = {
  cash: "direct-leaf",
  cashConversion: "exact-period",
  currentRatio: "exact-period",
  debt: "direct-leaf",
  debtToEquity: "instant-pair",
  dilutedEpsDeltaPercent: "exact-period",
  freeCashFlowProxy: "exact-period",
  grossMargin: "exact-period",
  grossProfitDeltaPercent: "exact-period",
  netDebt: "instant-pair",
  netIncomeDeltaPercent: "exact-period",
  netMargin: "exact-period",
  operatingCashFlowDeltaPercent: "exact-period",
  operatingIncomeDeltaPercent: "exact-period",
  operatingMargin: "exact-period",
  revenueDeltaPercent: "exact-period",
  roa: "exact-period",
  roe: "exact-period",
};

function verifyExactPeriodMetric(
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

function verifyInstantPairMetric(
  execution: OfflineCorpusExecution,
  metricKey: LensMetricKey,
  difference: OfflineCorpusDifference,
): boolean {
  const definition = INSTANT_PAIR_METRICS[metricKey];
  if (definition === undefined || !isRecord(difference.canonical)) {
    return false;
  }
  const { value, periodEnd } = difference.canonical;
  if (typeof value !== "number" || typeof periodEnd !== "string") {
    return false;
  }
  const [leftKey, rightKey, operation] = definition;
  const facts = latestCommonFinancialStatementPeriodEndFacts([
    financialStatementSeriesByKey(execution.artifact, leftKey),
    financialStatementSeriesByKey(execution.artifact, rightKey),
  ]);
  const left = facts?.[0];
  const right = facts?.[1];
  if (
    left === undefined ||
    right === undefined ||
    left.periodEnd !== right.periodEnd ||
    (operation === "ratio" && right.value === 0)
  ) {
    return false;
  }
  const expected = operation === "ratio" ? left.value / right.value : left.value - right.value;
  return (
    Math.abs(value - expected) <= Math.max(1, Math.abs(value), Math.abs(expected)) * 1e-12 &&
    periodEnd === left.periodEnd &&
    periodEnd === right.periodEnd &&
    sourceContainsFact(execution.input, left) &&
    sourceContainsFact(execution.input, right)
  );
}

function verifyDirectLeafMetric(
  execution: OfflineCorpusExecution,
  metricKey: LensMetricKey,
  difference: OfflineCorpusDifference,
): boolean {
  const seriesKey = DIRECT_LEAF_METRICS[metricKey];
  if (seriesKey === undefined || !isRecord(difference.canonical)) {
    return false;
  }
  const { value, periodEnd } = difference.canonical;
  const series = financialStatementSeriesByKey(execution.artifact, seriesKey);
  const fact =
    series === undefined
      ? undefined
      : latestFinancialStatementFact(financialStatementFacts(series));
  return (
    typeof value === "number" &&
    typeof periodEnd === "string" &&
    fact !== undefined &&
    value === fact.value &&
    periodEnd === fact.periodEnd &&
    sourceContainsFact(execution.input, fact)
  );
}

function postureFrom(values: readonly (boolean | undefined)[], requiredCount = 1): LensPosture {
  const known = values.filter((value): value is boolean => value !== undefined);
  if (known.length < requiredCount || known.length === 0) {
    return "insufficient-data";
  }
  const supported = known.filter(Boolean).length;
  if (supported === known.length) {
    return "criteria-supported";
  }
  if (supported === 0) {
    return "criteria-not-supported";
  }
  return "criteria-mixed";
}

function metricValue(metrics: ProjectedLensMetrics, key: string): number | undefined {
  const value = metrics[key]?.value;
  return typeof value === "number" ? value : undefined;
}

function verifyLensPosture(
  projection: ProjectedConsumers,
  lensName: LensName,
  posture: string,
  canonicalInputCategories: readonly string[],
): boolean {
  const metrics = projection.financialLens[lensName]?.metrics;
  if (metrics === undefined) {
    return false;
  }
  if (lensName === "Quality") {
    return (
      posture ===
      postureFrom(
        ["grossMargin", "operatingMargin", "netMargin", "freeCashFlowProxy"].map((key) => {
          const value = metricValue(metrics, key);
          return value === undefined ? undefined : value > 0;
        }),
      )
    );
  }
  if (lensName === "Growth") {
    return (
      posture ===
      postureFrom(
        [
          "revenueDeltaPercent",
          "grossProfitDeltaPercent",
          "operatingIncomeDeltaPercent",
          "netIncomeDeltaPercent",
          "dilutedEpsDeltaPercent",
          "operatingCashFlowDeltaPercent",
        ].map((key) => {
          const value = metricValue(metrics, key);
          return value === undefined ? undefined : value > 0;
        }),
        2,
      )
    );
  }
  if (canonicalInputCategories.includes("valuation")) {
    throw new Error(
      "Offline financial-lens posture assertion: Financial Strength unexpectedly received valuation input",
    );
  }
  const forbidden = ["netDebtToMarketCap", "debtToMarketCap", "payoutRatio"].filter((key) =>
    Object.hasOwn(metrics, key),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Offline financial-lens posture assertion: Financial Strength projected metrics unexpectedly contain ${forbidden.join(", ")}`,
    );
  }
  const netDebt = metricValue(metrics, "netDebt");
  const currentRatio = metricValue(metrics, "currentRatio");
  return (
    posture ===
    postureFrom([
      netDebt === undefined ? undefined : netDebt <= 0,
      currentRatio === undefined ? undefined : currentRatio >= 1,
    ])
  );
}

function isLensName(value: string | undefined): value is LensName {
  return value === "Quality" || value === "Growth" || value === "Financial Strength";
}

function isLensMetricKey(value: string | undefined): value is LensMetricKey {
  return value !== undefined && Object.hasOwn(LENS_METRIC_RELATIONS, value);
}

function unreachableLensMetricRelation(relation: never): never {
  throw new Error(`Unknown financial-lens metric relation: ${String(relation)}`);
}

export function verifyLensAllowanceProperties(
  execution: OfflineCorpusExecution,
  allowance: OfflineCorpusAllowance,
  difference: OfflineCorpusDifference,
): boolean {
  if (difference.path !== allowance.path) {
    return false;
  }
  const [root, lensName, member, metricKey, ...rest] = allowance.path.split(".");
  if (root !== "financialLens" || !isLensName(lensName) || rest.length > 0) {
    return false;
  }
  if (member === "posture" && metricKey === undefined) {
    return typeof difference.canonical === "string"
      ? verifyLensPosture(
          execution.projection.canonical,
          lensName,
          difference.canonical,
          execution.canonicalFinancialLensInputCategories,
        )
      : false;
  }
  if (member !== "metrics" || !isLensMetricKey(metricKey)) {
    return false;
  }
  const relation = LENS_METRIC_RELATIONS[metricKey];
  switch (relation) {
    case "direct-leaf": {
      return verifyDirectLeafMetric(execution, metricKey, difference);
    }
    case "instant-pair": {
      return verifyInstantPairMetric(execution, metricKey, difference);
    }
    case "exact-period": {
      return verifyExactPeriodMetric(execution, allowance, difference);
    }
    default: {
      return unreachableLensMetricRelation(relation);
    }
  }
}
