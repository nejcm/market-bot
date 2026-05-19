import type { AppConfig } from "../config";
import type { CliCommand } from "../cli/args";
import { join } from "node:path";
import { createRunId, prepareRunArtifacts, writeJson, writeRunOutputs } from "../artifacts";
import type { RunArtifacts } from "../artifacts";
import type {
  EvidenceQuality,
  KeyFinding,
  MarketSnapshot,
  ResearchReport,
  RunTrace,
  Scenario,
  Source,
  SourceGap,
} from "../domain/types";
import { rankMovers } from "../movers/ranking";
import type { ModelProvider } from "../model/types";
import { renderMarkdownReport } from "../report/markdown";
import { validateResearchReport } from "../report/schema";
import { summarizeMarketRegime } from "./regime";
import { isRecord } from "../sources/guards";
import type { RawSourceSnapshot } from "../sources/types";

export interface CollectedSources {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly newsSources: readonly Source[];
  readonly sourceGaps?: readonly SourceGap[];
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
  readonly stageOutputs: readonly StageOutput[];
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

interface StageOutput {
  readonly stage: "specialist-analysis" | "critique" | "final-synthesis";
  readonly content: string;
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
}

interface DepthProfile {
  readonly depth: "brief" | "deep";
  readonly analystStyle: "concise brief" | "fuller analyst-style";
  readonly minimumKeyFindings: number;
  readonly minimumScenarios: number;
  readonly focus: readonly string[];
}

interface ResearchContext {
  readonly depthProfile: DepthProfile;
  readonly marketRegime: ReturnType<typeof summarizeMarketRegime>;
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
  return readArray(value).filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
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
      if (
        !isRecord(item) ||
        typeof item.name !== "string" ||
        typeof item.description !== "string"
      ) {
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

function qualityRank(value: EvidenceQuality): number {
  if (value === "high") {
    return 3;
  }

  return value === "medium" ? 2 : 1;
}

function lowerQuality(left: EvidenceQuality, right: EvidenceQuality): EvidenceQuality {
  return qualityRank(left) <= qualityRank(right) ? left : right;
}

function deterministicSourceGaps(
  command: CliCommand,
  collectedSources: CollectedSources,
): readonly string[] {
  const gaps = collectedSources.sourceGaps?.map((gap) => `${gap.source}: ${gap.message}`) ?? [];
  const marketGaps =
    collectedSources.marketSnapshots.length === 0
      ? ["No usable market data snapshots were collected"]
      : [];
  const newsGaps =
    collectedSources.newsSources.length === 0 ? ["No usable news sources were collected"] : [];
  const tickerGaps =
    command.jobType === "ticker" &&
    collectedSources.marketSnapshots.every((snapshot) => snapshot.symbol !== command.symbol)
      ? [`No market snapshot matched ticker ${command.symbol}`]
      : [];

  return [...gaps, ...marketGaps, ...newsGaps, ...tickerGaps];
}

function deterministicQualityCap(collectedSources: CollectedSources): EvidenceQuality {
  if (collectedSources.marketSnapshots.length === 0) {
    return "low";
  }

  if ((collectedSources.sourceGaps?.length ?? 0) > 0 || collectedSources.newsSources.length === 0) {
    return "medium";
  }

  return "high";
}

function buildSourceList(collectedSources: CollectedSources): readonly Source[] {
  const marketSources = collectedSources.marketSnapshots.map(
    (snapshot): Source => ({
      id: snapshot.sourceId,
      title: `${snapshot.symbol} market snapshot`,
      fetchedAt: snapshot.observedAt,
      kind: "market-data",
      assetClass: snapshot.assetClass,
      symbol: snapshot.symbol,
    }),
  );

  return [...marketSources, ...collectedSources.newsSources];
}

function buildEvidencePayload(
  command: CliCommand,
  collectedSources: CollectedSources,
  config: AppConfig,
  context: ResearchContext,
): Record<string, unknown> {
  const limit =
    command.assetClass === "equity"
      ? config.sourceOptions.equityMoverLimit
      : config.sourceOptions.cryptoMoverLimit;
  const movers = rankMovers(
    collectedSources.marketSnapshots.filter(
      (snapshot) => snapshot.assetClass === command.assetClass,
    ),
    limit,
  );

  return {
    command,
    movers,
    marketRegime: context.marketRegime,
    marketSnapshots: collectedSources.marketSnapshots,
    newsSources: collectedSources.newsSources,
    sourceGaps: deterministicSourceGaps(command, collectedSources),
  };
}

function finalReportShape(): Record<string, unknown> {
  return {
    summary: "string",
    keyFindings: [{ text: "string", sourceIds: ["source-id"] }],
    bullCase: [{ text: "string", sourceIds: ["source-id"] }],
    bearCase: [{ text: "string", sourceIds: ["source-id"] }],
    risks: [{ text: "string", sourceIds: ["source-id"] }],
    catalysts: [{ text: "string", sourceIds: ["source-id"] }],
    scenarios: [{ name: "string", description: "string", sourceIds: ["source-id"] }],
    confidence: "high|medium|low",
    dataGaps: ["string"],
  };
}

function buildDepthProfile(command: CliCommand): DepthProfile {
  if (command.depth === "deep") {
    return {
      depth: "deep",
      analystStyle: "fuller analyst-style",
      minimumKeyFindings: command.jobType === "daily" ? 5 : 6,
      minimumScenarios: 3,
      focus:
        command.jobType === "daily"
          ? ["market regime", "movers", "cross-asset themes", "risks", "source gaps"]
          : ["thesis", "evidence", "catalysts", "bull case", "bear case", "scenarios", "data gaps"],
    };
  }

  return {
    depth: "brief",
    analystStyle: "concise brief",
    minimumKeyFindings: command.jobType === "daily" ? 3 : 4,
    minimumScenarios: 1,
    focus:
      command.jobType === "daily"
        ? ["market regime", "movers", "risks", "source gaps"]
        : ["thesis", "evidence", "risks", "data gaps"],
  };
}

function buildStagePrompt(
  stage: StageOutput["stage"],
  command: CliCommand,
  collectedSources: CollectedSources,
  config: AppConfig,
  context: ResearchContext,
  priorStages: readonly StageOutput[] = [],
): string {
  return JSON.stringify(
    {
      instruction:
        "Use only supplied source IDs. Do not use memory. Do not include trade actions, advice, position sizing, execution instructions, or portfolio changes.",
      stage,
      stageGoal:
        stage === "specialist-analysis"
          ? "Extract sourced thesis points, catalysts, risks, and evidence gaps from the collected sources."
          : (stage === "critique"
            ? "Challenge the specialist analysis for missing evidence, alternative explanations, and weak claims without adding new facts."
            : "Synthesize the final sourced research-only JSON report."),
      depthProfile: context.depthProfile,
      evidence: buildEvidencePayload(command, collectedSources, config, context),
      priorStages,
      requiredShape:
        stage === "final-synthesis"
          ? finalReportShape()
          : { findings: [{ text: "string", sourceIds: ["source-id"] }], dataGaps: ["string"] },
    },
    null,
    2,
  );
}

async function runStage(
  stage: StageOutput["stage"],
  model: string,
  input: RunResearchJobInput,
  context: ResearchContext,
  priorStages: readonly StageOutput[] = [],
): Promise<StageOutput> {
  const response = await input.provider.generate({
    model,
    responseFormat: "json",
    messages: [
      {
        role: "system",
        content: "You are a market research workflow stage. Return JSON only.",
      },
      {
        role: "user",
        content: buildStagePrompt(
          stage,
          input.command,
          input.collectedSources,
          input.config,
          context,
          priorStages,
        ),
      },
    ],
  });

  return {
    stage,
    content: response.content,
    tokenEstimate: response.tokenEstimate,
    costEstimateUsd: response.costEstimateUsd,
  };
}

export async function runResearchJob(input: RunResearchJobInput): Promise<RunResearchJobResult> {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const runId = createRunId(now);
  const context: ResearchContext = {
    depthProfile: buildDepthProfile(input.command),
    marketRegime: summarizeMarketRegime(
      input.command.assetClass,
      input.collectedSources.marketSnapshots,
    ),
  };
  const specialistOutput = await runStage(
    "specialist-analysis",
    input.config.quickModel,
    input,
    context,
  );
  const critiqueOutput = await runStage("critique", input.config.quickModel, input, context, [
    specialistOutput,
  ]);
  const finalOutput = await runStage(
    "final-synthesis",
    input.config.synthesisModel,
    input,
    context,
    [specialistOutput, critiqueOutput],
  );
  const stageOutputs = [specialistOutput, critiqueOutput, finalOutput];

  const payload = parseModelPayload(finalOutput.content);
  const dataGaps = [
    ...new Set([
      ...readStringArray(payload.dataGaps),
      ...deterministicSourceGaps(input.command, input.collectedSources),
    ]),
  ];
  const confidence = lowerQuality(
    readEvidenceQuality(payload.confidence),
    deterministicQualityCap(input.collectedSources),
  );
  const modelExtras =
    typeof payload.extras === "object" && payload.extras !== null && !Array.isArray(payload.extras)
      ? (payload.extras as Record<string, unknown>)
      : {};
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
    confidence,
    dataGaps,
    predictions: [],
    sources: buildSourceList(input.collectedSources),
    notFinancialAdvice: true,
    extras: {
      ...modelExtras,
      depth: input.command.depth,
      depthProfile: context.depthProfile,
      marketRegime: context.marketRegime,
    },
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
    stages: ["source-collection", ...stageOutputs.map((output) => output.stage)],
    tokenEstimate: stageOutputs.reduce((total, output) => total + output.tokenEstimate, 0),
    costEstimateUsd: stageOutputs.reduce((total, output) => total + output.costEstimateUsd, 0),
  };

  return {
    report,
    markdown: renderMarkdownReport(report),
    trace,
    stageOutputs,
  };
}

export async function persistResearchJob(
  input: RunResearchJobInput,
): Promise<PersistedResearchJobResult> {
  const result = await runResearchJob(input);
  const artifacts = await prepareRunArtifacts(input.config.dataDir, result.report.runId);

  await writeJson(join(artifacts.rawDir, "snapshots.json"), input.collectedSources.rawSnapshots);
  await writeJson(
    join(artifacts.normalizedDir, "market-snapshots.json"),
    input.collectedSources.marketSnapshots,
  );
  await writeJson(
    join(artifacts.normalizedDir, "news-sources.json"),
    input.collectedSources.newsSources,
  );
  await writeJson(
    join(artifacts.normalizedDir, "source-gaps.json"),
    input.collectedSources.sourceGaps ?? [],
  );
  await writeJson(join(artifacts.runDir, "stages.json"), result.stageOutputs);
  await writeRunOutputs(artifacts, result.report, result.markdown, result.trace);

  return {
    ...result,
    artifacts,
  };
}
