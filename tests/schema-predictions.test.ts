import { describe, expect, test } from "bun:test";
import { validatePredictions } from "../src/report/schema";

const knownIds = new Set(["src-1", "src-2"]);

const validPrediction = {
  id: "pred-1",
  claim: "SPY closes higher over the next 5 trading days.",
  kind: "direction",
  subject: "SPY",
  measurableAs: "close(SPY, +5) > close(SPY, 0)",
  horizonTradingDays: 5,
  probability: 0.6,
  sourceIds: ["src-1"],
};

describe("validatePredictions", () => {
  test("accepts a valid direction prediction", () => {
    const result = validatePredictions([validPrediction], knownIds);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.claim).toBe("SPY closes higher than today over 5 trading days");
    expect(result.errors).toHaveLength(0);
  });

  test("accepts missing model claim and derives one from measurableAs", () => {
    const { claim: _claim, ...withoutClaim } = validPrediction;

    const result = validatePredictions([withoutClaim], knownIds);

    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.claim).toBe("SPY closes higher than today over 5 trading days");
    expect(result.errors).toHaveLength(0);
  });

  test("drops prediction with unparseable measurableAs", () => {
    const result = validatePredictions(
      [{ ...validPrediction, measurableAs: "SPY goes up somehow" }],
      knownIds,
    );
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("unparseable measurableAs");
  });

  test("drops prediction with invalid kind", () => {
    const result = validatePredictions([{ ...validPrediction, kind: "recommendation" }], knownIds);
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("invalid kind");
  });

  test("drops prediction with out-of-range horizonTradingDays", () => {
    const result = validatePredictions([{ ...validPrediction, horizonTradingDays: 25 }], knownIds);
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("horizonTradingDays must be 1–20");
  });

  test("drops prediction with out-of-range probability", () => {
    const result = validatePredictions([{ ...validPrediction, probability: 1.5 }], knownIds);
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("probability must be 0–1");
  });

  test("ignores unsafe model claim text because claim is derived", () => {
    const result = validatePredictions(
      [{ ...validPrediction, claim: "Sell SPY if it closes lower." }],
      knownIds,
    );
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.claim).toBe("SPY closes higher than today over 5 trading days");
    expect(result.errors).toHaveLength(0);
  });

  test("drops prediction with unknown sourceId", () => {
    const result = validatePredictions(
      [{ ...validPrediction, sourceIds: ["unknown-src"] }],
      knownIds,
    );
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("unknown sourceId");
  });

  test("accepts prediction with empty sourceIds", () => {
    const result = validatePredictions([{ ...validPrediction, sourceIds: [] }], knownIds);
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  test("drops non-object candidates", () => {
    const result = validatePredictions(["not an object", null, 42], knownIds);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(3);
  });

  test("returns valid ones and errors for mixed input", () => {
    const result = validatePredictions(
      [validPrediction, { ...validPrediction, id: "pred-2", horizonTradingDays: 99 }],
      knownIds,
    );
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });

  test("rejects duplicate measurableAs and same-subject same-horizon forecasts", () => {
    const result = validatePredictions(
      [
        validPrediction,
        { ...validPrediction, id: "pred-duplicate-exact" },
        {
          ...validPrediction,
          id: "pred-duplicate-horizon",
          measurableAs: "close(SPY, +5) > close(SPY, 0)",
          probability: 0.55,
        },
      ],
      knownIds,
    );

    expect(result.valid).toHaveLength(1);
    expect(result.errors).toEqual([
      expect.stringContaining("duplicate measurableAs"),
      expect.stringContaining("duplicate measurableAs"),
    ]);
  });

  test("rejects same ticker range predictions at the same horizon", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-range-1",
          kind: "range",
          subject: "AAPL",
          measurableAs: "close(AAPL, +5) outside [180, 220]",
        },
        {
          ...validPrediction,
          id: "pred-range-2",
          kind: "range",
          subject: "AAPL",
          measurableAs: "close(AAPL, +5) outside [170, 230]",
        },
      ],
      knownIds,
    );

    expect(result.valid).toHaveLength(1);
    expect(result.errors[0]).toContain("redundant range forecast for AAPL at 5 trading days");
  });

  test("accepts a valid relative prediction", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-rel",
          kind: "relative",
          subject: "QQQ:SPY",
          measurableAs: "close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)",
          claim: "QQQ outperforms SPY over 5 trading days.",
        },
      ],
      knownIds,
    );
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.claim).toBe("QQQ outperforms SPY over 5 trading days");
  });

  test("rejects relative prediction with non-A:B subject", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-rel-bad",
          kind: "relative",
          subject: "QQQ",
          measurableAs: "close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)",
          claim: "QQQ outperforms SPY over 5 trading days.",
        },
      ],
      knownIds,
    );
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain('relative subject must be "A:B"');
  });

  test("rejects prediction when kind does not match measurableAs", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          kind: "direction",
          subject: "QQQ:SPY",
          measurableAs: "close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)",
        },
      ],
      knownIds,
    );

    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("kind does not match measurableAs");
  });

  test("rejects prediction when subject does not match measurableAs", () => {
    const result = validatePredictions(
      [{ ...validPrediction, subject: "QQQ", measurableAs: "close(SPY, +5) > close(SPY, 0)" }],
      knownIds,
    );

    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("subject does not match measurableAs");
  });

  test("rejects prediction when horizon does not match measurableAs", () => {
    const result = validatePredictions([{ ...validPrediction, horizonTradingDays: 10 }], knownIds);

    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("horizonTradingDays does not match measurableAs");
  });

  test("accepts a valid volatility prediction", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-vol",
          kind: "volatility",
          subject: "^VIX",
          measurableAs: "max(close(^VIX), 0..+5) > 20",
          claim: "VIX exceeds 20 within 5 trading days.",
        },
      ],
      knownIds,
    );
    expect(result.valid).toHaveLength(1);
  });

  test("accepts a valid range prediction", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-range",
          kind: "range",
          subject: "BTC",
          measurableAs: "close(BTC, +7) outside [90000, 110000]",
          horizonTradingDays: 7,
          claim: "BTC trades outside the 90000–110000 band within 7 days.",
        },
      ],
      knownIds,
    );
    expect(result.valid).toHaveLength(1);
  });

  test("accepts valid macro and IV predictions", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-macro",
          kind: "macro",
          subject: "DGS10",
          measurableAs: "fred(DGS10, +5) > fred(DGS10, 0)",
          claim: "DGS10 rises over 5 trading days.",
        },
        {
          ...validPrediction,
          id: "pred-iv",
          kind: "iv",
          subject: "AAPL",
          measurableAs: "iv(AAPL, +5) > 0.35",
          claim: "AAPL implied volatility exceeds 0.35 over 5 trading days.",
        },
      ],
      knownIds,
    );
    expect(result.valid).toHaveLength(2);
    expect(result.valid.map((item) => item.claim)).toEqual([
      "DGS10 rises over 5 trading days",
      "AAPL implied volatility is above 0.35 in 5 trading days",
    ]);
  });

  test("keeps bearish encoding as low probability on the up event", () => {
    const result = validatePredictions(
      [{ ...validPrediction, probability: 0.3, claim: "SPY closes lower." }],
      knownIds,
    );
    expect(result.valid).toEqual([
      expect.objectContaining({
        claim: "SPY closes higher than today over 5 trading days",
        probability: 0.3,
      }),
    ]);
  });
});
