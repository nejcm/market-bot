import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config";
import { resolveRunParams, type ResolvedRunParams } from "../config/runs";
import type { ResearchCommand } from "../cli/args";
import type { LoadedPrompt, StageLabel } from "./prompt-loader";
import { type EvidenceRequestToolName, type MarketRegimeSummary } from "../domain/types";
import { dedupeSourceGaps, sourceGapReportText } from "../domain/source-gaps";
import { rankMovers } from "../movers/ranking";
import { isRecord, readNumber, readString } from "../sources/guards";
import type { CollectedSources } from "../sources/types";
import { brierSkillScore } from "../scoring/calibration";
import type { CalibrationBin, CalibrationMetric, CalibrationSummary } from "../scoring/types";
import type { HistoricalResearchContext } from "./historical-context";
import type { MarketUpdateDelta } from "./market-update-delta";
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

// Loaded from data/calibration/summary.json, which is written as a CalibrationSummary.
// All fields optional because the file is read from disk and may be absent or partial.
export type CalibrationContext = Partial<CalibrationSummary>;

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
  // Carrier only — deterministic post-hoc delta, not added to the model evidence payload.
  readonly marketUpdateDelta?: MarketUpdateDelta;
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
            ? "Weekly equity mover universe is seeded from Yahoo day_gainers, day_losers, and most_actives — a single-day multi-screener set, not a true trailing 5-session mover screener"
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
    return parseCalibrationContext(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

// Domain invariants the producer guarantees (see src/scoring/calibration.ts).
// These are enforced at the untrusted disk boundary, not assumed.
// Finite-but-impossible values like hitRate 1.5 or negative counts are dropped.
function isProbability(value: number): boolean {
  return value >= 0 && value <= 1;
}

function isCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveCount(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

// Brier skill vs the always-0.5 baseline. Binary Brier in [0, 1] bounds the skill to [-3, 1].
// Values outside that range are impossible and dropped.
function isBrierSkill(value: number): boolean {
  return value >= -3 && value <= 1;
}

function readNumberWhere(
  record: Record<string, unknown>,
  key: string,
  predicate: (value: number) => boolean,
): number | undefined {
  const value = readNumber(record, key);
  return value !== undefined && predicate(value) ? value : undefined;
}

// Runtime schema validation at the disk boundary: summary.json is untrusted on read.
// Malformed or schema-drifted fields are dropped rather than cast through with `as`.
// Mirrors the custom-validation pattern in src/report/schema.ts (no Zod, per ADR 0003).
export function parseCalibrationContext(value: unknown): CalibrationContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const generatedAt = readString(value, "generatedAt");
  const resolvedCount = readNumberWhere(value, "resolvedCount", isCount);
  const brierScore = readNumberWhere(value, "brierScore", isProbability);
  const brierSkill = readNumberWhere(value, "brierSkillScore", isBrierSkill);
  const bins = Array.isArray(value.bins)
    ? value.bins.flatMap((bin) => {
        const parsed = parseCalibrationBin(bin);
        return parsed === undefined ? [] : [parsed];
      })
    : undefined;
  const byKind = parseMetricMap(value.byKind);
  const byAssetClass = parseMetricMap(value.byAssetClass);
  const byJobType = parseMetricMap(value.byJobType);
  const byMarketUpdateCadence = parseMetricMap(value.byMarketUpdateCadence);
  const byHorizonBucket = parseMetricMap(value.byHorizonBucket);
  return {
    ...(generatedAt !== undefined ? { generatedAt } : {}),
    ...(resolvedCount !== undefined ? { resolvedCount } : {}),
    ...(brierScore !== undefined ? { brierScore } : {}),
    ...(brierSkill !== undefined ? { brierSkillScore: brierSkill } : {}),
    ...(bins !== undefined ? { bins } : {}),
    ...(byKind !== undefined ? { byKind } : {}),
    ...(byAssetClass !== undefined ? { byAssetClass } : {}),
    ...(byJobType !== undefined ? { byJobType } : {}),
    ...(byMarketUpdateCadence !== undefined ? { byMarketUpdateCadence } : {}),
    ...(byHorizonBucket !== undefined ? { byHorizonBucket } : {}),
  };
}

function parseCalibrationBin(value: unknown): CalibrationBin | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pLow = readNumberWhere(value, "pLow", isProbability);
  const pHigh = readNumberWhere(value, "pHigh", isProbability);
  const label = readString(value, "label");
  const hitCount = readNumberWhere(value, "hitCount", isCount);
  const totalCount = readNumberWhere(value, "totalCount", isPositiveCount);
  const hitRate = readNumberWhere(value, "hitRate", isProbability);
  if (
    pLow === undefined ||
    pHigh === undefined ||
    label === undefined ||
    hitCount === undefined ||
    totalCount === undefined ||
    hitRate === undefined ||
    pLow >= pHigh ||
    hitCount > totalCount
  ) {
    return undefined;
  }
  return { pLow, pHigh, label, hitCount, totalCount, hitRate };
}

function parseCalibrationMetric(value: unknown): CalibrationMetric | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const brierScore = readNumberWhere(value, "brierScore", isProbability);
  const count = readNumberWhere(value, "count", isPositiveCount);
  if (brierScore === undefined || count === undefined) {
    return undefined;
  }
  return { brierScore, count };
}

function parseMetricMap(value: unknown): Record<string, CalibrationMetric> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([key, raw]) => {
    const metric = parseCalibrationMetric(raw);
    return metric === undefined ? [] : [[key, metric] as const];
  });
  return Object.fromEntries(entries);
}

function formatSkill(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

// Render a per-slice calibration section (by kind / by horizon) as a directive. Each slice shows
// Brier skill vs the always-0.5 baseline so the model sees where it currently has no edge.
function renderMetricSlice(
  lines: string[],
  title: string,
  metricsByKey: Record<string, CalibrationMetric> | undefined,
): void {
  const entries = metricsByKey === undefined ? [] : Object.entries(metricsByKey);
  if (entries.length === 0) {
    return;
  }
  lines.push(`${title} (Brier skill vs always-0.5; negative means worse than a coin flip):`);
  for (const [key, metric] of entries) {
    lines.push(
      `  ${key}: skill ${formatSkill(brierSkillScore(metric.brierScore))} (Brier ${metric.brierScore.toFixed(3)}, n=${String(metric.count)})`,
    );
  }
}

function buildCalibrationBlock(calibration: CalibrationContext | undefined): string | undefined {
  if (calibration === undefined) {
    return undefined;
  }
  const lines: string[] = [];
  if (typeof calibration.brierScore === "number") {
    lines.push(`Overall Brier score: ${calibration.brierScore.toFixed(3)} (lower is better)`);
    lines.push(
      `Brier skill vs always-0.5 baseline: ${formatSkill(brierSkillScore(calibration.brierScore))} (>0 beats always-stating-0.5, <0 is worse)`,
    );
  }
  if (typeof calibration.resolvedCount === "number") {
    lines.push(`Resolved predictions: ${calibration.resolvedCount}`);
  }
  if (Array.isArray(calibration.bins) && calibration.bins.length > 0) {
    lines.push("Bin summary (stated probability band vs actual hit rate):");
    for (const bin of calibration.bins) {
      const validBin = parseCalibrationBin(bin);
      if (validBin !== undefined) {
        lines.push(
          `  ${validBin.label}: actual hit ${validBin.hitRate.toFixed(2)} (n=${String(validBin.totalCount)})`,
        );
      }
    }
  }
  const beforeSlices = lines.length;
  renderMetricSlice(lines, "Per-kind calibration", calibration.byKind);
  renderMetricSlice(lines, "Per-horizon calibration", calibration.byHorizonBucket);
  if (lines.length > beforeSlices) {
    lines.push(
      "In any slice with negative skill, shade probabilities toward base rates: there you are currently worse than always stating 0.5.",
    );
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

// ---------------------------------------------------------------------------
// Prior-thesis error correction (audit finding #11)
//
// For ticker runs, surfaces prior predictions on the current instrument that resolved as misses, framed as explicit error-correction signal rather than a passive citation pool.
// The model is told to diagnose why each prior thesis failed before restating a similar view.
// The block is omitted entirely when no prior prediction on the instrument resolved as a miss, so empty history renders cleanly with no placeholder noise.
// ---------------------------------------------------------------------------

const MAX_PRIOR_MISS_BULLETS = 5;

interface PriorMiss {
  readonly runId: string;
  readonly generatedAt: string;
  readonly claim: string;
  readonly probability: number;
  readonly sourceId: string;
  readonly evidence?: Record<string, number | string>;
}

function collectPriorMisses(
  command: ResearchCommand,
  historicalContext: HistoricalResearchContext | undefined,
): readonly PriorMiss[] {
  if (command.jobType !== "ticker" || historicalContext === undefined) {
    return [];
  }
  const symbol = command.symbol.toUpperCase();
  const misses: PriorMiss[] = [];
  for (const run of historicalContext.runs) {
    if (run.symbol?.toUpperCase() !== symbol) {
      continue;
    }
    for (const prediction of run.predictions) {
      if (prediction.scoreOutcome !== "miss") {
        continue;
      }
      misses.push({
        runId: run.runId,
        generatedAt: run.generatedAt,
        claim: prediction.claim,
        probability: prediction.probability,
        sourceId: run.sourceId,
        ...(prediction.scoreEvidence !== undefined ? { evidence: prediction.scoreEvidence } : {}),
      });
    }
  }
  return misses
    .toSorted(
      (left, right) => generatedAtValue(right.generatedAt) - generatedAtValue(left.generatedAt),
    )
    .slice(0, MAX_PRIOR_MISS_BULLETS);
}

// Parse an ISO timestamp to epoch ms for ordering, tolerating malformed values (generatedAt is read
// From disk without format validation). Non-parseable timestamps sort oldest rather than crashing.
function generatedAtValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Collapse any newlines/tabs in free-form prior claim text so a single bullet stays a single line
// And cannot inject extra apparent bullets into the prompt block.
function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

// Render compacted resolution evidence as a single ` (observed k=v …)` segment, so the model sees
// How wrong a prior thesis was, not just that it missed. Numbers get bounded precision; strings are
// Single-lined against bullet injection. Returns "" when there is nothing to show.
function formatObservedEvidence(evidence: Record<string, number | string> | undefined): string {
  if (evidence === undefined) {
    return "";
  }
  const parts = Object.entries(evidence).map(([key, value]) => {
    const rendered =
      typeof value === "number" ? String(Math.round(value * 10_000) / 10_000) : singleLine(value);
    return `${singleLine(key)}=${rendered}`;
  });
  return parts.length === 0 ? "" : ` (observed ${parts.join(" ")})`;
}

function buildPriorThesisErrorBlock(
  command: ResearchCommand,
  historicalContext: HistoricalResearchContext | undefined,
): string | undefined {
  const misses = collectPriorMisses(command, historicalContext);
  // Second jobType narrowing is deliberate, not a duplicate of collectPriorMisses: it lets TS prove
  // Command.symbol exists below, and guards command.symbol access if collectPriorMisses is ever
  // Relaxed to non-ticker runs. Do not remove.
  if (misses.length === 0 || command.jobType !== "ticker") {
    return undefined;
  }
  const symbol = command.symbol.toUpperCase();
  const lines = [
    `Prior predictions on ${symbol} that resolved MISS. Treat each as error-correction signal: diagnose why the prior thesis was wrong before restating a similar view, and widen probabilities where the same setup recurs.`,
  ];
  for (const miss of misses) {
    const date = miss.generatedAt.slice(0, 10);
    lines.push(
      `  - run ${miss.runId} (${date}): claimed "${singleLine(miss.claim)}" at stated p=${miss.probability.toFixed(2)}, resolved MISS${formatObservedEvidence(miss.evidence)} — cite ${miss.sourceId}`,
    );
  }
  return lines.join("\n");
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

// Config-driven mover cap for the command's asset class. Shared so the orchestrator's
// Market-update mover set matches the ranked movers handed to the model.
export function moverLimitFor(command: ResearchCommand, config: AppConfig): number {
  return command.assetClass === "equity"
    ? config.sourceOptions.equityMoverLimit
    : config.sourceOptions.cryptoMoverLimit;
}

function buildEvidencePayload(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  config: AppConfig,
  context: ResearchContext,
): Record<string, unknown> {
  const movers = rankMovers(
    collectedSources.marketSnapshots.filter(
      (snapshot) => snapshot.assetClass === command.assetClass,
    ),
    moverLimitFor(command, config),
  );
  const calibrationBlock = buildCalibrationBlock(context.calibrationContext);
  const priorThesisErrors = buildPriorThesisErrorBlock(command, context.historicalContext);

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
    ...(priorThesisErrors !== undefined ? { priorThesisErrors } : {}),
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
  const exampleSubject = depthProfile.predictionSubjects[0] ?? "SPY";
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
      subject: exampleSubject,
      measurableAs: `close(${exampleSubject}, +${String(depthProfile.defaultPredictionHorizon)}) > close(${exampleSubject}, 0)`,
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
