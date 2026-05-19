import type { PredictionKind } from "../domain/types";
import { parseObservableExpression, type ObservableExpression } from "../forecast/observable";

export interface ParsedDirection {
  readonly kind: "direction";
  readonly subject: string;
  readonly horizonN: number;
}

export interface ParsedRelative {
  readonly kind: "relative";
  readonly subjectA: string;
  readonly subjectB: string;
  readonly horizonN: number;
}

export interface ParsedVolatility {
  readonly kind: "volatility";
  readonly subject: string;
  readonly horizonN: number;
  readonly threshold: number;
}

export interface ParsedRange {
  readonly kind: "range";
  readonly subject: string;
  readonly horizonN: number;
  readonly lo: number;
  readonly hi: number;
}

export type ParsedMeasurable = ParsedDirection | ParsedRelative | ParsedVolatility | ParsedRange;

function toParsedMeasurable(expression: ObservableExpression): ParsedMeasurable {
  if (expression.kind === "direction") {
    return {
      kind: "direction",
      subject: expression.subject,
      horizonN: expression.horizonTradingDays,
    };
  }

  if (expression.kind === "relative") {
    return {
      kind: "relative",
      subjectA: expression.subjectA,
      subjectB: expression.subjectB,
      horizonN: expression.horizonTradingDays,
    };
  }

  if (expression.kind === "volatility") {
    return {
      kind: "volatility",
      subject: expression.subject,
      horizonN: expression.horizonTradingDays,
      threshold: expression.threshold,
    };
  }

  return {
    kind: "range",
    subject: expression.subject,
    horizonN: expression.horizonTradingDays,
    lo: expression.lo,
    hi: expression.hi,
  };
}

export function parseMeasurableAs(expr: string): ParsedMeasurable {
  return toParsedMeasurable(parseObservableExpression(expr));
}

export function measurableKind(expr: string): PredictionKind {
  return parseMeasurableAs(expr).kind;
}
