import { afterEach, describe, expect, test } from "bun:test";
import { judgeDeepEquityPair, PAIRWISE_JUDGE_DIMENSIONS } from "./support/deep-equity-evaluation";
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
    const result = await runFixturePair("equity-aapl-deep", {
      llm: "replay",
      onDataRequest: (request) => requests.push(request.url),
    });
    pairResults.push(result);

    expect(result.variants.legacy.status).toBe("success");
    expect(result.variants.simplified.status).toBe("success");
    expect(
      requests.filter((url) => new URL(url).searchParams.get("symbols") === "AAPL"),
    ).toHaveLength(1);
    expect(result.judge).toBeUndefined();
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
    // Plan gate: median model-token estimate must improve by at least 30%.
    expect(medianReduction).toBeGreaterThanOrEqual(30);

    const tokenGateFailures = budgets.filter((budget) => budget.promptTokenReductionPercent < 30);
    expect(tokenGateFailures.map((budget) => budget.fixture)).toEqual(["equity-nbis-deep"]);
    const nbisBudget = tokenGateFailures[0];
    expect(nbisBudget).toBeDefined();
    if (nbisBudget === undefined) {
      throw new Error("Expected equity-nbis-deep to remain the per-fixture token outlier");
    }
    // Phase 5 input: record the outlier without allowing a material regression to pass silently.
    expect(nbisBudget.promptTokenReductionPercent).toBeGreaterThanOrEqual(25);
    expect(nbisBudget.promptTokenReductionPercent).toBeLessThan(30);
    for (const budget of budgets.filter((entry) => entry.fixture !== "equity-nbis-deep")) {
      expect(budget.promptTokenReductionPercent).toBeGreaterThanOrEqual(30);
    }
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
});
