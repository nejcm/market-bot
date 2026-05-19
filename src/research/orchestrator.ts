import type { AppConfig } from "../config";
import type { ResearchCommand } from "../cli/args";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createRunId, prepareRunArtifacts, writeJson, writeRunOutputs } from "../artifacts";
import type { RunArtifacts } from "../artifacts";
import type {
  EvidenceQuality,
  KeyFinding,
  MarketSnapshot,
  Prediction,
  ResearchReport,
  RunTrace,
  Scenario,
  Source,
  SourceGap,
} from "../domain/types";
import { isMarketUpdateJobType, marketUpdateCadence } from "../domain/types";
import { rankMovers } from "../movers/ranking";
import type { ModelProvider } from "../model/types";
import { renderMarkdownReport } from "../report/markdown";
import { validatePredictions, validateResearchReport } from "../report/schema";
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
  readonly command: ResearchCommand;
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
  readonly predictions?: unknown;
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
  readonly minimumPredictions: number;
  readonly defaultPredictionHorizon: number;
  readonly predictionSubjects: readonly string[];
  readonly focus: readonly string[];
}

interface ResearchContext {
  readonly depthProfile: DepthProfile;
  readonly marketRegime: ReturnType<typeof summarizeMarketRegime>;
  readonly calibrationContext: CalibrationContext | undefined;
}

interface CalibrationBinSummary {
  readonly kind: string;
  readonly pBin: string;
  readonly hitRate: number;
  readonly sampleCount: number;
}

interface CalibrationContext {
  readonly brierScore?: number;
  readonly resolvedCount?: number;
  readonly bins?: readonly CalibrationBinSummary[];
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
  command: ResearchCommand,
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
  const weeklyMoverGaps =
    command.jobType === "weekly"
      ? [
          command.assetClass === "equity"
            ? "Weekly equity mover universe is seeded from Yahoo day_gainers, not a true trailing 5-session mover screener"
            : "Weekly crypto mover data uses CoinGecko 24h change fields; trailing 7-day mover changes are not available in the current source payload",
        ]
      : [];

  return [...gaps, ...marketGaps, ...newsGaps, ...tickerGaps, ...weeklyMoverGaps];
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

async function loadCalibrationContext(dataDir: string): Promise<CalibrationContext | undefined> {
  try {
    const raw = await readFile(join(dataDir, "../calibration/summary.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    return parsed as CalibrationContext;
  } catch {
    return undefined;
  }
}

function buildCalibrationBlock(calibration: CalibrationContext | undefined): string | undefined {
  if (calibration === undefined) {
    return undefined;
  }
  const lines: string[] = [];
  if (typeof calibration.brierScore === "number") {
    lines.push(`Overall Brier score: ${calibration.brierScore.toFixed(3)} (lower is better)`);
  }
  if (typeof calibration.resolvedCount === "number") {
    lines.push(`Resolved predictions: ${calibration.resolvedCount}`);
  }
  if (Array.isArray(calibration.bins) && calibration.bins.length > 0) {
    lines.push("Bin summary (past hit rates vs stated probability):");
    for (const bin of calibration.bins) {
      if (isRecord(bin)) {
        lines.push(
          `  ${String(bin.kind)} p${String(bin.pBin)}: stated=${String(bin.pBin)} actual=${Number(bin.hitRate).toFixed(2)} (n=${String(bin.sampleCount)})`,
        );
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function buildEvidencePayload(
  command: ResearchCommand,
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
  const calibrationBlock = buildCalibrationBlock(context.calibrationContext);

  return {
    command,
    movers,
    marketRegime: context.marketRegime,
    marketSnapshots: collectedSources.marketSnapshots,
    newsSources: collectedSources.newsSources,
    sourceGaps: deterministicSourceGaps(command, collectedSources),
    ...(calibrationBlock !== undefined ? { priorCalibration: calibrationBlock } : {}),
  };
}

function finalReportShape(depthProfile: DepthProfile): Record<string, unknown> {
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
    predictions: Array.from({ length: depthProfile.minimumPredictions }, (_, idx) => ({
      id: `pred-${String(idx + 1)}`,
      claim: "string describing market quantity",
      kind: "direction|relative|volatility|range",
      subject: depthProfile.predictionSubjects[0] ?? "SPY",
      measurableAs: `close(SPY, +${String(depthProfile.defaultPredictionHorizon)}) > close(SPY, 0)`,
      horizonTradingDays: depthProfile.defaultPredictionHorizon,
      probability: 0.6,
      sourceIds: ["source-id"],
    })),
  };
}

const DAILY_PREDICTION_SUBJECTS = ["SPY", "QQQ", "^VIX", "BTC"] as const;

function buildDepthProfile(command: ResearchCommand): DepthProfile {
  const isMarketUpdate = isMarketUpdateJobType(command.jobType);
  const predictionSubjects =
    command.jobType === "ticker"
      ? [command.symbol]
      : (DAILY_PREDICTION_SUBJECTS as readonly string[]);
  const defaultPredictionHorizon = command.jobType === "weekly" ? 15 : 5;

  if (command.depth === "deep") {
    return {
      depth: "deep",
      analystStyle: "fuller analyst-style",
      minimumKeyFindings: isMarketUpdate ? 5 : 6,
      minimumScenarios: 3,
      minimumPredictions: isMarketUpdate ? 3 : 5,
      defaultPredictionHorizon,
      predictionSubjects,
      focus: isMarketUpdate
        ? [
            command.jobType === "weekly" ? "weekly market regime" : "market regime",
            command.jobType === "weekly" ? "5-session movers" : "movers",
            "cross-asset themes",
            "risks",
            "source gaps",
          ]
        : ["thesis", "evidence", "catalysts", "bull case", "bear case", "scenarios", "data gaps"],
    };
  }

  return {
    depth: "brief",
    analystStyle: "concise brief",
    minimumKeyFindings: isMarketUpdate ? 3 : 4,
    minimumScenarios: 1,
    minimumPredictions: isMarketUpdate ? 2 : 3,
    defaultPredictionHorizon,
    predictionSubjects,
    focus: isMarketUpdate
      ? [
          command.jobType === "weekly" ? "weekly market regime" : "market regime",
          command.jobType === "weekly" ? "5-session movers" : "movers",
          "risks",
          "source gaps",
        ]
      : ["thesis", "evidence", "risks", "data gaps"],
  };
}

function buildStagePrompt(
  stage: StageOutput["stage"],
  command: ResearchCommand,
  collectedSources: CollectedSources,
  config: AppConfig,
  context: ResearchContext,
  priorStages: readonly StageOutput[] = [],
  predictionRepromptErrors: readonly string[] = [],
): string {
  const baseInstruction =
    "Use only supplied source IDs. Do not use memory. Do not include trade actions, advice, position sizing, execution instructions, or portfolio changes.";
  const predictionInstruction =
    stage === "final-synthesis"
      ? ` Emit exactly ${String(context.depthProfile.minimumPredictions)} predictions using subjects from predictionSubjects and a default horizon near ${String(context.depthProfile.defaultPredictionHorizon)} trading days. Each prediction must use the measurableAs DSL: close(SUBJECT, +N) > close(SUBJECT, 0) for direction, close(A, +N)/close(A, 0) > close(B, +N)/close(B, 0) for relative, max(close(^VIX), 0..+N) > T for volatility, close(SUBJECT, +N) outside [Lo, Hi] for range.`
      : "";

  return JSON.stringify(
    {
      instruction: baseInstruction + predictionInstruction,
      stage,
      stageGoal:
        stage === "specialist-analysis"
          ? "Extract sourced thesis points, catalysts, risks, and evidence gaps from the collected sources."
          : stage === "critique"
            ? "Challenge the specialist analysis for missing evidence, alternative explanations, and weak claims without adding new facts."
            : "Synthesize the final sourced research-only JSON report including predictions.",
      depthProfile: context.depthProfile,
      evidence: buildEvidencePayload(command, collectedSources, config, context),
      priorStages,
      ...(predictionRepromptErrors.length > 0
        ? { predictionRepromptErrors, unmetMinimum: context.depthProfile.minimumPredictions }
        : {}),
      requiredShape:
        stage === "final-synthesis"
          ? finalReportShape(context.depthProfile)
          : { findings: [{ text: "string", sourceIds: ["source-id"] }], dataGaps: ["string"] },
    },
    undefined,
    2,
  );
}

async function runStage(
  stage: StageOutput["stage"],
  model: string,
  input: RunResearchJobInput,
  context: ResearchContext,
  priorStages: readonly StageOutput[] = [],
  predictionRepromptErrors: readonly string[] = [],
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
          predictionRepromptErrors,
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

function readPredictions(
  value: unknown,
  knownSourceIds: ReadonlySet<string>,
): { predictions: readonly Prediction[]; errors: readonly string[] } {
  const result = validatePredictions(readArray(value), knownSourceIds);
  return { predictions: result.valid, errors: result.errors };
}

export async function runResearchJob(input: RunResearchJobInput): Promise<RunResearchJobResult> {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const runId = createRunId(now);
  const calibrationContext = await loadCalibrationContext(input.config.dataDir);
  const context: ResearchContext = {
    depthProfile: buildDepthProfile(input.command),
    marketRegime: summarizeMarketRegime(
      input.command.assetClass,
      input.collectedSources.marketSnapshots,
    ),
    calibrationContext,
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
  let finalOutput = await runStage("final-synthesis", input.config.synthesisModel, input, context, [
    specialistOutput,
    critiqueOutput,
  ]);

  const sources = buildSourceList(input.collectedSources);
  const knownSourceIds = new Set(sources.map((source) => source.id));

  let payload = parseModelPayload(finalOutput.content);
  let predResult = readPredictions(payload.predictions, knownSourceIds);
  const stageOutputsArr: StageOutput[] = [specialistOutput, critiqueOutput, finalOutput];

  if (predResult.predictions.length < context.depthProfile.minimumPredictions) {
    finalOutput = await runStage(
      "final-synthesis",
      input.config.synthesisModel,
      input,
      context,
      [specialistOutput, critiqueOutput],
      predResult.errors,
    );
    stageOutputsArr.push(finalOutput);
    payload = parseModelPayload(finalOutput.content);
    predResult = readPredictions(payload.predictions, knownSourceIds);
  }

  const predictionErrors = predResult.errors;
  const stageOutputs = stageOutputsArr as readonly StageOutput[];

  const dataGapsRaw = [
    ...new Set([
      ...readStringArray(payload.dataGaps),
      ...deterministicSourceGaps(input.command, input.collectedSources),
    ]),
  ];
  const shortfall = predResult.predictions.length < context.depthProfile.minimumPredictions;
  const dataGaps = shortfall
    ? [
        ...dataGapsRaw,
        `predictionShortfall: emitted ${String(predResult.predictions.length)} of ${String(context.depthProfile.minimumPredictions)} required`,
      ]
    : dataGapsRaw;

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
    predictions: predResult.predictions,
    sources,
    notFinancialAdvice: true,
    extras: {
      ...modelExtras,
      depth: input.command.depth,
      depthProfile: context.depthProfile,
      ...(isMarketUpdateJobType(input.command.jobType)
        ? { marketUpdateCadence: marketUpdateCadence(input.command.jobType) }
        : {}),
      marketRegime: context.marketRegime,
    },
  });

  const trace: RunTrace = {
    runId,
    jobType: input.command.jobType,
    ...(isMarketUpdateJobType(input.command.jobType)
      ? { marketUpdateCadence: marketUpdateCadence(input.command.jobType) }
      : {}),
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
    ...(predictionErrors.length > 0 ? { predictionErrors } : {}),
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
