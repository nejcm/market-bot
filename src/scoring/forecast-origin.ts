import { DAY_MS } from "../config/shared";
import type { AssetClass } from "../domain/job-type";
import type { ResearchReport } from "../domain/report";
import {
  observationStrategyForExpression,
  parseObservableExpression,
  type ObservationStrategy,
} from "../forecast/observable";
import { isRecord } from "../guards";
import { firstExchangeSessionOnOrAfter, isExchangeTradingDay } from "./exchange-calendar";

function utcDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

export type EarningsEventTiming = "bmo" | "amc" | "unknown";

export function readEarningsEventTiming(report: ResearchReport): EarningsEventTiming {
  const setup = report.extras?.earningsSetup;
  if (!isRecord(setup)) {
    return "unknown";
  }
  const event = isRecord(setup.event) ? setup.event : undefined;
  const timing = event?.timing;
  if (timing === "bmo" || timing === "amc") {
    return timing;
  }
  return "unknown";
}

export function shiftCalendarDay(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function previousTradingDay(date: Date): Date {
  let cursor = shiftCalendarDay(date, -1);
  while (!isExchangeTradingDay(cursor)) {
    cursor = shiftCalendarDay(cursor, -1);
  }
  return cursor;
}

export function earningsOriginDate(eventDate: Date, timing: EarningsEventTiming): Date {
  if (timing === "amc") {
    // AMC: pre-reaction close is the event-date close.
    // If eventDate is not a trading day, walk backwards to the last trading day.
    let cursor = eventDate;
    while (!isExchangeTradingDay(cursor)) {
      cursor = shiftCalendarDay(cursor, -1);
    }
    return cursor;
  }
  // BMO / unknown: pre-reaction close is the prior session's close.
  return previousTradingDay(eventDate);
}

// Forecast Event origin (ADR 0003) on the report clock, for a window that was never recorded.
// Emits the same strings as the resolver's window origin, so equal origins give equal keys.
export function clockForecastOrigin(
  strategy: ObservationStrategy,
  assetClass: AssetClass,
  issuedAt: Date,
  timing: EarningsEventTiming,
): string {
  switch (strategy.mode) {
    case "close-window": {
      return assetClass === "crypto"
        ? utcDate(issuedAt)
        : firstExchangeSessionOnOrAfter(utcDate(issuedAt));
    }
    case "point": {
      return utcDate(issuedAt);
    }
    case "earnings-close-window": {
      const origin = earningsOriginDate(new Date(`${strategy.eventDate}T00:00:00Z`), timing);
      return `event ${strategy.eventDate}@${utcDate(origin)}`;
    }
    case "composite": {
      return strategy.strategies
        .map((nested) => clockForecastOrigin(nested, assetClass, issuedAt, timing))
        .join(" & ");
    }
  }
}

// Legacy fallback for a score without `forecastOrigin`; earnings timing defaults to unknown.
export function recomputedForecastOrigin(
  assetClass: AssetClass,
  measurableAs: string,
  generatedAt: string,
  timing: EarningsEventTiming = "unknown",
): string {
  const issuedAt = new Date(generatedAt);
  try {
    const strategy = observationStrategyForExpression(parseObservableExpression(measurableAs));
    return clockForecastOrigin(strategy, assetClass, issuedAt, timing);
  } catch {
    return clockForecastOrigin(
      { mode: "close-window", subjects: [], horizonTradingDays: 0 },
      assetClass,
      issuedAt,
      timing,
    );
  }
}

// A score's Forecast Event origin: what the resolver persisted, else the report-clock recompute.
export function scoreForecastOrigin(
  score: { readonly forecastOrigin?: string },
  measurableAs: string,
  report: ResearchReport,
): string {
  return (
    score.forecastOrigin ??
    recomputedForecastOrigin(
      report.assetClass,
      measurableAs,
      report.generatedAt,
      readEarningsEventTiming(report),
    )
  );
}
