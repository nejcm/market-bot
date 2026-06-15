import type { Prediction } from "../domain/types";

export type ForecastDisagreementBand = "low" | "medium" | "high";
export type ForecastDisagreementParticipantRole = "primary" | "challenger";
export type ForecastDisagreementParticipantStatus = "ok" | "error";

export interface ForecastDisagreementParticipantPrediction {
  readonly predictionId: string;
  readonly probability: number;
}

export interface ForecastDisagreementParticipant {
  readonly role: ForecastDisagreementParticipantRole;
  readonly provider: string;
  readonly model: string;
  readonly status: ForecastDisagreementParticipantStatus;
  readonly predictions?: readonly ForecastDisagreementParticipantPrediction[];
  readonly error?: string;
  readonly tokenEstimate?: number;
  readonly costEstimateUsd?: number;
}

export interface ForecastDisagreementPredictionSummary {
  readonly predictionId: string;
  readonly meanProbability: number;
  readonly probabilityVariance: number;
  readonly probabilitySpread: number;
  readonly band: ForecastDisagreementBand;
  readonly participantCount: number;
  readonly missingParticipantCount: number;
}

export interface ForecastDisagreementExtra {
  readonly version: 1;
  readonly generatedAt: string;
  readonly participantCount: number;
  readonly successfulParticipantCount: number;
  readonly errorCount: number;
  readonly predictions: readonly ForecastDisagreementPredictionSummary[];
}

export interface ForecastDisagreementArtifact extends ForecastDisagreementExtra {
  readonly provider: string;
  readonly baselineModel: string;
  readonly challengerModels: readonly string[];
  readonly participants: readonly ForecastDisagreementParticipant[];
}

export function disagreementBand(spread: number): ForecastDisagreementBand {
  if (spread < 0.1) {
    return "low";
  }
  return spread < 0.2 ? "medium" : "high";
}

function probabilitiesByPrediction(
  participant: ForecastDisagreementParticipant,
): ReadonlyMap<string, number> {
  return new Map(
    (participant.predictions ?? []).map((prediction) => [
      prediction.predictionId,
      prediction.probability,
    ]),
  );
}

function variance(values: readonly number[], mean: number): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
}

export function buildForecastDisagreementExtra(input: {
  readonly generatedAt: string;
  readonly predictions: readonly Prediction[];
  readonly participants: readonly ForecastDisagreementParticipant[];
}): ForecastDisagreementExtra {
  const participantProbabilities = input.participants.map(probabilitiesByPrediction);
  const summaries = input.predictions.map((prediction): ForecastDisagreementPredictionSummary => {
    const values = participantProbabilities
      .map((probabilities) => probabilities.get(prediction.id))
      .filter((value): value is number => value !== undefined);
    if (values.length === 0) {
      return {
        predictionId: prediction.id,
        meanProbability: prediction.probability,
        probabilityVariance: 0,
        probabilitySpread: 0,
        band: "low",
        participantCount: 0,
        missingParticipantCount: input.participants.length,
      };
    }
    const meanProbability = values.reduce((total, value) => total + value, 0) / values.length;
    const probabilitySpread = Math.max(...values) - Math.min(...values);

    return {
      predictionId: prediction.id,
      meanProbability,
      probabilityVariance: variance(values, meanProbability),
      probabilitySpread,
      band: disagreementBand(probabilitySpread),
      participantCount: values.length,
      missingParticipantCount: input.participants.length - values.length,
    };
  });

  return {
    version: 1,
    generatedAt: input.generatedAt,
    participantCount: input.participants.length,
    successfulParticipantCount: input.participants.filter(
      (participant) => participant.status === "ok",
    ).length,
    errorCount: input.participants.filter((participant) => participant.status === "error").length,
    predictions: summaries,
  };
}

export function buildForecastDisagreementArtifact(input: {
  readonly generatedAt: string;
  readonly provider: string;
  readonly baselineModel: string;
  readonly challengerModels: readonly string[];
  readonly predictions: readonly Prediction[];
  readonly participants: readonly ForecastDisagreementParticipant[];
}): ForecastDisagreementArtifact {
  return {
    ...buildForecastDisagreementExtra(input),
    provider: input.provider,
    baselineModel: input.baselineModel,
    challengerModels: input.challengerModels,
    participants: input.participants,
  };
}
