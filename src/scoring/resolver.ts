import type { Prediction, ResearchReport } from "../domain/types";
import {
  type ObservableBaseExpression,
  type ObservationStrategy,
  type Observation,
  type PointObservationRequest,
  observableForecastFromPrediction,
  observationStrategyForExpression,
  observationStrategyForForecast,
  resolveObservableExpression,
  resolveObservableForecast,
} from "../forecast/observable";
import { isExchangeTradingDay, resolutionDate } from "./exchange-calendar";
import type { ObservationRepository } from "./observations";
import type { ScoreOutcome } from "./types";
import { isRecord } from "../sources/guards";

export type { Observation };

export interface ResolveOutcomeResolved {
  readonly status: "resolved";
  readonly outcome: ScoreOutcome;
  readonly evidence: Record<string, unknown>;
}

export interface ResolveOutcomeVoided {
  readonly status: "voided";
  readonly evidence: Record<string, unknown>;
}

export interface ResolveOutcomeUnresolved {
  readonly status: "unresolved";
  readonly reason: "horizon-not-elapsed" | "observation-unavailable";
  readonly scoreStatus?: "pending-condition" | "active-pending";
  readonly evidence: Record<string, unknown>;
}

export type ResolveOutcomeResult =
  | ResolveOutcomeResolved
  | ResolveOutcomeVoided
  | ResolveOutcomeUnresolved;

async function closeObservations(
  report: ResearchReport,
  now: Date,
  repo: ObservationRepository,
  subjects: readonly string[],
  horizonTradingDays: number,
): Promise<readonly Observation[]> {
  const windows = await Promise.all(
    subjects.map((subject) =>
      repo.window(subject, report.assetClass, new Date(report.generatedAt), now),
    ),
  );
  const required = horizonTradingDays + 1;
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
  requests: readonly PointObservationRequest[],
  includeOrigin: boolean,
): Promise<readonly Observation[]> {
  const originDate = new Date(report.generatedAt);
  const atOrigin = includeOrigin
    ? await Promise.all(
        requests.map((request) => repo.point(request, report.assetClass, originDate)),
      )
    : [];
  const atHorizon = await Promise.all(
    requests.map((request) => repo.point(request, report.assetClass, resDate)),
  );

  return [...atOrigin, ...atHorizon].filter(
    (observation): observation is Observation => observation !== undefined,
  );
}

type EarningsEventTiming = "bmo" | "amc" | "unknown";

function readEarningsEventTiming(report: ResearchReport): EarningsEventTiming {
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

function shiftCalendarDay(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function previousTradingDay(date: Date): Date {
  let cursor = shiftCalendarDay(date, -1);
  while (!isExchangeTradingDay(cursor)) {
    cursor = shiftCalendarDay(cursor, -1);
  }
  return cursor;
}

function earningsOriginDate(eventDate: Date, timing: EarningsEventTiming): Date {
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

function earningsHorizonDate(
  eventDate: string,
  timing: EarningsEventTiming,
  horizonTradingDays: number,
): Date {
  if (timing === "bmo") {
    // BMO: first post-event session is eventDate itself.
    // Advance N trading days from the day before eventDate.
    const dayBefore = new Date(`${eventDate}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    return resolutionDate(dayBefore.toISOString(), horizonTradingDays);
  }
  // AMC / unknown: first post-event session is the next trading day.
  return resolutionDate(`${eventDate}T00:00:00Z`, horizonTradingDays);
}

async function earningsCloseObservations(
  report: ResearchReport,
  now: Date,
  repo: ObservationRepository,
  subject: string,
  eventDate: string,
  horizonTradingDays: number,
): Promise<readonly Observation[]> {
  const timing = readEarningsEventTiming(report);
  const originDate = earningsOriginDate(new Date(`${eventDate}T00:00:00Z`), timing);
  const horizonDate = earningsHorizonDate(eventDate, timing, horizonTradingDays);

  if (horizonDate > now) {
    return [];
  }

  const window = await repo.window(subject, report.assetClass, originDate, now);

  // Count how many trading days we need from origin to horizon.
  // BMO: origin (prior day) + N event days = N+1 closes
  // AMC: origin (event-date) + N post-event days = N+1 closes
  // Unknown: origin (prior day) + event-date + N post-event days = N+2 closes
  const required = timing === "unknown" ? horizonTradingDays + 2 : horizonTradingDays + 1;

  if (window.length < required) {
    return [];
  }

  // Return origin and horizon closes only — the DSL resolver compares first and last.
  const [origin] = window;
  const horizon = window[required - 1];
  if (origin === undefined || horizon === undefined) {
    return [];
  }
  return [origin, horizon];
}

async function observationsForStrategy(
  strategy: ObservationStrategy,
  report: ResearchReport,
  now: Date,
  repo: ObservationRepository,
): Promise<readonly Observation[]> {
  if (strategy.mode === "close-window") {
    return closeObservations(report, now, repo, strategy.subjects, strategy.horizonTradingDays);
  }
  if (strategy.mode === "point") {
    return pointObservations(
      report,
      resolutionDate(report.generatedAt, strategy.horizonTradingDays),
      repo,
      strategy.requests,
      strategy.includeOrigin,
    );
  }
  if (strategy.mode === "earnings-close-window") {
    return earningsCloseObservations(
      report,
      now,
      repo,
      strategy.subject,
      strategy.eventDate,
      strategy.horizonTradingDays,
    );
  }
  const nested = await Promise.all(
    strategy.strategies.map((nestedStrategy) =>
      observationsForStrategy(nestedStrategy, report, now, repo),
    ),
  );
  return nested.flat();
}

function horizonPendingEvidence(reason: string): ResolveOutcomeUnresolved {
  return {
    status: "unresolved",
    reason: "horizon-not-elapsed",
    evidence: { reason },
  };
}

async function resolveBaseExpression(
  expression: ObservableBaseExpression,
  report: ResearchReport,
  repo: ObservationRepository,
  now: Date,
): Promise<ReturnType<typeof resolveObservableExpression>> {
  const observations = await observationsForStrategy(
    observationStrategyForExpression(expression),
    report,
    now,
    repo,
  );
  return resolveObservableExpression(expression, observations);
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
  if (forecast.expression.kind === "conditional") {
    const { antecedent, consequent } = forecast.expression;
    const antecedentDate = resolutionDate(report.generatedAt, antecedent.horizonTradingDays);
    if (antecedentDate > now) {
      return {
        ...horizonPendingEvidence("conditional antecedent horizon not yet elapsed"),
        scoreStatus: "pending-condition",
      };
    }

    const antecedentResult = await resolveBaseExpression(antecedent, report, repo, now);
    if (antecedentResult.status === "unresolved") {
      return {
        status: "unresolved",
        reason: "observation-unavailable",
        scoreStatus: "pending-condition",
        evidence: { reason: "conditional antecedent observation unavailable" },
      };
    }
    // Base expressions cannot currently void; keep this defensive branch so a
    // Future base lifecycle state does not accidentally activate a conditional.
    if (antecedentResult.status === "voided") {
      return {
        status: "voided",
        evidence: {
          reason: "conditional antecedent did not occur",
          antecedent: antecedentResult.evidence,
        },
      };
    }
    if (antecedentResult.outcome === "miss") {
      return {
        status: "voided",
        evidence: {
          reason: "conditional antecedent did not occur",
          antecedent: antecedentResult.evidence,
        },
      };
    }

    const consequentDate = resolutionDate(report.generatedAt, consequent.horizonTradingDays);
    if (consequentDate > now) {
      return {
        status: "unresolved",
        reason: "horizon-not-elapsed",
        scoreStatus: "active-pending",
        evidence: {
          reason: "conditional antecedent occurred; consequent horizon not yet elapsed",
          antecedent: antecedentResult.evidence,
        },
      };
    }

    const consequentResult = await resolveBaseExpression(consequent, report, repo, now);
    if (consequentResult.status !== "resolved") {
      return {
        status: "unresolved",
        reason: "observation-unavailable",
        scoreStatus: "active-pending",
        evidence: {
          reason: "conditional consequent observation unavailable",
          antecedent: antecedentResult.evidence,
        },
      };
    }
    return {
      status: "resolved",
      outcome: consequentResult.outcome,
      evidence: {
        antecedent: antecedentResult.evidence,
        consequent: consequentResult.evidence,
      },
    };
  }

  const strategy = observationStrategyForForecast(forecast);

  // Earnings kinds use event-anchored due-date checks; all others use report-anchored.
  if (strategy.mode === "earnings-close-window") {
    const timing = readEarningsEventTiming(report);
    const horizonDate = earningsHorizonDate(
      strategy.eventDate,
      timing,
      strategy.horizonTradingDays,
    );
    if (horizonDate > now) {
      return horizonPendingEvidence("earnings event horizon not yet elapsed");
    }
  } else {
    const resDate = resolutionDate(report.generatedAt, prediction.horizonTradingDays);
    if (resDate > now) {
      return horizonPendingEvidence("horizon not yet elapsed");
    }
  }

  const observations = await observationsForStrategy(strategy, report, now, repo);

  const result = resolveObservableForecast(forecast, observations);
  if (result.status === "unresolved") {
    return {
      status: "unresolved",
      reason: "observation-unavailable",
      evidence: { reason: "observation unavailable" },
    };
  }
  if (result.status === "voided") {
    return { status: "voided", evidence: result.evidence };
  }
  return { status: "resolved", outcome: result.outcome, evidence: result.evidence };
}
