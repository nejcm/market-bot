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

  test("allows the sanctioned rendered peer-implied reference-range label", () => {
    expect(violatesResearchOnly("peer-implied price reference range")).toBeNull();
  });

  test("allows the explicit research-only target-price disclaimer", () => {
    expect(violatesResearchOnly("This is valuation context, not a target price.")).toBeNull();
    expect(violatesResearchOnly("This is a target price.")).not.toBeNull();
    expect(
      violatesResearchOnly(
        "Although this is not a target price, shares are likely to reach 250 USD within 12 months.",
      ),
    ).not.toBeNull();
    expect(violatesResearchOnly("Not A Target Price, but the stock reaches 300.")).not.toBeNull();
    expect(
      violatesResearchOnly("This is not a target prices statement; 400 is achievable."),
    ).not.toBeNull();
    expect(
      violatesResearchOnly(
        "Although this is valuation context, not a target price. Shares likely reach 250 USD.",
      ),
    ).not.toBeNull();
    expect(
      violatesResearchOnly(
        "This is valuation context, not a target price. The model states a fair value of 125 USD.",
      ),
    ).not.toBeNull();
  });

  test("blocks a bare peer-implied point price", () => {
    expect(violatesResearchOnly("The peer-implied price is 125 USD.")).not.toBeNull();
  });

  test("preserves valuation-certainty and descriptive valuation behavior", () => {
    expect(violatesResearchOnly("The model states a fair value of 125 USD.")).not.toBeNull();
    expect(
      violatesResearchOnly(
        "The calculation stopped because one or more implied prices are not positive.",
      ),
    ).toBeNull();
  });

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

/*
 * The price-target branch matches unconditionally, and F3 is fixed by screening the wording at
 * the source (`src/web-evidence/web-subject-profile.ts`) rather than by narrowing the gate. This
 * corpus pins that: it is the set of shapes an abandoned absence-exemption attempt had to spare or
 * catch, and three independent review rounds each found a different assertion that slipped through
 * a clause predicate. Under an unconditional match every one of them is rejected, including the
 * absence declarations — those never reach the gate now, because they are screened upstream.
 */
describe("price-target wording is rejected unconditionally", () => {
  const rejected = [
    // The live deep-AAPL gap sentence, and other absence declarations. Route 2 screens these at
    // The source; the gate itself is not asked to tell an absence from an assertion.
    "Analyst consensus, price targets, options data, dividend history, and split history are not available in the supplied web sources.",
    "Price targets are not available.",
    "Price targets were not available in the supplied web sources.",
    "Price targets are not disclosed by the issuer.",
    "Price targets not provided in the supplied sources.",
    "Target prices were not published in the filing.",
    "Analyst price targets and options data are not available",
    "Price targets, options data, and dividend history are not reported.",
    "Consensus estimates, price targets or analyst notes are not present in the supplied sources.",
    // Bare terms.
    "price target",
    "price targets",
    "target price",
    "target prices",
    "The consensus price target is 240 USD.",
    // A numeric assertion riding along beside an absence.
    "Price targets are not available, but peers imply $214.",
    "Price targets are not available at 214 USD.",
    "Price targets are not available and the % gap is wide.",
    "Price targets are not available; the peer-implied price is 214 USD.",
    "Price targets are not available. The model states a fair value of 125 USD.",
    "Price targets are not currently available.",
    "Price targets are not the focus of this section.",
    // Review round 1: an assertion before the term, an unrelated absence after it.
    "Our price target is above spot, but analyst coverage is not available.",
    "Analyst coverage is not available, but our price target is above spot.",
    "Our price target, well above spot, is not disclosed.",
    "Price targets are not available, and they sit above spot.",
    "Our price target stands, but analyst coverage is not available.",
    "Our price target, but analyst coverage, is not available.",
    "Our price target exceeds peer levels, options data are not available.",
    "The consensus price target is above spot.",
    "Management price target is well supported by peers.",
    // Review round 2: a numeric assertion before the term.
    "We maintain our $240 price target, and estimates are not available.",
    "We maintain our price target, and estimates are not available.",
    "We reiterate the price target, and guidance is not disclosed.",
    "I set a price target, and guidance is not disclosed.",
    "Our price target, and guidance, is not disclosed.",
    "We raised the price target, though guidance is not disclosed.",
    "The desk raised the price target, guidance is not disclosed.",
    "Analysts publish a price target, options data are not available.",
    // Review round 3: a short affirmative "subject" that a clause predicate read as an enumeration.
    "Price target stands, guidance is not disclosed.",
    "Price targets are not available. The consensus price target is 240 USD.",
    "Price targets are not available. Peer multiples imply a fair value of $214.",
    "Estimates are not available; the price target stands.",
    "Options data are not available for our price target.",
    "Price targets exceeding spot are not available.",
    "Price targets, which imply upside, are not available.",
    "Price targets are not available above 200 USD.",
    "Price targets are not available, implying upside.",
    "A 240 USD price target and options data are not available.",
    // Scanned report text is newline-joined, so a newline must not license the next line.
    "Analyst coverage is not available.\nThe price target is 240 USD.",
    "Price targets\nare not available.",
    "Price targets are not available.\nThe consensus price target is 240 USD.",
  ];

  for (const text of rejected) {
    test(`rejects: ${JSON.stringify(text)}`, () => {
      expect(violatesResearchOnly(text)).not.toBeNull();
    });
  }
});
