import { describe, expect, test } from "bun:test";
import { assessEvidenceQuality } from "../src/research/evidence-quality";
import type {
  BuildSourcePlanResult,
  EvidenceClass,
  EvidenceLane,
} from "../src/research/source-plan";

const generatedAt = "2026-06-01T00:00:00.000Z";

function planning(
  lanes: readonly {
    lane: EvidenceLane;
    evidenceClass: EvidenceClass;
    covered?: boolean;
    sourceCount?: number;
    observedAt?: string;
    provider?: string;
  }[],
): BuildSourcePlanResult {
  const coverage = lanes.map((lane) => ({
    lane: lane.lane,
    evidenceClass: lane.evidenceClass,
    status: lane.covered === false ? ("gap" as const) : ("covered" as const),
    coveredSourceIds:
      lane.covered === false
        ? []
        : Array.from(
            { length: lane.sourceCount ?? 1 },
            (_, index) => `${lane.lane}-source-${String(index + 1)}`,
          ),
    gapIds: lane.covered === false ? [`${lane.lane}:gap:1`] : [],
    gapText: lane.covered === false ? [`${lane.lane}: missing`] : [],
    freshnessNotes: [],
  }));
  const sources = lanes.flatMap((lane) =>
    lane.covered === false
      ? []
      : Array.from({ length: lane.sourceCount ?? 1 }, (_, index) => ({
          id: `${lane.lane}-source-${String(index + 1)}`,
          kind: "market-data" as const,
          provider: lane.provider ?? "provider-a",
          observedAt: lane.observedAt ?? generatedAt,
          lane: lane.lane,
          posture: "covered" as const,
          relatedGapIds: [],
        })),
  );
  return {
    sourcePlan: {
      version: 2,
      generatedAt,
      run: { jobType: "daily", assetClass: "equity", depth: "brief" },
      lanes: coverage.map((lane) => ({
        lane: lane.lane,
        evidenceClass: lane.evidenceClass,
        appliesToRun: true,
        capability: lane.lane,
      })),
    },
    evidenceLanes: {
      version: 2,
      generatedAt,
      lanes: coverage,
      summary: {
        plannedLaneCount: coverage.length,
        coreLaneCount: coverage.filter((lane) => lane.evidenceClass === "core").length,
        materialLaneCount: coverage.filter((lane) => lane.evidenceClass === "material").length,
        supplementalLaneCount: coverage.filter((lane) => lane.evidenceClass === "supplemental")
          .length,
        coveredLaneCount: coverage.filter((lane) => lane.status === "covered").length,
        gapLaneCount: coverage.filter((lane) => lane.status === "gap").length,
        coreGapLaneCount: coverage.filter(
          (lane) => lane.evidenceClass === "core" && lane.status === "gap",
        ).length,
        materialGapLaneCount: coverage.filter(
          (lane) => lane.evidenceClass === "material" && lane.status === "gap",
        ).length,
        sourceCount: sources.length,
        gapCount: coverage.filter((lane) => lane.status === "gap").length,
        coverageRatio:
          coverage.length === 0
            ? 1
            : coverage.filter((lane) => lane.status === "covered").length / coverage.length,
      },
    },
    sourceLedger: { version: 2, generatedAt, sources },
  };
}

describe("deterministic evidence quality", () => {
  test("maps missing core to low and missing material to medium", () => {
    expect(
      assessEvidenceQuality(
        planning([
          { lane: "market-data", evidenceClass: "core", covered: false },
          { lane: "news", evidenceClass: "material", sourceCount: 2 },
        ]),
        generatedAt,
      ).label,
    ).toBe("low");
    expect(
      assessEvidenceQuality(
        planning([
          { lane: "market-data", evidenceClass: "core" },
          { lane: "news", evidenceClass: "material", covered: false },
        ]),
        generatedAt,
      ).label,
    ).toBe("medium");
  });

  test("supplemental gaps do not lower high", () => {
    expect(
      assessEvidenceQuality(
        planning([
          { lane: "market-data", evidenceClass: "core" },
          { lane: "news", evidenceClass: "material", sourceCount: 2 },
          { lane: "supplemental-market", evidenceClass: "supplemental", covered: false },
        ]),
        generatedAt,
      ).label,
    ).toBe("high");
  });

  test("material freshness and risk-based corroboration limit high", () => {
    expect(
      assessEvidenceQuality(
        planning([
          { lane: "market-data", evidenceClass: "core" },
          {
            lane: "news",
            evidenceClass: "material",
            sourceCount: 2,
            observedAt: "2026-05-01T00:00:00.000Z",
          },
        ]),
        generatedAt,
      ).label,
    ).toBe("medium");
    expect(
      assessEvidenceQuality(
        planning([
          { lane: "market-data", evidenceClass: "core" },
          { lane: "news", evidenceClass: "material", sourceCount: 1 },
        ]),
        generatedAt,
      ).label,
    ).toBe("medium");
  });

  test("provider identity does not affect capability assessment", () => {
    const first = assessEvidenceQuality(
      planning([{ lane: "market-data", evidenceClass: "core", provider: "provider-a" }]),
      generatedAt,
    );
    const substitute = assessEvidenceQuality(
      planning([{ lane: "market-data", evidenceClass: "core", provider: "provider-b" }]),
      generatedAt,
    );
    expect(substitute.label).toBe(first.label);
    expect(substitute.checks).toEqual(first.checks);
  });
});
