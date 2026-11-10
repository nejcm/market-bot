import { DAY_MS } from "../config/shared";
import type { Prediction } from "../domain/prediction";
import type { ResearchReport } from "../domain/report";
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
import {
  clockForecastOrigin,
  earningsOriginDate,
  readEarningsEventTiming,
  shiftCalendarDay,
  type EarningsEventTiming,
} from "./forecast-origin";
import type { ObservationRepository } from "./observations";
import { scoringPolicyFor, type ScoringPolicy } from "./policy";
import { ORIGIN_ANCHOR_QUARANTINE_EVIDENCE_KEY, type ScoreOutcome } from "./types";
import { isUsListing } from "../sources/instrument-capability";
import { verifiedSnapshotSourceId } from "../sources/verified-snapshot-contract";
import type { CloseWindow } from "../sources/yahoo-chart";

export type { Observation };

const PROVIDER_SESSION_ANCHOR_TOLERANCE_DAYS = 5;

interface ResolveOutcomeResolved {
  readonly status: "resolved";
  readonly outcome: ScoreOutcome;
  readonly evidence: Record<string, unknown>;
  readonly forecastOrigin?: string;
}

interface ResolveOutcomeVoided {
  readonly status: "voided";
  readonly evidence: Record<string, unknown>;
  readonly forecastOrigin?: string;
}

interface ResolveOutcomeUnresolved {
  readonly status: "unresolved";
  readonly reason: "horizon-not-elapsed" | "observation-unavailable";
  readonly scoreStatus?: "pending-condition" | "active-pending";
  readonly evidence: Record<string, unknown>;
}

export type ResolveOutcomeResult =
  | ResolveOutcomeResolved
  | ResolveOutcomeVoided
  | ResolveOutcomeUnresolved;

interface UnverifiedSession {
  readonly subject: string;
  readonly date: string;
}

interface OriginAnchorQuarantine {
  readonly unverifiedSessions: readonly UnverifiedSession[];
  // Origin used after excluding unverified sessions from the candidate window, not proof of reselection.
  readonly replacementOriginDate?: string;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startsWithinProviderAnchorTolerance(
  window: readonly Observation[],
  anchor: Date,
): boolean {
  const [first] = window;
  if (first === undefined) {
    return false;
  }
  const anchorTime = Date.parse(`${ymd(anchor)}T00:00:00Z`);
  const firstTime = Date.parse(`${first.date}T00:00:00Z`);
  const delay = firstTime - anchorTime;
  return delay >= 0 && delay <= PROVIDER_SESSION_ANCHOR_TOLERANCE_DAYS * DAY_MS;
}

function unverifiedSession(report: ResearchReport, subject: string): UnverifiedSession | undefined {
  const source = report.sources.find(
    (candidate) => candidate.id === verifiedSnapshotSourceId(subject),
  );
  return source?.latestSessionStatus === "unverified" &&
    typeof source.latestSessionDate === "string"
    ? { subject, date: source.latestSessionDate }
    : undefined;
}

function unverifiedSessions(
  report: ResearchReport,
  subjects: readonly string[],
  policy: ScoringPolicy,
): readonly UnverifiedSession[] {
  if (policy.version !== 3 || report.assetClass !== "equity") {
    return [];
  }
  return subjects
    .map((subject) => unverifiedSession(report, subject))
    .filter((session): session is UnverifiedSession => session !== undefined);
}

function alignedCloseWindows(
  windows: readonly { readonly subject: string; readonly observations: readonly Observation[] }[],
  originDate: string,
  required: number,
): readonly Observation[] {
  const selected = windows.map(({ observations }) =>
    observations.filter((observation) => observation.date >= originDate).slice(0, required),
  );
  const dates = selected[0]?.map((observation) => observation.date);
  if (
    dates === undefined ||
    selected.some(
      (window) =>
        window.length !== required ||
        window.some((observation, index) => observation.date !== dates[index]),
    )
  ) {
    return [];
  }
  return selected.flat();
}

async function closeObservations(
  report: ResearchReport,
  now: Date,
  repo: ObservationRepository,
  subjects: readonly string[],
  horizonTradingDays: number,
  policy: ScoringPolicy,
): Promise<readonly Observation[]> {
  const anchor = new Date(report.generatedAt);
  const quarantined = unverifiedSessions(report, subjects, policy).filter(
    (session) => session.date <= ymd(anchor),
  );
  const fetchFrom =
    quarantined.length === 0
      ? anchor
      : shiftCalendarDay(anchor, -PROVIDER_SESSION_ANCHOR_TOLERANCE_DAYS);
  const windows = await Promise.all(
    subjects.map(async (subject) => ({
      subject,
      observations: await repo.window(subject, report.assetClass, fetchFrom, now, {
        scoringPolicyVersion: policy.version,
      }),
    })),
  );

  // Crypto under policy v3 resolves on the target UTC calendar date: the
  // Outcome close must be observed on exactly that date, not the Nth provider
  // Session. The full origin-through-target window is kept so within-horizon
  // Shapes (volatility max) see every intermediate close; endpoint shapes read
  // First/last. Equity (both policies) and v2 crypto count provider sessions.
  const cryptoTargetDate =
    report.assetClass === "crypto"
      ? policy.cryptoCloseTargetDate?.(report.generatedAt, horizonTradingDays)
      : undefined;
  if (cryptoTargetDate !== undefined) {
    const originYmd = ymd(new Date(report.generatedAt));
    const targetYmd = ymd(cryptoTargetDate);
    const selected = windows.map(({ observations }) => {
      const inRange = observations.filter(
        (observation) => observation.date >= originYmd && observation.date <= targetYmd,
      );
      const hasOrigin = inRange.some((observation) => observation.date === originYmd);
      const hasTarget = inRange.some((observation) => observation.date === targetYmd);
      return hasOrigin && hasTarget ? inRange : undefined;
    });
    return selected.every((range) => range !== undefined) ? selected.flat() : [];
  }

  const required = horizonTradingDays + 1;
  if (quarantined.length > 0) {
    const cutoff = quarantined
      .map((session) => session.date)
      .toSorted()
      .at(0);
    const originDate = windows[0]?.observations.findLast(
      (observation) =>
        cutoff !== undefined &&
        observation.date < cutoff &&
        observation.date <= ymd(anchor) &&
        windows.every(({ observations }) =>
          observations.some((candidate) => candidate.date === observation.date),
        ),
    )?.date;
    return originDate === undefined ? [] : alignedCloseWindows(windows, originDate, required);
  }

  const enough = windows.every(
    ({ observations }) =>
      observations.length >= required &&
      (report.assetClass !== "equity" ||
        policy.version !== 3 ||
        startsWithinProviderAnchorTolerance(observations, anchor)),
  );

  if (!enough) {
    return [];
  }

  return windows.flatMap(({ observations }) => observations.slice(0, required));
}

// Published observation nearest `date`, walking by `stepDays` up to the
// Policy's search bound (never past `now`). Policy v2 searches zero days,
// Preserving its exact-date semantics; policy v3 point dates are UTC calendar
// Days, so weekends and provider holidays publish nothing on the date itself.
// Horizon targets walk forward (+1) to the first publication on or after the
// Target. Origins walk backward (-1): the baseline must be the last value
// Already published when the forecast was made — a forward origin search
// Would grade the change from post-forecast data.
async function nearestPointObservation(
  repo: ObservationRepository,
  request: PointObservationRequest,
  report: ResearchReport,
  date: Date,
  stepDays: 1 | -1,
  remainingDays: number,
  now: Date,
): Promise<Observation | undefined> {
  if (date > now) {
    return undefined;
  }
  const observation = await repo.point(request, report.assetClass, date);
  if (observation !== undefined || remainingDays === 0) {
    return observation;
  }
  return nearestPointObservation(
    repo,
    request,
    report,
    new Date(date.getTime() + stepDays * DAY_MS),
    stepDays,
    remainingDays - 1,
    now,
  );
}

async function pointObservations(
  report: ResearchReport,
  resDate: Date,
  repo: ObservationRepository,
  requests: readonly PointObservationRequest[],
  includeOrigin: boolean,
  policy: ScoringPolicy,
  now: Date,
): Promise<readonly Observation[]> {
  const searchDays = policy.pointObservationSearchAheadDays;
  const originDate = new Date(report.generatedAt);
  const atOrigin = includeOrigin
    ? await Promise.all(
        requests.map((request) =>
          nearestPointObservation(repo, request, report, originDate, -1, searchDays, now),
        ),
      )
    : [];
  const atHorizon = await Promise.all(
    requests.map((request) =>
      nearestPointObservation(repo, request, report, resDate, 1, searchDays, now),
    ),
  );

  return [...atOrigin, ...atHorizon].filter(
    (observation): observation is Observation => observation !== undefined,
  );
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

function providerEarningsObservations(
  window: readonly Observation[],
  eventDate: string,
  timing: EarningsEventTiming,
  horizonTradingDays: number,
  unverifiedDate?: string,
): readonly Observation[] {
  const origin = window.findLast(
    (observation) =>
      observation.date !== unverifiedDate &&
      (timing === "amc" ? observation.date <= eventDate : observation.date < eventDate),
  );
  const horizon = window
    .filter((observation) =>
      timing === "bmo" ? observation.date >= eventDate : observation.date > eventDate,
    )
    .at(horizonTradingDays - 1);
  return origin === undefined || horizon === undefined ? [] : [origin, horizon];
}

function earningsAnchorUnverifiedSession(
  report: ResearchReport,
  subject: string,
  eventDate: string,
  timing: EarningsEventTiming,
  policy: ScoringPolicy,
): UnverifiedSession | undefined {
  const [session] = unverifiedSessions(report, [subject], policy);
  if (session === undefined) {
    return undefined;
  }
  const couldAnchor = timing === "amc" ? session.date <= eventDate : session.date < eventDate;
  return couldAnchor ? session : undefined;
}

async function earningsCloseObservations(
  report: ResearchReport,
  now: Date,
  repo: ObservationRepository,
  subject: string,
  eventDate: string,
  horizonTradingDays: number,
  policy: ScoringPolicy,
): Promise<readonly Observation[]> {
  const timing = readEarningsEventTiming(report);
  const originDate = earningsOriginDate(new Date(`${eventDate}T00:00:00Z`), timing);
  const horizonDate = earningsHorizonDate(eventDate, timing, horizonTradingDays);

  if (horizonDate > now) {
    return [];
  }

  const fetchFrom =
    policy.version === 3
      ? shiftCalendarDay(originDate, -PROVIDER_SESSION_ANCHOR_TOLERANCE_DAYS)
      : originDate;
  const window = await repo.window(subject, report.assetClass, fetchFrom, now, {
    scoringPolicyVersion: policy.version,
  });
  if (policy.version === 3) {
    const quarantined = earningsAnchorUnverifiedSession(report, subject, eventDate, timing, policy);
    return providerEarningsObservations(
      window,
      eventDate,
      timing,
      horizonTradingDays,
      quarantined?.date,
    );
  }

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
  policy: ScoringPolicy,
): Promise<readonly Observation[]> {
  if (strategy.mode === "close-window") {
    return closeObservations(
      report,
      now,
      repo,
      strategy.subjects,
      strategy.horizonTradingDays,
      policy,
    );
  }
  if (strategy.mode === "point") {
    return pointObservations(
      report,
      policy.pointTargetDate(report.generatedAt, strategy.horizonTradingDays),
      repo,
      strategy.requests,
      strategy.includeOrigin,
      policy,
      now,
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
      policy,
    );
  }
  const nested = await Promise.all(
    strategy.strategies.map((nestedStrategy) =>
      observationsForStrategy(nestedStrategy, report, now, repo, policy),
    ),
  );
  return nested.flat();
}

function originAnchorQuarantine(
  strategy: ObservationStrategy,
  report: ResearchReport,
  observations: readonly Observation[],
  policy: ScoringPolicy,
): OriginAnchorQuarantine | undefined {
  let sessions: readonly UnverifiedSession[] = [];
  if (strategy.mode === "close-window") {
    sessions = unverifiedSessions(report, strategy.subjects, policy).filter(
      (session) => session.date <= ymd(new Date(report.generatedAt)),
    );
  } else if (strategy.mode === "earnings-close-window") {
    const session = earningsAnchorUnverifiedSession(
      report,
      strategy.subject,
      strategy.eventDate,
      readEarningsEventTiming(report),
      policy,
    );
    sessions = session === undefined ? [] : [session];
  }
  if (sessions.length === 0) {
    return undefined;
  }
  const replacementOriginDate = observations[0]?.date;
  return {
    unverifiedSessions: sessions,
    ...(replacementOriginDate !== undefined ? { replacementOriginDate } : {}),
  };
}

// Forecast Event origin (ADR 0003) from the window actually used, not the report clock.
function baseForecastOrigin(
  strategy: ObservationStrategy,
  report: ResearchReport,
  observations: readonly Observation[],
): string | undefined {
  const anchor = observations[0]?.date;
  switch (strategy.mode) {
    case "close-window": {
      return anchor;
    }
    case "earnings-close-window": {
      return anchor === undefined ? undefined : `event ${strategy.eventDate}@${anchor}`;
    }
    case "point": {
      return ymd(new Date(report.generatedAt));
    }
    case "composite": {
      return undefined;
    }
  }
}

function originField(origin: string | undefined): { readonly forecastOrigin?: string } {
  return origin === undefined ? {} : { forecastOrigin: origin };
}

function quarantineEvidence(
  evidence: Record<string, unknown>,
  quarantine: OriginAnchorQuarantine | undefined,
): Record<string, unknown> {
  return quarantine === undefined
    ? evidence
    : { ...evidence, [ORIGIN_ANCHOR_QUARANTINE_EVIDENCE_KEY]: quarantine };
}

// Earnings expressions stay event-anchored even when nested in a conditional.
// All other base expressions use the policy clock for their forecast family.
function baseExpressionDueDate(
  expression: ObservableBaseExpression,
  report: ResearchReport,
  policy: ScoringPolicy,
): Date {
  const strategy = observationStrategyForExpression(expression);
  if (strategy.mode === "earnings-close-window") {
    return earningsHorizonDate(
      strategy.eventDate,
      readEarningsEventTiming(report),
      strategy.horizonTradingDays,
    );
  }
  if (strategy.mode === "point") {
    return policy.pointTargetDate(report.generatedAt, expression.horizonTradingDays);
  }
  return policy.closeDueDate(report.generatedAt, expression.horizonTradingDays, report.assetClass);
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
  policy: ScoringPolicy,
): Promise<{
  readonly resolution: ReturnType<typeof resolveObservableExpression>;
  readonly quarantine?: OriginAnchorQuarantine;
  readonly origin?: string;
}> {
  const strategy = observationStrategyForExpression(expression);
  const observations = await observationsForStrategy(strategy, report, now, repo, policy);
  const quarantine = originAnchorQuarantine(strategy, report, observations, policy);
  const origin = baseForecastOrigin(strategy, report, observations);
  return {
    resolution: resolveObservableExpression(expression, observations),
    ...(quarantine !== undefined ? { quarantine } : {}),
    ...(origin !== undefined ? { origin } : {}),
  };
}

function withPendingPlaceholders(subject: string, window: CloseWindow): readonly Observation[] {
  const pending = (window.withheldSessions ?? []).filter(
    (session) => session.status === "in-progress" || session.status === "awaiting-open",
  );
  const placeholders = pending.map(({ date }) => ({
    subject,
    date,
    value:
      window.findLast((observation) => observation.date < date)?.value ?? window[0]?.value ?? 1,
  }));
  return [...window, ...placeholders].toSorted((left, right) =>
    left.date.localeCompare(right.date),
  );
}

// A non-US listing can print its Nth session after the US-calendar due date (local holidays).
// Wait for it, bounded, only on a clean in-tolerance anchor; everything else spends an attempt.
async function awaitsShortNonUsWindow(
  expression: ObservableBaseExpression,
  report: ResearchReport,
  repo: ObservationRepository,
  now: Date,
  policy: ScoringPolicy,
): Promise<boolean> {
  const strategy = observationStrategyForExpression(expression);
  const anchor = new Date(report.generatedAt);
  const deadline = baseExpressionDueDate(expression, report, policy).getTime() + 10 * DAY_MS;
  if (
    policy.version !== 3 ||
    report.assetClass !== "equity" ||
    strategy.mode !== "close-window" ||
    now.getTime() >= deadline ||
    unverifiedSessions(report, strategy.subjects, policy).some(
      (session) => session.date <= ymd(anchor),
    )
  ) {
    return false;
  }
  const windows = await Promise.all(
    strategy.subjects.map(async (subject) => ({
      subject,
      observations: await repo.window(subject, report.assetClass, anchor, now, {
        scoringPolicyVersion: policy.version,
      }),
    })),
  );
  const short = windows.filter(
    ({ observations }) => observations.length < strategy.horizonTradingDays + 1,
  );
  return (
    short.length > 0 &&
    short.every(({ subject }) => !isUsListing(subject)) &&
    windows.every(({ observations }) => startsWithinProviderAnchorTolerance(observations, anchor))
  );
}

// A still-trading session is a wait only when filling exactly those sessions would resolve the one
// Unresolved base expression; placeholders never decide a conditional's antecedent or activation.
export async function resolveOutcome(
  prediction: Prediction,
  report: ResearchReport,
  repo: ObservationRepository,
  now: Date,
): Promise<ResolveOutcomeResult> {
  const windows = new Map<string, Promise<CloseWindow>>();
  const points = new Map<string, Promise<Observation | undefined>>();
  const memoized: ObservationRepository = {
    point(request, assetClass, date) {
      const key = JSON.stringify([request, assetClass, date]);
      const cached = points.get(key) ?? repo.point(request, assetClass, date);
      points.set(key, cached);
      return cached;
    },
    window(subject, assetClass, from, to, options) {
      const key = JSON.stringify([subject, assetClass, from, to, options]);
      const cached = windows.get(key) ?? repo.window(subject, assetClass, from, to, options);
      windows.set(key, cached);
      return cached;
    },
  };
  const result = await resolveWithRepository(prediction, report, memoized, now);
  if (result.status !== "unresolved" || result.reason !== "observation-unavailable") {
    return result;
  }
  const forecast = observableForecastFromPrediction(prediction);
  if (!("prediction" in forecast)) {
    return result;
  }
  const { expression } = forecast;
  const conditionalSide = result.scoreStatus === "active-pending" ? "consequent" : "antecedent";
  const unresolvedExpression =
    expression.kind === "conditional" ? expression[conditionalSide] : expression;
  const policy = scoringPolicyFor(prediction);
  const fetched = await Promise.all(windows.values());
  const withheld = fetched.flatMap((window) => window.withheldSessions ?? []);
  let unavailable = result;
  if (withheld.length > 0) {
    const counterfactual = await resolveBaseExpression(
      unresolvedExpression,
      report,
      {
        point: memoized.point,
        async window(subject, assetClass, from, to, options) {
          return withPendingPlaceholders(
            subject,
            await memoized.window(subject, assetClass, from, to, options),
          );
        },
      },
      now,
      policy,
    );
    if (counterfactual.resolution.status !== "unresolved") {
      return { ...result, reason: "horizon-not-elapsed" };
    }
    unavailable = { ...result, evidence: { ...result.evidence, withheldSessions: withheld } };
  }
  return (await awaitsShortNonUsWindow(unresolvedExpression, report, memoized, now, policy))
    ? { ...result, reason: "horizon-not-elapsed" }
    : unavailable;
}

async function resolveWithRepository(
  prediction: Prediction,
  report: ResearchReport,
  repo: ObservationRepository,
  now: Date,
): Promise<ResolveOutcomeResult> {
  const policy = scoringPolicyFor(prediction);
  const forecast = observableForecastFromPrediction(prediction);
  if (!("prediction" in forecast)) {
    throw new Error(forecast.message);
  }
  if (forecast.expression.kind === "conditional") {
    const { antecedent, consequent } = forecast.expression;
    const antecedentDate = baseExpressionDueDate(antecedent, report, policy);
    if (antecedentDate > now) {
      return {
        ...horizonPendingEvidence("conditional antecedent horizon not yet elapsed"),
        scoreStatus: "pending-condition",
      };
    }

    const antecedentSelection = await resolveBaseExpression(antecedent, report, repo, now, policy);
    const antecedentResult = antecedentSelection.resolution;
    // A voided conditional never fetches its consequent window, so that leg stays on the report clock.
    const voidedOrigin = originField(
      antecedentSelection.origin === undefined
        ? undefined
        : `${antecedentSelection.origin} & ${clockForecastOrigin(
            observationStrategyForExpression(consequent),
            report.assetClass,
            new Date(report.generatedAt),
            readEarningsEventTiming(report),
          )}`,
    );
    if (antecedentResult.status === "unresolved") {
      return {
        status: "unresolved",
        reason: "observation-unavailable",
        scoreStatus: "pending-condition",
        evidence: quarantineEvidence(
          { reason: "conditional antecedent observation unavailable" },
          antecedentSelection.quarantine,
        ),
      };
    }
    // Base expressions cannot currently void; keep this defensive branch so a
    // Future base lifecycle state does not accidentally activate a conditional.
    if (antecedentResult.status === "voided") {
      return {
        status: "voided",
        evidence: {
          reason: "conditional antecedent did not occur",
          antecedent: quarantineEvidence(antecedentResult.evidence, antecedentSelection.quarantine),
        },
        ...voidedOrigin,
      };
    }
    if (antecedentResult.outcome === "miss") {
      return {
        status: "voided",
        evidence: {
          reason: "conditional antecedent did not occur",
          antecedent: quarantineEvidence(antecedentResult.evidence, antecedentSelection.quarantine),
        },
        ...voidedOrigin,
      };
    }

    const consequentDate = baseExpressionDueDate(consequent, report, policy);
    if (consequentDate > now) {
      return {
        status: "unresolved",
        reason: "horizon-not-elapsed",
        scoreStatus: "active-pending",
        evidence: {
          reason: "conditional antecedent occurred; consequent horizon not yet elapsed",
          antecedent: quarantineEvidence(antecedentResult.evidence, antecedentSelection.quarantine),
        },
      };
    }

    const consequentSelection = await resolveBaseExpression(consequent, report, repo, now, policy);
    const consequentResult = consequentSelection.resolution;
    if (consequentResult.status !== "resolved") {
      return {
        status: "unresolved",
        reason: "observation-unavailable",
        scoreStatus: "active-pending",
        evidence: {
          reason: "conditional consequent observation unavailable",
          antecedent: quarantineEvidence(antecedentResult.evidence, antecedentSelection.quarantine),
          ...(consequentSelection.quarantine !== undefined
            ? {
                [ORIGIN_ANCHOR_QUARANTINE_EVIDENCE_KEY]: consequentSelection.quarantine,
              }
            : {}),
        },
      };
    }
    return {
      status: "resolved",
      outcome: consequentResult.outcome,
      evidence: {
        antecedent: quarantineEvidence(antecedentResult.evidence, antecedentSelection.quarantine),
        consequent: quarantineEvidence(consequentResult.evidence, consequentSelection.quarantine),
      },
      ...originField(
        antecedentSelection.origin === undefined || consequentSelection.origin === undefined
          ? undefined
          : `${antecedentSelection.origin} & ${consequentSelection.origin}`,
      ),
    };
  }

  const strategy = observationStrategyForForecast(forecast);

  // Earnings kinds use event-anchored due-date checks; all others use the
  // Policy clock for their forecast family (point vs close).
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
    const resDate =
      strategy.mode === "point"
        ? policy.pointTargetDate(report.generatedAt, prediction.horizonTradingDays)
        : policy.closeDueDate(report.generatedAt, prediction.horizonTradingDays, report.assetClass);
    if (resDate > now) {
      return horizonPendingEvidence("horizon not yet elapsed");
    }
  }

  const observations = await observationsForStrategy(strategy, report, now, repo, policy);
  const quarantine = originAnchorQuarantine(strategy, report, observations, policy);

  const result = resolveObservableForecast(forecast, observations);
  if (result.status === "unresolved") {
    return {
      status: "unresolved",
      reason: "observation-unavailable",
      evidence: quarantineEvidence({ reason: "observation unavailable" }, quarantine),
    };
  }
  const origin = originField(baseForecastOrigin(strategy, report, observations));
  if (result.status === "voided") {
    return {
      status: "voided",
      evidence: quarantineEvidence(result.evidence, quarantine),
      ...origin,
    };
  }
  return {
    status: "resolved",
    outcome: result.outcome,
    evidence: quarantineEvidence(result.evidence, quarantine),
    ...origin,
  };
}
