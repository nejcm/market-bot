import type {
  KeyFinding,
  PostSynthesisAuditWarning,
  Prediction,
  ResearchReport,
  Scenario,
} from "../domain/types";
import type { WebSourceUsage } from "./web-source-usage";

const NUMERIC_CLAIM_PATTERN = /(?:[$]?\d+(?:\.\d+)?%?|\b\d+(?:\.\d+)?\b)/u;
const TECHNICAL_INDICATOR_PATTERN = /\b(?:ema|sma|rsi|macd|bollinger|atr)\b/iu;
export const EVIDENCE_POSTURE_LABELS = [
  "observed fact",
  "issuer claim",
  "derived calculation",
  "model inference",
  "assumption",
  "stale evidence",
  "conflicting evidence",
  "missing required source",
  "prior forecast outcome",
  "historical forecast outcome",
] as const;
const WEAK_POSTURE_CLAIM_PATTERN =
  /\b(?:assum(?:e|es|ed|ing|ption)|infer(?:s|red|ence)?|model-inferred|stale|conflict(?:s|ing|ed)?|unsupported|unverified|uncited|missing source|source gap|data gap)\b/iu;
const HISTORICAL_OUTCOME_CONTEXT_PATTERN = /\b(?:prior|previous|historical|past|resolved)\b/iu;
const FORECAST_OUTCOME_PATTERN =
  /\b(?:forecast|prediction|miss(?:es|ed)?|hit(?:s)?|resolved|outcome)\b/iu;
const FORECAST_HORIZON_PATTERN = /\b\d+\s*(?:-| )?(?:trading\s*)?day\b/iu;

interface AuditClaim {
  readonly location: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
}

export function auditPostSynthesisReport(
  report: ResearchReport,
  webSourceUsage?: WebSourceUsage,
): readonly PostSynthesisAuditWarning[] {
  return [
    ...claimsForReport(report).flatMap((claim) => auditClaim(claim)),
    ...(webSourceUsage !== undefined &&
    webSourceUsage.currentRunIds.size >= 4 &&
    webSourceUsage.currentRunUsedIds.size === 0
      ? [freshWebUnusedWarning(webSourceUsage)]
      : []),
  ];
}

function claimsForReport(report: ResearchReport): readonly AuditClaim[] {
  return [
    ...findingsForSection("keyFindings", report.keyFindings),
    ...findingsForSection("bullCase", report.bullCase),
    ...findingsForSection("bearCase", report.bearCase),
    ...findingsForSection("risks", report.risks),
    ...findingsForSection("catalysts", report.catalysts),
    ...scenariosForSection(report.scenarios),
    ...predictionsForSection(report.predictions),
  ];
}

function findingsForSection(
  section: string,
  findings: readonly KeyFinding[],
): readonly AuditClaim[] {
  return findings.map((finding, index) => ({
    location: `${section}[${String(index)}]`,
    text: finding.text,
    sourceIds: finding.sourceIds,
  }));
}

function scenariosForSection(scenarios: readonly Scenario[]): readonly AuditClaim[] {
  return scenarios.map((scenario, index) => ({
    location: `scenarios[${String(index)}]`,
    text: scenario.description,
    sourceIds: scenario.sourceIds,
  }));
}

function predictionsForSection(predictions: readonly Prediction[]): readonly AuditClaim[] {
  return predictions.map((prediction, index) => ({
    location: `predictions[${String(index)}]`,
    text: prediction.claim,
    sourceIds: prediction.sourceIds,
  }));
}

function auditClaim(claim: AuditClaim): readonly PostSynthesisAuditWarning[] {
  return [
    ...(isNumericOrTechnicalClaim(claim.text) &&
    !isHistoricalForecastOutcome(claim.text) &&
    hasNoSupportingSource(claim.sourceIds)
      ? [unsupportedNumericWarning(claim)]
      : []),
    ...(shouldCarryPostureLabel(claim.text, claim.sourceIds) && !hasPostureLabel(claim.text)
      ? [missingPostureWarning(claim)]
      : []),
  ];
}

export function isNumericOrTechnicalClaim(text: string): boolean {
  return NUMERIC_CLAIM_PATTERN.test(text) || TECHNICAL_INDICATOR_PATTERN.test(text);
}

export function isTechnicalClaim(text: string): boolean {
  return TECHNICAL_INDICATOR_PATTERN.test(text);
}

export function isNumericClaim(text: string): boolean {
  return NUMERIC_CLAIM_PATTERN.test(text);
}

export function isHistoricalForecastOutcome(text: string): boolean {
  return (
    HISTORICAL_OUTCOME_CONTEXT_PATTERN.test(text) &&
    FORECAST_OUTCOME_PATTERN.test(text) &&
    FORECAST_HORIZON_PATTERN.test(text)
  );
}

export function hasNoSupportingSource(sourceIds: readonly string[]): boolean {
  return sourceIds.every((sourceId) => sourceId.startsWith("history-report-"));
}

export function shouldCarryPostureLabel(text: string, sourceIds: readonly string[]): boolean {
  return hasNoSupportingSource(sourceIds) || WEAK_POSTURE_CLAIM_PATTERN.test(text);
}

export function hasPostureLabel(text: string): boolean {
  const normalized = text.toLowerCase();
  return EVIDENCE_POSTURE_LABELS.some((label) => normalized.includes(label));
}

function unsupportedNumericWarning(claim: AuditClaim): PostSynthesisAuditWarning {
  return {
    code: "unsupported-numeric-claim",
    location: claim.location,
    message: "numeric or technical claim has no non-history supporting source citation",
    sourceIds: claim.sourceIds,
  };
}

function missingPostureWarning(claim: AuditClaim): PostSynthesisAuditWarning {
  return {
    code: "weak-evidence-posture-missing",
    location: claim.location,
    message: "weak or unsupported claim is missing an evidence posture label",
    sourceIds: claim.sourceIds,
  };
}

function freshWebUnusedWarning(usage: WebSourceUsage): PostSynthesisAuditWarning {
  return {
    code: "fresh-web-unused",
    location: "report",
    message: "accepted fresh web sources were unused; review gather relevance and dataGap wording",
    sourceIds: [...usage.currentRunIds],
  };
}
