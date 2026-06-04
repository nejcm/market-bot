import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config";
import { resolveRunParams, type ResolvedRunParams } from "../config/runs";
import type { ResearchCommand } from "../cli/args";
import type { LoadedPrompt, StageLabel } from "./prompt-loader";
import { type EvidenceRequestToolName, type MarketRegimeSummary } from "../domain/types";
import { dedupeSourceGaps, sourceGapReportText } from "../domain/source-gaps";
import { rankMovers } from "../movers/ranking";
import { isRecord } from "../sources/guards";
import type { CollectedSources } from "../sources/types";
import type { HistoricalResearchContext } from "./historical-context";
import type { LoadedPlaybook, PlaybookCandidate, PlaybookStage, StagePlaybooks } from "./playbooks";
import type { SpotlightCandidate, SpotlightSelectionResult } from "./spotlights";

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
  readonly runParams: ResolvedRunParams;
  readonly marketRegime: MarketRegimeSummary;
  readonly calibrationContext: CalibrationContext | undefined;
  readonly evidenceRequest?: EvidenceRequestContext;
  readonly domainPlaybooks?: readonly StagePlaybooks[];
  readonly historicalContext?: HistoricalResearchContext;
  readonly spotlightCandidates?: readonly SpotlightCandidate[];
  readonly spotlightSelection?: SpotlightSelectionResult;
}

export interface EvidenceRequestContext {
  readonly round: number;
  readonly availableTools: readonly EvidenceRequestToolName[];
  readonly toolUnits: Readonly<Record<EvidenceRequestToolName, number>>;
  readonly sourceUnitsUsed: number;
  readonly toolCallsUsed: number;
  readonly maxRounds: number;
  readonly maxToolCalls: number;
  readonly sourceBudget: number;
}

// ---------------------------------------------------------------------------
// Deterministic source gaps — disclosed in the prompt and in the final report
// ---------------------------------------------------------------------------

export function deterministicSourceGaps(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): readonly string[] {
  const gaps = dedupeSourceGaps(collectedSources.sourceGaps).map((gap) => sourceGapReportText(gap));
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

export function buildDepthProfileFromParams(
  command: ResearchCommand,
  params: ResolvedRunParams,
): DepthProfile {
  return {
    depth: command.depth,
    analystStyle: params.analystStyle,
    minimumKeyFindings: params.minimumKeyFindings,
    minimumScenarios: params.minimumScenarios,
    minimumPredictions: params.minimumPredictions,
    defaultPredictionHorizon: params.defaultPredictionHorizon,
    predictionSubjects: params.predictionSubjects,
    focus: params.focus,
  };
}

export function buildDepthProfile(command: ResearchCommand, appConfig: AppConfig): DepthProfile {
  return buildDepthProfileFromParams(command, resolveRunParams(command, appConfig));
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
    supplementalMarketSnapshots: collectedSources.supplementalMarketSnapshots,
    newsSources: collectedSources.newsSources,
    ...(collectedSources.marketContext !== undefined
      ? { marketContext: collectedSources.marketContext }
      : {}),
    ...(command.jobType === "ticker" && collectedSources.extendedEvidence !== undefined
      ? { extendedEvidence: collectedSources.extendedEvidence }
      : {}),
    ...(context.historicalContext !== undefined
      ? { historicalContext: compactHistoricalContext(context.historicalContext) }
      : {}),
    ...(context.spotlightCandidates !== undefined
      ? { spotlightCandidates: context.spotlightCandidates }
      : {}),
    ...(context.spotlightSelection !== undefined
      ? { spotlightSelection: compactSpotlightSelection(context.spotlightSelection) }
      : {}),
    ...(context.evidenceRequest !== undefined ? { evidenceRequest: context.evidenceRequest } : {}),
    sourceGaps: deterministicSourceGaps(command, collectedSources),
    ...(calibrationBlock !== undefined ? { priorCalibration: calibrationBlock } : {}),
  };
}

function compactHistoricalContext(context: HistoricalResearchContext): Record<string, unknown> {
  return {
    generatedAt: context.generatedAt,
    recentDays: context.recentDays,
    anchorMonths: context.anchorMonths,
    sourceIds: context.sources.map((source) => source.id),
    runs: context.runs,
    gaps: context.gaps,
    audit: context.audit,
    artifactDeltas: context.artifactDeltas,
  };
}

function compactSpotlightSelection(selection: SpotlightSelectionResult): Record<string, unknown> {
  return {
    ...(selection.rationale !== undefined ? { rationale: selection.rationale } : {}),
    selected: selection.selected.map((item) => ({
      symbol: item.symbol,
      rationale: item.rationale,
      sourceIds: item.sourceIds,
      candidateId: item.candidate.id,
    })),
    rejected: selection.rejected,
    audit: selection.audit,
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
    extras: {
      historicalContext: {
        summary: "string",
        sourceIds: ["history-report-run-id"],
        items: [{ text: "string", sourceIds: ["history-report-run-id"] }],
        gaps: ["string"],
      },
      spotlights: {
        items: [{ symbol: "string", rationale: "string", sourceIds: ["source-id"] }],
      },
    },
  };
}

function evidenceRequestShape(): Record<string, unknown> {
  return {
    requests: [
      {
        tool: "sec_latest_filing|tradier_iv_term_structure",
        args: { symbol: "run symbol only" },
        rationale: "string",
      },
    ],
  };
}

function playbookSelectionShape(): Record<string, unknown> {
  return {
    rationale: "short string",
    selections: [{ stage: "stage label", playbookIds: ["playbook-id"] }],
  };
}

function spotlightSelectionShape(): Record<string, unknown> {
  return {
    rationale: "short string",
    selections: [
      { symbol: "ticker", rationale: "string", sourceIds: ["current-market-source-id"] },
    ],
  };
}

function stagePlaybooks(
  stage: StageLabel,
  context: ResearchContext,
): readonly LoadedPlaybook[] | undefined {
  if (
    stage === "evidence-request" ||
    stage === "playbook-selection" ||
    stage === "spotlight-selection"
  ) {
    return undefined;
  }
  return context.domainPlaybooks?.find((entry) => entry.stage === stage)?.playbooks;
}

function evidenceCategories(
  collectedSources: CollectedSources,
  context?: ResearchContext,
): readonly string[] {
  const categories = new Set<string>();
  if (collectedSources.marketSnapshots.length > 0) {
    categories.add("market-data");
  }
  if (collectedSources.supplementalMarketSnapshots.length > 0) {
    categories.add("supplemental-market-data");
  }
  if (collectedSources.newsSources.length > 0) {
    categories.add("news");
  }
  if ((collectedSources.marketContext?.items ?? []).length > 0) {
    categories.add("market-context");
  }
  for (const item of collectedSources.extendedEvidence?.items ?? []) {
    categories.add(item.category);
  }
  if ((context?.historicalContext?.runs.length ?? 0) > 0) {
    categories.add("historical-context");
  }
  if ((context?.spotlightSelection?.selected.length ?? 0) > 0) {
    categories.add("market-spotlights");
  }
  return [...categories].toSorted();
}

export function buildPlaybookSelectionPrompt(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  context: ResearchContext,
  loaded: LoadedPrompt,
  plannedStages: readonly PlaybookStage[],
  candidates: readonly PlaybookCandidate[],
): string {
  return JSON.stringify(
    {
      instruction: loaded.instruction,
      stage: "playbook-selection",
      stageGoal: loaded.goal,
      command,
      depthProfile: context.depthProfile,
      plannedStages,
      candidates,
      marketRegime: { label: context.marketRegime.label },
      evidenceCategories: evidenceCategories(collectedSources, context),
      sourceGaps: deterministicSourceGaps(command, collectedSources),
      requiredShape: playbookSelectionShape(),
    },
    undefined,
    2,
  );
}

export function buildSpotlightSelectionPrompt(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  context: ResearchContext,
  loaded: LoadedPrompt,
  candidates: readonly SpotlightCandidate[],
  cap: number,
): string {
  return JSON.stringify(
    {
      instruction: loaded.instruction,
      stage: "spotlight-selection",
      stageGoal: loaded.goal,
      command,
      depthProfile: context.depthProfile,
      selectionCap: cap,
      candidates,
      marketRegime: { label: context.marketRegime.label },
      historicalContext:
        context.historicalContext === undefined
          ? undefined
          : compactHistoricalContext(context.historicalContext),
      evidenceCategories: evidenceCategories(collectedSources, context),
      sourceGaps: deterministicSourceGaps(command, collectedSources),
      requiredShape: spotlightSelectionShape(),
    },
    undefined,
    2,
  );
}

// ---------------------------------------------------------------------------
// Stage prompt
// ---------------------------------------------------------------------------

export function buildStagePrompt(
  stage: StageLabel,
  command: ResearchCommand,
  collectedSources: CollectedSources,
  config: AppConfig,
  context: ResearchContext,
  loaded: LoadedPrompt,
  priorStages: readonly unknown[] = [],
  predictionRepromptErrors: readonly string[] = [],
  reportValidationErrors: readonly string[] = [],
  allowedSourceIds: readonly string[] = [],
): string {
  const predictionInstruction =
    stage === "final-synthesis"
      ? ` Emit exactly ${String(context.depthProfile.minimumPredictions)} predictions using subjects from predictionSubjects and a default horizon near ${String(context.depthProfile.defaultPredictionHorizon)} trading days. Each prediction must use the measurableAs DSL: close(SUBJECT, +N) > close(SUBJECT, 0) for direction, close(A, +N)/close(A, 0) > close(B, +N)/close(B, 0) for relative, max(close(^VIX), 0..+N) > T for volatility, close(SUBJECT, +N) outside [Lo, Hi] for range, fred(SERIES, +N) > fred(SERIES, 0) for macro, or iv(SUBJECT, +N) > T for IV.`
      : "";
  const predictionRepair =
    stage === "final-synthesis" && predictionRepromptErrors.length > 0
      ? {
          requiredPredictionCount: context.depthProfile.minimumPredictions,
          instruction: `Return a complete final report with exactly ${String(context.depthProfile.minimumPredictions)} valid predictions. Do not omit the predictions array, and do not return a partial patch.`,
        }
      : undefined;
  const requiredShape = (() => {
    if (stage === "evidence-request") {
      return evidenceRequestShape();
    }
    if (stage === "final-synthesis") {
      return finalReportShape(context.depthProfile);
    }
    return {
      findings: [{ text: "string", sourceIds: ["source-id"] }],
      dataGaps: ["string"],
    };
  })();
  const playbooks = stagePlaybooks(stage, context);

  return JSON.stringify(
    {
      instruction: loaded.instruction + predictionInstruction,
      stage,
      stageGoal: loaded.goal,
      depthProfile: context.depthProfile,
      evidence: buildEvidencePayload(command, collectedSources, config, context),
      ...(playbooks !== undefined && playbooks.length > 0 ? { domainPlaybooks: playbooks } : {}),
      priorStages,
      ...(predictionRepromptErrors.length > 0
        ? {
            predictionRepromptErrors,
            unmetMinimum: context.depthProfile.minimumPredictions,
            predictionRepair,
          }
        : {}),
      ...(reportValidationErrors.length > 0 ? { reportValidationErrors, allowedSourceIds } : {}),
      requiredShape,
    },
    undefined,
    2,
  );
}
