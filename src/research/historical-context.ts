import type { ResearchCommand } from "../cli/args";
import { historyOptions, type AppConfig, type HistoryOptions } from "../config";
import type {
  AssetClass,
  EvidenceQuality,
  JobType,
  KeyFinding,
  MarketSnapshot,
  MarketUpdateJobType,
  ResearchReport,
  Source,
} from "../domain/types";
import { scanRunArtifacts, type RunArtifactScan } from "../run-artifacts";
import type { PredictionScore } from "../scoring/types";
import { isRecord, readNumber, readString, stringArrayValue } from "../sources/guards";

// Recency reasons answer "why was this run in the time window" (sliding-recent vs point anchor).
// Relevance reasons answer "why is this run topically on-point for the current command": ticker
// History for the command's own instrument ("same-symbol") or a selected market-update spotlight
// ("spotlight-symbol"), and market-update history matching the command's daily/weekly cadence
// ("same-cadence") or the other cadence for the same asset ("cross-cadence").
export type HistoricalRecencyReason = "recent" | `anchor-${number}m`;
export type HistoricalRelevanceReason =
  | "same-symbol"
  | "spotlight-symbol"
  | "same-cadence"
  | "cross-cadence";
export type HistoricalSelectionReason = HistoricalRecencyReason | HistoricalRelevanceReason;

export interface HistoricalPredictionSummary {
  readonly id: string;
  readonly claim: string;
  readonly subject: string;
  readonly horizonTradingDays: number;
  readonly probability: number;
  readonly scoreStatus: "not-scored" | "unresolved" | "resolved";
  readonly scoreOutcome?: "hit" | "miss";
  // Observed resolution values for misses only (e.g. { close0, closeN }). Kept lean so the prior-
  // Thesis error-correction block can show how wrong a prior thesis was, not just that it missed.
  readonly scoreEvidence?: Record<string, number | string>;
}

export interface HistoricalNumericSnapshot {
  readonly symbol: string;
  readonly price: number;
  readonly changePercent24h: number;
  readonly volume: number;
  readonly observedAt: string;
  readonly benchmarkSymbol?: string;
  readonly benchmarkChangePercent24h?: number;
}

export interface HistoricalRunContext {
  readonly runId: string;
  readonly sourceId: string;
  readonly jobType: JobType;
  readonly assetClass: AssetClass;
  readonly symbol?: string;
  readonly generatedAt: string;
  readonly selectionReasons: readonly HistoricalSelectionReason[];
  readonly summary: string;
  readonly confidence: EvidenceQuality;
  readonly keyFindings: readonly KeyFinding[];
  readonly risks: readonly KeyFinding[];
  readonly catalysts: readonly KeyFinding[];
  readonly dataGaps: readonly string[];
  readonly predictions: readonly HistoricalPredictionSummary[];
  readonly scoreSummary: {
    readonly total: number;
    readonly resolved: number;
    readonly hit: number;
    readonly miss: number;
    readonly unresolved: number;
  };
  readonly marketSnapshots: readonly HistoricalNumericSnapshot[];
  readonly keyExtras?: Record<string, unknown>;
}

export interface HistoricalResearchContext {
  readonly generatedAt: string;
  readonly recentDays: number;
  readonly anchorMonths: readonly number[];
  readonly runs: readonly HistoricalRunContext[];
  readonly sources: readonly Source[];
  readonly gaps: readonly string[];
  readonly audit: HistoricalContextAudit;
  readonly artifactDeltas: readonly HistoricalArtifactDelta[];
}

export interface HistoricalContextAudit {
  readonly scannedRunCount: number;
  readonly malformedRunCount: number;
  readonly malformedScoreCount: number;
  readonly candidateRunCount: number;
  readonly selectedRunCount: number;
  readonly recentSelectedCount: number;
  readonly anchorSelectedCount: number;
  // Relevance-lane and correction-input visibility (Cross-run Intelligence hardening). These make
  // The deterministic prior-state selection auditable from the trace without re-deriving it.
  readonly sameSymbolSelectedCount: number;
  readonly spotlightSymbolSelectedCount: number;
  readonly sameCadenceSelectedCount: number;
  readonly crossCadenceSelectedCount: number;
  // Selected runs carrying at least one resolved miss — the population the prior-miss correction
  // Blocks draw from (ticker instrument errors / market-scoped forecast errors).
  readonly resolvedMissRunCount: number;
  // Total disclosed historical/cross-run gaps, including non-data gaps such as an unreadable
  // Alpha-search watchlist surfaced here rather than as a live SourceGap.
  readonly gapCount: number;
}

export interface HistoricalArtifactDelta {
  readonly symbol: string;
  readonly fromRunId: string;
  readonly toRunId: string;
  readonly fromGeneratedAt: string;
  readonly toGeneratedAt: string;
  readonly priceChangePercent: number;
  readonly changePercent24hDelta: number;
}

interface HistoricalArtifact {
  readonly runDirName: string;
  readonly report: ResearchReport;
  readonly snapshots: readonly HistoricalNumericSnapshot[];
  readonly scores: readonly PredictionScore[];
}

interface SelectedArtifact {
  readonly artifact: HistoricalArtifact;
  readonly reasons: readonly HistoricalSelectionReason[];
}

interface ScanResult {
  readonly artifacts: readonly HistoricalArtifact[];
  readonly scannedRunCount: number;
  readonly malformedRunCount: number;
  readonly malformedScoreCount: number;
}

export interface LoadHistoricalContextInput {
  readonly dataDir: string;
  readonly command: ResearchCommand;
  readonly config: Pick<AppConfig, "historyOptions">;
  readonly now?: Date;
  readonly spotlightSymbols?: readonly string[];
  // Non-data gaps owned by the cross-run/historical channel (e.g. an unreadable alpha-search
  // Watchlist). Surfaced through historicalContext.gaps instead of the live SourceGap stream.
  readonly extraGaps?: readonly string[];
}

export interface HistoricalContextReader {
  readonly load: (
    input: Omit<LoadHistoricalContextInput, "dataDir">,
  ) => Promise<HistoricalResearchContext>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_LIMIT = 8;

function isMarketUpdateJobType(value: JobType): value is MarketUpdateJobType {
  return value === "daily" || value === "weekly";
}

// Project the reader's full MarketSnapshot down to the compact numeric shape the
// Historical context exposes, keeping only the benchmark fields it surfaces.
function toHistoricalSnapshot(snapshot: MarketSnapshot): HistoricalNumericSnapshot {
  const benchmarkSymbol = snapshot.benchmark?.symbol;
  const benchmarkChange = snapshot.benchmark?.changePercent24h;
  return {
    symbol: snapshot.symbol.toUpperCase(),
    price: snapshot.price,
    changePercent24h: snapshot.changePercent24h,
    volume: snapshot.volume,
    observedAt: snapshot.observedAt,
    ...(typeof benchmarkSymbol === "string" && benchmarkSymbol.trim() !== ""
      ? { benchmarkSymbol }
      : {}),
    ...(typeof benchmarkChange === "number" && Number.isFinite(benchmarkChange)
      ? { benchmarkChangePercent24h: benchmarkChange }
      : {}),
  };
}

// Adapt the shared Run Artifact scan into this module's selection inputs. Audit
// Counts are derived from per-run statuses to preserve prior behavior exactly:
// Report-absent dirs are not "scanned"; malformed score is counted only for
// Runs whose report loaded.
function toScanResult(scan: RunArtifactScan): ScanResult {
  return {
    artifacts: scan.artifacts.map((artifact) => ({
      runDirName: artifact.runDirName,
      report: artifact.report,
      snapshots: artifact.marketSnapshots.map(toHistoricalSnapshot),
      scores: artifact.scores,
    })),
    scannedRunCount: scan.entries.filter((entry) => entry.status.report !== "absent").length,
    malformedRunCount: scan.entries.filter((entry) => entry.status.report === "malformed").length,
    malformedScoreCount: scan.artifacts.filter((artifact) => artifact.status.score === "malformed")
      .length,
  };
}

function generatedAtMs(artifact: HistoricalArtifact): number {
  const parsed = Date.parse(artifact.report.generatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function subtractMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() - months);
  return next;
}

function sortNewest(left: HistoricalArtifact, right: HistoricalArtifact): number {
  return (
    generatedAtMs(right) - generatedAtMs(left) ||
    right.report.runId.localeCompare(left.report.runId)
  );
}

function sortPreferredCadence(
  preferred: MarketUpdateJobType | undefined,
): (left: HistoricalArtifact, right: HistoricalArtifact) => number {
  return (left, right) => {
    if (preferred !== undefined) {
      const leftPreferred = left.report.jobType === preferred;
      const rightPreferred = right.report.jobType === preferred;
      if (leftPreferred !== rightPreferred) {
        return leftPreferred ? -1 : 1;
      }
    }
    return sortNewest(left, right);
  };
}

function selectArtifacts(input: {
  readonly candidates: readonly HistoricalArtifact[];
  readonly limit: number;
  readonly options: HistoryOptions;
  readonly now: Date;
  readonly preferredCadence?: MarketUpdateJobType;
}): readonly SelectedArtifact[] {
  const { candidates, limit, options, now, preferredCadence } = input;
  const selected = new Map<string, HistoricalSelectionReason[]>();
  const cutoffMs = now.getTime() - options.recentDays * DAY_MS;
  const sort = sortPreferredCadence(preferredCadence);

  for (const artifact of candidates
    .filter((candidate) => generatedAtMs(candidate) >= cutoffMs)
    .toSorted(sort)
    .slice(0, limit)) {
    selected.set(artifact.report.runId, ["recent"]);
  }

  for (const anchorMonth of options.anchorMonths) {
    const targetMs = subtractMonths(now, anchorMonth).getTime();
    const anchor = candidates
      .filter((candidate) => generatedAtMs(candidate) <= targetMs)
      .toSorted(sort)
      .at(0);
    if (anchor === undefined) {
      continue;
    }
    selected.set(anchor.report.runId, [
      ...(selected.get(anchor.report.runId) ?? []),
      `anchor-${anchorMonth}m`,
    ]);
  }

  const result: SelectedArtifact[] = [];
  for (const [runId, reasons] of selected.entries()) {
    const artifact = candidates.find((candidate) => candidate.report.runId === runId);
    if (artifact !== undefined) {
      result.push({
        artifact,
        reasons: [...new Set(reasons)],
      });
    }
  }
  return result.toSorted((left, right) => sortNewest(left.artifact, right.artifact));
}

function scoreSummary(scores: readonly PredictionScore[]): HistoricalRunContext["scoreSummary"] {
  const resolved = scores.filter((score) => score.resolved);
  const hit = resolved.filter((score) => score.outcome === "hit").length;
  const miss = resolved.filter((score) => score.outcome === "miss").length;
  return {
    total: scores.length,
    resolved: resolved.length,
    hit,
    miss,
    unresolved: scores.length - resolved.length,
  };
}

// Resolution evidence is read from disk as Record<string, unknown> and varies by forecast kind.
// Keep only primitive number/string fields, capped, so the prior-miss block stays decoupled from
// Per-kind evidence schemas. Returns undefined when nothing usable survives.
const SCORE_EVIDENCE_KEY_LIMIT = 6;

function compactScoreEvidence(
  evidence: Record<string, unknown>,
): Record<string, number | string> | undefined {
  const result: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (Object.keys(result).length >= SCORE_EVIDENCE_KEY_LIMIT) {
      break;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    } else if (typeof value === "string") {
      result[key] = value;
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function predictionSummaries(
  report: ResearchReport,
  scores: readonly PredictionScore[],
): readonly HistoricalPredictionSummary[] {
  const scoreByPrediction = new Map(scores.map((score) => [score.predictionId, score]));
  return report.predictions.map((prediction) => {
    const score = scoreByPrediction.get(prediction.id);
    let scoreStatus: HistoricalPredictionSummary["scoreStatus"] = "not-scored";
    if (score !== undefined) {
      scoreStatus = score.resolved ? "resolved" : "unresolved";
    }
    const scoreEvidence =
      score?.outcome === "miss" ? compactScoreEvidence(score.evidence) : undefined;
    return {
      id: prediction.id,
      claim: prediction.claim,
      subject: prediction.subject,
      horizonTradingDays: prediction.horizonTradingDays,
      probability: prediction.probability,
      scoreStatus,
      ...(score?.outcome !== undefined ? { scoreOutcome: score.outcome } : {}),
      ...(scoreEvidence !== undefined ? { scoreEvidence } : {}),
    };
  });
}

function compactSnapshots(
  snapshots: readonly HistoricalNumericSnapshot[],
  symbols: ReadonlySet<string>,
): readonly HistoricalNumericSnapshot[] {
  const filtered =
    symbols.size === 0
      ? snapshots
      : snapshots.filter((snapshot) => symbols.has(snapshot.symbol.toUpperCase()));
  return filtered
    .toSorted(
      (left, right) =>
        Math.abs(right.changePercent24h) - Math.abs(left.changePercent24h) ||
        left.symbol.localeCompare(right.symbol),
    )
    .slice(0, SNAPSHOT_LIMIT);
}

function keyExtras(
  extras: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (extras === undefined) {
    return;
  }
  const result: Record<string, unknown> = {};
  if (typeof extras.depth === "string") {
    result.depth = extras.depth;
  }
  if (typeof extras.marketUpdateCadence === "string") {
    result.marketUpdateCadence = extras.marketUpdateCadence;
  }
  if (isRecord(extras.marketRegime)) {
    result.marketRegime = {
      label: readString(extras.marketRegime, "label"),
      proxyCount: readNumber(extras.marketRegime, "proxyCount"),
      drivers: stringArrayValue(extras.marketRegime.drivers),
    };
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function toRunContext(
  selected: SelectedArtifact,
  symbols: ReadonlySet<string>,
): HistoricalRunContext {
  const { report } = selected.artifact;
  const sourceId = `history-report-${report.runId}`;
  const extras = keyExtras(report.extras);
  return {
    runId: report.runId,
    sourceId,
    jobType: report.jobType,
    assetClass: report.assetClass,
    ...(report.symbol !== undefined ? { symbol: report.symbol } : {}),
    generatedAt: report.generatedAt,
    selectionReasons: selected.reasons,
    summary: report.summary,
    confidence: report.confidence,
    keyFindings: report.keyFindings.slice(0, 5),
    risks: report.risks.slice(0, 5),
    catalysts: report.catalysts.slice(0, 5),
    dataGaps: report.dataGaps.slice(0, 8),
    predictions: predictionSummaries(report, selected.artifact.scores),
    scoreSummary: scoreSummary(selected.artifact.scores),
    marketSnapshots: compactSnapshots(selected.artifact.snapshots, symbols),
    ...(extras !== undefined ? { keyExtras: extras } : {}),
  };
}

function historicalSource(run: HistoricalRunContext): Source {
  return {
    id: run.sourceId,
    title: `${run.jobType}${run.symbol === undefined ? "" : ` ${run.symbol}`} prior report`,
    fetchedAt: run.generatedAt,
    kind: "model",
    assetClass: run.assetClass,
    ...(run.symbol !== undefined ? { symbol: run.symbol } : {}),
    provider: "market-bot",
    rawRef: `${run.runId}/report.json`,
    summary: run.summary,
  };
}

function addSelections(
  selected: Map<string, SelectedArtifact>,
  selections: readonly SelectedArtifact[],
): void {
  for (const selection of selections) {
    const existing = selected.get(selection.artifact.report.runId);
    selected.set(selection.artifact.report.runId, {
      artifact: selection.artifact,
      reasons: [...new Set([...(existing?.reasons ?? []), ...selection.reasons])],
    });
  }
}

// Layers a topical relevance reason onto each selection's recency reasons
// (`recent`/`anchor-Nm`), without changing which runs were selected. `reasonFor`
// May return undefined to leave a selection's reasons untouched (e.g. market
// History pulled into a ticker/alpha-search command has no command cadence to
// Compare against).
function withRelevanceReasons(
  selections: readonly SelectedArtifact[],
  reasonFor: (artifact: HistoricalArtifact) => HistoricalRelevanceReason | undefined,
): readonly SelectedArtifact[] {
  return selections.map((selection) => {
    const reason = reasonFor(selection.artifact);
    return reason === undefined
      ? selection
      : { artifact: selection.artifact, reasons: [...new Set([...selection.reasons, reason])] };
  });
}

// `same-cadence` / `cross-cadence` only describe relevance to a daily/weekly
// Command — a command cadence is the basis for the comparison. Ticker and
// Alpha-search commands pull in market-update history for general regime
// Context, not cadence-matched forecasting context, so they get no cadence
// Relevance reason here (recency reasons still apply).
function marketCadenceReason(
  artifactJobType: JobType,
  commandJobType: JobType,
): HistoricalRelevanceReason | undefined {
  if (commandJobType !== "daily" && commandJobType !== "weekly") {
    return undefined;
  }
  return artifactJobType === commandJobType ? "same-cadence" : "cross-cadence";
}

function normalizedSymbols(symbols: readonly string[] | undefined): Set<string> {
  return new Set((symbols ?? []).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean));
}

function computeArtifactDeltas(
  runs: readonly HistoricalRunContext[],
): readonly HistoricalArtifactDelta[] {
  const marketRuns = runs
    .filter((run) => isMarketUpdateJobType(run.jobType))
    .toSorted((left, right) => left.generatedAt.localeCompare(right.generatedAt));
  const deltas: HistoricalArtifactDelta[] = [];

  for (let index = 1; index < marketRuns.length; index += 1) {
    const previous = marketRuns[index - 1];
    const current = marketRuns[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const previousBySymbol = new Map(
      previous.marketSnapshots.map((snapshot) => [snapshot.symbol, snapshot]),
    );
    for (const snapshot of current.marketSnapshots) {
      const prior = previousBySymbol.get(snapshot.symbol);
      if (prior === undefined || prior.price === 0) {
        continue;
      }
      deltas.push({
        symbol: snapshot.symbol,
        fromRunId: previous.runId,
        toRunId: current.runId,
        fromGeneratedAt: previous.generatedAt,
        toGeneratedAt: current.generatedAt,
        priceChangePercent:
          Math.round(((snapshot.price - prior.price) / prior.price) * 10_000) / 100,
        changePercent24hDelta:
          Math.round((snapshot.changePercent24h - prior.changePercent24h) * 100) / 100,
      });
    }
  }

  return deltas;
}

function buildHistoricalContext(
  input: LoadHistoricalContextInput,
  scan: ScanResult,
): HistoricalResearchContext {
  const options = historyOptions(input.config);
  const now = input.now ?? new Date();
  const selected = new Map<string, SelectedArtifact>();
  const candidateRunIds = new Set<string>();
  const gaps: string[] = [];
  const spotlightSymbols = normalizedSymbols(input.spotlightSymbols);
  const focusSymbols = new Set(spotlightSymbols);

  const sameAssetMarketRuns = scan.artifacts.filter(
    (artifact) =>
      isMarketUpdateJobType(artifact.report.jobType) &&
      artifact.report.assetClass === input.command.assetClass,
  );
  for (const artifact of sameAssetMarketRuns) {
    candidateRunIds.add(artifact.report.runId);
  }

  if (input.command.jobType === "ticker") {
    const commandSymbol = input.command.symbol.toUpperCase();
    focusSymbols.add(commandSymbol);
    const sameTickerRuns = scan.artifacts.filter(
      (artifact) =>
        artifact.report.jobType === "ticker" &&
        artifact.report.assetClass === input.command.assetClass &&
        artifact.report.symbol?.toUpperCase() === commandSymbol,
    );
    for (const artifact of sameTickerRuns) {
      candidateRunIds.add(artifact.report.runId);
    }
    if (sameTickerRuns.length === 0) {
      gaps.push(`No prior ticker runs found for ${input.command.symbol}`);
    }
    addSelections(
      selected,
      withRelevanceReasons(
        selectArtifacts({
          candidates: sameTickerRuns,
          limit: options.tickerRecentLimit,
          options,
          now,
        }),
        () => "same-symbol",
      ),
    );
  }

  if (sameAssetMarketRuns.length === 0) {
    gaps.push(`No prior ${input.command.assetClass} market-update runs found`);
  }
  addSelections(
    selected,
    withRelevanceReasons(
      selectArtifacts(
        input.command.jobType === "daily" || input.command.jobType === "weekly"
          ? {
              candidates: sameAssetMarketRuns,
              limit: options.marketRecentLimit,
              options,
              now,
              preferredCadence: input.command.jobType,
            }
          : {
              candidates: sameAssetMarketRuns,
              limit: options.marketRecentLimit,
              options,
              now,
            },
      ),
      (artifact) => marketCadenceReason(artifact.report.jobType, input.command.jobType),
    ),
  );

  // The spotlightSymbols input carries the spotlight candidate set during the
  // Pre-selection pass and the actually-selected spotlights afterward. The
  // `spotlight-symbol` reason therefore means "ticker history for a spotlight-
  // Candidate symbol"; only the post-selection context (or a market-only context
  // With no such reasons) reaches synthesis, so the persisted/trace label
  // Reflects selected spotlights.
  for (const symbol of spotlightSymbols) {
    const sameTickerRuns = scan.artifacts.filter(
      (artifact) =>
        artifact.report.jobType === "ticker" &&
        artifact.report.assetClass === input.command.assetClass &&
        artifact.report.symbol?.toUpperCase() === symbol,
    );
    for (const artifact of sameTickerRuns) {
      candidateRunIds.add(artifact.report.runId);
    }
    addSelections(
      selected,
      withRelevanceReasons(
        selectArtifacts({
          candidates: sameTickerRuns,
          limit: options.tickerRecentLimit,
          options,
          now,
        }),
        () => "spotlight-symbol",
      ),
    );
  }

  if (scan.malformedRunCount > 0) {
    gaps.push(`Skipped ${String(scan.malformedRunCount)} malformed historical report artifact(s)`);
  }
  // Non-data gaps owned by this channel (e.g. an unreadable alpha-search watchlist),
  // Surfaced here rather than as a live SourceGap — see LoadHistoricalContextInput.extraGaps.
  gaps.push(...(input.extraGaps ?? []));

  const runs = [...selected.values()]
    .map((selection) => toRunContext(selection, focusSymbols))
    .toSorted((left, right) => right.generatedAt.localeCompare(left.generatedAt));

  return {
    generatedAt: now.toISOString(),
    recentDays: options.recentDays,
    anchorMonths: options.anchorMonths,
    runs,
    sources: runs.map((run) => historicalSource(run)),
    gaps,
    audit: {
      scannedRunCount: scan.scannedRunCount,
      malformedRunCount: scan.malformedRunCount,
      malformedScoreCount: scan.malformedScoreCount,
      candidateRunCount: candidateRunIds.size,
      selectedRunCount: runs.length,
      recentSelectedCount: runs.filter((run) => run.selectionReasons.includes("recent")).length,
      anchorSelectedCount: runs.filter((run) =>
        run.selectionReasons.some((reason) => reason.startsWith("anchor-")),
      ).length,
      sameSymbolSelectedCount: runs.filter((run) => run.selectionReasons.includes("same-symbol"))
        .length,
      spotlightSymbolSelectedCount: runs.filter((run) =>
        run.selectionReasons.includes("spotlight-symbol"),
      ).length,
      sameCadenceSelectedCount: runs.filter((run) => run.selectionReasons.includes("same-cadence"))
        .length,
      crossCadenceSelectedCount: runs.filter((run) =>
        run.selectionReasons.includes("cross-cadence"),
      ).length,
      resolvedMissRunCount: runs.filter((run) => run.scoreSummary.miss > 0).length,
      gapCount: gaps.length,
    },
    artifactDeltas: computeArtifactDeltas(runs),
  };
}

export async function createHistoricalContextReader(
  dataDir: string,
): Promise<HistoricalContextReader> {
  const scan = toScanResult(await scanRunArtifacts(dataDir));
  return {
    load: async (input) => buildHistoricalContext({ ...input, dataDir }, scan),
  };
}

export async function loadHistoricalContext(
  input: LoadHistoricalContextInput,
): Promise<HistoricalResearchContext> {
  const scan = toScanResult(await scanRunArtifacts(input.dataDir));
  return buildHistoricalContext(input, scan);
}
