import type { Prediction, ResearchReport } from "../domain/types";
import {
  type ObservableForecast,
  type Observation,
  observableForecastFromPrediction,
  observationStrategyForForecast,
  resolveObservableForecast,
} from "../forecast/observable";
import type { ObservationRepository } from "./observations";
import type { ScoreOutcome } from "./types";

export type { Observation };

export interface ResolveOutcomeResolved {
  readonly status: "resolved";
  readonly outcome: ScoreOutcome;
  readonly evidence: Record<string, unknown>;
}

export interface ResolveOutcomeUnresolved {
  readonly status: "unresolved";
  readonly reason: "horizon-not-elapsed" | "observation-unavailable";
  readonly evidence: Record<string, unknown>;
}

export type ResolveOutcomeResult = ResolveOutcomeResolved | ResolveOutcomeUnresolved;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function isWeekday(date: Date): boolean {
  const dow = date.getDay();
  return dow !== 0 && dow !== 6;
}

function resolutionDate(generatedAt: string, horizonTradingDays: number): Date {
  let count = 0;
  let cursor = new Date(generatedAt);
  while (count < horizonTradingDays) {
    cursor = addDays(cursor, 1);
    if (isWeekday(cursor)) {
      count += 1;
    }
  }
  return cursor;
}

async function closeObservations(
  forecast: ObservableForecast,
  report: ResearchReport,
  now: Date,
  repo: ObservationRepository,
  subjects: readonly string[],
): Promise<readonly Observation[]> {
  const windows = await Promise.all(
    subjects.map((subject) =>
      repo.window(subject, report.assetClass, new Date(report.generatedAt), now),
    ),
  );
  const required = forecast.horizonTradingDays + 1;
  const enough = windows.every((window) => window.length >= required);

  if (!enough) {
    return [];
  }

  return windows.flatMap((window) => window.slice(0, required));
}

async function pointObservations(
  report: ResearchReport,
  resDate: Date,
  repo: ObservationRepository,
  symbols: readonly string[],
  includeOrigin: boolean,
): Promise<readonly Observation[]> {
  const originDate = new Date(report.generatedAt);
  const atOrigin = includeOrigin
    ? await Promise.all(symbols.map((symbol) => repo.point(symbol, report.assetClass, originDate)))
    : [];
  const atHorizon = await Promise.all(
    symbols.map((symbol) => repo.point(symbol, report.assetClass, resDate)),
  );

  return [...atOrigin, ...atHorizon].filter(
    (observation): observation is Observation => observation !== undefined,
  );
}

export async function resolveOutcome(
  prediction: Prediction,
  report: ResearchReport,
  repo: ObservationRepository,
  now: Date,
): Promise<ResolveOutcomeResult> {
  const forecast = observableForecastFromPrediction(prediction);
  if (!("prediction" in forecast)) {
    throw new Error(forecast.message);
  }
  const resDate = resolutionDate(report.generatedAt, prediction.horizonTradingDays);

  if (resDate > now) {
    return {
      status: "unresolved",
      reason: "horizon-not-elapsed",
      evidence: { reason: "horizon not yet elapsed" },
    };
  }

  const strategy = observationStrategyForForecast(forecast);
  const observations =
    strategy.mode === "close-window"
      ? await closeObservations(forecast, report, now, repo, strategy.subjects)
      : await pointObservations(report, resDate, repo, strategy.subjects, strategy.includeOrigin);

  const result = resolveObservableForecast(forecast, observations);
  if (result.status === "unresolved") {
    return {
      status: "unresolved",
      reason: "observation-unavailable",
      evidence: { reason: "observation unavailable" },
    };
  }
  return { status: "resolved", outcome: result.outcome, evidence: result.evidence };
}
