import type { AppConfig } from "../config";
import type { CliCommand } from "../cli/args";
import { join } from "node:path";
import { createRunId, prepareRunArtifacts, writeJson, writeRunOutputs, type RunArtifacts } from "../artifacts";
import type { EvidenceQuality, KeyFinding, MarketSnapshot, ResearchReport, RunTrace, Scenario, Source } from "../domain/types";
import { rankMovers } from "../movers/ranking";
import type { ModelProvider } from "../model/types";
import { renderMarkdownReport } from "../report/markdown";
import { validateResearchReport } from "../report/schema";
import { isRecord } from "../sources/guards";
import type { RawSourceSnapshot } from "../sources/types";

export interface CollectedSources {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly newsSources: readonly Source[];
}

export interface RunResearchJobInput {
  readonly command: CliCommand;
  readonly config: AppConfig;
  readonly provider: ModelProvider;
  readonly collectedSources: CollectedSources;
  readonly now?: Date;
}

export interface RunResearchJobResult {
  readonly report: ResearchReport;
  readonly markdown: string;
  readonly trace: RunTrace;
}

export interface PersistedResearchJobResult extends RunResearchJobResult {
  readonly artifacts: RunArtifacts;
}

interface ModelReportPayload {
  readonly summary?: unknown;
  readonly keyFindings?: unknown;
  readonly bullCase?: unknown;
  readonly bearCase?: unknown;
  readonly risks?: unknown;
  readonly catalysts?: unknown;
  readonly scenarios?: unknown;
  readonly confidence?: unknown;
  readonly dataGaps?: unknown;
  readonly extras?: unknown;
}

function parseModelPayload(content: string): ModelReportPayload {
  const parsed = JSON.parse(content) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("Model report payload must be a JSON object");
  }

  return parsed;
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readStringArray(value: unknown): readonly string[] {
  return readArray(value).filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function readFindings(value: unknown): readonly KeyFinding[] {
  return readArray(value)
    .map((item): KeyFinding | undefined => {
      if (!isRecord(item) || typeof item.text !== "string") {
        return undefined;
      }

      return {
        text: item.text,
        sourceIds: readStringArray(item.sourceIds),
      };
    })
    .filter((item): item is KeyFinding => item !== undefined);
}

function readScenarios(value: unknown): readonly Scenario[] {
  return readArray(value)
    .map((item): Scenario | undefined => {
      if (!isRecord(item) || typeof item.name !== "string" || typeof item.description !== "string") {
        return undefined;
      }

      return {
        name: item.name,
        description: item.description,
        sourceIds: readStringArray(item.sourceIds),
      };
    })
    .filter((item): item is Scenario => item !== undefined);
}

function readEvidenceQuality(value: unknown): EvidenceQuality {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }

  return "low";
}

function buildSourceList(collectedSources: CollectedSources): readonly Source[] {
  const marketSources = collectedSources.marketSnapshots.map((snapshot): Source => ({
    id: snapshot.sourceId,
    title: `${snapshot.symbol} market snapshot`,
    fetchedAt: snapshot.observedAt,
    kind: "market-data",
    assetClass: snapshot.assetClass,
    symbol: snapshot.symbol,
  }));

  return [...marketSources, ...collectedSources.newsSources];
}

function buildPrompt(command: CliCommand, collectedSources: CollectedSources, config: AppConfig): string {
  const limit = command.assetClass === "equity" ? config.sourceOptions.equityMoverLimit : config.sourceOptions.cryptoMoverLimit;
  const movers = rankMovers(
    collectedSources.marketSnapshots.filter((snapshot) => snapshot.assetClass === command.assetClass),
    limit,
  );

  return JSON.stringify(
    {
      instruction:
        "Create a sourced research-only JSON report from provided evidence only. Do not use memory. Do not include trade actions, advice, position sizing, execution instructions, or portfolio changes.",
      command,
      movers,
      marketSnapshots: collectedSources.marketSnapshots,
      newsSources: collectedSources.newsSources,
      requiredShape: {
        summary: "string",
        keyFindings: [{ text: "string", sourceIds: ["source-id"] }],
        bullCase: [{ text: "string", sourceIds: ["source-id"] }],
        bearCase: [{ text: "string", sourceIds: ["source-id"] }],
        risks: [{ text: "string", sourceIds: ["source-id"] }],
        catalysts: [{ text: "string", sourceIds: ["source-id"] }],
        scenarios: [{ name: "string", description: "string", sourceIds: ["source-id"] }],
        confidence: "high|medium|low",
        dataGaps: ["string"],
      },
    },
    null,
    2,
  );
}

export async function runResearchJob(input: RunResearchJobInput): Promise<RunResearchJobResult> {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const runId = createRunId(now);
  const modelResponse = await input.provider.generate({
    model: input.config.synthesisModel,
    responseFormat: "json",
    messages: [
      {
        role: "system",
        content: "You are a research editor. Use only supplied source IDs. Return JSON only.",
      },
      {
        role: "user",
        content: buildPrompt(input.command, input.collectedSources, input.config),
      },
    ],
  });

  const payload = parseModelPayload(modelResponse.content);
  const report = validateResearchReport({
    runId,
    jobType: input.command.jobType,
    assetClass: input.command.assetClass,
    ...(input.command.jobType === "ticker" ? { symbol: input.command.symbol } : {}),
    generatedAt,
    summary: typeof payload.summary === "string" ? payload.summary : "",
    keyFindings: readFindings(payload.keyFindings),
    bullCase: readFindings(payload.bullCase),
    bearCase: readFindings(payload.bearCase),
    risks: readFindings(payload.risks),
    catalysts: readFindings(payload.catalysts),
    scenarios: readScenarios(payload.scenarios),
    confidence: readEvidenceQuality(payload.confidence),
    dataGaps: readStringArray(payload.dataGaps),
    sources: buildSourceList(input.collectedSources),
    notFinancialAdvice: true,
    ...(typeof payload.extras === "object" && payload.extras !== null && !Array.isArray(payload.extras) ? { extras: payload.extras as Record<string, unknown> } : {}),
  });

  const trace: RunTrace = {
    runId,
    jobType: input.command.jobType,
    assetClass: input.command.assetClass,
    ...(input.command.jobType === "ticker" ? { symbol: input.command.symbol } : {}),
    depth: input.command.depth,
    provider: input.provider.name,
    quickModel: input.config.quickModel,
    synthesisModel: input.config.synthesisModel,
    startedAt: generatedAt,
    completedAt: new Date(now.getTime() + 1).toISOString(),
    sourceGaps: report.dataGaps,
    tokenEstimate: modelResponse.tokenEstimate,
    costEstimateUsd: modelResponse.costEstimateUsd,
  };

  return {
    report,
    markdown: renderMarkdownReport(report),
    trace,
  };
}

export async function persistResearchJob(input: RunResearchJobInput): Promise<PersistedResearchJobResult> {
  const result = await runResearchJob(input);
  const artifacts = await prepareRunArtifacts(input.config.dataDir, result.report.runId);

  await writeJson(join(artifacts.rawDir, "snapshots.json"), input.collectedSources.rawSnapshots);
  await writeJson(join(artifacts.normalizedDir, "market-snapshots.json"), input.collectedSources.marketSnapshots);
  await writeJson(join(artifacts.normalizedDir, "news-sources.json"), input.collectedSources.newsSources);
  await writeRunOutputs(artifacts, result.report, result.markdown, result.trace);

  return {
    ...result,
    artifacts,
  };
}
