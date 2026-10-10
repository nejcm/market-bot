import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PredictionKind, SourceGap } from "../../../src/domain/types";
import { isRecord } from "../../../src/guards";
import type { ModelProvider } from "../../../src/model/types";
import { knownSourceIds } from "../../../src/report/markdown-primitives";
import { readGapTriage } from "../../../src/report/gap-triage";
import type { RunAnalytics } from "../../../src/research/run-analytics";
import type { StageOutput } from "../../../src/research/final-synthesis";
import { readAnalytics } from "../../../src/run-artifact-analytics-reader";
import { readJsonFile } from "../../../src/run-artifact-json-reader";
import { RUN_ARTIFACT_FILES } from "../../../src/run-artifact-layout";
import { readSourceGaps } from "../../../src/run-artifact-report-reader";
import { loadRunArtifact, type RunArtifact } from "../../../src/run-artifacts";
import type { FetchLike } from "../../../src/sources/types";
import { makeReplayFetch } from "./data-cassette";
import { loadFixture, runFixture } from "./index";

export const EVALS_ROOT = join(import.meta.dir, "../../../data/evals");
const EVAL_SAMPLE_FILE = "eval-sample.json";
const SUMMARY_FILE = "summary.json";
const CASSETTE_MISS_PREFIX = "Fixture data cassette miss: ";
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
// Same predicate the final-synthesis language repair prompt uses to pick gate errors.
const LANGUAGE_GATE_ERROR = "trade-action language";
// AGENTS.md: a deep live equity run is ~438k tokens; synthetic cassettes record far less.
const LIVE_DEEP_RUN_TOKENS = 438_000;
// Metric groups are keyed by the first dotted segment; an unavailable group is excluded from compare.
const METRIC_GROUPS = [
  "durationMs",
  "cassetteMisses",
  "tokens",
  "repairs",
  "predictions",
  "citations",
  "dataGaps",
  "sourceGaps",
  "integrity",
  "postSynthesisAudit",
] as const;
type MetricGroup = (typeof METRIC_GROUPS)[number];

type EvalSampleStatus = "completed" | "failed-final-synthesis" | "threw";

interface EvalSampleRecord {
  readonly fixture: string;
  readonly sample: string;
  readonly status: EvalSampleStatus;
  readonly runDirName?: string;
  readonly durationMs: number;
  readonly cassetteMisses: { readonly count: number; readonly keys: readonly string[] };
  readonly error?: string;
}

interface EvalSampleMetrics {
  readonly fixture: string;
  readonly sample: string;
  readonly status: EvalSampleStatus | "incomplete";
  readonly cassetteMissKeys: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly unavailable: readonly MetricGroup[];
}

interface EvalSummary {
  readonly label: string;
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
  return join(evalLabelDir(root, label), pathSegment(fixture), pathSegment(sample));
}

export function countCassetteMisses(inner: FetchLike, keys: string[]): FetchLike {
  return async (input, init) => {
    try {
      return await inner(input, init);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(CASSETTE_MISS_PREFIX)) {
        keys.push(error.message.slice(CASSETTE_MISS_PREFIX.length));
      }
      throw error;
    }
  };
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
  const fetchImpl = countCassetteMisses(
    input.fetchImpl ?? makeReplayFetch(fixture.dataCassette, fixture.dir),
    missKeys,
  );
  const startedAt = performance.now();
  const restoreEnv = disableIndexAccess();
  const runError = await runFixture(input.fixture, {
    llm: input.llm,
    dataDir,
    keepDataDir: true,
    fetchImpl,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
  })
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
  const record: EvalSampleRecord = {
    fixture: input.fixture,
    sample: input.sample,
    status,
    ...(runDirName !== undefined ? { runDirName } : {}),
    durationMs: Math.round(performance.now() - startedAt),
    cassetteMisses: { count: missKeys.length, keys: missKeys },
    ...(runError !== undefined
      ? { error: runError instanceof Error ? runError.message : String(runError) }
      : {}),
  };
  await writeFile(join(sampleDir, EVAL_SAMPLE_FILE), `${JSON.stringify(record, undefined, 2)}\n`);
  return { ...record, sampleDir, ...(runDir !== undefined ? { runDir } : {}) };
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
      metrics: { "status.incomplete": 1 },
      unavailable: METRIC_GROUPS,
    };
  }
  const metrics: Record<string, number> = {
    [`status.${record.status}`]: 1,
    durationMs: record.durationMs,
    cassetteMisses: record.cassetteMisses.count,
  };
  const available = new Set<MetricGroup>(["durationMs", "cassetteMisses"]);
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
    cassetteMissKeys: record.cassetteMisses.keys,
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

export async function readEvalSummary(root: string, label: string): Promise<EvalSummary> {
  return JSON.parse(
    await readFile(join(evalLabelDir(root, label), SUMMARY_FILE), "utf8"),
  ) as EvalSummary;
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
  return `${lines.join("\n")}\n`;
}

export async function liveTokenEstimate(
  fixture: string,
): Promise<{ readonly recorded: number; readonly perRun: number }> {
  const { llmCassette } = await loadFixture(fixture);
  const recorded = Object.values(llmCassette.entries)
    .flat()
    .reduce((sum, entry) => sum + entry.tokenEstimate, 0);
  return { recorded, perRun: Math.max(recorded, LIVE_DEEP_RUN_TOKENS) };
}
