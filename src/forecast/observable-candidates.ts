import type { Prediction, PredictionKind } from "../domain/types";
import { stringArrayValue } from "../guards";
import type {
  ObservableExpression,
  ObservableForecast,
  ObservableForecastIssue,
  ObservableForecastPolicy,
} from "./observable-types";
import { issue } from "./observable-shapes";
import {
  instrumentsForExpression,
  isPredictionKind,
  measurableAsForExpression,
  parseObservableExpression,
  renderClaim,
  subjectForExpression,
} from "./observable-expression";

export const MIN_PREDICTION_HORIZON_TRADING_DAYS = 1;
export const MAX_PREDICTION_HORIZON_TRADING_DAYS = 20;

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
  if (
    expression.kind === "conditional" &&
    expression.antecedent.horizonTradingDays >= expression.consequent.horizonTradingDays
  ) {
    return issue(
      "invalid-horizon",
      `Prediction ${id}: conditional antecedent horizon must be earlier than consequent horizon`,
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

export function resolveCandidate(
  item: unknown,
  policy: ObservableForecastPolicy,
): ObservableForecast | ObservableForecastIssue {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return issue("not-object", "Prediction must be an object");
  }

  const p = item as Record<string, unknown>;
  const {
    id: idValue,
    kind,
    subject: subjectValue,
    measurableAs: measurableAsValue,
    horizonTradingDays: horizonTradingDaysValue,
    probability: probabilityValue,
    sourceIds: sourceIdsValue,
  } = p;
  const id = typeof idValue === "string" ? idValue : undefined;
  const subject = typeof subjectValue === "string" ? subjectValue : undefined;
  const measurableAs = typeof measurableAsValue === "string" ? measurableAsValue : undefined;
  const horizonTradingDays =
    typeof horizonTradingDaysValue === "number" ? horizonTradingDaysValue : undefined;
  const probability = typeof probabilityValue === "number" ? probabilityValue : undefined;
  const sourceIds = stringArrayValue(sourceIdsValue);

  if (id === undefined) {
    return issue("missing-id", "Prediction missing id");
  }
  if (!isPredictionKind(kind)) {
    return issue("invalid-kind", `Prediction ${id}: invalid kind "${String(kind)}"`, id);
  }
  if (subject === undefined) {
    return issue("missing-subject", `Prediction ${id}: missing subject`, id);
  }
  if (measurableAs === undefined) {
    return issue("missing-measurable-as", `Prediction ${id}: missing measurableAs`, id);
  }
  if (
    horizonTradingDays === undefined ||
    !Number.isInteger(horizonTradingDays) ||
    horizonTradingDays < MIN_PREDICTION_HORIZON_TRADING_DAYS ||
    horizonTradingDays > MAX_PREDICTION_HORIZON_TRADING_DAYS
  ) {
    return issue(
      "invalid-horizon",
      `Prediction ${id}: horizonTradingDays must be ${MIN_PREDICTION_HORIZON_TRADING_DAYS}–${MAX_PREDICTION_HORIZON_TRADING_DAYS}`,
      id,
    );
  }
  if (
    probability === undefined ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  ) {
    return issue("invalid-probability", `Prediction ${id}: probability must be 0–1`, id);
  }
  const expression = parseExpressionCandidate(id, measurableAs);
  if ("code" in expression) {
    return expression;
  }

  const normalizedSubject = normalizePredictionSubject(kind, subject, expression);
  const mismatch = validateProjection(id, kind, normalizedSubject, horizonTradingDays, expression);
  if (mismatch !== undefined) {
    return mismatch;
  }

  const { knownSourceIds, requireSourceIds, allowedSubjects } = policy;
  if (allowedSubjects !== undefined) {
    // For relative forecasts the normalized subject is "primarySymbol:benchmarkSymbol".
    // Allow the forecast when the primary instrument (before the colon) is in the set.
    const primarySubject = normalizedSubject.includes(":")
      ? (normalizedSubject.split(":")[0] ?? normalizedSubject)
      : normalizedSubject;
    if (!allowedSubjects.has(primarySubject) && !allowedSubjects.has(normalizedSubject)) {
      return issue(
        "disallowed-subject",
        `Prediction ${id}: subject "${normalizedSubject}" is not in the allowed set for this run`,
        id,
      );
    }
  }
  if (knownSourceIds !== undefined) {
    for (const sid of sourceIds) {
      if (!knownSourceIds.has(sid)) {
        return issue("unknown-source", `Prediction ${id}: unknown sourceId "${sid}"`, id);
      }
    }
  }
  if (requireSourceIds === true && sourceIds.length === 0) {
    return issue(
      "missing-sources",
      `Prediction ${id}: predictions must cite at least one sourceId`,
      id,
    );
  }

  const canonicalMeasurableAs = measurableAsForExpression(expression);
  const prediction: Prediction = {
    id,
    claim: renderClaim(expression),
    kind,
    subject: normalizedSubject,
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
    subject: normalizedSubject,
    horizonTradingDays,
  };
}

// A relative forecast's canonical subject is the "primary:benchmark" pair, but models routinely
// Write the bare primary ticker. The projection below finds the relative expression a bare subject
// Could name — the expression itself for kind `relative`, or the consequent for a `conditional`
// That wraps one, since a conditional's subject is defined by its consequent (conditionalShape).
// Both cases are the same authoring slip and normalize identically. A subject that already carries
// A colon, or that does not match the relative primary, is returned untouched so validateProjection
// Still rejects a genuine field mismatch.
function relativeExpressionForSubject(
  kind: PredictionKind,
  expression: ObservableExpression,
): Extract<ObservableExpression, { readonly kind: "relative" }> | undefined {
  if (kind === "relative" && expression.kind === "relative") {
    return expression;
  }
  if (kind === "conditional" && expression.kind === "conditional") {
    const { consequent } = expression;
    return consequent.kind === "relative" ? consequent : undefined;
  }
  return undefined;
}

function normalizePredictionSubject(
  kind: PredictionKind,
  subject: string,
  expression: ObservableExpression,
): string {
  if (subject.includes(":")) {
    return subject;
  }
  const relative = relativeExpressionForSubject(kind, expression);
  return relative !== undefined && subject === relative.subjectA
    ? subjectForExpression(expression)
    : subject;
}
