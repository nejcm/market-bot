import { describe, expect, test } from "bun:test";
import {
  observableForecastFromPrediction,
  readObservableForecasts,
} from "../src/forecast/observable";
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

  test("rejects prediction with empty sourceIds at emission", () => {
    const result = validatePredictions([{ ...validPrediction, sourceIds: [] }], knownIds);
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("predictions must cite at least one sourceId");
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
    expect(result.errors).toEqual([]);
    expect(result.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining("duplicate measurableAs"),
      expect.stringContaining("duplicate measurableAs"),
    ]);
  });

  test("rejects a same-subject direction forecast at an adjacent horizon", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-dir-5d",
          subject: "AAPL",
          measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
        },
        {
          ...validPrediction,
          id: "pred-dir-6d",
          subject: "AAPL",
          measurableAs: "close(AAPL, +6) > close(AAPL, 0)",
          horizonTradingDays: 6,
        },
      ],
      knownIds,
    );

    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.horizonTradingDays).toBe(5);
    expect(result.errors).toEqual([]);
    expect(result.issues[0]?.message).toContain(
      "redundant direction forecast for AAPL at 6 trading days",
    );
  });

  test("prefers the shorter direction horizon when adjacent forecasts arrive reversed", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-dir-6d",
          subject: "AAPL",
          measurableAs: "close(AAPL, +6) > close(AAPL, 0)",
          horizonTradingDays: 6,
        },
        {
          ...validPrediction,
          id: "pred-dir-5d",
          subject: "AAPL",
          measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
        },
      ],
      knownIds,
    );

    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.id).toBe("pred-dir-5d");
    expect(result.errors).toHaveLength(0);
  });

  test("keeps same-subject direction forecasts at well-separated horizons", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-dir-5d",
          subject: "AAPL",
          measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
        },
        {
          ...validPrediction,
          id: "pred-dir-10d",
          subject: "AAPL",
          measurableAs: "close(AAPL, +10) > close(AAPL, 0)",
          horizonTradingDays: 10,
        },
      ],
      knownIds,
    );

    expect(result.valid).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  test("keeps same-subject range forecasts at adjacent horizons", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-range-5d",
          kind: "range",
          subject: "AAPL",
          measurableAs: "close(AAPL, +5) outside [180, 220]",
        },
        {
          ...validPrediction,
          id: "pred-range-6d",
          kind: "range",
          subject: "AAPL",
          measurableAs: "close(AAPL, +6) outside [180, 220]",
          horizonTradingDays: 6,
        },
      ],
      knownIds,
    );

    expect(result.valid).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
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
    expect(result.errors).toEqual([]);
    expect(result.issues[0]?.message).toContain(
      "redundant range forecast for AAPL at 5 trading days",
    );
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

  test("normalizes bare relative subject from measurableAs", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-rel-bare",
          kind: "relative",
          subject: "QQQ",
          measurableAs: "close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)",
          claim: "QQQ outperforms SPY over 5 trading days.",
        },
      ],
      knownIds,
    );
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.subject).toBe("QQQ:SPY");
    expect(result.errors).toHaveLength(0);
  });

  test("rejects relative prediction with non-matching bare subject", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-rel-bad",
          kind: "relative",
          subject: "DIA",
          measurableAs: "close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)",
          claim: "QQQ outperforms SPY over 5 trading days.",
        },
      ],
      knownIds,
    );
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("subject does not match measurableAs");
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

  test("accepts conditional predictions and derives consequent subject fields", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          kind: "conditional",
          subject: "QQQ",
          horizonTradingDays: 10,
          measurableAs:
            "if (close(SPY, +5) > close(SPY, 0)) then (close(QQQ, +10) > close(QQQ, 0))",
        },
      ],
      knownIds,
    );

    expect(result.valid).toEqual([
      expect.objectContaining({
        kind: "conditional",
        subject: "QQQ",
        horizonTradingDays: 10,
        claim:
          "If SPY closes higher than today over 5 trading days, then QQQ closes higher than today over 10 trading days",
      }),
    ]);
  });

  test("rejects conditional predictions when antecedent horizon is not earlier", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          kind: "conditional",
          subject: "QQQ",
          horizonTradingDays: 5,
          measurableAs: "if (close(SPY, +5) > close(SPY, 0)) then (close(QQQ, +5) > close(QQQ, 0))",
        },
      ],
      knownIds,
    );

    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("antecedent horizon must be earlier");
  });

  test("rejects nested conditional predictions", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          kind: "conditional",
          subject: "QQQ",
          horizonTradingDays: 10,
          measurableAs:
            "if (if (close(SPY, +3) > close(SPY, 0)) then (close(QLD, +4) > close(QLD, 0))) then (close(QQQ, +10) > close(QQQ, 0))",
        },
      ],
      knownIds,
    );

    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("unparseable measurableAs");
  });
});

describe("duplicate-id rejection", () => {
  test("first occurrence wins; second with same id and different measurableAs gets duplicate-id", () => {
    const result = validatePredictions(
      [
        { ...validPrediction, id: "dup-id", measurableAs: "close(SPY, +5) > close(SPY, 0)" },
        {
          ...validPrediction,
          id: "dup-id",
          measurableAs: "close(QQQ, +5) > close(QQQ, 0)",
          subject: "QQQ",
        },
      ],
      knownIds,
    );
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.subject).toBe("SPY");
    expect(result.errors[0]).toContain("duplicate prediction id");
  });

  test("distinct ids are unaffected", () => {
    const result = validatePredictions(
      [
        validPrediction,
        {
          ...validPrediction,
          id: "pred-2",
          measurableAs: "close(QQQ, +5) > close(QQQ, 0)",
          subject: "QQQ",
        },
      ],
      knownIds,
    );
    expect(result.valid).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });
});

describe("missing-sources rejection (emission vs re-parse)", () => {
  test("re-parse path: observableForecastFromPrediction accepts empty sourceIds (no regression for historical artifacts)", () => {
    const prediction = {
      id: "hist-1",
      claim: "SPY closes higher than today over 5 trading days",
      kind: "direction" as const,
      subject: "SPY",
      measurableAs: "close(SPY, +5) > close(SPY, 0)",
      horizonTradingDays: 5,
      probability: 0.6,
      sourceIds: [] as string[],
    };
    const result = observableForecastFromPrediction(prediction);
    // Re-parse path must not reject empty sourceIds — historical artifacts may lack them.
    expect("prediction" in result).toBe(true);
  });

  test("re-parse path: readObservableForecasts without requireSourceIds accepts empty sourceIds", () => {
    const candidates = [{ ...validPrediction, sourceIds: [] }];
    const result = readObservableForecasts(candidates);
    expect(result.forecasts).toHaveLength(1);
    expect(result.issues).toHaveLength(0);
  });
});

describe("allowedSubjects enforcement (3.1 — context-aware subject gate)", () => {
  const marketOverviewAllowed = new Set(["SPY", "QQQ", "^VIX", "DGS10"]);
  const tickerAllowed = new Set(["AAPL"]);

  test("rejects a market-overview prediction whose subject is not in the allowed set", () => {
    // BTC is not an equity market-overview subject
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-btc",
          subject: "BTC",
          measurableAs: "close(BTC, +5) > close(BTC, 0)",
        },
      ],
      knownIds,
      marketOverviewAllowed,
    );
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]).toContain("not in the allowed set");
    expect(result.issues[0]?.code).toBe("disallowed-subject");
  });

  test("accepts a prediction whose subject is in the allowed set", () => {
    // SPY is an allowed market-overview subject
    const result = validatePredictions([validPrediction], knownIds, marketOverviewAllowed);
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  test("accepts a dotted ticker prediction whose subject is in the allowed set", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-rrl",
          subject: "RR.L",
          measurableAs: "close(RR.L, +5) > close(RR.L, 0)",
        },
      ],
      knownIds,
      new Set(["RR.L"]),
    );

    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.subject).toBe("RR.L");
    expect(result.errors).toHaveLength(0);
  });

  test("accepts a macro prediction whose subject is a FRED series in the allowed set", () => {
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
      ],
      knownIds,
      marketOverviewAllowed,
    );
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  test("accepts a ticker relative forecast where the primary subject (AAPL) is in the allowed set", () => {
    // Relative subject is "AAPL:SPY"; primary part "AAPL" is in tickerAllowed
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-rel",
          kind: "relative",
          subject: "AAPL:SPY",
          measurableAs: "close(AAPL, +5) / close(AAPL, 0) > close(SPY, +5) / close(SPY, 0)",
        },
      ],
      knownIds,
      tickerAllowed,
    );
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  test("accepts and normalizes a dotted ticker relative forecast", () => {
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-rrl-rel",
          kind: "relative",
          subject: "RR.L",
          measurableAs: "close(RR.L, +5) / close(RR.L, 0) > close(QQQ, +5) / close(QQQ, 0)",
        },
      ],
      knownIds,
      new Set(["RR.L"]),
    );

    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.subject).toBe("RR.L:QQQ");
    expect(result.errors).toHaveLength(0);
  });

  test("accepts predictions when allowedSubjects is undefined (no gate)", () => {
    // Research runs pass allowedSubjects=undefined; all subjects pass through
    const result = validatePredictions(
      [
        {
          ...validPrediction,
          id: "pred-btc",
          subject: "BTC",
          measurableAs: "close(BTC, +5) > close(BTC, 0)",
        },
      ],
      knownIds,
      // AllowedSubjects not passed — undefined means no gate
    );
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });
});
