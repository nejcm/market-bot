import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchReport, RunTrace } from "../../src/domain/types";
import { isRecord, readNumber, readString } from "../../src/guards";
import { validateResearchReport } from "../../src/report/schema";
import type { StageOutput } from "../../src/research/final-synthesis";
import {
  deepEquityVariantEvaluationMetrics,
  type DeepEquityPipelineVariant,
  type DeepEquityVariantEvaluationMetrics,
} from "./deep-equity-evaluation";
import { DEEP_EQUITY_EVALUATION_METRICS_FILE } from "./run-fixtures";

export interface ResumableEvaluationVariant {
  readonly runDir: string;
  readonly report: ResearchReport;
  readonly trace: RunTrace;
  /** Optional so run traces written before quick-model recording still resume. */
  readonly quickModel?: string;
  readonly stageOutputs: readonly StageOutput[];
  readonly metrics: DeepEquityVariantEvaluationMetrics;
}

export interface ResumableEvaluationPair {
  readonly scenario: string;
  readonly repetition: number;
  readonly variants: Readonly<Record<DeepEquityPipelineVariant, ResumableEvaluationVariant>>;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function directoryNames(path: string): Promise<readonly string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

function readStages(value: unknown, path: string): readonly StageOutput[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        isRecord(entry) &&
        readString(entry, "stage") !== undefined &&
        typeof entry.content === "string" &&
        readNumber(entry, "tokenEstimate") !== undefined,
    )
  ) {
    throw new Error(`resume stages artifact is malformed: ${path}`);
  }
  return value as readonly StageOutput[];
}

function readTrace(value: unknown, path: string): RunTrace {
  if (
    !isRecord(value) ||
    readNumber(value, "tokenEstimate") === undefined ||
    readString(value, "synthesisModel") === undefined
  ) {
    throw new Error(`resume trace artifact is malformed: ${path}`);
  }
  return value as unknown as RunTrace;
}

async function readPromptTokenEstimate(runDir: string): Promise<number | undefined> {
  try {
    const value = await readJson(join(runDir, DEEP_EQUITY_EVALUATION_METRICS_FILE));
    if (!isRecord(value)) {
      return undefined;
    }
    const estimate = readNumber(value, "reasoningPromptTokenEstimate");
    return estimate !== undefined && estimate > 0 ? estimate : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function loadVariant(
  repetitionDir: string,
  variant: DeepEquityPipelineVariant,
): Promise<ResumableEvaluationVariant> {
  const variantDir = join(repetitionDir, variant);
  const runDirs = await directoryNames(variantDir);
  if (runDirs.length !== 1) {
    throw new Error(
      `resume expected exactly one ${variant} run under ${variantDir}; found ${String(runDirs.length)}`,
    );
  }
  const runDir = join(variantDir, runDirs[0]!);
  const reportPath = join(runDir, "report.json");
  const tracePath = join(runDir, "trace.json");
  const stagesPath = join(runDir, "stages.json");
  const reportValue = await readJson(reportPath);
  if (!isRecord(reportValue)) {
    throw new Error(`resume report artifact is malformed: ${reportPath}`);
  }
  const report = validateResearchReport(reportValue as unknown as ResearchReport);
  const traceValue = await readJson(tracePath);
  const trace = readTrace(traceValue, tracePath);
  const quickModel = isRecord(traceValue) ? readString(traceValue, "quickModel") : undefined;
  const stageOutputs = readStages(await readJson(stagesPath), stagesPath);
  const reasoningPromptTokenEstimate = await readPromptTokenEstimate(runDir);
  return {
    runDir,
    report,
    trace,
    ...(quickModel !== undefined ? { quickModel } : {}),
    stageOutputs,
    metrics: deepEquityVariantEvaluationMetrics(
      { report, trace, stageOutputs },
      reasoningPromptTokenEstimate,
    ),
  };
}

export async function discoverResumableEvaluationPairs(
  root: string,
): Promise<readonly ResumableEvaluationPair[]> {
  const pairs: ResumableEvaluationPair[] = [];
  for (const scenario of await directoryNames(root)) {
    const scenarioDir = join(root, scenario);
    for (const repetitionName of await directoryNames(scenarioDir)) {
      const match = /^repetition-(\d+)$/u.exec(repetitionName);
      if (match === null) {
        continue;
      }
      const repetition = Number(match[1]);
      const repetitionDir = join(scenarioDir, repetitionName);
      try {
        pairs.push({
          scenario,
          repetition,
          variants: {
            legacy: await loadVariant(repetitionDir, "legacy"),
            simplified: await loadVariant(repetitionDir, "simplified"),
          },
        });
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        ) {
          continue;
        }
        throw error;
      }
    }
  }
  return pairs.toSorted(
    (left, right) =>
      left.scenario.localeCompare(right.scenario) || left.repetition - right.repetition,
  );
}
