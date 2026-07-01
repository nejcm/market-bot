import { predictions, type PredictionView } from "../src/run-artifact-projection";

export {
  extendedEvidenceItems,
  reportSearchCandidates,
  stringArray,
  textItems,
  type ExtendedEvidenceItemView,
} from "../src/report-search-entries";

// Report-derived view projections (scenarios, predictions, sources, data gap helpers)
// Live in src/run-artifact-projection.ts per ADR 0016; this module re-exports them so
// Existing app/API callers keep their import paths. Score/analytics-derived views below
// (forecast disagreement, miss autopsies, prediction scores, target health) stay local.
export {
  formatShortfallGap,
  predictions,
  scenarios,
  sources,
  splitDataGaps,
  type PredictionView,
  type ScenarioView,
  type SourceView,
  type SplitDataGaps,
} from "../src/run-artifact-projection";

export type PredictionScoreStatus =
  | "pending"
  | "pending-condition"
  | "active-pending"
  | "resolved"
  | "voided"
  | "abandoned";

export interface PredictionScoreView {
  readonly predictionId: string;
  readonly status: PredictionScoreStatus;
  readonly resolved: boolean;
  readonly outcome?: "hit" | "miss";
  readonly observedAt?: string;
  readonly close0?: number;
  readonly closeN?: number;
  readonly changePct?: number;
  readonly pendingReason?: string;
}

export type ForecastDisagreementBand = "low" | "medium" | "high";

export interface ForecastDisagreementView {
  readonly predictionId: string;
  readonly meanProbability: number;
  readonly probabilityVariance: number;
  readonly probabilitySpread: number;
  readonly band: ForecastDisagreementBand;
  readonly participantCount: number;
  readonly missingParticipantCount: number;
}

export interface MissAutopsyView {
  readonly predictionId: string;
  readonly cause: string;
  readonly forecastError: string;
  readonly rationale: string;
  readonly supportingSignals: readonly string[];
}

export interface ScoredForecast extends PredictionView {
  readonly score?: PredictionScoreView;
  readonly forecastDisagreement?: ForecastDisagreementView;
  readonly missAutopsy?: MissAutopsyView;
}

export interface ForecastRollup {
  readonly total: number;
  readonly resolved: number;
  readonly hits: number;
  readonly misses: number;
  readonly voided: number;
  readonly pending: number;
}

export interface ForecastGroup {
  readonly key: string;
  readonly antecedent?: string;
  readonly forecasts: readonly ScoredForecast[];
}

export interface PredictionTargetHealth {
  readonly count: number;
  readonly target: number;
  readonly targetMet: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPredictionScoreStatus(
  item: Record<string, unknown>,
  resolved: boolean,
  outcome: "hit" | "miss" | undefined,
): PredictionScoreStatus {
  const status = readString(item, "status");
  if (
    status === "pending" ||
    status === "pending-condition" ||
    status === "active-pending" ||
    status === "resolved" ||
    status === "voided" ||
    status === "abandoned"
  ) {
    return status;
  }
  if (outcome !== undefined) {
    return "resolved";
  }
  return resolved ? "abandoned" : "pending";
}

export function predictionScores(
  score: Record<string, unknown> | undefined,
): readonly PredictionScoreView[] {
  const value = score?.scores;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const predictionId = readString(item, "predictionId");
      if (predictionId === undefined) {
        return [];
      }

      const resolved = item.resolved === true;
      const rawOutcome = readString(item, "outcome");
      const outcome = rawOutcome === "hit" || rawOutcome === "miss" ? rawOutcome : undefined;
      const status = readPredictionScoreStatus(item, resolved, outcome);
      const observedAt = readString(item, "observedAt");
      const evidence = isRecord(item.evidence) ? item.evidence : {};
      const close0 = readNumber(evidence, "close0");
      const closeN = readNumber(evidence, "closeN");
      const hasCloses = close0 !== undefined && closeN !== undefined;
      const changePct = hasCloses && close0 !== 0 ? ((closeN - close0) / close0) * 100 : undefined;
      const pendingReason = readString(evidence, "reason");
      return [
        {
          predictionId,
          status,
          resolved,
          ...(outcome !== undefined ? { outcome } : {}),
          ...(observedAt !== undefined ? { observedAt } : {}),
          ...(hasCloses ? { close0, closeN } : {}),
          ...(changePct !== undefined ? { changePct } : {}),
          ...(pendingReason !== undefined ? { pendingReason } : {}),
        },
      ];
    });
}

function conditionalAntecedent(measurableAs: string | undefined): string | undefined {
  if (measurableAs === undefined || !measurableAs.startsWith("if (")) {
    return undefined;
  }
  // Keep this parser local to the client view model so the UI bundle does not
  // Pull in the full observable resolver stack.
  let depth = 0;
  for (let idx = "if ".length; idx < measurableAs.length; idx += 1) {
    const char = measurableAs[idx];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return measurableAs.slice("if (".length, idx);
      }
    }
  }
  return undefined;
}

export function forecastGroups(items: readonly ScoredForecast[]): readonly ForecastGroup[] {
  const groups = new Map<string, ScoredForecast[]>();
  const antecedents = new Map<string, string>();
  for (const item of items) {
    const antecedent =
      item.kind === "conditional" ? conditionalAntecedent(item.measurableAs) : undefined;
    const key = antecedent === undefined ? `forecast:${item.id}` : `conditional:${antecedent}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
    if (antecedent !== undefined) {
      antecedents.set(key, antecedent);
    }
  }
  return [...groups.entries()].map(([key, forecasts]) => {
    const antecedent = antecedents.get(key);
    return antecedent === undefined ? { key, forecasts } : { key, antecedent, forecasts };
  });
}

function isForecastDisagreementBand(value: unknown): value is ForecastDisagreementBand {
  return value === "low" || value === "medium" || value === "high";
}

export function forecastDisagreements(
  report: Record<string, unknown> | undefined,
): readonly ForecastDisagreementView[] {
  const extras = report?.extras;
  if (!isRecord(extras) || !isRecord(extras.forecastDisagreement)) {
    return [];
  }
  const disagreementPredictions = extras.forecastDisagreement.predictions;
  if (!Array.isArray(disagreementPredictions)) {
    return [];
  }

  return disagreementPredictions.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const predictionId = readString(item, "predictionId");
    const meanProbability = readNumber(item, "meanProbability");
    const probabilityVariance = readNumber(item, "probabilityVariance");
    const probabilitySpread = readNumber(item, "probabilitySpread");
    const participantCount = readNumber(item, "participantCount");
    const missingParticipantCount = readNumber(item, "missingParticipantCount");
    if (
      predictionId === undefined ||
      meanProbability === undefined ||
      probabilityVariance === undefined ||
      probabilitySpread === undefined ||
      participantCount === undefined ||
      missingParticipantCount === undefined ||
      !isForecastDisagreementBand(item.band)
    ) {
      return [];
    }
    return [
      {
        predictionId,
        meanProbability,
        probabilityVariance,
        probabilitySpread,
        band: item.band,
        participantCount,
        missingParticipantCount,
      },
    ];
  });
}

export function missAutopsies(
  missAutopsy: Record<string, unknown> | undefined,
): readonly MissAutopsyView[] {
  const value = missAutopsy?.autopsies;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly MissAutopsyView[] => {
    if (!isRecord(item)) {
      return [];
    }
    const predictionId = readString(item, "predictionId");
    const cause = readString(item, "cause");
    const forecastError = readString(item, "forecastError");
    const rationale = readString(item, "rationale");
    if (
      predictionId === undefined ||
      cause === undefined ||
      forecastError === undefined ||
      rationale === undefined
    ) {
      return [];
    }
    const signals = item.supportingSignals;
    return [
      {
        predictionId,
        cause,
        forecastError,
        rationale,
        supportingSignals: Array.isArray(signals)
          ? signals.filter((signal): signal is string => typeof signal === "string")
          : [],
      },
    ];
  });
}

export function scoredForecasts(
  report: Record<string, unknown> | undefined,
  score: Record<string, unknown> | undefined,
  missAutopsy: Record<string, unknown> | undefined = undefined,
): readonly ScoredForecast[] {
  const scoresById = new Map(
    predictionScores(score).map((item) => [item.predictionId, item] as const),
  );
  const disagreementById = new Map(
    forecastDisagreements(report).map((item) => [item.predictionId, item] as const),
  );
  const autopsyById = new Map(
    missAutopsies(missAutopsy).map((item) => [item.predictionId, item] as const),
  );
  return predictions(report).map((prediction) => {
    const predictionScore = scoresById.get(prediction.id);
    const forecastDisagreement = disagreementById.get(prediction.id);
    const predictionAutopsy = autopsyById.get(prediction.id);
    return {
      ...prediction,
      ...(predictionScore !== undefined ? { score: predictionScore } : {}),
      ...(forecastDisagreement !== undefined ? { forecastDisagreement } : {}),
      ...(predictionAutopsy !== undefined ? { missAutopsy: predictionAutopsy } : {}),
    };
  });
}

export function forecastRollup(items: readonly ScoredForecast[]): ForecastRollup {
  const resolvedItems = items.filter((item) => item.score?.resolved === true);
  const hits = resolvedItems.filter((item) => item.score?.outcome === "hit").length;
  const misses = resolvedItems.filter((item) => item.score?.outcome === "miss").length;
  const voided = resolvedItems.filter((item) => item.score?.status === "voided").length;
  return {
    total: items.length,
    resolved: resolvedItems.length,
    hits,
    misses,
    voided,
    pending: items.length - resolvedItems.length,
  };
}

function readDepthProfileTarget(report?: Record<string, unknown>): number | undefined {
  const extras = report?.extras;
  if (!isRecord(extras)) {
    return undefined;
  }

  const { depthProfile } = extras;
  if (!isRecord(depthProfile)) {
    return undefined;
  }

  const target = depthProfile.targetPredictions;
  return typeof target === "number" && Number.isFinite(target) ? target : undefined;
}

export function predictionTargetHealth(
  analytics?: Record<string, unknown>,
  report?: Record<string, unknown>,
): PredictionTargetHealth | undefined {
  const predictionsBlock = analytics?.predictions;
  if (isRecord(predictionsBlock)) {
    const count = readNumber(predictionsBlock, "count");
    const target = readNumber(predictionsBlock, "targetCount");
    if (count !== undefined && target !== undefined) {
      const targetMet =
        typeof predictionsBlock.targetMet === "boolean"
          ? predictionsBlock.targetMet
          : count >= target;
      return { count, target, targetMet };
    }
  }

  const fallbackTarget = readDepthProfileTarget(report);
  if (fallbackTarget === undefined || report === undefined) {
    return undefined;
  }

  const count = arrayCount(report, "predictions");
  return {
    count,
    target: fallbackTarget,
    targetMet: count >= fallbackTarget,
  };
}

function arrayCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return Array.isArray(value) ? value.length : 0;
}
