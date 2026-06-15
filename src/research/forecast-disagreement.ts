import type { Prediction } from "../domain/types";
import type { ModelParams, ModelProvider } from "../model/types";
import { isRecord, readNumber, readString } from "../sources/guards";
import type { LoadedPrompt } from "./prompt-loader";
import type { StageOutput } from "./final-synthesis";

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

export interface ForecastDisagreementResult {
  readonly artifact: ForecastDisagreementArtifact;
  readonly stageOutputs: readonly StageOutput[];
  readonly dataGaps: readonly string[];
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

function buildPrompt(input: {
  readonly loaded: LoadedPrompt;
  readonly report: {
    readonly runId: string;
    readonly generatedAt: string;
    readonly summary: string;
    readonly keyFindings: unknown;
    readonly bullCase: unknown;
    readonly bearCase: unknown;
    readonly risks: unknown;
    readonly catalysts: unknown;
    readonly scenarios: unknown;
    readonly predictions: readonly Prediction[];
  };
}): string {
  return JSON.stringify(
    {
      instruction: input.loaded.instruction,
      stage: "forecast-disagreement",
      stageGoal: input.loaded.goal,
      report: input.report,
      requiredShape: {
        predictions: [{ id: "prediction-id", probability: 0.6 }],
      },
    },
    undefined,
    2,
  );
}

// Partial coverage is accepted to avoid voiding a whole challenger over one bad item.
// Unknown IDs, out-of-range probabilities, duplicates, and malformed entries are skipped.
// Incomplete coverage is already modeled per prediction by missingParticipantCount.
// Structurally invalid responses, or zero usable probabilities, mark it as an error.
function readParticipantPredictions(
  value: unknown,
  knownPredictionIds: ReadonlySet<string>,
): readonly ForecastDisagreementParticipantPrediction[] {
  if (!isRecord(value) || !Array.isArray(value.predictions)) {
    throw new Error("Forecast disagreement response must include a predictions array");
  }

  const seen = new Set<string>();
  const predictions: ForecastDisagreementParticipantPrediction[] = [];
  for (const item of value.predictions) {
    if (!isRecord(item)) {
      continue;
    }
    const predictionId = readString(item, "id") ?? readString(item, "predictionId");
    const probability = readNumber(item, "probability");
    if (
      predictionId === undefined ||
      !knownPredictionIds.has(predictionId) ||
      seen.has(predictionId) ||
      probability === undefined ||
      probability < 0 ||
      probability > 1
    ) {
      continue;
    }
    seen.add(predictionId);
    predictions.push({ predictionId, probability });
  }

  if (predictions.length === 0) {
    throw new Error("Forecast disagreement response included no usable prediction probabilities");
  }

  return predictions;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runForecastDisagreement(input: {
  readonly generatedAt: string;
  readonly provider: ModelProvider;
  readonly providerName: string;
  readonly baselineModel: string;
  readonly challengerModels: readonly string[];
  readonly modelParams?: ModelParams;
  readonly loaded: LoadedPrompt;
  readonly report: {
    readonly runId: string;
    readonly generatedAt: string;
    readonly summary: string;
    readonly keyFindings: unknown;
    readonly bullCase: unknown;
    readonly bearCase: unknown;
    readonly risks: unknown;
    readonly catalysts: unknown;
    readonly scenarios: unknown;
    readonly predictions: readonly Prediction[];
  };
}): Promise<ForecastDisagreementResult> {
  const knownPredictionIds = new Set(input.report.predictions.map((prediction) => prediction.id));
  const prompt = buildPrompt({ loaded: input.loaded, report: input.report });
  const primary: ForecastDisagreementParticipant = {
    role: "primary",
    provider: input.providerName,
    model: input.baselineModel,
    status: "ok",
    predictions: input.report.predictions.map((prediction) => ({
      predictionId: prediction.id,
      probability: prediction.probability,
    })),
  };

  const challengerResults = await Promise.all(
    input.challengerModels.map(async (model) => {
      try {
        const response = await input.provider.generate({
          model,
          ...(input.modelParams !== undefined ? { params: input.modelParams } : {}),
          responseFormat: "json",
          messages: [
            { role: "system", content: input.loaded.system },
            { role: "user", content: prompt },
          ],
        });
        const predictions = readParticipantPredictions(
          JSON.parse(response.content) as unknown,
          knownPredictionIds,
        );
        return {
          participant: {
            role: "challenger",
            provider: input.providerName,
            model,
            status: "ok",
            predictions,
            tokenEstimate: response.tokenEstimate,
            costEstimateUsd: response.costEstimateUsd,
          } satisfies ForecastDisagreementParticipant,
          stageOutput: {
            stage: "forecast-disagreement",
            content: response.content,
            tokenEstimate: response.tokenEstimate,
            costEstimateUsd: response.costEstimateUsd,
          } satisfies StageOutput,
        };
      } catch (error) {
        const message = errorMessage(error);
        return {
          participant: {
            role: "challenger",
            provider: input.providerName,
            model,
            status: "error",
            error: message,
          } satisfies ForecastDisagreementParticipant,
          stageOutput: {
            stage: "forecast-disagreement",
            content: JSON.stringify({ model, error: message }),
            tokenEstimate: 0,
            costEstimateUsd: 0,
          } satisfies StageOutput,
        };
      }
    }),
  );
  const participants = [primary, ...challengerResults.map((result) => result.participant)];
  const artifact = buildForecastDisagreementArtifact({
    generatedAt: input.generatedAt,
    provider: input.providerName,
    baselineModel: input.baselineModel,
    challengerModels: input.challengerModels,
    predictions: input.report.predictions,
    participants,
  });
  const dataGaps =
    artifact.errorCount > 0
      ? [
          `forecastDisagreement: ${String(artifact.errorCount)} configured challenger model(s) failed; partial uncertainty signal only`,
        ]
      : [];

  return {
    artifact,
    stageOutputs: challengerResults.map((result) => result.stageOutput),
    dataGaps,
  };
}
