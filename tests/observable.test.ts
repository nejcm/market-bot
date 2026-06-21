import { describe, expect, test } from "bun:test";
import {
  instrumentsForMeasurableAs,
  observationStrategyForForecast,
  parseObservableExpression,
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
      {
        measurableAs: "close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)",
        expected: ["QQQ", "SPY"],
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
