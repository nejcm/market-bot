import { SOURCE_KINDS, type Source, type SubjectKind } from "./domain/types";
import { isSourceGapCause } from "./domain/source-gaps";
import {
  isEvidenceLane,
  type EvidenceLanesArtifact,
  type LaneCoverageStatus,
  type LaneRequirement,
  type SourceLedgerArtifact,
  type SourcePlanArtifact,
} from "./research/source-plan";
import type { FinancialLensArtifact } from "./sources/extended-evidence/financial-lens";
import { FUNDAMENTAL_HISTORY_POINT_FORMS } from "./sources/extended-evidence/financial-statements-contract";
import type {
  PeerImpliedRange,
  PeerImpliedRangeSuppressedReason,
} from "./sources/extended-evidence/valuation-comps";
import type {
  FundamentalHistoryArtifact,
  FundamentalHistorySeriesKey,
} from "./sources/extended-evidence/fundamental-history";
import {
  isBusinessFrameworkGapCode,
  isBusinessFrameworkPosture,
  isBusinessFrameworkSectionName,
  isBusinessLifecyclePhase,
  type BusinessFrameworkArtifact,
} from "./sources/extended-evidence/business-framework";
// Import the public profile contract leaf directly, not the ./web-evidence barrel.
// The web-evidence phase reuses this reader, while its barrel eagerly exports that phase.
// Importing the barrel here would form a run-artifacts → phase → profile-reuse → run-artifacts cycle.
import {
  LEGACY_WEB_SUBJECT_PROFILE_QUESTION_KEYS,
  WEB_SUBJECT_PROFILE_QUESTION_KEYS,
  type WebSubjectProfileAnswer,
  type WebSubjectProfileArtifact,
} from "./web-evidence/contract";
import {
  readWebSubjectProfileAnswer,
  readWebSubjectProfileFacts,
} from "./report/report-extras-contract";
import { isAssetClass, isJobType } from "./run-artifact-value-guards";
import { isRecord, readNumber, readString, readStringArray } from "./guards";

export interface ThemeCatalystItem {
  readonly label: string;
  readonly sourceIds: readonly string[];
  readonly date?: string;
  readonly sourceStatus?: string;
  readonly researchRelevance?: string;
}

const LANE_REQUIREMENTS: ReadonlySet<string> = new Set<LaneRequirement>(["required", "optional"]);
const LANE_COVERAGE_STATUSES: ReadonlySet<string> = new Set<LaneCoverageStatus>([
  "covered",
  "gap",
  "not-covered",
]);
const SOURCE_KIND_SET: ReadonlySet<Source["kind"]> = new Set(SOURCE_KINDS);

function isDepth(value: unknown): value is "brief" | "deep" {
  return value === "brief" || value === "deep";
}

function isLaneRequirement(value: unknown): value is LaneRequirement {
  return typeof value === "string" && LANE_REQUIREMENTS.has(value);
}

function isEvidenceClass(value: unknown): boolean {
  return value === "core" || value === "material" || value === "supplemental";
}

function isLaneCoverageStatus(value: unknown): value is LaneCoverageStatus {
  return typeof value === "string" && LANE_COVERAGE_STATUSES.has(value);
}

function isSourceKind(value: unknown): value is Source["kind"] {
  return typeof value === "string" && SOURCE_KIND_SET.has(value as Source["kind"]);
}

export function readThemeCatalysts(value: unknown): readonly ThemeCatalystItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly ThemeCatalystItem[] => {
    if (!isRecord(item)) {
      return [];
    }
    const label = readString(item, "label");
    if (label === undefined) {
      return [];
    }
    return [
      {
        label,
        sourceIds: readStringArray(item, "sourceIds") ?? [],
        ...(typeof item.date === "string" ? { date: item.date } : {}),
        ...(typeof item.sourceStatus === "string" ? { sourceStatus: item.sourceStatus } : {}),
        ...(typeof item.researchRelevance === "string"
          ? { researchRelevance: item.researchRelevance }
          : {}),
      },
    ];
  });
}

function hasSourcePlanRunShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    isJobType(value.jobType) &&
    isAssetClass(value.assetClass) &&
    isDepth(value.depth) &&
    (value.symbol === undefined || typeof value.symbol === "string") &&
    (value.subject === undefined || typeof value.subject === "string")
  );
}

function hasSourcePlanLaneShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    isEvidenceLane(value.lane) &&
    typeof value.appliesToRun === "boolean" &&
    ((isLaneRequirement(value.requirement) && typeof value.providerPath === "string") ||
      (isEvidenceClass(value.evidenceClass) && isEvidenceLane(value.capability)))
  );
}

export function readSourcePlan(value: unknown): SourcePlanArtifact | undefined {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    readString(value, "generatedAt") === undefined ||
    !hasSourcePlanRunShape(value.run) ||
    !Array.isArray(value.lanes) ||
    !value.lanes.every(hasSourcePlanLaneShape)
  ) {
    return;
  }
  return value as unknown as SourcePlanArtifact;
}

function hasEvidenceLaneSummaryShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    readNumber(value, "plannedLaneCount") !== undefined &&
    ((readNumber(value, "requiredLaneCount") !== undefined &&
      readNumber(value, "optionalLaneCount") !== undefined &&
      readNumber(value, "requiredGapLaneCount") !== undefined) ||
      (readNumber(value, "coreLaneCount") !== undefined &&
        readNumber(value, "materialLaneCount") !== undefined &&
        readNumber(value, "supplementalLaneCount") !== undefined &&
        readNumber(value, "coreGapLaneCount") !== undefined &&
        readNumber(value, "materialGapLaneCount") !== undefined)) &&
    readNumber(value, "coveredLaneCount") !== undefined &&
    readNumber(value, "gapLaneCount") !== undefined &&
    readNumber(value, "sourceCount") !== undefined &&
    readNumber(value, "gapCount") !== undefined &&
    readNumber(value, "coverageRatio") !== undefined
  );
}

function hasEvidenceLaneCoverageShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    isEvidenceLane(value.lane) &&
    isLaneCoverageStatus(value.status) &&
    (typeof value.required === "boolean" || isEvidenceClass(value.evidenceClass)) &&
    (value.supportable === undefined || typeof value.supportable === "boolean") &&
    (value.gapCauses === undefined ||
      (Array.isArray(value.gapCauses) && value.gapCauses.every(isSourceGapCause))) &&
    readStringArray(value, "coveredSourceIds") !== undefined &&
    readStringArray(value, "gapIds") !== undefined &&
    readStringArray(value, "gapText") !== undefined &&
    readStringArray(value, "freshnessNotes") !== undefined
  );
}

export function readEvidenceLanes(value: unknown): EvidenceLanesArtifact | undefined {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    readString(value, "generatedAt") === undefined ||
    !Array.isArray(value.lanes) ||
    !value.lanes.every(hasEvidenceLaneCoverageShape) ||
    !hasEvidenceLaneSummaryShape(value.summary)
  ) {
    return;
  }
  return value as unknown as EvidenceLanesArtifact;
}

const FINANCIAL_LENS_NAMES: ReadonlySet<string> = new Set([
  "Quality",
  "Growth",
  "Financial Strength",
  "Value",
  "Momentum",
]);
const FINANCIAL_LENS_POSTURES: ReadonlySet<string> = new Set([
  "criteria-supported",
  "criteria-mixed",
  "criteria-not-supported",
  "insufficient-data",
]);
const FINANCIAL_LENS_UNITS: ReadonlySet<string> = new Set([
  "ratio",
  "ratio-percent",
  "whole-percent",
  "currency",
  "number",
  "text",
]);
function hasFinancialLensMetricShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.label === "string" &&
    (typeof value.value === "number" || typeof value.value === "string") &&
    typeof value.unit === "string" &&
    FINANCIAL_LENS_UNITS.has(value.unit) &&
    readStringArray(value, "sourceIds") !== undefined &&
    (value.currency === undefined || typeof value.currency === "string") &&
    (value.periodEnd === undefined || typeof value.periodEnd === "string") &&
    (value.periodMonths === undefined ||
      (typeof value.periodMonths === "number" && Number.isFinite(value.periodMonths)))
  );
}

function hasFinancialLensShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    FINANCIAL_LENS_NAMES.has(value.name) &&
    typeof value.posture === "string" &&
    FINANCIAL_LENS_POSTURES.has(value.posture) &&
    Array.isArray(value.metrics) &&
    value.metrics.every(hasFinancialLensMetricShape) &&
    readStringArray(value, "sourceIds") !== undefined &&
    (value.currentStatus === undefined ||
      value.currentStatus === "current" ||
      value.currentStatus === "partial") &&
    (value.currentStatusReasonCodes === undefined ||
      readStringArray(value, "currentStatusReasonCodes") !== undefined)
  );
}

// Reads the structured financial-lenses.json artifact so the console can render
// Lens tiles dynamically from lenses[].metrics[] (label/value/unit) instead of a
// Hardcoded key list. Returns undefined when the file is absent or malformed.
export function readFinancialLensesArtifact(value: unknown): FinancialLensArtifact | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    readString(value, "generatedAt") === undefined ||
    readString(value, "symbol") === undefined ||
    !Array.isArray(value.lenses) ||
    !value.lenses.every(hasFinancialLensShape) ||
    readStringArray(value, "sourceIds") === undefined
  ) {
    return undefined;
  }
  return value as unknown as FinancialLensArtifact;
}

const PEER_IMPLIED_RANGE_SUPPRESSED_REASONS: ReadonlySet<PeerImpliedRangeSuppressedReason> =
  new Set([
    "peer supportability is not supported",
    "fewer than 3 usable peers",
    "annualized revenue is not positive",
    "net debt is unavailable",
    "net debt uses mixed reporting periods",
    "shares outstanding is not positive",
    "quote currency is not USD",
    "peer percentile inputs are unavailable",
    "one or more implied prices are not positive",
    "current price is unavailable",
  ]);

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function hasPeerImpliedRangeInputsShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNullableFiniteNumber(value.peerP25EvToAnnualizedRevenue) &&
    isNullableFiniteNumber(value.peerMedianEvToAnnualizedRevenue) &&
    isNullableFiniteNumber(value.peerP75EvToAnnualizedRevenue) &&
    isNullableFiniteNumber(value.annualizedRevenue) &&
    (isNullableFiniteNumber(value.netDebt) || value.netDebt === "mixed-period") &&
    isNullableFiniteNumber(value.sharesOutstanding) &&
    isNullableFiniteNumber(value.currentPrice) &&
    (value.quoteCurrency === null || typeof value.quoteCurrency === "string") &&
    (value.quoteObservedAt === null || typeof value.quoteObservedAt === "string")
  );
}

// Reads only the optional range block from valuation-comps.json. The console
// Does not consume the broader comps artifact.
export function readPeerImpliedRange(value: unknown): PeerImpliedRange | undefined {
  if (!isRecord(value) || !isRecord(value.impliedPriceRange)) {
    return undefined;
  }
  const range = value.impliedPriceRange;
  if (
    range.label !== "peer-implied price reference range" ||
    range.basis !== "peer EV/annualized revenue percentiles applied to target annualized revenue" ||
    range.formula !== "impliedPrice(m) = (m × annualizedRevenue − netDebt) / sharesOutstanding" ||
    !hasPeerImpliedRangeInputsShape(range.inputs)
  ) {
    return undefined;
  }
  if (
    range.status === "suppressed" &&
    typeof range.suppressedReason === "string" &&
    PEER_IMPLIED_RANGE_SUPPRESSED_REASONS.has(
      range.suppressedReason as PeerImpliedRangeSuppressedReason,
    )
  ) {
    return range as unknown as PeerImpliedRange;
  }
  const { inputs } = range;
  if (
    range.status === "derived" &&
    isRecord(inputs) &&
    readNumber(inputs, "peerP25EvToAnnualizedRevenue") !== undefined &&
    readNumber(inputs, "peerMedianEvToAnnualizedRevenue") !== undefined &&
    readNumber(inputs, "peerP75EvToAnnualizedRevenue") !== undefined &&
    readNumber(inputs, "annualizedRevenue") !== undefined &&
    readNumber(inputs, "netDebt") !== undefined &&
    readNumber(inputs, "sharesOutstanding") !== undefined &&
    readNumber(inputs, "currentPrice") !== undefined &&
    inputs.quoteCurrency === "USD" &&
    readString(inputs, "quoteObservedAt") !== undefined &&
    readNumber(range, "low") !== undefined &&
    readNumber(range, "mid") !== undefined &&
    readNumber(range, "high") !== undefined &&
    (range.position === "below-range" ||
      range.position === "within-range" ||
      range.position === "above-range")
  ) {
    return range as unknown as PeerImpliedRange;
  }
  return undefined;
}

const FUNDAMENTAL_HISTORY_SERIES_KEYS: readonly FundamentalHistorySeriesKey[] = [
  "revenue",
  "grossProfit",
  "operatingIncome",
  "netIncome",
  "dilutedEps",
  "operatingCashFlow",
  "capex",
  "freeCashFlowProxy",
  "grossMargin",
  "operatingMargin",
  "netMargin",
];

function hasFundamentalHistoryPointShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    readNumber(value, "value") !== undefined &&
    FUNDAMENTAL_HISTORY_POINT_FORMS.some((form) => value.form === form) &&
    readNumber(value, "fy") !== undefined &&
    readString(value, "fp") !== undefined &&
    readString(value, "periodStart") !== undefined &&
    readString(value, "periodEnd") !== undefined &&
    readNumber(value, "periodMonths") !== undefined &&
    readString(value, "filedAt") !== undefined &&
    readString(value, "currency") !== undefined
  );
}

function hasFundamentalHistoryCagrShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    readNumber(value, "percent") !== undefined &&
    readNumber(value, "years") !== undefined &&
    readString(value, "periodStart") !== undefined &&
    readString(value, "periodEnd") !== undefined
  );
}

function hasFundamentalHistoryMarginChangeShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    readNumber(value, "percentagePoints") !== undefined &&
    readNumber(value, "years") !== undefined &&
    readString(value, "periodStart") !== undefined &&
    readString(value, "periodEnd") !== undefined
  );
}

function hasFundamentalHistorySeriesShape(
  value: unknown,
  key: FundamentalHistorySeriesKey,
): boolean {
  return (
    isRecord(value) &&
    value.key === key &&
    readString(value, "label") !== undefined &&
    (value.unit === "currency" || value.unit === "per-share" || value.unit === "ratio") &&
    (value.concept === undefined || readString(value, "concept") !== undefined) &&
    Array.isArray(value.annual) &&
    value.annual.every(hasFundamentalHistoryPointShape) &&
    (value.ttm === undefined || hasFundamentalHistoryPointShape(value.ttm)) &&
    (value.cagr === undefined || hasFundamentalHistoryCagrShape(value.cagr)) &&
    (value.marginChange === undefined ||
      hasFundamentalHistoryMarginChangeShape(value.marginChange)) &&
    readStringArray(value, "notes") !== undefined
  );
}

export function readFundamentalHistoryArtifact(
  value: unknown,
): FundamentalHistoryArtifact | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    readString(value, "generatedAt") === undefined ||
    readString(value, "symbol") === undefined ||
    readString(value, "sourceId") === undefined ||
    (value.sourceUrl !== undefined && readString(value, "sourceUrl") === undefined) ||
    !isRecord(value.series)
  ) {
    return undefined;
  }
  const { series } = value;
  if (
    !FUNDAMENTAL_HISTORY_SERIES_KEYS.every((key) =>
      hasFundamentalHistorySeriesShape(series[key], key),
    )
  ) {
    return undefined;
  }
  return value as unknown as FundamentalHistoryArtifact;
}

function hasBusinessFrameworkGaps(value: unknown, version: 1 | 2): boolean {
  return (
    Array.isArray(value) &&
    value.every((gap) =>
      version === 1
        ? typeof gap === "string"
        : isRecord(gap) &&
          typeof gap.code === "string" &&
          isBusinessFrameworkGapCode(gap.code) &&
          typeof gap.text === "string",
    )
  );
}

function hasBusinessFrameworkSectionShape(value: unknown, version: 1 | 2): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isBusinessFrameworkSectionName(value.name) &&
    typeof value.posture === "string" &&
    isBusinessFrameworkPosture(value.posture) &&
    typeof value.summary === "string" &&
    Array.isArray(value.metrics) &&
    value.metrics.every(hasFinancialLensMetricShape) &&
    readStringArray(value, "sourceIds") !== undefined &&
    hasBusinessFrameworkGaps(value.gaps, version)
  );
}

export function readBusinessFrameworkArtifact(
  value: unknown,
): BusinessFrameworkArtifact | undefined {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
    return undefined;
  }
  const { version } = value;
  if (
    readString(value, "generatedAt") === undefined ||
    readString(value, "symbol") === undefined ||
    typeof value.phase !== "string" ||
    !isBusinessLifecyclePhase(value.phase) ||
    !Array.isArray(value.sections) ||
    !value.sections.every((section) => hasBusinessFrameworkSectionShape(section, version)) ||
    readStringArray(value, "sourceIds") === undefined ||
    !hasBusinessFrameworkGaps(value.gaps, version)
  ) {
    return undefined;
  }
  return value as unknown as BusinessFrameworkArtifact;
}

function readWebSubjectProfileQuestions(
  value: unknown,
  subjectKind: SubjectKind,
  version: 2 | 3,
): Readonly<Record<string, WebSubjectProfileAnswer>> | undefined {
  if (!isRecord(value)) {
    return;
  }
  const entries: [string, WebSubjectProfileAnswer][] = [];
  const keys =
    version === 2
      ? LEGACY_WEB_SUBJECT_PROFILE_QUESTION_KEYS[subjectKind]
      : WEB_SUBJECT_PROFILE_QUESTION_KEYS[subjectKind];
  for (const key of keys) {
    const answer = readWebSubjectProfileAnswer(value[key]);
    if (answer === undefined) {
      return;
    }
    entries.push([key, answer]);
  }
  return Object.fromEntries(entries);
}

export function readWebSubjectProfileArtifact(
  value: unknown,
): WebSubjectProfileArtifact | undefined {
  if (!isRecord(value) || (value.version !== 2 && value.version !== 3)) {
    return;
  }
  const version = value.version as 2 | 3;
  const generatedAt = readString(value, "generatedAt");
  const subjectKind = readSubjectKind(value.subjectKind);
  const subjectId = readString(value, "subjectId");
  if (subjectKind === undefined || subjectId === undefined) {
    return;
  }
  const questions = readWebSubjectProfileQuestions(value.questions, subjectKind, version);
  const subjectSummary = readWebSubjectProfileAnswer(value.subjectSummary);
  const recentMaterialEvents = readWebSubjectProfileFacts(value.recentMaterialEvents);
  const factLedger = readWebSubjectProfileFacts(value.factLedger);
  const openGaps = readStringArray(value, "openGaps");
  const sourceIds = readStringArray(value, "sourceIds");
  const symbol = readString(value, "symbol");
  const subjectLabel = readString(value, "subjectLabel");
  const companyName = readString(value, "companyName");
  const secFilingBasisDate = readString(value, "secFilingBasisDate");
  if (
    generatedAt === undefined ||
    subjectSummary === undefined ||
    questions === undefined ||
    recentMaterialEvents === undefined ||
    factLedger === undefined ||
    factLedger.length === 0 ||
    openGaps === undefined ||
    sourceIds === undefined
  ) {
    return;
  }
  const base = {
    version,
    generatedAt,
    subjectKind,
    subjectId,
    ...(subjectLabel !== undefined ? { subjectLabel } : {}),
    subjectSummary,
    recentMaterialEvents,
    factLedger,
    openGaps,
    sourceIds,
  };
  if (subjectKind === "company") {
    if (symbol === undefined) {
      return;
    }
    return {
      ...base,
      subjectKind,
      symbol: symbol.toUpperCase(),
      ...(companyName !== undefined ? { companyName } : {}),
      questions: questions as WebSubjectProfileArtifact["questions"],
      ...(secFilingBasisDate !== undefined ? { secFilingBasisDate } : {}),
    } as WebSubjectProfileArtifact;
  }
  if (subjectKind === "crypto-asset") {
    if (symbol === undefined) {
      return;
    }
    return {
      ...base,
      subjectKind,
      symbol: symbol.toUpperCase(),
      questions: questions as WebSubjectProfileArtifact["questions"],
    } as WebSubjectProfileArtifact;
  }
  return {
    ...base,
    subjectKind,
    questions: questions as WebSubjectProfileArtifact["questions"],
  } as WebSubjectProfileArtifact;
}

function readSubjectKind(value: unknown): SubjectKind | undefined {
  return value === "company" || value === "crypto-asset" || value === "theme" ? value : undefined;
}

function hasSourceLedgerEntryShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isSourceKind(value.kind) &&
    isEvidenceLane(value.lane) &&
    value.posture === "covered" &&
    readStringArray(value, "relatedGapIds") !== undefined &&
    (value.provider === undefined || typeof value.provider === "string") &&
    (value.fetchedAt === undefined || typeof value.fetchedAt === "string") &&
    (value.observedAt === undefined || typeof value.observedAt === "string")
  );
}

export function readSourceLedger(value: unknown): SourceLedgerArtifact | undefined {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    readString(value, "generatedAt") === undefined ||
    !Array.isArray(value.sources) ||
    !value.sources.every(hasSourceLedgerEntryShape)
  ) {
    return;
  }
  return value as unknown as SourceLedgerArtifact;
}
