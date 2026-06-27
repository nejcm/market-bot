import { isInstrumentCommand, type InstrumentCommand, type ResearchCommand } from "../../cli/args";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  MarketSnapshot,
  SourceGap,
  VerifiedMarketSnapshot,
} from "../../domain/types";
import { sourceGap } from "../../domain/source-gaps";
import { verifiedSnapshotSourceId } from "../../research/verified-snapshot-contract";
import { formatLensValue, type LensValueUnit } from "./value-format";

export type BusinessFrameworkSectionName =
  | "Business"
  | "Phase"
  | "Moat"
  | "Growth"
  | "Management"
  | "Risk"
  | "Valuation";

export type BusinessLifecyclePhase =
  | "startup"
  | "hyper-growth"
  | "operating-leverage"
  | "capital-return"
  | "decline";

export type BusinessFrameworkPosture =
  | "criteria-supported"
  | "criteria-mixed"
  | "criteria-not-supported"
  | "insufficient-data";

export interface BusinessFrameworkMetric {
  readonly key: string;
  readonly label: string;
  readonly value: number | string;
  readonly unit: LensValueUnit;
  readonly sourceIds: readonly string[];
  readonly currency?: string;
}

export interface BusinessFrameworkSection {
  readonly name: BusinessFrameworkSectionName;
  readonly posture: BusinessFrameworkPosture;
  readonly summary: string;
  readonly metrics: readonly BusinessFrameworkMetric[];
  readonly sourceIds: readonly string[];
  readonly gaps: readonly string[];
}

export interface BusinessFrameworkReconciliation {
  readonly resolvedGaps: readonly string[];
  readonly profileSourceIds: readonly string[];
}

export interface BusinessFrameworkArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly symbol: string;
  readonly phase: BusinessLifecyclePhase;
  readonly sections: readonly BusinessFrameworkSection[];
  readonly sourceIds: readonly string[];
  readonly gaps: readonly string[];
  readonly reconciliation?: BusinessFrameworkReconciliation;
}

interface BusinessFrameworkResult {
  readonly extendedEvidence?: ExtendedEvidence;
  readonly artifact?: BusinessFrameworkArtifact;
  readonly sourceGaps: readonly SourceGap[];
}

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

const SECTION_ORDER: readonly BusinessFrameworkSectionName[] = [
  "Business",
  "Phase",
  "Moat",
  "Growth",
  "Management",
  "Risk",
  "Valuation",
];

export const QUALITATIVE_GAPS = [
  "Segment mix, customer concentration, and purchase recurrence are not available from current normalized sources",
  "Management track record and capital allocation commentary are not available from current normalized sources",
  "Analyst estimates, company-specific KPIs, and risk bucket evidence are not available from current normalized sources",
] as const;

function readMetric(
  metrics: Readonly<Record<string, number | string>> | undefined,
  key: string,
): number | undefined {
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function section(
  name: BusinessFrameworkSectionName,
  posture: BusinessFrameworkPosture,
  metrics: readonly BusinessFrameworkMetric[],
  sourceIds: readonly string[],
  gaps: readonly string[] = [],
): BusinessFrameworkSection {
  return {
    name,
    posture,
    summary: sectionSummary(name, posture, metrics),
    metrics,
    sourceIds,
    gaps,
  };
}

export function frameworkGap(symbol: string, gaps: readonly string[]): SourceGap {
  return sourceGap({
    source: "business-framework",
    message: `Business Framework partial for ${symbol}: ${gaps.join("; ")}`,
    provider: "market-bot",
    capability: "extended-evidence",
    cause: "provider-data-missing",
    evidenceQualityImpact: "no-cap",
  });
}

export function addBusinessFrameworkEvidence(
  command: ResearchCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedEvidence: ExtendedEvidence | undefined,
  verifiedMarketSnapshot: VerifiedMarketSnapshot | undefined,
  generatedAt: string,
): BusinessFrameworkResult {
  if (!isInstrumentCommand(command) || command.assetClass !== "equity") {
    return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
  }

  const secItem = itemByCategory(extendedEvidence, "sec-edgar");
  const valuationItem = itemByCategory(extendedEvidence, "valuation");
  const yahooItem = itemByCategory(extendedEvidence, "yahoo-fundamentals");
  const financialLensItem = itemByCategory(extendedEvidence, "financial-lens");
  const snapshot = tickerSnapshot(command, marketSnapshots);
  const quoteCurrency = snapshot?.identity?.quoteCurrency ?? "USD";
  const secSourceIds = secItem?.sourceIds ?? [];
  const yahooSourceIds = yahooItem?.sourceIds ?? [];
  const valuationSourceIds = valuationItem?.sourceIds ?? [];
  const verifiedSourceIds =
    verifiedMarketSnapshot === undefined
      ? []
      : [verifiedSnapshotSourceId(verifiedMarketSnapshot.symbol)];
  const revenue = readMetric(secItem?.metrics, "revenue");
  const grossProfit = readMetric(secItem?.metrics, "grossProfit");
  const operatingIncome = readMetric(secItem?.metrics, "operatingIncome");
  const netIncome = readMetric(secItem?.metrics, "netIncome");
  const revenueDeltaPercent = readMetric(secItem?.metrics, "revenueDeltaPercent");
  const operatingIncomeDeltaPercent = readMetric(secItem?.metrics, "operatingIncomeDeltaPercent");
  const netIncomeDeltaPercent = readMetric(secItem?.metrics, "netIncomeDeltaPercent");
  const operatingCashFlowDeltaPercent = readMetric(
    secItem?.metrics,
    "operatingCashFlowDeltaPercent",
  );
  const dividendsPaid = readMetric(secItem?.metrics, "dividendsPaid");
  const shareRepurchases = readMetric(secItem?.metrics, "shareRepurchases");
  const dividendYield = readMetric(yahooItem?.metrics, "dividendYield");
  const grossMargin = ratio(grossProfit, revenue);
  const operatingMargin = ratio(operatingIncome, revenue);
  const currentRatio = readMetric(financialLensItem?.metrics, "currentRatio");
  const debtToMarketCap = readMetric(financialLensItem?.metrics, "debtToMarketCap");
  const hasCapitalReturnEvidence = hasCapitalReturn({
    dividendsPaid,
    shareRepurchases,
    dividendYield,
  });
  const valuationSupportability = valuationItem?.metrics?.valuationSupportability;
  const phase = classifyBusinessLifecyclePhase({
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
        ...metric("revenue", "Revenue", revenue, "currency", secSourceIds, quoteCurrency),
        ...metric(
          "grossProfit",
          "Gross profit",
          grossProfit,
          "currency",
          secSourceIds,
          quoteCurrency,
        ),
        ...metric(
          "operatingIncome",
          "Operating income",
          operatingIncome,
          "currency",
          secSourceIds,
          quoteCurrency,
        ),
      ],
      secSourceIds,
      [QUALITATIVE_GAPS[0]],
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
          quoteCurrency,
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
      [QUALITATIVE_GAPS[0]],
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
          "Net income YoY",
          netIncomeDeltaPercent,
          "whole-percent",
          secSourceIds,
        ),
      ],
      secSourceIds,
      [QUALITATIVE_GAPS[2]],
    ),
    section("Management", "insufficient-data", [], [], [QUALITATIVE_GAPS[1]]),
    section(
      "Risk",
      postureFrom([
        currentRatio === undefined ? undefined : currentRatio >= 1,
        debtToMarketCap === undefined ? undefined : debtToMarketCap <= 0.5,
        revenueDeltaPercent === undefined ? undefined : revenueDeltaPercent >= 0,
      ]),
      [
        ...metric(
          "currentRatio",
          "Current ratio",
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
      [QUALITATIVE_GAPS[2]],
    ),
    section(
      "Valuation",
      postureFrom([
        valuationSupportability === undefined ? undefined : valuationSupportability === "supported",
      ]),
      [
        ...metric(
          "trailingPE",
          "Trailing PE",
          readMetric(yahooItem?.metrics, "trailingPE"),
          "ratio",
          yahooSourceIds,
        ),
        ...metric(
          "forwardPE",
          "Forward PE",
          readMetric(yahooItem?.metrics, "forwardPE"),
          "ratio",
          yahooSourceIds,
        ),
        ...metric(
          "evToAnnualizedRevenue",
          "EV/revenue",
          readMetric(valuationItem?.metrics, "evToAnnualizedRevenue"),
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
  const gaps = [...new Set(sections.flatMap((frameworkSection) => frameworkSection.gaps))];
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
  const artifact: BusinessFrameworkArtifact = {
    version: 1,
    generatedAt,
    symbol: command.symbol.toUpperCase(),
    phase,
    sections,
    sourceIds,
    gaps,
  };
  const sourceGaps = gaps.length === 0 ? [] : [frameworkGap(command.symbol, gaps)];
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
