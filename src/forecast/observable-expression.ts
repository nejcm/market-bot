import type { PredictionKind } from "../domain/types";
import type {
  ObservableBaseExpression,
  ObservableExpression,
  ObservableForecast,
  ObservableForecastResolution,
  Observation,
  ObservationStrategy,
} from "./observable-types";
import {
  BASE_PREDICTION_SHAPES,
  directionShape,
  earningsDirectionShape,
  earningsMoveShape,
  ivShape,
  macroShape,
  rangeShape,
  relativeShape,
  uniqueStrings,
  volatilityShape,
  type AnyPredictionShape,
  type PredictionShape,
} from "./observable-shapes";

export function isPredictionKind(value: unknown): value is PredictionKind {
  return typeof value === "string" && value in PREDICTION_SHAPE_BY_KIND;
}

function splitConditionalExpression(expr: string):
  | {
      readonly antecedent: string;
      readonly consequent: string;
    }
  | undefined {
  if (!expr.startsWith("if (")) {
    return undefined;
  }
  const antecedentStart = "if (".length - 1;
  const antecedentEnd = matchingParenIndex(expr, antecedentStart);
  if (antecedentEnd === undefined) {
    return undefined;
  }
  const between = expr.slice(antecedentEnd + 1).trimStart();
  if (!between.startsWith("then (")) {
    return undefined;
  }
  const consequentOpen =
    antecedentEnd + 1 + (expr.slice(antecedentEnd + 1).length - between.length) + "then ".length;
  const consequentEnd = matchingParenIndex(expr, consequentOpen);
  if (consequentEnd === undefined || expr.slice(consequentEnd + 1).trim() !== "") {
    return undefined;
  }
  return {
    antecedent: expr.slice(antecedentStart + 1, antecedentEnd),
    consequent: expr.slice(consequentOpen + 1, consequentEnd),
  };
}

function matchingParenIndex(expr: string, openIndex: number): number | undefined {
  if (expr[openIndex] !== "(") {
    return undefined;
  }
  let depth = 0;
  for (let idx = openIndex; idx < expr.length; idx += 1) {
    const char = expr[idx];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return idx;
      }
    }
  }
  return undefined;
}

function parseBaseObservableExpression(expr: string): ObservableBaseExpression {
  const s = expr.trim();
  for (const shape of BASE_PREDICTION_SHAPES) {
    const expression = shape.parse(s);
    if (expression !== undefined) {
      return expression;
    }
  }

  throw new Error(`Cannot parse measurableAs: "${expr}"`);
}

const conditionalShape: PredictionShape<"conditional"> = {
  kind: "conditional",

  parse(expr) {
    const parts = splitConditionalExpression(expr);
    if (parts === undefined) {
      return;
    }
    const antecedent = parseBaseObservableExpression(parts.antecedent);
    const consequent = parseBaseObservableExpression(parts.consequent);
    return {
      kind: "conditional",
      antecedent,
      consequent,
      horizonTradingDays: consequent.horizonTradingDays,
    };
  },

  measurableAs(expression) {
    return `if (${measurableAsForExpression(expression.antecedent)}) then (${measurableAsForExpression(expression.consequent)})`;
  },

  renderClaim(expression) {
    return `If ${renderClaim(expression.antecedent)}, then ${renderClaim(expression.consequent)}`;
  },

  subject(expression) {
    return subjectForExpression(expression.consequent);
  },

  instruments(expression) {
    return uniqueStrings([
      ...instrumentsForExpression(expression.antecedent),
      ...instrumentsForExpression(expression.consequent),
    ]);
  },

  observationStrategy(expression) {
    return {
      mode: "composite",
      strategies: [
        observationStrategyForExpression(expression.antecedent),
        observationStrategyForExpression(expression.consequent),
      ],
    };
  },

  resolve(expression, observations) {
    const antecedent = resolveObservableExpression(expression.antecedent, observations);
    if (antecedent.status === "unresolved") {
      return antecedent;
    }
    if (antecedent.status === "voided") {
      return antecedent;
    }
    if (antecedent.outcome === "miss") {
      return {
        status: "voided",
        evidence: {
          reason: "conditional antecedent did not occur",
          antecedent: antecedent.evidence,
        },
      };
    }
    const consequent = resolveObservableExpression(expression.consequent, observations);
    if (consequent.status === "resolved") {
      return {
        status: "resolved",
        outcome: consequent.outcome,
        evidence: { antecedent: antecedent.evidence, consequent: consequent.evidence },
      };
    }
    return consequent;
  },
};

const PREDICTION_SHAPES: readonly AnyPredictionShape[] = [
  ...BASE_PREDICTION_SHAPES,
  conditionalShape,
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
  "earnings-direction": earningsDirectionShape,
  "earnings-move": earningsMoveShape,
  conditional: conditionalShape,
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

export function instrumentsForMeasurableAs(measurableAs: string): readonly string[] {
  try {
    return instrumentsForExpression(parseObservableExpression(measurableAs));
  } catch {
    return [];
  }
}

export function observationStrategyForExpression(
  expression: ObservableExpression,
): ObservationStrategy {
  return shapeForExpression(expression).observationStrategy(expression);
}

export function observationStrategyForForecast(forecast: ObservableForecast): ObservationStrategy {
  return observationStrategyForExpression(forecast.expression);
}

export function resolveObservableForecast(
  forecast: ObservableForecast,
  observations: readonly Observation[],
): ObservableForecastResolution {
  return resolveObservableExpression(forecast.expression, observations);
}

export function resolveObservableExpression(
  expression: ObservableExpression,
  observations: readonly Observation[],
): ObservableForecastResolution {
  return shapeForExpression(expression).resolve(expression, observations);
}
