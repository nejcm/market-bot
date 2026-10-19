import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AppConfig } from "../../../src/config";
import type { PredictionKind } from "../../../src/domain/prediction";
import type { SourceGap } from "../../../src/domain/sources";
import { isRecord } from "../../../src/guards";
import type { ModelProvider } from "../../../src/model/types";
import { knownSourceIds } from "../../../src/report/markdown-primitives";
import { readGapTriage } from "../../../src/report/gap-triage";
import type { RunAnalytics } from "../../../src/research/run-analytics";
import {
  MAX_REPORT_VALIDATION_REPROMPTS,
  type StageOutput,
} from "../../../src/research/final-synthesis";
import { MAX_PREDICTION_REPROMPTS } from "../../../src/research/orchestrator";
import { readAnalytics } from "../../../src/run-artifact-analytics-reader";
import { readJsonFile } from "../../../src/run-artifact-json-reader";
import { RUN_ARTIFACT_FILES } from "../../../src/run-artifact-layout";
import { readSourceGaps } from "../../../src/run-artifact-report-reader";
import { loadRunArtifact, type RunArtifact } from "../../../src/run-artifacts";
import type { FetchLike } from "../../../src/sources/types";
import { countCassetteMisses, makeReplayFetch } from "../../../src/replay/data-cassette";
import { createProvider } from "../../../src/model/factory";
import { createFixtureConfig, createLiveFixtureConfig, loadFixture, runFixture } from "./index";
import {
  type LiveStage,
  validateLiveStage,
  requestStage,
  makeReplayProvider,
  ModelReplayError,
  type ReplayProvider,
} from "../../../src/replay/llm-cassette";

import { EVALS_ROOT } from "../../../src/replay/eval-output";

export { EVALS_ROOT } from "../../../src/replay/eval-output";
const EVAL_SAMPLE_FILE = "eval-sample.json";
const SUMMARY_FILE = "summary.json";
const SYNTHESIS_SCOPE = "final-synthesis-only";
const MAX_RAW_RESPONSE_CHARS = 20_000;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

// Older Bun releases (CI pins one) omit the "Name: message" header from error.stack.
function errorStackWithMessage(error: Error, stack: string): string {
  const header = `${error.name}: ${error.message}`;
  return stack.startsWith(header) ? stack : `${header}\n${stack.replace(/^\w*Error\n/u, "")}`;
}
// Same predicate the final-synthesis language repair prompt uses to pick gate errors.
const LANGUAGE_GATE_ERROR = "trade-action language";
// AGENTS.md: a deep live equity run is ~438k tokens; synthetic cassettes record far less.
const LIVE_DEEP_RUN_TOKENS = 438_000;
// Initial call, prediction reprompts, the report retry and its prediction follow-up, report repairs.
const MAX_FINAL_SYNTHESIS_CALLS =
  1 + MAX_PREDICTION_REPROMPTS + 2 + MAX_REPORT_VALIDATION_REPROMPTS;
// Recorded deep fixtures spend ~37k–46k per synthesis call; synthetic cassettes record ~100.
const LIVE_STAGE_CALL_TOKENS = 50_000;
// Metric groups are keyed by the first dotted segment; an unavailable group is excluded from compare.
const METRIC_GROUPS = [
  "durationMs",
  "cassetteMisses",
  "modelReplayMisses",
  "modelCalls",
  "modelTokens",
  "tokens",
  "repairs",
  "predictions",
  "citations",
  "dataGaps",
  "sourceGaps",
  "integrity",
  "postSynthesisAudit",
  "synthesis",
] as const;
type MetricGroup = (typeof METRIC_GROUPS)[number];

type EvalSampleStatus =
  | "completed"
  | "failed-final-synthesis"
  | "threw"
  | "incomplete"
  | "not-exercised";

interface EvalSampleRecord {
  readonly fixture: string;
  readonly sample: string;
  readonly status: EvalSampleStatus;
  readonly runDirName?: string;
  readonly durationMs: number;
  readonly cassetteMisses: { readonly count: number; readonly keys: readonly string[] };
  readonly modelReplayMisses: {
    readonly count: number;
    readonly keys: readonly string[];
    readonly errors: readonly string[];
  };
  readonly modelCalls: { readonly replayed: number; readonly live: number };
  readonly tokens: { readonly replayed: number; readonly live: number };
  readonly evaluation?: {
    readonly liveStage: LiveStage;
    readonly downstreamReasoning: "recorded";
    readonly sourceRequests: "cassette-only";
  };
  readonly responseUsage?: ReturnType<ReplayProvider["diagnostics"]>;
  readonly error?: string;
  readonly errorStack?: string;
  readonly rawResponseContent?: string;
}

interface EvalSampleMetrics {
  readonly fixture: string;
  readonly sample: string;
  readonly status: EvalSampleStatus;
  readonly evaluation?: EvalSampleRecord["evaluation"];
  readonly cassetteMissKeys: readonly string[];
  readonly modelReplayMissKeys: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly unavailable: readonly MetricGroup[];
}

interface EvalSummary {
  readonly label: string;
  readonly scope?: typeof SYNTHESIS_SCOPE;
  readonly samples: readonly EvalSampleMetrics[];
}

export interface EvalSampleInput {
  readonly root?: string;
  readonly label: string;
  readonly fixture: string;
  readonly sample: string;
  readonly llm: "replay" | "live";
  readonly fetchImpl?: FetchLike;
  readonly provider?: ModelProvider;
  readonly liveStages?: LiveStage;
}

export interface EvalSampleResult extends EvalSampleRecord {
  readonly sampleDir: string;
  readonly runDir?: string;
}

function pathSegment(segment: string): string {
  if (!PATH_SEGMENT.test(segment)) {
    throw new Error(`Eval path segment must match ${PATH_SEGMENT.source}: ${segment}`);
  }
  return segment;
}

export function evalLabelDir(root: string, label: string): string {
  return join(resolve(root), pathSegment(label));
}

// Plain-name segments keep `runs/..` (cache, calibration, news-seen, peers) inside the sample dir.
export function evalSampleDir(
  root: string,
  label: string,
  fixture: string,
  sample: string,
): string {
  return join(
    evalLabelDir(root, label),
    pathSegment(
      fixture.includes("/")
        ? `${basename(resolve(fixture, ".."))}-${new Bun.CryptoHasher("sha256").update(resolve(fixture)).digest("hex").slice(0, 8)}`
        : fixture,
    ),
    pathSegment(sample),
  );
}

function disableIndexAccess(): () => void {
  const saved = {
    MARKET_BOT_INDEX_DISABLE: process.env.MARKET_BOT_INDEX_DISABLE,
    MARKET_BOT_INDEX_DB_PATH: process.env.MARKET_BOT_INDEX_DB_PATH,
  };
  process.env.MARKET_BOT_INDEX_DISABLE = "1";
  delete process.env.MARKET_BOT_INDEX_DB_PATH;
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

async function publishedRunDirName(dataDir: string): Promise<string | undefined> {
  const names = await readdir(dataDir).catch(() => []);
  return names.find((name) => !name.startsWith("."));
}

export async function runEvalSample(input: EvalSampleInput): Promise<EvalSampleResult> {
  if (input.liveStages !== undefined) {
    validateLiveStage(input.liveStages);
    if (input.llm === "replay" && input.provider === undefined) {
      throw new Error("Selected offline evaluation requires an injected provider");
    }
  }
  const sampleDir = evalSampleDir(
    input.root ?? EVALS_ROOT,
    input.label,
    input.fixture,
    input.sample,
  );
  const fixture = await loadFixture(input.fixture);
  await mkdir(dirname(sampleDir), { recursive: true });
  // Non-recursive: an existing sample dir throws EEXIST instead of mixing two runs' state.
  await mkdir(sampleDir);
  const dataDir = join(sampleDir, "runs");
  const missKeys: string[] = [];
  const modelMissKeys: string[] = [];
  const modelMissErrors: string[] = [];
  let replayedCalls = 0;
  let liveCalls = 0;
  let replayedTokens = 0;
  let liveTokens = 0;
  const replay: { provider?: ReplayProvider } = {};
  const fetchImpl = countCassetteMisses(
    input.fetchImpl ?? makeReplayFetch(fixture.dataCassette, fixture.dir),
    missKeys,
  );
  const startedAt = performance.now();
  const restoreEnv = disableIndexAccess();
  let rawResponseContent: string | undefined = undefined;
  const runError = await (async () => {
    const baseProvider =
      input.provider ??
      (input.llm === "replay" && input.liveStages === undefined
        ? makeReplayProvider(fixture.llmCassette)
        : createProvider(createLiveFixtureConfig(fixture.meta, dataDir)));
    const countedLive: ModelProvider = {
      ...baseProvider,
      generate: async (request) => {
        if (missKeys.length > 0 || modelMissKeys.length > 0) {
          throw new Error("Refusing live model call after replay failure");
        }
        liveCalls += 1;
        const response = await baseProvider.generate(request);
        liveTokens += response.tokenEstimate;
        return response;
      },
    };
    const provider =
      input.liveStages !== undefined
        ? makeReplayProvider(fixture.llmCassette, countedLive, input.liveStages)
        : baseProvider;
    const routedProvider =
      input.liveStages === undefined && input.llm === "live" ? countedLive : provider;
    if ("diagnostics" in provider && typeof provider.diagnostics === "function") {
      replay.provider = provider as ReplayProvider;
    }
    return runFixture(input.fixture, {
      llm: input.llm,
      dataDir,
      keepDataDir: true,
      fetchImpl,
      provider: {
        ...routedProvider,
        generate: async (request) => {
          rawResponseContent = undefined;
          try {
            const response = await routedProvider.generate(request);
            if (
              input.liveStages !== undefined
                ? requestStage(request) !== input.liveStages
                : input.llm === "replay"
            ) {
              replayedCalls += 1;
              replayedTokens += response.tokenEstimate;
            }
            rawResponseContent = response.content.slice(0, MAX_RAW_RESPONSE_CHARS);
            return response;
          } catch (error) {
            if (error instanceof ModelReplayError) {
              modelMissKeys.push(error.key);
              modelMissErrors.push(error.message);
            }
            throw error;
          }
        },
      },
    });
  })()
    .then(
      () => undefined,
      (error: unknown) => error ?? new Error("Fixture run threw a nullish value"),
    )
    .finally(restoreEnv);
  const runDirName = await publishedRunDirName(dataDir);
  const runDir = runDirName === undefined ? undefined : join(dataDir, runDirName);
  let status: EvalSampleStatus = "completed";
  if (runError !== undefined) {
    status =
      runDir !== undefined && existsSync(join(runDir, RUN_ARTIFACT_FILES.failure))
        ? "failed-final-synthesis"
        : "threw";
  }
  if (
    missKeys.length > 0 ||
    modelMissKeys.length > 0 ||
    (runError instanceof Error && /Replay state/iu.test(runError.message))
  ) {
    status = "incomplete";
  } else if (
    runError === undefined &&
    (input.llm === "live" || input.liveStages !== undefined) &&
    liveCalls === 0
  ) {
    status = "not-exercised";
  }
  const record: EvalSampleRecord = {
    fixture: input.fixture,
    sample: input.sample,
    status,
    ...(runDirName !== undefined ? { runDirName } : {}),
    durationMs: Math.round(performance.now() - startedAt),
    cassetteMisses: { count: missKeys.length, keys: missKeys },
    modelReplayMisses: {
      count: modelMissKeys.length,
      keys: modelMissKeys,
      errors: modelMissErrors,
    },
    modelCalls: { replayed: replayedCalls, live: liveCalls },
    tokens: { replayed: replayedTokens, live: liveTokens },
    ...(input.liveStages !== undefined
      ? {
          evaluation: {
            liveStage: input.liveStages,
            downstreamReasoning: "recorded" as const,
            sourceRequests: "cassette-only" as const,
          },
        }
      : {}),
    ...(replay.provider !== undefined ? { responseUsage: replay.provider.diagnostics() } : {}),
    ...(runError !== undefined
      ? { error: runError instanceof Error ? runError.message : String(runError) }
      : {}),
    ...(runError instanceof Error && runError.stack !== undefined
      ? { errorStack: errorStackWithMessage(runError, runError.stack) }
      : {}),
    ...(runError !== undefined &&
    missKeys.length === 0 &&
    modelMissKeys.length === 0 &&
    rawResponseContent !== undefined
      ? { rawResponseContent }
      : {}),
  };
  await writeFile(join(sampleDir, EVAL_SAMPLE_FILE), `${JSON.stringify(record, undefined, 2)}\n`);
  return { ...record, sampleDir, ...(runDir !== undefined ? { runDir } : {}) };
}

export async function runEvalBatch(input: {
  readonly root: string;
  readonly label: string;
  readonly fixtures: readonly string[];
  readonly samples: number;
  readonly runSample: (fixture: string, sample: string) => Promise<EvalSampleResult>;
}): Promise<0 | 1> {
  let exitCode: 0 | 1 = 0;
  for (const fixture of input.fixtures) {
    for (let sample = 1; sample <= input.samples; sample += 1) {
      // eslint-disable-next-line no-await-in-loop -- samples share process-level index overrides
      const result = await input.runSample(fixture, String(sample));
      if (result.status !== "completed") {
        exitCode = 1;
      }
      // eslint-disable-next-line no-await-in-loop -- preserve a summary after every sample
      await writeEvalSummary(input.root, input.label);
    }
  }
  return exitCode;
}

function addCount(metrics: Record<string, number>, key: string, by = 1): void {
  metrics[key] = (metrics[key] ?? 0) + by;
}

function stageMetrics(stages: readonly StageOutput[], metrics: Record<string, number>): void {
  for (const stage of stages) {
    addCount(metrics, `tokens.${stage.stage}`, stage.tokenEstimate);
    addCount(metrics, "tokens.total", stage.tokenEstimate);
    const reason = stage.stage === "final-synthesis" ? stage.repromptReason : undefined;
    const reportErrors = reason?.reportValidationErrors ?? [];
    if (reportErrors.some((error) => error.includes(LANGUAGE_GATE_ERROR))) {
      addCount(metrics, "repairs.researchLanguage");
    }
    if (reportErrors.some((error) => !error.includes(LANGUAGE_GATE_ERROR))) {
      addCount(metrics, "repairs.reportValidation");
    }
    if ((reason?.predictionErrors ?? []).length > 0) {
      addCount(metrics, "repairs.predictionErrors");
    }
  }
}

function reportMetrics(artifact: RunArtifact, metrics: Record<string, number>): void {
  const { report, sourceGaps } = artifact;
  sourceGapMetrics(sourceGaps, metrics);
  const relative: PredictionKind = "relative";
  metrics["predictions.count"] = report.predictions.length;
  metrics["predictions.relative"] = report.predictions.filter((p) => p.kind === relative).length;
  metrics["predictions.absolute"] = report.predictions.length - metrics["predictions.relative"];
  metrics["predictions.shortfall"] = report.predictionShortfall?.missingCount ?? 0;
  for (const prediction of report.predictions) {
    addCount(metrics, `predictions.kind.${prediction.kind}`);
  }
  const citable = [...report.keyFindings, ...report.predictions];
  if (citable.length > 0) {
    const cited = citable.filter((item) => knownSourceIds(report, item.sourceIds).length > 0);
    metrics["citations.coverage"] = cited.length / citable.length;
  }
  for (const gap of report.dataGaps) {
    addCount(metrics, `dataGaps.${readGapTriage(gap, sourceGaps, report.symbol)}`);
  }
}

function sourceGapMetrics(sourceGaps: readonly SourceGap[], metrics: Record<string, number>): void {
  for (const gap of sourceGaps) {
    addCount(metrics, `sourceGaps.${gap.cause ?? "unclassified"}`);
  }
}

function prunedMetrics(trace: unknown, metrics: Record<string, number>): void {
  const audit = isRecord(trace) ? trace.reportIntegrityAudit : undefined;
  const pruned = isRecord(audit) && Array.isArray(audit.pruned) ? audit.pruned : [];
  for (const item of pruned) {
    const location = isRecord(item) && typeof item.location === "string" ? item.location : "";
    addCount(metrics, `integrity.pruned.${location.replace(/\[\d+\]$/u, "") || "unknown"}`);
  }
}

function analyticsMetrics(analytics: Partial<RunAnalytics>, metrics: Record<string, number>): void {
  const integrity = analytics.reportIntegrity;
  if (integrity !== undefined) {
    metrics[`integrity.label.${integrity.label}`] = 1;
    metrics["integrity.prunedItems"] = integrity.prunedItemCount;
    for (const advisory of integrity.advisories ?? []) {
      addCount(metrics, `integrity.advisory.${advisory.code}`);
    }
  }
  for (const [code, count] of Object.entries(analytics.postSynthesisAudit?.byCode ?? {})) {
    metrics[`postSynthesisAudit.${code}`] = count;
  }
}

async function readSampleRecord(sampleDir: string): Promise<EvalSampleRecord | undefined> {
  const file = await readJsonFile(join(sampleDir, EVAL_SAMPLE_FILE));
  return file.status === "ok" ? (file.value as EvalSampleRecord) : undefined;
}

export async function extractSampleMetrics(
  fixture: string,
  sample: string,
  sampleDir: string,
): Promise<EvalSampleMetrics> {
  const record = await readSampleRecord(sampleDir);
  if (record === undefined) {
    return {
      fixture,
      sample,
      status: "incomplete",
      cassetteMissKeys: [],
      modelReplayMissKeys: [],
      metrics: { "status.incomplete": 1 },
      unavailable: METRIC_GROUPS,
    };
  }
  const metrics: Record<string, number> = {
    [`status.${record.status}`]: 1,
    durationMs: record.durationMs,
    cassetteMisses: record.cassetteMisses.count,
    modelReplayMisses: record.modelReplayMisses.count,
    "modelCalls.replayed": record.modelCalls.replayed,
    "modelCalls.live": record.modelCalls.live,
    "modelTokens.replayed": record.tokens.replayed,
    "modelTokens.live": record.tokens.live,
  };
  const available = new Set<MetricGroup>([
    "durationMs",
    "cassetteMisses",
    "modelReplayMisses",
    "modelCalls",
    "modelTokens",
  ]);
  if (record.runDirName !== undefined) {
    const runDir = join(sampleDir, "runs", record.runDirName);
    const stages = await readJsonFile(join(runDir, RUN_ARTIFACT_FILES.stages));
    if (stages.status === "ok" && Array.isArray(stages.value)) {
      stageMetrics(stages.value as StageOutput[], metrics);
      available.add("tokens").add("repairs");
    }
    const { artifact } = await loadRunArtifact(runDir);
    if (artifact !== undefined) {
      reportMetrics(artifact, metrics);
      available.add("predictions").add("citations").add("dataGaps").add("sourceGaps");
    } else {
      const gaps = await readJsonFile(join(runDir, RUN_ARTIFACT_FILES.sourceGaps));
      if (gaps.status === "ok") {
        sourceGapMetrics(readSourceGaps(gaps.value), metrics);
        available.add("sourceGaps");
      }
    }
    const analytics = await readAnalytics(runDir);
    const trace = await readJsonFile(join(runDir, RUN_ARTIFACT_FILES.trace));
    if (analytics.status === "ok" && trace.status === "ok") {
      analyticsMetrics(analytics.value as Partial<RunAnalytics>, metrics);
      prunedMetrics(trace.value, metrics);
      available.add("integrity").add("postSynthesisAudit");
    }
  }
  return {
    fixture: record.fixture,
    sample: record.sample,
    status: record.status,
    ...(record.evaluation !== undefined ? { evaluation: record.evaluation } : {}),
    cassetteMissKeys: record.cassetteMisses.keys,
    modelReplayMissKeys: record.modelReplayMisses.keys,
    metrics,
    unavailable: METRIC_GROUPS.filter((group) => !available.has(group)),
  };
}

async function childDirs(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

export async function writeEvalSummary(root: string, label: string): Promise<EvalSummary> {
  const labelDir = evalLabelDir(root, label);
  const samples: EvalSampleMetrics[] = [];
  for (const fixture of await childDirs(labelDir)) {
    for (const sample of await childDirs(join(labelDir, fixture))) {
      samples.push(await extractSampleMetrics(fixture, sample, join(labelDir, fixture, sample)));
    }
  }
  const summary = { label, samples };
  await writeFile(join(labelDir, SUMMARY_FILE), `${JSON.stringify(summary, undefined, 2)}\n`);
  return summary;
}

interface SynthesisSampleRecord {
  readonly status: "completed" | "failed";
  readonly durationMs: number;
  readonly modelCalls: EvalSampleRecord["modelCalls"];
  readonly tokens: EvalSampleRecord["tokens"];
  readonly modelReplayMisses: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
}

function isCounts(value: unknown): value is { readonly replayed: number; readonly live: number } {
  return isRecord(value) && typeof value.replayed === "number" && typeof value.live === "number";
}

function isSynthesisSampleRecord(value: unknown): value is SynthesisSampleRecord {
  return (
    isRecord(value) &&
    (value.status === "completed" || value.status === "failed") &&
    typeof value.durationMs === "number" &&
    isCounts(value.modelCalls) &&
    isCounts(value.tokens) &&
    Array.isArray(value.modelReplayMisses) &&
    isRecord(value.metrics) &&
    Object.values(value.metrics).every((metric) => typeof metric === "number")
  );
}

function isIntegrityAudit(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.reportIntegrity === "string" &&
    typeof value.prunedItemCount === "number" &&
    (value.advisories === undefined ||
      (Array.isArray(value.advisories) &&
        value.advisories.every(
          (advisory) => isRecord(advisory) && typeof advisory.code === "string",
        )))
  );
}

async function synthesisSampleMetrics(sampleDir: string): Promise<EvalSampleMetrics> {
  const sample = basename(sampleDir);
  const file = await readJsonFile(join(sampleDir, EVAL_SAMPLE_FILE));
  const record =
    file.status === "ok" && isSynthesisSampleRecord(file.value) ? file.value : undefined;
  if (record === undefined) {
    return {
      fixture: SYNTHESIS_SCOPE,
      sample,
      status: "incomplete",
      cassetteMissKeys: [],
      modelReplayMissKeys: [],
      metrics: { "status.incomplete": 1 },
      unavailable: METRIC_GROUPS,
    };
  }
  const status = record.status === "failed" ? "failed-final-synthesis" : record.status;
  const metrics: Record<string, number> = {
    [`status.${status}`]: 1,
    durationMs: record.durationMs,
    modelReplayMisses: record.modelReplayMisses.length,
    "modelCalls.replayed": record.modelCalls.replayed,
    "modelCalls.live": record.modelCalls.live,
    "modelTokens.replayed": record.tokens.replayed,
    "modelTokens.live": record.tokens.live,
  };
  for (const [key, value] of Object.entries(record.metrics)) {
    metrics[`synthesis.${key}`] = value;
  }
  const available = new Set<MetricGroup>([
    "durationMs",
    "modelReplayMisses",
    "modelCalls",
    "modelTokens",
    "synthesis",
  ]);
  const { artifact } = await loadRunArtifact(sampleDir);
  if (artifact !== undefined) {
    reportMetrics(artifact, metrics);
    available.add("predictions").add("citations").add("dataGaps");
  }
  const validation = await readJsonFile(join(sampleDir, "validation.json"));
  const audit =
    validation.status === "ok" && isRecord(validation.value)
      ? validation.value.integrity
      : undefined;
  if (isIntegrityAudit(audit)) {
    analyticsMetrics(
      {
        reportIntegrity: {
          label: audit.reportIntegrity,
          prunedItemCount: audit.prunedItemCount,
          advisories: audit.advisories,
        },
      } as Partial<RunAnalytics>,
      metrics,
    );
    prunedMetrics({ reportIntegrityAudit: audit }, metrics);
    available.add("integrity");
  }
  return {
    fixture: SYNTHESIS_SCOPE,
    sample,
    status,
    cassetteMissKeys: [],
    modelReplayMissKeys: record.modelReplayMisses,
    metrics,
    unavailable: METRIC_GROUPS.filter((group) => !available.has(group)),
  };
}

export async function readEvalSummary(root: string, label: string): Promise<EvalSummary> {
  const labelDir = evalLabelDir(root, label);
  const summary = JSON.parse(await readFile(join(labelDir, SUMMARY_FILE), "utf8")) as {
    readonly scope?: string;
    readonly samples: readonly unknown[];
  };
  if (summary.scope !== SYNTHESIS_SCOPE) {
    return summary as EvalSummary;
  }
  // Summary dirs are absolute at write time; resolve them under this label so moved labels still read.
  const samples = [];
  for (const { dir } of summary.samples as readonly { dir: string }[]) {
    // oxlint-disable-next-line no-await-in-loop -- small, ordered sample list
    samples.push(await synthesisSampleMetrics(join(labelDir, pathSegment(basename(dir)))));
  }
  return { label, scope: SYNTHESIS_SCOPE, samples };
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// Absent in a sample that measured the group = 0; an unavailable group or a ratio with no
// Denominator is skipped and n drops, so a failed run cannot read as an improvement.
function sampleValue(sample: EvalSampleMetrics, metric: string): number | undefined {
  const group = metric.split(".")[0] as MetricGroup;
  if (sample.unavailable.includes(group)) {
    return undefined;
  }
  return sample.metrics[metric] ?? (metric === "citations.coverage" ? undefined : 0);
}

function cell(samples: readonly EvalSampleMetrics[], metric: string): string {
  if (samples.length === 0) {
    return "—";
  }
  const values = samples
    .map((sample) => sampleValue(sample, metric))
    .filter((value) => value !== undefined);
  if (values.length === 0) {
    return `— (n=0/${String(samples.length)})`;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const range = `[${formatNumber(Math.min(...values))}–${formatNumber(Math.max(...values))}]`;
  const n =
    values.length < samples.length ? ` (n=${String(values.length)}/${String(samples.length)})` : "";
  return `${formatNumber(mean)} ${range}${n}`;
}

export function formatEvalCompare(base: EvalSummary, next: EvalSummary): string {
  if (base.scope !== next.scope) {
    throw new Error(
      `Cannot compare eval labels of different scopes: ${base.label} (${base.scope ?? "fixtures"}) vs ${next.label} (${next.scope ?? "fixtures"})`,
    );
  }
  const fixtures = [
    ...new Set([...base.samples, ...next.samples].map((s) => s.fixture)),
  ].toSorted();
  const lines = [
    `| fixture | metric | ${base.label} mean [range] | ${next.label} mean [range] |`,
    "| --- | --- | --- | --- |",
  ];
  for (const fixture of fixtures) {
    const baseSamples = base.samples.filter((sample) => sample.fixture === fixture);
    const nextSamples = next.samples.filter((sample) => sample.fixture === fixture);
    const metrics = [
      ...new Set([...baseSamples, ...nextSamples].flatMap((sample) => Object.keys(sample.metrics))),
    ].toSorted();
    for (const metric of metrics) {
      lines.push(
        `| ${fixture} | ${metric} | ${cell(baseSamples, metric)} | ${cell(nextSamples, metric)} |`,
      );
    }
  }
  const selectedStages = [
    ...new Set(
      [...base.samples, ...next.samples].flatMap((sample) =>
        sample.evaluation === undefined ? [] : [sample.evaluation.liveStage],
      ),
    ),
  ];
  const scope =
    selectedStages.length === 0
      ? ""
      : `Selected-stage evaluation (${selectedStages.join(", ")}): other model reasoning stays recorded; source requests are cassette-only.\n\n`;
  return `${scope}${lines.join("\n")}\n`;
}

export async function unreplayableFixtureError(fixture: string): Promise<string | undefined> {
  const { meta } = await loadFixture(fixture);
  const { replayClassification } = meta;
  return replayClassification === "incomplete"
    ? `Fixture ${fixture} is not replayable: replayClassification "${replayClassification}"`
    : undefined;
}

function boundedStageCalls(stage: LiveStage, config: AppConfig): number {
  switch (stage) {
    case "final-synthesis": {
      return MAX_FINAL_SYNTHESIS_CALLS;
    }
    case "web-gather": {
      return config.webGatherOptions.maxRounds;
    }
    case "evidence-request": {
      return config.evidenceRequestOptions.maxRounds;
    }
    case "forecast-disagreement": {
      return config.forecastDisagreementOptions?.challengerModels.length ?? 0;
    }
    default: {
      return 1;
    }
  }
}

export async function liveTokenEstimate(
  fixture: string,
  liveStages?: LiveStage,
): Promise<{
  readonly recorded: number;
  readonly perRun: number;
  readonly boundedCalls?: number;
  readonly observedCalls?: number;
  readonly maxInputTokens?: number;
  readonly expectedPerRun?: number;
}> {
  if (liveStages !== undefined) {
    validateLiveStage(liveStages);
  }
  const { llmCassette, meta } = await loadFixture(fixture);
  const entries = Object.entries(llmCassette.entries)
    .filter(([key]) => liveStages === undefined || key.startsWith(`${liveStages}|`))
    .flatMap(([, stageEntries]) => stageEntries);
  const recorded = entries.reduce((sum, entry) => sum + entry.tokenEstimate, 0);
  if (liveStages === undefined) {
    return { recorded, perRun: Math.max(recorded, LIVE_DEEP_RUN_TOKENS) };
  }
  const root = await mkdtemp(join(tmpdir(), "market-bot-eval-estimate-"));
  const restoreEnv = disableIndexAccess();
  let maxInputTokens = 0;
  let observedCalls = 0;
  try {
    const replay = makeReplayProvider(llmCassette);
    await runFixture(fixture, {
      llm: "replay",
      dataDir: join(root, "runs"),
      provider: makeReplayProvider(
        llmCassette,
        {
          name: "offline-prompt-measurement",
          generate: (request) => {
            observedCalls += 1;
            maxInputTokens = Math.max(
              maxInputTokens,
              Math.ceil(
                request.messages.reduce((sum, message) => sum + message.content.length, 0) / 4,
              ),
            );
            return replay.generate(request);
          },
        },
        liveStages,
      ),
    });
  } finally {
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
  const config = createFixtureConfig(meta, join(root, "runs"));
  const boundedCalls = boundedStageCalls(liveStages, config);
  const callTokens = Math.max(
    LIVE_STAGE_CALL_TOKENS,
    maxInputTokens + Math.max(0, ...entries.map((entry) => Math.ceil(entry.content.length / 4))),
    ...entries.map((entry) => entry.tokenEstimate),
  );
  return {
    recorded,
    perRun: Math.max(boundedCalls, observedCalls) * Math.ceil(1.25 * callTokens),
    boundedCalls: Math.max(boundedCalls, observedCalls),
    observedCalls,
    maxInputTokens,
    expectedPerRun: observedCalls * callTokens,
  };
}
