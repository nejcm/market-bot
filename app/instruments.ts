import type { AssetClass, Prediction } from "../src/domain/types";
import { instrumentsForExpression, parseObservableExpression } from "../src/forecast/observable";
import type { InstrumentTimelineEntry } from "../src/history/artifacts";
import { readInstrumentTimeline } from "../src/history/timeline-reader";
import type { PredictionScore } from "../src/scoring/types";
import type {
  InstrumentForecastOutcome,
  InstrumentTimelineDetail,
  InstrumentTimelineForecast,
  InstrumentTimelinePricePoint,
} from "./types";

function scoreOutcome(score: PredictionScore | undefined): InstrumentForecastOutcome {
  if (score === undefined) {
    return "unscored";
  }
  if (!score.resolved) {
    return "pending";
  }
  if (score.status === "voided") {
    return "voided";
  }
  if (score.outcome === "hit") {
    return "event-true";
  }
  return score.outcome === "miss" ? "event-false" : "unscored";
}

function predictionSymbols(prediction: Prediction): readonly string[] | undefined {
  try {
    return instrumentsForExpression(parseObservableExpression(prediction.measurableAs)).map(
      (symbol) => symbol.toUpperCase(),
    );
  } catch {
    return undefined;
  }
}

function predictionMatchesSymbol(
  prediction: Prediction,
  symbol: string,
): {
  readonly matches: boolean;
  readonly malformed: boolean;
} {
  const parsedSymbols = predictionSymbols(prediction);
  if (parsedSymbols !== undefined) {
    return { matches: parsedSymbols.includes(symbol), malformed: false };
  }
  return { matches: prediction.subject.toUpperCase() === symbol, malformed: true };
}

function forecastsForEntry(
  entry: InstrumentTimelineEntry,
  symbol: string,
): {
  readonly forecasts: readonly InstrumentTimelineForecast[];
  readonly malformedPredictionCount: number;
} {
  const scoresById = new Map(entry.scores.map((score) => [score.predictionId, score] as const));
  const autopsiesById = new Map(
    entry.missAutopsies.map((autopsy) => [autopsy.predictionId, autopsy] as const),
  );
  let malformedPredictionCount = 0;
  const forecasts = entry.thesis.predictions.flatMap((prediction) => {
    const match = predictionMatchesSymbol(prediction, symbol);
    if (match.malformed && match.matches) {
      malformedPredictionCount += 1;
    }
    if (!match.matches) {
      return [];
    }
    const score = scoresById.get(prediction.id);
    const autopsy = autopsiesById.get(prediction.id);
    return [
      {
        id: prediction.id,
        runId: entry.runId,
        generatedAt: entry.generatedAt,
        jobType: entry.jobType,
        scope: entry.scope,
        claim: prediction.claim,
        subject: prediction.subject,
        probability: prediction.probability,
        horizonTradingDays: prediction.horizonTradingDays,
        outcome: scoreOutcome(score),
        ...(score?.observedAt !== undefined ? { observedAt: score.observedAt } : {}),
        ...(autopsy !== undefined ? { missAutopsyCause: autopsy.cause } : {}),
      },
    ];
  });
  return { forecasts, malformedPredictionCount };
}

function pricePointsForEntries(
  entries: readonly InstrumentTimelineEntry[],
): readonly InstrumentTimelinePricePoint[] {
  const byDate = new Map<string, InstrumentTimelinePricePoint>();
  for (const entry of entries) {
    for (const close of entry.verifiedMarketSnapshot?.recentCloses ?? []) {
      byDate.set(close.date, { date: close.date, close: close.close });
    }
  }
  return [...byDate.values()].toSorted((left, right) => left.date.localeCompare(right.date));
}

function countsFor(
  forecasts: readonly InstrumentTimelineForecast[],
): InstrumentTimelineDetail["counts"] {
  return {
    total: forecasts.length,
    eventTrue: forecasts.filter((forecast) => forecast.outcome === "event-true").length,
    eventFalse: forecasts.filter((forecast) => forecast.outcome === "event-false").length,
    pending: forecasts.filter((forecast) => forecast.outcome === "pending").length,
    voided: forecasts.filter((forecast) => forecast.outcome === "voided").length,
    unscored: forecasts.filter((forecast) => forecast.outcome === "unscored").length,
  };
}

export async function readInstrumentTimelineDetail(
  dataDir: string,
  assetClass: AssetClass,
  symbol: string,
): Promise<InstrumentTimelineDetail> {
  const normalizedSymbol = symbol.toUpperCase();
  const result = await readInstrumentTimeline(dataDir, assetClass, normalizedSymbol);
  let malformedPredictionCount = 0;
  const entries = result.timeline.entries.flatMap((entry) => {
    const item = forecastsForEntry(entry, normalizedSymbol);
    malformedPredictionCount += item.malformedPredictionCount;
    return item.forecasts;
  });
  return {
    assetClass: result.timeline.assetClass,
    symbol: result.timeline.symbol,
    instrumentKey: result.timeline.instrumentKey,
    generatedAt: result.timeline.generatedAt,
    source: result.source,
    entries: entries.toSorted((left, right) => right.generatedAt.localeCompare(left.generatedAt)),
    pricePoints: pricePointsForEntries(result.timeline.entries),
    counts: countsFor(entries),
    warnings: {
      malformedRunCount: result.malformedRunCount,
      malformedPredictionCount,
    },
  };
}
