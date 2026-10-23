import { describe, expect, test } from "bun:test";
import type { ResearchCommand } from "../src/cli/args";
import {
  FORECAST_BASELINE_VERSION,
  ewmaDailySigma,
  forecastBaseline,
  rangeOutsideProbability,
  standardNormalCdf,
  type BaselineClose,
} from "../src/forecast/baseline";
import { parseObservableExpression } from "../src/forecast/observable";
import { eventGrid, issueForecastBook } from "../src/research/event-grid";
import { rederivePredictionShortfallReportAfterPruning } from "../src/report/prediction-shortfall";
import { validateResearchReport } from "../src/report/schema";
import {
  collectedSources,
  prediction,
  researchReport,
  verifiedMarketSnapshot,
} from "./support/fixtures";

const EQUITY: ResearchCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "brief",
};

function day(index: number): string {
  return new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
}

// Alternating ±1% log returns: EWMA σ is exactly 0.01 and the last close returns to 100.
function alternatingCloses(count: number, base = 100): BaselineClose[] {
  return Array.from({ length: count }, (_, index) => ({
    date: day(index),
    close: base * Math.exp(index % 2 === 0 ? 0 : 0.01),
  }));
}

function closes(entries: Record<string, readonly BaselineClose[]>) {
  return new Map(Object.entries(entries));
}

const range = (expression: string) => parseObservableExpression(expression);

// Alternating closes with every close from day 40 on scaled by factor: one jump of log(factor).
function jumped(factor: number): BaselineClose[] {
  return alternatingCloses(61).map((bar, index) =>
    index >= 40 ? { ...bar, close: bar.close * factor } : bar,
  );
}

function splitDates(entries: Record<string, readonly string[]>) {
  return new Map(Object.entries(entries));
}

describe("Forecast Baseline estimator", () => {
  test("pins the normal CDF and EWMA volatility on fixed inputs", () => {
    expect(standardNormalCdf(0)).toBeCloseTo(0.5, 7);
    expect(standardNormalCdf(1)).toBeCloseTo(0.841_344_7, 6);
    expect(standardNormalCdf(-1.96)).toBeCloseTo(0.024_997_9, 6);
    expect(
      ewmaDailySigma(Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01))),
    ).toBeCloseTo(0.01, 12);
    expect(ewmaDailySigma([0.02, 0, 0, 0])).toBeCloseTo(0.0099, 6);
  });

  test("prices a ±1σ√h band at P(|z| > 1)", () => {
    const move = 0.01 * Math.sqrt(5);
    expect(
      rangeOutsideProbability({
        sigma: 0.01,
        spot: 100,
        lo: 100 * Math.exp(-move),
        hi: 100 * Math.exp(move),
        horizon: 5,
      }),
    ).toBeCloseTo(0.3173, 4);
  });

  test("computes range, direction and relative baselines from split-adjusted closes", () => {
    const history = closes({ AAPL: alternatingCloses(61), SPY: alternatingCloses(61, 500) });
    expect(forecastBaseline(range("close(AAPL, +5) outside [97.79, 102.26]"), history)).toEqual({
      status: "computed",
      probability: 0.3176,
      infoCutoff: day(60),
    });
    expect(forecastBaseline(range("close(AAPL, +5) > close(AAPL, 0)"), history)).toEqual({
      status: "computed",
      probability: 0.5,
      infoCutoff: day(60),
    });
    expect(
      forecastBaseline(
        range("close(AAPL, +5)/close(AAPL, 0) > close(SPY, +5)/close(SPY, 0)"),
        history,
      ),
    ).toEqual({ status: "computed", probability: 0.5, infoCutoff: day(60) });
  });

  test("declares short history, split signature, zero volatility and missing benchmark", () => {
    const split = alternatingCloses(61).map((bar, index) =>
      index >= 40 ? { ...bar, close: bar.close / 2 } : bar,
    );
    const flat = Array.from({ length: 61 }, (_, index) => ({ date: day(index), close: 100 }));
    const expression = range("close(AAPL, +1) outside [99, 101]");
    expect(forecastBaseline(expression, closes({ AAPL: alternatingCloses(60) }))).toEqual({
      status: "unavailable",
      symbol: "AAPL",
      reason: "short-history",
    });
    expect(forecastBaseline(expression, closes({ AAPL: split }))).toMatchObject({
      reason: "split-signature",
    });
    expect(forecastBaseline(expression, closes({ AAPL: flat }))).toMatchObject({
      reason: "zero-volatility",
    });
    expect(
      forecastBaseline(
        range("close(AAPL, +5)/close(AAPL, 0) > close(SPY, +5)/close(SPY, 0)"),
        closes({ AAPL: alternatingCloses(61) }),
      ),
    ).toEqual({ status: "unavailable", symbol: "SPY", reason: "missing-closes" });
  });

  test("a large real move on adjusted closes is volatility, not a split", () => {
    const earningsDay = jumped(1.2);
    const expression = range("close(AAPL, +1) outside [99, 101]");
    expect(
      forecastBaseline(expression, closes({ AAPL: earningsDay }), splitDates({ AAPL: [] })),
    ).toMatchObject({ status: "computed" });
    expect(
      forecastBaseline(range("close(AAPL, +1) outside [99, 101]"), closes({ AAPL: jumped(1.05) })),
    ).toMatchObject({
      status: "computed",
    });
  });

  test("flags unadjusted forward and reverse splits, alone or with a ±10% split-day move", () => {
    const expression = range("close(AAPL, +1) outside [99, 101]");
    for (const factor of [0.8, 0.75, 2 / 3, 0.5, 1 / 3, 5, 10, 0.5 * 1.1, 0.5 * 0.9, 5 * 1.1]) {
      expect(forecastBaseline(expression, closes({ AAPL: jumped(factor) }))).toMatchObject({
        reason: "split-signature",
      });
    }
  });

  test("provider split metadata separates a real halving from a misadjusted split", () => {
    const expression = range("close(AAPL, +1) outside [99, 101]");
    const halving = closes({ AAPL: jumped(0.5) });
    expect(forecastBaseline(expression, halving, splitDates({ AAPL: [] }))).toMatchObject({
      status: "computed",
    });
    expect(forecastBaseline(expression, halving, splitDates({ AAPL: [day(10)] }))).toMatchObject({
      status: "computed",
    });
    expect(forecastBaseline(expression, halving, splitDates({ AAPL: [day(41)] }))).toMatchObject({
      reason: "split-signature",
    });
    expect(forecastBaseline(expression, halving, splitDates({ SPY: [] }))).toMatchObject({
      reason: "split-signature",
    });
  });

  test("a larger genuine move does not mask a smaller residual split", () => {
    const expression = range("close(AAPL, +1) outside [99, 101]");
    const twoJumps = closes({
      AAPL: jumped(0.75).map((bar, index) =>
        index >= 10 ? { ...bar, close: bar.close * 2 } : bar,
      ),
    });
    expect(forecastBaseline(expression, twoJumps, splitDates({ AAPL: [day(40)] }))).toMatchObject({
      reason: "split-signature",
    });
    expect(forecastBaseline(expression, twoJumps)).toMatchObject({ reason: "split-signature" });
    expect(forecastBaseline(expression, twoJumps, splitDates({ AAPL: [] }))).toMatchObject({
      status: "computed",
    });
  });

  test("a non-positive range bound has zero tail probability, not NaN", () => {
    const history = closes({ AAPL: alternatingCloses(61) });
    const result = forecastBaseline(range("close(AAPL, +5) outside [-1, 102.26]"), history);
    expect(result).toMatchObject({ status: "computed" });
    expect(result.status === "computed" && Number.isFinite(result.probability)).toBe(true);
  });

  test("uses the newest date as infoCutoff for out-of-order closes", () => {
    const series = alternatingCloses(61);
    const shuffled = [series.at(-1)!, ...series.slice(0, -1)];
    expect(
      forecastBaseline(range("close(AAPL, +1) outside [99, 101]"), closes({ AAPL: shuffled })),
    ).toMatchObject({ infoCutoff: day(60) });
  });

  test("declares a stale relative leg instead of stamping 0.5", () => {
    const staleSpy = alternatingCloses(61, 500).map((bar, index) => ({
      ...bar,
      date: day(index - 30),
    }));
    expect(
      forecastBaseline(
        range("close(AAPL, +5)/close(AAPL, 0) > close(SPY, +5)/close(SPY, 0)"),
        closes({ AAPL: alternatingCloses(61), SPY: staleSpy }),
      ),
    ).toEqual({ status: "unavailable", symbol: "SPY", reason: "stale-closes" });
  });

  test("conditional and volatility events have no baseline", () => {
    const history = closes({ AAPL: alternatingCloses(61) });
    expect(
      forecastBaseline(
        range("if (close(AAPL, +1) > close(AAPL, 0)) then (close(AAPL, +5) > close(AAPL, 0))"),
        history,
      ),
    ).toEqual({ status: "unsupported" });
    expect(forecastBaseline(range("iv(AAPL, +5) > 0.35"), history)).toEqual({
      status: "unsupported",
    });
  });
});

function gridSources(overrides: { readonly spy?: boolean } = {}) {
  const bars = (base: number) =>
    alternatingCloses(61, base).map((bar) => ({ ...bar, completed: true }));
  return collectedSources({
    verifiedMarketSnapshot: verifiedMarketSnapshot({
      recentCloses: alternatingCloses(30).map(({ date, close }) => ({ date, close })),
    }),
    priceHistory: [
      {
        symbol: "AAPL",
        sourceId: "price-history-AAPL",
        priceMode: "split-adjusted-close",
        bars: bars(100),
      },
      ...(overrides.spy === false
        ? []
        : [
            {
              symbol: "SPY",
              sourceId: "price-history-SPY",
              priceMode: "split-adjusted-close" as const,
              bars: bars(500),
            },
          ]),
    ],
  });
}

const KNOWN = new Set(["verified-snapshot-AAPL", "price-history-AAPL", "price-history-SPY"]);

describe("Event Grid", () => {
  test("issues priced grid events with origin and Forecast Baseline", () => {
    const sources = gridSources();
    const grid = eventGrid(EQUITY, sources);
    expect(grid.events.map(({ id }) => id)).toEqual([
      "grid-range-1",
      "grid-range-5",
      "grid-range-20",
      "grid-relative-5",
    ]);
    const book = issueForecastBook({
      command: EQUITY,
      collectedSources: sources,
      modelPredictions: [
        prediction({ id: "p1", measurableAs: "close(AAPL, +5) > close(AAPL, 0)" }),
      ],
      modelEventGrid: grid.events.map(({ id }) => ({ id, probability: 0.4 })),
      knownSourceIds: KNOWN,
    });
    expect(book.gaps).toEqual([]);
    expect(book.predictions.map(({ id, origin }) => [id, origin])).toEqual([
      ["p1", "model"],
      ["grid-range-1", "grid"],
      ["grid-range-5", "grid"],
      ["grid-range-20", "grid"],
      ["grid-relative-5", "grid"],
    ]);
    for (const issued of book.predictions) {
      expect(issued.baselineVersion).toBe(FORECAST_BASELINE_VERSION);
      expect(issued.baselineProbability).toBeGreaterThan(0);
      expect(issued.infoCutoff).toBe(day(60));
    }
    expect(() =>
      validateResearchReport(researchReport({ predictions: book.predictions })),
    ).not.toThrow();
  });

  test("declares unpriced and invalid grid events instead of dropping or defaulting them", () => {
    const sources = gridSources();
    const book = issueForecastBook({
      command: EQUITY,
      collectedSources: sources,
      modelPredictions: [],
      modelEventGrid: [
        { id: "grid-range-1", probability: 0.3 },
        { id: "grid-range-5", probability: 1.4 },
        { id: "grid-range-20", probability: "0.3" },
      ],
      knownSourceIds: KNOWN,
    });
    expect(book.predictions.map(({ id }) => id)).toEqual(["grid-range-1"]);
    expect(book.gaps.map(({ source, message }) => `${source}: ${message}`)).toEqual([
      "event-grid: Event Grid events not issued because the final synthesis returned no valid eventGrid probability for them: grid-range-5, grid-range-20, grid-relative-5",
    ]);
  });

  test("folds a model prediction restating a grid event into the grid", () => {
    const sources = gridSources();
    const [range1, range5, range20, relative5] = eventGrid(EQUITY, sources).events;
    const book = issueForecastBook({
      command: EQUITY,
      collectedSources: sources,
      modelPredictions: [
        prediction({
          id: "pred-1",
          kind: "range",
          measurableAs: range20!.measurableAs,
          probability: 0.38,
        }),
        prediction({
          id: "pred-2",
          kind: "relative",
          measurableAs: relative5!.measurableAs,
          probability: 0.42,
        }),
        prediction({
          id: "pred-3",
          kind: "relative",
          measurableAs: relative5!.measurableAs,
          probability: 0.9,
        }),
        prediction({ id: range1!.id, probability: 0.2, sourceIds: ["other"] }),
        prediction({ id: "pred-4", measurableAs: "close(AAPL, +10) > close(AAPL, 0)" }),
      ],
      modelEventGrid: [
        { id: "grid-range-5", probability: 0.33 },
        { id: "grid-range-20", probability: 0.39 },
        { id: "grid-relative-5", probability: 7 },
      ],
      knownSourceIds: KNOWN,
    });
    expect(
      book.predictions.map(({ id, origin, probability }) => [id, origin, probability]),
    ).toEqual([
      ["pred-4", "model", 0.65],
      ["grid-range-1", "grid", 0.2],
      ["grid-range-5", "grid", 0.33],
      ["grid-range-20", "grid", 0.39],
      ["grid-relative-5", "grid", 0.42],
    ]);
    expect(book.predictions.find(({ id }) => id === range1!.id)?.sourceIds).toEqual(
      range1!.sourceIds,
    );
    expect(book.predictions.find(({ id }) => id === range5!.id)?.measurableAs).toBe(
      range5!.measurableAs,
    );
    expect(book.gaps).toEqual([]);
  });

  test("folds nothing when no grid is issued", () => {
    const book = issueForecastBook({
      command: { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "brief" },
      collectedSources: gridSources(),
      modelPredictions: [prediction({ id: "grid-range-1" })],
      modelEventGrid: [{ id: "grid-range-1", probability: 0.3 }],
      knownSourceIds: KNOWN,
    });
    expect(book.predictions.map(({ id, origin }) => [id, origin])).toEqual([
      ["grid-range-1", "model"],
    ]);
  });

  test("keeps a restatement as a model prediction when its grid event has no collected source", () => {
    const sources = gridSources();
    const relative5 = eventGrid(EQUITY, sources).events.find(({ kind }) => kind === "relative")!;
    const book = issueForecastBook({
      command: EQUITY,
      collectedSources: sources,
      modelPredictions: [prediction({ kind: "relative", measurableAs: relative5.measurableAs })],
      modelEventGrid: [],
      knownSourceIds: new Set(["verified-snapshot-AAPL"]),
    });
    expect(book.predictions.map(({ id, origin }) => [id, origin])).toEqual([["pred-1", "model"]]);
    expect(book.gaps.map(({ message }) => message)).toContain(
      "Event Grid event grid-relative-5 not issued: none of its close sources were collected",
    );
  });

  test("extends the baseline window to the snapshot's newer close so both share one spot", () => {
    const sources = gridSources();
    const book = issueForecastBook({
      command: EQUITY,
      collectedSources: {
        ...sources,
        verifiedMarketSnapshot: verifiedMarketSnapshot({
          recentCloses: [...alternatingCloses(61).slice(-29), { date: day(61), close: 100.5 }],
        }),
      },
      modelPredictions: [],
      modelEventGrid: [{ id: "grid-range-1", probability: 0.3 }],
      knownSourceIds: KNOWN,
    });
    expect(book.predictions.find(({ id }) => id === "grid-range-1")?.infoCutoff).toBe(day(61));
  });

  test("omits the baseline with a declared gap when the benchmark is missing", () => {
    const book = issueForecastBook({
      command: EQUITY,
      collectedSources: gridSources({ spy: false }),
      modelPredictions: [],
      modelEventGrid: [{ id: "grid-relative-5", probability: 0.5 }],
      knownSourceIds: KNOWN,
    });
    const relative = book.predictions.find(({ id }) => id === "grid-relative-5");
    expect(relative).toBeDefined();
    expect(relative).not.toHaveProperty("baselineProbability");
    expect(book.gaps.map(({ source, message }) => `${source}: ${message}`)).toContain(
      "forecast-baseline: Forecast Baseline omitted for grid-relative-5: no split-adjusted close history was collected for SPY",
    );
  });

  test("declares the grid off for crypto, the benchmark itself and a missing range reference", () => {
    const crypto = eventGrid(
      { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "brief" },
      gridSources(),
    );
    expect(crypto.events).toEqual([]);
    expect(crypto.gaps[0]?.message).toContain("crypto runs");
    const spy = eventGrid({ ...EQUITY, symbol: "SPY" }, gridSources());
    expect(spy.events.map(({ id }) => id)).not.toContain("grid-relative-5");
    expect(spy.gaps[0]?.message).toContain("SPY is its own benchmark");
    const noReference = eventGrid(EQUITY, collectedSources());
    expect(noReference.events.map(({ id }) => id)).toEqual(["grid-relative-5"]);
    expect(noReference.gaps[0]?.message).toContain("±1σ range reference");
  });

  test("schema rejects a baseline without its version and cutoff", () => {
    expect(() =>
      validateResearchReport(
        researchReport({ predictions: [prediction({ baselineProbability: 0.3 })] }),
      ),
    ).toThrow();
    expect(() =>
      validateResearchReport(
        researchReport({
          predictions: [prediction({ origin: "oracle" as unknown as "grid" })],
        }),
      ),
    ).toThrow();
  });

  test("grid events do not count toward the prediction target", () => {
    const report = rederivePredictionShortfallReportAfterPruning(
      researchReport({
        predictionShortfall: { emittedCount: 1, targetCount: 3, missingCount: 2 },
        predictions: [
          prediction({ id: "p1", origin: "model" }),
          prediction({ id: "grid-range-1", origin: "grid" }),
          prediction({ id: "grid-range-5", origin: "grid" }),
        ],
      }),
    );
    expect(report.predictionShortfall).toEqual({
      emittedCount: 1,
      targetCount: 3,
      missingCount: 2,
    });
  });
});
