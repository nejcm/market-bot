import type { SourceGap } from "../../domain/sources";
import { sourceGap } from "../../domain/source-gaps";
import { DEBT_CONCEPTS, scopedLabel } from "./financial-statement-definitions";

export interface SecMetricDefinition {
  readonly key: string;
  readonly label: string;
  readonly concepts: readonly string[];
  readonly unitKeys: readonly string[];
  // Optional metrics are emitted when present but their absence is not a data
  // Gap (e.g. dividendsPaid is absent for non-dividend-paying issuers). Required
  // Metrics add to missingFacts/missingDeltas and cap evidence quality when absent.
  readonly optional?: boolean;
}

export const SEC_METRIC_DEFINITIONS = [
  {
    key: "revenue",
    label: "revenue",
    concepts: [
      "Revenues",
      "SalesRevenueNet",
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
    ],
    unitKeys: ["USD"],
  },
  {
    key: "grossProfit",
    label: "gross profit",
    concepts: ["GrossProfit"],
    unitKeys: ["USD"],
  },
  {
    key: "operatingIncome",
    label: "operating income",
    concepts: ["OperatingIncomeLoss"],
    unitKeys: ["USD"],
  },
  {
    key: "netIncome",
    label: "net income attributable to parent",
    concepts: ["NetIncomeLoss"],
    unitKeys: ["USD"],
  },
  {
    key: "consolidatedNetIncome",
    label: "net income consolidated including NCI",
    concepts: ["ProfitLoss"],
    unitKeys: ["USD"],
    optional: true,
  },
  {
    key: "dilutedEps",
    label: "diluted EPS",
    concepts: ["EarningsPerShareDiluted"],
    unitKeys: ["USD/shares"],
  },
  {
    key: "continuingIncome",
    label: "income",
    concepts: [
      "IncomeLossFromContinuingOperations",
      "IncomeLossFromContinuingOperationsIncludingPortionAttributableToNoncontrollingInterest",
    ],
    unitKeys: ["USD"],
    optional: true,
  },
  {
    key: "consolidatedContinuingIncome",
    label: "income including NCI",
    concepts: [
      "IncomeLossFromContinuingOperationsIncludingPortionAttributableToNoncontrollingInterest",
    ],
    unitKeys: ["USD"],
    optional: true,
  },
  {
    key: "continuingDilutedEps",
    label: "diluted EPS",
    concepts: ["IncomeLossFromContinuingOperationsPerDilutedShare"],
    unitKeys: ["USD/shares"],
    optional: true,
  },
  {
    key: "cash",
    label: "cash",
    concepts: [
      "CashAndCashEquivalentsAtCarryingValue",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
    unitKeys: ["USD"],
  },
  {
    key: "operatingCashFlow",
    label: "operating cash flow",
    // Continuing first: revenue is a continuing line once the issuer splits out discontinued operations.
    concepts: [
      "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
      "NetCashProvidedByUsedInOperatingActivities",
    ],
    unitKeys: ["USD"],
  },
  {
    key: "capex",
    label: "capex",
    concepts: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
    unitKeys: ["USD"],
  },
  {
    key: "dilutedShares",
    label: "diluted shares",
    concepts: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
    unitKeys: ["shares"],
  },
  {
    key: "currentAssets",
    label: "current assets",
    concepts: ["AssetsCurrent"],
    unitKeys: ["USD"],
  },
  {
    key: "currentLiabilities",
    label: "current liabilities",
    concepts: ["LiabilitiesCurrent"],
    unitKeys: ["USD"],
  },
  {
    key: "stockholdersEquity",
    label: "stockholders' equity",
    concepts: [
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
    unitKeys: ["USD"],
    optional: true,
  },
  {
    key: "assets",
    label: "total assets",
    concepts: ["Assets"],
    unitKeys: ["USD"],
    optional: true,
  },
  {
    key: "dividendsPaid",
    label: "dividends paid",
    // Cash-flow total first: some filers tag the common-only concept just quarterly (Meta).
    concepts: [
      "PaymentsOfDividends",
      "PaymentsOfDividendsCommonStock",
      "PaymentsOfOrdinaryDividends",
      "PaymentsForDividends",
      "DividendsPaid",
    ],
    unitKeys: ["USD"],
    optional: true,
  },
  {
    key: "shareRepurchases",
    label: "share repurchases",
    concepts: [
      "PaymentsForRepurchaseOfCommonStock",
      "PaymentsForRepurchaseOfEquity",
      "PaymentsForRepurchaseOfCommonStockAndPreferredStock",
    ],
    unitKeys: ["USD"],
    optional: true,
  },
] as const satisfies readonly SecMetricDefinition[];

export type SecMetricDefinitionKey = (typeof SEC_METRIC_DEFINITIONS)[number]["key"];

export const DEBT_METRIC = {
  key: "debt",
  label: "debt",
  concepts: DEBT_CONCEPTS["us-gaap"].totals,
  unitKeys: ["USD"],
} as const satisfies SecMetricDefinition;

export const DEBT_MAY_INCLUDE_FINANCE_LEASES = "may-include-finance-leases";

export function leaseInclusiveDebtGap(periodEnd: string, concepts: readonly string[]): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: `SEC debt as of ${periodEnd} may include finance leases: ${concepts.join(", ")} is tagged without a matching finance-lease amount to remove`,
    provider: "sec-edgar",
    capability: "extended-evidence",
    cause: "provider-data-missing",
    evidenceQualityImpact: "no-cap",
  });
}

export function withheldDebtGap(periodEnd: string, reason: string): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: `SEC debt withheld: the newest debt instant ${periodEnd} is incomplete (${reason}), and no older amount stands in as current debt`,
    provider: "sec-edgar",
    capability: "extended-evidence",
    cause: "provider-data-missing",
    evidenceQualityImpact: "no-cap",
  });
}

export function isDebtBasisGap(gap: SourceGap): boolean {
  return (
    gap.provider === "sec-edgar" &&
    (gap.message.startsWith("SEC debt withheld: ") ||
      /^SEC debt as of \S+ may include finance leases: /u.test(gap.message))
  );
}

// A change off a non-positive base, or into a negative value, is not meaningful.
export function deltaPercent(latest: number, prior: number): number | undefined {
  return prior > 0 && latest >= 0 ? ((latest - prior) / prior) * 100 : undefined;
}

// Below 2% of revenue, a one-point margin move swings the ratio by 50% or more.
export const MIN_MEANINGFUL_BASE_REVENUE_SHARE = 0.02;

export function nearZeroBase(base: number, revenue: number): boolean {
  return base > 0 && base < MIN_MEANINGFUL_BASE_REVENUE_SHARE * Math.abs(revenue);
}

// The series whose prior-year base a YoY's materiality reads; EPS reads its income.
export const YOY_BASE_SERIES: Readonly<Partial<Record<string, string>>> = {
  grossProfit: "grossProfit",
  operatingIncome: "operatingIncome",
  netIncome: "netIncome",
  consolidatedNetIncome: "consolidatedNetIncome",
  consolidatedContinuingIncome: "consolidatedContinuingIncome",
  continuingIncome: "continuingIncome",
  operatingCashFlow: "operatingCashFlow",
  dilutedEps: "netIncome",
  continuingDilutedEps: "continuingIncome",
};

type SummaryMetrics = Readonly<Record<string, number | string>> | undefined;

export function summarySamePeriod(metrics: SummaryMetrics, left: string, right: string): boolean {
  return (
    metrics?.[`${left}PeriodEnd`] !== undefined &&
    metrics[`${left}PeriodEnd`] === metrics[`${right}PeriodEnd`] &&
    metrics[`${left}PeriodMonths`] === metrics[`${right}PeriodMonths`]
  );
}

export function summaryPriorBase(
  metrics: SummaryMetrics,
  key: string,
): { readonly baseKey: string; readonly base: number; readonly revenue?: number } | undefined {
  const baseKey = YOY_BASE_SERIES[key];
  const aligned =
    baseKey === key || (baseKey !== undefined && summarySamePeriod(metrics, key, baseKey));
  const base = aligned ? metrics?.[`${baseKey}Prior`] : undefined;
  const revenue = summarySamePeriod(metrics, key, "revenue") ? metrics?.revenuePrior : undefined;
  return baseKey === undefined || typeof base !== "number"
    ? undefined
    : { baseKey, base, ...(typeof revenue === "number" ? { revenue } : {}) };
}

function formatMetric(label: string, latest: number, delta: number | undefined): string {
  return delta === undefined
    ? `${label} ${String(latest)}`
    : `${label} ${String(latest)} (${delta.toFixed(1)}% YoY)`;
}

const SUMMARY_METRIC_DEFINITIONS: readonly SecMetricDefinition[] = [
  ...SEC_METRIC_DEFINITIONS,
  DEBT_METRIC,
];

// `metricsFor` picks the metric source per key, so canonical inputs can override legacy ones.
export function formatSecFundamentalsSummary(
  metricsFor: (key: string) => Readonly<Record<string, number | string>> | undefined,
): string | undefined {
  const parts = SUMMARY_METRIC_DEFINITIONS.flatMap(({ key, label }) => {
    const metrics = metricsFor(key);
    const latest = metrics?.[key];
    if (typeof latest !== "number") {
      return [];
    }
    if (key === "consolidatedNetIncome" && metricsFor("netIncome")?.netIncome === latest) {
      return [];
    }
    if (
      key === "consolidatedContinuingIncome" &&
      metricsFor("continuingIncome")?.continuingIncome === latest
    ) {
      return [];
    }
    const prior = summaryPriorBase(metrics, key);
    const delta =
      prior?.revenue !== undefined && nearZeroBase(prior.base, prior.revenue)
        ? undefined
        : metrics?.[`${key}DeltaPercent`];
    const scope = metrics?.[`${key}Scope`];
    return [
      formatMetric(
        scopedLabel(label, typeof scope === "string" ? scope : undefined),
        latest,
        typeof delta === "number" ? delta : undefined,
      ),
    ];
  });
  return parts.length === 0 ? undefined : `SEC Fundamental Evidence: ${parts.join(", ")}.`;
}
