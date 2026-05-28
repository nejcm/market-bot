import { describe, expect, test } from "bun:test";
import {
  READER_DIRECTED_ADVICE_PATTERN,
  TRADE_ACTION_PATTERN,
  violatesResearchOnly,
} from "../src/domain/research-language";

describe("TRADE_ACTION_PATTERN", () => {
  const banned = [
    "buy",
    "sell",
    "hold",
    "go long",
    "go short",
    "short this",
    "accumulate",
    "reduce exposure",
    "increase exposure",
    "rebalance",
    "take profit",
    "stop loss",
    "position size",
    "position sizing",
    "open a position",
    "take a position",
    "trim exposure",
    "add shares",
    "scale in",
    "set an entry",
    "exit at",
    "execute",
    "execution instruction",
    "portfolio change",
    "allocation change",
  ];

  for (const phrase of banned) {
    test(`matches "${phrase}"`, () => {
      expect(TRADE_ACTION_PATTERN.test(phrase)).toBe(true);
    });
  }

  test("matches in sentence context", () => {
    expect(TRADE_ACTION_PATTERN.test("You should buy SPY given the trend.")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(TRADE_ACTION_PATTERN.test("BUY")).toBe(true);
    expect(TRADE_ACTION_PATTERN.test("SELL")).toBe(true);
    expect(TRADE_ACTION_PATTERN.test("Rebalance your portfolio")).toBe(true);
  });
});

describe("READER_DIRECTED_ADVICE_PATTERN", () => {
  const banned = [
    "Investors should open a position in SPY.",
    "Traders may want to trim exposure.",
    "You need to rebalance this portfolio.",
    "Should buy SPY on weakness.",
  ];

  for (const phrase of banned) {
    test(`matches "${phrase}"`, () => {
      expect(READER_DIRECTED_ADVICE_PATTERN.test(phrase)).toBe(true);
    });
  }
});

describe("violatesResearchOnly", () => {
  const research = [
    "SPY has been trading above its 200-day moving average.",
    "BTC dominance increased amid broad risk-off sentiment.",
    "Volatility regime shifted to elevated after the Fed announcement.",
    "The probability of a breakout above resistance is moderate.",
    "Inflation should decline if shelter data cools.",
    "close(SPY, +5) > close(SPY, 0)",
  ];

  for (const text of research) {
    test(`returns null for research language: "${text.slice(0, 60)}"`, () => {
      expect(violatesResearchOnly(text)).toBeNull();
    });
  }

  test("returns match object for banned phrase", () => {
    const result = violatesResearchOnly("Investors may want to buy SPY here.");
    expect(result).not.toBeNull();
    expect(result?.match.toLowerCase()).toBe("buy");
  });

  test("returns null for empty string", () => {
    expect(violatesResearchOnly("")).toBeNull();
  });

  test("captures the matched word in the result", () => {
    const result = violatesResearchOnly("A rebalance of the portfolio is warranted.");
    expect(result?.match.toLowerCase()).toBe("rebalance");
  });

  test("blocks reader-directed advice without explicit buy/sell wording", () => {
    const result = violatesResearchOnly(
      "Investors should open a position in SPY and trim exposure below 500.",
    );
    expect(result).not.toBeNull();
  });
});
