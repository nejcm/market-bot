import type {
  MissAutopsyCause,
  MissAutopsyEntry,
  PredictionScore,
  PredictionScoreStatus,
  ScoreRepair,
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

export function readPredictionScoreStatus(value: unknown): PredictionScoreStatus | undefined {
  return value === "pending" ||
    value === "pending-condition" ||
    value === "active-pending" ||
    value === "resolved" ||
    value === "voided" ||
    value === "abandoned"
    ? value
    : undefined;
}

export interface MalformedScoreRow {
  readonly predictionId: string;
  readonly reason: string;
  readonly raw: Record<string, unknown>;
}

export interface ScoreRows {
  readonly scores: readonly PredictionScore[];
  /** Rows with a prediction id that fail the row contract; kept so writers preserve them verbatim. */
  readonly malformed: readonly MalformedScoreRow[];
}

// A persisted `resolved` key is ignored: status alone carries the lifecycle (ADR 0003).
function readScoreRow(
  item: Record<string, unknown>,
): PredictionScore | MalformedScoreRow | undefined {
  if (typeof item.predictionId !== "string") {
    return;
  }
  const { predictionId } = item;
  const malformed = (reason: string): MalformedScoreRow => ({ predictionId, reason, raw: item });
  if (
    typeof item.runId !== "string" ||
    typeof item.attemptCount !== "number" ||
    !isRecord(item.evidence)
  ) {
    return malformed("missing runId, attemptCount, or evidence");
  }
  const status = readPredictionScoreStatus(item.status);
  if (status === undefined) {
    return malformed(item.status === undefined ? "missing status" : "unknown status");
  }
  const base = {
    predictionId,
    runId: item.runId,
    attemptCount: item.attemptCount,
    // Carried through so score-writing consumers preserve the version stamped on terminal scores.
    ...(typeof item.scoringVersion === "number" ? { scoringVersion: item.scoringVersion } : {}),
    evidence: item.evidence,
  };
  const observedAt = typeof item.observedAt === "string" ? item.observedAt : undefined;
  const terminalExtras = {
    ...(typeof item.forecastOrigin === "string" ? { forecastOrigin: item.forecastOrigin } : {}),
    ...(isRecord(item.repair) ? { repair: item.repair as unknown as ScoreRepair } : {}),
  };
  switch (status) {
    case "resolved": {
      if ((item.outcome !== "hit" && item.outcome !== "miss") || observedAt === undefined) {
        return malformed("resolved without outcome and observedAt");
      }
      return { ...base, status, outcome: item.outcome, observedAt, ...terminalExtras };
    }
    case "voided": {
      if (observedAt === undefined) {
        return malformed("voided without observedAt");
      }
      return { ...base, status, observedAt, ...terminalExtras };
    }
    case "abandoned": {
      const abandonedAt = typeof item.abandonedAt === "string" ? item.abandonedAt : observedAt;
      if (abandonedAt === undefined) {
        return malformed("abandoned without abandonedAt");
      }
      return { ...base, status, abandonedAt };
    }
    default: {
      return {
        ...base,
        status,
        ...(typeof item.nextAttemptAt === "string" ? { nextAttemptAt: item.nextAttemptAt } : {}),
      };
    }
  }
}

export function readScoreRows(value: unknown): ScoreRows | undefined {
  if (!isRecord(value) || !Array.isArray(value.scores)) {
    return;
  }
  const scores: PredictionScore[] = [];
  const malformed: MalformedScoreRow[] = [];
  for (const item of value.scores) {
    const row = isRecord(item) ? readScoreRow(item) : undefined;
    if (row === undefined) {
      continue;
    }
    if ("reason" in row) {
      malformed.push(row);
    } else {
      scores.push(row);
    }
  }
  return { scores, malformed };
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
