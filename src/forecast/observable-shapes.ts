import type { PredictionKind } from "../domain/types";
import type {
  ObservableExpression,
  ObservableForecastIssue,
  ObservableForecastResolution,
  ObservableForecastResolved,
  ObservableForecastUnresolved,
  Observation,
  ObservationStrategy,
} from "./observable-types";

const SYMBOL = String.raw`([\w\^]+(?:\.[\w]+)*(?::[.\w]+)*)`;
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

const DATE = String.raw`(\d{4}-\d{2}-\d{2})`;
const EARNINGS_DIRECTION_RE = new RegExp(
  String.raw`^earningsReturn\(${SYMBOL},\s*${DATE},\s*\+${N}\)\s*>\s*0$`,
  "u",
);
const EARNINGS_MOVE_RE = new RegExp(
  String.raw`^abs\(earningsReturn\(${SYMBOL},\s*${DATE},\s*\+${N}\)\)\s*>\s*${NUM}$`,
  "u",
);

type ObservableExpressionOf<K extends PredictionKind> = Extract<
  ObservableExpression,
  { readonly kind: K }
>;
type BasePredictionKind = Exclude<PredictionKind, "conditional">;

export interface PredictionShape<K extends PredictionKind> {
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

export type AnyPredictionShape = {
  readonly [K in PredictionKind]: PredictionShape<K>;
}[PredictionKind];
export type AnyBasePredictionShape = {
  readonly [K in BasePredictionKind]: PredictionShape<K>;
}[BasePredictionKind];

export function issue(
  code: ObservableForecastIssue["code"],
  message: string,
  predictionId?: string,
): ObservableForecastIssue {
  return predictionId === undefined ? { code, message } : { code, message, predictionId };
}

export const directionShape: PredictionShape<"direction"> = {
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
    return {
      mode: "close-window",
      subjects: [expression.subject],
      horizonTradingDays: expression.horizonTradingDays,
    };
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

export const relativeShape: PredictionShape<"relative"> = {
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
    return {
      mode: "close-window",
      subjects: [expression.subjectA, expression.subjectB],
      horizonTradingDays: expression.horizonTradingDays,
    };
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

export const volatilityShape: PredictionShape<"volatility"> = {
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
    return {
      mode: "close-window",
      subjects: [expression.subject],
      horizonTradingDays: expression.horizonTradingDays,
    };
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

export const rangeShape: PredictionShape<"range"> = {
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
    return {
      mode: "close-window",
      subjects: [expression.subject],
      horizonTradingDays: expression.horizonTradingDays,
    };
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

export const macroShape: PredictionShape<"macro"> = {
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
      horizonTradingDays: expression.horizonTradingDays,
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

export const ivShape: PredictionShape<"iv"> = {
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
      horizonTradingDays: expression.horizonTradingDays,
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

export const earningsDirectionShape: PredictionShape<"earnings-direction"> = {
  kind: "earnings-direction",

  parse(expr) {
    const match = EARNINGS_DIRECTION_RE.exec(expr);
    if (match === null) {
      return;
    }
    return {
      kind: "earnings-direction",
      subject: match[1] as string,
      eventDate: match[2] as string,
      horizonTradingDays: Number(match[3]),
    };
  },

  measurableAs(expression) {
    return `earningsReturn(${expression.subject}, ${expression.eventDate}, +${String(expression.horizonTradingDays)}) > 0`;
  },

  renderClaim(expression) {
    return `${expression.subject} closes higher than its pre-earnings close ${String(expression.horizonTradingDays)} trading days after the ${expression.eventDate} earnings event`;
  },

  subject(expression) {
    return expression.subject;
  },

  instruments(expression) {
    return [expression.subject];
  },

  observationStrategy(expression) {
    return {
      mode: "earnings-close-window",
      subject: expression.subject,
      eventDate: expression.eventDate,
      horizonTradingDays: expression.horizonTradingDays,
    };
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

export const earningsMoveShape: PredictionShape<"earnings-move"> = {
  kind: "earnings-move",

  parse(expr) {
    const match = EARNINGS_MOVE_RE.exec(expr);
    if (match === null) {
      return;
    }
    return {
      kind: "earnings-move",
      subject: match[1] as string,
      eventDate: match[2] as string,
      horizonTradingDays: Number(match[3]),
      threshold: Number(match[4]),
    };
  },

  measurableAs(expression) {
    return `abs(earningsReturn(${expression.subject}, ${expression.eventDate}, +${String(expression.horizonTradingDays)})) > ${String(expression.threshold)}`;
  },

  renderClaim(expression) {
    const pct = (expression.threshold * 100).toFixed(1);
    return `${expression.subject} moves more than ${pct}% from its pre-earnings close ${String(expression.horizonTradingDays)} trading days after the ${expression.eventDate} earnings event`;
  },

  subject(expression) {
    return expression.subject;
  },

  instruments(expression) {
    return [expression.subject];
  },

  observationStrategy(expression) {
    return {
      mode: "earnings-close-window",
      subject: expression.subject,
      eventDate: expression.eventDate,
      horizonTradingDays: expression.horizonTradingDays,
    };
  },

  resolve(expression, observations) {
    const closes = sortedObservations(observations, expression.subject);
    const close0 = closes[0]?.value;
    const closeN = closes.at(-1)?.value;
    if (close0 === undefined || closeN === undefined || close0 === 0) {
      return unresolved("missing-horizon", [expression.subject]);
    }
    const returnPct = (closeN - close0) / close0;
    return resolvedForecast(Math.abs(returnPct) > expression.threshold ? "hit" : "miss", {
      close0,
      closeN,
      returnPct,
      threshold: expression.threshold,
    });
  },
};

export function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export const BASE_PREDICTION_SHAPES: readonly AnyBasePredictionShape[] = [
  directionShape,
  relativeShape,
  volatilityShape,
  rangeShape,
  macroShape,
  ivShape,
  earningsDirectionShape,
  earningsMoveShape,
];

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
