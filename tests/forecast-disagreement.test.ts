import { describe, expect, test } from "bun:test";
import type { Prediction } from "../src/domain/types";
import {
  buildForecastDisagreementArtifact,
  disagreementBand,
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

describe("forecast disagreement", () => {
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
});
