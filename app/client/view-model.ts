import type {
  AlphaCohortDetail,
  CalibrationDetail,
  ProviderHealthDetail,
  RunDetail,
  RunSearchResult,
  RunSummary,
} from "../types";
import { MIN_CALIBRATION_SAMPLE } from "../../src/scoring/calibration";
import { formatLensValue } from "../../src/sources/extended-evidence/value-format";
import type {
  BusinessFrameworkArtifact,
  BusinessFrameworkMetric,
  BusinessFrameworkPosture,
  BusinessFrameworkSectionName,
  BusinessLifecyclePhase,
} from "../../src/sources/extended-evidence/business-framework";
import type { WebSubjectProfileArtifact } from "../../src/sources/extended-evidence/web-subject-profile";
import type {
  FinancialLensArtifact,
  FinancialLensMetric,
  FinancialLensName,
} from "../../src/sources/extended-evidence/financial-lens";
import { RUN_ARTIFACT_FILES } from "../../src/run-artifact-layout";

export {
  extendedEvidenceItems,
  forecastDisagreements,
  forecastGroups,
  forecastRollup,
  missAutopsies,
  predictionScores,
  predictionTargetHealth,
  predictions,
  scenarios,
  scoredForecasts,
  sources,
  formatShortfallGap,
  splitDataGaps,
  stringArray,
  textItems,
} from "../report-artifact-view";
export type {
  ExtendedEvidenceItemView,
  ForecastRollup,
  ForecastDisagreementView,
  ForecastGroup,
  MissAutopsyView,
  PredictionScoreView,
  PredictionTargetHealth,
  ScoredForecast,
  SplitDataGaps,
} from "../report-artifact-view";

const RUN_PATH_PREFIX = "/runs/";
const INSTRUMENT_PATH_PREFIX = "/instruments/";
const RECENT_RUN_LIMIT = 5;
const RUN_TYPE_ORDER = ["market-overview", "daily", "weekly", "equity", "crypto"];
const PROVIDER_GAP_KEYS = ["missingCredential", "fetchFailed", "yahooAuth", "other"];

export interface SearchResultGroup {
  readonly run: RunSummary;
  readonly results: readonly RunSearchResult[];
}

export interface RunTypeGroup {
  readonly type: string;
  readonly runs: readonly RunSummary[];
}

export interface DashboardMetrics {
  readonly totalRuns: number;
  readonly totalSources: number;
  readonly totalForecasts: number;
  readonly totalDataGaps: number;
  readonly scoredRuns: number;
  readonly equityRuns: number;
  readonly cryptoRuns: number;
  readonly averageConfidence: string;
}

export interface ProviderHealthRow {
  readonly provider: string;
  readonly route: string;
  readonly degraded: boolean;
  readonly total: number;
  readonly gaps: number;
  readonly note: string;
}

export interface RunTrendPoint {
  readonly date: string;
  readonly runs: number;
  readonly forecasts: number;
  readonly sources: number;
  readonly dataGaps: number;
}

export interface CalibrationHeadline {
  readonly brierScore?: number;
  readonly brierSkillScore?: number;
  readonly resolvedCount: number;
  readonly generatedAt?: string;
}

export interface CalibrationSampleWarning {
  readonly show: boolean;
  readonly resolvedCount: number;
  readonly minimum: number;
}

export interface ValuationMetricTile {
  readonly label: string;
  readonly value: string;
}

export type FinancialLensStatTone = "strong" | "healthy" | "watch" | "weak" | "neutral";

export interface FinancialLensStatTile extends ValuationMetricTile {
  readonly key: string;
  readonly lens: FinancialLensName;
  readonly tone: FinancialLensStatTone;
  readonly assessment?: "Strong" | "Healthy" | "Watch" | "Weak";
}

export interface BusinessFrameworkMetricTile extends ValuationMetricTile {
  readonly key: string;
  readonly sourceIds: readonly string[];
}

export interface BusinessFrameworkSectionView {
  readonly name: BusinessFrameworkSectionName;
  readonly posture: BusinessFrameworkPosture;
  readonly summary: string;
  readonly text?: string;
  readonly metrics: readonly BusinessFrameworkMetricTile[];
  readonly sourceIds: readonly string[];
  readonly gaps: readonly string[];
}

export interface BusinessFrameworkView {
  readonly phase: BusinessLifecyclePhase;
  readonly sections: readonly BusinessFrameworkSectionView[];
  readonly sourceIds: readonly string[];
  readonly gaps: readonly string[];
}

export interface WebSubjectProfileQuestionView {
  readonly key: string;
  readonly label: string;
  readonly answer: string;
  readonly sourceIds: readonly string[];
}

export interface WebSubjectProfileFactView {
  readonly claim: string;
  readonly sourceIds: readonly string[];
}

export interface WebSubjectProfileView {
  readonly subjectKind?: string;
  readonly subjectLabel?: string;
  readonly subjectSummary?: WebSubjectProfileQuestionView;
  readonly generatedAt?: string;
  readonly questions: readonly WebSubjectProfileQuestionView[];
  readonly recentMaterialEvents: readonly WebSubjectProfileFactView[];
  readonly factLedger: readonly WebSubjectProfileFactView[];
  readonly openGaps: readonly string[];
  readonly sourceIds: readonly string[];
}

export interface ReliabilityBin {
  readonly label: string;
  readonly pLow: number;
  readonly pHigh: number;
  readonly hitRate: number;
  readonly hitCount: number;
  readonly totalCount: number;
}

export interface CalibrationSliceRow {
  readonly key: string;
  readonly brierScore: number;
  readonly count: number;
}

export interface CalibrationAutopsyCauseRow {
  readonly cause: string;
  readonly count: number;
}

export interface RunCompareCard {
  readonly runId: string;
  readonly label: string;
  readonly generatedAt: string;
  readonly forecasts: string;
  readonly targetMet: boolean;
  readonly shortfall: string;
  readonly calibration: string;
  readonly snapshotFreshness: string;
}

export interface HistoricalContextAuditView {
  readonly scannedRunCount: number;
  readonly candidateRunCount: number;
  readonly selectedRunCount: number;
  readonly recentSelectedCount: number;
  readonly anchorSelectedCount: number;
  readonly sameSymbolSelectedCount: number;
  readonly spotlightSymbolSelectedCount: number;
  readonly sameSubjectSelectedCount: number;
  readonly sameHorizonSelectedCount: number;
  readonly crossHorizonSelectedCount: number;
  readonly resolvedMissRunCount: number;
  readonly missCorrectionSelectedCount: number;
  readonly gapCount: number;
}

export interface AlphaCohortHeadline {
  readonly generatedAt?: string;
  readonly rejectedCandidateCount: number;
  readonly watchlistCandidateCount: number;
  readonly tickerBriefedLeadCount: number;
  readonly unbriefedLeadCount: number;
}

export interface AlphaRejectionBucketRow {
  readonly reason: string;
  readonly rejectedCount: number;
  readonly uniqueSymbolCount: number;
  readonly laterValidatedSymbolCount: number;
  readonly validation: string;
}

export interface AlphaStaleLeadRow {
  readonly ageBucket: string;
  readonly unbriefedLeadCount: number;
  readonly validation: string;
}

export type CalibrationSliceGroup =
  | "byKind"
  | "byAssetClass"
  | "byJobType"
  | "byMarketUpdateHorizonBucket"
  | "byHorizonBucket"
  | "byMarketRegime";

const HORIZON_BUCKET_ORDER = ["1-5d", "6-10d", "11-15d", "16-20d"];

export function calibrationHeadline(detail: CalibrationDetail): CalibrationHeadline {
  const summary = detail.summary ?? {};
  const brierScore = readFiniteNumber(summary.brierScore);
  const brierSkillScore = readFiniteNumber(summary.brierSkillScore);
  const generatedAt = typeof summary.generatedAt === "string" ? summary.generatedAt : undefined;
  return {
    ...(brierScore !== undefined ? { brierScore } : {}),
    ...(brierSkillScore !== undefined ? { brierSkillScore } : {}),
    resolvedCount: readFiniteNumber(summary.resolvedCount) ?? 0,
    ...(generatedAt !== undefined ? { generatedAt } : {}),
  };
}

export function calibrationSampleWarning(headline: CalibrationHeadline): CalibrationSampleWarning {
  return {
    show: headline.resolvedCount < MIN_CALIBRATION_SAMPLE,
    resolvedCount: headline.resolvedCount,
    minimum: MIN_CALIBRATION_SAMPLE,
  };
}

export function formatUsdCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (abs >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toFixed(0)}`;
}

export function formatMultiple(value: number): string {
  return `${value.toFixed(1)}x`;
}

const VALUATION_METRIC_LABELS: Readonly<Record<string, string>> = {
  marketCap: "Market cap",
  enterpriseValue: "Enterprise value",
  annualizedRevenue: "Annualized revenue",
  evToAnnualizedRevenue: "EV / annualized revenue",
  revenuePeriodMonths: "Revenue period (months)",
  corePeerCount: "Core peers",
  peerMedianEvToAnnualizedRevenue: "Peer median EV / annualized revenue",
  peerP25EvToAnnualizedRevenue: "Peer P25 EV / annualized revenue",
  peerP75EvToAnnualizedRevenue: "Peer P75 EV / annualized revenue",
  valuationSupportability: "Supportability",
};

export function valuationMetricTiles(
  metrics: Readonly<Record<string, number | string>> | undefined,
): readonly ValuationMetricTile[] {
  if (metrics === undefined) {
    return [];
  }

  const keys = [
    "marketCap",
    "enterpriseValue",
    "annualizedRevenue",
    "evToAnnualizedRevenue",
    "revenuePeriodMonths",
    "corePeerCount",
    "peerMedianEvToAnnualizedRevenue",
    "peerP25EvToAnnualizedRevenue",
    "peerP75EvToAnnualizedRevenue",
    "valuationSupportability",
  ] as const;

  return keys.flatMap((key) => {
    const raw = metrics[key];
    const label = VALUATION_METRIC_LABELS[key] ?? key;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      if (
        key === "evToAnnualizedRevenue" ||
        key === "peerMedianEvToAnnualizedRevenue" ||
        key === "peerP25EvToAnnualizedRevenue" ||
        key === "peerP75EvToAnnualizedRevenue"
      ) {
        return [{ label, value: formatMultiple(raw) }];
      }
      if (key === "revenuePeriodMonths" || key === "corePeerCount") {
        return [{ label, value: String(raw) }];
      }
      return [{ label, value: formatUsdCompact(raw) }];
    }
    if (key === "valuationSupportability" && typeof raw === "string") {
      return [{ label, value: raw }];
    }
    return [];
  });
}

function formatPosture(value: string): string {
  return value.replaceAll("-", " ");
}

// Renders financial-lens tiles dynamically from the structured artifact's
// Lenses[].metrics[] (label/value/unit) instead of a hardcoded key list. For each
// Lens a posture tile is emitted first, then every metric the artifact carries,
// Formatted via the shared value-format module so server summary and client tiles
// Stay identical. Metrics absent from the artifact are absent from the grid
// (sparse for non-US, rich for US). See plan Q7 / revision 5.
export function financialLensMetricTiles(
  artifact?: FinancialLensArtifact,
): readonly ValuationMetricTile[] {
  if (artifact === undefined) {
    return [];
  }
  return artifact.lenses.flatMap((lens) => {
    const postureTile: ValuationMetricTile = {
      label: lens.name,
      value: formatPosture(lens.posture),
    };
    const metricTiles = lens.metrics.map((metric): ValuationMetricTile => {
      const value =
        typeof metric.value === "string"
          ? metric.value
          : formatLensValue(metric.value, metric.unit, metric.currency);
      return { label: metric.label, value };
    });
    return [postureTile, ...metricTiles];
  });
}

function assessment(
  value: number,
  strong: (input: number) => boolean,
  healthy: (input: number) => boolean,
  watch: (input: number) => boolean,
): Pick<FinancialLensStatTile, "tone" | "assessment"> {
  if (strong(value)) {
    return { tone: "strong", assessment: "Strong" };
  }
  if (healthy(value)) {
    return { tone: "healthy", assessment: "Healthy" };
  }
  if (watch(value)) {
    return { tone: "watch", assessment: "Watch" };
  }
  return { tone: "weak", assessment: "Weak" };
}

function assessFinancialLensMetric(
  metric: FinancialLensMetric,
): Pick<FinancialLensStatTile, "tone" | "assessment"> {
  const { key, value: rawValue } = metric;
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
    if (key === "valuationSupportability") {
      if (rawValue === "supported") {
        return { tone: "strong", assessment: "Strong" };
      }
      if (rawValue === "screening-only") {
        return { tone: "watch", assessment: "Watch" };
      }
      if (rawValue === "not-supportable") {
        return { tone: "weak", assessment: "Weak" };
      }
    }
    return { tone: "neutral" };
  }

  switch (key) {
    case "grossMargin": {
      return assessment(
        rawValue,
        (v) => v >= 0.4,
        (v) => v >= 0.3,
        (v) => v >= 0.2,
      );
    }
    case "operatingMargin": {
      return assessment(
        rawValue,
        (v) => v >= 0.15,
        (v) => v >= 0.1,
        (v) => v >= 0.05,
      );
    }
    case "netMargin": {
      return assessment(
        rawValue,
        (v) => v >= 0.1,
        (v) => v >= 0.06,
        (v) => v >= 0.03,
      );
    }
    case "cashConversion": {
      return assessment(
        rawValue,
        (v) => v >= 1,
        (v) => v >= 0.75,
        (v) => v >= 0.5,
      );
    }
    case "roe": {
      return assessment(
        rawValue,
        (v) => v >= 0.15,
        (v) => v >= 0.1,
        (v) => v >= 0.05,
      );
    }
    case "roa": {
      return assessment(
        rawValue,
        (v) => v >= 0.07,
        (v) => v >= 0.04,
        (v) => v >= 0.02,
      );
    }
    case "revenueDeltaPercent":
    case "grossProfitDeltaPercent":
    case "operatingIncomeDeltaPercent":
    case "netIncomeDeltaPercent":
    case "dilutedEpsDeltaPercent":
    case "operatingCashFlowDeltaPercent": {
      return assessment(
        rawValue,
        (v) => v >= 10,
        (v) => v >= 3,
        (v) => v >= 0,
      );
    }
    case "debtToMarketCap":
    case "netDebtToMarketCap": {
      return assessment(
        rawValue,
        (v) => v <= 0.25,
        (v) => v <= 0.4,
        (v) => v <= 0.5,
      );
    }
    case "currentRatio": {
      return assessment(
        rawValue,
        (v) => v >= 1.5 && v <= 3,
        (v) => v >= 1.2 && v <= 4,
        (v) => v >= 1 && v <= 4,
      );
    }
    case "debtToEquity": {
      return assessment(
        rawValue,
        (v) => v <= 0.5,
        (v) => v <= 1,
        (v) => v <= 1.5,
      );
    }
    case "payoutRatio": {
      return assessment(
        rawValue,
        (v) => v >= 0 && v <= 0.6,
        (v) => v >= 0 && v <= 0.75,
        (v) => v >= 0 && v <= 0.8,
      );
    }
    case "evToAnnualizedRevenue":
    case "marketCapToAnnualizedRevenue": {
      return assessment(
        rawValue,
        (v) => v > 0 && v <= 3,
        (v) => v > 0 && v <= 5,
        (v) => v > 0 && v <= 8,
      );
    }
    case "peRatio":
    case "forwardPe":
    case "pcfRatio": {
      return assessment(
        rawValue,
        (v) => v > 0 && v <= 15,
        (v) => v > 0 && v <= 20,
        (v) => v > 0 && v <= 25,
      );
    }
    case "priceToBook": {
      return assessment(
        rawValue,
        (v) => v > 0 && v <= 3,
        (v) => v > 0 && v <= 4.5,
        (v) => v > 0 && v <= 6,
      );
    }
    case "rsi14": {
      return assessment(
        rawValue,
        (v) => v >= 40 && v <= 70,
        (v) => (v >= 30 && v < 40) || (v > 70 && v <= 80),
        (v) => (v >= 20 && v < 30) || (v > 80 && v <= 90),
      );
    }
    case "macdHistogram": {
      return assessment(
        rawValue,
        (v) => v >= 0,
        (v) => v > -0.25,
        (v) => v > -0.5,
      );
    }
    default: {
      return { tone: "neutral" };
    }
  }
}

export function financialLensStatTiles(
  artifact?: FinancialLensArtifact,
): readonly FinancialLensStatTile[] {
  if (artifact === undefined) {
    return [];
  }
  return artifact.lenses.flatMap((lens) =>
    lens.metrics.map((metric): FinancialLensStatTile => {
      const value =
        typeof metric.value === "string"
          ? metric.value
          : formatLensValue(metric.value, metric.unit, metric.currency);
      return {
        key: metric.key,
        lens: lens.name,
        label: metric.label,
        value,
        ...assessFinancialLensMetric(metric),
      };
    }),
  );
}

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
const BUSINESS_FRAMEWORK_UNITS: ReadonlySet<string> = new Set<BusinessFrameworkMetric["unit"]>([
  "ratio",
  "ratio-percent",
  "whole-percent",
  "currency",
  "number",
  "text",
]);

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function businessFrameworkMetricTile(value: unknown): BusinessFrameworkMetricTile | undefined {
  const record = readRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const key = readStringField(record, "key");
  const label = readStringField(record, "label");
  const unit = readStringField(record, "unit");
  const raw = record.value;
  if (
    key === undefined ||
    label === undefined ||
    unit === undefined ||
    !BUSINESS_FRAMEWORK_UNITS.has(unit) ||
    (typeof raw !== "number" && typeof raw !== "string")
  ) {
    return undefined;
  }
  const currency = readStringField(record, "currency");
  const typedUnit = unit as BusinessFrameworkMetric["unit"];
  return {
    key,
    label,
    value: typeof raw === "string" ? raw : formatLensValue(raw, typedUnit, currency),
    sourceIds: stringArray(record.sourceIds),
  };
}

function businessFrameworkFromValue(value: unknown): BusinessFrameworkView | undefined {
  const record = readRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const phase = readStringField(record, "phase");
  if (phase === undefined || !BUSINESS_FRAMEWORK_PHASES.has(phase)) {
    return undefined;
  }
  const typedPhase = phase as BusinessLifecyclePhase;
  const rawSections = Array.isArray(record.sections) ? record.sections : [];
  const sections = rawSections.flatMap((item): readonly BusinessFrameworkSectionView[] => {
    const section = readRecord(item);
    if (section === undefined) {
      return [];
    }
    const name = readStringField(section, "name");
    const posture = readStringField(section, "posture");
    const summary = readStringField(section, "summary");
    if (
      name === undefined ||
      posture === undefined ||
      summary === undefined ||
      !BUSINESS_FRAMEWORK_SECTION_NAMES.has(name) ||
      !BUSINESS_FRAMEWORK_POSTURES.has(posture)
    ) {
      return [];
    }
    const typedName = name as BusinessFrameworkSectionName;
    const typedPosture = posture as BusinessFrameworkPosture;
    const text = readStringField(section, "text");
    const metrics = Array.isArray(section.metrics)
      ? section.metrics.flatMap((metric) => {
          const tile = businessFrameworkMetricTile(metric);
          return tile === undefined ? [] : [tile];
        })
      : [];
    return [
      {
        name: typedName,
        posture: typedPosture,
        summary,
        ...(text !== undefined ? { text } : {}),
        metrics,
        sourceIds: stringArray(section.sourceIds),
        gaps: businessFrameworkGapTexts(section.gaps),
      },
    ];
  });
  return {
    phase: typedPhase,
    sections,
    sourceIds: stringArray(record.sourceIds),
    gaps: businessFrameworkGapTexts(record.gaps),
  };
}

function businessFrameworkGapTexts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((gap) => {
    if (typeof gap === "string") {
      return [gap];
    }
    const record = readRecord(gap);
    const text = record === undefined ? undefined : readStringField(record, "text");
    return text === undefined ? [] : [text];
  });
}

export function businessFrameworkView(
  report: Record<string, unknown> | undefined,
  artifact?: BusinessFrameworkArtifact,
): BusinessFrameworkView | undefined {
  const extras = readRecord(report?.extras);
  return (
    businessFrameworkFromValue(extras?.businessFramework) ?? businessFrameworkFromValue(artifact)
  );
}

const WEB_SUBJECT_PROFILE_QUESTIONS: Readonly<Record<string, readonly [string, string][]>> = {
  company: [
    ["whatItDoes", "What it does"],
    ["howItMakesMoney", "How it makes money"],
    ["customers", "Customers"],
    ["geography", "Geography"],
    ["purchaseRecurrence", "Purchase recurrence"],
    ["pricingPower", "Pricing power"],
    ["recessionCyclicality", "Recession cyclicality"],
    ["managementTrackRecord", "Management track record"],
    ["capitalAllocation", "Capital allocation"],
    ["companyKpis", "Company-specific KPIs"],
    ["riskFactors", "Disclosed risk factors"],
  ],
  "crypto-asset": [
    ["whatItDoes", "What it does"],
    ["valueAccrual", "Value accrual"],
    ["supplyIssuance", "Supply and issuance"],
    ["usageAdoption", "Usage and adoption"],
    ["governanceBuilders", "Governance and builders"],
    ["competitionMoat", "Competition and moat"],
    ["keyRisks", "Key risks"],
  ],
  theme: [
    ["whatItIs", "What it is"],
    ["whyNow", "Why now"],
    ["beneficiaries", "Beneficiaries"],
    ["headwinds", "Headwinds"],
    ["keyDebates", "Key debates"],
    ["howItPlaysOut", "How it plays out"],
  ],
};

function webProfileFacts(value: unknown): readonly WebSubjectProfileFactView[] {
  return Array.isArray(value)
    ? value.flatMap((item): readonly WebSubjectProfileFactView[] => {
        const record = readRecord(item);
        const claim = readStringField(record, "claim");
        const sourceIds = stringArray(record?.sourceIds);
        return claim === undefined || sourceIds.length === 0 ? [] : [{ claim, sourceIds }];
      })
    : [];
}

function webSubjectProfileFromValue(value: unknown): WebSubjectProfileView | undefined {
  const record = readRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const rawQuestions = readRecord(record.questions);
  const subjectKind = readStringField(record, "subjectKind");
  const labels =
    WEB_SUBJECT_PROFILE_QUESTIONS[subjectKind ?? "company"] ??
    WEB_SUBJECT_PROFILE_QUESTIONS.company ??
    [];
  const questions =
    rawQuestions === undefined
      ? []
      : labels.flatMap(([key, label]): readonly WebSubjectProfileQuestionView[] => {
          const question = readRecord(rawQuestions[key]);
          const answer = readStringField(question, "answer");
          const sourceIds = stringArray(question?.sourceIds);
          return answer === undefined || answer === "" || sourceIds.length === 0
            ? []
            : [{ key, label, answer, sourceIds }];
        });
  const rawSummary = readRecord(record.subjectSummary);
  const summaryAnswer = readStringField(rawSummary, "answer");
  const summarySourceIds = stringArray(rawSummary?.sourceIds);
  const subjectSummary =
    summaryAnswer === undefined || summaryAnswer === "" || summarySourceIds.length === 0
      ? undefined
      : {
          key: "subjectSummary",
          label: "Summary",
          answer: summaryAnswer,
          sourceIds: summarySourceIds,
        };
  const recentMaterialEvents = webProfileFacts(record.recentMaterialEvents);
  const factLedger = webProfileFacts(record.factLedger);
  const openGaps = stringArray(record.openGaps);
  if (
    questions.length === 0 &&
    recentMaterialEvents.length === 0 &&
    factLedger.length === 0 &&
    openGaps.length === 0
  ) {
    return undefined;
  }
  const subjectLabel =
    readStringField(record, "subjectLabel") ?? readStringField(record, "companyName");
  const generatedAt = readStringField(record, "generatedAt");
  return {
    ...(subjectKind !== undefined ? { subjectKind } : {}),
    ...(subjectLabel !== undefined ? { subjectLabel } : {}),
    ...(subjectSummary !== undefined ? { subjectSummary } : {}),
    ...(generatedAt !== undefined ? { generatedAt } : {}),
    questions,
    recentMaterialEvents,
    factLedger,
    openGaps,
    sourceIds: stringArray(record.sourceIds),
  };
}

export function webSubjectProfileView(
  report: Record<string, unknown> | undefined,
  artifact?: WebSubjectProfileArtifact,
): WebSubjectProfileView | undefined {
  const extras = readRecord(report?.extras);
  return (
    webSubjectProfileFromValue(extras?.webSubjectProfile) ?? webSubjectProfileFromValue(artifact)
  );
}

export function reliabilityBins(detail: CalibrationDetail): readonly ReliabilityBin[] {
  const bins = detail.summary?.bins;
  if (!Array.isArray(bins)) {
    return [];
  }

  return bins
    .filter(
      (bin): bin is Record<string, unknown> =>
        typeof bin === "object" && bin !== null && !Array.isArray(bin),
    )
    .flatMap((bin) => {
      const pLow = readFiniteNumber(bin.pLow);
      const pHigh = readFiniteNumber(bin.pHigh);
      const hitRate = readFiniteNumber(bin.hitRate);
      const hitCount = readFiniteNumber(bin.hitCount);
      const totalCount = readFiniteNumber(bin.totalCount);
      const label = typeof bin.label === "string" ? bin.label : undefined;
      return pLow === undefined ||
        pHigh === undefined ||
        hitRate === undefined ||
        hitCount === undefined ||
        totalCount === undefined ||
        label === undefined
        ? []
        : [{ label, pLow, pHigh, hitRate, hitCount, totalCount }];
    })
    .toSorted((left, right) => left.pLow - right.pLow);
}

export function calibrationSlices(
  detail: CalibrationDetail,
  group: CalibrationSliceGroup,
): readonly CalibrationSliceRow[] {
  const slice = detail.summary?.[group];
  if (typeof slice !== "object" || slice === null || Array.isArray(slice)) {
    return [];
  }

  const rows = Object.entries(slice).flatMap(([key, metric]) => {
    if (typeof metric !== "object" || metric === null || Array.isArray(metric)) {
      return [];
    }

    const record = metric as Record<string, unknown>;
    const brierScore = readFiniteNumber(record.brierScore);
    const count = readFiniteNumber(record.count);
    return brierScore === undefined || count === undefined ? [] : [{ key, brierScore, count }];
  });

  return group === "byHorizonBucket" || group === "byMarketUpdateHorizonBucket"
    ? rows.toSorted((left, right) => horizonBucketRank(left.key) - horizonBucketRank(right.key))
    : rows.toSorted((left, right) => right.count - left.count);
}

export function calibrationAutopsyCauses(
  detail: CalibrationDetail,
): readonly CalibrationAutopsyCauseRow[] {
  const counts = detail.summary?.byMissAutopsyCause;
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) {
    return [];
  }
  return Object.entries(counts)
    .flatMap(([cause, value]) => {
      const count = readFiniteNumber(value);
      return count === undefined ? [] : [{ cause, count }];
    })
    .toSorted((left, right) => right.count - left.count || left.cause.localeCompare(right.cause));
}

function horizonBucketRank(bucket: string): number {
  const index = HORIZON_BUCKET_ORDER.indexOf(bucket);
  return index === -1 ? HORIZON_BUCKET_ORDER.length : index;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumberField(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readStringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function formatSkill(value: number | undefined): string {
  if (value === undefined) {
    return "cal n/a";
  }
  return `skill ${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function preferredCalibrationSlice(
  analytics: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const calibration = readRecord(analytics?.calibrationAtGeneration);
  return (
    readRecord(calibration?.marketUpdateHorizonBucket) ??
    readRecord(calibration?.jobType) ??
    readRecord(calibration?.assetClass)
  );
}

export function runCompareCards(details: readonly RunDetail[]): readonly RunCompareCard[] {
  return details.flatMap((detail) => {
    const { analytics } = detail;
    if (analytics === undefined) {
      return [];
    }

    const predictions = readRecord(analytics.predictions);
    const shortfall = readRecord(predictions?.shortfall);
    const targetCount = readNumberField(predictions, "targetCount");
    const count = readNumberField(predictions, "count");
    const targetMet = predictions?.targetMet === true;
    const calibration = preferredCalibrationSlice(analytics);
    const snapshot = readRecord(analytics.verifiedMarketSnapshot);
    const snapshotAge = readFiniteNumber(snapshot?.latestSessionAgeDays);
    const snapshotSymbol = readStringField(snapshot, "symbol");

    return [
      {
        runId: detail.summary.runId,
        label: runLabel(detail.summary),
        generatedAt: formatDateMinute(detail.summary.generatedAt),
        forecasts: targetCount > 0 ? `${String(count)}/${String(targetCount)}` : String(count),
        targetMet,
        shortfall:
          shortfall === undefined
            ? "none"
            : `${String(readNumberField(shortfall, "missingCount"))} missing${
                shortfall.disclosed === true ? ", disclosed" : ""
              }`,
        calibration: formatSkill(readFiniteNumber(calibration?.brierSkillScore)),
        snapshotFreshness:
          snapshotAge === undefined || snapshotSymbol === undefined
            ? "snapshot n/a"
            : `${snapshotSymbol} snapshot ${String(snapshotAge)}d`,
      },
    ];
  });
}

export function historicalContextAuditView(
  trace?: Record<string, unknown>,
): HistoricalContextAuditView | undefined {
  const audit = readRecord(trace?.historicalContext);
  if (audit === undefined) {
    return undefined;
  }

  return {
    scannedRunCount: readNumberField(audit, "scannedRunCount"),
    candidateRunCount: readNumberField(audit, "candidateRunCount"),
    selectedRunCount: readNumberField(audit, "selectedRunCount"),
    recentSelectedCount: readNumberField(audit, "recentSelectedCount"),
    anchorSelectedCount: readNumberField(audit, "anchorSelectedCount"),
    sameSymbolSelectedCount: readNumberField(audit, "sameSymbolSelectedCount"),
    spotlightSymbolSelectedCount: readNumberField(audit, "spotlightSymbolSelectedCount"),
    sameSubjectSelectedCount: readNumberField(audit, "sameSubjectSelectedCount"),
    sameHorizonSelectedCount: readNumberField(audit, "sameHorizonSelectedCount"),
    crossHorizonSelectedCount: readNumberField(audit, "crossHorizonSelectedCount"),
    resolvedMissRunCount: readNumberField(audit, "resolvedMissRunCount"),
    missCorrectionSelectedCount: readNumberField(audit, "missCorrectionSelectedCount"),
    gapCount: readNumberField(audit, "gapCount"),
  };
}

export function alphaCohortHeadline(detail: AlphaCohortDetail): AlphaCohortHeadline {
  const { summary } = detail;
  const generatedAt = readStringField(summary, "generatedAt");
  return {
    ...(generatedAt !== undefined ? { generatedAt } : {}),
    rejectedCandidateCount: readNumberField(summary, "rejectedCandidateCount"),
    watchlistCandidateCount: readNumberField(summary, "watchlistCandidateCount"),
    tickerBriefedLeadCount: readNumberField(summary, "tickerBriefedLeadCount"),
    unbriefedLeadCount: readNumberField(summary, "unbriefedLeadCount"),
  };
}

function metricText(metrics: unknown): string {
  const record = readRecord(metrics);
  if (record === undefined) {
    return "n/a";
  }
  const rows = Object.entries(record)
    .toSorted(([left], [right]) => Number(left) - Number(right))
    .flatMap(([horizon, value]) => {
      const metric = readRecord(value);
      if (metric === undefined) {
        return [];
      }
      const resolvedCount = readNumberField(metric, "resolvedCount");
      if (resolvedCount === 0) {
        return [];
      }
      const hitRate = readFiniteNumber(metric.hitRate);
      const averageExcessReturn = readFiniteNumber(metric.averageExcessReturn);
      return [
        `${horizon}d ${hitRate === undefined ? "n/a" : `${(hitRate * 100).toFixed(1)}%`} hit · ${
          averageExcessReturn === undefined ? "n/a" : `${(averageExcessReturn * 100).toFixed(1)}%`
        } excess · n=${String(resolvedCount)}`,
      ];
    });
  return rows.length === 0 ? "n/a" : rows.join("; ");
}

export function alphaRejectionBucketRows(
  detail: AlphaCohortDetail,
): readonly AlphaRejectionBucketRow[] {
  const buckets = detail.summary?.rejectionBuckets;
  if (!Array.isArray(buckets)) {
    return [];
  }

  return buckets
    .filter((bucket): bucket is Record<string, unknown> => readRecord(bucket) !== undefined)
    .map((bucket) => ({
      reason: readStringField(bucket, "reason") ?? "unknown",
      rejectedCount: readNumberField(bucket, "rejectedCount"),
      uniqueSymbolCount: readNumberField(bucket, "uniqueSymbolCount"),
      laterValidatedSymbolCount: readNumberField(bucket, "laterValidatedSymbolCount"),
      validation: metricText(bucket.validation),
    }));
}

export function alphaStaleLeadRows(detail: AlphaCohortDetail): readonly AlphaStaleLeadRow[] {
  const buckets = detail.summary?.staleLeadDecay;
  if (!Array.isArray(buckets)) {
    return [];
  }

  return buckets
    .filter((bucket): bucket is Record<string, unknown> => readRecord(bucket) !== undefined)
    .map((bucket) => ({
      ageBucket: readStringField(bucket, "ageBucket") ?? "unknown",
      unbriefedLeadCount: readNumberField(bucket, "unbriefedLeadCount"),
      validation: metricText(bucket.validation),
    }));
}

export const VERIFIED_SNAPSHOT_PATH = RUN_ARTIFACT_FILES.verifiedMarketSnapshot;

export interface SnapshotClose {
  readonly date: string;
  readonly close: number;
}

export interface SnapshotOhlcv {
  readonly date: string;
  readonly close: number;
}

export interface SnapshotView {
  readonly symbol: string;
  readonly analysisDate?: string;
  readonly latestSessionDate?: string;
  readonly ohlcv?: SnapshotOhlcv;
  readonly indicators: Readonly<Record<string, number>>;
  readonly recentCloses: readonly SnapshotClose[];
}

export interface CloseLinePoint {
  readonly x: number;
  readonly y: number;
  readonly date: string;
  readonly close: number;
}

export function verifiedSnapshotView(content: string): SnapshotView | undefined {
  return verifiedSnapshotValue(parseJson(content));
}

export function verifiedSnapshotValue(value: unknown): SnapshotView | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const symbol = typeof record.symbol === "string" ? record.symbol : undefined;
  const recentCloses = snapshotCloses(record.recentCloses);
  if (symbol === undefined || recentCloses.length < 2) {
    return undefined;
  }

  const analysisDate = typeof record.analysisDate === "string" ? record.analysisDate : undefined;
  const latestSessionDate =
    typeof record.latestSessionDate === "string" ? record.latestSessionDate : undefined;
  const ohlcv = snapshotOhlcv(record.ohlcv);
  return {
    symbol,
    ...(analysisDate !== undefined ? { analysisDate } : {}),
    ...(latestSessionDate !== undefined ? { latestSessionDate } : {}),
    ...(ohlcv !== undefined ? { ohlcv } : {}),
    indicators: snapshotIndicators(record.indicators),
    recentCloses,
  };
}

export function tradingViewSymbol(symbol: string, exchange?: string): string {
  const cleanSymbol = symbol.trim().toUpperCase();
  const cleanExchange = exchange?.trim().toUpperCase();
  return cleanExchange === undefined || cleanExchange === ""
    ? cleanSymbol
    : `${cleanExchange}:${cleanSymbol}`;
}

export function tradingViewUrl(symbol: string, exchange?: string): string {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(
    tradingViewSymbol(symbol, exchange),
  )}`;
}

export function instrumentPath(assetClass: string, symbol: string): string {
  return `${INSTRUMENT_PATH_PREFIX}${encodeURIComponent(assetClass)}/${encodeURIComponent(
    symbol.toUpperCase(),
  )}`;
}

export function instrumentFromPathname(
  pathname: string,
): { readonly assetClass: string; readonly symbol: string } | undefined {
  if (!pathname.startsWith(INSTRUMENT_PATH_PREFIX)) {
    return undefined;
  }
  const parts = pathname.slice(INSTRUMENT_PATH_PREFIX.length).split("/");
  if (parts.length !== 2) {
    return undefined;
  }
  try {
    const assetClass = decodeURIComponent(parts[0] ?? "");
    const symbol = decodeURIComponent(parts[1] ?? "");
    return assetClass === "" || symbol === ""
      ? undefined
      : { assetClass, symbol: symbol.toUpperCase() };
  } catch {
    return undefined;
  }
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function snapshotCloses(value: unknown): readonly SnapshotClose[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const close = readFiniteNumber(record.close);
    return typeof record.date === "string" && close !== undefined
      ? [{ date: record.date, close }]
      : [];
  });
}

function snapshotOhlcv(value: unknown): SnapshotOhlcv | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const close = readFiniteNumber(record.close);
  return typeof record.date === "string" && close !== undefined
    ? { date: record.date, close }
    : undefined;
}

function snapshotIndicators(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const indicator = readFiniteNumber(entry);
      return indicator === undefined ? [] : [[key, indicator] as const];
    }),
  );
}

export function closeLinePoints(
  closes: readonly SnapshotClose[],
  plotLeft: number,
  plotWidth: number,
  plotTop: number,
  plotHeight: number,
): readonly CloseLinePoint[] {
  if (closes.length === 0) {
    return [];
  }

  const values = closes.map((entry) => entry.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  return closes.map((entry, index) => ({
    x: plotLeft + (closes.length === 1 ? 0 : (index * plotWidth) / (closes.length - 1)),
    y:
      range === 0 ? plotTop + plotHeight / 2 : plotTop + ((max - entry.close) / range) * plotHeight,
    date: entry.date,
    close: entry.close,
  }));
}

export function horizonMarkers(
  forecasts: readonly { readonly horizonTradingDays?: number }[],
): readonly number[] {
  return [
    ...new Set(
      forecasts
        .map((forecast) => forecast.horizonTradingDays)
        .filter((horizon): horizon is number => horizon !== undefined && horizon > 0),
    ),
  ].toSorted((left, right) => left - right);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function formatClose(value: number): string {
  return Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(4);
}

export function jsonBlock(value: Record<string, unknown> | undefined): string {
  return value === undefined ? "Not available" : JSON.stringify(value, null, 2);
}

export function runLabel(run: RunSummary): string {
  const subject = run.symbol ?? run.assetClass ?? "unknown";
  return `${run.jobType ?? "run"} / ${subject}`;
}

export function runCountsLabel(run: RunSummary): string {
  return `${String(run.findingCount)} fnd · ${String(run.predictionCount)} fct · ${String(run.dataGapCount)} gap`;
}

export function formatDate(value: string | undefined): string {
  if (value === undefined) {
    return "unknown time";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatDateMinute(value: string | undefined): string {
  if (value === undefined) {
    return "unknown time";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      });
}

export function runPath(runId: string): string {
  return `${RUN_PATH_PREFIX}${encodeURIComponent(runId)}`;
}

export function runIdFromPathname(pathname: string): string | undefined {
  if (!pathname.startsWith(RUN_PATH_PREFIX)) {
    return undefined;
  }

  const encodedRunId = pathname.slice(RUN_PATH_PREFIX.length);
  if (encodedRunId === "" || encodedRunId.includes("/")) {
    return undefined;
  }

  try {
    const runId = decodeURIComponent(encodedRunId);
    return runId === "" ? undefined : runId;
  } catch {
    return undefined;
  }
}

export function recentRunSummaries(
  runs: readonly RunSummary[],
  limit: number = RECENT_RUN_LIMIT,
): readonly RunSummary[] {
  return runs.slice(0, Math.max(0, limit));
}

export function filterRuns(
  runs: readonly RunSummary[],
  typeFilter: string,
  queryText: string,
): readonly RunSummary[] {
  return runs.filter(
    (run) =>
      (typeFilter === "all" || (run.jobType ?? "run") === typeFilter) &&
      (queryText.trim() === "" || matchesQuery(run, queryText)),
  );
}

export function providerHealthRows(detail: ProviderHealthDetail): readonly ProviderHealthRow[] {
  const routes = detail.summary?.routes;
  if (!Array.isArray(routes)) {
    return [];
  }

  return routes
    .filter(
      (route): route is Record<string, unknown> =>
        typeof route === "object" && route !== null && !Array.isArray(route),
    )
    .map((route) => {
      const gaps = PROVIDER_GAP_KEYS.reduce((sum, key) => sum + readCount(route, key), 0);
      const { sampleMessages } = route;
      const note =
        Array.isArray(sampleMessages) && typeof sampleMessages[0] === "string"
          ? sampleMessages[0]
          : "";

      return {
        provider: typeof route.provider === "string" ? route.provider : "unknown",
        route: typeof route.route === "string" ? route.route : "",
        degraded: gaps > 0,
        total: readCount(route, "total"),
        gaps,
        note,
      };
    });
}

function readCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

export function matchesQuery(run: RunSummary, text: string): boolean {
  const haystack = [run.runId, run.jobType, run.assetClass, run.symbol, run.depth, run.confidence]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();

  return haystack.includes(text.trim().toLowerCase());
}

export function groupedRunsByType(runs: readonly RunSummary[]): readonly RunTypeGroup[] {
  const groups = new Map<string, RunSummary[]>();

  for (const run of runs) {
    const type = run.jobType ?? "run";
    groups.set(type, [...(groups.get(type) ?? []), run]);
  }

  return [...groups.entries()]
    .toSorted(([left], [right]) => runTypeRank(left) - runTypeRank(right))
    .map(([type, groupedRuns]) => ({
      type,
      runs: groupedRuns,
    }));
}

function runTypeRank(type: string): number {
  const index = RUN_TYPE_ORDER.indexOf(type);
  return index === -1 ? RUN_TYPE_ORDER.length : index;
}

export function dashboardMetrics(runs: readonly RunSummary[]): DashboardMetrics {
  const confidenceValues = runs
    .map((run) => confidenceRank(run.confidence))
    .filter((value): value is number => value !== undefined);
  const averageConfidence =
    confidenceValues.length === 0
      ? "unknown"
      : confidenceLabel(
          confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length,
        );

  return {
    totalRuns: runs.length,
    totalSources: runs.reduce((sum, run) => sum + run.sourceCount, 0),
    totalForecasts: runs.reduce((sum, run) => sum + run.predictionCount, 0),
    totalDataGaps: runs.reduce((sum, run) => sum + run.dataGapCount, 0),
    scoredRuns: runs.filter((run) => run.hasScore).length,
    equityRuns: runs.filter((run) => run.assetClass === "equity").length,
    cryptoRuns: runs.filter((run) => run.assetClass === "crypto").length,
    averageConfidence,
  };
}

export function runTrend(runs: readonly RunSummary[], bucketLimit = 14): readonly RunTrendPoint[] {
  const buckets = new Map<string, RunTrendPoint>();

  for (const run of runs) {
    const date = dateKey(run.generatedAt);
    if (date === undefined) {
      continue;
    }

    const current = buckets.get(date) ?? {
      date,
      runs: 0,
      forecasts: 0,
      sources: 0,
      dataGaps: 0,
    };

    buckets.set(date, {
      date,
      runs: current.runs + 1,
      forecasts: current.forecasts + run.predictionCount,
      sources: current.sources + run.sourceCount,
      dataGaps: current.dataGaps + run.dataGapCount,
    });
  }

  return [...buckets.values()]
    .toSorted((left, right) => left.date.localeCompare(right.date))
    .slice(Math.max(0, buckets.size - bucketLimit));
}

export function groupedSearchResults(
  results: readonly RunSearchResult[],
): readonly SearchResultGroup[] {
  const groups = new Map<string, { run: RunSummary; results: RunSearchResult[] }>();

  for (const result of results) {
    const group = groups.get(result.run.runId);
    if (group === undefined) {
      groups.set(result.run.runId, { run: result.run, results: [result] });
      continue;
    }

    groups.set(result.run.runId, { run: group.run, results: [...group.results, result] });
  }

  return [...groups.values()];
}

function dateKey(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function confidenceRank(value: string | undefined): number | undefined {
  if (value === "low") {
    return 1;
  }

  if (value === "medium") {
    return 2;
  }

  if (value === "high") {
    return 3;
  }

  return undefined;
}

function confidenceLabel(value: number): string {
  if (value >= 2.5) {
    return "high";
  }

  if (value >= 1.5) {
    return "medium";
  }

  return "low";
}
