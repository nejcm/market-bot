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

  test("drops prediction with trade-action language in claim", () => {
    const result = validatePredictions(
      [{ ...validPrediction, claim: "Sell SPY if it closes lower." }],
      knownIds,
    );
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("trade-action language");
  });

  test("drops prediction with reader-directed language in claim", () => {
    const result = validatePredictions(
      [{ ...validPrediction, claim: "Consider rotating into SPY." }],
      knownIds,
    );
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("reader-directed language");
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
          claim: "BTC trades outside the 90000–110000 band within 7 days.",
        },
      ],
      knownIds,
    );
    expect(result.valid).toHaveLength(1);
  });
});
