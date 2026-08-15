import {
  isMarketRegimeLabel,
  isReportIntegrity,
  type ExtendedEvidence,
  type ExtendedEvidenceCategory,
  type ExtendedEvidenceItem,
  type Instrument,
  type InstrumentIdentity,
  type KeyFinding,
  type MarketRegimeLabel,
  type Prediction,
  type ProviderInstrumentId,
  type ResearchReport,
  type Source,
  type SourceGap,
  type SourceGapAttemptClassification,
  type SourceGapAttemptFailure,
  type SourceGapAttempts,
  type SubjectKind,
} from "./domain/types";
import { readEquityAnalysisCompleteness } from "./domain/equity-analysis-completeness";
import {
  isSourceGapCapability,
  isSourceGapCause,
  isSourceGapEvidenceQualityImpact,
  isSourceGapTriage,
} from "./domain/source-gaps";
import { isPredictionKind, renderClaimForMeasurableAs } from "./forecast/observable";
import { CURRENT_SCORING_POLICY_VERSION } from "./scoring/policy";
import { normalizePredictionShortfall } from "./report/prediction-shortfall";
import { readVerifiedMarketSnapshots } from "./run-artifact-snapshot-reader";
import { isAssetClass, isJobType, readPrimitiveEvidence } from "./run-artifact-value-guards";
import { isRecord, nonEmptyStringArrayValue, readString, stringArrayValue } from "./guards";

const EXTENDED_EVIDENCE_CATEGORIES: ReadonlySet<string> = new Set<ExtendedEvidenceCategory>([
  "sec-edgar",
  "valuation",
  "equity-events",
  "fred-macro",
  "options-iv",
  "on-chain",
  "financial-lens",
  "subsequent-events",
  "business-framework",
  "web-subject-profile",
  "yahoo-fundamentals",
  "analyst-estimates",
  "analyst-estimate-context",
  "institutional-ownership",
]);

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

function isExtendedEvidenceCategory(value: unknown): value is ExtendedEvidenceCategory {
  return typeof value === "string" && EXTENDED_EVIDENCE_CATEGORIES.has(value);
}

function isSubjectKind(value: unknown): value is SubjectKind {
  return value === "company" || value === "crypto-asset" || value === "theme";
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
        // Unknown versions degrade to absent, which resolves under policy v2.
        ...(item.scoringPolicyVersion === CURRENT_SCORING_POLICY_VERSION
          ? { scoringPolicyVersion: CURRENT_SCORING_POLICY_VERSION }
          : {}),
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

export function readSourceGaps(value: unknown): readonly SourceGap[] {
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
    const triage = isSourceGapTriage(item.triage) ? item.triage : undefined;
    const attempts = readSourceGapAttempts(item.attempts);
    return [
      {
        source: item.source,
        message: item.message,
        ...(typeof item.symbol === "string" ? { symbol: item.symbol } : {}),
        ...(typeof item.provider === "string" ? { provider: item.provider } : {}),
        ...(capability !== undefined ? { capability } : {}),
        ...(cause !== undefined ? { cause } : {}),
        ...(evidenceQualityImpact !== undefined ? { evidenceQualityImpact } : {}),
        ...(triage !== undefined ? { triage } : {}),
        ...(attempts !== undefined ? { attempts } : {}),
      },
    ];
  });
}

function isSourceGapAttemptClassification(value: unknown): value is SourceGapAttemptClassification {
  return (
    value === "timeout" ||
    value === "server-error" ||
    value === "network" ||
    value === "circuit-open" ||
    value === "non-transient"
  );
}

function isSourceGapAttemptFailure(value: unknown): value is SourceGapAttemptFailure {
  return (
    isRecord(value) &&
    Number.isInteger(value.attempt) &&
    (value.attempt as number) > 0 &&
    isSourceGapAttemptClassification(value.classification) &&
    typeof value.message === "string"
  );
}

export function readSourceGapAttempts(value: unknown): SourceGapAttempts | undefined {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.count) ||
    (value.count as number) < 1 ||
    typeof value.elapsedMs !== "number" ||
    !Number.isFinite(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    !Array.isArray(value.failures) ||
    !value.failures.every(isSourceGapAttemptFailure)
  ) {
    return;
  }
  return {
    count: value.count as number,
    elapsedMs: value.elapsedMs,
    failures: value.failures,
  };
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
  const subject =
    isRecord(value.subject) &&
    isSubjectKind(value.subject.subjectKind) &&
    typeof value.subject.subjectId === "string"
      ? {
          subjectKind: value.subject.subjectKind,
          subjectId: value.subject.subjectId,
          ...(typeof value.subject.subjectLabel === "string"
            ? { subjectLabel: value.subject.subjectLabel }
            : {}),
        }
      : undefined;
  if (instrument === undefined && subject === undefined) {
    return;
  }
  return {
    ...(instrument !== undefined ? { instrument } : {}),
    ...(subject !== undefined ? { subject } : {}),
    items: readExtendedEvidenceItems(value.items),
    gaps: readSourceGaps(value.gaps),
  };
}

export function readReport(value: unknown): ResearchReport | undefined {
  if (!isRecord(value) || !isJobType(value.jobType) || !isAssetClass(value.assetClass)) {
    return;
  }
  const runId = readString(value, "runId");
  const generatedAt = readString(value, "generatedAt");
  if (runId === undefined || generatedAt === undefined) {
    return;
  }
  const extendedEvidence = readExtendedEvidence(value.extendedEvidence);
  const evidenceQuality =
    value.evidenceQuality === "high" ||
    value.evidenceQuality === "medium" ||
    value.evidenceQuality === "low"
      ? value.evidenceQuality
      : undefined;
  const legacyConfidence =
    value.confidence === "high" || value.confidence === "medium" || value.confidence === "low"
      ? value.confidence
      : undefined;
  const verifiedRepresentativeSnapshots = readVerifiedMarketSnapshots(
    value.verifiedRepresentativeSnapshots,
  );
  const researchQualityDriver = readString(value, "researchQualityDriver");
  const equityAnalysisCompleteness = readEquityAnalysisCompleteness(
    value.equityAnalysisCompleteness,
  );
  const normalizedShortfall = normalizePredictionShortfall(
    value.predictionShortfall,
    stringArrayValue(value.dataGaps),
  );
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
    ...(evidenceQuality !== undefined
      ? { evidenceQuality }
      : { confidence: legacyConfidence ?? "low" }),
    ...(isReportIntegrity(value.reportIntegrity) ? { reportIntegrity: value.reportIntegrity } : {}),
    ...(isReportIntegrity(value.researchQuality) ? { researchQuality: value.researchQuality } : {}),
    ...(researchQualityDriver !== undefined ? { researchQualityDriver } : {}),
    ...(equityAnalysisCompleteness !== undefined ? { equityAnalysisCompleteness } : {}),
    ...(normalizedShortfall.predictionShortfall === undefined
      ? {}
      : { predictionShortfall: normalizedShortfall.predictionShortfall }),
    dataGaps: normalizedShortfall.dataGaps,
    predictions: readPredictions(value.predictions),
    sources: readSources(value.sources),
    ...(extendedEvidence !== undefined ? { extendedEvidence } : {}),
    ...(verifiedRepresentativeSnapshots.length > 0 ? { verifiedRepresentativeSnapshots } : {}),
    notFinancialAdvice: true,
    ...(isRecord(value.extras) ? { extras: value.extras } : {}),
  };
}
