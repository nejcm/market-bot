import { sourceGap } from "../../domain/source-gaps";
import {
  enterpriseValueBridgeMetrics,
  resolveEnterpriseValueBridge,
} from "./enterprise-value-bridge";
import type { ExtendedEvidence, ExtendedEvidenceItem } from "../../domain/evidence";
import type { SourceGap } from "../../domain/sources";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementSeriesKey,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";
import {
  conceptScope,
  isContinuingScope,
  TOTAL_OPERATIONS_SCOPE,
} from "./financial-statement-definitions";
import type { SecSicClassification } from "./sec-edgar";
import {
  DEBT_MAY_INCLUDE_FINANCE_LEASES,
  formatSecFundamentalsSummary,
  type SecMetricDefinitionKey,
} from "./sec-fundamentals-format";
import {
  financialStatementFacts,
  financialStatementPeriodMonths,
  financialStatementPeriodsYearAligned,
  financialStatementSeriesByKey,
  isYearAligned,
  latestCommonFinancialStatementFacts,
  latestFinancialStatementFact,
  earlierShareBasisPeriods,
  touchesEarlierShareBasis,
} from "./financial-statement-selection";
import { withheldDebt } from "./sec-debt";
import { unadjustedLeaseInclusiveDebt } from "./sec-debt-resolution";

const CANONICAL_FINANCIAL_LENS_SELECTION_VERSION = 1;
const CANONICAL_FINANCIAL_LENS_SELECTION_VERSION_KEY = "financialLensSelectionVersion";

function hasCanonicalFinancialLensSelection(item: ExtendedEvidenceItem | undefined): boolean {
  return (
    item?.metrics?.[CANONICAL_FINANCIAL_LENS_SELECTION_VERSION_KEY] ===
    CANONICAL_FINANCIAL_LENS_SELECTION_VERSION
  );
}

const FLOW_SERIES = [
  ["revenue", "revenue"],
  ["grossProfit", "grossProfit"],
  ["operatingIncome", "operatingIncome"],
  ["netIncome", "netIncome"],
  ["dilutedEps", "dilutedEps"],
  ["operatingCashFlow", "operatingCashFlow"],
  ["capex", "capitalExpenditure"],
  ["dividendsPaid", "dividendsPaid"],
  ["continuingIncome", "continuingIncome"],
  ["continuingDilutedEps", "continuingDilutedEps"],
] as const satisfies readonly (readonly [string, FinancialStatementSeriesKey])[];

const TOTAL_COUNTERPARTS = {
  continuingIncome: "netIncome",
  continuingDilutedEps: "dilutedEps",
} as const;

const INSTANT_SERIES = [
  ["cash", "cash"],
  ["debt", "debt"],
  ["currentAssets", "currentAssets"],
  ["currentLiabilities", "currentLiabilities"],
  ["stockholdersEquity", "stockholdersEquity"],
  ["assets", "totalAssets"],
] as const satisfies readonly (readonly [string, FinancialStatementSeriesKey])[];

type CanonicalFactMetricKey =
  | (typeof FLOW_SERIES)[number][0]
  | (typeof INSTANT_SERIES)[number][0]
  | "consolidatedNetIncome";

export type SecFactMetricKey = CanonicalFactMetricKey | SecMetricDefinitionKey;

export type SecMetricKey =
  | SecFactMetricKey
  | `${SecFactMetricKey}PeriodEnd`
  | `${SecFactMetricKey}PeriodMonths`
  | `${SecFactMetricKey}Prior`
  | `${SecFactMetricKey}DeltaPercent`
  | `${SecFactMetricKey}Scope`
  | "revenuePeriodEnd"
  | "financialLensSelectionVersion"
  | "sic"
  | "sicDescription"
  | "stateOfIncorporation";

export function priorComparable(
  series: FinancialStatementSeries,
  selected: FinancialStatementFact,
  earlierShareBasis: ReadonlySet<string>,
): FinancialStatementFact | undefined {
  const months = financialStatementPeriodMonths(selected);
  return latestFinancialStatementFact(
    financialStatementFacts(series).filter(
      (fact) =>
        fact.periodEnd < selected.periodEnd &&
        !touchesEarlierShareBasis([fact, selected], earlierShareBasis) &&
        (fact.concept === selected.concept ||
          (series.key === "debt" && fact.lineScope === true && selected.lineScope === true)) &&
        financialStatementPeriodMonths(fact) === months &&
        (series.statement === "balanceSheet"
          ? fact.periodStart === undefined &&
            selected.periodStart === undefined &&
            isYearAligned(fact.periodEnd, selected.periodEnd)
          : financialStatementPeriodsYearAligned(fact, selected)) &&
        fact.currency === selected.currency &&
        fact.unit === selected.unit &&
        fact.unitScale === selected.unitScale,
    ),
  );
}

function addFactMetrics(
  metrics: Record<string, number | string>,
  key: CanonicalFactMetricKey,
  fact: FinancialStatementFact | undefined,
  series: FinancialStatementSeries,
  earlierShareBasis: ReadonlySet<string> = new Set(),
): void {
  if (fact === undefined) {
    return;
  }
  metrics[key] = fact.value;
  metrics[`${key}PeriodEnd`] = fact.periodEnd;
  const scope = conceptScope(fact.concept);
  if (scope !== undefined) {
    metrics[`${key}Scope`] = scope;
  }
  const months = financialStatementPeriodMonths(fact);
  if (months !== undefined) {
    metrics[`${key}PeriodMonths`] = months;
  }
  const prior = priorComparable(series, fact, earlierShareBasis);
  if (prior !== undefined) {
    metrics[`${key}Prior`] = prior.value;
    if (prior.value !== 0) {
      metrics[`${key}DeltaPercent`] = ((fact.value - prior.value) / Math.abs(prior.value)) * 100;
    }
  }
}

// Cash conversion divides by income of the operating cash flow's own operations scope.
function cashConversionIncomeKey(
  operatingCashFlow: FinancialStatementSeries,
): "continuingIncome" | "netIncome" {
  const latest = latestFinancialStatementFact(financialStatementFacts(operatingCashFlow));
  return isContinuingScope(conceptScope(latest?.concept)) ? "continuingIncome" : "netIncome";
}

export function cashConversionScopeGaps(
  artifact: FinancialStatementsArtifact,
): readonly SourceGap[] {
  const { operatingCashFlow } = artifact.statements.cashFlowStatement;
  const incomeKey = cashConversionIncomeKey(operatingCashFlow);
  const income =
    incomeKey === "continuingIncome"
      ? artifact.statements.incomeStatement.continuingIncome
      : artifact.statements.incomeStatement.netIncome;
  if (
    financialStatementFacts(operatingCashFlow).length === 0 ||
    latestCommonFinancialStatementFacts([operatingCashFlow, income]) !== undefined
  ) {
    return [];
  }
  return [
    sourceGap({
      source: "sec-edgar",
      message:
        incomeKey === "continuingIncome"
          ? "SEC cash conversion withheld: operating cash flow is reported for continuing operations, and no income from continuing operations shares its period, currency, and unit"
          : "SEC cash conversion withheld: no net income shares the operating cash flow period, currency, and unit",
      symbol: artifact.symbol,
      provider: "sec-edgar",
      capability: "extended-evidence",
      cause: "provider-data-missing",
      evidenceQualityImpact: "no-cap",
    }),
  ];
}

export function canonicalFinancialMetrics(
  artifact: FinancialStatementsArtifact,
): Record<string, number | string> {
  const metrics: Record<string, number | string> = {};
  [...FLOW_SERIES, ...INSTANT_SERIES].forEach(([metricKey, seriesKey]) => {
    const series = financialStatementSeriesByKey(artifact, seriesKey);
    if (series === undefined) {
      throw new Error(`Canonical financial statements are missing ${seriesKey}`);
    }
    const fact = latestFinancialStatementFact(financialStatementFacts(series));
    const totalPeriodEnd =
      metricKey in TOTAL_COUNTERPARTS
        ? metrics[`${TOTAL_COUNTERPARTS[metricKey as keyof typeof TOTAL_COUNTERPARTS]}PeriodEnd`]
        : undefined;
    // A continuing-operations series older than its total counterpart is history, not a scope split.
    if (
      typeof totalPeriodEnd !== "string" ||
      fact === undefined ||
      fact.periodEnd >= totalPeriodEnd
    ) {
      addFactMetrics(
        metrics,
        metricKey,
        fact,
        series,
        earlierShareBasisPeriods(artifact.omissionNotes, seriesKey),
      );
    }
  });
  for (const [continuingKey, totalKey] of Object.entries(TOTAL_COUNTERPARTS)) {
    if (metrics[continuingKey] !== undefined && metrics[`${totalKey}Scope`] === undefined) {
      metrics[`${totalKey}Scope`] = TOTAL_OPERATIONS_SCOPE;
    }
  }
  const income = artifact.statements.incomeStatement;
  const revenueTtm =
    metrics.revenuePeriodMonths === 12
      ? metrics.revenue
      : income.revenue.ttm?.periodEnd === metrics.revenuePeriodEnd
        ? income.revenue.ttm?.value
        : undefined;
  if (revenueTtm !== undefined) {
    metrics.revenueTtm = revenueTtm;
  }
  const [netIncomeFact, consolidatedNetIncomeFact] =
    latestCommonFinancialStatementFacts([income.netIncome, income.consolidatedNetIncome]) ?? [];
  // Consolidated income is read against net income, so only net income's own period qualifies.
  if (netIncomeFact === latestFinancialStatementFact(financialStatementFacts(income.netIncome))) {
    addFactMetrics(
      metrics,
      "consolidatedNetIncome",
      consolidatedNetIncomeFact,
      income.consolidatedNetIncome,
    );
  }
  if (typeof metrics.cash === "number" && typeof metrics.cashPeriodEnd === "string") {
    Object.assign(
      metrics,
      enterpriseValueBridgeMetrics(
        resolveEnterpriseValueBridge(artifact.enterpriseValueBridge, {
          value: metrics.cash,
          periodEnd: metrics.cashPeriodEnd,
        }),
      ),
    );
  }
  const withheld = withheldDebt(artifact);
  if (withheld !== undefined) {
    for (const key of Object.keys(metrics).filter((candidate) =>
      /^debt(?:[A-Z]|$)/u.test(candidate),
    )) {
      delete metrics[key];
    }
    metrics.debtIncompletePeriodEnd = withheld.periodEnd;
    metrics.debtIncompleteReason = withheld.reason;
  }
  const latestDebt = latestFinancialStatementFact(
    financialStatementFacts(artifact.statements.balanceSheet.debt),
  );
  if (
    withheld === undefined &&
    latestDebt !== undefined &&
    unadjustedLeaseInclusiveDebt(latestDebt.taxonomy, latestDebt.concept).length > 0
  ) {
    metrics.debtLeaseScope = DEBT_MAY_INCLUDE_FINANCE_LEASES;
  }
  if (Object.keys(metrics).length > 0) {
    metrics[CANONICAL_FINANCIAL_LENS_SELECTION_VERSION_KEY] =
      CANONICAL_FINANCIAL_LENS_SELECTION_VERSION;
  }
  return metrics;
}

function legacySecItem(evidence: ExtendedEvidence | undefined): ExtendedEvidenceItem | undefined {
  return evidence?.items.find(
    (item) => item.category === "sec-edgar" && item.metrics !== undefined,
  );
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

const CANONICAL_FACT_METRIC_KEYS = new Set<string>([
  ...[...FLOW_SERIES, ...INSTANT_SERIES].map(([metricKey]) => metricKey),
  "consolidatedNetIncome",
]);

function canonicalSummary(
  legacy: ExtendedEvidenceItem | undefined,
  metrics: Readonly<Record<string, number | string>>,
): string {
  // Without a legacy item there is no us-gaap label or USD basis to render prose against.
  if (legacy === undefined) {
    return "Canonical SEC financial statement inputs.";
  }
  if (hasCanonicalFinancialLensSelection(legacy)) {
    return legacy.summary;
  }
  // Canonical keys render only from canonical metrics; legacy fills keys canonical never produces.
  const fundamentals = formatSecFundamentalsSummary((key) =>
    CANONICAL_FACT_METRIC_KEYS.has(key) ? metrics : legacy.metrics,
  );
  const filings = legacy.summary.replace(/SEC Fundamental Evidence: .*$/su, "").trim();
  return [filings, fundamentals].filter((part) => part !== undefined && part !== "").join(" ");
}

export function withCanonicalFinancialLensInputs(
  evidence: ExtendedEvidence | undefined,
  artifact: FinancialStatementsArtifact,
  sicClassification?: SecSicClassification,
): ExtendedEvidence {
  const legacy = legacySecItem(evidence);
  const metrics = canonicalFinancialMetrics(artifact);
  if (legacy === undefined && Object.keys(metrics).length === 0) {
    return evidence ?? { items: [], gaps: [] };
  }
  const classificationMetrics = Object.fromEntries(
    Object.entries(legacy?.metrics ?? {}).filter(
      ([key]) => key === "sic" || key === "sicDescription" || key === "stateOfIncorporation",
    ),
  );
  const canonical: ExtendedEvidenceItem = {
    category: "sec-edgar",
    title: legacy?.title ?? `${artifact.symbol} canonical financial statements`,
    summary: canonicalSummary(legacy, metrics),
    sourceIds: unique([...(legacy?.sourceIds ?? []), artifact.sourceId]),
    observedAt: legacy?.observedAt ?? artifact.analysisAsOf,
    metrics: {
      ...classificationMetrics,
      ...(sicClassification !== undefined
        ? {
            sic: sicClassification.sic,
            ...(sicClassification.sicDescription !== undefined
              ? { sicDescription: sicClassification.sicDescription }
              : {}),
            ...(sicClassification.stateOfIncorporation !== undefined
              ? { stateOfIncorporation: sicClassification.stateOfIncorporation }
              : {}),
          }
        : {}),
      ...metrics,
    },
    ...(legacy?.identity !== undefined ? { identity: legacy.identity } : {}),
  };
  const items = evidence?.items ?? [];
  return {
    ...(evidence?.instrument !== undefined ? { instrument: evidence.instrument } : {}),
    ...(evidence?.subject !== undefined ? { subject: evidence.subject } : {}),
    items:
      legacy === undefined
        ? [...items.filter((item) => item.category !== "financial-lens"), canonical]
        : items.map((item) => (item === legacy ? canonical : item)),
    gaps: evidence?.gaps ?? [],
  };
}
