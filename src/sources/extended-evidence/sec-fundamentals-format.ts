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

export function deltaPercent(latest: number, prior: number): number | undefined {
  return prior === 0 ? undefined : ((latest - prior) / Math.abs(prior)) * 100;
}

function formatMetric(
  label: string,
  latest: number,
  prior: number | undefined,
  delta: number | undefined,
): string {
  if (delta === undefined) {
    return `${label} ${String(latest)}`;
  }
  if (prior !== undefined && latest < 0 && prior < 0) {
    const direction = latest < prior ? "widened" : "narrowed";
    return `${label} ${String(latest)} (loss ${direction} ${Math.abs(delta).toFixed(1)}% YoY)`;
  }
  return `${label} ${String(latest)} (${delta.toFixed(1)}% YoY)`;
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
    const prior = metrics?.[`${key}Prior`];
    const delta = metrics?.[`${key}DeltaPercent`];
    const scope = metrics?.[`${key}Scope`];
    return [
      formatMetric(
        scopedLabel(label, typeof scope === "string" ? scope : undefined),
        latest,
        typeof prior === "number" ? prior : undefined,
        typeof delta === "number" ? delta : undefined,
      ),
    ];
  });
  return parts.length === 0 ? undefined : `SEC Fundamental Evidence: ${parts.join(", ")}.`;
}
