import type { Prediction } from "../domain/prediction";
import type { KeyFinding, ResearchReport, Scenario } from "../domain/report";
import type { PostSynthesisAuditWarning } from "../domain/run-trace";
import type { WebSourceUsage } from "../web-evidence";
import { isGapShapedClaimForAuditWarning } from "./gap-shaped-claims";
import { SCALE_WORDS } from "./web-figure-verification";

const NUMERIC_CLAIM_PATTERN = /(?:[$]?\d+(?:\.\d+)?%?|\b\d+(?:\.\d+)?\b)/u;
// "Q2 2026", "H1 FY26", "3Q" label a period, not a figure, unless a financial unit is attached.
const FISCAL_PERIOD_TOKEN_PATTERN =
  /(?<![\d.])\b(?:Q[1-4]|H[12]|[1-4]Q)(?:\s+(?:FY\s?\d{2}|(?:FY)?(?:19|20)\d{2}))?\b(?!\.\d)/giu;
// 8 covers Sc + grouping/minus/whitespace; unbounded prefix slice was O(n^2) per date.
const UNIT_WINDOW = 8;
// Only "T1"/"H100" or "Rev8" shapes name an entity; currency-led forms (RM485, Rs500, kr500, usd500) stay figures.
const ALPHANUMERIC_NAME_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d\p{Sc}])(?!Q[1-4]\b|H[12]\b)(?:\p{Lu}|\p{Lu}\p{Ll}{2,})\d+(?![\p{L}\d%‰‱]|[.,]\d|\s*(?:[x×%‰‱]|\p{Sc}|(?i:${SCALE_WORDS}|bln|crore|cr|lakh|mm|k|m|b)\b))`,
  "gu",
);
const NOT_A_FIGURE_AFTER = String.raw`(?![\p{L}\d%‰‱]|[.,]\d|\s*(?:[x×%‰‱]|\p{Sc}|-\s*\d|(?i:${SCALE_WORDS}|bln|crore|cr|lakh|mm|k|m|b|mw|gw|mwh|gwh|bps|bp|pp)\b))`;
// Month-day dates stay with the integrity audit's date check, which keeps invalid ones numeric.
const MONTH_NAMES =
  "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
// Shortcut: name shapes seen in real runs ("S&P 500", "10-K", "MI350", "COVID-19"); a model token label replaces them in phase 7.
const SEC_FORM_PATTERN = /(?<![\p{L}\d-])(?:6|8|10|11|20|40)-[KQF](?:\/A)?(?![\p{L}\d])/gu;
const SPACED_NAME_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d\p{Sc}/&'’.-])(?!${MONTH_NAMES}\b)([\p{L}&'’]*\p{Lu}[\p{L}&'’]*) \d+${NOT_A_FIGURE_AFTER}`,
  "gu",
);
const GLUED_NAME_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d\p{Sc}/&'’.-])(?!FY)(\p{Lu}{2,}|\p{Lu}\p{L}*-)\d+${NOT_A_FIGURE_AFTER}`,
  "gu",
);
const CURRENCY_WORDS: ReadonlySet<string> = new Set([
  ...Intl.supportedValuesOf("currency").map((code) => code.toLowerCase()),
  "rm",
  "rs",
  "rp",
  "kr",
]);
const CURRENCY_PREFIX_PATTERN = /\p{Sc}[\s()[\]{}-]*$/u;
const UNIT_SUFFIX_PATTERN = /^\s*(?:[%‰‱]|[x×X⨯*]|\p{Sc})/u;
const TECHNICAL_INDICATOR_PATTERN = /\b(?:ema|sma|rsi|macd|bollinger|atr)\d*\b/iu;
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
const SELF_DECLARING_WEAK_POSTURES = [
  "unverified",
  "unsupported",
  "uncited",
  "low-trust",
  "inferred",
] as const;
const CANONICAL_POSTURE_REQUIRED_PATTERN = /\b(?:missing source|source gap|data gap)\b/iu;
const HISTORICAL_OUTCOME_CONTEXT_PATTERN = /\b(?:prior|previous|historical|past|resolved)\b/iu;
const FORECAST_OUTCOME_PATTERN =
  /\b(?:forecast|prediction|miss(?:es|ed)?|hit(?:s)?|resolved|outcome)\b/iu;
const PEER_MEDIAN_PATTERN = /\bpeer[\s-]+medians?\b/iu;
const NEGATED_PEER_MEDIAN_PATTERN =
  /\b(?:no|without)\s+(?:usable\s+)?peer[\s-]+medians?\b|\bpeer[\s-]+medians?\b[^.]*\b(?:not available|unavailable|not computed|could not be computed|cannot be computed|not computable|withheld)\b/iu;
// Comps rows carry only EV/revenue, so a median of another metric is outside the usable-peer set.
const EV_REVENUE_PATTERN =
  /\bEV\s*\/\s*(?:TTM\s+|annualized\s+)?(?:revenue|sales)\b|\benterprise[\s-]value[\s-]to[\s-](?:revenue|sales)\b/iu;
const OTHER_PEER_METRIC_PATTERN =
  /\bEV\s*\/\s*(?!(?:TTM\s+|annualized\s+)?(?:revenue|sales)\b)\w|\benterprise[\s-]value[\s-]to[\s-](?!revenue\b|sales\b)\w|\b(?:P\s*\/\s*[EBS]|gross profit|price[\s-]to[\s-](?:earnings|book|sales)|EBITDA|EBIT|earnings multiple|FCF|free cash flow|margins?|growth|ROIC|ROE|yield|payout)\b/iu;
const FORECAST_HORIZON_PATTERN = /\b\d+\s*(?:-| )?(?:trading\s*)?day\b/iu;

export type PeerMedianMetric = "ev-revenue" | "other" | "absence";
// Keyed by trimmed clause text; a clause without a label falls back to the regex.
export type PeerMedianLabels = ReadonlyMap<string, PeerMedianMetric>;

interface AuditClaim {
  readonly location: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
}

export function auditPostSynthesisReport(
  report: ResearchReport,
  webSourceUsage?: WebSourceUsage,
  usablePeerSourceIds?: ReadonlySet<string>,
  peerMedianLabels?: PeerMedianLabels,
  runCurrencies: readonly string[] = [],
): readonly PostSynthesisAuditWarning[] {
  return [
    ...claimsForReport(report).flatMap((claim) =>
      auditClaim(claim, usablePeerSourceIds, peerMedianLabels, runCurrencies),
    ),
    ...(webSourceUsage !== undefined &&
    webSourceUsage.currentRunIds.size >= 4 &&
    webSourceUsage.currentRunUsedIds.size === 0
      ? [freshWebUnusedWarning(webSourceUsage)]
      : []),
  ];
}

export function claimsForReport(report: ResearchReport): readonly AuditClaim[] {
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

function auditClaim(
  claim: AuditClaim,
  usablePeerSourceIds: ReadonlySet<string> | undefined,
  peerMedianLabels: PeerMedianLabels | undefined,
  runCurrencies: readonly string[],
): readonly PostSynthesisAuditWarning[] {
  return [
    ...(isUncitedPeerMedianClaim(claim.text, claim.sourceIds, usablePeerSourceIds, peerMedianLabels)
      ? [peerMedianUncitedWarning(claim)]
      : []),
    ...(isGapShapedClaimForAuditWarning(claim.text) && claim.sourceIds.length > 0
      ? [citedGapShapedClaimWarning(claim)]
      : []),
    ...((isNumericClaim(claim.text, runCurrencies) || isTechnicalClaim(claim.text)) &&
    !isHistoricalForecastOutcome(claim.text) &&
    hasNoSupportingSource(claim.sourceIds)
      ? [unsupportedNumericWarning(claim)]
      : []),
    ...(shouldCarryPostureLabel(claim.text, claim.sourceIds) &&
    !hasPostureLabel(claim.text, claim.sourceIds)
      ? [missingPostureWarning(claim)]
      : []),
  ];
}

export function peerMedianClauses(text: string): readonly string[] {
  return text
    .split(/[;.!?](?:\s|$)/u)
    .map((clause) => clause.trim())
    .filter(
      (clause) =>
        PEER_MEDIAN_PATTERN.test(clause) &&
        !NEGATED_PEER_MEDIAN_PATTERN.test(clause) &&
        !isGapShapedClaimForAuditWarning(clause),
    );
}

export function isUncitedPeerMedianClaim(
  text: string,
  sourceIds: readonly string[],
  usablePeerSourceIds: ReadonlySet<string> | undefined,
  peerMedianLabels?: PeerMedianLabels,
): boolean {
  return (
    usablePeerSourceIds !== undefined &&
    peerMedianClauses(text).some((clause) => {
      const label = peerMedianLabels?.get(clause);
      return label === undefined
        ? EV_REVENUE_PATTERN.test(clause) || !OTHER_PEER_METRIC_PATTERN.test(clause)
        : label === "ev-revenue";
    }) &&
    !sourceIds.some((id) => usablePeerSourceIds.has(id))
  );
}

export function isTechnicalClaim(text: string): boolean {
  return TECHNICAL_INDICATOR_PATTERN.test(text);
}

export function isNumericClaim(text: string, runCurrencies: readonly string[] = []): boolean {
  const prefixes = runCurrencyPrefixes(runCurrencies);
  return NUMERIC_CLAIM_PATTERN.test(
    text
      .replaceAll(FISCAL_PERIOD_TOKEN_PATTERN, (span, offset: number) =>
        hasAttachedFinancialUnit(text, offset, offset + span.length) ? span : " ",
      )
      .replaceAll(ALPHANUMERIC_NAME_PATTERN, (span) =>
        prefixes.has(span.replace(/\d+$/u, "").toLowerCase()) ? span : " ",
      )
      .replaceAll(SEC_FORM_PATTERN, " ")
      .replaceAll(SPACED_NAME_PATTERN, (span, name: string) =>
        isCurrencyWord(name, prefixes) ? span : " ",
      )
      .replaceAll(GLUED_NAME_PATTERN, (span, name: string) =>
        isCurrencyWord(name.replace(/-$/u, ""), prefixes) ? span : " ",
      ),
  );
}

function isCurrencyWord(word: string, runPrefixes: ReadonlySet<string>): boolean {
  const lower = word.toLowerCase();
  return CURRENCY_WORDS.has(lower) || runPrefixes.has(lower);
}

// "R500" on a ZAR run or "Myr500" on a MYR run is that currency, not a name: ISO code plus CLDR letter symbols.
function runCurrencyPrefixes(currencies: readonly string[]): ReadonlySet<string> {
  return new Set(
    currencies.flatMap((code) => [
      code.toLowerCase(),
      ...(["symbol", "narrowSymbol"] as const).flatMap((currencyDisplay) =>
        currencySymbol(code, currencyDisplay),
      ),
    ]),
  );
}

function currencySymbol(code: string, currencyDisplay: "symbol" | "narrowSymbol"): string[] {
  try {
    const symbol = new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      currencyDisplay,
    })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value;
    return symbol !== undefined && /^\p{L}+$/u.test(symbol) ? [symbol.toLowerCase()] : [];
  } catch {
    return [];
  }
}

export function hasAttachedFinancialUnit(text: string, start: number, end: number): boolean {
  const prefix = text.slice(Math.max(0, start - UNIT_WINDOW), start);
  const suffix = text.slice(end, end + UNIT_WINDOW);
  return CURRENCY_PREFIX_PATTERN.test(prefix) || UNIT_SUFFIX_PATTERN.test(suffix);
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

// Self-declaring weak terms satisfy posture only for claims with a current source and no
// Explicit gap phrase. Empty or history-only citations and explicit gap phrases still
// Require a canonical posture label.
export function hasPostureLabel(text: string, sourceIds: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  if (EVIDENCE_POSTURE_LABELS.some((label) => normalized.includes(label))) {
    return true;
  }
  return (
    !hasNoSupportingSource(sourceIds) &&
    !CANONICAL_POSTURE_REQUIRED_PATTERN.test(text) &&
    SELF_DECLARING_WEAK_POSTURES.some((posture) => normalized.includes(posture))
  );
}

function citedGapShapedClaimWarning(claim: AuditClaim): PostSynthesisAuditWarning {
  return {
    code: "gap-shaped-claim-cited",
    location: claim.location,
    message: "gap-shaped claim carries source citations; review citation grounding",
    sourceIds: claim.sourceIds,
  };
}

function unsupportedNumericWarning(claim: AuditClaim): PostSynthesisAuditWarning {
  return {
    code: "unsupported-numeric-claim",
    location: claim.location,
    message: "numeric or technical claim has no non-history supporting source citation",
    sourceIds: claim.sourceIds,
  };
}

function peerMedianUncitedWarning(claim: AuditClaim): PostSynthesisAuditWarning {
  return {
    code: "peer-median-uncited",
    location: claim.location,
    message: "peer-median claim cites no usable peer source",
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
