import { isInstrumentCommand, type InstrumentCommand, type ResearchCommand } from "../../cli/args";
import type { ExtendedEvidence, ExtendedEvidenceItem } from "../../domain/evidence";
import type { MarketSnapshot, VerifiedMarketSnapshot } from "../../domain/market-data";
import type { SourceGap } from "../../domain/sources";
import { verifiedSnapshotSourceId } from "../../research/verified-snapshot-contract";
import {
  frameworkGaps,
  QUALITATIVE_GAPS,
  type BusinessFrameworkArtifact,
  type BusinessFrameworkGap,
  type BusinessFrameworkGapCode,
  type BusinessLifecyclePhase,
  type BusinessFrameworkMetric,
  type BusinessFrameworkPosture,
  type BusinessFrameworkSection,
  type BusinessFrameworkSectionName,
} from "./business-framework";
import { selectedFinancialLensDerivedMetric } from "./financial-lens-canonical";
import { secFundamentalItem, secScope } from "./financial-lens-metrics";
import { currentRatioIsCurrent } from "./financial-lens-builders";
import { scopedLabel } from "./financial-statement-definitions";
import { REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT } from "./valuation-comps";
import { readNumberMetric, readStringMetric } from "./utils";
import { formatLensValue } from "./value-format";

// Shortcut: the pre-Metric-Section builder, kept only as the accepted-difference gate's oracle; delete with the gate.
type LegacyBusinessFrameworkSection = Omit<BusinessFrameworkSection, "metricSectionIds"> & {
  readonly metrics: readonly BusinessFrameworkMetric[];
};

type LegacyBusinessFrameworkArtifact = Omit<BusinessFrameworkArtifact, "version" | "sections"> & {
  readonly version: 2;
  readonly sections: readonly LegacyBusinessFrameworkSection[];
};

interface LegacyBusinessFrameworkResult {
  readonly extendedEvidence?: ExtendedEvidence;
  readonly artifact?: LegacyBusinessFrameworkArtifact;
  readonly sourceGaps: readonly SourceGap[];
}

const SECTION_ORDER: readonly BusinessFrameworkSectionName[] = [
  "Business",
  "Phase",
  "Moat",
  "Growth",
  "Management",
  "Risk",
  "Valuation",
];

function qualitativeGaps(
  ...codes: readonly BusinessFrameworkGapCode[]
): readonly BusinessFrameworkGap[] {
  return QUALITATIVE_GAPS.filter((gap) => codes.includes(gap.code));
}

function hasCapitalReturn(input: {
  readonly dividendsPaid?: number | undefined;
  readonly shareRepurchases?: number | undefined;
  readonly dividendYield?: number | undefined;
}): boolean {
  return (
    (input.dividendsPaid !== undefined && Math.abs(input.dividendsPaid) > 0) ||
    (input.shareRepurchases !== undefined && Math.abs(input.shareRepurchases) > 0) ||
    (input.dividendYield !== undefined && input.dividendYield > 0)
  );
}

function classifyLegacyPhase(input: {
  readonly revenueDeltaPercent?: number | undefined;
  readonly operatingIncome?: number | undefined;
  readonly operatingIncomeDeltaPercent?: number | undefined;
  readonly netIncome?: number | undefined;
  readonly netIncomeDeltaPercent?: number | undefined;
  readonly dividendsPaid?: number | undefined;
  readonly shareRepurchases?: number | undefined;
  readonly dividendYield?: number | undefined;
}): BusinessLifecyclePhase {
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

function itemByCategory(
  extendedEvidence: ExtendedEvidence | undefined,
  category: ExtendedEvidenceItem["category"],
): ExtendedEvidenceItem | undefined {
  return extendedEvidence?.items.find((item) => item.category === category);
}

function tickerSnapshot(
  command: InstrumentCommand,
  marketSnapshots: readonly MarketSnapshot[],
): MarketSnapshot | undefined {
  const symbol = command.symbol.toUpperCase();
  return marketSnapshots.find(
    (snapshot) =>
      snapshot.assetClass === command.assetClass && snapshot.symbol.toUpperCase() === symbol,
  );
}

function ratio(numerator: number | undefined, denominator: number | undefined): number | undefined {
  return numerator !== undefined && denominator !== undefined && denominator !== 0
    ? numerator / denominator
    : undefined;
}

function positive(value: number | undefined): boolean | undefined {
  return value === undefined ? undefined : value > 0;
}

function postureFrom(
  values: readonly (boolean | undefined)[],
  requiredCount = 1,
): BusinessFrameworkPosture {
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

function metric(
  key: string,
  label: string,
  value: number | string | undefined,
  unit: BusinessFrameworkMetric["unit"],
  sourceIds: readonly string[],
  currency?: string,
): readonly BusinessFrameworkMetric[] {
  return value === undefined
    ? []
    : [{ key, label, value, unit, sourceIds, ...(currency !== undefined ? { currency } : {}) }];
}

function formatMetricValue(item: BusinessFrameworkMetric): string {
  return typeof item.value === "string"
    ? item.value
    : formatLensValue(item.value, item.unit, item.currency);
}

function sectionSummary(
  name: BusinessFrameworkSectionName,
  posture: BusinessFrameworkPosture,
  metrics: readonly BusinessFrameworkMetric[],
): string {
  const metricText = metrics
    .slice(0, 3)
    .map((item) => `${item.label} ${formatMetricValue(item)}`)
    .join(", ");
  if (name === "Phase") {
    return `Phase classification${metricText === "" ? "" : ` (${metricText})`}`;
  }
  return `${name} ${posture}${metricText === "" ? "" : ` (${metricText})`}`;
}

function section(
  name: BusinessFrameworkSectionName,
  posture: BusinessFrameworkPosture,
  metrics: readonly BusinessFrameworkMetric[],
  sourceIds: readonly string[],
  gaps: readonly BusinessFrameworkGap[] = [],
): LegacyBusinessFrameworkSection {
  return {
    name,
    posture,
    summary: sectionSummary(name, posture, metrics),
    metrics,
    sourceIds,
    gaps,
  };
}

// Counterfactual inputs for the parity gate: a waived metric's new value or filed currency.
export interface LegacyOverrides {
  readonly values?: Readonly<Record<string, number | undefined>>;
  readonly currencies?: Readonly<Record<string, string>>;
}

export function legacyBusinessFrameworkEvidence(
  command: ResearchCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedEvidence: ExtendedEvidence | undefined,
  verifiedMarketSnapshot: VerifiedMarketSnapshot | undefined,
  generatedAt: string,
  overrides: LegacyOverrides = {},
): LegacyBusinessFrameworkResult {
  if (!isInstrumentCommand(command) || command.assetClass !== "equity") {
    return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
  }

  const secItem = itemByCategory(extendedEvidence, "sec-edgar");
  const valuationItem = itemByCategory(extendedEvidence, "valuation");
  const yahooItem = itemByCategory(extendedEvidence, "yahoo-fundamentals");
  const financialLensItem = itemByCategory(extendedEvidence, "financial-lens");
  const snapshot = tickerSnapshot(command, marketSnapshots);
  const quoteCurrency = snapshot?.identity?.quoteCurrency ?? "USD";
  const values = overrides.values ?? {};
  const pick = (key: string, value: number | undefined) =>
    Object.hasOwn(values, key) ? values[key] : value;
  const currencyOf = (key: string) => overrides.currencies?.[key] ?? quoteCurrency;
  const secSourceIds = secItem?.sourceIds ?? [];
  const yahooSourceIds = yahooItem?.sourceIds ?? [];
  const valuationSourceIds = valuationItem?.sourceIds ?? [];
  const verifiedSourceIds =
    verifiedMarketSnapshot === undefined
      ? []
      : [verifiedSnapshotSourceId(verifiedMarketSnapshot.symbol)];
  const revenue = pick("revenue", readNumberMetric(secItem?.metrics, "revenue"));
  const grossProfit = pick("grossProfit", readNumberMetric(secItem?.metrics, "grossProfit"));
  const operatingIncome = pick(
    "operatingIncome",
    readNumberMetric(secItem?.metrics, "operatingIncome"),
  );
  const netIncome = pick("netIncome", readNumberMetric(secItem?.metrics, "netIncome"));
  const revenueDeltaPercent = pick(
    "revenueDeltaPercent",
    readNumberMetric(secItem?.metrics, "revenueDeltaPercent"),
  );
  const operatingIncomeDeltaPercent = pick(
    "operatingIncomeDeltaPercent",
    readNumberMetric(secItem?.metrics, "operatingIncomeDeltaPercent"),
  );
  const netIncomeDeltaPercent = pick(
    "netIncomeDeltaPercent",
    readNumberMetric(secItem?.metrics, "netIncomeDeltaPercent"),
  );
  const operatingCashFlowDeltaPercent = pick(
    "operatingCashFlowDeltaPercent",
    readNumberMetric(secItem?.metrics, "operatingCashFlowDeltaPercent"),
  );
  const dividendsPaid = pick("dividendsPaid", readNumberMetric(secItem?.metrics, "dividendsPaid"));
  const shareRepurchases = pick(
    "shareRepurchases",
    readNumberMetric(secItem?.metrics, "shareRepurchases"),
  );
  const dividendYield = pick(
    "dividendYield",
    readNumberMetric(yahooItem?.metrics, "dividendYield"),
  );
  const grossMargin = pick(
    "grossMargin",
    selectedFinancialLensDerivedMetric(secItem, "grossMargin", ratio(grossProfit, revenue)),
  );
  const operatingMargin = pick(
    "operatingMargin",
    selectedFinancialLensDerivedMetric(secItem, "operatingMargin", ratio(operatingIncome, revenue)),
  );
  const currentRatio = pick(
    "currentRatio",
    readNumberMetric(financialLensItem?.metrics, "currentRatio"),
  );
  const currentRatioPeriodEnd = readStringMetric(
    financialLensItem?.metrics,
    "currentRatioPeriodEnd",
  );
  const currentRatioEligible = currentRatioIsCurrent(
    secFundamentalItem(extendedEvidence),
    generatedAt,
  );
  const debtToMarketCap = pick(
    "debtToMarketCap",
    readNumberMetric(financialLensItem?.metrics, "debtToMarketCap"),
  );
  const hasCapitalReturnEvidence = hasCapitalReturn({
    dividendsPaid,
    shareRepurchases,
    dividendYield,
  });
  const valuationSupportability = valuationItem?.metrics?.valuationSupportability;
  const valuationSupportabilityCriterion =
    valuationSupportability === undefined || valuationSupportability === "not-meaningful"
      ? undefined
      : valuationSupportability === "supported";
  const phase = classifyLegacyPhase({
    revenueDeltaPercent,
    operatingIncome,
    operatingIncomeDeltaPercent,
    netIncome,
    netIncomeDeltaPercent,
    dividendsPaid,
    shareRepurchases,
    dividendYield,
  });
  const sections = [
    section(
      "Business",
      postureFrom(
        [
          revenue === undefined ? undefined : true,
          grossProfit === undefined ? undefined : true,
          operatingIncome === undefined ? undefined : true,
        ],
        2,
      ),
      [
        ...metric("revenue", "Revenue", revenue, "currency", secSourceIds, currencyOf("revenue")),
        ...metric(
          "grossProfit",
          "Gross profit",
          grossProfit,
          "currency",
          secSourceIds,
          currencyOf("grossProfit"),
        ),
        ...metric(
          "operatingIncome",
          "Operating income",
          operatingIncome,
          "currency",
          secSourceIds,
          currencyOf("operatingIncome"),
        ),
      ],
      secSourceIds,
      qualitativeGaps(
        "business-description",
        "geographic-mix",
        "segment-mix",
        "customer-concentration",
        "purchase-recurrence",
      ),
    ),
    section(
      "Phase",
      revenueDeltaPercent === undefined && !hasCapitalReturnEvidence
        ? "insufficient-data"
        : "criteria-supported",
      [
        ...metric("phase", "Phase", phase, "text", [...secSourceIds, ...yahooSourceIds]),
        ...metric(
          "revenueDeltaPercent",
          "Revenue YoY",
          revenueDeltaPercent,
          "whole-percent",
          secSourceIds,
        ),
        ...metric(
          "dividendYield",
          "Dividend yield",
          dividendYield,
          "whole-percent",
          yahooSourceIds,
        ),
        ...metric(
          "shareRepurchases",
          "Share repurchases",
          shareRepurchases,
          "currency",
          secSourceIds,
          currencyOf("shareRepurchases"),
        ),
      ],
      [...new Set([...secSourceIds, ...yahooSourceIds])],
    ),
    section(
      "Moat",
      postureFrom([
        grossMargin === undefined ? undefined : grossMargin >= 0.4,
        operatingMargin === undefined ? undefined : operatingMargin > 0,
      ]),
      [
        ...metric("grossMargin", "Gross margin", grossMargin, "ratio-percent", secSourceIds),
        ...metric(
          "operatingMargin",
          "Operating margin",
          operatingMargin,
          "ratio-percent",
          secSourceIds,
        ),
      ],
      secSourceIds,
      qualitativeGaps(
        "segment-mix",
        "customer-concentration",
        "purchase-recurrence",
        "pricing-power",
      ),
    ),
    section(
      "Growth",
      postureFrom(
        [
          positive(revenueDeltaPercent),
          positive(operatingIncomeDeltaPercent),
          positive(netIncomeDeltaPercent),
          positive(operatingCashFlowDeltaPercent),
        ],
        2,
      ),
      [
        ...metric(
          "revenueDeltaPercent",
          "Revenue YoY",
          revenueDeltaPercent,
          "whole-percent",
          secSourceIds,
        ),
        ...metric(
          "operatingIncomeDeltaPercent",
          "Operating income YoY",
          operatingIncomeDeltaPercent,
          "whole-percent",
          secSourceIds,
        ),
        ...metric(
          "netIncomeDeltaPercent",
          scopedLabel("Net income YoY", secScope(secItem, "netIncome")),
          netIncomeDeltaPercent,
          "whole-percent",
          secSourceIds,
        ),
      ],
      secSourceIds,
      qualitativeGaps("company-kpis", "analyst-consensus"),
    ),
    section(
      "Management",
      "insufficient-data",
      [],
      [],
      qualitativeGaps("management-track-record", "capital-allocation"),
    ),
    section(
      "Risk",
      postureFrom([
        currentRatio === undefined || !currentRatioEligible ? undefined : currentRatio >= 1,
        debtToMarketCap === undefined ? undefined : debtToMarketCap <= 0.5,
        revenueDeltaPercent === undefined ? undefined : revenueDeltaPercent >= 0,
      ]),
      [
        ...metric(
          "currentRatio",
          currentRatioEligible
            ? "Current ratio"
            : `Current ratio (historical, ${currentRatioPeriodEnd ?? "undated"})`,
          currentRatio,
          "ratio",
          financialLensItem?.sourceIds ?? [],
        ),
        ...metric(
          "debtToMarketCap",
          "Debt/market cap",
          debtToMarketCap,
          "ratio-percent",
          financialLensItem?.sourceIds ?? [],
        ),
      ],
      financialLensItem?.sourceIds ?? [],
      qualitativeGaps("risk-factors", "cyclicality"),
    ),
    section(
      "Valuation",
      postureFrom([valuationSupportabilityCriterion]),
      [
        ...(valuationSupportability === "not-meaningful"
          ? metric(
              "valuationCaveat",
              "Valuation caveat",
              REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
              "text",
              valuationSourceIds,
            )
          : []),
        ...metric(
          "trailingPE",
          "Trailing PE",
          pick("trailingPE", readNumberMetric(yahooItem?.metrics, "trailingPE")),
          "ratio",
          yahooSourceIds,
        ),
        ...metric(
          "forwardPE",
          "Forward PE",
          pick("forwardPE", readNumberMetric(yahooItem?.metrics, "forwardPE")),
          "ratio",
          yahooSourceIds,
        ),
        ...metric(
          "evToAnnualizedRevenue",
          "EV/revenue",
          pick(
            "evToAnnualizedRevenue",
            readNumberMetric(valuationItem?.metrics, "evToAnnualizedRevenue"),
          ),
          "ratio",
          valuationSourceIds,
        ),
      ],
      [...new Set([...valuationSourceIds, ...yahooSourceIds])],
    ),
  ].toSorted((left, right) => SECTION_ORDER.indexOf(left.name) - SECTION_ORDER.indexOf(right.name));
  const sourceIds = [
    ...new Set(
      [
        ...sections.flatMap((frameworkSection) => frameworkSection.sourceIds),
        ...verifiedSourceIds,
      ].filter((sourceId) => sourceId !== ""),
    ),
  ];
  const gaps = [
    ...new Map(
      sections
        .flatMap((frameworkSection) => frameworkSection.gaps)
        .map((gap) => [typeof gap === "string" ? gap : gap.code, gap]),
    ).values(),
  ];
  const item: ExtendedEvidenceItem = {
    category: "business-framework",
    title: `${command.symbol} Business Framework Evidence`,
    summary: `Business Framework: ${sections.map((frameworkSection) => frameworkSection.summary).join("; ")}.`,
    sourceIds,
    observedAt:
      [
        snapshot?.observedAt,
        secItem?.observedAt,
        valuationItem?.observedAt,
        verifiedMarketSnapshot?.fetchedAt,
      ]
        .filter((value): value is string => value !== undefined)
        .toSorted()
        .at(-1) ?? generatedAt,
    metrics: Object.fromEntries([
      ["phase", phase],
      ...sections.map(
        (frameworkSection) =>
          [`${frameworkSection.name.toLowerCase()}Posture`, frameworkSection.posture] as const,
      ),
    ]),
    ...(secItem?.identity !== undefined ? { identity: secItem.identity } : {}),
  };
  const artifact: LegacyBusinessFrameworkArtifact = {
    version: 2,
    generatedAt,
    symbol: command.symbol.toUpperCase(),
    phase,
    sections,
    sourceIds,
    gaps,
  };
  const sourceGaps = frameworkGaps(command.symbol, gaps);
  const mergedEvidence: ExtendedEvidence = {
    instrument: extendedEvidence?.instrument ?? {
      symbol: command.symbol,
      assetClass: command.assetClass,
    },
    items: [...(extendedEvidence?.items ?? []), item],
    gaps: [...(extendedEvidence?.gaps ?? []), ...sourceGaps],
  };
  return { extendedEvidence: mergedEvidence, artifact, sourceGaps };
}
