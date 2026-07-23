import { describe, expect, test } from "bun:test";
import {
  READER_DIRECTED_ADVICE_PATTERN,
  TRADE_ACTION_PATTERN,
  violatesResearchOnly,
} from "../src/domain/research-language";

describe("TRADE_ACTION_PATTERN", () => {
  const banned = [
    "buy the stock",
    "sell the shares",
    "hold this position",
    "go long",
    "go short",
    "short this",
    "accumulate shares",
    "reduce exposure",
    "increase exposure",
    "rebalance the portfolio",
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
    "execute the trade",
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
    expect(TRADE_ACTION_PATTERN.test("You should buy the stock given the trend.")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(TRADE_ACTION_PATTERN.test("BUY THE STOCK")).toBe(true);
    expect(TRADE_ACTION_PATTERN.test("SELL THE SHARES")).toBe(true);
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
    "Customers buy devices through Apple's retail and online stores.",
    "Apple sells devices, software, and services.",
    "The company holds substantial cash and marketable securities.",
    "Management may execute the product launch in September.",
    "The distributor accumulates inventory before launches.",
  ];

  for (const text of research) {
    test(`returns null for research language: "${text.slice(0, 60)}"`, () => {
      expect(violatesResearchOnly(text)).toBeNull();
    });
  }

  test("returns match object for banned phrase", () => {
    const result = violatesResearchOnly("Investors may want to buy SPY here.");
    expect(result).not.toBeNull();
    expect(result?.match.toLowerCase()).toBe("buy spy");
  });

  test("blocks direct ticker trade actions", () => {
    expect(violatesResearchOnly("buy AAPL")).not.toBeNull();
  });

  test("returns null for empty string", () => {
    expect(violatesResearchOnly("")).toBeNull();
  });

  test("captures the matched word in the result", () => {
    const result = violatesResearchOnly("A rebalance of the portfolio is warranted.");
    expect(result?.match.toLowerCase()).toBe("rebalance of the portfolio");
  });

  test("blocks reader-directed advice without explicit buy/sell wording", () => {
    const result = violatesResearchOnly(
      "Investors should open a position in SPY and trim exposure below 500.",
    );
    expect(result).not.toBeNull();
  });

  for (const phrase of [
    "fair value",
    "margin of safety",
    "undervalued",
    "overvalued",
    "target price",
    "target prices",
    "price target",
    "price targets",
    "implied price",
    "implied prices",
    "intrinsic value",
    "percentage gap",
    "% gap",
    "valuation gap",
    "implied fair value",
  ]) {
    test(`blocks valuation-certainty wording: "${phrase}"`, () => {
      expect(violatesResearchOnly(phrase)).not.toBeNull();
    });
  }

  for (const text of [
    "The peer-implied price reference range is a descriptive peer interval.",
    "The source coverage gap remains open and the observed value is 12.",
    "The calculation stopped because one or more implied prices are not positive.",
  ]) {
    test(`allows descriptive valuation prose: "${text}"`, () => {
      expect(violatesResearchOnly(text)).toBeNull();
    });
  }

  const terseImperatives = [
    "Buy now",
    "Sell immediately",
    "Hold for upside",
    "Accumulate gradually",
    "Buy the dip",
    "Sell into strength",
    "Buy more",
    "Hold indefinitely",
  ];

  for (const phrase of terseImperatives) {
    test(`blocks terse imperative trade advice: "${phrase}"`, () => {
      expect(violatesResearchOnly(phrase)).not.toBeNull();
    });
  }

  test("blocks imperative advice mid-paragraph after sentence boundary", () => {
    expect(
      violatesResearchOnly("The setup is compelling. Buy now before earnings."),
    ).not.toBeNull();
  });

  const safeCompoundsAndProse = [
    "Sell-side analysts raised their revenue estimates.",
    "Buy-side demand for the new issue was strong.",
    "Sellers raised prices across the channel.",
    "Buyers flocked to the latest model.",
    "Holding company structure simplifies reporting.",
  ];

  for (const text of safeCompoundsAndProse) {
    test(`allows non-advice prose: "${text.slice(0, 50)}"`, () => {
      expect(violatesResearchOnly(text)).toBeNull();
    });
  }
});
