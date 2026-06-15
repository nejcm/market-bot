import type { Prediction, ResearchReport } from "../domain/types";
import type {
  ForecastErrorDirection,
  MissAutopsyCause,
  MissAutopsyEntry,
  MissAutopsyFile,
  PredictionScore,
} from "./types";

const OVERPREDICTED_THRESHOLD = 0.6;
const UNDERPREDICTED_THRESHOLD = 0.4;
const EXTREME_OVERCONFIDENCE_THRESHOLD = 0.75;
const EXTREME_UNDERCONFIDENCE_THRESHOLD = 0.25;
const EVIDENCE_KEY_LIMIT = 8;

const SOURCE_GAP_PATTERN =
  /\b(source|provider|credential|coverage|fetch|stale|fallback|unavailable|missing|unsupported|no-cap|gap)\b/iu;

export function forecastErrorDirection(
  prediction: Prediction,
  score: PredictionScore,
): ForecastErrorDirection | undefined {
  if (!score.resolved || score.outcome === undefined) {
    return;
  }
  if (score.outcome === "miss" && prediction.probability >= OVERPREDICTED_THRESHOLD) {
    return "overpredicted";
  }
  if (score.outcome === "hit" && prediction.probability <= UNDERPREDICTED_THRESHOLD) {
    return "underpredicted";
  }
}

function compactEvidence(evidence: Record<string, unknown>): Record<string, number | string> {
  const result: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (Object.keys(result).length >= EVIDENCE_KEY_LIMIT) {
      break;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    } else if (typeof value === "string" && value.trim() !== "") {
      result[key] = value;
    }
  }
  return result;
}

function hasSourceGap(report: ResearchReport): boolean {
  return report.dataGaps.some((gap) => SOURCE_GAP_PATTERN.test(gap));
}

function classifyCause(input: {
  readonly report: ResearchReport;
  readonly prediction: Prediction;
  readonly direction: ForecastErrorDirection;
}): { readonly cause: MissAutopsyCause; readonly signals: readonly string[] } {
  const signals: string[] = [];
  if (hasSourceGap(input.report)) {
    signals.push("forecast-time report disclosed provider/source evidence gaps");
    return { cause: "source_gap", signals };
  }
  if (input.report.dataGaps.length > 0 || input.prediction.sourceIds.length === 0) {
    signals.push(
      input.report.dataGaps.length > 0
        ? "forecast-time report disclosed data gaps"
        : "prediction carried no direct source citations",
    );
    return { cause: "data_gap", signals };
  }
  if (
    (input.direction === "overpredicted" &&
      input.prediction.probability >= EXTREME_OVERCONFIDENCE_THRESHOLD) ||
    (input.direction === "underpredicted" &&
      input.prediction.probability <= EXTREME_UNDERCONFIDENCE_THRESHOLD)
  ) {
    signals.push("forecast probability was extreme relative to the resolved event");
    return { cause: "model_overconfidence", signals };
  }
  signals.push("persisted artifacts do not identify a deterministic cause");
  return { cause: "insufficient_evidence", signals };
}

function rationaleFor(cause: MissAutopsyCause): string {
  if (cause === "source_gap") {
    return "Material forecast error with disclosed provider or source coverage gaps at forecast time.";
  }
  if (cause === "data_gap") {
    return "Material forecast error with disclosed data gaps or weak direct citation support at forecast time.";
  }
  if (cause === "model_overconfidence") {
    return "Material forecast error where the stated probability was extreme relative to the resolved event.";
  }
  return "Material forecast error, but persisted artifacts do not support a more specific deterministic cause.";
}

function buildEntry(input: {
  readonly report: ResearchReport;
  readonly prediction: Prediction;
  readonly score: PredictionScore;
  readonly direction: ForecastErrorDirection;
}): MissAutopsyEntry | undefined {
  if (input.score.observedAt === undefined || input.score.outcome === undefined) {
    return;
  }
  const classification = classifyCause(input);
  return {
    predictionId: input.prediction.id,
    runId: input.report.runId,
    observedAt: input.score.observedAt,
    scoreOutcome: input.score.outcome,
    probability: input.prediction.probability,
    forecastError: input.direction,
    cause: classification.cause,
    rationale: rationaleFor(classification.cause),
    supportingSignals: classification.signals,
    evidence: compactEvidence(input.score.evidence),
  };
}

export function buildMissAutopsyFile(
  report: ResearchReport,
  scores: readonly PredictionScore[],
  now: Date = new Date(),
): MissAutopsyFile {
  const scoreByPrediction = new Map(scores.map((score) => [score.predictionId, score]));
  const autopsies = report.predictions.flatMap((prediction): readonly MissAutopsyEntry[] => {
    const score = scoreByPrediction.get(prediction.id);
    if (score === undefined) {
      return [];
    }
    const direction = forecastErrorDirection(prediction, score);
    if (direction === undefined) {
      return [];
    }
    const entry = buildEntry({ report, prediction, score, direction });
    return entry === undefined ? [] : [entry];
  });

  return {
    version: 1,
    runId: report.runId,
    generatedAt: now.toISOString(),
    autopsies,
  };
}
