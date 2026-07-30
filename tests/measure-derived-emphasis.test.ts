import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  aggregateMeasurements,
  aggregateRecords,
  assertOutputOutsideData,
  measureReport,
  parseArguments,
  renderHuman,
  type DerivedEmphasisArtifact,
  type PairMeasurement,
} from "../scripts/measure-derived-emphasis";

function measured(text: string) {
  return { status: "measured", measurement: measureReport(text) } as const;
}

describe("measureReport", () => {
  test("normalizes derived-construction spelling variants", () => {
    const report = [
      "TTM trailing twelve trailing-twelve-month trailing 12 months",
      "CAGR compound annual growth rate peer median peer-median",
      "peer implied peer-implied range implied-range annualized annualised",
    ].join(" ");

    const measurement = measureReport(report);

    expect(measurement.derivedMarkerCount).toBe(13);
    expect(measurement.firstDerivedFraction).toBe(0);
  });

  test("counts ISO dates as reported-period anchors", () => {
    const measurement = measureReport(
      "Results were reported for 2026-03-31 and compared with 2025-03-31.",
    );

    expect(measurement.reportedMarkerCount).toBe(2);
    expect(measurement.derivedToReportedRatio).toBe(0);
  });

  test("normalizes period, fiscal-quarter, fiscal-year, and filing-form anchors", () => {
    const report = [
      "period ended period-end",
      "Q2 FY2026 Q3'25 FY 2026 fiscal second quarter 2025 fiscal-year 2024",
      "10-K 10Q 6-K 20-F",
    ].join(" ");

    const measurement = measureReport(report);

    expect(measurement.reportedMarkerCount).toBe(11);
  });

  test("normalizes counts per thousand words and measures first derived position", () => {
    const measurement = measureReport("reported facts first TTM later");

    expect(measurement.wordCount).toBe(5);
    expect(measurement.derivedPerThousandWords).toBe(200);
    expect(measurement.reportedPerThousandWords).toBe(0);
    expect(measurement.derivedToReportedRatio).toBeNull();
    expect(measurement.firstDerivedFraction).toBe(21 / 30);
  });
});

describe("derived emphasis aggregation", () => {
  test("uses true medians for even and odd repetition counts", () => {
    const measurements = [
      measureReport("TTM 2026-03-31"),
      measureReport("TTM TTM TTM 2026-03-31"),
      measureReport("TTM TTM 2026-03-31"),
    ];

    const medians = aggregateMeasurements(measurements);

    expect(medians.derivedMarkerCount).toBe(2);
    expect(medians.reportedMarkerCount).toBe(1);
    expect(medians.derivedToReportedRatio).toBe(2);
    expect(aggregateMeasurements(measurements.slice(0, 2)).derivedMarkerCount).toBe(2);
  });

  test("aggregates each scenario and emits simplified-minus-legacy deltas", () => {
    const records: readonly PairMeasurement[] = [
      {
        scenario: "scenario",
        repetition: 1,
        variants: {
          legacy: measured("TTM 2026-03-31"),
          simplified: measured("TTM TTM TTM 2026-03-31"),
        },
      },
      {
        scenario: "scenario",
        repetition: 2,
        variants: {
          legacy: measured("TTM TTM 2026-03-31"),
          simplified: {
            status: "artifact-error",
            error: "missing report.md",
          },
        },
      },
    ];

    const [scenario] = aggregateRecords(records);

    expect(scenario?.variants.legacy.measuredReportCount).toBe(2);
    expect(scenario?.variants.simplified.errorCount).toBe(1);
    expect(scenario?.variants.legacy.medians.derivedMarkerCount).toBe(1.5);
    expect(scenario?.simplifiedMinusLegacy.derivedMarkerCount).toBe(1.5);
  });
});

describe("measure-derived-emphasis CLI helpers", () => {
  test("parses root and optional output flags", () => {
    expect(parseArguments(["--root", "evaluation", "--json", "--out", "result.json"])).toEqual({
      root: "evaluation",
      json: true,
      out: "result.json",
    });
  });

  test("renders report rows, scenario medians, and deltas", () => {
    const measurement = measureReport("TTM 2026-03-31");
    const variant = { status: "measured", runDir: "run", measurement } as const;
    const artifact: DerivedEmphasisArtifact = {
      version: 1,
      evaluationRoot: "evaluation",
      selectedAutomatically: false,
      records: [
        {
          scenario: "scenario",
          repetition: 1,
          variants: { legacy: variant, simplified: variant },
        },
      ],
      scenarios: aggregateRecords([
        {
          scenario: "scenario",
          repetition: 1,
          variants: { legacy: variant, simplified: variant },
        },
      ]),
    };

    const output = renderHuman(artifact);

    expect(output).toContain("Scenario medians");
    expect(output).toContain("legacy: n=1, errors=0");
    expect(output).toContain("delta: derived=0.00, reported=0.00, derived/1kw=0.00");
  });

  test.each([
    ["relative data path", "data/out.json"],
    ["traversal into data", "scripts/../data/out.json"],
    [
      "absolute data path",
      resolve(import.meta.dir, "..", "data", "__measure_derived_emphasis_test__", "out.json"),
    ],
    ["bare data", "data"],
  ])("rejects %s", (_label, out) => {
    expect(() => assertOutputOutsideData(out)).toThrow("--out must not write under data/");
  });

  test("accepts an output path outside repository data", () => {
    const output = resolve(import.meta.dir, "..", "artifacts", "derived-emphasis.json");

    expect(assertOutputOutsideData(output)).toBe(output);
  });
});
