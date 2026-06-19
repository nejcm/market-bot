import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config";
import { resolveRunParams, type ForecastKindMix, type ResolvedRunParams } from "../config/runs";
import type { ResearchCommand } from "../cli/args";
import type { LoadedPrompt, StageLabel } from "./prompt-loader";
import { dedupeSourceGaps, sourceGapReportText } from "../domain/source-gaps";
import { marketUpdateHorizonBucketOf, marketUpdateHorizonOf } from "../domain/types";
import { rankMovers } from "../movers/ranking";
import { isRecord, readNumber, readString } from "../sources/guards";
import type { CollectedSources } from "../sources/types";
import {
  missingVerifiedSnapshotGapText,
  verifiedSnapshotCitationRule,
  verifiedSnapshotSourceId,
} from "./verified-snapshot-contract";
import { MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS } from "../forecast/observable";
import { brierSkillScore } from "../scoring/calibration";
import type { CalibrationBin, CalibrationMetric } from "../scoring/types";
import type {
  HistoricalPredictionSummary,
  HistoricalResearchContext,
  HistoricalRunContext,
} from "./historical-context";
import type { LoadedPlaybook, PlaybookCandidate, PlaybookStage } from "./playbooks";
import type {
  CalibrationContext,
  DepthProfile,
  EvidenceRequestContext,
  ResearchContext,
} from "./research-context-types";
import {
  commandResearchSubjectIdentity,
  isSameResearchSubjectIdentity,
} from "./research-subject-identity";
import { resolveResearchSubjectProxy } from "./subject-registry";
import type { SpotlightCandidate, SpotlightSelectionResult } from "./spotlights";

export type { CalibrationContext, DepthProfile, EvidenceRequestContext, ResearchContext };

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
  const marketUpdateHorizon = marketUpdateHorizonOf(command);
  const overviewMoverGaps =
    marketUpdateHorizon !== undefined && marketUpdateHorizon > 5
      ? [
          command.assetClass === "equity"
            ? "Market overview mover universe is seeded from Yahoo day_gainers, day_losers, and most_actives — a single-day multi-screener set, not a trailing horizon mover screener"
            : "Market overview crypto mover data uses CoinGecko 24h change fields; trailing horizon mover changes are not available in the current source payload",
        ]
      : [];

  const verifiedSnapshotGaps =
    command.jobType === "ticker" &&
    command.assetClass === "equity" &&
    collectedSources.verifiedMarketSnapshot === undefined
      ? [missingVerifiedSnapshotGapText(command.symbol)]
      : [];

  // Research subject: flag representative instruments with no live market snapshot so the
  // Model can cite the gap instead of silently substituting a mover (Phase 2.2).
  const researchRepresentativeGaps: string[] = [];
  if (command.jobType === "research") {
    const resolution = resolveResearchSubjectProxy(command.subject);
    if (resolution.subject !== undefined) {
      const liveSymbols = new Set(
        collectedSources.marketSnapshots.map((s) => s.symbol.toUpperCase()),
      );
      for (const instrument of resolution.subject.representativeInstruments) {
        if (!liveSymbols.has(instrument.symbol.toUpperCase())) {
          const label =
            instrument.name !== undefined
              ? `${instrument.name} (${instrument.symbol})`
              : instrument.symbol;
          researchRepresentativeGaps.push(
            `researchRepresentative: no live market snapshot for representative ${label}; cite the registry sourceId instead`,
          );
        }
      }
    }
  }

  return [
    ...gaps,
    ...marketGaps,
    ...newsGaps,
    ...tickerGaps,
    ...overviewMoverGaps,
    ...verifiedSnapshotGaps,
    ...researchRepresentativeGaps,
  ];
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
  const missAutopsyCount = readNumberWhere(value, "missAutopsyCount", isCount);
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
  const byMarketUpdateHorizonBucket =
    parseMetricMap(value.byMarketUpdateHorizonBucket) ??
    parseMetricMap(value.byMarketUpdateCadence);
  const byHorizonBucket = parseMetricMap(value.byHorizonBucket);
  const byMissAutopsyCause = parseCountMap(value.byMissAutopsyCause);
  const conditionalPredictions = parseConditionalCalibrationSummary(value.conditionalPredictions);
  return {
    ...(generatedAt !== undefined ? { generatedAt } : {}),
    ...(resolvedCount !== undefined ? { resolvedCount } : {}),
    ...(missAutopsyCount !== undefined ? { missAutopsyCount } : {}),
    ...(brierScore !== undefined ? { brierScore } : {}),
    ...(brierSkill !== undefined ? { brierSkillScore: brierSkill } : {}),
    ...(bins !== undefined ? { bins } : {}),
    ...(byKind !== undefined ? { byKind } : {}),
    ...(byAssetClass !== undefined ? { byAssetClass } : {}),
    ...(byJobType !== undefined ? { byJobType } : {}),
    ...(byMarketUpdateHorizonBucket !== undefined ? { byMarketUpdateHorizonBucket } : {}),
    ...(byHorizonBucket !== undefined ? { byHorizonBucket } : {}),
    ...(byMissAutopsyCause !== undefined ? { byMissAutopsyCause } : {}),
    ...(conditionalPredictions !== undefined ? { conditionalPredictions } : {}),
  };
}

function parseConditionalCalibrationSummary(
  value: unknown,
): CalibrationContext["conditionalPredictions"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const activatedCount = readNumberWhere(value, "activatedCount", isCount);
  const voidedCount = readNumberWhere(value, "voidedCount", isCount);
  if (activatedCount === undefined || voidedCount === undefined) {
    return undefined;
  }
  return { activatedCount, voidedCount };
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

function parseCountMap(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([key, raw]) =>
    typeof raw === "number" && isCount(raw) ? [[key, raw] as const] : [],
  );
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
  if (calibration.conditionalPredictions !== undefined) {
    lines.push(
      `Conditional Predictions: ${String(calibration.conditionalPredictions.activatedCount)} activated, ${String(calibration.conditionalPredictions.voidedCount)} voided/excluded`,
    );
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

function missFrom(run: HistoricalRunContext, prediction: HistoricalPredictionSummary): PriorMiss {
  return {
    runId: run.runId,
    generatedAt: run.generatedAt,
    claim: prediction.claim,
    probability: prediction.probability,
    sourceId: run.sourceId,
    ...(prediction.scoreEvidence !== undefined ? { evidence: prediction.scoreEvidence } : {}),
  };
}

function sortedRecentMisses(misses: readonly PriorMiss[]): readonly PriorMiss[] {
  return misses
    .toSorted(
      (left, right) => generatedAtValue(right.generatedAt) - generatedAtValue(left.generatedAt),
    )
    .slice(0, MAX_PRIOR_MISS_BULLETS);
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
      if (prediction.scoreOutcome === "miss") {
        misses.push(missFrom(run, prediction));
      }
    }
  }
  return sortedRecentMisses(misses);
}

// Market subjects can be single series (SPY, ^VIX, DGS10) or relative pairs
// (QQQ:SPY). A prior forecast is eligible only when every subject leg is one of
// The configured market subjects; this avoids pulling ticker-specific pairs
// Like SPY:AAPL into market-update correction.
function isConfiguredMarketSubject(subject: string, subjectKeys: ReadonlySet<string>): boolean {
  const subjectParts = subject
    .split(":")
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length > 0);
  return subjectParts.length > 0 && subjectParts.every((part) => subjectKeys.has(part));
}

function historicalRunHorizonBucket(run: HistoricalRunContext): string | undefined {
  // The run context carries no horizonTradingDays, so market-overview history
  // Resolves its bucket from the persisted extras; legacy daily/weekly falls
  // Back to the canonical derivation.
  if (typeof run.keyExtras?.marketUpdateHorizonBucket === "string") {
    return run.keyExtras.marketUpdateHorizonBucket;
  }
  return marketUpdateHorizonBucketOf(run);
}

// Market-scoped sibling of collectPriorMisses (ADR 0015): for market-overview runs,
// Gathers resolved misses from prior same-horizon, same-asset market-update runs
// Whose prediction subject is one of the command's configured market subjects
// (index/macro), so the forecast can learn from prior market-scoped errors. The
// JobType filter alone already excludes spotlight ticker misses (jobType "ticker").
function collectMarketForecastMisses(
  command: ResearchCommand,
  historicalContext: HistoricalResearchContext | undefined,
  predictionSubjects: readonly string[],
): readonly PriorMiss[] {
  if (
    (command.jobType !== "market-overview" &&
      command.jobType !== "daily" &&
      command.jobType !== "weekly") ||
    historicalContext === undefined
  ) {
    return [];
  }
  const subjectKeys = new Set(predictionSubjects.map((subject) => subject.trim().toUpperCase()));
  const commandBucket = marketUpdateHorizonBucketOf(command);
  const misses: PriorMiss[] = [];
  for (const run of historicalContext.runs) {
    if (
      run.assetClass !== command.assetClass ||
      historicalRunHorizonBucket(run) !== commandBucket
    ) {
      continue;
    }
    for (const prediction of run.predictions) {
      if (
        prediction.scoreOutcome === "miss" &&
        isConfiguredMarketSubject(prediction.subject, subjectKeys)
      ) {
        misses.push(missFrom(run, prediction));
      }
    }
  }
  return sortedRecentMisses(misses);
}

function isSameResearchRun(run: HistoricalRunContext, command: ResearchCommand): boolean {
  if (command.jobType !== "research" || run.jobType !== "research") {
    return false;
  }
  return isSameResearchSubjectIdentity(commandResearchSubjectIdentity(command), run);
}

function collectResearchForecastMisses(
  command: ResearchCommand,
  historicalContext: HistoricalResearchContext | undefined,
): readonly PriorMiss[] {
  if (command.jobType !== "research" || historicalContext === undefined) {
    return [];
  }
  const proxy = commandResearchSubjectIdentity(command).predictionProxySymbol;
  if (proxy === undefined) {
    return [];
  }
  const misses: PriorMiss[] = [];
  for (const run of historicalContext.runs) {
    if (run.assetClass !== command.assetClass || !isSameResearchRun(run, command)) {
      continue;
    }
    for (const prediction of run.predictions) {
      if (prediction.scoreOutcome === "miss" && prediction.subject.toUpperCase() === proxy) {
        misses.push(missFrom(run, prediction));
      }
    }
  }
  return sortedRecentMisses(misses);
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
  return value.replaceAll(/\s+/gu, " ").trim();
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

function renderMissBullet(miss: PriorMiss): string {
  const date = miss.generatedAt.slice(0, 10);
  return `  - run ${miss.runId} (${date}): claimed "${singleLine(miss.claim)}" at stated p=${miss.probability.toFixed(2)}, resolved MISS${formatObservedEvidence(miss.evidence)} — cite ${miss.sourceId}`;
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
  return [
    `Prior predictions on ${symbol} that resolved MISS. Treat each as error-correction signal: diagnose why the prior thesis was wrong before restating a similar view, and widen probabilities where the same setup recurs.`,
    ...misses.map((miss) => renderMissBullet(miss)),
  ].join("\n");
}

// Market-scoped counterpart of the ticker instrument block (ADR 0015): for
// Market-overview runs, surfaces prior MISS forecasts on the command's configured
// Market subjects (index/macro) so the model corrects market-scoped errors. The
// Ticker instrument block stays untouched; spotlight ticker misses are excluded
// By the same-horizon filter in collectMarketForecastMisses.
function buildMarketForecastErrorBlock(
  command: ResearchCommand,
  context: ResearchContext,
): string | undefined {
  const misses = collectMarketForecastMisses(
    command,
    context.historicalContext,
    context.depthProfile.predictionSubjects,
  );
  if (misses.length === 0) {
    return undefined;
  }
  return [
    `Prior market-overview forecasts on configured market subjects that resolved MISS. Treat each as error-correction signal: diagnose why the prior market read was wrong before restating a similar view, and widen probabilities where the same regime setup recurs.`,
    ...misses.map((miss) => renderMissBullet(miss)),
  ].join("\n");
}

function buildResearchForecastErrorBlock(
  command: ResearchCommand,
  historicalContext: HistoricalResearchContext | undefined,
): string | undefined {
  const misses = collectResearchForecastMisses(command, historicalContext);
  if (misses.length === 0 || command.jobType !== "research") {
    return undefined;
  }
  const identity = commandResearchSubjectIdentity(command);
  const subjectKey = identity.subjectKey ?? command.subject;
  const proxy = identity.predictionProxySymbol;
  return [
    `Prior research forecasts on ${subjectKey}${proxy === undefined ? "" : ` (${proxy})`} that resolved MISS. Treat each as thematic error-correction signal: diagnose why the prior segment read was wrong before restating a similar view, and widen probabilities where the same subject setup recurs.`,
    ...misses.map((miss) => renderMissBullet(miss)),
  ].join("\n");
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
    targetPredictions: params.targetPredictions,
    defaultPredictionHorizon: params.defaultPredictionHorizon,
    predictionSubjects: params.predictionSubjects,
    focus: params.focus,
    targetKindMix: params.targetKindMix,
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
  const priorMarketForecastErrors = buildMarketForecastErrorBlock(command, context);
  const priorThematicForecastErrors = buildResearchForecastErrorBlock(
    command,
    context.historicalContext,
  );

  // Compact verified snapshot for prompts: latest OHLCV, indicators, recent closes only.
  // The full bar series stays on disk (rawSnapshots / normalized sidecar).
  const verifiedMarketSnapshotBlock =
    collectedSources.verifiedMarketSnapshot !== undefined
      ? {
          verifiedMarketSnapshot: collectedSources.verifiedMarketSnapshot,
          verifiedMarketSnapshotSourceId: verifiedSnapshotSourceId(
            collectedSources.verifiedMarketSnapshot.symbol,
          ),
          verifiedMarketSnapshotCitationRule: verifiedSnapshotCitationRule(
            collectedSources.verifiedMarketSnapshot.symbol,
          ),
        }
      : {};

  const resolvedIdentityBlock =
    collectedSources.resolvedInstrumentIdentity !== undefined
      ? {
          resolvedInstrumentIdentity: collectedSources.resolvedInstrumentIdentity,
          resolvedIdentityInstruction:
            "This is the canonical instrument identity for this run. Use this identity; do not substitute a different company.",
        }
      : {};

  // Research subject: surface registry representatives + provenance in the evidence payload
  // So the model quotes named representatives instead of generic movers (Phase 2.2).
  const registrySubjectBlock: Record<string, unknown> = {};
  if (command.jobType === "research") {
    const resolution = resolveResearchSubjectProxy(command.subject);
    if (resolution.subject !== undefined) {
      const liveSymbols = new Set(
        collectedSources.marketSnapshots.map((s) => s.symbol.toUpperCase()),
      );
      const entry = resolution.subject;
      registrySubjectBlock.registrySubject = {
        subjectKey: entry.subjectKey,
        displayName: entry.displayName,
        representativeInstruments: entry.representativeInstruments.map((instrument) => ({
          symbol: instrument.symbol,
          ...(instrument.name !== undefined ? { name: instrument.name } : {}),
          instrumentType: instrument.instrumentType,
          sourceIds: instrument.sourceIds,
          hasLiveSnapshot: liveSymbols.has(instrument.symbol.toUpperCase()),
        })),
        provenanceSources: entry.sources.map((src) => ({
          sourceId: src.sourceId,
          title: src.title,
          ...(src.url !== undefined ? { url: src.url } : {}),
        })),
        ...(entry.predictionProxy !== undefined
          ? { predictionProxy: { symbol: entry.predictionProxy.symbol } }
          : {}),
        instruction:
          "Quote the named representative instruments and cite their sourceIds in findings and predictions. Prefer registry representatives over generic market movers for this subject.",
      };
    }
  }

  return {
    command,
    ...userSteeringField(command),
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
    ...(priorMarketForecastErrors !== undefined ? { priorMarketForecastErrors } : {}),
    ...(priorThematicForecastErrors !== undefined ? { priorThematicForecastErrors } : {}),
    ...verifiedMarketSnapshotBlock,
    ...resolvedIdentityBlock,
    ...registrySubjectBlock,
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
    predictions: Array.from({ length: depthProfile.targetPredictions }, (_, idx) => ({
      id: `pred-${String(idx + 1)}`,
      kind: "direction|relative|volatility|range|macro|iv|conditional",
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

// Bounded steering field shared by the spotlight-selection and final-synthesis
// Stages so an optional market-overview prompt steers both (A3) without
// Replacing the deterministic market overview evidence.
function userSteeringField(command: ResearchCommand): Record<string, unknown> {
  if (command.jobType !== "market-overview" || command.prompt === undefined) {
    return {};
  }
  return {
    userSteeringPrompt: {
      text: command.prompt,
      instruction:
        "Use this as steering for spotlight selection and final synthesis. Do not replace the deterministic market overview evidence.",
    },
  };
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
      ...userSteeringField(command),
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

// ---------------------------------------------------------------------------
// Prediction-kind mix guidance (audit finding #10 — emission policy)
//
// Soft guidance only: steers `final-synthesis` toward the run type's favored,
// More-informative kinds (e.g. `relative`, `macro`, `range`) instead of
// Leaning on bare `direction`, whose short-horizon base rate sits near 0.5.
// Not a validation gate — no reprompt branch reads this.
// ---------------------------------------------------------------------------

function buildKindMixGuidance(mix: ForecastKindMix): string {
  const favored = mix.favored.join(", ");
  const floor =
    mix.minNonDirection !== undefined && mix.minNonDirection > 0
      ? ` Aim for at least ${String(mix.minNonDirection)} prediction(s) using a kind other than \`direction\` where the evidence supports it.`
      : "";
  return ` Favor more informative forecast kinds in this priority order where the evidence supports them: ${favored}. Use bare \`direction\` only when no better-measured kind fits the available evidence — its short-horizon base rate sits near a coin flip.${floor}`;
}

function buildPredictionRepairInstruction(context: ResearchContext): string {
  const subjects = context.depthProfile.predictionSubjects.join(", ");
  const favoredKinds = context.depthProfile.targetKindMix.favored.join(", ");
  return `Return a complete final report with a valid predictions array, fixing the flagged predictions. Do not omit the predictions array, and do not return a partial patch. The array may hold fewer than ${String(context.depthProfile.targetPredictions)} predictions when the evidence does not support more — do not pad with coin-flips to reach a count. Make every prediction distinct: replace any dropped near-duplicate rather than re-emitting it. Prefer replacement forecasts using these subjects: ${subjects}; favor these kinds when supported: ${favoredKinds}. For ticker relative forecasts, use subject form TICKER:BENCHMARK. For range forecasts, vary the horizon or range bounds when another range forecast already covers the same subject and horizon. Keep two direction calls on the same subject at least ${String(MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS)} trading days apart — otherwise vary the subject, kind, or horizon.`;
}

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
  const conditionalPredictionInstruction =
    stage === "final-synthesis" && command.depth === "deep"
      ? " Deep runs may use Conditional Predictions with measurableAs syntax if (<existing expression>) then (<existing expression>) when evidence supports a conditional setup. For conditional predictions, kind is conditional, subject and horizonTradingDays come from the consequent, the antecedent horizon must be earlier than the consequent horizon, and probability means P(consequent | antecedent). Do not nest conditionals."
      : "";
  const predictionInstruction =
    stage === "final-synthesis"
      ? ` Emit up to ${String(context.depthProfile.targetPredictions)} predictions using subjects from predictionSubjects and a default horizon near ${String(context.depthProfile.defaultPredictionHorizon)} trading days. The count is a target, not a quota: emit a prediction only where the evidence supports a directional lean. Prefer fewer high-conviction forecasts over padding to the target, and never emit a coin-flip (probability near 0.5) just to reach a count. Do not write a claim field; it is rendered deterministically from measurableAs. Each prediction must use the measurableAs DSL: close(SUBJECT, +N) > close(SUBJECT, 0) for direction, close(A, +N)/close(A, 0) > close(B, +N)/close(B, 0) for relative, max(close(^VIX), 0..+N) > T for volatility, close(SUBJECT, +N) outside [Lo, Hi] for range, fred(SERIES, +N) > fred(SERIES, 0) for macro, or iv(SUBJECT, +N) > T for IV. probability is the probability that the measurableAs expression evaluates TRUE. The grammar only expresses up/outside; to express a bearish or stays-within-range view, set probability below 0.5 on the up/outside expression.${conditionalPredictionInstruction}${buildKindMixGuidance(context.depthProfile.targetKindMix)}`
      : "";
  const predictionRepair =
    stage === "final-synthesis" && predictionRepromptErrors.length > 0
      ? { instruction: buildPredictionRepairInstruction(context) }
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
        ? { predictionRepromptErrors, predictionRepair }
        : {}),
      ...(reportValidationErrors.length > 0 ? { reportValidationErrors, allowedSourceIds } : {}),
      requiredShape,
    },
    undefined,
    2,
  );
}
