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
import { resolutionDate } from "./exchange-calendar";
import type { ObservationRepository } from "./observations";
import type { ScoreOutcome } from "./types";

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

  const resDate = resolutionDate(report.generatedAt, prediction.horizonTradingDays);

  if (resDate > now) {
    return {
      status: "unresolved",
      reason: "horizon-not-elapsed",
      evidence: { reason: "horizon not yet elapsed" },
    };
  }

  const strategy = observationStrategyForForecast(forecast);
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
