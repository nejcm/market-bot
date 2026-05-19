import { describe, expect, test } from "bun:test";
import { parseMeasurableAs } from "../src/scoring/dsl";

describe("parseMeasurableAs", () => {
  describe("direction", () => {
    test("parses standard form", () => {
      expect(parseMeasurableAs("close(SPY, +5) > close(SPY, 0)")).toEqual({
        kind: "direction",
        subject: "SPY",
        horizonN: 5,
      });
    });

    test("parses with caret symbol (^VIX)", () => {
      expect(parseMeasurableAs("close(^VIX, +3) > close(^VIX, 0)")).toEqual({
        kind: "direction",
        subject: "^VIX",
        horizonN: 3,
      });
    });

    test("parses without spaces around +N", () => {
      expect(parseMeasurableAs("close(QQQ,+10) > close(QQQ, 0)")).toEqual({
        kind: "direction",
        subject: "QQQ",
        horizonN: 10,
      });
    });
  });

  describe("relative", () => {
    test("parses standard form", () => {
      expect(
        parseMeasurableAs("close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)"),
      ).toEqual({
        kind: "relative",
        subjectA: "QQQ",
        subjectB: "SPY",
        horizonN: 5,
      });
    });
  });

  describe("volatility", () => {
    test("parses standard form", () => {
      expect(parseMeasurableAs("max(close(^VIX), 0..+5) > 20")).toEqual({
        kind: "volatility",
        subject: "^VIX",
        horizonN: 5,
        threshold: 20,
      });
    });

    test("parses decimal threshold", () => {
      expect(parseMeasurableAs("max(close(^VIX), 0..+10) > 18.5")).toEqual({
        kind: "volatility",
        subject: "^VIX",
        horizonN: 10,
        threshold: 18.5,
      });
    });
  });

  describe("range", () => {
    test("parses standard form", () => {
      expect(parseMeasurableAs("close(BTC, +7) outside [90000, 110000]")).toEqual({
        kind: "range",
        subject: "BTC",
        horizonN: 7,
        lo: 90_000,
        hi: 110_000,
      });
    });

    test("parses decimal bounds", () => {
      expect(parseMeasurableAs("close(ETH, +5) outside [1800.5, 2200.0]")).toEqual({
        kind: "range",
        subject: "ETH",
        horizonN: 5,
        lo: 1800.5,
        hi: 2200,
      });
    });
  });

  describe("invalid input", () => {
    test("throws on unknown form", () => {
      expect(() => parseMeasurableAs("SPY goes up")).toThrow("Cannot parse measurableAs");
    });

    test("throws on empty string", () => {
      expect(() => parseMeasurableAs("")).toThrow("Cannot parse measurableAs");
    });

    test("throws on partial match", () => {
      expect(() => parseMeasurableAs("close(SPY, +5)")).toThrow("Cannot parse measurableAs");
    });

    test("throws on malformed numeric threshold (multiple dots)", () => {
      expect(() => parseMeasurableAs("max(close(^VIX), 0..+5) > 1.2.3")).toThrow(
        "Cannot parse measurableAs",
      );
    });

    test("throws on bare-dot numeric token", () => {
      expect(() => parseMeasurableAs("max(close(^VIX), 0..+5) > .")).toThrow(
        "Cannot parse measurableAs",
      );
    });

    test("throws on inverted range (lo >= hi)", () => {
      expect(() => parseMeasurableAs("close(BTC, +7) outside [110000, 90000]")).toThrow(
        "Cannot parse measurableAs",
      );
    });

    test("throws on degenerate range (lo === hi)", () => {
      expect(() => parseMeasurableAs("close(BTC, +7) outside [100000, 100000]")).toThrow(
        "Cannot parse measurableAs",
      );
    });
  });
});
