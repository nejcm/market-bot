import { describe, expect, test } from "bun:test";
import {
  instrumentsForMeasurableAs,
  isPredictionKind,
  MAX_PREDICTION_HORIZON_TRADING_DAYS,
  MIN_PREDICTION_HORIZON_TRADING_DAYS,
  observationStrategyForForecast,
  parseObservableExpression,
  RELATIVE_FORECAST_EQUAL_PROBABILITY_EPSILON,
  readObservableForecasts,
  renderClaim,
  resolveObservableForecast,
  type ObservableExpression,
  type ObservableForecast,
  type ObservationStrategy,
} from "../src/forecast/observable";

function forecastFor(expression: ObservableExpression): ObservableForecast {
  return {
    prediction: {
      id: "p1",
      claim: "test claim",
      kind: expression.kind,
      subject: "test",
      measurableAs: "test",
      horizonTradingDays: expression.horizonTradingDays,
      probability: 0.5,
      sourceIds: [],
    },
    expression,
    instruments: [],
    measurableAs: "test",
    subject: "test",
    horizonTradingDays: expression.horizonTradingDays,
  };
}

describe("parseObservableExpression", () => {
  describe("direction", () => {
    test("parses standard form", () => {
      expect(parseObservableExpression("close(SPY, +5) > close(SPY, 0)")).toEqual({
        kind: "direction",
        subject: "SPY",
        horizonTradingDays: 5,
      });
    });

    test("parses with caret symbol (^VIX)", () => {
      expect(parseObservableExpression("close(^VIX, +3) > close(^VIX, 0)")).toEqual({
        kind: "direction",
        subject: "^VIX",
        horizonTradingDays: 3,
      });
    });

    test("parses without spaces around +N", () => {
      expect(parseObservableExpression("close(QQQ,+10) > close(QQQ, 0)")).toEqual({
        kind: "direction",
        subject: "QQQ",
        horizonTradingDays: 10,
      });
    });

    test("parses dotted exchange suffix symbols", () => {
      expect(parseObservableExpression("close(RR.L, +5) > close(RR.L, 0)")).toEqual({
        kind: "direction",
        subject: "RR.L",
        horizonTradingDays: 5,
      });
    });
  });

  describe("relative", () => {
    test("parses standard form", () => {
      expect(
        parseObservableExpression(
          "close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)",
        ),
      ).toEqual({
        kind: "relative",
        subjectA: "QQQ",
        subjectB: "SPY",
        horizonTradingDays: 5,
      });
    });

    test("parses dotted primary symbols", () => {
      expect(
        parseObservableExpression(
          "close(RR.L, +5) / close(RR.L, 0) > close(QQQ, +5) / close(QQQ, 0)",
        ),
      ).toEqual({
        kind: "relative",
        subjectA: "RR.L",
        subjectB: "QQQ",
        horizonTradingDays: 5,
      });
    });

    test("parses no-space relative expressions", () => {
      expect(
        parseObservableExpression("close(AAPL,+10)/close(AAPL,0) > close(QQQ,+10)/close(QQQ,0)"),
      ).toEqual({
        kind: "relative",
        subjectA: "AAPL",
        subjectB: "QQQ",
        horizonTradingDays: 10,
      });
    });

    test("rejects less-than expressions under the positive-only grammar", () => {
      const measurableAs = "close(AAPL,+10)/close(AAPL,0) < close(QQQ,+10)/close(QQQ,0)";
      const result = readObservableForecasts([
        {
          id: "p1",
          kind: "relative",
          subject: "AAPL:QQQ",
          measurableAs,
          horizonTradingDays: 10,
          probability: 0.4,
          sourceIds: [],
        },
      ]);

      expect(result.predictions).toEqual([]);
      expect(result.issues.map((issue) => issue.message)).toContain(
        `Prediction p1: unparseable measurableAs: "${measurableAs}"`,
      );
    });
  });

  describe("volatility", () => {
    test("parses standard form", () => {
      expect(parseObservableExpression("max(close(^VIX), 0..+5) > 20")).toEqual({
        kind: "volatility",
        subject: "^VIX",
        horizonTradingDays: 5,
        threshold: 20,
      });
    });

    test("parses decimal threshold", () => {
      expect(parseObservableExpression("max(close(^VIX), 0..+10) > 18.5")).toEqual({
        kind: "volatility",
        subject: "^VIX",
        horizonTradingDays: 10,
        threshold: 18.5,
      });
    });
  });

  describe("range", () => {
    test("parses standard form", () => {
      expect(parseObservableExpression("close(BTC, +7) outside [90000, 110000]")).toEqual({
        kind: "range",
        subject: "BTC",
        horizonTradingDays: 7,
        lo: 90_000,
        hi: 110_000,
      });
    });

    test("parses decimal bounds", () => {
      expect(parseObservableExpression("close(ETH, +5) outside [1800.5, 2200.0]")).toEqual({
        kind: "range",
        subject: "ETH",
        horizonTradingDays: 5,
        lo: 1800.5,
        hi: 2200,
      });
    });

    test("parses dotted symbols", () => {
      expect(parseObservableExpression("close(RR.L, +5) outside [1360, 1460]")).toEqual({
        kind: "range",
        subject: "RR.L",
        horizonTradingDays: 5,
        lo: 1360,
        hi: 1460,
      });
    });
  });

  describe("macro", () => {
    test("parses FRED direction form", () => {
      expect(parseObservableExpression("fred(DGS10, +5) > fred(DGS10, 0)")).toEqual({
        kind: "macro",
        seriesId: "DGS10",
        horizonTradingDays: 5,
      });
    });
  });

  describe("iv", () => {
    test("parses IV threshold form", () => {
      expect(parseObservableExpression("iv(AAPL, +5) > 0.35")).toEqual({
        kind: "iv",
        subject: "AAPL",
        horizonTradingDays: 5,
        threshold: 0.35,
      });
    });
  });

  describe("conditional", () => {
    test("parses a single conditional edge", () => {
      expect(
        parseObservableExpression(
          "if (close(SPY, +5) > close(SPY, 0)) then (close(QQQ, +10) > close(QQQ, 0))",
        ),
      ).toEqual({
        kind: "conditional",
        antecedent: { kind: "direction", subject: "SPY", horizonTradingDays: 5 },
        consequent: { kind: "direction", subject: "QQQ", horizonTradingDays: 10 },
        horizonTradingDays: 10,
      });
    });

    test("rejects nested conditional operands", () => {
      expect(() =>
        parseObservableExpression(
          "if (if (close(SPY, +3) > close(SPY, 0)) then (close(QLD, +4) > close(QLD, 0))) then (close(QQQ, +10) > close(QQQ, 0))",
        ),
      ).toThrow("Cannot parse measurableAs");
    });

    test("resolves a conditional forecast from pooled observations", () => {
      const expression = parseObservableExpression(
        "if (close(SPY, +5) > close(SPY, 0)) then (close(QQQ, +10) > close(QQQ, 0))",
      );

      expect(
        resolveObservableForecast(forecastFor(expression), [
          { subject: "SPY", date: "2026-05-01", value: 500 },
          { subject: "SPY", date: "2026-05-08", value: 505 },
          { subject: "QQQ", date: "2026-05-01", value: 400 },
          { subject: "QQQ", date: "2026-05-15", value: 410 },
        ]),
      ).toMatchObject({
        status: "resolved",
        outcome: "hit",
      });
    });
  });

  describe("invalid input", () => {
    test("throws on unknown form", () => {
      expect(() => parseObservableExpression("SPY goes up")).toThrow("Cannot parse measurableAs");
    });

    test("throws on empty string", () => {
      expect(() => parseObservableExpression("")).toThrow("Cannot parse measurableAs");
    });

    test("throws on partial match", () => {
      expect(() => parseObservableExpression("close(SPY, +5)")).toThrow(
        "Cannot parse measurableAs",
      );
    });

    test("throws on malformed numeric threshold (multiple dots)", () => {
      expect(() => parseObservableExpression("max(close(^VIX), 0..+5) > 1.2.3")).toThrow(
        "Cannot parse measurableAs",
      );
    });

    test("throws on bare-dot numeric token", () => {
      expect(() => parseObservableExpression("max(close(^VIX), 0..+5) > .")).toThrow(
        "Cannot parse measurableAs",
      );
    });

    test("throws on double-dot symbol", () => {
      expect(() => parseObservableExpression("close(SPY..QQQ, +5) > close(SPY..QQQ, 0)")).toThrow(
        "Cannot parse measurableAs",
      );
    });

    test("throws on inverted range (lo >= hi)", () => {
      expect(() => parseObservableExpression("close(BTC, +7) outside [110000, 90000]")).toThrow(
        "Cannot parse measurableAs",
      );
    });

    test("throws on degenerate range (lo === hi)", () => {
      expect(() => parseObservableExpression("close(BTC, +7) outside [100000, 100000]")).toThrow(
        "Cannot parse measurableAs",
      );
    });
  });
});

describe("renderClaim", () => {
  test("renders claims for each observable kind", () => {
    const cases: readonly {
      readonly expression: ObservableExpression;
      readonly expected: string;
    }[] = [
      {
        expression: { kind: "direction", subject: "SPY", horizonTradingDays: 5 },
        expected: "SPY closes higher than today over 5 trading days",
      },
      {
        expression: {
          kind: "relative",
          subjectA: "QQQ",
          subjectB: "SPY",
          horizonTradingDays: 5,
        },
        expected: "QQQ outperforms SPY over 5 trading days",
      },
      {
        expression: {
          kind: "volatility",
          subject: "^VIX",
          horizonTradingDays: 5,
          threshold: 20,
        },
        expected: "^VIX trades above 20 within 5 trading days",
      },
      {
        expression: {
          kind: "range",
          subject: "BTC",
          horizonTradingDays: 7,
          lo: 90_000,
          hi: 110_000,
        },
        expected: "BTC closes outside 90000-110000 over 7 trading days",
      },
      {
        expression: { kind: "macro", seriesId: "DGS10", horizonTradingDays: 5 },
        expected: "DGS10 rises over 5 trading days",
      },
      {
        expression: {
          kind: "iv",
          subject: "AAPL",
          horizonTradingDays: 5,
          threshold: 0.35,
        },
        expected: "AAPL implied volatility is above 0.35 in 5 trading days",
      },
      {
        expression: {
          kind: "conditional",
          antecedent: { kind: "direction", subject: "SPY", horizonTradingDays: 5 },
          consequent: { kind: "direction", subject: "QQQ", horizonTradingDays: 10 },
          horizonTradingDays: 10,
        },
        expected:
          "If SPY closes higher than today over 5 trading days, then QQQ closes higher than today over 10 trading days",
      },
    ];

    for (const item of cases) {
      expect(renderClaim(item.expression)).toBe(item.expected);
    }
  });
});

describe("observationStrategyForForecast", () => {
  test("maps each expression kind to its observation strategy", () => {
    const cases: readonly {
      readonly expression: ObservableExpression;
      readonly expected: ObservationStrategy;
    }[] = [
      {
        expression: { kind: "direction", subject: "SPY", horizonTradingDays: 5 },
        expected: { mode: "close-window", subjects: ["SPY"], horizonTradingDays: 5 },
      },
      {
        expression: {
          kind: "relative",
          subjectA: "QQQ",
          subjectB: "SPY",
          horizonTradingDays: 5,
        },
        expected: { mode: "close-window", subjects: ["QQQ", "SPY"], horizonTradingDays: 5 },
      },
      {
        expression: {
          kind: "volatility",
          subject: "^VIX",
          horizonTradingDays: 5,
          threshold: 20,
        },
        expected: { mode: "close-window", subjects: ["^VIX"], horizonTradingDays: 5 },
      },
      {
        expression: {
          kind: "range",
          subject: "BTC",
          horizonTradingDays: 7,
          lo: 90_000,
          hi: 110_000,
        },
        expected: { mode: "close-window", subjects: ["BTC"], horizonTradingDays: 7 },
      },
      {
        expression: { kind: "macro", seriesId: "DGS10", horizonTradingDays: 5 },
        expected: {
          mode: "point",
          requests: [{ kind: "fred", subject: "DGS10", observationSubject: "FRED:DGS10" }],
          includeOrigin: true,
          horizonTradingDays: 5,
        },
      },
      {
        expression: {
          kind: "iv",
          subject: "AAPL",
          horizonTradingDays: 5,
          threshold: 0.35,
        },
        expected: {
          mode: "point",
          requests: [{ kind: "iv", subject: "AAPL", observationSubject: "IV:AAPL" }],
          includeOrigin: false,
          horizonTradingDays: 5,
        },
      },
      {
        expression: {
          kind: "conditional",
          antecedent: { kind: "direction", subject: "SPY", horizonTradingDays: 5 },
          consequent: { kind: "direction", subject: "QQQ", horizonTradingDays: 10 },
          horizonTradingDays: 10,
        },
        expected: {
          mode: "composite",
          strategies: [
            { mode: "close-window", subjects: ["SPY"], horizonTradingDays: 5 },
            { mode: "close-window", subjects: ["QQQ"], horizonTradingDays: 10 },
          ],
        },
      },
    ];

    for (const { expression, expected } of cases) {
      expect(observationStrategyForForecast(forecastFor(expression))).toEqual(expected);
    }
  });
});

describe("instrumentsForMeasurableAs", () => {
  test("extracts instruments from valid expressions across kinds", () => {
    const cases: readonly {
      readonly measurableAs: string;
      readonly expected: readonly string[];
    }[] = [
      { measurableAs: "close(SPY, +5) > close(SPY, 0)", expected: ["SPY"] },
      { measurableAs: "close(RR.L, +5) > close(RR.L, 0)", expected: ["RR.L"] },
      {
        measurableAs: "close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)",
        expected: ["QQQ", "SPY"],
      },
      {
        measurableAs: "close(RR.L, +5) / close(RR.L, 0) > close(QQQ, +5) / close(QQQ, 0)",
        expected: ["RR.L", "QQQ"],
      },
      { measurableAs: "fred(DGS10, +5) > fred(DGS10, 0)", expected: ["FRED:DGS10"] },
      {
        measurableAs: "if (close(SPY, +5) > close(SPY, 0)) then (close(QQQ, +10) > close(QQQ, 0))",
        expected: ["SPY", "QQQ"],
      },
    ];

    for (const { measurableAs, expected } of cases) {
      expect(instrumentsForMeasurableAs(measurableAs)).toEqual(expected);
    }
  });

  test("returns empty array for malformed or empty DSL instead of throwing", () => {
    expect(instrumentsForMeasurableAs("")).toEqual([]);
    expect(instrumentsForMeasurableAs("not a real expression")).toEqual([]);
    expect(instrumentsForMeasurableAs("close(SPY,")).toEqual([]);
  });
});

describe("isPredictionKind", () => {
  const allKinds = [
    "direction",
    "relative",
    "volatility",
    "range",
    "macro",
    "iv",
    "earnings-direction",
    "earnings-move",
    "conditional",
  ] as const;

  for (const kind of allKinds) {
    test(`returns true for "${kind}"`, () => {
      expect(isPredictionKind(kind)).toBe(true);
    });
  }

  test("returns false for a known non-kind string", () => {
    expect(isPredictionKind("recommendation")).toBe(false);
  });

  test("returns false for an empty string", () => {
    expect(isPredictionKind("")).toBe(false);
  });

  test("returns false for a non-string value", () => {
    expect(isPredictionKind(42)).toBe(false);
    expect(isPredictionKind(null)).toBe(false);
    expect(isPredictionKind({ kind: "direction" })).toBe(false);
  });
});

// A relative forecast's canonical subject is "primary:benchmark", and a conditional takes its
// Subject from its consequent — so a conditional wrapping a relative consequent needs the pair
// Form too. Bare-primary subjects used to normalize only for kind `relative`, which rejected the
// Conditional case with "subject does not match measurableAs" (2026-07-27 paired evaluation, three
// Of six deep-equity fixtures). Normalization now covers both; everything else is untouched.
function readOne(prediction: Record<string, unknown>): ReturnType<typeof readObservableForecasts> {
  return readObservableForecasts([prediction]);
}

describe("readObservableForecasts horizon validation", () => {
  test("rejects a horizon beyond the legal range", () => {
    const result = readOne({
      id: "p1",
      kind: "direction",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
      horizonTradingDays: 21,
      probability: 0.62,
      sourceIds: [],
    });

    expect(result.predictions).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "invalid-horizon",
        message: `Prediction p1: horizonTradingDays must be ${MIN_PREDICTION_HORIZON_TRADING_DAYS}–${MAX_PREDICTION_HORIZON_TRADING_DAYS}`,
      }),
    ]);
  });
});

describe("readObservableForecasts subject normalization", () => {
  test("completes a bare subject on a conditional with a relative consequent", () => {
    const result = readOne({
      id: "p1",
      kind: "conditional",
      subject: "AAPL",
      measurableAs:
        "if (close(SPY, +2) > close(SPY, 0)) then (close(AAPL, +5)/close(AAPL, 0) > close(SPY, +5)/close(SPY, 0))",
      horizonTradingDays: 5,
      probability: 0.62,
      sourceIds: [],
    });
    expect(result.issues).toEqual([]);
    expect(result.predictions[0]?.subject).toBe("AAPL:SPY");
  });

  test("still completes a bare subject on a plain relative forecast", () => {
    const result = readOne({
      id: "p1",
      kind: "relative",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5)/close(AAPL, 0) > close(SPY, +5)/close(SPY, 0)",
      horizonTradingDays: 5,
      probability: 0.62,
      sourceIds: [],
    });
    expect(result.issues).toEqual([]);
    expect(result.predictions[0]?.subject).toBe("AAPL:SPY");
  });

  test("leaves an explicit pair subject untouched", () => {
    const result = readOne({
      id: "p1",
      kind: "relative",
      subject: "AAPL:SPY",
      measurableAs: "close(AAPL, +5)/close(AAPL, 0) > close(SPY, +5)/close(SPY, 0)",
      horizonTradingDays: 5,
      probability: 0.62,
      sourceIds: [],
    });
    expect(result.predictions[0]?.subject).toBe("AAPL:SPY");
  });

  test("leaves direction, range, and direction-consequent conditional subjects bare", () => {
    const direction = readOne({
      id: "p1",
      kind: "direction",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
      horizonTradingDays: 5,
      probability: 0.62,
      sourceIds: [],
    });
    const range = readOne({
      id: "p2",
      kind: "range",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) outside [190, 207]",
      horizonTradingDays: 5,
      probability: 0.37,
      sourceIds: [],
    });
    const conditional = readOne({
      id: "p3",
      kind: "conditional",
      subject: "AAPL",
      measurableAs: "if (close(SPY, +2) > close(SPY, 0)) then (close(AAPL, +5) > close(AAPL, 0))",
      horizonTradingDays: 5,
      probability: 0.62,
      sourceIds: [],
    });
    expect(direction.predictions[0]?.subject).toBe("AAPL");
    expect(range.predictions[0]?.subject).toBe("AAPL");
    expect(conditional.predictions[0]?.subject).toBe("AAPL");
  });

  test("still rejects a subject that names neither the primary nor the pair", () => {
    const result = readOne({
      id: "p1",
      kind: "conditional",
      subject: "SPY",
      measurableAs:
        "if (close(SPY, +2) > close(SPY, 0)) then (close(AAPL, +5)/close(AAPL, 0) > close(SPY, +5)/close(SPY, 0))",
      horizonTradingDays: 5,
      probability: 0.62,
      sourceIds: [],
    });
    expect(result.predictions).toEqual([]);
    expect(result.issues.map((issue) => issue.message)).toContain(
      "Prediction p1: subject does not match measurableAs",
    );
  });
});

describe("readObservableForecasts broad US index redundancy", () => {
  test("reports the benchmark class for equal-probability broad-index forecasts", () => {
    const result = readObservableForecasts([
      {
        id: "pred-spy",
        kind: "relative",
        subject: "AAPL:SPY",
        measurableAs: "close(AAPL, +5)/close(AAPL, 0) > close(SPY, +5)/close(SPY, 0)",
        horizonTradingDays: 5,
        probability: 0.6,
        sourceIds: [],
      },
      {
        id: "pred-qqq",
        kind: "relative",
        subject: "AAPL:QQQ",
        measurableAs: "close(AAPL, +5)/close(AAPL, 0) > close(QQQ, +5)/close(QQQ, 0)",
        horizonTradingDays: 5,
        probability: 0.6,
        sourceIds: [],
      },
    ]);

    expect(result.predictions.map((prediction) => prediction.id)).toEqual(["pred-spy"]);
    expect(result.issues[0]).toEqual(
      expect.objectContaining({
        code: "redundant-prediction",
        predictionId: "pred-qqq",
      }),
    );
    expect(result.issues[0]?.message).toContain(
      "accepted benchmark SPY is equivalent in class broad-us-index",
    );
    expect(result.issues[0]?.message).not.toContain("same probability");
  });

  test.each(["VTI", "ITOT", "IWB", "SCHB"] as const)(
    "rejects %s as redundant with SPY for the same primary subject and horizon",
    (benchmark) => {
      const result = readObservableForecasts([
        {
          id: "pred-spy",
          kind: "relative",
          subject: "AAPL:SPY",
          measurableAs: "close(AAPL, +5)/close(AAPL, 0) > close(SPY, +5)/close(SPY, 0)",
          horizonTradingDays: 5,
          probability: 0.62,
          sourceIds: [],
        },
        {
          id: `pred-${benchmark.toLowerCase()}`,
          kind: "relative",
          subject: `AAPL:${benchmark}`,
          measurableAs: `close(AAPL, +5)/close(AAPL, 0) > close(${benchmark}, +5)/close(${benchmark}, 0)`,
          horizonTradingDays: 5,
          probability: 0.61,
          sourceIds: [],
        },
      ]);

      expect(result.predictions.map((prediction) => prediction.id)).toEqual(["pred-spy"]);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "redundant-prediction",
          predictionId: `pred-${benchmark.toLowerCase()}`,
        }),
      ]);
    },
  );
});

describe("readObservableForecasts equal-probability relative redundancy", () => {
  test("rejects QQQ and IWM benchmarks at the same probability", () => {
    const result = readObservableForecasts([
      {
        id: "pred-qqq",
        kind: "relative",
        subject: "NBIS:QQQ",
        measurableAs: "close(NBIS, +5)/close(NBIS, 0) > close(QQQ, +5)/close(QQQ, 0)",
        horizonTradingDays: 5,
        probability: 0.38,
        sourceIds: [],
      },
      {
        id: "pred-iwm",
        kind: "relative",
        subject: "NBIS:IWM",
        measurableAs: "close(NBIS, +5)/close(NBIS, 0) > close(IWM, +5)/close(IWM, 0)",
        horizonTradingDays: 5,
        probability: 0.38,
        sourceIds: [],
      },
    ]);

    expect(result.predictions.map((prediction) => prediction.id)).toEqual(["pred-qqq"]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "redundant-prediction",
        predictionId: "pred-iwm",
        message: expect.stringContaining("QQQ and IWM"),
      }),
    ]);
    expect(result.issues[0]?.message).toContain("0.38");
  });

  test("accepts QQQ and a sector ETF when their probabilities are differentiated", () => {
    const result = readObservableForecasts([
      {
        id: "pred-qqq",
        kind: "relative",
        subject: "NBIS:QQQ",
        measurableAs: "close(NBIS, +5)/close(NBIS, 0) > close(QQQ, +5)/close(QQQ, 0)",
        horizonTradingDays: 5,
        probability: 0.38,
        sourceIds: [],
      },
      {
        id: "pred-xlk",
        kind: "relative",
        subject: "NBIS:XLK",
        measurableAs: "close(NBIS, +5)/close(NBIS, 0) > close(XLK, +5)/close(XLK, 0)",
        horizonTradingDays: 5,
        probability: 0.42,
        sourceIds: [],
      },
    ]);

    expect(result.predictions.map((prediction) => prediction.id)).toEqual(["pred-qqq", "pred-xlk"]);
    expect(result.issues).toEqual([]);
  });

  test("rejects at and just under the epsilon and accepts just over it", () => {
    const basePrediction = {
      id: "pred-qqq",
      kind: "relative",
      subject: "NBIS:QQQ",
      measurableAs: "close(NBIS, +5)/close(NBIS, 0) > close(QQQ, +5)/close(QQQ, 0)",
      horizonTradingDays: 5,
      probability: 0,
      sourceIds: [],
    };
    const benchmarkPrediction = {
      id: "pred-iwm",
      kind: "relative",
      subject: "NBIS:IWM",
      measurableAs: "close(NBIS, +5)/close(NBIS, 0) > close(IWM, +5)/close(IWM, 0)",
      horizonTradingDays: 5,
      sourceIds: [],
    };
    const justUnder = readObservableForecasts([
      basePrediction,
      {
        ...benchmarkPrediction,
        probability: RELATIVE_FORECAST_EQUAL_PROBABILITY_EPSILON - 0.0001,
      },
    ]);
    const atBoundary = readObservableForecasts([
      basePrediction,
      {
        ...benchmarkPrediction,
        probability: RELATIVE_FORECAST_EQUAL_PROBABILITY_EPSILON,
      },
    ]);
    const justOver = readObservableForecasts([
      basePrediction,
      {
        ...benchmarkPrediction,
        probability: RELATIVE_FORECAST_EQUAL_PROBABILITY_EPSILON + 0.0001,
      },
    ]);

    expect(justUnder.predictions.map((prediction) => prediction.id)).toEqual(["pred-qqq"]);
    expect(justUnder.issues[0]?.code).toBe("redundant-prediction");
    expect(atBoundary.predictions.map((prediction) => prediction.id)).toEqual(["pred-qqq"]);
    expect(atBoundary.issues[0]?.code).toBe("redundant-prediction");
    expect(justOver.predictions.map((prediction) => prediction.id)).toEqual([
      "pred-qqq",
      "pred-iwm",
    ]);
    expect(justOver.issues).toEqual([]);
  });
});
