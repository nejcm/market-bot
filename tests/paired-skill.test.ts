import { describe, expect, test } from "bun:test";
import { pairedSkillView } from "../app/client/view-model";
import {
  buildCalibrationSummary,
  nextPairedSkillReviewDate,
  PAIRED_SKILL_POLICY,
  type ResolvedPair,
} from "../src/scoring/calibration";
import { renderCalibrationConsole } from "../src/scoring/calibration-console";
import { renderCalibrationMarkdown } from "../src/scoring/calibration-markdown";
import { prediction, predictionScore } from "./support/fixtures";

const DAY_MS = 86_400_000;
const START = Date.parse("2026-01-05T15:00:00.000Z");

interface EventSpec {
  readonly subject: string;
  readonly dayOffset: number;
  readonly hit: boolean;
  readonly modelProbability: number;
  readonly baselineProbability?: number;
  readonly horizonTradingDays?: number;
  readonly kind?: "direction" | "conditional";
  readonly measurableAs?: string;
  readonly assetClass?: "equity" | "crypto";
  readonly runId?: string;
  readonly origin?: "grid" | "model";
}

function pair(spec: EventSpec, index: number): ResolvedPair {
  const issued = START + spec.dayOffset * DAY_MS;
  const generatedAt = new Date(issued).toISOString();
  const runId = spec.runId ?? `run-${String(index)}`;
  return {
    prediction: prediction({
      id: `p-${String(index)}`,
      scoringPolicyVersion: 3,
      kind: spec.kind ?? "direction",
      subject: spec.subject,
      measurableAs: spec.measurableAs ?? `close(${spec.subject}, +5) > close(${spec.subject}, 0)`,
      horizonTradingDays: spec.horizonTradingDays ?? 5,
      probability: spec.modelProbability,
      ...(spec.origin === undefined ? {} : { origin: spec.origin }),
      ...(spec.baselineProbability === undefined
        ? {}
        : {
            baselineProbability: spec.baselineProbability,
            baselineVersion: "ewma-0.94-w60-v1",
            infoCutoff: generatedAt.slice(0, 10),
          }),
    }),
    score: predictionScore(spec.hit ? "hit" : "miss", {
      predictionId: `p-${String(index)}`,
      runId,
      scoringVersion: 3,
      observedAt: "2026-10-01T00:00:00.000Z",
    }),
    assetClass: spec.assetClass ?? "equity",
    jobType: "equity",
    runId,
    generatedAt,
  };
}

// `count` weekly, non-overlapping events spread over five subjects.
function events(count: number, model: (hit: boolean, index: number) => number): ResolvedPair[] {
  return Array.from({ length: count }, (_, index) => {
    const hit = index % 2 === 0;
    return pair(
      {
        subject: ["AAPL", "MSFT", "AMD", "NVDA", "SPY"][index % 5]!,
        dayOffset: Math.floor(index / 5) * 14,
        hit,
        modelProbability: model(hit, index),
        baselineProbability: 0.5,
      },
      index,
    );
  });
}

function paired(pairs: readonly ResolvedPair[]) {
  return buildCalibrationSummary(pairs, new Date("2026-10-20T00:00:00.000Z")).pairedSkill!;
}

function rangeAs(version: string, base: ResolvedPair, id: string): ResolvedPair {
  return {
    ...base,
    prediction: {
      ...base.prediction,
      id,
      kind: "range",
      measurableAs: `close(${base.prediction.subject}, +5) outside [${version.endsWith("v1") ? "95, 105" : "96, 104"}]`,
      baselineProbability: 0.32,
      baselineVersion: version,
    },
  };
}

describe("Paired Skill", () => {
  test("model better than the baseline beyond the minimum useful effect", () => {
    const summary = paired(events(40, (hit) => (hit ? 0.8 : 0.2)));
    expect(summary.overall).toMatchObject({
      count: 40,
      subjectCount: 5,
      blockCount: 40,
      deltaBrier: expect.closeTo(0.21, 10),
      ciLow: expect.closeTo(0.21, 10),
      status: "model-better",
      meetsMinimumUsefulEffect: true,
      skillVsHalf: expect.closeTo(0.84, 10),
    });
    expect(summary.byKind.direction?.status).toBe("model-better");
  });

  test("baseline better than the model", () => {
    const summary = paired(events(40, (hit) => (hit ? 0.2 : 0.8)));
    expect(summary.overall).toMatchObject({
      status: "baseline-better",
      meetsMinimumUsefulEffect: false,
    });
    expect(summary.overall!.ciHigh).toBeLessThan(0);
  });

  test("indistinguishable when the interval spans zero", () => {
    const summary = paired(events(40, () => 0.6));
    expect(summary.overall!.ciLow).toBeLessThan(0);
    expect(summary.overall!.ciHigh).toBeGreaterThan(0);
    expect(summary.overall!.status).toBe("not-yet-decidable");
  });

  test("below the pre-registered floor stays not-yet-decidable even with a one-sided interval", () => {
    const summary = paired(
      events(PAIRED_SKILL_POLICY.minPairedCount - 1, (hit) => (hit ? 0.8 : 0.2)),
    );
    expect(summary.overall!.ciLow).toBeGreaterThan(0);
    expect(summary.overall!.status).toBe("not-yet-decidable");
  });

  test("excludes v1 range baselines but keeps v1 direction and every v2 baseline", () => {
    const direction = events(4, (hit) => (hit ? 0.8 : 0.2));
    const legacy = events(3, () => 0.4).map((base, index) =>
      rangeAs("ewma-0.94-w60-v1", base, `v1-${String(index)}`),
    );
    const current = events(2, () => 0.4).map((base, index) =>
      rangeAs("ewma-0.94-w60-v2", base, `v2-${String(index)}`),
    );
    const summary = paired([...direction, ...legacy, ...current]);
    expect(summary.excludedLegacyRangeBaselineCount).toBe(3);
    expect(summary.excludedWithoutBaselineCount).toBe(0);
    expect(summary.overall?.count).toBe(6);
    expect(summary.byKind.range?.count).toBe(2);
    expect(summary.byKind.direction?.count).toBe(4);
    const calibration = buildCalibrationSummary(
      [...direction, ...legacy, ...current],
      new Date("2026-10-20T00:00:00.000Z"),
    );
    expect(renderCalibrationMarkdown(calibration)).toContain(
      "Range events excluded on the superseded ewma-0.94-w60-v1 baseline: 3",
    );
    expect(renderCalibrationConsole(calibration)).toContain(
      "3 range excluded on the superseded ewma-0.94-w60-v1 baseline",
    );
  });

  test("predictions without a baseline are excluded and counted", () => {
    const withBaseline = events(4, (hit) => (hit ? 0.8 : 0.2));
    const without = [
      pair({ subject: "AAPL", dayOffset: 400, hit: true, modelProbability: 0.9 }, 100),
      pair({ subject: "MSFT", dayOffset: 400, hit: false, modelProbability: 0.9 }, 101),
    ];
    const summary = paired([...withBaseline, ...without]);
    expect(summary.excludedWithoutBaselineCount).toBe(2);
    expect(summary.overall?.count).toBe(4);
    const none = paired(without);
    expect(none.excludedWithoutBaselineCount).toBe(2);
    expect(none).not.toHaveProperty("overall");
    expect(none.byKind).toEqual({});
  });

  test("events whose resolution windows overlap on one subject share a bootstrap block", () => {
    const summary = paired([
      pair(
        {
          subject: "AAPL",
          dayOffset: 0,
          hit: true,
          modelProbability: 0.8,
          baselineProbability: 0.5,
        },
        0,
      ),
      pair(
        {
          subject: "AAPL",
          dayOffset: 3,
          hit: true,
          modelProbability: 0.8,
          baselineProbability: 0.5,
        },
        1,
      ),
      pair(
        {
          subject: "AAPL:SPY",
          dayOffset: 9,
          hit: true,
          modelProbability: 0.8,
          baselineProbability: 0.5,
        },
        2,
      ),
      pair(
        {
          subject: "AAPL",
          dayOffset: 30,
          hit: true,
          modelProbability: 0.8,
          baselineProbability: 0.5,
        },
        3,
      ),
      pair(
        {
          subject: "MSFT",
          dayOffset: 3,
          hit: true,
          modelProbability: 0.8,
          baselineProbability: 0.5,
        },
        4,
      ),
    ]);
    expect(summary.overall).toMatchObject({ count: 5, subjectCount: 2, blockCount: 3 });
  });

  test("a grid event re-issued by two runs on the same session counts once", () => {
    const grid = (index: number, runId: string) =>
      pair(
        {
          subject: "AAPL",
          dayOffset: 0,
          hit: true,
          modelProbability: 0.6,
          baselineProbability: 0.5,
          runId,
          origin: "grid",
        },
        index,
      );
    const summary = buildCalibrationSummary([grid(0, "run-a"), grid(1, "run-b")]);
    expect(summary.duplicateForecastCount).toBe(1);
    expect(summary.pairedSkill?.overall?.count).toBe(1);
  });

  test("the interval depends on the set of Forecast Events, not their input order", () => {
    const pairs = Array.from({ length: 36 }, (_, index) => {
      const hit = index % 3 !== 0;
      return pair(
        {
          subject: `S${String(index % 12)}`,
          dayOffset: Math.floor(index / 12) * 14,
          hit,
          modelProbability: hit ? 0.62 : 0.45,
          baselineProbability: 0.5,
        },
        index,
      );
    });
    const reference = paired(pairs);
    for (const step of [5, 7, 11, 13, 25]) {
      const shuffled = pairs.map((_, index) => pairs[(index * step) % pairs.length]!);
      expect(paired(shuffled)).toEqual(reference);
    }
    expect(paired(pairs.toReversed())).toEqual(reference);
  });

  test("blocks end at the close due date, not the score-pass clock", () => {
    const summary = paired(
      [0, 2, 7, 9, 14].map((dayOffset, index) =>
        pair(
          {
            subject: "AAPL",
            dayOffset,
            hit: true,
            modelProbability: 0.8,
            baselineProbability: 0.5,
            horizonTradingDays: 1,
          },
          index,
        ),
      ),
    );
    expect(summary.overall).toMatchObject({ count: 5, blockCount: 5 });
  });

  test("crypto blocks end on the v3 UTC-day clock", () => {
    const crypto = (dayOffset: number, index: number) =>
      pair(
        {
          subject: "BTC",
          dayOffset,
          hit: true,
          modelProbability: 0.8,
          baselineProbability: 0.5,
          assetClass: "crypto",
        },
        index,
      );
    // Issued Jan 5 15:00, h=5: v3 is due Jan 11 00:00 UTC, v2 (NYSE clock) Jan 12 15:00.
    expect(paired([crypto(0, 0), crypto(6, 1)]).overall?.blockCount).toBe(2);
  });

  test("enough events but too few blocks stays not-yet-decidable", () => {
    const tradingDays = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
    const pairs = Array.from({ length: 40 }, (_, index) =>
      pair(
        {
          subject: ["AAPL", "MSFT", "AMD", "NVDA"][index % 4]!,
          dayOffset: tradingDays[Math.floor(index / 4)]!,
          hit: true,
          modelProbability: 0.8,
          baselineProbability: 0.5,
        },
        index,
      ),
    );
    const summary = buildCalibrationSummary(pairs);
    const overall = summary.pairedSkill!.overall!;
    expect(overall).toMatchObject({ count: 40, blockCount: 4, status: "not-yet-decidable" });
    expect(overall.ciLow).toBeGreaterThan(0);
    expect(renderCalibrationMarkdown(summary)).toContain("not-yet-decidable (below 5-block floor)");
  });

  test("a conditional without a baseline is excluded beside a paired direction event", () => {
    const summary = paired([
      pair(
        {
          subject: "AAPL",
          dayOffset: 0,
          hit: true,
          modelProbability: 0.7,
          baselineProbability: 0.5,
        },
        0,
      ),
      pair(
        {
          subject: "AAPL",
          dayOffset: 0,
          hit: false,
          modelProbability: 0.6,
          kind: "conditional",
          measurableAs:
            "if close(AAPL, +1) > close(AAPL, 0) then close(AAPL, +5) > close(AAPL, +1)",
        },
        1,
      ),
    ]);
    expect(summary.excludedWithoutBaselineCount).toBe(1);
    expect(Object.keys(summary.byKind)).toEqual(["direction"]);
    expect(summary.overall?.count).toBe(1);
  });

  test("markdown, text console and Research Console show the headline and the 0.5 column", () => {
    const summary = buildCalibrationSummary(events(40, (hit) => (hit ? 0.8 : 0.2)));
    const markdown = renderCalibrationMarkdown(summary);
    expect(markdown).toContain("## Paired skill vs Forecast Baseline");
    expect(markdown).toContain("Excluded without a Forecast Baseline: 0");
    expect(markdown).toContain(
      "| all | 40 | 40 | +0.2100 | [+0.2100, +0.2100] | model-better (meets minimum useful effect) | none (decided per kind) | 0.8400 |",
    );
    const stdout = renderCalibrationConsole(summary);
    expect(stdout).toContain(
      "all: 0.2100 [0.2100, 0.2100], n=40, 40 blocks, model-better (meets minimum useful effect)",
    );
    expect(stdout).toContain("direction: 0.2100");
    expect(stdout).toContain("at next review: keep model probabilities");
    expect(stdout).toContain(
      `Next pre-registered review: ${summary.pairedSkill?.nextReviewDate ?? ""}`,
    );
    expect(markdown).toContain("Next pre-registered review: ");
    expect(stdout).toContain("about 784 independent blocks");
    expect(markdown).toContain("about 784 independent blocks");
    const view = pairedSkillView({
      summary: structuredClone(summary) as unknown as Record<string, unknown>,
    });
    expect(view?.summary).toEqual(summary.pairedSkill);
    expect(view?.policyNote).toContain("about 784 independent blocks");
    expect(view?.rows.map(({ key, status, decisionRule }) => [key, status, decisionRule])).toEqual([
      ["all", "model-better", undefined],
      ["direction", "model-better", "keep-model"],
    ]);
    expect(pairedSkillView({ summary: {} })).toBeUndefined();
    const { pairedSkill: _omitted, ...legacy } = summary;
    expect(renderCalibrationMarkdown(legacy)).toContain("_Not recorded in this summary._");
    expect(renderCalibrationConsole(legacy)).toContain(
      "Paired skill: not recorded in this summary",
    );
  });

  test("next review date follows the pre-registered quarterly schedule", () => {
    expect(nextPairedSkillReviewDate(new Date("2026-10-20T00:00:00Z"))).toBe("2027-01-15");
    expect(nextPairedSkillReviewDate(new Date("2027-01-15T12:00:00Z"))).toBe("2027-01-15");
    expect(nextPairedSkillReviewDate(new Date("2027-01-16T00:00:00Z"))).toBe("2027-04-15");
    expect(nextPairedSkillReviewDate(new Date("2027-10-16T00:00:00Z"))).toBe("2028-01-15");
  });

  test("decision rule follows status and the minimum useful effect", () => {
    const rule = (model: (hit: boolean) => number) =>
      buildCalibrationSummary(events(40, model)).pairedSkill?.byKind.direction?.decisionRule;
    expect(rule((hit) => (hit ? 0.8 : 0.2))).toBe("keep-model");
    expect(rule((hit) => (hit ? 0.2 : 0.8))).toBe("publish-baseline");
    expect(rule(() => 0.5)).toBe("keep-recording");
  });

  test("the overall aggregate carries no decision; kinds below the floor keep recording", () => {
    const mixed = events(40, (hit) => (hit ? 0.3 : 0.7)).map(
      (event, index): ResolvedPair =>
        index % 2 === 0
          ? event
          : { ...event, prediction: { ...event.prediction, kind: "range" as const } },
    );
    const summary = buildCalibrationSummary(mixed, new Date("2026-10-20T00:00:00.000Z"));
    const skill = summary.pairedSkill!;
    expect(skill.overall?.status).toBe("baseline-better");
    expect(skill.overall).not.toHaveProperty("decisionRule");
    expect(
      Object.values(skill.byKind).map(({ count, decisionRule }) => [count, decisionRule]),
    ).toEqual([
      [20, "keep-recording"],
      [20, "keep-recording"],
    ]);
    const allRow = renderCalibrationMarkdown(summary)
      .split("\n")
      .find((line) => line.startsWith("| all |"));
    expect(allRow).toContain("none (decided per kind)");
    expect(renderCalibrationConsole(summary)).not.toContain("publish the Forecast Baseline");
    const view = pairedSkillView({
      summary: structuredClone(summary) as unknown as Record<string, unknown>,
    });
    expect(view?.rows[0]).toMatchObject({ key: "all", decisionText: "none (decided per kind)" });
    expect(view?.rows[0]).not.toHaveProperty("decisionRule");
  });
});
