import type {
  MissAutopsyCause,
  MissAutopsyEntry,
  PredictionScore,
  PredictionScoreStatus,
} from "./scoring/types";
import { readPrimitiveEvidence } from "./run-artifact-value-guards";
import { isRecord, stringArrayValue } from "./guards";

const MISS_AUTOPSY_CAUSES: ReadonlySet<string> = new Set<MissAutopsyCause>([
  "data_gap",
  "source_gap",
  "model_overconfidence",
  "insufficient_evidence",
]);

export function isMissAutopsyCause(value: unknown): value is MissAutopsyCause {
  return typeof value === "string" && MISS_AUTOPSY_CAUSES.has(value);
}

function readPredictionScoreStatus(value: unknown): PredictionScoreStatus | undefined {
  return value === "pending" ||
    value === "pending-condition" ||
    value === "active-pending" ||
    value === "resolved" ||
    value === "voided" ||
    value === "abandoned"
    ? value
    : undefined;
}

export function readScores(value: unknown): readonly PredictionScore[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.scores)) {
    return;
  }
  return value.scores.flatMap((item): readonly PredictionScore[] => {
    if (
      !isRecord(item) ||
      typeof item.predictionId !== "string" ||
      typeof item.runId !== "string" ||
      typeof item.resolved !== "boolean" ||
      typeof item.attemptCount !== "number" ||
      !isRecord(item.evidence)
    ) {
      return [];
    }
    const status = readPredictionScoreStatus(item.status);
    return [
      {
        predictionId: item.predictionId,
        runId: item.runId,
        ...(status !== undefined ? { status } : {}),
        resolved: item.resolved,
        outcome: item.outcome === "hit" || item.outcome === "miss" ? item.outcome : undefined,
        observedAt: typeof item.observedAt === "string" ? item.observedAt : undefined,
        attemptCount: item.attemptCount,
        ...(typeof item.nextAttemptAt === "string" ? { nextAttemptAt: item.nextAttemptAt } : {}),
        // Carried through at full fidelity so score-writing consumers (scoring/index.ts) can
        // Preserve the version stamped on already-resolved scores. Undefined for legacy files.
        ...(typeof item.scoringVersion === "number" ? { scoringVersion: item.scoringVersion } : {}),
        evidence: item.evidence,
      },
    ];
  });
}

export function readMissAutopsies(value: unknown): readonly MissAutopsyEntry[] {
  if (!isRecord(value) || !Array.isArray(value.autopsies)) {
    return [];
  }
  return value.autopsies.flatMap((item): readonly MissAutopsyEntry[] => {
    if (
      !isRecord(item) ||
      typeof item.predictionId !== "string" ||
      typeof item.runId !== "string" ||
      typeof item.observedAt !== "string" ||
      (item.scoreOutcome !== "hit" && item.scoreOutcome !== "miss") ||
      typeof item.probability !== "number" ||
      (item.forecastError !== "overpredicted" && item.forecastError !== "underpredicted") ||
      !isMissAutopsyCause(item.cause) ||
      typeof item.rationale !== "string"
    ) {
      return [];
    }
    // An otherwise-valid entry with absent or non-object evidence keeps an empty
    // Evidence map rather than being dropped (the field is non-essential context).
    const evidence = readPrimitiveEvidence(item.evidence) ?? {};
    return [
      {
        predictionId: item.predictionId,
        runId: item.runId,
        observedAt: item.observedAt,
        scoreOutcome: item.scoreOutcome,
        probability: item.probability,
        forecastError: item.forecastError,
        cause: item.cause,
        rationale: item.rationale,
        supportingSignals: stringArrayValue(item.supportingSignals),
        evidence,
      },
    ];
  });
}
