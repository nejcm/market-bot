import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchReport, RunTrace } from "../../src/domain/types";
import {
  loadFixture,
  runFixture,
  type FixtureDataRequest,
  type RunFixtureResult,
} from "./run-fixtures";
import { makeReplayProvider } from "./run-fixtures/llm-cassette";
import {
  captureProvider,
  modelCallTotals,
  type CapturedModelCall,
  type ModelCallTotals,
} from "./model-call-capture";

export {
  captureProvider,
  modelCallTotals,
  type CapturedModelCall,
  type ModelCallTotals,
} from "./model-call-capture";

export const DEEP_EQUITY_LEGACY_BASELINE_PATH = join(
  import.meta.dir,
  "..",
  "baselines",
  "deep-equity-legacy-pipeline.json",
);

export const DEEP_EQUITY_BASELINE_FIXTURES = [
  "equity-aapl-deep",
  "equity-nbis-deep",
  "equity-fpi-quarterly",
  "equity-fpi-ifrs-semiannual",
  "equity-analysis-comprehensive",
  "equity-analysis-estimated-suppressed",
] as const;

interface RequestCount {
  readonly provider: string;
  readonly method: string;
  readonly urlShape: string;
  readonly count: number;
}

interface DeepEquityFixtureBaseline {
  readonly fixture: string;
  readonly modelStages: readonly CapturedModelCall[];
  readonly modelCallTotals: ModelCallTotals;
  readonly requestCounts: readonly RequestCount[];
  readonly normalizedFiles: readonly string[];
  readonly integrityPruning: {
    readonly reportIntegrity: string;
    readonly researchQuality: string;
    readonly prunedItemCount: number;
    readonly advisoryWarningCount: number;
    readonly prunedLocations: readonly string[];
  };
  readonly validation: {
    readonly validPredictionCount: number;
    readonly validCitationReferenceCount: number;
    readonly distinctValidCitedSourceCount: number;
    readonly reportSourceCount: number;
  };
}

export interface DeepEquityLegacyBaseline {
  readonly version: 1;
  readonly description: string;
  readonly pipelineVariant: "legacy";
  readonly fixtures: readonly DeepEquityFixtureBaseline[];
}

function pathShape(pathname: string): string {
  const segments = pathname.split("/");
  return segments
    .map((segment, index) => {
      const previous = segments[index - 1];
      if (previous === "chart") {
        return ":symbol";
      }
      if (/^CIK\d{6,}\.json$/u.test(segment)) {
        return ":cik.json";
      }
      return /^(?:\d[\d-]{5,}|[a-f0-9]{16,})$/iu.test(segment) ? ":id" : segment;
    })
    .join("/");
}

function requestShape(request: FixtureDataRequest): Omit<RequestCount, "count"> {
  const url = new URL(request.url);
  const queryKeys = [...new Set(url.searchParams.keys())].toSorted();
  return {
    provider: url.hostname,
    method: request.method,
    urlShape: `${pathShape(url.pathname)}${queryKeys.length > 0 ? `?${queryKeys.join("&")}` : ""}`,
  };
}

function requestCounts(requests: readonly FixtureDataRequest[]): readonly RequestCount[] {
  const counts = new Map<string, RequestCount>();
  for (const request of requests) {
    const shape = requestShape(request);
    const key = `${shape.provider}\n${shape.method}\n${shape.urlShape}`;
    const current = counts.get(key);
    counts.set(key, { ...shape, count: (current?.count ?? 0) + 1 });
  }
  return [...counts.values()].toSorted((left, right) => {
    const provider = left.provider.localeCompare(right.provider);
    if (provider !== 0) {
      return provider;
    }
    const method = left.method.localeCompare(right.method);
    return method !== 0 ? method : left.urlShape.localeCompare(right.urlShape);
  });
}

function citationReferences(value: unknown, references: string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      citationReferences(item, references);
    }
    return references;
  }
  if (value === null || typeof value !== "object") {
    return references;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "sourceIds" && Array.isArray(item)) {
      references.push(
        ...item.filter((sourceId): sourceId is string => typeof sourceId === "string"),
      );
      continue;
    }
    citationReferences(item, references);
  }
  return references;
}

function integrityBaseline(trace: RunTrace): DeepEquityFixtureBaseline["integrityPruning"] {
  const audit = trace.reportIntegrityAudit;
  if (audit === undefined) {
    throw new Error("deep-equity baseline requires report integrity audit telemetry");
  }
  return {
    reportIntegrity: audit.reportIntegrity,
    researchQuality: audit.researchQuality,
    prunedItemCount: audit.prunedItemCount,
    advisoryWarningCount: audit.advisoryWarningCount,
    prunedLocations: audit.pruned.map((item) => item.location),
  };
}

function validationBaseline(report: ResearchReport): DeepEquityFixtureBaseline["validation"] {
  const references = citationReferences(report);
  return {
    validPredictionCount: report.predictions.length,
    validCitationReferenceCount: references.length,
    distinctValidCitedSourceCount: new Set(references).size,
    reportSourceCount: report.sources.length,
  };
}

export function orderedModelStages(
  result: RunFixtureResult,
  captured: readonly CapturedModelCall[],
): readonly CapturedModelCall[] {
  const byStage = new Map<string, CapturedModelCall[]>();
  for (const call of captured) {
    byStage.set(call.stage, [...(byStage.get(call.stage) ?? []), call]);
  }
  return result.stageOutputs.map((output, index) => {
    const [call, ...remaining] = byStage.get(output.stage) ?? [];
    if (call === undefined) {
      throw new Error(`deep-equity baseline did not capture prompt for ${output.stage}`);
    }
    byStage.set(output.stage, remaining);
    return { ...call, order: index + 1 };
  });
}

async function measureFixture(fixtureName: string): Promise<DeepEquityFixtureBaseline> {
  const fixture = await loadFixture(fixtureName);
  const modelCalls: CapturedModelCall[] = [];
  const dataRequests: FixtureDataRequest[] = [];
  const result: RunFixtureResult = await runFixture(fixtureName, {
    llm: "replay",
    provider: captureProvider(makeReplayProvider(fixture.llmCassette), modelCalls),
    onDataRequest: (request) => dataRequests.push(request),
  });
  try {
    const normalizedFiles = await readdir(join(result.artifacts.runDir, "normalized"));
    return {
      fixture: fixtureName,
      modelStages: orderedModelStages(result, modelCalls),
      modelCallTotals: modelCallTotals(modelCalls),
      requestCounts: requestCounts(dataRequests),
      normalizedFiles: normalizedFiles.filter((file) => file.endsWith(".json")).toSorted(),
      integrityPruning: integrityBaseline(result.trace),
      validation: validationBaseline(result.report),
    };
  } finally {
    await result.cleanup();
  }
}

export async function measureDeepEquityLegacyBaseline(): Promise<DeepEquityLegacyBaseline> {
  const fixtures: DeepEquityFixtureBaseline[] = [];
  for (const fixture of DEEP_EQUITY_BASELINE_FIXTURES) {
    fixtures.push(await measureFixture(fixture));
  }
  return {
    version: 1,
    description:
      "Regenerable legacy deep-equity pipeline baseline from unchanged fixed-data and LLM cassettes.",
    pipelineVariant: "legacy",
    fixtures,
  };
}

export async function readDeepEquityLegacyBaseline(): Promise<DeepEquityLegacyBaseline> {
  const content = await readFile(DEEP_EQUITY_LEGACY_BASELINE_PATH, "utf8");
  return JSON.parse(content) as DeepEquityLegacyBaseline;
}

export interface DeepEquitySimplifiedCallBudget {
  readonly fixture: string;
  readonly coreStages: readonly string[];
  readonly totalCallCount: number;
  readonly promptTokenEstimate: number;
  readonly legacyPromptTokenEstimate: number;
  readonly promptTokenReductionPercent: number;
}

function isExcludedBudgetStage(output: RunFixtureResult["stageOutputs"][number]): boolean {
  if (output.stage === "financial-table-mapping" || output.stage === "forecast-disagreement") {
    return true;
  }
  return (
    output.stage === "final-synthesis" &&
    output.repromptReason !== undefined &&
    output.repromptReason.predictionCompletion === undefined
  );
}

async function measureSimplifiedFixture(
  fixtureName: string,
  legacyPromptTokenEstimate: number,
): Promise<DeepEquitySimplifiedCallBudget> {
  const fixture = await loadFixture(fixtureName);
  const modelCalls: CapturedModelCall[] = [];
  const result = await runFixture(fixtureName, {
    llm: "replay",
    reasoningVariant: "simplified",
    provider: captureProvider(makeReplayProvider(fixture.llmCassette), modelCalls),
  });
  try {
    const ordered = orderedModelStages(result, modelCalls);
    const budgeted = ordered.filter(
      (_call, index) => !isExcludedBudgetStage(result.stageOutputs[index]!),
    );
    const coreStages = ordered.flatMap((call, index) => {
      const output = result.stageOutputs[index]!;
      if (
        output.repromptReason !== undefined ||
        (call.stage !== "equity-analysis" &&
          call.stage !== "critique" &&
          call.stage !== "final-synthesis")
      ) {
        return [];
      }
      return [call.stage];
    });
    const totals = modelCallTotals(modelCalls);
    return {
      fixture: fixtureName,
      coreStages,
      totalCallCount: budgeted.length,
      promptTokenEstimate: totals.promptTokenEstimate,
      legacyPromptTokenEstimate,
      promptTokenReductionPercent:
        ((legacyPromptTokenEstimate - totals.promptTokenEstimate) / legacyPromptTokenEstimate) *
        100,
    };
  } finally {
    await result.cleanup();
  }
}

export async function measureDeepEquitySimplifiedCallBudgets(): Promise<
  readonly DeepEquitySimplifiedCallBudget[]
> {
  const legacy = await readDeepEquityLegacyBaseline();
  const legacyByFixture = new Map(
    legacy.fixtures.map((fixture) => [
      fixture.fixture,
      fixture.modelCallTotals.promptTokenEstimate,
    ]),
  );
  const budgets: DeepEquitySimplifiedCallBudget[] = [];
  for (const fixtureName of DEEP_EQUITY_BASELINE_FIXTURES) {
    const legacyPromptTokenEstimate = legacyByFixture.get(fixtureName);
    if (legacyPromptTokenEstimate === undefined) {
      throw new Error(`legacy deep-equity baseline missing fixture ${fixtureName}`);
    }
    budgets.push(await measureSimplifiedFixture(fixtureName, legacyPromptTokenEstimate));
  }
  return budgets;
}
