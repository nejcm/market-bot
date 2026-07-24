import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchReport, RunTrace } from "../../src/domain/types";
import type { ModelProvider, ModelRequest } from "../../src/model/types";
import {
  loadFixture,
  runFixture,
  type FixtureDataRequest,
  type RunFixtureResult,
} from "./run-fixtures";
import { makeReplayProvider } from "./run-fixtures/llm-cassette";

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

interface CapturedModelCall {
  readonly order: number;
  readonly stage: string;
  readonly model: string;
  readonly promptCharacterEstimate: number;
  readonly promptTokenEstimate: number;
  readonly providerTokenEstimate: number;
}

interface RequestCount {
  readonly provider: string;
  readonly method: string;
  readonly urlShape: string;
  readonly count: number;
}

interface ModelCallTotals {
  readonly callCount: number;
  readonly promptCharacterEstimate: number;
  readonly promptTokenEstimate: number;
  readonly providerTokenEstimate: number;
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

function requestStage(request: ModelRequest): string {
  const content = request.messages.findLast((message) => message.role === "user")?.content;
  if (content === undefined) {
    return "unknown";
  }
  try {
    const parsed = JSON.parse(content) as { readonly stage?: unknown };
    return typeof parsed.stage === "string" ? parsed.stage : "unknown";
  } catch {
    return "unknown";
  }
}

function captureProvider(provider: ModelProvider, captured: CapturedModelCall[]): ModelProvider {
  let order = 0;
  return {
    name: provider.name,
    generate: async (request) => {
      const currentOrder = order;
      order += 1;
      const response = await provider.generate(request);
      const promptCharacterEstimate = request.messages.reduce(
        (total, message) => total + stablePromptContent(message.content).length,
        0,
      );
      captured[currentOrder] = {
        order: currentOrder + 1,
        stage: requestStage(request),
        model: request.model,
        promptCharacterEstimate,
        promptTokenEstimate: Math.ceil(promptCharacterEstimate / 4),
        providerTokenEstimate: response.tokenEstimate,
      };
      return response;
    },
  };
}

function withoutVolatileTiming(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => withoutVolatileTiming(item));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "durationMs")
      .map(([key, item]) => [key, withoutVolatileTiming(item)]),
  );
}

function stablePromptContent(content: string): string {
  try {
    return JSON.stringify(withoutVolatileTiming(JSON.parse(content) as unknown));
  } catch {
    return content;
  }
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

function orderedModelStages(
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

function modelCallTotals(captured: readonly CapturedModelCall[]): ModelCallTotals {
  return captured.reduce<ModelCallTotals>(
    (totals, call) => ({
      callCount: totals.callCount + 1,
      promptCharacterEstimate: totals.promptCharacterEstimate + call.promptCharacterEstimate,
      promptTokenEstimate: totals.promptTokenEstimate + call.promptTokenEstimate,
      providerTokenEstimate: totals.providerTokenEstimate + call.providerTokenEstimate,
    }),
    {
      callCount: 0,
      promptCharacterEstimate: 0,
      promptTokenEstimate: 0,
      providerTokenEstimate: 0,
    },
  );
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
