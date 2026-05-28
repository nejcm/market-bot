import { describe, expect, test } from "bun:test";
import { parseObservableExpression } from "../src/forecast/observable";

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
