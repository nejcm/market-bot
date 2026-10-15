import { isInstrumentCommand, type InstrumentCommand, type ResearchCommand } from "../../cli/args";
import type { ExtendedEvidence, ExtendedEvidenceItem } from "../../domain/evidence";
import type { MarketSnapshot, VerifiedMarketSnapshot } from "../../domain/market-data";
import type { SourceGap } from "../../domain/sources";
import { sourceGap } from "../../domain/source-gaps";
import { verifiedSnapshotSourceId } from "../../research/verified-snapshot-contract";
import {
  businessFrameworkMetrics,
  businessFrameworkMetricSectionId,
} from "./business-framework-metrics";
import type { FinancialStatementsArtifact } from "./financial-statements-contract";
import type { MetricSection } from "./metric-engine";
import { formatMetricValue, type LensValueUnit } from "./value-format";

const BUSINESS_FRAMEWORK_SECTION_NAMES = [
  "Business",
  "Phase",
  "Moat",
  "Growth",
  "Management",
  "Risk",
  "Valuation",
] as const;
export type BusinessFrameworkSectionName = (typeof BUSINESS_FRAMEWORK_SECTION_NAMES)[number];

const BUSINESS_FRAMEWORK_PHASES = [
  "startup",
  "hyper-growth",
  "operating-leverage",
  "capital-return",
  "decline",
] as const;
export type BusinessLifecyclePhase = (typeof BUSINESS_FRAMEWORK_PHASES)[number];

const BUSINESS_FRAMEWORK_POSTURES = [
  "criteria-supported",
  "criteria-mixed",
  "criteria-not-supported",
  "insufficient-data",
] as const;
export type BusinessFrameworkPosture = (typeof BUSINESS_FRAMEWORK_POSTURES)[number];

export function isBusinessFrameworkSectionName(
  value: string,
): value is BusinessFrameworkSectionName {
  return (BUSINESS_FRAMEWORK_SECTION_NAMES as readonly string[]).includes(value);
}

export function isBusinessLifecyclePhase(value: string): value is BusinessLifecyclePhase {
  return (BUSINESS_FRAMEWORK_PHASES as readonly string[]).includes(value);
}

export function isBusinessFrameworkPosture(value: string): value is BusinessFrameworkPosture {
  return (BUSINESS_FRAMEWORK_POSTURES as readonly string[]).includes(value);
}

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
  readonly metricSectionIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly gaps: readonly BusinessFrameworkGapValue[];
}

export interface BusinessFrameworkReconciliation {
  readonly resolvedGaps: readonly BusinessFrameworkGapCode[];
  readonly profileSourceIds: readonly string[];
}

export interface BusinessFrameworkArtifact {
  readonly version: 1 | 2 | 3;
  readonly generatedAt: string;
  readonly symbol: string;
  readonly phase: BusinessLifecyclePhase;
  readonly sections: readonly BusinessFrameworkSection[];
  readonly sourceIds: readonly string[];
  readonly gaps: readonly BusinessFrameworkGapValue[];
  readonly reconciliation?: BusinessFrameworkReconciliation;
}

interface BusinessFrameworkResult {
  readonly extendedEvidence?: ExtendedEvidence;
  readonly artifact?: BusinessFrameworkArtifact;
  readonly sourceGaps: readonly SourceGap[];
  readonly metricSections?: readonly MetricSection[];
  readonly metricSectionGaps?: readonly SourceGap[];
}

const SECTION_ORDER = BUSINESS_FRAMEWORK_SECTION_NAMES;

const BUSINESS_FRAMEWORK_GAP_CODES = [
  "business-description",
  "geographic-mix",
  "segment-mix",
  "customer-concentration",
  "purchase-recurrence",
  "management-track-record",
  "capital-allocation",
  "company-kpis",
  "risk-factors",
  "analyst-consensus",
  "pricing-power",
  "cyclicality",
] as const;
export type BusinessFrameworkGapCode = (typeof BUSINESS_FRAMEWORK_GAP_CODES)[number];

export function isBusinessFrameworkGapCode(value: string): value is BusinessFrameworkGapCode {
  return (BUSINESS_FRAMEWORK_GAP_CODES as readonly string[]).includes(value);
}

export interface BusinessFrameworkGap {
  readonly code: BusinessFrameworkGapCode;
  readonly text: string;
}

export type BusinessFrameworkGapValue = BusinessFrameworkGap | string;

export const QUALITATIVE_GAPS = [
  {
    code: "business-description",
    text: "Business description is not available from current normalized sources",
  },
  {
    code: "geographic-mix",
    text: "Geographic revenue mix is not available from current normalized sources",
  },
  { code: "segment-mix", text: "Segment mix is not available from current normalized sources" },
  {
    code: "customer-concentration",
    text: "Customer concentration is not available from current normalized sources",
  },
  {
    code: "purchase-recurrence",
    text: "Purchase recurrence is not available from current normalized sources",
  },
  {
    code: "management-track-record",
    text: "Management track record is not available from current normalized sources",
  },
  {
    code: "capital-allocation",
    text: "Capital allocation commentary is not available from current normalized sources",
  },
  {
    code: "company-kpis",
    text: "Company-specific KPI evidence is not available from current normalized sources",
  },
  {
    code: "risk-factors",
    text: "Disclosed risk-factor evidence is not available from current normalized sources",
  },
  {
    code: "analyst-consensus",
    text: "Analyst consensus is not available from a provider-neutral authoritative capability",
  },
  {
    code: "pricing-power",
    text: "Pricing power evidence is not available from current normalized sources",
  },
  {
    code: "cyclicality",
    text: "Recession cyclicality evidence is not available from current normalized sources",
  },
] as const satisfies readonly BusinessFrameworkGap[];

function qualitativeGaps(
  ...codes: readonly BusinessFrameworkGapCode[]
): readonly BusinessFrameworkGap[] {
  return QUALITATIVE_GAPS.filter((gap) => codes.includes(gap.code));
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

function sectionSummary(
  name: BusinessFrameworkSectionName,
  posture: BusinessFrameworkPosture,
  metricSection: MetricSection | undefined,
): string {
  const metricText = (metricSection?.metrics ?? [])
    .flatMap((metric) => {
      const value =
        metric.status === "value"
          ? formatMetricValue(metric.value, metric.unit, metric.currency)
          : undefined;
      return value === undefined ? [] : [`${metric.label} ${value}`];
    })
    .slice(0, 3)
    .join(", ");
  if (name === "Phase") {
    return `Phase classification${metricText === "" ? "" : ` (${metricText})`}`;
  }
  return `${name} ${posture}${metricText === "" ? "" : ` (${metricText})`}`;
}

const SECTION_GAPS: Readonly<
  Record<BusinessFrameworkSectionName, readonly BusinessFrameworkGapCode[]>
> = {
  Business: [
    "business-description",
    "geographic-mix",
    "segment-mix",
    "customer-concentration",
    "purchase-recurrence",
  ],
  Phase: [],
  Moat: ["segment-mix", "customer-concentration", "purchase-recurrence", "pricing-power"],
  Growth: ["company-kpis", "analyst-consensus"],
  Management: ["management-track-record", "capital-allocation"],
  Risk: ["risk-factors", "cyclicality"],
  Valuation: [],
};

export function frameworkGaps(
  symbol: string,
  gaps: readonly BusinessFrameworkGapValue[],
): readonly SourceGap[] {
  return gaps.map((gap) =>
    sourceGap({
      source: "business-framework",
      message: `Business Framework partial for ${symbol}: ${typeof gap === "string" ? gap : `${gap.code}: ${gap.text}`}`,
      provider: "market-bot",
      capability: "extended-evidence",
      cause: "provider-data-missing",
      evidenceQualityImpact: "no-cap",
    }),
  );
}

const FRAMEWORK_GAP_CODE_RE = /^Business Framework partial for [^:]+: (?<code>[a-z-]+): /u;

// Reads back the gap code that frameworkGaps encodes into the message. SourceGap
// Carries no code field, so this parser and frameworkGaps are one contract; the
// Round-trip test fails if either side moves.
export function frameworkGapCode(gap: SourceGap): BusinessFrameworkGapCode | undefined {
  if (gap.source !== "business-framework") {
    return undefined;
  }
  const code = FRAMEWORK_GAP_CODE_RE.exec(gap.message)?.groups?.code;
  return code !== undefined && isBusinessFrameworkGapCode(code) ? code : undefined;
}

export function addBusinessFrameworkEvidence(
  command: ResearchCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedEvidence: ExtendedEvidence | undefined,
  verifiedMarketSnapshot: VerifiedMarketSnapshot | undefined,
  generatedAt: string,
  statements?: FinancialStatementsArtifact,
): BusinessFrameworkResult {
  if (!isInstrumentCommand(command) || command.assetClass !== "equity") {
    return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
  }

  const secItem = itemByCategory(extendedEvidence, "sec-edgar");
  const valuationItem = itemByCategory(extendedEvidence, "valuation");
  const yahooItem = itemByCategory(extendedEvidence, "yahoo-fundamentals");
  const financialLensItem = itemByCategory(extendedEvidence, "financial-lens");
  const snapshot = tickerSnapshot(command, marketSnapshots);
  const secSourceIds = secItem?.sourceIds ?? [];
  const yahooSourceIds = yahooItem?.sourceIds ?? [];
  const valuationSourceIds = valuationItem?.sourceIds ?? [];
  const lensSourceIds = financialLensItem?.sourceIds ?? [];
  const verifiedSourceIds =
    verifiedMarketSnapshot === undefined
      ? []
      : [verifiedSnapshotSourceId(verifiedMarketSnapshot.symbol)];
  const metrics = businessFrameworkMetrics({
    symbol: command.symbol,
    ...(statements !== undefined ? { statements } : {}),
    ...(extendedEvidence !== undefined ? { evidence: extendedEvidence } : {}),
    asOf: generatedAt,
  });
  const sectionSourceIds: Readonly<Record<BusinessFrameworkSectionName, readonly string[]>> = {
    Business: secSourceIds,
    Phase: [...new Set([...secSourceIds, ...yahooSourceIds])],
    Moat: secSourceIds,
    Growth: secSourceIds,
    Management: [],
    Risk: lensSourceIds,
    Valuation: [...new Set([...valuationSourceIds, ...yahooSourceIds])],
  };
  const sections = SECTION_ORDER.map((name): BusinessFrameworkSection => {
    const posture = metrics.postures[name];
    const metricSection = metrics.sections[name];
    return {
      name,
      posture,
      summary: sectionSummary(name, posture, metricSection),
      metricSectionIds: metricSection === undefined ? [] : [businessFrameworkMetricSectionId(name)],
      sourceIds: sectionSourceIds[name],
      gaps: qualitativeGaps(...SECTION_GAPS[name]),
    };
  });
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
  const { phase } = metrics;
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
    version: 3,
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
  return {
    extendedEvidence: mergedEvidence,
    artifact,
    sourceGaps,
    metricSections: SECTION_ORDER.flatMap((name) => {
      const metricSection = metrics.sections[name];
      return metricSection === undefined ? [] : [metricSection];
    }),
    metricSectionGaps: metrics.sourceGaps,
  };
}
