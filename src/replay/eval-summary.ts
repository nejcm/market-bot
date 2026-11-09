import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { PredictionKind } from "../domain/prediction";
import type { SourceGap } from "../domain/sources";
import { isRecord } from "../guards";
import { USAGE_FIELDS } from "../model/types";
import { readGapTriage } from "../report/gap-triage";
import { knownSourceIds } from "../report/markdown-primitives";
import type { StageOutput } from "../research/final-synthesis";
import { CATALOG_FIGURE_HINT, referenceMetricSections } from "../research/metric-references";
import type { RunAnalytics } from "../research/run-analytics";
import { rollupStageUsage, type StageUsageRollup } from "../research/stage-usage";
import { readAnalytics } from "../run-artifact-analytics-reader";
import type { MetricSection } from "../sources/extended-evidence/metric-engine";
import { readJsonFile } from "../run-artifact-json-reader";
import { RUN_ARTIFACT_FILES } from "../run-artifact-layout";
import { readSourceGaps } from "../run-artifact-report-reader";
import { loadRunArtifact, type RunArtifact } from "../run-artifacts";
import { synthesisFigureCounts } from "./eval-cases";
import { loadSynthesisReplayInput } from "./synthesis-input";
import type { LiveStage, ReplayProvider } from "./llm-cassette";

export const EVAL_SAMPLE_FILE = "eval-sample.json";
const SUMMARY_FILE = "summary.json";
const SYNTHESIS_SCOPE = "final-synthesis-only";
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
// Same predicate the final-synthesis language repair prompt uses to pick gate errors.
const LANGUAGE_GATE_ERROR = "trade-action language";
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

export type EvalSampleStatus =
  | "completed"
  | "failed-final-synthesis"
  | "threw"
  | "incomplete"
  | "not-exercised";

export interface EvalSampleRecord {
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

export function pathSegment(segment: string): string {
  if (!PATH_SEGMENT.test(segment)) {
    throw new Error(`Eval path segment must match ${PATH_SEGMENT.source}: ${segment}`);
  }
  return segment;
}

export function evalLabelDir(root: string, label: string): string {
  return join(resolve(root), pathSegment(label));
}

function addCount(metrics: Record<string, number>, key: string, by = 1): void {
  metrics[key] = (metrics[key] ?? 0) + by;
}

function stageMetrics(stages: readonly StageOutput[], metrics: Record<string, number>): void {
  for (const stage of stages) {
    addCount(metrics, `tokens.${stage.stage}`, stage.tokenEstimate);
    addCount(metrics, "tokens.total", stage.tokenEstimate);
    const reason = stage.stage === "final-synthesis" ? stage.repromptReason : undefined;
    const reportErrors = (reason?.reportValidationErrors ?? []).filter(
      (error) => !error.startsWith(CATALOG_FIGURE_HINT),
    );
    if (reportErrors.some((error) => error.includes(LANGUAGE_GATE_ERROR))) {
      addCount(metrics, "repairs.researchLanguage");
    }
    if (reportErrors.some((error) => !error.includes(LANGUAGE_GATE_ERROR))) {
      addCount(metrics, "repairs.reportValidation");
    }
    if (reason?.catalogFigureHints !== undefined) {
      addCount(metrics, "repairs.catalogFigureHints", reason.catalogFigureHints);
    }
    if ((reason?.predictionErrors ?? []).length > 0) {
      addCount(metrics, "repairs.predictionErrors");
    }
  }
}

function usageMetrics(rollups: readonly StageUsageRollup[], metrics: Record<string, number>): void {
  for (const row of rollups) {
    for (const field of USAGE_FIELDS) {
      const count = row[field];
      // An unreported count stays out of the summary so a mean never averages in a fake 0.
      if (count !== "unknown") {
        addCount(metrics, `tokens.${row.stage}.${field}`, count);
      }
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
    const webFigure = isRecord(item) && isRecord(item.webFigure) ? item.webFigure : undefined;
    if (typeof webFigure?.reason === "string") {
      addCount(metrics, `integrity.webFigure.${webFigure.reason}`);
    }
  }
}

function analyticsMetrics(analytics: Partial<RunAnalytics>, metrics: Record<string, number>): void {
  const integrity = analytics.reportIntegrity;
  if (integrity !== undefined) {
    metrics[`integrity.label.${integrity.label}`] = 1;
    metrics["integrity.prunedItems"] = integrity.prunedItemCount;
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
    const analytics = await readAnalytics(runDir);
    if (stages.status === "ok" && Array.isArray(stages.value)) {
      stageMetrics(stages.value as StageOutput[], metrics);
      // The provider-seam ledger also sees calls with no stage output; a failed run keeps it in failure.json.
      const failure = await readJsonFile(join(runDir, RUN_ARTIFACT_FILES.failure));
      const ledger =
        (analytics.status === "ok"
          ? (analytics.value as Partial<RunAnalytics>).runShape?.usageByStage
          : undefined) ??
        (failure.status === "ok" && isRecord(failure.value) && isRecord(failure.value.cost)
          ? (failure.value.cost.usageByStage as readonly StageUsageRollup[] | undefined)
          : undefined);
      usageMetrics(ledger ?? rollupStageUsage(stages.value as StageOutput[]), metrics);
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
    // oxlint-disable-next-line no-await-in-loop -- small, ordered fixture list
    for (const sample of await childDirs(join(labelDir, fixture))) {
      // oxlint-disable-next-line no-await-in-loop -- small, ordered sample list
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
  readonly input?: unknown;
}

// The catalog assembly prefixed against; undefined when the sample's capture is gone or unreadable.
async function sampleMetricCatalog(
  record: SynthesisSampleRecord,
  catalogs: Map<string, Promise<readonly MetricSection[] | undefined>>,
): Promise<readonly MetricSection[] | undefined> {
  if (typeof record.input !== "string") {
    return undefined;
  }
  const cached =
    catalogs.get(record.input) ??
    loadSynthesisReplayInput(record.input).then(
      ({ input }) => referenceMetricSections(input.collectedSources),
      () => undefined,
    );
  catalogs.set(record.input, cached);
  return cached;
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
    typeof value.prunedItemCount === "number"
  );
}

async function synthesisSampleMetrics(
  sampleDir: string,
  catalogs: Map<string, Promise<readonly MetricSection[] | undefined>>,
): Promise<EvalSampleMetrics> {
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
  // Derived here, not at write time, so samples from an older commit compare on the same figures.
  const synthesis = await readJsonFile(join(sampleDir, "synthesis.json"));
  const accepted =
    synthesis.status === "ok" &&
    isRecord(synthesis.value) &&
    Array.isArray(synthesis.value.stageOutputs)
      ? synthesis.value.stageOutputs.findLast(
          (row: unknown) => isRecord(row) && row.stage === "final-synthesis",
        )
      : undefined;
  const available = new Set<MetricGroup>([
    "durationMs",
    "modelReplayMisses",
    "modelCalls",
    "modelTokens",
    "synthesis",
  ]);
  if (synthesis.status === "ok" && isRecord(synthesis.value)) {
    const { stageOutputs, regeneratedAnalysis } = synthesis.value;
    const { attemptedCalls, completedCalls } = file.value as Record<string, unknown>;
    // Only synthesis requests are logged before their response, so an unanswered request is a synthesis call.
    const unanswered =
      typeof attemptedCalls === "number" && typeof completedCalls === "number"
        ? Math.max(0, attemptedCalls - completedCalls)
        : 0;
    const calls = [
      ...(Array.isArray(regeneratedAnalysis) ? regeneratedAnalysis : []),
      ...(Array.isArray(stageOutputs) ? stageOutputs : []),
      ...Array.from({ length: unanswered }, () => ({
        stage: "final-synthesis",
        status: "error" as const,
        usage: "unknown" as const,
      })),
    ] as StageOutput[];
    usageMetrics(rollupStageUsage(calls), metrics);
    available.add("tokens");
  }
  if (isRecord(accepted) && typeof accepted.content === "string") {
    const counts = synthesisFigureCounts(
      accepted.content,
      await sampleMetricCatalog(record, catalogs),
    );
    if (counts.metricReferences !== undefined) {
      metrics["synthesis.metricReferences"] = counts.metricReferences;
    }
    metrics["synthesis.typedFigures"] = counts.typedFigures;
    metrics["synthesis.figureQuotes"] = counts.figureQuotes;
  }
  const { defects } = file.value as { readonly defects?: unknown };
  if (isRecord(defects) && Array.isArray(defects.unmatchedFigures)) {
    metrics["synthesis.unmatchedFigures"] = defects.unmatchedFigures.reduce(
      (sum: number, row: unknown) =>
        sum + (isRecord(row) && Array.isArray(row.figures) ? row.figures.length : 0),
      0,
    );
  }
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
        },
      } as Partial<RunAnalytics>,
      metrics,
    );
    prunedMetrics({ reportIntegrityAudit: audit }, metrics);
    available.add("integrity");
  }
  const warnings =
    validation.status === "ok" && isRecord(validation.value)
      ? validation.value.warnings
      : undefined;
  if (Array.isArray(warnings)) {
    for (const warning of warnings) {
      if (isRecord(warning) && typeof warning.code === "string") {
        addCount(metrics, `postSynthesisAudit.${warning.code}`);
      }
    }
    available.add("postSynthesisAudit");
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
  const catalogs = new Map<string, Promise<readonly MetricSection[] | undefined>>();
  for (const { dir } of summary.samples as readonly { dir: string }[]) {
    const sampleDir = join(labelDir, pathSegment(basename(dir)));
    // oxlint-disable-next-line no-await-in-loop -- small, ordered sample list
    samples.push(await synthesisSampleMetrics(sampleDir, catalogs));
  }
  return { label, scope: SYNTHESIS_SCOPE, samples };
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// Read only from an accepted report, so absence means unmeasured, never zero.
const MEASURED_ONLY = new Set([
  "citations.coverage",
  "synthesis.metricReferences",
  "synthesis.typedFigures",
  "synthesis.unmatchedFigures",
]);

// Absent in a sample that measured the group = 0; an unavailable group or a measured-only metric
// Is skipped and n drops, so a failed run cannot read as an improvement.
function sampleValue(sample: EvalSampleMetrics, metric: string): number | undefined {
  const group = metric.split(".")[0] as MetricGroup;
  if (sample.unavailable.includes(group)) {
    return undefined;
  }
  return sample.metrics[metric] ?? (isMeasuredOnly(metric) ? undefined : 0);
}

function isMeasuredOnly(metric: string): boolean {
  const usageField = metric.startsWith("tokens.") ? metric.split(".").at(-1) : undefined;
  return MEASURED_ONLY.has(metric) || USAGE_FIELDS.some((field) => field === usageField);
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

// Older labels' stored summaries still carry these; read as 0 on newer labels they fake a drop.
function isRetiredMetric(metric: string): boolean {
  return metric.startsWith("integrity.advisory.");
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
    ]
      .filter((metric) => !isRetiredMetric(metric))
      .toSorted();
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
