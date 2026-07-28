import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  assertOutputOutsideData,
  measureRangePrediction,
  parseArguments,
  renderHuman,
  totalFor,
  type BandGeometryArtifact,
} from "../scripts/measure-band-geometry";

const EVIDENCE = {
  marketSnapshots: [
    {
      symbol: "AAPL",
      price: 200,
      observedAt: "2026-06-15T14:30:00Z",
      sourceId: "market-yahoo-equity-aapl",
    },
  ],
  verifiedMarketSnapshot: {
    symbol: "AAPL",
    latestSessionDate: "2026-05-01",
    ohlcv: { close: 216.6 },
  },
  impliedPriceRange: { low: 145.6, high: 264.73 },
} as const;

describe("measureRangePrediction", () => {
  test("measures midpoint-relative width, quote-relative centring, and implied-range copies", () => {
    const measurement = measureRangePrediction(
      {
        id: "pred-1",
        kind: "range",
        subject: "AAPL",
        measurableAs: "close(AAPL, +5) outside [145.6, 264.73]",
      },
      EVIDENCE,
    );

    expect(measurement.relativeBandHalfWidth.valuePercent).toBeCloseTo(29.03, 2);
    expect(measurement.bandCentring.valuePercent).toBeCloseTo(2.5825, 4);
    expect(measurement.bandCentring.reference?.kind).toBe("current-price-reference");
    expect(measurement.impliedPriceRangeCopy).toEqual({ status: "checked", matches: true });
    expect(measurement.unmeasurableReasons).toEqual([]);
  });

  test("detects an implied-range copy rounded to one decimal place", () => {
    const measurement = measureRangePrediction(
      {
        id: "pred-1",
        subject: "AAPL",
        measurableAs: "close(AAPL, +5) outside [145.6, 264.7]",
      },
      EVIDENCE,
    );

    expect(measurement.impliedPriceRangeCopy).toEqual({ status: "checked", matches: true });
  });

  test("falls back to the verified latest close when the quote is older", () => {
    const measurement = measureRangePrediction(
      {
        id: "pred-1",
        subject: "AAPL",
        measurableAs: "close(AAPL, +5) outside [190, 210]",
      },
      {
        ...EVIDENCE,
        marketSnapshots: [
          {
            symbol: "AAPL",
            price: 195,
            observedAt: "2026-04-30T14:30:00Z",
            sourceId: "market-yahoo-equity-aapl",
          },
        ],
      },
    );

    expect(measurement.bandCentring.reference).toEqual({
      kind: "verified-snapshot-latest-close",
      price: 216.6,
      asOf: "2026-05-01",
      sourceId: "verified-snapshot-AAPL",
    });
  });

  test("keeps malformed range predictions visible with explicit reasons", () => {
    const measurement = measureRangePrediction(
      { id: "pred-bad", kind: "range", subject: "AAPL" },
      EVIDENCE,
    );

    expect(measurement.relativeBandHalfWidth).toEqual({
      status: "unmeasurable",
      reason: "missing-measurable-as",
    });
    expect(measurement.bandCentring).toEqual({
      status: "unmeasurable",
      reason: "missing-measurable-as",
    });
    expect(measurement.unmeasurableReasons).toEqual(["missing-measurable-as"]);
  });
});

describe("measure-band-geometry CLI helpers", () => {
  test("parses one positional root and optional output flags", () => {
    expect(parseArguments(["root", "--json", "--out", "result.json"])).toEqual({
      root: "root",
      json: true,
      out: "result.json",
    });
  });

  test("renders zero-range variants instead of inventing a denominator", () => {
    const emptyVariant = {
      status: "measured",
      runDir: "run",
      rangePredictionCount: 0,
      measurablePredictionCount: 0,
      unmeasurablePredictionCount: 0,
      unmeasurableReasonCounts: {},
      measurements: [],
    } as const;
    const artifact: BandGeometryArtifact = {
      version: 1,
      evaluationRoot: "evaluation",
      selectedAutomatically: false,
      records: [
        {
          scenario: "scenario",
          repetition: 1,
          variants: { legacy: emptyVariant, simplified: emptyVariant },
        },
      ],
      totals: {
        legacy: {
          rangePredictionCount: 0,
          measurablePredictionCount: 0,
          unmeasurablePredictionCount: 0,
          impliedPriceRangeCopyCount: 0,
          copyCheckUnavailableCount: 0,
          variantErrorCount: 0,
          artifactErrorCount: 0,
          unmeasurableReasonCounts: {},
        },
        simplified: {
          rangePredictionCount: 0,
          measurablePredictionCount: 0,
          unmeasurablePredictionCount: 0,
          impliedPriceRangeCopyCount: 0,
          copyCheckUnavailableCount: 0,
          variantErrorCount: 1,
          artifactErrorCount: 2,
          unmeasurableReasonCounts: {},
        },
      },
    };

    expect(renderHuman(artifact)).toContain("(no range predictions)");
    expect(renderHuman(artifact)).toContain("simplified: range=0, measurable=0, unmeasurable=0");
    expect(renderHuman(artifact)).toContain(
      "copy-check-unavailable=0, variant-errors=1, artifact-errors=2",
    );
  });

  test("derives measurement, copy-unavailable, variant-error, and artifact-error totals", () => {
    const measurable = measureRangePrediction(
      {
        id: "pred-good",
        subject: "AAPL",
        measurableAs: "close(AAPL, +5) outside [145.6, 264.73]",
      },
      EVIDENCE,
    );
    const unmeasurable = measureRangePrediction(
      { id: "pred-bad", kind: "range", subject: "AAPL" },
      {
        marketSnapshots: EVIDENCE.marketSnapshots,
        verifiedMarketSnapshot: EVIDENCE.verifiedMarketSnapshot,
      },
    );
    const noRanges = {
      status: "measured",
      rangePredictionCount: 0,
      measurablePredictionCount: 0,
      unmeasurablePredictionCount: 0,
      unmeasurableReasonCounts: {},
      measurements: [],
    } as const;
    const records = [
      {
        scenario: "measured",
        repetition: 1,
        variants: {
          legacy: {
            status: "measured",
            rangePredictionCount: 2,
            measurablePredictionCount: 1,
            unmeasurablePredictionCount: 1,
            unmeasurableReasonCounts: { "missing-measurable-as": 1 },
            measurements: [measurable, unmeasurable],
          },
          simplified: noRanges,
        },
      },
      {
        scenario: "variant-error-1",
        repetition: 1,
        variants: {
          legacy: {
            status: "variant-error",
            error: "failed",
            rangePredictionCount: 0,
            measurablePredictionCount: 0,
            unmeasurablePredictionCount: 0,
            unmeasurableReasonCounts: {},
            measurements: [],
          },
          simplified: noRanges,
        },
      },
      {
        scenario: "variant-error-2",
        repetition: 1,
        variants: {
          legacy: {
            status: "variant-error",
            error: "failed again",
            rangePredictionCount: 0,
            measurablePredictionCount: 0,
            unmeasurablePredictionCount: 0,
            unmeasurableReasonCounts: {},
            measurements: [],
          },
          simplified: noRanges,
        },
      },
      {
        scenario: "artifact-error",
        repetition: 1,
        variants: {
          legacy: {
            status: "artifact-error",
            error: "unreadable",
            rangePredictionCount: 0,
            measurablePredictionCount: 0,
            unmeasurablePredictionCount: 0,
            unmeasurableReasonCounts: {},
            measurements: [],
          },
          simplified: noRanges,
        },
      },
    ] as const;

    expect(totalFor(records, "legacy")).toEqual({
      rangePredictionCount: 2,
      measurablePredictionCount: 1,
      unmeasurablePredictionCount: 1,
      impliedPriceRangeCopyCount: 1,
      copyCheckUnavailableCount: 1,
      variantErrorCount: 2,
      artifactErrorCount: 1,
      unmeasurableReasonCounts: { "missing-measurable-as": 1 },
    });
  });

  test.each([
    ["relative data path", "data/out.json"],
    ["traversal into data", "scripts/../data/out.json"],
    [
      "absolute data path",
      resolve(import.meta.dir, "..", "data", "__measure_band_geometry_test__", "out.json"),
    ],
    ["bare data", "data"],
  ])("rejects %s", (_label, out) => {
    expect(() => assertOutputOutsideData(out)).toThrow("--out must not write under data/");
  });

  test("accepts an output path outside repository data", () => {
    const output = resolve(import.meta.dir, "..", "artifacts", "band-geometry.json");

    expect(assertOutputOutsideData(output)).toBe(output);
  });
});
