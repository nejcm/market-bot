import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  SOURCE_KINDS,
  isMarketRegimeLabel,
  type AssetClass,
  type ExtendedEvidence,
  type ExtendedEvidenceCategory,
  type ExtendedEvidenceItem,
  type Instrument,
  type InstrumentIdentity,
  type JobType,
  type KeyFinding,
  type MarketRegimeLabel,
  type MarketSnapshot,
  type Prediction,
  type PredictionKind,
  type ProviderInstrumentId,
  type ResearchReport,
  type Source,
  type SourceGap,
  type VerifiedMarketSnapshot,
} from "./domain/types";
import {
  isSourceGapCapability,
  isSourceGapCause,
  isSourceGapEvidenceQualityImpact,
} from "./domain/source-gaps";
import { renderClaimForMeasurableAs } from "./forecast/observable";
import { RUN_ARTIFACT_FILES } from "./run-artifact-layout";
import type {
  MissAutopsyCause,
  MissAutopsyEntry,
  PredictionScore,
  PredictionScoreStatus,
} from "./scoring/types";
import {
  EVIDENCE_LANES,
  type EvidenceLane,
  type EvidenceLanesArtifact,
  type LaneCoverageStatus,
  type LaneRequirement,
  type SourceLedgerArtifact,
  type SourcePlanArtifact,
} from "./research/source-plan";
import type { FinancialLensArtifact } from "./sources/extended-evidence/financial-lens";
import type {
  BusinessFrameworkArtifact,
  BusinessFrameworkPosture,
  BusinessFrameworkSectionName,
  BusinessLifecyclePhase,
} from "./sources/extended-evidence/business-framework";
import {
  isRecord,
  nonEmptyStringArrayValue,
  readNumber,
  readString,
  readStringArray,
  stringArrayValue,
} from "./sources/guards";

// ---------------------------------------------------------------------------
// Run Artifact reader — the single read seam for persisted research runs under
// MARKET_BOT_DATA_DIR/<run-id>/. Parses report.json, score.json, and normalized
// Market snapshots once, leniently, at full fidelity. Callers project down to
// What they need. Reading is intentionally tolerant: older artifacts predate the
// Current schema, and report/schema.ts only validates on write. See ADR 0016.
// ---------------------------------------------------------------------------

// Per-file load outcome. "absent" = the file is missing (ENOENT); "malformed" =
// Present but unreadable or wrong shape.
export type ArtifactFileStatus = "ok" | "malformed" | "absent";

// The Market Regime label in effect at forecast time, persisted on the report as
// `extras.marketRegime.label`. Read leniently: older artifacts and reports with
// Unreadable extras return undefined (treated as an "unknown" calibration bucket).
export function readReportMarketRegimeLabel(report: ResearchReport): MarketRegimeLabel | undefined {
  const regime = report.extras?.marketRegime;
  if (!isRecord(regime)) {
    return undefined;
  }
  return isMarketRegimeLabel(regime.label) ? regime.label : undefined;
}

export interface RunArtifactStatus {
  readonly report: ArtifactFileStatus;
  readonly score: ArtifactFileStatus;
}

// The parsed core of one run directory. Only produced when report.json loads
// (status.report === "ok"). History/alpha-specific files (supplemental
// Snapshots, SEC fundamentals, alpha validation) are read by their one caller,
// Not here.
export interface RunArtifact {
  readonly runDirName: string;
  readonly report: ResearchReport;
  readonly scores: readonly PredictionScore[];
  readonly missAutopsies: readonly MissAutopsyEntry[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly verifiedMarketSnapshot?: VerifiedMarketSnapshot;
  readonly sourcePlan?: SourcePlanArtifact;
  readonly evidenceLanes?: EvidenceLanesArtifact;
  readonly sourceLedger?: SourceLedgerArtifact;
  readonly financialLenses?: FinancialLensArtifact;
  readonly businessFramework?: BusinessFrameworkArtifact;
  readonly status: RunArtifactStatus;
}

// Status for every scanned directory, including those without a loadable report.
// Callers fold these into their own audit counts.
export interface RunScanEntry {
  readonly runDirName: string;
  readonly status: RunArtifactStatus;
}

export interface RunArtifactScan {
  // Report-"ok" runs only.
  readonly artifacts: readonly RunArtifact[];
  // One entry per scanned directory.
  readonly entries: readonly RunScanEntry[];
}

export interface LoadedRunArtifact {
  readonly artifact?: RunArtifact;
  readonly status: RunArtifactStatus;
}

interface JsonFileResult {
  readonly status: ArtifactFileStatus;
  readonly value?: unknown;
}

const PREDICTION_KINDS: ReadonlySet<string> = new Set<PredictionKind>([
  "direction",
  "relative",
  "volatility",
  "range",
  "macro",
  "iv",
  "earnings-direction",
  "earnings-move",
  "conditional",
]);

const MISS_AUTOPSY_CAUSES: ReadonlySet<string> = new Set<MissAutopsyCause>([
  "data_gap",
  "source_gap",
  "model_overconfidence",
  "insufficient_evidence",
]);
const EXTENDED_EVIDENCE_CATEGORIES: ReadonlySet<string> = new Set<ExtendedEvidenceCategory>([
  "sec-edgar",
  "valuation",
  "equity-events",
  "fred-macro",
  "options-iv",
  "on-chain",
  "financial-lens",
  "business-framework",
  "web-company-profile",
  "yahoo-fundamentals",
]);
const EVIDENCE_LANE_SET: ReadonlySet<string> = new Set(EVIDENCE_LANES);
const LANE_REQUIREMENTS: ReadonlySet<string> = new Set<LaneRequirement>(["required", "optional"]);
const LANE_COVERAGE_STATUSES: ReadonlySet<string> = new Set<LaneCoverageStatus>([
  "covered",
  "gap",
  "not-covered",
]);
const SOURCE_KIND_SET: ReadonlySet<Source["kind"]> = new Set(SOURCE_KINDS);

function isAssetClass(value: unknown): value is AssetClass {
  return value === "equity" || value === "crypto";
}

function isDepth(value: unknown): value is "brief" | "deep" {
  return value === "brief" || value === "deep";
}

function isJobType(value: unknown): value is JobType {
  return (
    value === "market-overview" ||
    value === "daily" ||
    value === "weekly" ||
    value === "equity" ||
    value === "crypto" ||
    value === "alpha-search" ||
    value === "research"
  );
}

function isPredictionKind(value: unknown): value is PredictionKind {
  return typeof value === "string" && PREDICTION_KINDS.has(value);
}

function isMissAutopsyCause(value: unknown): value is MissAutopsyCause {
  return typeof value === "string" && MISS_AUTOPSY_CAUSES.has(value);
}

function isExtendedEvidenceCategory(value: unknown): value is ExtendedEvidenceCategory {
  return typeof value === "string" && EXTENDED_EVIDENCE_CATEGORIES.has(value);
}

function isEvidenceLane(value: unknown): value is EvidenceLane {
  return typeof value === "string" && EVIDENCE_LANE_SET.has(value);
}

function isLaneRequirement(value: unknown): value is LaneRequirement {
  return typeof value === "string" && LANE_REQUIREMENTS.has(value);
}

function isLaneCoverageStatus(value: unknown): value is LaneCoverageStatus {
  return typeof value === "string" && LANE_COVERAGE_STATUSES.has(value);
}

function isSourceKind(value: unknown): value is Source["kind"] {
  return typeof value === "string" && SOURCE_KIND_SET.has(value as Source["kind"]);
}

// Distinguishes a missing file from a present-but-broken one: ENOENT returns
// "absent", any other failure (IO error, invalid JSON) returns "malformed".
async function readJsonFile(path: string): Promise<JsonFileResult> {
  try {
    const raw = await readFile(path, "utf8");
    try {
      return { status: "ok", value: JSON.parse(raw) as unknown };
    } catch {
      return { status: "malformed" };
    }
  } catch (error) {
    return isRecord(error) && error.code === "ENOENT"
      ? { status: "absent" }
      : { status: "malformed" };
  }
}

function readFindings(value: unknown): readonly KeyFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly KeyFinding[] => {
    if (!isRecord(item) || typeof item.text !== "string") {
      return [];
    }
    return [{ text: item.text, sourceIds: nonEmptyStringArrayValue(item.sourceIds) }];
  });
}

function readPredictions(value: unknown): readonly Prediction[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly Prediction[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !isPredictionKind(item.kind) ||
      typeof item.subject !== "string" ||
      typeof item.measurableAs !== "string" ||
      typeof item.horizonTradingDays !== "number" ||
      typeof item.probability !== "number"
    ) {
      return [];
    }
    const claim = renderClaimForMeasurableAs(
      item.measurableAs,
      typeof item.claim === "string" ? item.claim : undefined,
    );
    if (claim === undefined) {
      return [];
    }
    return [
      {
        id: item.id,
        claim,
        kind: item.kind,
        subject: item.subject,
        measurableAs: item.measurableAs,
        horizonTradingDays: item.horizonTradingDays,
        probability: item.probability,
        sourceIds: nonEmptyStringArrayValue(item.sourceIds),
      },
    ];
  });
}

function readSources(value: unknown): readonly Source[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly Source[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.fetchedAt !== "string" ||
      typeof item.kind !== "string"
    ) {
      return [];
    }
    return [item as unknown as Source];
  });
}

function readInstrument(value: unknown): Instrument | undefined {
  if (!isRecord(value) || typeof value.symbol !== "string" || !isAssetClass(value.assetClass)) {
    return;
  }
  const identity = readInstrumentIdentity(value.identity);
  return {
    symbol: value.symbol.toUpperCase(),
    assetClass: value.assetClass,
    ...(identity !== undefined ? { identity } : {}),
  };
}

function readProviderInstrumentIds(value: unknown): readonly ProviderInstrumentId[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly ProviderInstrumentId[] => {
    if (
      !isRecord(item) ||
      typeof item.provider !== "string" ||
      typeof item.idKind !== "string" ||
      typeof item.value !== "string"
    ) {
      return [];
    }
    return [{ provider: item.provider, idKind: item.idKind, value: item.value }];
  });
}

function readInstrumentIdentity(value: unknown): InstrumentIdentity | undefined {
  if (!isRecord(value)) {
    return;
  }
  const exchange = readString(value, "exchange");
  const quoteCurrency = readString(value, "quoteCurrency");
  const displayName = readString(value, "displayName");
  const providerIds = readProviderInstrumentIds(value.providerIds);
  const aliases = readProviderInstrumentIds(value.aliases);
  if (
    exchange === undefined &&
    quoteCurrency === undefined &&
    displayName === undefined &&
    providerIds.length === 0 &&
    aliases.length === 0
  ) {
    return;
  }
  return {
    ...(exchange !== undefined ? { exchange } : {}),
    ...(quoteCurrency !== undefined ? { quoteCurrency } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(providerIds.length > 0 ? { providerIds } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

function readSourceGaps(value: unknown): readonly SourceGap[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly SourceGap[] => {
    if (!isRecord(item) || typeof item.source !== "string" || typeof item.message !== "string") {
      return [];
    }
    const capability = isSourceGapCapability(item.capability) ? item.capability : undefined;
    const cause = isSourceGapCause(item.cause) ? item.cause : undefined;
    const evidenceQualityImpact = isSourceGapEvidenceQualityImpact(item.evidenceQualityImpact)
      ? item.evidenceQualityImpact
      : undefined;
    return [
      {
        source: item.source,
        message: item.message,
        ...(typeof item.provider === "string" ? { provider: item.provider } : {}),
        ...(capability !== undefined ? { capability } : {}),
        ...(cause !== undefined ? { cause } : {}),
        ...(evidenceQualityImpact !== undefined ? { evidenceQualityImpact } : {}),
      },
    ];
  });
}

function readExtendedEvidenceItems(value: unknown): readonly ExtendedEvidenceItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly ExtendedEvidenceItem[] => {
    if (
      !isRecord(item) ||
      !isExtendedEvidenceCategory(item.category) ||
      typeof item.title !== "string" ||
      typeof item.summary !== "string" ||
      typeof item.observedAt !== "string"
    ) {
      return [];
    }
    const metrics = readPrimitiveEvidence(item.metrics);
    const identity = readInstrumentIdentity(item.identity);
    return [
      {
        category: item.category,
        title: item.title,
        summary: item.summary,
        sourceIds: nonEmptyStringArrayValue(item.sourceIds),
        observedAt: item.observedAt,
        ...(metrics !== undefined ? { metrics } : {}),
        ...(identity !== undefined ? { identity } : {}),
      },
    ];
  });
}

function readExtendedEvidence(value: unknown): ExtendedEvidence | undefined {
  if (!isRecord(value)) {
    return;
  }
  const instrument = readInstrument(value.instrument);
  if (instrument === undefined) {
    return;
  }
  return {
    instrument,
    items: readExtendedEvidenceItems(value.items),
    gaps: readSourceGaps(value.gaps),
  };
}

function readReport(value: unknown): ResearchReport | undefined {
  if (!isRecord(value) || !isJobType(value.jobType) || !isAssetClass(value.assetClass)) {
    return;
  }
  const runId = readString(value, "runId");
  const generatedAt = readString(value, "generatedAt");
  if (runId === undefined || generatedAt === undefined) {
    return;
  }
  const extendedEvidence = readExtendedEvidence(value.extendedEvidence);
  return {
    runId,
    jobType: value.jobType,
    assetClass: value.assetClass,
    ...(typeof value.symbol === "string" ? { symbol: value.symbol.toUpperCase() } : {}),
    ...(typeof value.horizonTradingDays === "number"
      ? { horizonTradingDays: value.horizonTradingDays }
      : {}),
    generatedAt,
    summary: readString(value, "summary") ?? "",
    keyFindings: readFindings(value.keyFindings),
    bullCase: readFindings(value.bullCase),
    bearCase: readFindings(value.bearCase),
    risks: readFindings(value.risks),
    catalysts: readFindings(value.catalysts),
    scenarios: [],
    confidence:
      value.confidence === "high" || value.confidence === "medium" || value.confidence === "low"
        ? value.confidence
        : "low",
    dataGaps: stringArrayValue(value.dataGaps),
    predictions: readPredictions(value.predictions),
    sources: readSources(value.sources),
    ...(extendedEvidence !== undefined ? { extendedEvidence } : {}),
    notFinancialAdvice: true,
    ...(isRecord(value.extras) ? { extras: value.extras } : {}),
  };
}

function readScores(value: unknown): readonly PredictionScore[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.scores)) {
    return;
  }
  return value.scores.flatMap((item): readonly PredictionScore[] => {
    if (
      !isRecord(item) ||
      typeof item.predictionId !== "string" ||
      typeof item.runId !== "string" ||
      typeof item.resolved !== "boolean" ||
      typeof item.attemptCount !== "number" ||
      !isRecord(item.evidence)
    ) {
      return [];
    }
    const status = readPredictionScoreStatus(item.status);
    return [
      {
        predictionId: item.predictionId,
        runId: item.runId,
        ...(status !== undefined ? { status } : {}),
        resolved: item.resolved,
        outcome: item.outcome === "hit" || item.outcome === "miss" ? item.outcome : undefined,
        observedAt: typeof item.observedAt === "string" ? item.observedAt : undefined,
        attemptCount: item.attemptCount,
        // Carried through at full fidelity so score-writing consumers (scoring/index.ts) can
        // Preserve the version stamped on already-resolved scores. Undefined for legacy files.
        ...(typeof item.scoringVersion === "number" ? { scoringVersion: item.scoringVersion } : {}),
        evidence: item.evidence,
      },
    ];
  });
}

function readPredictionScoreStatus(value: unknown): PredictionScoreStatus | undefined {
  return value === "pending" ||
    value === "pending-condition" ||
    value === "active-pending" ||
    value === "resolved" ||
    value === "voided" ||
    value === "abandoned"
    ? value
    : undefined;
}

function readPrimitiveEvidence(value: unknown): Record<string, number | string> | undefined {
  if (!isRecord(value)) {
    return;
  }
  const evidence: Record<string, number | string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && Number.isFinite(item)) {
      evidence[key] = item;
    } else if (typeof item === "string") {
      evidence[key] = item;
    }
  }
  return evidence;
}

function readMissAutopsies(value: unknown): readonly MissAutopsyEntry[] {
  if (!isRecord(value) || !Array.isArray(value.autopsies)) {
    return [];
  }
  return value.autopsies.flatMap((item): readonly MissAutopsyEntry[] => {
    if (
      !isRecord(item) ||
      typeof item.predictionId !== "string" ||
      typeof item.runId !== "string" ||
      typeof item.observedAt !== "string" ||
      (item.scoreOutcome !== "hit" && item.scoreOutcome !== "miss") ||
      typeof item.probability !== "number" ||
      (item.forecastError !== "overpredicted" && item.forecastError !== "underpredicted") ||
      !isMissAutopsyCause(item.cause) ||
      typeof item.rationale !== "string"
    ) {
      return [];
    }
    // An otherwise-valid entry with absent or non-object evidence keeps an empty
    // Evidence map rather than being dropped (the field is non-essential context).
    const evidence = readPrimitiveEvidence(item.evidence) ?? {};
    return [
      {
        predictionId: item.predictionId,
        runId: item.runId,
        observedAt: item.observedAt,
        scoreOutcome: item.scoreOutcome,
        probability: item.probability,
        forecastError: item.forecastError,
        cause: item.cause,
        rationale: item.rationale,
        supportingSignals: stringArrayValue(item.supportingSignals),
        evidence,
      },
    ];
  });
}

function readSnapshots(value: unknown): readonly MarketSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly MarketSnapshot[] => {
    if (
      !isRecord(item) ||
      typeof item.sourceId !== "string" ||
      !isAssetClass(item.assetClass) ||
      typeof item.symbol !== "string" ||
      typeof item.price !== "number" ||
      typeof item.changePercent24h !== "number" ||
      typeof item.volume !== "number" ||
      typeof item.observedAt !== "string"
    ) {
      return [];
    }
    return [item as unknown as MarketSnapshot];
  });
}

function readOhlcvBar(value: unknown): VerifiedMarketSnapshot["ohlcv"] | undefined {
  if (!isRecord(value)) {
    return;
  }
  const open = readNumber(value, "open");
  const high = readNumber(value, "high");
  const low = readNumber(value, "low");
  const close = readNumber(value, "close");
  const volume = readNumber(value, "volume");
  return typeof value.date === "string" &&
    open !== undefined &&
    high !== undefined &&
    low !== undefined &&
    close !== undefined &&
    volume !== undefined
    ? { date: value.date, open, high, low, close, volume }
    : undefined;
}

function readNullableIndicator(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readIndicators(value: unknown): VerifiedMarketSnapshot["indicators"] | undefined {
  if (!isRecord(value)) {
    return;
  }
  return {
    ema10: readNullableIndicator(value, "ema10"),
    sma50: readNullableIndicator(value, "sma50"),
    sma200: readNullableIndicator(value, "sma200"),
    rsi14: readNullableIndicator(value, "rsi14"),
    macd: readNullableIndicator(value, "macd"),
    macdSignal: readNullableIndicator(value, "macdSignal"),
    macdHistogram: readNullableIndicator(value, "macdHistogram"),
    bollUpper: readNullableIndicator(value, "bollUpper"),
    bollMiddle: readNullableIndicator(value, "bollMiddle"),
    bollLower: readNullableIndicator(value, "bollLower"),
    atr14: readNullableIndicator(value, "atr14"),
  };
}

function readRecentCloses(value: unknown): VerifiedMarketSnapshot["recentCloses"] | undefined {
  if (!Array.isArray(value)) {
    return;
  }
  const closes = value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const close = readNumber(entry, "close");
    return typeof entry.date === "string" && close !== undefined
      ? [{ date: entry.date, close }]
      : [];
  });
  return closes.length >= 2 ? closes : undefined;
}

function readVerifiedMarketSnapshot(value: unknown): VerifiedMarketSnapshot | undefined {
  if (!isRecord(value) || value.assetClass !== "equity" || typeof value.symbol !== "string") {
    return;
  }
  const analysisDate = readString(value, "analysisDate");
  const fetchedAt = readString(value, "fetchedAt");
  const latestSessionDate = readString(value, "latestSessionDate");
  const ohlcv = readOhlcvBar(value.ohlcv);
  const indicators = readIndicators(value.indicators);
  const recentCloses = readRecentCloses(value.recentCloses);
  return analysisDate === undefined ||
    fetchedAt === undefined ||
    latestSessionDate === undefined ||
    ohlcv === undefined ||
    indicators === undefined ||
    recentCloses === undefined
    ? undefined
    : {
        symbol: value.symbol.toUpperCase(),
        assetClass: "equity",
        analysisDate,
        fetchedAt,
        latestSessionDate,
        ohlcv,
        indicators,
        recentCloses,
      };
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
    isLaneRequirement(value.requirement) &&
    typeof value.appliesToRun === "boolean" &&
    typeof value.providerPath === "string"
  );
}

function readSourcePlan(value: unknown): SourcePlanArtifact | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
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
    readNumber(value, "requiredLaneCount") !== undefined &&
    readNumber(value, "optionalLaneCount") !== undefined &&
    readNumber(value, "coveredLaneCount") !== undefined &&
    readNumber(value, "gapLaneCount") !== undefined &&
    readNumber(value, "requiredGapLaneCount") !== undefined &&
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
    typeof value.required === "boolean" &&
    readStringArray(value, "coveredSourceIds") !== undefined &&
    readStringArray(value, "gapIds") !== undefined &&
    readStringArray(value, "gapText") !== undefined &&
    readStringArray(value, "freshnessNotes") !== undefined
  );
}

function readEvidenceLanes(value: unknown): EvidenceLanesArtifact | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
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
const BUSINESS_FRAMEWORK_SECTION_NAMES: ReadonlySet<string> = new Set<BusinessFrameworkSectionName>(
  ["Business", "Phase", "Moat", "Growth", "Management", "Risk", "Valuation"],
);
const BUSINESS_FRAMEWORK_PHASES: ReadonlySet<string> = new Set<BusinessLifecyclePhase>([
  "startup",
  "hyper-growth",
  "operating-leverage",
  "capital-return",
  "decline",
]);
const BUSINESS_FRAMEWORK_POSTURES: ReadonlySet<string> = new Set<BusinessFrameworkPosture>([
  "criteria-supported",
  "criteria-mixed",
  "criteria-not-supported",
  "insufficient-data",
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
    (value.currency === undefined || typeof value.currency === "string")
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
    readStringArray(value, "sourceIds") !== undefined
  );
}

// Reads the structured financial-lenses.json artifact so the console can render
// Lens tiles dynamically from lenses[].metrics[] (label/value/unit) instead of a
// Hardcoded key list. Returns undefined when the file is absent or malformed.
function readFinancialLensesArtifact(value: unknown): FinancialLensArtifact | undefined {
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

function hasBusinessFrameworkSectionShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    BUSINESS_FRAMEWORK_SECTION_NAMES.has(value.name) &&
    typeof value.posture === "string" &&
    BUSINESS_FRAMEWORK_POSTURES.has(value.posture) &&
    typeof value.summary === "string" &&
    Array.isArray(value.metrics) &&
    value.metrics.every(hasFinancialLensMetricShape) &&
    readStringArray(value, "sourceIds") !== undefined &&
    readStringArray(value, "gaps") !== undefined
  );
}

function readBusinessFrameworkArtifact(value: unknown): BusinessFrameworkArtifact | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    readString(value, "generatedAt") === undefined ||
    readString(value, "symbol") === undefined ||
    typeof value.phase !== "string" ||
    !BUSINESS_FRAMEWORK_PHASES.has(value.phase) ||
    !Array.isArray(value.sections) ||
    !value.sections.every(hasBusinessFrameworkSectionShape) ||
    readStringArray(value, "sourceIds") === undefined ||
    readStringArray(value, "gaps") === undefined
  ) {
    return undefined;
  }
  return value as unknown as BusinessFrameworkArtifact;
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

function readSourceLedger(value: unknown): SourceLedgerArtifact | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    readString(value, "generatedAt") === undefined ||
    !Array.isArray(value.sources) ||
    !value.sources.every(hasSourceLedgerEntryShape)
  ) {
    return;
  }
  return value as unknown as SourceLedgerArtifact;
}

function scoreStatusFor(
  file: JsonFileResult,
  parsed: readonly PredictionScore[] | undefined,
): ArtifactFileStatus {
  if (file.status === "absent") {
    return "absent";
  }
  return parsed === undefined ? "malformed" : "ok";
}

const REPORT_FILE = RUN_ARTIFACT_FILES.report;
const SCORE_FILE = RUN_ARTIFACT_FILES.score;
const MISS_AUTOPSY_FILE = RUN_ARTIFACT_FILES.missAutopsy;
const MARKET_SNAPSHOTS_FILE = RUN_ARTIFACT_FILES.marketSnapshots;
const VERIFIED_MARKET_SNAPSHOT_FILE = RUN_ARTIFACT_FILES.verifiedMarketSnapshot;
const SOURCE_PLAN_FILE = RUN_ARTIFACT_FILES.sourcePlan;
const EVIDENCE_LANES_FILE = RUN_ARTIFACT_FILES.evidenceLanes;
const SOURCE_LEDGER_FILE = RUN_ARTIFACT_FILES.sourceLedger;
const FINANCIAL_LENSES_FILE = RUN_ARTIFACT_FILES.financialLenses;
const BUSINESS_FRAMEWORK_FILE = RUN_ARTIFACT_FILES.businessFramework;

// Reads one run directory. Returns an artifact only when report.json loads to a
// Valid report; score.json is read only in that case (matching the historical
// Short-circuit so audit counts stay stable).
export async function loadRunArtifact(runDir: string): Promise<LoadedRunArtifact> {
  const runDirName = basename(runDir);
  const reportFile = await readJsonFile(join(runDir, REPORT_FILE));
  const report = reportFile.status === "ok" ? readReport(reportFile.value) : undefined;
  if (report === undefined) {
    // ENOENT stays "absent"; a present-but-bad report becomes "malformed".
    const reportStatus: ArtifactFileStatus =
      reportFile.status === "absent" ? "absent" : "malformed";
    return { status: { report: reportStatus, score: "absent" } };
  }

  const scoreFile = await readJsonFile(join(runDir, SCORE_FILE));
  const parsedScores = scoreFile.status === "ok" ? readScores(scoreFile.value) : undefined;
  const missAutopsyFile = await readJsonFile(join(runDir, MISS_AUTOPSY_FILE));
  const snapshotFile = await readJsonFile(join(runDir, MARKET_SNAPSHOTS_FILE));
  const verifiedSnapshotFile = await readJsonFile(join(runDir, VERIFIED_MARKET_SNAPSHOT_FILE));
  const sourcePlanFile = await readJsonFile(join(runDir, SOURCE_PLAN_FILE));
  const evidenceLanesFile = await readJsonFile(join(runDir, EVIDENCE_LANES_FILE));
  const sourceLedgerFile = await readJsonFile(join(runDir, SOURCE_LEDGER_FILE));
  const financialLensesFile = await readJsonFile(join(runDir, FINANCIAL_LENSES_FILE));
  const businessFrameworkFile = await readJsonFile(join(runDir, BUSINESS_FRAMEWORK_FILE));
  const status: RunArtifactStatus = {
    report: "ok",
    score: scoreStatusFor(scoreFile, parsedScores),
  };
  const verifiedMarketSnapshot =
    verifiedSnapshotFile.status === "ok"
      ? readVerifiedMarketSnapshot(verifiedSnapshotFile.value)
      : undefined;
  const sourcePlan =
    sourcePlanFile.status === "ok" ? readSourcePlan(sourcePlanFile.value) : undefined;
  const evidenceLanes =
    evidenceLanesFile.status === "ok" ? readEvidenceLanes(evidenceLanesFile.value) : undefined;
  const sourceLedger =
    sourceLedgerFile.status === "ok" ? readSourceLedger(sourceLedgerFile.value) : undefined;
  const financialLenses =
    financialLensesFile.status === "ok"
      ? readFinancialLensesArtifact(financialLensesFile.value)
      : undefined;
  const businessFramework =
    businessFrameworkFile.status === "ok"
      ? readBusinessFrameworkArtifact(businessFrameworkFile.value)
      : undefined;

  return {
    artifact: {
      runDirName,
      report,
      scores: parsedScores ?? [],
      missAutopsies: readMissAutopsies(missAutopsyFile.value),
      marketSnapshots: readSnapshots(snapshotFile.value),
      ...(verifiedMarketSnapshot !== undefined ? { verifiedMarketSnapshot } : {}),
      ...(sourcePlan !== undefined ? { sourcePlan } : {}),
      ...(evidenceLanes !== undefined ? { evidenceLanes } : {}),
      ...(sourceLedger !== undefined ? { sourceLedger } : {}),
      ...(financialLenses !== undefined ? { financialLenses } : {}),
      ...(businessFramework !== undefined ? { businessFramework } : {}),
      status,
    },
    status,
  };
}

// Scans every run directory under dataDir in one pass. A missing dataDir yields
// An empty scan.
export async function scanRunArtifactsFromDisk(dataDir: string): Promise<RunArtifactScan> {
  const dirEntries = await readdir(dataDir, { withFileTypes: true }).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return [] as Dirent[];
    }
    throw error;
  });

  const dirs = dirEntries.filter((entry) => entry.isDirectory());
  const loaded = await Promise.all(
    dirs.map(async (entry) => ({
      name: entry.name,
      result: await loadRunArtifact(join(dataDir, entry.name)),
    })),
  );

  return {
    artifacts: loaded.flatMap((item) =>
      item.result.artifact === undefined ? [] : [item.result.artifact],
    ),
    entries: loaded.map((item) => ({ runDirName: item.name, status: item.result.status })),
  };
}

// Full artifact scans always read from disk until the index can hydrate RunArtifact payloads.
export async function scanRunArtifacts(dataDir: string): Promise<RunArtifactScan> {
  return await scanRunArtifactsFromDisk(dataDir);
}
