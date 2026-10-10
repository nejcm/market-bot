import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "../artifacts";
import type { Prediction } from "../domain/prediction";
import type { ResearchReport } from "../domain/report";
import { isRecord } from "../guards";
import { RUN_ARTIFACT_FILES } from "../run-artifact-layout";
import { loadRunArtifact } from "../run-artifacts";
import {
  readYahooRegularSession,
  withholdUnfinishedSessions,
  type YahooRegularSessionRead,
} from "../sources/yahoo";
import { fetchCloseWithCache, readLegacyWindowEntry } from "./close-cache";
import { scoreOnePrediction, writeMissAutopsyRunDir, type ScorePassOptions } from "./index";
import { resolveOutcome, type ResolveOutcomeResult } from "./resolver";
import type { AuditedWithheldSession, PredictionScore, ScoreRepairVerdict } from "./types";

const DAY_MS = 86_400_000;

type ScoreRepairDetection =
  | ScoreRepairVerdict
  | "not-applicable"
  | "unaffected"
  | "unreproducible"
  | "not-resolved"
  | "already-repaired";

export interface ScoreRepairRequest {
  readonly runId: string;
  readonly predictionId: string;
  readonly apply: boolean;
  readonly now: Date;
  readonly options: ScorePassOptions;
}

export interface ScoreRepairResult {
  readonly runId: string;
  readonly predictionId: string;
  readonly verdict: ScoreRepairDetection;
  readonly detail: string;
  readonly withheldSessions: readonly AuditedWithheldSession[];
  readonly original: PredictionScore;
  readonly repaired?: PredictionScore;
  readonly runDir: string;
}

interface Detection {
  readonly verdict: ScoreRepairDetection;
  readonly detail: string;
  readonly withheldSessions: readonly AuditedWithheldSession[];
}

const ymd = (date: Date): string => date.toISOString().slice(0, 10);

function cachedPayload(raw: string): unknown {
  try {
    const entry = JSON.parse(raw) as unknown;
    return isRecord(entry) ? entry.payload : undefined;
  } catch {
    return undefined;
  }
}

function chartSymbol(payload: unknown): string | undefined {
  const result =
    isRecord(payload) && isRecord(payload.chart) && Array.isArray(payload.chart.result)
      ? payload.chart.result[0]
      : undefined;
  return isRecord(result) && isRecord(result.meta) && typeof result.meta.symbol === "string"
    ? result.meta.symbol.toUpperCase()
    : undefined;
}

// Regular-session schedules recorded by any Yahoo chart fetch around the scoring day, keyed by
// Symbol and session date. A later fetch still proves when that session closed.
async function recordedSchedules(
  cacheDir: string,
  scoredAt: Date,
): Promise<ReadonlyMap<string, YahooRegularSessionRead>> {
  const schedules = new Map<string, YahooRegularSessionRead>();
  const days = [-1, 0, 1].map((offset) => ymd(new Date(scoredAt.getTime() + offset * DAY_MS)));
  for (const day of days) {
    const dir = join(cacheDir, day);
    // oxlint-disable-next-line no-await-in-loop -- Three small directories, read in order.
    const names = await readdir(dir).catch(() => []);
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      // oxlint-disable-next-line no-await-in-loop -- Sequential reads bound memory on large payloads.
      const raw = await readFile(join(dir, name), "utf8").catch(() => "");
      if (!raw.includes('"currentTradingPeriod"')) {
        continue;
      }
      const payload = cachedPayload(raw);
      const symbol = chartSymbol(payload);
      const schedule = readYahooRegularSession(payload);
      if (symbol !== undefined && schedule.status === "ok") {
        schedules.set(`${symbol}|${schedule.window.startDate}`, schedule);
      }
    }
  }
  return schedules;
}

function reproducesScore(result: ResolveOutcomeResult, score: PredictionScore): boolean {
  return (
    (result.status === "resolved" || result.status === "voided") &&
    result.status === (score.status ?? "resolved") &&
    (result.status !== "resolved" || result.outcome === score.outcome) &&
    JSON.stringify(result.evidence) === JSON.stringify(score.evidence)
  );
}

// Replays the score from the uncertified v2 windows it consumed, as stored and then with the
// Completed-session rule applied at each window's own acquisition time. Reads only.
async function detect(
  report: ResearchReport,
  prediction: Prediction,
  original: PredictionScore,
  cacheDir: string | undefined,
): Promise<Detection> {
  const none = { withheldSessions: [] };
  if (original.repair !== undefined) {
    return {
      verdict: "already-repaired",
      detail: `repaired at ${original.repair.repairedAt}`,
      ...none,
    };
  }
  if (!original.resolved || original.status === "abandoned" || original.observedAt === undefined) {
    return {
      verdict: "not-resolved",
      detail: `score status is ${original.status ?? "unknown"}`,
      ...none,
    };
  }
  if (report.assetClass !== "equity") {
    return {
      verdict: "not-applicable",
      detail: "only equity close-session scores can consume an unfinished exchange session",
      ...none,
    };
  }
  if (cacheDir === undefined) {
    return {
      verdict: "unreproducible",
      detail: "the close cache is disabled, so the consumed windows cannot be replayed",
      ...none,
    };
  }
  const scoredAt = new Date(original.observedAt);
  const schedules = await recordedSchedules(cacheDir, scoredAt);
  const withheldSessions: AuditedWithheldSession[] = [];
  // "proven" drops only bars that existed and were provably still trading at acquisition.
  const replay = (mode: "as-scored" | "certified" | "proven") =>
    resolveOutcome(
      prediction,
      report,
      {
        async point(request, assetClass, date) {
          const value = await fetchCloseWithCache(
            request.observationSubject,
            assetClass,
            date,
            cacheDir,
            async () => undefined,
          );
          return value === undefined
            ? undefined
            : { subject: request.observationSubject, date: ymd(date), value };
        },
        async window(subject, assetClass, from, to, options) {
          const entry = await readLegacyWindowEntry(
            cacheDir,
            subject,
            assetClass,
            from,
            to,
            options,
          );
          if (entry === undefined || mode === "as-scored") {
            return entry?.observations ?? [];
          }
          // Prefer the acquisition day's session, which also exposes a pre-open window.
          const scheduleFor = (date: string | undefined) =>
            schedules.get(`${subject.toUpperCase()}|${String(date)}`);
          const window = withholdUnfinishedSessions(
            entry.observations,
            scheduleFor(entry.cachedAt.slice(0, 10)) ??
              scheduleFor(entry.observations.at(-1)?.date) ?? { status: "absent" },
            entry.cachedAt,
          );
          if (mode === "proven") {
            const trading = new Set(
              (window.withheldSessions ?? []).flatMap((session) =>
                session.status === "in-progress" ? [session.date] : [],
              ),
            );
            return entry.observations.filter((observation) => !trading.has(observation.date));
          }
          withheldSessions.push(
            ...(window.withheldSessions ?? []).map((session) => ({
              subject,
              acquiredAt: entry.cachedAt,
              ...session,
            })),
          );
          return window;
        },
      },
      scoredAt,
    );
  const asScored = await replay("as-scored");
  if (!reproducesScore(asScored, original)) {
    return {
      verdict: "unreproducible",
      detail: "the cached v2 windows no longer reproduce the stored score",
      ...none,
    };
  }
  const certified = await replay("certified");
  if (JSON.stringify(certified) === JSON.stringify(asScored)) {
    return {
      verdict: "unaffected",
      detail: "every session it consumed was complete at acquisition",
      ...none,
    };
  }
  const proven = await replay("proven");
  return JSON.stringify(proven) === JSON.stringify(asScored)
    ? {
        verdict: "suspect",
        detail: "no recorded schedule proves a consumed session had closed",
        withheldSessions,
      }
    : {
        verdict: "proven-premature",
        detail: "a recorded exchange schedule shows a consumed session was still trading",
        withheldSessions,
      };
}

async function readRawScoreFile(runDir: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(
    await readFile(join(runDir, RUN_ARTIFACT_FILES.score), "utf8"),
  ) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.scores)) {
    throw new Error(`Unreadable ${RUN_ARTIFACT_FILES.score} in ${runDir}`);
  }
  return parsed;
}

async function resolveRunDir(dataDir: string, runId: string): Promise<string> {
  const runDir = join(dataDir, runId);
  const [runsReal, runReal] = await Promise.all([
    realpath(dataDir).catch(() => undefined),
    realpath(runDir).catch(() => undefined),
  ]);
  if (
    basename(runId) !== runId ||
    runId.startsWith(".") ||
    runReal === undefined ||
    dirname(runReal) !== runsReal
  ) {
    throw new Error(`Invalid run id: ${runId}`);
  }
  return runDir;
}

// Callers hold data/shared-state.lock when `apply` is set, then refresh the index and Calibration.
// Rerunning --apply on a repaired score redoes those derived steps without rescoring.
export async function repairScore(
  dataDir: string,
  request: ScoreRepairRequest,
): Promise<ScoreRepairResult> {
  const runDir = await resolveRunDir(dataDir, request.runId);
  const { artifact } = await loadRunArtifact(runDir);
  const rawFile = await readRawScoreFile(runDir);
  const rawRows = rawFile.scores as readonly unknown[];
  const isTarget = (row: unknown) => isRecord(row) && row.predictionId === request.predictionId;
  const prediction = artifact?.report.predictions.find(({ id }) => id === request.predictionId);
  const matches = artifact?.scores.filter(
    ({ predictionId }) => predictionId === request.predictionId,
  );
  const [original] = matches ?? [];
  if (artifact === undefined || prediction === undefined || original === undefined) {
    throw new Error(`No scored Prediction ${request.predictionId} in run ${request.runId}`);
  }
  if (matches?.length !== 1 || rawRows.filter((row) => isTarget(row)).length !== 1) {
    throw new Error(
      `Prediction ${request.predictionId} does not select exactly one score row in run ${request.runId}`,
    );
  }
  const detection = await detect(
    artifact.report,
    prediction,
    original,
    request.options.closeCacheDir,
  );
  const result = { runId: request.runId, predictionId: prediction.id, original, runDir };
  if (request.apply && detection.verdict === "already-repaired") {
    await writeMissAutopsyRunDir(
      runDir,
      artifact.report,
      artifact.scores,
      artifact.missAutopsies,
      request.now,
    );
    return { ...result, ...detection, repaired: original };
  }
  if (
    !request.apply ||
    (detection.verdict !== "proven-premature" && detection.verdict !== "suspect")
  ) {
    return { ...result, ...detection };
  }

  const replacement = await scoreOnePrediction(
    prediction,
    artifact.report,
    undefined,
    request.now,
    request.options,
  );
  if (replacement.status !== "resolved" && replacement.status !== "voided") {
    return {
      ...result,
      ...detection,
      detail: `${detection.detail}; verified replacement observations are unavailable (${String(replacement.evidence.reason)}), so nothing was written`,
    };
  }
  const repaired: PredictionScore = {
    ...replacement,
    repair: {
      repairedAt: request.now.toISOString(),
      verdict: detection.verdict,
      withheldSessions: detection.withheldSessions,
      original: rawRows.find((row) => isTarget(row)) as Record<string, unknown>,
    },
  };
  await writeFileAtomic(
    join(runDir, RUN_ARTIFACT_FILES.score),
    `${JSON.stringify(
      { ...rawFile, scores: rawRows.map((row) => (isTarget(row) ? repaired : row)) },
      undefined,
      2,
    )}\n`,
  );
  await writeMissAutopsyRunDir(
    runDir,
    artifact.report,
    artifact.scores.map((score) => (score === original ? repaired : score)),
    artifact.missAutopsies,
    request.now,
  );
  return { ...result, ...detection, repaired };
}

function describeScore(score: PredictionScore): string {
  return `${score.status ?? "resolved"}${score.outcome === undefined ? "" : ` ${score.outcome}`} observed ${String(score.observedAt)}`;
}

function describeWithheld(session: AuditedWithheldSession): string {
  switch (session.status) {
    case "in-progress": {
      return `in progress, regular session closes ${session.closesAt}`;
    }
    case "awaiting-open": {
      return `unproven until the next session opens at ${session.opensAt}`;
    }
    case "unverified": {
      return session.reason;
    }
  }
}

export function renderScoreRepair(result: ScoreRepairResult, apply: boolean): string {
  const lines = [
    `Score repair ${result.runId} ${result.predictionId}: ${result.verdict}`,
    `  ${result.detail}`,
    `  stored: ${describeScore(result.original)}`,
    ...result.withheldSessions.map(
      (session) =>
        `  withheld ${session.subject} ${session.date} (acquired ${session.acquiredAt}): ${describeWithheld(session)}`,
    ),
  ];
  if (result.verdict === "already-repaired" && result.repaired !== undefined) {
    lines.push("  derived artifacts refreshed; the score itself was not rescored");
  } else if (result.repaired !== undefined) {
    lines.push(
      `  repaired: ${describeScore(result.repaired)}; the stored score is kept under repair.original`,
    );
  } else if (!apply && (result.verdict === "proven-premature" || result.verdict === "suspect")) {
    lines.push("  dry run: nothing written; rerun with --apply to rescore from verified sessions");
  }
  return lines.join("\n");
}
