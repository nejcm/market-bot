import type { Prediction } from "../domain/types";

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

export type ObservableBaseExpression =
  | ObservableDirection
  | ObservableRelative
  | ObservableVolatility
  | ObservableRange
  | ObservableMacro
  | ObservableIv;

export interface ObservableConditional {
  readonly kind: "conditional";
  readonly antecedent: ObservableBaseExpression;
  readonly consequent: ObservableBaseExpression;
  readonly horizonTradingDays: number;
}

export type ObservableExpression = ObservableBaseExpression | ObservableConditional;

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

export interface ObservableForecastVoided {
  readonly status: "voided";
  readonly evidence: Record<string, unknown>;
}

export interface ObservableForecastUnresolved {
  readonly status: "unresolved";
  readonly reason: "missing-origin" | "missing-horizon" | "missing-window";
  readonly missingInstruments: readonly string[];
}

export type ObservableForecastResolution =
  | ObservableForecastResolved
  | ObservableForecastVoided
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
      readonly horizonTradingDays: number;
    }
  | {
      readonly mode: "point";
      readonly requests: readonly PointObservationRequest[];
      readonly includeOrigin: boolean;
      readonly horizonTradingDays: number;
    }
  | {
      readonly mode: "composite";
      readonly strategies: readonly ObservationStrategy[];
    };
