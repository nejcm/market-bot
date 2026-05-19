import type { Prediction, PredictionKind } from "../domain/types";

export interface ObservableDirection {
  readonly kind: "direction";
  readonly subject: string;
  readonly horizonTradingDays: number;
}

export interface ObservableRelative {
  readonly kind: "relative";
  readonly subjectA: string;
  readonly subjectB: string;
  readonly horizonTradingDays: number;
}

export interface ObservableVolatility {
  readonly kind: "volatility";
  readonly subject: string;
  readonly horizonTradingDays: number;
  readonly threshold: number;
}

export interface ObservableRange {
  readonly kind: "range";
  readonly subject: string;
  readonly horizonTradingDays: number;
  readonly lo: number;
  readonly hi: number;
}

export type ObservableExpression =
  | ObservableDirection
  | ObservableRelative
  | ObservableVolatility
  | ObservableRange;

export interface ObservableForecast {
  readonly prediction: Prediction;
  readonly expression: ObservableExpression;
  readonly instruments: readonly string[];
  readonly measurableAs: string;
  readonly subject: string;
  readonly horizonTradingDays: number;
}

export interface ObservableForecastPolicy {
  readonly knownSourceIds?: ReadonlySet<string>;
}

export interface ObservableForecastIssue {
  readonly predictionId?: string;
  readonly code:
    | "not-object"
    | "missing-id"
    | "missing-claim"
    | "invalid-kind"
    | "missing-subject"
    | "missing-measurable-as"
    | "invalid-horizon"
    | "invalid-probability"
    | "unsafe-claim"
    | "unparseable-measurable"
    | "field-mismatch"
    | "unknown-source";
  readonly message: string;
}

export interface ObservableForecastReadResult {
  readonly forecasts: readonly ObservableForecast[];
  readonly predictions: readonly Prediction[];
  readonly issues: readonly ObservableForecastIssue[];
  readonly promptErrors: readonly string[];
}

export interface CloseAtDate {
  readonly symbol: string;
  readonly date: string;
  readonly close: number;
}

export interface ObservableForecastResolved {
  readonly status: "resolved";
  readonly outcome: "hit" | "miss";
  readonly evidence: Record<string, unknown>;
}

export interface ObservableForecastUnresolved {
  readonly status: "unresolved";
  readonly reason: "missing-origin" | "missing-horizon" | "missing-window";
  readonly missingInstruments: readonly string[];
}

export type ObservableForecastResolution =
  | ObservableForecastResolved
  | ObservableForecastUnresolved;

const SYMBOL = String.raw`([\w\^]+(?::[.\w]+)*)`;
const N = String.raw`(\d+)`;
const NUM = String.raw`(-?\d+(?:\.\d+)?)`;

const DIRECTION_RE = new RegExp(
  String.raw`^close\(${SYMBOL},\s*\+${N}\)\s*>\s*close\(\1,\s*0\)$`,
  "u",
);
const RELATIVE_RE = new RegExp(
  String.raw`^close\(${SYMBOL},\s*\+${N}\)\s*/\s*close\(\1,\s*0\)\s*>\s*close\(${SYMBOL},\s*\+\2\)\s*/\s*close\(\3,\s*0\)$`,
  "u",
);
const VOLATILITY_RE = new RegExp(
  String.raw`^max\(close\(${SYMBOL}\),\s*0\.\.\+${N}\)\s*>\s*${NUM}$`,
  "u",
);
const RANGE_RE = new RegExp(
  String.raw`^close\(${SYMBOL},\s*\+${N}\)\s+outside\s+\[${NUM},\s*${NUM}\]$`,
  "u",
);

const TRADE_ACTION_PATTERN =
  /\b(buy|sell|hold|go long|go short|short this|accumulate|reduce exposure|increase exposure|rebalance|take profit|stop loss|position size|position sizing|execute|execution instruction|portfolio change|allocation change)\b/iu;
const READER_ACTION_PATTERN = /\b(consider|watch for|should|could be a|expect to)\b/iu;

function isPredictionKind(value: unknown): value is PredictionKind {
  return (
    value === "direction" || value === "relative" || value === "volatility" || value === "range"
  );
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function issue(
  code: ObservableForecastIssue["code"],
  message: string,
  predictionId?: string,
): ObservableForecastIssue {
  return predictionId === undefined ? { code, message } : { code, message, predictionId };
}

export function parseObservableExpression(expr: string): ObservableExpression {
  const s = expr.trim();

  const dir = DIRECTION_RE.exec(s);
  if (dir !== null) {
    return { kind: "direction", subject: dir[1] as string, horizonTradingDays: Number(dir[2]) };
  }

  const rel = RELATIVE_RE.exec(s);
  if (rel !== null) {
    return {
      kind: "relative",
      subjectA: rel[1] as string,
      subjectB: rel[3] as string,
      horizonTradingDays: Number(rel[2]),
    };
  }

  const vol = VOLATILITY_RE.exec(s);
  if (vol !== null) {
    return {
      kind: "volatility",
      subject: vol[1] as string,
      horizonTradingDays: Number(vol[2]),
      threshold: Number(vol[3]),
    };
  }

  const range = RANGE_RE.exec(s);
  if (range !== null) {
    const lo = Number(range[3]);
    const hi = Number(range[4]);
    if (lo >= hi) {
      throw new Error(
        `Cannot parse measurableAs: "${expr}" — range lo (${lo}) must be < hi (${hi})`,
      );
    }
    return {
      kind: "range",
      subject: range[1] as string,
      horizonTradingDays: Number(range[2]),
      lo,
      hi,
    };
  }

  throw new Error(`Cannot parse measurableAs: "${expr}"`);
}

export function measurableAsForExpression(expression: ObservableExpression): string {
  if (expression.kind === "direction") {
    return `close(${expression.subject}, +${String(expression.horizonTradingDays)}) > close(${expression.subject}, 0)`;
  }
  if (expression.kind === "relative") {
    return `close(${expression.subjectA}, +${String(expression.horizonTradingDays)}) / close(${expression.subjectA}, 0) > close(${expression.subjectB}, +${String(expression.horizonTradingDays)}) / close(${expression.subjectB}, 0)`;
  }
  if (expression.kind === "volatility") {
    return `max(close(${expression.subject}), 0..+${String(expression.horizonTradingDays)}) > ${String(expression.threshold)}`;
  }
  return `close(${expression.subject}, +${String(expression.horizonTradingDays)}) outside [${String(expression.lo)}, ${String(expression.hi)}]`;
}

export function subjectForExpression(expression: ObservableExpression): string {
  return expression.kind === "relative"
    ? `${expression.subjectA}:${expression.subjectB}`
    : expression.subject;
}

export function instrumentsForExpression(expression: ObservableExpression): readonly string[] {
  return expression.kind === "relative"
    ? [expression.subjectA, expression.subjectB]
    : [expression.subject];
}

function validateProjection(
  id: string,
  kind: PredictionKind,
  subject: string,
  horizonTradingDays: number,
  expression: ObservableExpression,
): ObservableForecastIssue | undefined {
  if (kind !== expression.kind) {
    return issue("field-mismatch", `Prediction ${id}: kind does not match measurableAs`, id);
  }
  if (subject !== subjectForExpression(expression)) {
    return issue("field-mismatch", `Prediction ${id}: subject does not match measurableAs`, id);
  }
  if (horizonTradingDays !== expression.horizonTradingDays) {
    return issue(
      "field-mismatch",
      `Prediction ${id}: horizonTradingDays does not match measurableAs`,
      id,
    );
  }
  return undefined;
}

function parseExpressionCandidate(
  id: string,
  measurableAs: string,
): ObservableExpression | ObservableForecastIssue {
  try {
    return parseObservableExpression(measurableAs);
  } catch {
    return issue(
      "unparseable-measurable",
      `Prediction ${id}: unparseable measurableAs: "${measurableAs}"`,
      id,
    );
  }
}

function resolveCandidate(
  item: unknown,
  policy: ObservableForecastPolicy,
): ObservableForecast | ObservableForecastIssue {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return issue("not-object", "Prediction must be an object");
  }

  const p = item as Record<string, unknown>;
  const {
    id: idValue,
    claim: claimValue,
    kind,
    subject: subjectValue,
    measurableAs: measurableAsValue,
    horizonTradingDays: horizonTradingDaysValue,
    probability: probabilityValue,
    sourceIds: sourceIdsValue,
  } = p;
  const id = typeof idValue === "string" ? idValue : undefined;
  const claim = typeof claimValue === "string" ? claimValue : undefined;
  const subject = typeof subjectValue === "string" ? subjectValue : undefined;
  const measurableAs = typeof measurableAsValue === "string" ? measurableAsValue : undefined;
  const horizonTradingDays =
    typeof horizonTradingDaysValue === "number" ? horizonTradingDaysValue : undefined;
  const probability = typeof probabilityValue === "number" ? probabilityValue : undefined;
  const sourceIds = readStringArray(sourceIdsValue);

  if (id === undefined) {
    return issue("missing-id", "Prediction missing id");
  }
  if (claim === undefined) {
    return issue("missing-claim", `Prediction ${id}: missing claim`, id);
  }
  if (!isPredictionKind(kind)) {
    return issue("invalid-kind", `Prediction ${id}: invalid kind "${String(kind)}"`, id);
  }
  if (subject === undefined) {
    return issue("missing-subject", `Prediction ${id}: missing subject`, id);
  }
  if (kind === "relative" && !/^[^:\s]+:[^:\s]+$/u.test(subject)) {
    return issue(
      "field-mismatch",
      `Prediction ${id}: relative subject must be "A:B" form, got "${subject}"`,
      id,
    );
  }
  if (measurableAs === undefined) {
    return issue("missing-measurable-as", `Prediction ${id}: missing measurableAs`, id);
  }
  if (
    horizonTradingDays === undefined ||
    !Number.isInteger(horizonTradingDays) ||
    horizonTradingDays < 1 ||
    horizonTradingDays > 20
  ) {
    return issue("invalid-horizon", `Prediction ${id}: horizonTradingDays must be 1–20`, id);
  }
  if (
    probability === undefined ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  ) {
    return issue("invalid-probability", `Prediction ${id}: probability must be 0–1`, id);
  }
  if (TRADE_ACTION_PATTERN.test(claim)) {
    return issue("unsafe-claim", `Prediction ${id}: claim contains trade-action language`, id);
  }
  if (READER_ACTION_PATTERN.test(claim)) {
    return issue("unsafe-claim", `Prediction ${id}: claim contains reader-directed language`, id);
  }

  const expression = parseExpressionCandidate(id, measurableAs);
  if ("code" in expression) {
    return expression;
  }

  const mismatch = validateProjection(id, kind, subject, horizonTradingDays, expression);
  if (mismatch !== undefined) {
    return mismatch;
  }

  const { knownSourceIds } = policy;
  if (knownSourceIds !== undefined) {
    for (const sid of sourceIds) {
      if (!knownSourceIds.has(sid)) {
        return issue("unknown-source", `Prediction ${id}: unknown sourceId "${sid}"`, id);
      }
    }
  }

  const canonicalMeasurableAs = measurableAsForExpression(expression);
  const prediction: Prediction = {
    id,
    claim,
    kind,
    subject,
    measurableAs: canonicalMeasurableAs,
    horizonTradingDays,
    probability,
    sourceIds,
  };

  return {
    prediction,
    expression,
    instruments: instrumentsForExpression(expression),
    measurableAs: canonicalMeasurableAs,
    subject,
    horizonTradingDays,
  };
}

export function observableForecastFromPrediction(
  prediction: Prediction,
): ObservableForecast | ObservableForecastIssue {
  return resolveCandidate(prediction, {});
}

export function readObservableForecasts(
  value: unknown,
  policy: ObservableForecastPolicy = {},
): ObservableForecastReadResult {
  const candidates = Array.isArray(value) ? value : [];
  const resolvedCandidates = candidates.map((candidate) => resolveCandidate(candidate, policy));
  const forecasts = resolvedCandidates.filter(
    (item): item is ObservableForecast => "prediction" in item,
  );
  const issues = resolvedCandidates.filter(
    (item): item is ObservableForecastIssue => !("prediction" in item),
  );

  return {
    forecasts,
    predictions: forecasts.map((forecast) => forecast.prediction),
    issues,
    promptErrors: issues.map((item) => item.message),
  };
}

function sortedCloses(closePrices: readonly CloseAtDate[], symbol: string): readonly CloseAtDate[] {
  return closePrices
    .filter((close) => close.symbol === symbol)
    .toSorted((left, right) => left.date.localeCompare(right.date));
}

function resolvedForecast(
  outcome: "hit" | "miss",
  evidence: Record<string, unknown>,
): ObservableForecastResolved {
  return { status: "resolved", outcome, evidence };
}

function unresolved(
  reason: ObservableForecastUnresolved["reason"],
  missingInstruments: readonly string[],
): ObservableForecastUnresolved {
  return { status: "unresolved", reason, missingInstruments };
}

export function resolveObservableForecast(
  forecast: ObservableForecast,
  closePrices: readonly CloseAtDate[],
): ObservableForecastResolution {
  const { expression } = forecast;

  if (expression.kind === "direction") {
    const closes = sortedCloses(closePrices, expression.subject);
    const close0 = closes[0]?.close;
    const closeN = closes.at(-1)?.close;
    if (close0 === undefined || closeN === undefined) {
      return unresolved("missing-horizon", [expression.subject]);
    }
    return resolvedForecast(closeN > close0 ? "hit" : "miss", { close0, closeN });
  }

  if (expression.kind === "relative") {
    const closesA = sortedCloses(closePrices, expression.subjectA);
    const closesB = sortedCloses(closePrices, expression.subjectB);
    const closeA0 = closesA[0]?.close;
    const closeAN = closesA.at(-1)?.close;
    const closeB0 = closesB[0]?.close;
    const closeBN = closesB.at(-1)?.close;
    const missing = [
      ...(closeA0 === undefined || closeAN === undefined ? [expression.subjectA] : []),
      ...(closeB0 === undefined || closeBN === undefined ? [expression.subjectB] : []),
    ];
    if (
      missing.length > 0 ||
      closeA0 === undefined ||
      closeAN === undefined ||
      closeB0 === undefined ||
      closeBN === undefined
    ) {
      return unresolved("missing-horizon", missing);
    }
    const returnA = closeAN / closeA0;
    const returnB = closeBN / closeB0;
    return resolvedForecast(returnA > returnB ? "hit" : "miss", { returnA, returnB });
  }

  if (expression.kind === "volatility") {
    const closes = sortedCloses(closePrices, expression.subject).map((close) => close.close);
    if (closes.length === 0) {
      return unresolved("missing-window", [expression.subject]);
    }
    const maxClose = Math.max(...closes);
    return resolvedForecast(maxClose > expression.threshold ? "hit" : "miss", {
      maxClose,
      threshold: expression.threshold,
    });
  }

  const closes = sortedCloses(closePrices, expression.subject);
  const closeN = closes.at(-1)?.close;
  if (closeN === undefined) {
    return unresolved("missing-horizon", [expression.subject]);
  }
  return resolvedForecast(closeN < expression.lo || closeN > expression.hi ? "hit" : "miss", {
    closeN,
    lo: expression.lo,
    hi: expression.hi,
  });
}
