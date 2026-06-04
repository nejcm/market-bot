import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchCommand } from "../cli/args";
import { historyOptions, type AppConfig, type HistoryOptions } from "../config";
import type {
  AssetClass,
  EvidenceQuality,
  JobType,
  KeyFinding,
  MarketUpdateJobType,
  Prediction,
  ResearchReport,
  Source,
} from "../domain/types";
import type { PredictionScore } from "../scoring/types";
import {
  isRecord,
  nonEmptyStringArrayValue,
  readNumber,
  readString,
  stringArrayValue,
} from "../sources/guards";

export type HistoricalSelectionReason = "recent" | `anchor-${number}m`;

export interface HistoricalPredictionSummary {
  readonly id: string;
  readonly claim: string;
  readonly subject: string;
  readonly horizonTradingDays: number;
  readonly probability: number;
  readonly scoreStatus: "not-scored" | "unresolved" | "resolved";
  readonly scoreOutcome?: "hit" | "miss";
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
}

export interface HistoricalContextReader {
  readonly load: (
    input: Omit<LoadHistoricalContextInput, "dataDir">,
  ) => Promise<HistoricalResearchContext>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_LIMIT = 8;

function isAssetClass(value: unknown): value is AssetClass {
  return value === "equity" || value === "crypto";
}

function isJobType(value: unknown): value is JobType {
  return value === "daily" || value === "weekly" || value === "ticker" || value === "alpha-search";
}

function isEvidenceQuality(value: unknown): value is EvidenceQuality {
  return value === "high" || value === "medium" || value === "low";
}

function isMarketUpdateJobType(value: JobType): value is MarketUpdateJobType {
  return value === "daily" || value === "weekly";
}

function readFindings(value: unknown): readonly KeyFinding[] {
  return Array.isArray(value)
    ? value
        .map((item): KeyFinding | undefined => {
          if (!isRecord(item) || typeof item.text !== "string") {
            return undefined;
          }
          return {
            text: item.text,
            sourceIds: nonEmptyStringArrayValue(item.sourceIds),
          };
        })
        .filter((item): item is KeyFinding => item !== undefined)
    : [];
}

function readPredictions(value: unknown): readonly Prediction[] {
  return Array.isArray(value)
    ? value
        .map((item): Prediction | undefined => {
          if (
            !isRecord(item) ||
            typeof item.id !== "string" ||
            typeof item.claim !== "string" ||
            typeof item.subject !== "string" ||
            typeof item.measurableAs !== "string" ||
            typeof item.horizonTradingDays !== "number" ||
            typeof item.probability !== "number"
          ) {
            return undefined;
          }
          return {
            id: item.id,
            claim: item.claim,
            kind: item.kind === "relative" ? "relative" : "direction",
            subject: item.subject,
            measurableAs: item.measurableAs,
            horizonTradingDays: item.horizonTradingDays,
            probability: item.probability,
            sourceIds: nonEmptyStringArrayValue(item.sourceIds),
          };
        })
        .filter((item): item is Prediction => item !== undefined)
    : [];
}

function readReport(value: unknown): ResearchReport | undefined {
  if (!isRecord(value) || !isJobType(value.jobType) || !isAssetClass(value.assetClass)) {
    return;
  }

  const runId = readString(value, "runId");
  const generatedAt = readString(value, "generatedAt");
  if (runId === undefined || generatedAt === undefined) {
    return;
  }

  return {
    runId,
    jobType: value.jobType,
    assetClass: value.assetClass,
    ...(typeof value.symbol === "string" ? { symbol: value.symbol.toUpperCase() } : {}),
    generatedAt,
    summary: readString(value, "summary") ?? "",
    keyFindings: readFindings(value.keyFindings),
    bullCase: readFindings(value.bullCase),
    bearCase: readFindings(value.bearCase),
    risks: readFindings(value.risks),
    catalysts: readFindings(value.catalysts),
    scenarios: [],
    confidence: isEvidenceQuality(value.confidence) ? value.confidence : "low",
    dataGaps: stringArrayValue(value.dataGaps),
    predictions: readPredictions(value.predictions),
    sources: [],
    notFinancialAdvice: true,
    ...(isRecord(value.extras) ? { extras: value.extras } : {}),
  };
}

function readScores(value: unknown): readonly PredictionScore[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.scores)) {
    return;
  }

  return value.scores
    .map((item): PredictionScore | undefined => {
      if (
        !isRecord(item) ||
        typeof item.predictionId !== "string" ||
        typeof item.runId !== "string" ||
        typeof item.resolved !== "boolean" ||
        typeof item.attemptCount !== "number" ||
        !isRecord(item.evidence)
      ) {
        return undefined;
      }
      return {
        predictionId: item.predictionId,
        runId: item.runId,
        resolved: item.resolved,
        outcome: item.outcome === "hit" || item.outcome === "miss" ? item.outcome : undefined,
        observedAt: typeof item.observedAt === "string" ? item.observedAt : undefined,
        attemptCount: item.attemptCount,
        evidence: item.evidence,
      };
    })
    .filter((item): item is PredictionScore => item !== undefined);
}

function readSnapshots(value: unknown): readonly HistoricalNumericSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): HistoricalNumericSnapshot | undefined => {
      if (!isRecord(item)) {
        return undefined;
      }
      const symbol = readString(item, "symbol");
      const price = readNumber(item, "price");
      const changePercent24h = readNumber(item, "changePercent24h");
      const volume = readNumber(item, "volume");
      const observedAt = readString(item, "observedAt");
      if (
        symbol === undefined ||
        price === undefined ||
        changePercent24h === undefined ||
        volume === undefined ||
        observedAt === undefined
      ) {
        return undefined;
      }
      const benchmark = isRecord(item.benchmark) ? item.benchmark : undefined;
      const benchmarkSymbol = benchmark === undefined ? undefined : readString(benchmark, "symbol");
      const benchmarkChangePercent24h =
        benchmark === undefined ? undefined : readNumber(benchmark, "changePercent24h");
      return {
        symbol: symbol.toUpperCase(),
        price,
        changePercent24h,
        volume,
        observedAt,
        ...(benchmarkSymbol !== undefined ? { benchmarkSymbol } : {}),
        ...(benchmarkChangePercent24h !== undefined ? { benchmarkChangePercent24h } : {}),
      };
    })
    .filter((item): item is HistoricalNumericSnapshot => item !== undefined);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readArtifact(
  dataDir: string,
  runDirName: string,
): Promise<{
  readonly artifact?: HistoricalArtifact;
  readonly scannedRunCount: number;
  readonly malformedRunCount: number;
  readonly malformedScoreCount: number;
}> {
  const runDir = join(dataDir, runDirName);
  let reportRaw: unknown | undefined = undefined;
  try {
    reportRaw = await readJson(join(runDir, "report.json"));
  } catch {
    return {
      scannedRunCount: 1,
      malformedRunCount: 1,
      malformedScoreCount: 0,
    };
  }
  if (reportRaw === undefined) {
    return {
      scannedRunCount: 0,
      malformedRunCount: 0,
      malformedScoreCount: 0,
    };
  }

  const report = readReport(reportRaw);
  if (report === undefined) {
    return {
      scannedRunCount: 1,
      malformedRunCount: 1,
      malformedScoreCount: 0,
    };
  }

  let snapshotRaw: unknown | undefined = undefined;
  try {
    snapshotRaw = await readJson(join(runDir, "normalized", "market-snapshots.json"));
  } catch {
    snapshotRaw = undefined;
  }

  let scoreRaw: unknown | undefined = undefined;
  let malformedScoreCount = 0;
  try {
    scoreRaw = await readJson(join(runDir, "score.json"));
  } catch (error) {
    if (!(isRecord(error) && error.code === "ENOENT")) {
      malformedScoreCount = 1;
    }
  }
  const scores = scoreRaw === undefined ? [] : readScores(scoreRaw);
  if (scores === undefined) {
    malformedScoreCount = 1;
  }

  return {
    artifact: {
      runDirName,
      report,
      snapshots: readSnapshots(snapshotRaw),
      scores: scores ?? [],
    },
    scannedRunCount: 1,
    malformedRunCount: 0,
    malformedScoreCount,
  };
}

async function scanRunArtifacts(dataDir: string): Promise<ScanResult> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return {
        artifacts: [],
        scannedRunCount: 0,
        malformedRunCount: 0,
        malformedScoreCount: 0,
      };
    }
    throw error;
  }

  const results = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readArtifact(dataDir, entry.name)),
  );

  return {
    artifacts: results.flatMap((result) =>
      result.artifact === undefined ? [] : [result.artifact],
    ),
    scannedRunCount: results.reduce((total, result) => total + result.scannedRunCount, 0),
    malformedRunCount: results.reduce((total, result) => total + result.malformedRunCount, 0),
    malformedScoreCount: results.reduce((total, result) => total + result.malformedScoreCount, 0),
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
    return {
      id: prediction.id,
      claim: prediction.claim,
      subject: prediction.subject,
      horizonTradingDays: prediction.horizonTradingDays,
      probability: prediction.probability,
      scoreStatus,
      ...(score?.outcome !== undefined ? { scoreOutcome: score.outcome } : {}),
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
      selectArtifacts({
        candidates: sameTickerRuns,
        limit: options.tickerRecentLimit,
        options,
        now,
      }),
    );
  }

  if (sameAssetMarketRuns.length === 0) {
    gaps.push(`No prior ${input.command.assetClass} market-update runs found`);
  }
  addSelections(
    selected,
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
  );

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
      selectArtifacts({
        candidates: sameTickerRuns,
        limit: options.tickerRecentLimit,
        options,
        now,
      }),
    );
  }

  if (scan.malformedRunCount > 0) {
    gaps.push(`Skipped ${String(scan.malformedRunCount)} malformed historical report artifact(s)`);
  }

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
    },
    artifactDeltas: computeArtifactDeltas(runs),
  };
}

export async function createHistoricalContextReader(
  dataDir: string,
): Promise<HistoricalContextReader> {
  const scan = await scanRunArtifacts(dataDir);
  return {
    load: async (input) => buildHistoricalContext({ ...input, dataDir }, scan),
  };
}

export async function loadHistoricalContext(
  input: LoadHistoricalContextInput,
): Promise<HistoricalResearchContext> {
  const scan = await scanRunArtifacts(input.dataDir);
  return buildHistoricalContext(input, scan);
}
