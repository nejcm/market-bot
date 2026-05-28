import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config";
import type { ResearchCommand } from "../cli/args";
import {
  isMarketUpdateJobType,
  type ExtendedEvidence,
  type MarketRegimeSummary,
  type MarketSnapshot,
  type Source,
  type SourceGap,
} from "../domain/types";
import { rankMovers } from "../movers/ranking";
import { isRecord } from "../sources/guards";
import type { RawSourceSnapshot } from "../sources/types";

// ---------------------------------------------------------------------------
// CollectedSources — the normalized output of the sources subsystem
// ---------------------------------------------------------------------------

export interface CollectedSources {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly newsSources: readonly Source[];
  readonly extendedSources?: readonly Source[];
  readonly extendedEvidence?: ExtendedEvidence;
  readonly sourceGaps?: readonly SourceGap[];
}

// ---------------------------------------------------------------------------
// DepthProfile, CalibrationContext, ResearchContext
// ---------------------------------------------------------------------------

export interface DepthProfile {
  readonly depth: "brief" | "deep";
  readonly analystStyle: "concise brief" | "fuller analyst-style";
  readonly minimumKeyFindings: number;
  readonly minimumScenarios: number;
  readonly minimumPredictions: number;
  readonly defaultPredictionHorizon: number;
  readonly predictionSubjects: readonly string[];
  readonly focus: readonly string[];
}

interface CalibrationBinSummary {
  readonly kind: string;
  readonly pBin: string;
  readonly hitRate: number;
  readonly sampleCount: number;
}

export interface CalibrationContext {
  readonly brierScore?: number;
  readonly resolvedCount?: number;
  readonly bins?: readonly CalibrationBinSummary[];
}

export interface ResearchContext {
  readonly depthProfile: DepthProfile;
  readonly marketRegime: MarketRegimeSummary;
  readonly calibrationContext: CalibrationContext | undefined;
}

// ---------------------------------------------------------------------------
// Deterministic source gaps — disclosed in the prompt and in the final report
// ---------------------------------------------------------------------------

export function deterministicSourceGaps(
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

// ---------------------------------------------------------------------------
// Calibration context loading and formatting
// ---------------------------------------------------------------------------

export async function loadCalibrationContext(
  dataDir: string,
): Promise<CalibrationContext | undefined> {
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

// ---------------------------------------------------------------------------
// Depth profile
// ---------------------------------------------------------------------------

const MARKET_UPDATE_PREDICTION_SUBJECTS = ["SPY", "QQQ", "^VIX", "BTC"] as const;

export function buildDepthProfile(command: ResearchCommand): DepthProfile {
  const isMarketUpdate = isMarketUpdateJobType(command.jobType);
  const predictionSubjects =
    command.jobType === "ticker"
      ? [command.symbol]
      : (MARKET_UPDATE_PREDICTION_SUBJECTS as readonly string[]);
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

// ---------------------------------------------------------------------------
// Evidence payload — the JSON blob handed to each model stage
// ---------------------------------------------------------------------------

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
    ...(command.jobType === "ticker" && collectedSources.extendedEvidence !== undefined
      ? { extendedEvidence: collectedSources.extendedEvidence }
      : {}),
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
      kind: "direction|relative|volatility|range|macro|iv",
      subject: depthProfile.predictionSubjects[0] ?? "SPY",
      measurableAs: `close(SPY, +${String(depthProfile.defaultPredictionHorizon)}) > close(SPY, 0)`,
      horizonTradingDays: depthProfile.defaultPredictionHorizon,
      probability: 0.6,
      sourceIds: ["source-id"],
    })),
  };
}

// ---------------------------------------------------------------------------
// Stage prompt
// ---------------------------------------------------------------------------

type StageLabel = "specialist-analysis" | "critique" | "final-synthesis";

export function buildStagePrompt(
  stage: StageLabel,
  command: ResearchCommand,
  collectedSources: CollectedSources,
  config: AppConfig,
  context: ResearchContext,
  priorStages: readonly unknown[] = [],
  predictionRepromptErrors: readonly string[] = [],
): string {
  const baseInstruction =
    "Use only supplied source IDs. Do not use memory. Do not include trade actions, advice, position sizing, execution instructions, or portfolio changes.";
  const predictionInstruction =
    stage === "final-synthesis"
      ? ` Emit exactly ${String(context.depthProfile.minimumPredictions)} predictions using subjects from predictionSubjects and a default horizon near ${String(context.depthProfile.defaultPredictionHorizon)} trading days. Each prediction must use the measurableAs DSL: close(SUBJECT, +N) > close(SUBJECT, 0) for direction, close(A, +N)/close(A, 0) > close(B, +N)/close(B, 0) for relative, max(close(^VIX), 0..+N) > T for volatility, close(SUBJECT, +N) outside [Lo, Hi] for range, fred(SERIES, +N) > fred(SERIES, 0) for macro, or iv(SUBJECT, +N) > T for IV.`
      : "";

  let stageGoal = "Synthesize the final sourced research-only JSON report including predictions.";
  if (stage === "specialist-analysis") {
    stageGoal =
      "Extract sourced thesis points, catalysts, risks, and evidence gaps from the collected sources.";
  } else if (stage === "critique") {
    stageGoal =
      "Challenge the specialist analysis for missing evidence, alternative explanations, and weak claims without adding new facts.";
  }

  return JSON.stringify(
    {
      instruction: baseInstruction + predictionInstruction,
      stage,
      stageGoal,
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
