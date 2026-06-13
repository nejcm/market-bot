import type { Prediction, PredictionKind } from "../domain/types";
import { stringArrayValue } from "../sources/guards";

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

export interface ObservableMacro {
  readonly kind: "macro";
  readonly seriesId: string;
  readonly horizonTradingDays: number;
}

export interface ObservableIv {
  readonly kind: "iv";
  readonly subject: string;
  readonly horizonTradingDays: number;
  readonly threshold: number;
}

export type ObservableExpression =
  | ObservableDirection
  | ObservableRelative
  | ObservableVolatility
  | ObservableRange
  | ObservableMacro
  | ObservableIv;

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
    | "invalid-kind"
    | "missing-subject"
    | "missing-measurable-as"
    | "invalid-horizon"
    | "invalid-probability"
    | "unparseable-measurable"
    | "field-mismatch"
    | "unknown-source"
    | "redundant-prediction";
  readonly message: string;
}

export interface ObservableForecastReadResult {
  readonly forecasts: readonly ObservableForecast[];
  readonly predictions: readonly Prediction[];
  readonly issues: readonly ObservableForecastIssue[];
  readonly promptErrors: readonly string[];
}

export interface Observation {
  readonly subject: string;
  readonly date: string;
  readonly value: number;
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

export type PointObservationRequest =
  | {
      readonly kind: "fred";
      readonly subject: string;
      readonly observationSubject: string;
    }
  | {
      readonly kind: "iv";
      readonly subject: string;
      readonly observationSubject: string;
    };

export type ObservationStrategy =
  | {
      readonly mode: "close-window";
      readonly subjects: readonly string[];
    }
  | {
      readonly mode: "point";
      readonly requests: readonly PointObservationRequest[];
      readonly includeOrigin: boolean;
    };

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
const FRED_RE = new RegExp(String.raw`^fred\(([A-Z0-9_]+),\s*\+${N}\)\s*>\s*fred\(\1,\s*0\)$`, "u");
const IV_RE = new RegExp(String.raw`^iv\(${SYMBOL},\s*\+${N}\)\s*>\s*${NUM}$`, "u");

type ObservableExpressionOf<K extends PredictionKind> = Extract<
  ObservableExpression,
  { readonly kind: K }
>;

interface PredictionShape<K extends PredictionKind> {
  readonly kind: K;
  readonly parse: (expr: string) => ObservableExpressionOf<K> | undefined;
  readonly measurableAs: (expression: ObservableExpressionOf<K>) => string;
  readonly renderClaim: (expression: ObservableExpressionOf<K>) => string;
  readonly subject: (expression: ObservableExpressionOf<K>) => string;
  readonly instruments: (expression: ObservableExpressionOf<K>) => readonly string[];
  readonly observationStrategy: (expression: ObservableExpressionOf<K>) => ObservationStrategy;
  readonly resolve: (
    expression: ObservableExpressionOf<K>,
    observations: readonly Observation[],
  ) => ObservableForecastResolution;
}

type AnyPredictionShape = {
  readonly [K in PredictionKind]: PredictionShape<K>;
}[PredictionKind];

function isPredictionKind(value: unknown): value is PredictionKind {
  return typeof value === "string" && value in PREDICTION_SHAPE_BY_KIND;
}

function issue(
  code: ObservableForecastIssue["code"],
  message: string,
  predictionId?: string,
): ObservableForecastIssue {
  return predictionId === undefined ? { code, message } : { code, message, predictionId };
}

const directionShape: PredictionShape<"direction"> = {
  kind: "direction",

  parse(expr) {
    const dir = DIRECTION_RE.exec(expr);
    if (dir === null) {
      return;
    }
    return { kind: "direction", subject: dir[1] as string, horizonTradingDays: Number(dir[2]) };
  },

  measurableAs(expression) {
    return `close(${expression.subject}, +${String(expression.horizonTradingDays)}) > close(${expression.subject}, 0)`;
  },

  renderClaim(expression) {
    return `${expression.subject} closes higher than today over ${String(expression.horizonTradingDays)} trading days`;
  },

  subject(expression) {
    return expression.subject;
  },

  instruments(expression) {
    return [expression.subject];
  },

  observationStrategy(expression) {
    return { mode: "close-window", subjects: [expression.subject] };
  },

  resolve(expression, observations) {
    const closes = sortedObservations(observations, expression.subject);
    const close0 = closes[0]?.value;
    const closeN = closes.at(-1)?.value;
    if (close0 === undefined || closeN === undefined) {
      return unresolved("missing-horizon", [expression.subject]);
    }
    return resolvedForecast(closeN > close0 ? "hit" : "miss", { close0, closeN });
  },
};

const relativeShape: PredictionShape<"relative"> = {
  kind: "relative",

  parse(expr) {
    const rel = RELATIVE_RE.exec(expr);
    if (rel === null) {
      return;
    }
    return {
      kind: "relative",
      subjectA: rel[1] as string,
      subjectB: rel[3] as string,
      horizonTradingDays: Number(rel[2]),
    };
  },

  measurableAs(expression) {
    return `close(${expression.subjectA}, +${String(expression.horizonTradingDays)}) / close(${expression.subjectA}, 0) > close(${expression.subjectB}, +${String(expression.horizonTradingDays)}) / close(${expression.subjectB}, 0)`;
  },

  renderClaim(expression) {
    return `${expression.subjectA} outperforms ${expression.subjectB} over ${String(expression.horizonTradingDays)} trading days`;
  },

  subject(expression) {
    return `${expression.subjectA}:${expression.subjectB}`;
  },

  instruments(expression) {
    return [expression.subjectA, expression.subjectB];
  },

  observationStrategy(expression) {
    return { mode: "close-window", subjects: [expression.subjectA, expression.subjectB] };
  },

  resolve(expression, observations) {
    const closesA = sortedObservations(observations, expression.subjectA);
    const closesB = sortedObservations(observations, expression.subjectB);
    const closeA0 = closesA[0]?.value;
    const closeAN = closesA.at(-1)?.value;
    const closeB0 = closesB[0]?.value;
    const closeBN = closesB.at(-1)?.value;
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
  },
};

const volatilityShape: PredictionShape<"volatility"> = {
  kind: "volatility",

  parse(expr) {
    const vol = VOLATILITY_RE.exec(expr);
    if (vol === null) {
      return;
    }
    return {
      kind: "volatility",
      subject: vol[1] as string,
      horizonTradingDays: Number(vol[2]),
      threshold: Number(vol[3]),
    };
  },

  measurableAs(expression) {
    return `max(close(${expression.subject}), 0..+${String(expression.horizonTradingDays)}) > ${String(expression.threshold)}`;
  },

  renderClaim(expression) {
    return `${expression.subject} trades above ${String(expression.threshold)} within ${String(expression.horizonTradingDays)} trading days`;
  },

  subject(expression) {
    return expression.subject;
  },

  instruments(expression) {
    return [expression.subject];
  },

  observationStrategy(expression) {
    return { mode: "close-window", subjects: [expression.subject] };
  },

  resolve(expression, observations) {
    const closes = sortedObservations(observations, expression.subject).map(
      (observation) => observation.value,
    );
    if (closes.length === 0) {
      return unresolved("missing-window", [expression.subject]);
    }
    const maxClose = Math.max(...closes);
    return resolvedForecast(maxClose > expression.threshold ? "hit" : "miss", {
      maxClose,
      threshold: expression.threshold,
    });
  },
};

const rangeShape: PredictionShape<"range"> = {
  kind: "range",

  parse(expr) {
    const range = RANGE_RE.exec(expr);
    if (range === null) {
      return;
    }
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
  },

  measurableAs(expression) {
    return `close(${expression.subject}, +${String(expression.horizonTradingDays)}) outside [${String(expression.lo)}, ${String(expression.hi)}]`;
  },

  renderClaim(expression) {
    return `${expression.subject} closes outside ${String(expression.lo)}-${String(expression.hi)} over ${String(expression.horizonTradingDays)} trading days`;
  },

  subject(expression) {
    return expression.subject;
  },

  instruments(expression) {
    return [expression.subject];
  },

  observationStrategy(expression) {
    return { mode: "close-window", subjects: [expression.subject] };
  },

  resolve(expression, observations) {
    const closes = sortedObservations(observations, expression.subject);
    const closeN = closes.at(-1)?.value;
    if (closeN === undefined) {
      return unresolved("missing-horizon", [expression.subject]);
    }
    return resolvedForecast(closeN < expression.lo || closeN > expression.hi ? "hit" : "miss", {
      closeN,
      lo: expression.lo,
      hi: expression.hi,
    });
  },
};

const macroShape: PredictionShape<"macro"> = {
  kind: "macro",

  parse(expr) {
    const fred = FRED_RE.exec(expr);
    if (fred === null) {
      return;
    }
    return { kind: "macro", seriesId: fred[1] as string, horizonTradingDays: Number(fred[2]) };
  },

  measurableAs(expression) {
    return `fred(${expression.seriesId}, +${String(expression.horizonTradingDays)}) > fred(${expression.seriesId}, 0)`;
  },

  renderClaim(expression) {
    return `${expression.seriesId} rises over ${String(expression.horizonTradingDays)} trading days`;
  },

  subject(expression) {
    return expression.seriesId;
  },

  instruments(expression) {
    return [`FRED:${expression.seriesId}`];
  },

  observationStrategy(expression) {
    return {
      mode: "point",
      requests: [
        {
          kind: "fred",
          subject: expression.seriesId,
          observationSubject: `FRED:${expression.seriesId}`,
        },
      ],
      includeOrigin: true,
    };
  },

  resolve(expression, observations) {
    const subject = `FRED:${expression.seriesId}`;
    const closes = sortedObservations(observations, subject);
    const [origin] = closes;
    const horizon = closes.at(-1);
    if (origin === undefined) {
      return unresolved("missing-origin", [subject]);
    }
    if (horizon === undefined || horizon.date === origin.date) {
      return unresolved("missing-horizon", [subject]);
    }
    return resolvedForecast(horizon.value > origin.value ? "hit" : "miss", {
      seriesId: expression.seriesId,
      fred0: origin.value,
      fredN: horizon.value,
      date0: origin.date,
      dateN: horizon.date,
    });
  },
};

const ivShape: PredictionShape<"iv"> = {
  kind: "iv",

  parse(expr) {
    const iv = IV_RE.exec(expr);
    if (iv === null) {
      return;
    }
    return {
      kind: "iv",
      subject: iv[1] as string,
      horizonTradingDays: Number(iv[2]),
      threshold: Number(iv[3]),
    };
  },

  measurableAs(expression) {
    return `iv(${expression.subject}, +${String(expression.horizonTradingDays)}) > ${String(expression.threshold)}`;
  },

  renderClaim(expression) {
    return `${expression.subject} implied volatility is above ${String(expression.threshold)} in ${String(expression.horizonTradingDays)} trading days`;
  },

  subject(expression) {
    return expression.subject;
  },

  instruments(expression) {
    return [`IV:${expression.subject}`];
  },

  observationStrategy(expression) {
    return {
      mode: "point",
      requests: [
        {
          kind: "iv",
          subject: expression.subject,
          observationSubject: `IV:${expression.subject}`,
        },
      ],
      includeOrigin: false,
    };
  },

  resolve(expression, observations) {
    const subject = `IV:${expression.subject}`;
    const closes = sortedObservations(observations, subject);
    const horizon = closes.at(-1);
    if (horizon === undefined) {
      return unresolved("missing-horizon", [subject]);
    }
    return resolvedForecast(horizon.value > expression.threshold ? "hit" : "miss", {
      subject: expression.subject,
      ivN: horizon.value,
      threshold: expression.threshold,
      dateN: horizon.date,
    });
  },
};

const PREDICTION_SHAPES: readonly AnyPredictionShape[] = [
  directionShape,
  relativeShape,
  volatilityShape,
  rangeShape,
  macroShape,
  ivShape,
];

const PREDICTION_SHAPE_BY_KIND: {
  readonly [K in PredictionKind]: PredictionShape<K>;
} = {
  direction: directionShape,
  relative: relativeShape,
  volatility: volatilityShape,
  range: rangeShape,
  macro: macroShape,
  iv: ivShape,
};

function shapeByKind<K extends PredictionKind>(kind: K): PredictionShape<K> {
  return PREDICTION_SHAPE_BY_KIND[kind];
}

function shapeForExpression<E extends ObservableExpression>(
  expression: E,
): PredictionShape<E["kind"]> {
  const shape = shapeByKind(expression.kind);
  return shape;
}

export function parseObservableExpression(expr: string): ObservableExpression {
  const s = expr.trim();
  for (const shape of PREDICTION_SHAPES) {
    const expression = shape.parse(s);
    if (expression !== undefined) {
      return expression;
    }
  }

  throw new Error(`Cannot parse measurableAs: "${expr}"`);
}

export function measurableAsForExpression(expression: ObservableExpression): string {
  return shapeForExpression(expression).measurableAs(expression);
}

export function renderClaim(expression: ObservableExpression): string {
  return shapeForExpression(expression).renderClaim(expression);
}

export function renderClaimForMeasurableAs(
  measurableAs: string,
  fallback: string | undefined,
): string | undefined {
  try {
    return renderClaim(parseObservableExpression(measurableAs));
  } catch {
    return fallback;
  }
}

export function subjectForExpression(expression: ObservableExpression): string {
  return shapeForExpression(expression).subject(expression);
}

export function instrumentsForExpression(expression: ObservableExpression): readonly string[] {
  return shapeForExpression(expression).instruments(expression);
}

function observationStrategyForExpression(expression: ObservableExpression): ObservationStrategy {
  return shapeForExpression(expression).observationStrategy(expression);
}

export function observationStrategyForForecast(forecast: ObservableForecast): ObservationStrategy {
  return observationStrategyForExpression(forecast.expression);
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
    claim: renderClaim(expression),
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

function redundancyKey(forecast: ObservableForecast): string {
  return [forecast.prediction.kind, forecast.subject, String(forecast.horizonTradingDays)].join(
    "|",
  );
}

function rejectRedundantForecasts(forecasts: readonly ObservableForecast[]): {
  readonly forecasts: readonly ObservableForecast[];
  readonly issues: readonly ObservableForecastIssue[];
} {
  const measurableSeen = new Set<string>();
  const kindSubjectHorizonSeen = new Set<string>();
  const accepted: ObservableForecast[] = [];
  const issues: ObservableForecastIssue[] = [];

  for (const forecast of forecasts) {
    const { measurableAs, prediction, subject, horizonTradingDays } = forecast;
    if (measurableSeen.has(measurableAs)) {
      issues.push(
        issue(
          "redundant-prediction",
          `Prediction ${prediction.id}: duplicate measurableAs "${measurableAs}"`,
          prediction.id,
        ),
      );
      continue;
    }

    const key = redundancyKey(forecast);
    if (kindSubjectHorizonSeen.has(key)) {
      issues.push(
        issue(
          "redundant-prediction",
          `Prediction ${prediction.id}: redundant ${prediction.kind} forecast for ${subject} at ${String(horizonTradingDays)} trading days`,
          prediction.id,
        ),
      );
      continue;
    }

    measurableSeen.add(measurableAs);
    kindSubjectHorizonSeen.add(key);
    accepted.push(forecast);
  }

  return { forecasts: accepted, issues };
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
  const accepted = rejectRedundantForecasts(forecasts);
  const allIssues = [...issues, ...accepted.issues];

  return {
    forecasts: accepted.forecasts,
    predictions: accepted.forecasts.map((forecast) => forecast.prediction),
    issues: allIssues,
    promptErrors: allIssues.map((item) => item.message),
  };
}

function sortedObservations(
  observations: readonly Observation[],
  subject: string,
): readonly Observation[] {
  return observations
    .filter((observation) => observation.subject === subject)
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
  observations: readonly Observation[],
): ObservableForecastResolution {
  return shapeForExpression(forecast.expression).resolve(forecast.expression, observations);
}
