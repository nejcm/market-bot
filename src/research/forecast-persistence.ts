import type { ResearchReport } from "../domain/types";
import { measurableAsForExpression, parseObservableExpression } from "../forecast/observable";

// Compact prior-run projection the historical-context reader hands to
// BuildForecastPersistence: just enough to compare claim identity and probability.
export interface ForecastPersistenceBaseline {
  readonly runId: string;
  readonly predictions: readonly {
    readonly measurableAs: string;
    readonly probability: number;
  }[];
}

// Deterministic run-over-run forecast repetition telemetry vs the newest comparable
// Prior run. Analytics-only: never a rejection gate, never model-prompt input.
export interface ForecastPersistence {
  readonly baselineRunId: string;
  readonly repeatedClaimCount: number;
  readonly unchangedProbabilityCount: number;
}

// Claim identity is the canonical measurableAs rendered from the parsed observable
// Expression, so formatting drift between runs does not defeat the comparison.
// Pre-DSL artifacts that fail to parse fall back to collapsed lowercase text.
function claimKey(measurableAs: string): string {
  try {
    return measurableAsForExpression(parseObservableExpression(measurableAs));
  } catch {
    return measurableAs.trim().toLowerCase().replaceAll(/\s+/g, " ");
  }
}

export function buildForecastPersistence(input: {
  readonly report: ResearchReport;
  readonly baseline: ForecastPersistenceBaseline | undefined;
}): ForecastPersistence | undefined {
  const { report, baseline } = input;
  if (baseline === undefined) {
    return undefined;
  }
  const baselineProbabilities = new Map<string, Set<number>>();
  for (const prediction of baseline.predictions) {
    const key = claimKey(prediction.measurableAs);
    const probabilities = baselineProbabilities.get(key) ?? new Set<number>();
    probabilities.add(prediction.probability);
    baselineProbabilities.set(key, probabilities);
  }
  let repeatedClaimCount = 0;
  let unchangedProbabilityCount = 0;
  for (const prediction of report.predictions) {
    const probabilities = baselineProbabilities.get(claimKey(prediction.measurableAs));
    if (probabilities === undefined) {
      continue;
    }
    repeatedClaimCount += 1;
    if (probabilities.has(prediction.probability)) {
      unchangedProbabilityCount += 1;
    }
  }
  return { baselineRunId: baseline.runId, repeatedClaimCount, unchangedProbabilityCount };
}
