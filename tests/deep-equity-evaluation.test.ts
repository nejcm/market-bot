import { afterEach, describe, expect, test } from "bun:test";
import {
  aggregateDeepEquityEvaluation,
  createSeededEvaluationRandom,
  deepEquityVariantEvaluationMetrics,
  evaluateDeepEquityGates,
  judgeDeepEquityPair,
  judgeDeepEquityPairSafely,
  PAIRWISE_JUDGE_DIMENSIONS,
  type DeepEquityEvaluationAggregate,
  type DeepEquityEvaluationRunRecord,
  type DeepEquityGateName,
  type DeepEquityHardGateInputs,
  type DeepEquityVariantEvaluationMetrics,
  type PairwiseJudgeResult,
} from "./support/deep-equity-evaluation";
import {
  deriveEvaluationStreamSeed,
  type EvaluationRandomStreamName,
} from "./support/evaluation-random";
import type { ModelRequest } from "../src/model/types";
import {
  measureDeepEquityLegacyBaseline,
  measureDeepEquitySimplifiedCallBudgets,
  readDeepEquityLegacyBaseline,
} from "./support/deep-equity-pipeline-baseline";
import { researchReport } from "./support/fixtures";
import {
  loadFixture,
  runFixture,
  runFixturePair,
  type RunFixturePairResult,
} from "./support/run-fixtures";
import { makeReplayProvider } from "./support/run-fixtures/llm-cassette";

const pairResults: RunFixturePairResult[] = [];

afterEach(async () => {
  await Promise.all(pairResults.splice(0).map((result) => result.cleanup()));
});

function judgeResponse(): string {
  return JSON.stringify({
    dimensions: Object.fromEntries(
      PAIRWISE_JUDGE_DIMENSIONS.map((dimension) => [
        dimension,
        { A: 5, B: 3, rationale: `${dimension} comparison` },
      ]),
    ),
    winner: "A",
    rationale: "A is stronger overall.",
    criticalMaterialEvidenceOmissions: { A: [], B: ["material event omitted"] },
  });
}

describe("deep-equity pipeline evaluation", () => {
  test("pins the regenerable legacy baseline to fixed fixture cassettes", async () => {
    const measured = await measureDeepEquityLegacyBaseline();
    expect(measured).toEqual(await readDeepEquityLegacyBaseline());
    for (const fixture of measured.fixtures) {
      expect(fixture.modelCallTotals.callCount).toBeGreaterThanOrEqual(fixture.modelStages.length);
      expect(fixture.modelCallTotals.promptTokenEstimate).toBeGreaterThanOrEqual(
        fixture.modelStages.reduce((total, call) => total + call.promptTokenEstimate, 0),
      );
      expect(fixture.modelCallTotals.providerTokenEstimate).toBeGreaterThanOrEqual(
        fixture.modelStages.reduce((total, call) => total + call.providerTokenEstimate, 0),
      );
    }
  }, 30_000);

  test("collects once and runs both pipeline variants in paired replay mode", async () => {
    const requests: string[] = [];
    let variantOrderDraws = 0;
    let blindLabelDraws = 0;
    const result = await runFixturePair("equity-aapl-deep", {
      llm: "replay",
      onDataRequest: (request) => requests.push(request.url),
      variantOrderRandom: () => {
        variantOrderDraws += 1;
        return 0.75;
      },
      blindLabelRandom: () => {
        blindLabelDraws += 1;
        return 0.25;
      },
    });
    pairResults.push(result);

    expect(result.variants.legacy.status).toBe("success");
    expect(result.variants.simplified.status).toBe("success");
    if (result.variants.simplified.status !== "success") {
      throw new Error("simplified replay must succeed");
    }
    expect(deepEquityVariantEvaluationMetrics(result.variants.simplified.result)).toMatchObject({
      researchOnlyBoundaryPassed: true,
      persistedPredictionsValidate: true,
      validPredictionCount: 0,
      citedSourceUtilization: 1,
      allCitedSourceIdsResolve: true,
      coreReasoningCallCount: 3,
      totalReasoningCallCount: 4,
      reportIntegrity: "high",
    });
    expect(
      requests.filter((url) => new URL(url).searchParams.get("symbols") === "AAPL"),
    ).toHaveLength(1);
    expect(result.judge).toBeUndefined();
    expect(variantOrderDraws).toBe(1);
    expect(blindLabelDraws).toBe(0);
  });

  test("measures the simplified deep-equity call and prompt-token budgets", async () => {
    const budgets = await measureDeepEquitySimplifiedCallBudgets();

    for (const budget of budgets) {
      expect(budget.coreStages).toEqual(["equity-analysis", "critique", "final-synthesis"]);
      expect(budget.totalCallCount).toBeLessThanOrEqual(5);
    }
    const reductions = budgets
      .map((budget) => budget.promptTokenReductionPercent)
      .toSorted((left, right) => left - right);
    const midpoint = Math.floor(reductions.length / 2);
    const medianReduction =
      reductions.length % 2 === 0
        ? ((reductions[midpoint - 1] ?? 0) + (reductions[midpoint] ?? 0)) / 2
        : (reductions[midpoint] ?? 0);
    // This is a hygiene tripwire, not the Phase 5 cutover gate.
    // The tripwire measures promptTokenReductionPercent from cassette replay.
    // The cutover gate measures the whole-run trace.tokenEstimate median on paid runs, at 0.30.
    // Enforcing 30 here proxied that gate with the wrong metric.
    // Every deliberate payload change then tripped a constant, training edits to the constant.
    //
    // Relaxed 2026-07-28 by explicit user decision: token growth is acceptable.
    // These bounds now catch only unintended bloat.
    // Shipping the full evidence packet to final synthesis would put NBIS near 13%, firing this.
    // Deliberate growth should change the design, not this number.
    expect(medianReduction).toBeGreaterThanOrEqual(25);
    for (const budget of budgets) {
      expect(budget.promptTokenReductionPercent).toBeGreaterThanOrEqual(15);
    }

    // NBIS carries a financial-table-mapping stage the other fixtures lack.
    // That stage sits in both variants, so its achievable percentage is structurally compressed.
    // Assert it stays the outlier rather than pinning a numeric band.
    // If this stops holding, the pipeline shape changed and someone should look.
    const lowestReduction = budgets.toSorted(
      (left, right) => left.promptTokenReductionPercent - right.promptTokenReductionPercent,
    )[0];
    expect(lowestReduction?.fixture).toBe("equity-nbis-deep");
  }, 30_000);

  test("simplified prediction reprompt returns a complete report and recovers", async () => {
    const fixture = await loadFixture("equity-aapl-deep");
    const replay = makeReplayProvider(fixture.llmCassette);
    const finalPrompts: Record<string, unknown>[] = [];
    let validReportContent: string | undefined;
    const invalidPrediction = {
      id: "bad-subject",
      claim: "AAPL closes higher over 5 trading days.",
      kind: "direction",
      subject: "AAPL",
      measurableAs: "close(MSFT, +5) > close(MSFT, 0)",
      horizonTradingDays: 5,
      probability: 0.65,
      sourceIds: ["market-yahoo-equity-aapl"],
    };
    const validPrediction = {
      id: "recovered-aapl",
      claim: "AAPL closes higher over 5 trading days.",
      kind: "direction",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
      horizonTradingDays: 5,
      probability: 0.65,
      sourceIds: ["market-yahoo-equity-aapl"],
    };
    const result = await runFixture("equity-aapl-deep", {
      llm: "replay",
      reasoningVariant: "simplified",
      provider: {
        name: replay.name,
        generate: async (request) => {
          const prompt = JSON.parse(
            request.messages.findLast((message) => message.role === "user")?.content ?? "{}",
          ) as Record<string, unknown>;
          if (prompt.stage !== "final-synthesis") {
            return replay.generate(request);
          }
          finalPrompts.push(prompt);
          if (finalPrompts.length === 1) {
            const response = await replay.generate(request);
            const report = JSON.parse(response.content) as Record<string, unknown>;
            validReportContent = JSON.stringify({ ...report, predictions: [validPrediction] });
            return {
              ...response,
              content: JSON.stringify({ ...report, predictions: [invalidPrediction] }),
            };
          }
          const isRepair =
            Array.isArray(prompt.predictionRepromptErrors) ||
            Array.isArray(prompt.reportValidationErrors);
          if (isRepair) {
            const repairGuidance = JSON.stringify({
              instruction: prompt.instruction,
              predictionRepair: prompt.predictionRepair,
              reportLanguageRepair: prompt.reportLanguageRepair,
            });
            return {
              content: repairGuidance.includes("complete final report")
                ? (validReportContent ?? "{}")
                : JSON.stringify({ predictions: [validPrediction] }),
              tokenEstimate: 50,
              costEstimateUsd: 0,
            };
          }
          return replay.generate(request);
        },
      },
    });
    try {
      expect(result.report.summary).not.toBe("");
      expect(result.report.predictions.map((prediction) => prediction.id)).toContain(
        "recovered-aapl",
      );
      expect(result.trace.predictionRetryErrors).toContain(
        "Prediction bad-subject: subject does not match measurableAs",
      );
      const repairPrompt = finalPrompts.find((prompt) =>
        Array.isArray(prompt.predictionRepromptErrors),
      );
      expect(JSON.stringify(repairPrompt?.predictionRepair)).toContain("complete final report");
      expect(JSON.stringify(repairPrompt?.predictionRepair)).toContain(
        "do not pad with coin-flips",
      );
      expect(JSON.stringify(repairPrompt?.predictionRepair)).toContain("TICKER:BENCHMARK");
    } finally {
      await result.cleanup();
    }
  }, 30_000);

  test("blinds randomized labels and maps judge scores back to variants", async () => {
    const requests: ModelRequest[] = [];
    const result = await judgeDeepEquityPair({
      provider: {
        name: "judge-provider",
        generate: async (request) => {
          requests.push(request);
          return { content: judgeResponse(), tokenEstimate: 123 };
        },
      },
      judgeModel: "independent-judge",
      synthesisModels: ["synthesis-model"],
      reports: {
        legacy: researchReport({ summary: "legacy report" }),
        simplified: researchReport({ summary: "simplified report" }),
      },
      random: () => 0.75,
    });

    expect(result.blindLabels).toEqual({ legacy: "B", simplified: "A" });
    expect(result.decision).toBe("simplified");
    expect(result.dimensions[0]).toEqual({
      dimension: "evidence-grounding-citations",
      legacyScore: 3,
      simplifiedScore: 5,
      rationale: "evidence-grounding-citations comparison",
    });
    expect(result.criticalMaterialEvidenceOmissions).toEqual({
      legacy: ["material event omitted"],
      simplified: [],
    });
    expect(result.tokenEstimate).toBe(123);
    const prompt = JSON.parse(
      requests[0]?.messages.findLast((message) => message.role === "user")?.content ?? "{}",
    ) as {
      readonly reports?: readonly {
        readonly label: string;
        readonly report: { readonly summary?: string };
      }[];
    };
    expect(prompt.reports?.map((entry) => [entry.label, entry.report.summary])).toEqual([
      ["A", "simplified report"],
      ["B", "legacy report"],
    ]);
    expect(JSON.stringify(prompt)).not.toContain("pipelineVariant");
  });

  test("rejects a judge model used for synthesis before calling the provider", async () => {
    let called = false;

    await expect(
      judgeDeepEquityPair({
        provider: {
          name: "judge-provider",
          generate: async () => {
            called = true;
            return { content: judgeResponse(), tokenEstimate: 1 };
          },
        },
        judgeModel: "same-model",
        synthesisModels: ["same-model"],
        reports: {
          legacy: researchReport(),
          simplified: researchReport(),
        },
      }),
    ).rejects.toThrow('judge model "same-model" must differ from synthesis model(s): same-model');
    expect(called).toBe(false);
  });

  test("repairs one malformed judge response and returns the valid retry", async () => {
    const requests: ModelRequest[] = [];
    const responses = [
      JSON.stringify({ winner: "A", rationale: "dimensions omitted" }),
      judgeResponse(),
    ];

    const outcome = await judgeDeepEquityPairSafely({
      provider: {
        name: "repairing-judge-provider",
        generate: async (request) => {
          requests.push(request);
          return { content: responses[requests.length - 1]!, tokenEstimate: 10 };
        },
      },
      judgeModel: "independent-judge",
      synthesisModels: ["synthesis-model"],
      reports: { legacy: researchReport(), simplified: researchReport() },
      random: () => 0.25,
    });

    expect(outcome.status).toBe("judged");
    if (outcome.status !== "judged") {
      throw new Error("judge retry must produce a verdict");
    }
    expect(requests).toHaveLength(2);
    expect(outcome.judge.tokenEstimate).toBe(20);
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      "pairwise judge response must contain a dimensions object",
    );
    expect(requests[1]?.messages.at(-1)?.content).toContain("Return the complete expected object");
  });

  test("records a typed transport failure after exactly one retry", async () => {
    let attempts = 0;

    const outcome = await judgeDeepEquityPairSafely({
      provider: {
        name: "failing-judge-provider",
        generate: async () => {
          attempts += 1;
          throw new Error(`judge transport failure ${String(attempts)}`);
        },
      },
      judgeModel: "independent-judge",
      synthesisModels: ["synthesis-model"],
      reports: { legacy: researchReport(), simplified: researchReport() },
      random: () => 0.25,
    });

    expect(attempts).toBe(2);
    expect(outcome).toEqual({
      status: "unjudged",
      reason: {
        code: "transport-error",
        message: "judge transport failure 2",
        attempts: 2,
        tokenEstimate: null,
      },
    });
  });

  test("retains token usage from two terminal malformed judge responses", async () => {
    const tokenEstimates = [7, 11] as const;
    let attempts = 0;

    const outcome = await judgeDeepEquityPairSafely({
      provider: {
        name: "malformed-judge-provider",
        generate: async () => ({
          content: JSON.stringify({ winner: "A", rationale: "dimensions omitted" }),
          tokenEstimate: tokenEstimates[attempts++]!,
        }),
      },
      judgeModel: "independent-judge",
      synthesisModels: ["synthesis-model"],
      reports: { legacy: researchReport(), simplified: researchReport() },
      random: () => 0.25,
    });

    expect(attempts).toBe(2);
    expect(outcome).toEqual({
      status: "unjudged",
      reason: {
        code: "missing-dimensions",
        message: "pairwise judge response must contain a dimensions object",
        attempts: 2,
        tokenEstimate: 18,
      },
    });
  });
});

const passingHardGates: DeepEquityHardGateInputs = {
  allReportsValidate: true,
  allCitedSourceIdsResolve: true,
  zeroResearchOnlyBoundaryViolations: true,
  zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: true,
  noAdditionalLowIntegrityReports: true,
  noDeterministicEvidenceCoverageRegression: true,
  noInvalidPredictionsPersist: true,
  humanReviewApproved: true,
  liveSmokePassed: true,
};

function evaluationMetrics(
  overrides: Partial<DeepEquityVariantEvaluationMetrics> = {},
): DeepEquityVariantEvaluationMetrics {
  return {
    researchOnlyBoundaryPassed: true,
    persistedPredictionsValidate: true,
    validPredictionCount: 5,
    citedSourceUtilization: 0.5,
    allCitedSourceIdsResolve: true,
    modelTokenEstimate: 100,
    reasoningPromptTokenEstimate: 100,
    coreReasoningCallCount: 3,
    totalReasoningCallCount: 4,
    reportIntegrity: "high",
    deterministicEvidenceCoverageRatio: 1,
    ...overrides,
  };
}

function syntheticJudge(
  decision: PairwiseJudgeResult["decision"] = "simplified",
  rubricDifference = 0,
): PairwiseJudgeResult {
  return {
    version: 1,
    judgeModel: "synthetic-independent-judge",
    blindOrder: ["A", "B"],
    blindLabels: { legacy: "A", simplified: "B" },
    dimensions: PAIRWISE_JUDGE_DIMENSIONS.map((dimension) => ({
      dimension,
      legacyScore: 3,
      simplifiedScore: 3 + rubricDifference,
      rationale: "synthetic rubric fixture",
    })),
    decision,
    rationale: "synthetic pairwise fixture",
    criticalMaterialEvidenceOmissions: { legacy: [], simplified: [] },
    tokenEstimate: 10,
  };
}

function passingEvaluationRecords(
  judge: (scenario: string, repetition: number) => PairwiseJudgeResult = () => syntheticJudge(),
): readonly DeepEquityEvaluationRunRecord[] {
  return ["scenario-a", "scenario-b", "scenario-c", "scenario-d"].flatMap((scenario) =>
    [1, 2, 3].map((repetition) => ({
      scenario,
      repetition,
      variants: {
        legacy: evaluationMetrics(),
        simplified: evaluationMetrics({
          validPredictionCount: 4,
          citedSourceUtilization: 0.46,
          modelTokenEstimate: 70,
        }),
      },
      judge: judge(scenario, repetition),
    })),
  );
}

const passingEvaluationPlan = {
  scenarios: ["scenario-a", "scenario-b", "scenario-c", "scenario-d"],
  repetitions: [1, 2, 3],
} as const;

function failingGateNames(aggregate: DeepEquityEvaluationAggregate): readonly DeepEquityGateName[] {
  return evaluateDeepEquityGates(aggregate, passingHardGates).failingGates;
}

describe("deep-equity evaluation aggregation and gates", () => {
  test("aggregates rubric, pairwise, scenario, prediction, utilization, token, and call metrics", () => {
    const aggregate = aggregateDeepEquityEvaluation(passingEvaluationRecords(), {
      plan: passingEvaluationPlan,
      bootstrapIterations: 200,
      random: createSeededEvaluationRandom(42),
    });

    expect(aggregate.rubric).toEqual({
      evaluatedPairCount: 12,
      meanDifference: 0,
      pairedBootstrap95PercentCi: {
        lowerBound: 0,
        upperBound: 0,
        iterations: 200,
      },
    });
    expect(aggregate.pairwise).toMatchObject({
      evaluatedPairCount: 12,
      unevaluatedPairCount: 0,
      simplifiedWins: 12,
      simplifiedLosses: 0,
      ties: 0,
      simplifiedWinRate: 1,
      simplifiedLossRate: 0,
      tieRate: 0,
    });
    expect(aggregate.scenarios[0]).toMatchObject({
      repetitions: [1, 2, 3],
      simplifiedWins: 3,
      simplifiedLosses: 0,
      ties: 0,
      legacyMedianValidPredictionCount: 5,
      simplifiedMedianValidPredictionCount: 4,
      validPredictionMedianDifference: -1,
    });
    expect(aggregate.citedSourceUtilizationDelta).toBeCloseTo(-0.04);
    expect(aggregate.medianModelTokenImprovement).toBeCloseTo(0.3);
    expect(aggregate.reasoningPromptTokens).toEqual({
      evaluatedPairCount: 12,
      unavailablePairCount: 0,
      medianImprovement: 0,
    });
    expect(aggregate.reasoningCalls).toEqual({
      allRunsUseThreeCoreCalls: true,
      allRunsUseAtMostFiveTotalCalls: true,
      maximumCoreCallCount: 3,
      maximumTotalCallCount: 4,
    });
  });

  test("returns a clean pass when every hard and non-inferiority gate passes", () => {
    const aggregate = aggregateDeepEquityEvaluation(passingEvaluationRecords(), {
      plan: passingEvaluationPlan,
      bootstrapIterations: 100,
      random: createSeededEvaluationRandom(7),
    });

    expect(evaluateDeepEquityGates(aggregate, passingHardGates)).toMatchObject({
      status: "pass",
      passed: true,
      failingGates: [],
    });
  });

  test("fails each non-inferiority gate individually", () => {
    const passing = aggregateDeepEquityEvaluation(passingEvaluationRecords(), {
      plan: passingEvaluationPlan,
      bootstrapIterations: 100,
      random: createSeededEvaluationRandom(9),
    });
    const cases: readonly {
      readonly name: DeepEquityGateName;
      readonly aggregate: DeepEquityEvaluationAggregate;
    }[] = [
      {
        name: "rubric-non-inferiority",
        aggregate: {
          ...passing,
          rubric: {
            ...passing.rubric,
            pairedBootstrap95PercentCi: {
              ...passing.rubric.pairedBootstrap95PercentCi,
              lowerBound: -0.250_001,
            },
          },
        },
      },
      {
        name: "pairwise-loss-rate",
        aggregate: {
          ...passing,
          pairwise: {
            ...passing.pairwise,
            simplifiedWins: 8,
            simplifiedLosses: 4,
            simplifiedWinRate: 8 / 12,
            simplifiedLossRate: 4 / 12,
          },
        },
      },
      {
        name: "scenario-repetition-losses",
        aggregate: {
          ...passing,
          scenarios: passing.scenarios.map((scenario, index) =>
            index === 0 ? { ...scenario, simplifiedWins: 1, simplifiedLosses: 2 } : scenario,
          ),
        },
      },
      {
        name: "valid-prediction-count",
        aggregate: {
          ...passing,
          scenarios: passing.scenarios.map((scenario, index) =>
            index === 0
              ? {
                  ...scenario,
                  simplifiedMedianValidPredictionCount: 3,
                  validPredictionMedianDifference: -2,
                }
              : scenario,
          ),
        },
      },
      {
        name: "cited-source-utilization",
        aggregate: { ...passing, citedSourceUtilizationDelta: -0.050_001 },
      },
      {
        name: "model-token-improvement",
        aggregate: { ...passing, medianModelTokenImprovement: 0.299_999 },
      },
      {
        name: "reasoning-call-budget",
        aggregate: {
          ...passing,
          reasoningCalls: { ...passing.reasoningCalls, allRunsUseThreeCoreCalls: false },
        },
      },
    ];

    for (const fixture of cases) {
      expect(failingGateNames(fixture.aggregate)).toEqual([fixture.name]);
    }
  });

  test("counts ties without treating them as wins or losses", () => {
    const aggregate = aggregateDeepEquityEvaluation(
      passingEvaluationRecords(() => syntheticJudge("tie")),
      {
        plan: passingEvaluationPlan,
        bootstrapIterations: 100,
        random: createSeededEvaluationRandom(11),
      },
    );

    expect(aggregate.pairwise).toMatchObject({
      simplifiedWins: 0,
      simplifiedLosses: 0,
      ties: 12,
      simplifiedWinRate: 0,
      simplifiedLossRate: 0,
      tieRate: 1,
    });
    expect(aggregate.scenarios.every((scenario) => scenario.ties === 3)).toBe(true);
  });

  test("fails every judge-dependent gate when the judged sample is incomplete", () => {
    const records = passingEvaluationRecords().map((record, index) =>
      index === 0
        ? {
            scenario: record.scenario,
            repetition: record.repetition,
            variants: record.variants,
          }
        : record,
    );
    const aggregate = aggregateDeepEquityEvaluation(records, {
      plan: passingEvaluationPlan,
      bootstrapIterations: 100,
      random: createSeededEvaluationRandom(12),
    });
    const verdict = evaluateDeepEquityGates(aggregate, passingHardGates);

    expect(aggregate.rubric.evaluatedPairCount).toBe(11);
    expect(aggregate.runCount).toBe(12);
    expect(verdict.failingGates).toEqual([
      "rubric-non-inferiority",
      "pairwise-loss-rate",
      "scenario-repetition-losses",
    ]);
  });

  test("uses the planned denominator when an entire fixture fails before aggregation", () => {
    const survivingRecords = passingEvaluationRecords().filter(
      (record) => record.scenario !== "scenario-d",
    );
    const aggregate = aggregateDeepEquityEvaluation(survivingRecords, {
      bootstrapIterations: 100,
      random: createSeededEvaluationRandom(14),
      plan: passingEvaluationPlan,
    });
    const verdict = evaluateDeepEquityGates(aggregate, passingHardGates);
    const missingScenario = aggregate.scenarios.find(
      (scenario) => scenario.scenario === "scenario-d",
    );

    expect(aggregate.plannedPairCount).toBe(12);
    expect(aggregate.runCount).toBe(9);
    expect(aggregate.rubric.evaluatedPairCount).toBe(9);
    expect(missingScenario).toMatchObject({
      expectedRepetitions: [1, 2, 3],
      repetitions: [],
      judgedRepetitions: [],
      legacyMedianValidPredictionCount: null,
      simplifiedMedianValidPredictionCount: null,
      validPredictionMedianDifference: null,
    });
    expect(verdict.failingGates).toEqual(
      expect.arrayContaining([
        "rubric-non-inferiority",
        "pairwise-loss-rate",
        "scenario-repetition-losses",
      ]),
    );
  });

  test("rejects plan omission instead of inferring a gate denominator from survivors", () => {
    const survivingRecords = passingEvaluationRecords().filter(
      (record) => record.scenario !== "scenario-d",
    );

    expect(() =>
      // @ts-expect-error The runtime guard protects untyped callers as well as the required type.
      aggregateDeepEquityEvaluation(survivingRecords, {
        bootstrapIterations: 100,
        random: createSeededEvaluationRandom(15),
      }),
    ).toThrow("gate-producing aggregation requires an authoritative evaluation plan");
  });

  test("passes when the paired-bootstrap lower bound is exactly -0.25", () => {
    const aggregate = aggregateDeepEquityEvaluation(
      passingEvaluationRecords(() => syntheticJudge("simplified", -0.25)),
      {
        plan: passingEvaluationPlan,
        bootstrapIterations: 100,
        random: createSeededEvaluationRandom(13),
      },
    );

    expect(aggregate.rubric.pairedBootstrap95PercentCi.lowerBound).toBe(-0.25);
    expect(failingGateNames(aggregate)).toEqual([]);
  });

  test("derives evaluation random streams without adjacent-seed correlation", () => {
    const streamPairs: readonly (readonly [
      EvaluationRandomStreamName,
      EvaluationRandomStreamName,
    ])[] = [
      ["variantOrder", "blindLabels"],
      ["variantOrder", "pairedBootstrap"],
      ["blindLabels", "pairedBootstrap"],
    ];
    const measuredDrawIndices = new Set([1, 2, 4, 8]);
    const seedCount = 20_000;

    for (const [leftStream, rightStream] of streamPairs) {
      const sameSideCounts = new Map<number, number>();
      for (let seed = 1; seed <= seedCount; seed += 1) {
        const leftRandom = createSeededEvaluationRandom(
          deriveEvaluationStreamSeed(seed, leftStream),
        );
        const rightRandom = createSeededEvaluationRandom(
          deriveEvaluationStreamSeed(seed, rightStream),
        );
        for (let drawIndex = 1; drawIndex <= 8; drawIndex += 1) {
          const sameSide = leftRandom() >= 0.5 === rightRandom() >= 0.5;
          if (sameSide && measuredDrawIndices.has(drawIndex)) {
            sameSideCounts.set(drawIndex, (sameSideCounts.get(drawIndex) ?? 0) + 1);
          }
        }
      }

      for (const drawIndex of measuredDrawIndices) {
        const sameSideRate = (sameSideCounts.get(drawIndex) ?? 0) / seedCount;
        expect(sameSideRate).toBeGreaterThan(0.48);
        expect(sameSideRate).toBeLessThan(0.52);
      }
    }
  });

  test("rejects invalid deterministic aggregation inputs", () => {
    const records = passingEvaluationRecords();
    const firstRecord = records[0];
    const judge = firstRecord?.judge;
    if (firstRecord === undefined || judge === undefined) {
      throw new Error("synthetic evaluation record must contain a judge result");
    }

    expect(() => createSeededEvaluationRandom(1.5)).toThrow("evaluation seed must be an integer");
    expect(() =>
      aggregateDeepEquityEvaluation(records, {
        plan: { scenarios: [], repetitions: [1] },
      }),
    ).toThrow("evaluation plan must contain unique, non-empty scenarios");
    expect(() =>
      aggregateDeepEquityEvaluation(records, {
        plan: { scenarios: ["scenario-a"], repetitions: [2] },
      }),
    ).toThrow("evaluation plan repetitions must be contiguous positive integers");
    expect(() =>
      aggregateDeepEquityEvaluation(records, {
        plan: passingEvaluationPlan,
        bootstrapIterations: 0,
      }),
    ).toThrow("bootstrap iterations must be a positive integer");
    expect(() =>
      aggregateDeepEquityEvaluation(records, {
        plan: passingEvaluationPlan,
        bootstrapIterations: 1,
        random: () => 1,
      }),
    ).toThrow("evaluation RNG must return a finite value in [0, 1)");
    expect(() =>
      aggregateDeepEquityEvaluation([{ ...firstRecord, judge: { ...judge, dimensions: [] } }], {
        plan: passingEvaluationPlan,
        bootstrapIterations: 1,
      }),
    ).toThrow("pairwise judge result must contain rubric dimensions");
  });
});
