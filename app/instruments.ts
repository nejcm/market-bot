import { join } from "node:path";
import type { AssetClass } from "../src/domain/job-type";
import type { Prediction } from "../src/domain/prediction";
import { instrumentsForExpression, parseObservableExpression } from "../src/forecast/observable";
import type { InstrumentTimelineEntry } from "../src/history/artifacts";
import { readInstrumentTimeline } from "../src/history/timeline-reader";
import type { PredictionScore } from "../src/scoring/types";
import { dataRootFromRunsDir } from "../src/data-paths";
import { findSecTicker } from "../src/sources/extended-evidence/sec-edgar";
import { getProfileRow, putProfileRow, withConsoleDb, type ProfileRow } from "./console-db";
import { fetchFinnhubProfile, normalizeFinnhubProfile, profileIsFresh } from "./finnhub-profile";
import { loadSecTickers } from "./sec-tickers";
import type {
  InstrumentForecastOutcome,
  InstrumentProfileState,
  InstrumentTimelineDetail,
  InstrumentTimelineForecast,
  InstrumentTimelinePricePoint,
} from "./types";

export interface InstrumentConsoleOptions {
  readonly consoleDbPath: string;
  readonly secTickersCacheDir?: string;
  readonly finnhubApiToken?: string;
  readonly secUserAgent?: string;
  readonly fetchFn?: typeof fetch;
  readonly now?: Date;
}

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
        ...(prediction.baselineProbability !== undefined
          ? { baselineProbability: prediction.baselineProbability }
          : {}),
        ...(prediction.origin !== undefined ? { origin: prediction.origin } : {}),
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
  console?: InstrumentConsoleOptions,
): Promise<InstrumentTimelineDetail> {
  const normalizedSymbol = symbol.toUpperCase();
  const now = console?.now ?? new Date();
  const result = await readInstrumentTimeline(dataDir, assetClass, normalizedSymbol);
  let malformedPredictionCount = 0;
  const entries = result.timeline.entries.flatMap((entry) => {
    const item = forecastsForEntry(entry, normalizedSymbol);
    malformedPredictionCount += item.malformedPredictionCount;
    return item.forecasts;
  });
  const detail: InstrumentTimelineDetail = {
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
  if (assetClass !== "equity" || console === undefined) {
    return detail;
  }

  const fetchFn = console.fetchFn ?? fetch;
  const sec = await loadSecTickers({
    cacheDir: console.secTickersCacheDir ?? join(dataRootFromRunsDir(dataDir), "cache"),
    fetchFn,
    ...(console.secUserAgent !== undefined ? { secUserAgent: console.secUserAgent } : {}),
    now,
  });
  // A non-SEC symbol is declared not-found only when it has no runs: existing pages stay readable.
  const notFound =
    sec.ok &&
    findSecTicker(sec.payload, normalizedSymbol) === undefined &&
    result.timeline.entries.length === 0;
  if (notFound) {
    return { ...detail, notFound: true };
  }
  const profile = await readInstrumentProfile(console, normalizedSymbol, fetchFn, now);
  return { ...detail, profile };
}

async function readInstrumentProfile(
  console: InstrumentConsoleOptions,
  symbol: string,
  fetchFn: typeof fetch,
  now: Date,
): Promise<InstrumentProfileState> {
  const cached = readCachedProfile(console.consoleDbPath, symbol);
  if (cached !== undefined && profileIsFresh(cached.fetchedAt, now)) {
    const profile = normalizeFinnhubProfile(cached.payload);
    if (profile !== undefined) {
      return { status: "available", profile: { ...profile, fetchedAt: cached.fetchedAt } };
    }
  }

  const fetched = await fetchFinnhubProfile(symbol, console.finnhubApiToken, fetchFn, now);
  if (!fetched.ok) {
    return { status: "gap", message: fetched.message };
  }
  storeProfileRow(console.consoleDbPath, symbol, fetched.payload, fetched.fetchedAt);
  return { status: "available", profile: { ...fetched.profile, fetchedAt: fetched.fetchedAt } };
}

function readCachedProfile(dbPath: string, symbol: string): ProfileRow | undefined {
  try {
    return withConsoleDb(dbPath, (db) => getProfileRow(db, symbol));
  } catch {
    // Unopenable console DB: fall back to a live fetch; the page still renders.
    return undefined;
  }
}

function storeProfileRow(
  dbPath: string,
  symbol: string,
  payload: unknown,
  fetchedAt: string,
): void {
  try {
    withConsoleDb(dbPath, (db) => putProfileRow(db, symbol, payload, fetchedAt));
  } catch {
    // Storage failure never blocks serving the fetched profile.
  }
}
