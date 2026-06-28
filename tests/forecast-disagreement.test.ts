import { describe, expect, test } from "bun:test";
import type { Prediction } from "../src/domain/types";
import type { ModelProvider } from "../src/model/types";
import type { LoadedPrompt } from "../src/research/prompt-loader";
import {
  buildForecastDisagreementArtifact,
  disagreementBand,
  runForecastDisagreement,
} from "../src/research/forecast-disagreement";

const predictions: readonly Prediction[] = [
  {
    id: "pred-1",
    claim: "SPY closes higher over five trading days.",
    kind: "direction",
    subject: "SPY",
    measurableAs: "close(SPY, +5) > close(SPY, 0)",
    horizonTradingDays: 5,
    probability: 0.6,
    sourceIds: ["market-spy"],
  },
  {
    id: "pred-2",
    claim: "QQQ closes higher over five trading days.",
    kind: "direction",
    subject: "QQQ",
    measurableAs: "close(QQQ, +5) > close(QQQ, 0)",
    horizonTradingDays: 5,
    probability: 0.55,
    sourceIds: ["market-qqq"],
  },
];

const loadedPrompt: LoadedPrompt = {
  system: "system",
  instruction: "instruction",
  goal: "goal",
};

const challengerReport = {
  runId: "run-1",
  generatedAt: "2026-06-15T00:00:00.000Z",
  summary: "summary",
  keyFindings: [],
  bullCase: [],
  bearCase: [],
  risks: [],
  catalysts: [],
  scenarios: [],
  predictions,
};

function jsonProvider(content: string): ModelProvider {
  return {
    name: "openai",
    generate: async () => ({ content, tokenEstimate: 10, costEstimateUsd: 0.001 }),
  };
}

async function runWithChallenger(content: string): Promise<{
  readonly status: "ok" | "error";
  readonly predictions:
    | readonly { readonly predictionId: string; readonly probability: number }[]
    | undefined;
}> {
  const result = await runForecastDisagreement({
    generatedAt: "2026-06-15T00:00:00.000Z",
    provider: jsonProvider(content),
    providerName: "openai",
    baselineModel: "gpt-5.5",
    challengerModels: ["gpt-5.4"],
    loaded: loadedPrompt,
    report: challengerReport,
  });
  const challenger = result.artifact.participants.find(
    (participant) => participant.role === "challenger",
  );
  if (challenger === undefined) {
    throw new Error("expected a challenger participant");
  }
  return { status: challenger.status, predictions: challenger.predictions };
}

describe("forecast disagreement", () => {
  test("includes the analysis cutoff in challenger prompts", async () => {
    let analysisAsOf = "";
    const provider: ModelProvider = {
      name: "openai",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        analysisAsOf = typeof prompt.analysisAsOf === "string" ? prompt.analysisAsOf : "";
        return {
          content: JSON.stringify({ predictions: [{ id: "pred-1", probability: 0.7 }] }),
          tokenEstimate: 10,
          costEstimateUsd: 0.001,
        };
      },
    };

    await runForecastDisagreement({
      generatedAt: challengerReport.generatedAt,
      provider,
      providerName: "openai",
      baselineModel: "gpt-5.5",
      challengerModels: ["gpt-5.4"],
      loaded: loadedPrompt,
      report: challengerReport,
    });

    expect(analysisAsOf).toBe(challengerReport.generatedAt);
  });

  test("maps spread to neutral bands", () => {
    expect(disagreementBand(0.09)).toBe("low");
    expect(disagreementBand(0.1)).toBe("medium");
    expect(disagreementBand(0.19)).toBe("medium");
    expect(disagreementBand(0.2)).toBe("high");
  });

  test("builds unweighted summaries from participant probabilities", () => {
    const artifact = buildForecastDisagreementArtifact({
      generatedAt: "2026-06-15T00:00:00.000Z",
      provider: "openai",
      baselineModel: "gpt-5.5",
      challengerModels: ["gpt-5.4"],
      predictions,
      participants: [
        {
          role: "primary",
          provider: "openai",
          model: "gpt-5.5",
          status: "ok",
          predictions: [
            { predictionId: "pred-1", probability: 0.6 },
            { predictionId: "pred-2", probability: 0.55 },
          ],
        },
        {
          role: "challenger",
          provider: "openai",
          model: "gpt-5.4",
          status: "ok",
          predictions: [
            { predictionId: "pred-1", probability: 0.8 },
            { predictionId: "pred-2", probability: 0.5 },
          ],
        },
      ],
    });

    expect(artifact).toMatchObject({
      version: 1,
      provider: "openai",
      baselineModel: "gpt-5.5",
      challengerModels: ["gpt-5.4"],
      participantCount: 2,
      successfulParticipantCount: 2,
      errorCount: 0,
    });
    expect(artifact.predictions[0]).toMatchObject({
      predictionId: "pred-1",
      band: "high",
      participantCount: 2,
      missingParticipantCount: 0,
    });
    expect(artifact.predictions[0]?.meanProbability).toBeCloseTo(0.7);
    expect(artifact.predictions[0]?.probabilityVariance).toBeCloseTo(0.01);
    expect(artifact.predictions[0]?.probabilitySpread).toBeCloseTo(0.2);
    expect(artifact.predictions[1]).toMatchObject({
      predictionId: "pred-2",
      band: "low",
      participantCount: 2,
      missingParticipantCount: 0,
    });
    expect(artifact.predictions[1]?.meanProbability).toBeCloseTo(0.525);
    expect(artifact.predictions[1]?.probabilityVariance).toBeCloseTo(0.000_625);
    expect(artifact.predictions[1]?.probabilitySpread).toBeCloseTo(0.05);
  });

  test("keeps partial participant failures auditable", () => {
    const artifact = buildForecastDisagreementArtifact({
      generatedAt: "2026-06-15T00:00:00.000Z",
      provider: "openai",
      baselineModel: "gpt-5.5",
      challengerModels: ["gpt-5.4"],
      predictions,
      participants: [
        {
          role: "primary",
          provider: "openai",
          model: "gpt-5.5",
          status: "ok",
          predictions: [{ predictionId: "pred-1", probability: 0.6 }],
        },
        {
          role: "challenger",
          provider: "openai",
          model: "gpt-5.4",
          status: "error",
          error: "malformed JSON",
        },
      ],
    });

    expect(artifact.successfulParticipantCount).toBe(1);
    expect(artifact.errorCount).toBe(1);
    expect(artifact.predictions[0]).toMatchObject({
      predictionId: "pred-1",
      meanProbability: 0.6,
      probabilityVariance: 0,
      probabilitySpread: 0,
      band: "low",
      participantCount: 1,
      missingParticipantCount: 1,
    });
    expect(artifact.predictions[1]).toMatchObject({
      predictionId: "pred-2",
      meanProbability: 0.55,
      probabilityVariance: 0,
      probabilitySpread: 0,
      band: "low",
      participantCount: 0,
      missingParticipantCount: 2,
    });
  });

  test("keeps valid probabilities when a challenger omits some prediction IDs", async () => {
    const challenger = await runWithChallenger(
      JSON.stringify({ predictions: [{ id: "pred-1", probability: 0.7 }] }),
    );

    expect(challenger.status).toBe("ok");
    expect(challenger.predictions).toEqual([{ predictionId: "pred-1", probability: 0.7 }]);
  });

  test("ignores unknown IDs, out-of-range probabilities, and duplicates", async () => {
    const challenger = await runWithChallenger(
      JSON.stringify({
        predictions: [
          { id: "pred-unknown", probability: 0.9 },
          { id: "pred-1", probability: 1.4 },
          { id: "pred-2", probability: 0.5 },
          { id: "pred-2", probability: 0.6 },
        ],
      }),
    );

    expect(challenger.status).toBe("ok");
    expect(challenger.predictions).toEqual([{ predictionId: "pred-2", probability: 0.5 }]);
  });

  test("marks a challenger as error when no usable probabilities remain", async () => {
    const challenger = await runWithChallenger(
      JSON.stringify({ predictions: [{ id: "pred-unknown", probability: 0.9 }] }),
    );

    expect(challenger.status).toBe("error");
    expect(challenger.predictions).toBeUndefined();
  });

  test("marks a challenger as error when the response is structurally invalid", async () => {
    const challenger = await runWithChallenger(JSON.stringify({ notPredictions: true }));

    expect(challenger.status).toBe("error");
    expect(challenger.predictions).toBeUndefined();
  });
});
