import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  researchReportEvidenceQuality,
  type AssetClass,
  type InstrumentIdentity,
  type JobType,
  type KeyFinding,
  type Prediction,
  type ResearchReport,
  type Source,
  type VerifiedMarketSnapshot,
} from "../domain/types";
import { instrumentsForMeasurableAs } from "../forecast/observable";
import { dataRootFromRunsDir } from "../data-paths";
import type { ModelProvider } from "../model/types";
import { withUntrustedModelInputRule } from "../model/trust-guard";
import { violatesResearchOnly } from "../domain/research-language";
import {
  buildReportSearchEntries,
  openQuestions,
  predictionClaim,
  REPORT_SEARCH_SECTIONS,
  type ReportSearchEntry,
} from "../report-search-entries";
import { scanRunArtifacts } from "../run-artifacts";
import { searchHistoryEntriesFromIndex } from "../run-artifact-index";
import { MUTABLE_SIDECARS, RUN_ARTIFACT_FILES } from "../run-artifact-layout";
import type { MissAutopsyEntry, PredictionScore } from "../scoring/types";
import { isRecord } from "../sources/guards";

export const HISTORY_SECTIONS = [...REPORT_SEARCH_SECTIONS, "fundamentals", "validation"] as const;

export type HistorySection = (typeof HISTORY_SECTIONS)[number];

export type ThesisScope = "instrument" | "market-update";

export interface HistorySearchFilters {
  readonly query: string;
  readonly symbol?: string;
  readonly assetClass?: AssetClass;
  readonly jobType?: JobType;
  readonly from?: string;
  readonly to?: string;
  readonly section?: HistorySection;
  readonly provider?: string;
  readonly limit?: number;
}

export interface HistorySearchEntry {
  readonly id: string;
  readonly runId: string;
  readonly generatedAt: string;
  readonly jobType: JobType;
  readonly assetClass: AssetClass;
  readonly symbol?: string;
  readonly instrumentKey?: string;
  readonly section: HistorySection;
  readonly label: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly provider?: string;
  readonly sourceKind?: string;
  readonly predictionId?: string;
}

export interface HistoryIndex {
  readonly version: 1 | 2 | 3;
  readonly generatedAt: string;
  readonly sourceRunCount: number;
  readonly malformedRunCount: number;
  readonly entries: readonly HistorySearchEntry[];
  readonly sourceRunIds?: readonly string[];
  readonly sourceSidecars?: readonly HistorySourceSidecar[];
}

interface HistorySourceSidecar {
  readonly runId: string;
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
}

export interface ResearchThesisState {
  readonly summary: string;
  readonly keyFindings: readonly KeyFinding[];
  readonly bullCase: readonly KeyFinding[];
  readonly bearCase: readonly KeyFinding[];
  readonly risks: readonly KeyFinding[];
  readonly catalysts: readonly KeyFinding[];
  readonly dataGaps: readonly string[];
  readonly predictions: readonly Prediction[];
  readonly openQuestions: readonly string[];
}

export interface InstrumentTimelineEntry {
  readonly runId: string;
  readonly generatedAt: string;
  readonly jobType: JobType;
  readonly assetClass: AssetClass;
  readonly symbol: string;
  readonly instrumentKey: string;
  readonly scope: ThesisScope;
  readonly confidence: string;
  readonly confidenceLegacy?: boolean;
  readonly thesis: ResearchThesisState;
  readonly sources: readonly Source[];
  readonly scores: readonly PredictionScore[];
  readonly missAutopsies: readonly MissAutopsyEntry[];
  readonly identity?: InstrumentIdentity;
  readonly verifiedMarketSnapshot?: VerifiedMarketSnapshot;
  readonly snapshots: readonly Record<string, unknown>[];
  readonly fundamentals: readonly Record<string, unknown>[];
  readonly validation: readonly Record<string, unknown>[];
}

export interface InstrumentTimeline {
  readonly version: 1;
  readonly generatedAt: string;
  readonly instrumentKey: string;
  readonly assetClass: AssetClass;
  readonly symbol: string;
  readonly entries: readonly InstrumentTimelineEntry[];
}

export interface HistoryRebuildResult {
  readonly historyDir: string;
  readonly indexPath: string;
  readonly instrumentCount: number;
  readonly sourceRunCount: number;
  readonly malformedRunCount: number;
}

export type HistoryRebuild = (dataDir: string, now?: Date) => Promise<HistoryRebuildResult>;

export interface ThesisDeltaInput {
  readonly dataDir: string;
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly since?: string;
  readonly to?: string;
  readonly narrative?: boolean;
  readonly provider?: ModelProvider;
  readonly model?: string;
  readonly now?: Date;
}

export interface ThesisDeltaSection {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface ThesisDelta {
  readonly version: 1;
  readonly generatedAt: string;
  readonly instrumentKey: string;
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly fromRunId: string;
  readonly toRunId: string;
  readonly fromGeneratedAt: string;
  readonly toGeneratedAt: string;
  readonly sections: Record<string, ThesisDeltaSection>;
  readonly narrative?: {
    readonly text: string;
    readonly model: string;
    readonly provider: string;
    readonly tokenEstimate: number;
    readonly costEstimateUsd?: number;
  };
}

const HISTORY_DIR = "history";
const INDEX_FILE = "index.json";
const HISTORY_INDEX_VERSION = 3;
const MAX_SEARCH_RESULTS = 100;

export function historyDir(dataDir: string): string {
  return join(dataRootFromRunsDir(dataDir), HISTORY_DIR);
}

export function instrumentKey(assetClass: AssetClass, symbol: string): string {
  return `${assetClass}:${symbol.toUpperCase()}`;
}

export function instrumentFileName(key: string): string {
  return `${key.replace(":", "-").replaceAll(/[^A-Z0-9._-]/giu, "_")}.json`;
}

async function sourceSidecarFingerprints(
  dataDir: string,
  runDirNames: readonly string[],
): Promise<readonly HistorySourceSidecar[]> {
  const sidecars = await Promise.all(
    runDirNames.flatMap((runId) =>
      MUTABLE_SIDECARS.map(async (path) => {
        const filePath = join(dataDir, runId, path);
        const metadata = await stat(filePath).catch(() => null);
        return metadata?.isFile() === true
          ? {
              runId,
              path: String(path),
              size: metadata.size,
              modifiedAt: metadata.mtimeMs,
            }
          : null;
      }),
    ),
  );
  return sidecars
    .filter((sidecar): sidecar is HistorySourceSidecar => sidecar !== null)
    .toSorted((left, right) =>
      `${left.runId}:${left.path}`.localeCompare(`${right.runId}:${right.path}`),
    );
}

function sidecarFingerprintMatches(
  current: readonly HistorySourceSidecar[],
  indexed: readonly HistorySourceSidecar[] | undefined,
): boolean {
  return JSON.stringify(current) === JSON.stringify(indexed ?? []);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function recordArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

export function reportInstrumentKeys(
  report: ResearchReport,
): readonly { key: string; symbol: string }[] {
  const symbols = new Set<string>();
  if (report.symbol !== undefined) {
    symbols.add(report.symbol.toUpperCase());
  }
  for (const source of report.sources) {
    if (source.symbol !== undefined && source.assetClass === report.assetClass) {
      symbols.add(source.symbol.toUpperCase());
    }
  }
  for (const prediction of report.predictions) {
    // Legacy malformed forecasts yield no instruments and must not poison timeline aggregation.
    for (const instrument of instrumentsForMeasurableAs(prediction.measurableAs)) {
      const symbol = instrument.trim();
      if (/^[A-Z0-9._-]+$/iu.test(symbol)) {
        symbols.add(symbol.toUpperCase());
      }
    }
  }
  return [...symbols].map((symbol) => ({ symbol, key: instrumentKey(report.assetClass, symbol) }));
}

function firstIdentity(report: ResearchReport, symbol: string): InstrumentIdentity | undefined {
  return report.sources.find(
    (source) => source.symbol?.toUpperCase() === symbol && source.identity !== undefined,
  )?.identity;
}

function thesisState(
  report: ResearchReport,
  scores: readonly PredictionScore[],
): ResearchThesisState {
  return {
    summary: report.summary,
    keyFindings: report.keyFindings,
    bullCase: report.bullCase,
    bearCase: report.bearCase,
    risks: report.risks,
    catalysts: report.catalysts,
    dataGaps: report.dataGaps,
    predictions: report.predictions,
    openQuestions: openQuestions(report, scores),
  };
}

function addEntry(
  entries: HistorySearchEntry[],
  report: ResearchReport,
  section: HistorySection,
  label: string,
  text: string,
  sourceIds: readonly string[] = [],
  extras: Partial<HistorySearchEntry> = {},
): void {
  if (text.trim() === "") {
    return;
  }
  const symbol = report.symbol?.toUpperCase();
  entries.push({
    id: `${report.runId}:${section}:${entries.length}`,
    runId: report.runId,
    generatedAt: report.generatedAt,
    jobType: report.jobType,
    assetClass: report.assetClass,
    ...(symbol !== undefined
      ? { symbol, instrumentKey: instrumentKey(report.assetClass, symbol) }
      : {}),
    section,
    label,
    text,
    sourceIds,
    ...extras,
  });
}

function historyEntryForReportEntry(entry: ReportSearchEntry, index: number): HistorySearchEntry {
  return {
    id: `${entry.runId}:${entry.section}:${String(index)}`,
    runId: entry.runId,
    generatedAt: entry.generatedAt,
    jobType: entry.jobType,
    assetClass: entry.assetClass,
    ...(entry.symbol !== undefined
      ? {
          symbol: entry.symbol,
          instrumentKey: instrumentKey(entry.assetClass, entry.symbol),
        }
      : {}),
    section: entry.section,
    label: entry.label,
    text: entry.text,
    sourceIds: entry.sourceIds,
    ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
    ...(entry.sourceKind !== undefined ? { sourceKind: entry.sourceKind } : {}),
    ...(entry.predictionId !== undefined ? { predictionId: entry.predictionId } : {}),
  };
}

function searchEntriesFor(
  report: ResearchReport,
  scores: readonly PredictionScore[],
  fundamentals: readonly Record<string, unknown>[],
  validation: readonly Record<string, unknown>[],
): readonly HistorySearchEntry[] {
  const entries = buildReportSearchEntries(report, scores, "history").map((entry, index) =>
    historyEntryForReportEntry(entry, index),
  );
  for (const [index, item] of fundamentals.entries()) {
    addEntry(
      entries,
      report,
      "fundamentals",
      `Fundamental evidence ${String(index + 1)}`,
      JSON.stringify(item),
    );
  }
  for (const [index, item] of validation.entries()) {
    addEntry(
      entries,
      report,
      "validation",
      `Validation ${String(index + 1)}`,
      JSON.stringify(item),
    );
  }
  return entries;
}

export interface LoadedHistoryRun {
  readonly report: ResearchReport;
  readonly scores: readonly PredictionScore[];
  readonly missAutopsies: readonly MissAutopsyEntry[];
  readonly verifiedMarketSnapshot?: VerifiedMarketSnapshot;
  readonly verifiedRepresentativeSnapshots?: readonly VerifiedMarketSnapshot[];
  readonly snapshots: readonly Record<string, unknown>[];
  readonly fundamentals: readonly Record<string, unknown>[];
  readonly validation: readonly Record<string, unknown>[];
}

interface HistoryRunSidecars {
  readonly snapshots: readonly Record<string, unknown>[];
  readonly fundamentals: readonly Record<string, unknown>[];
  readonly validation: readonly Record<string, unknown>[];
}

// Report and score come from the canonical Run Artifact seam (ADR 0002). The history-only
// Sidecars below — supplemental snapshot records (kept as Record so unknown provider fields
// Survive into timelines), SEC fundamentals, and alpha validation — have a single caller and
// Are read here, not folded into the shared bundle.
export async function loadRunSidecars(runDir: string): Promise<HistoryRunSidecars> {
  const supplementalSnapshots = recordArray(
    await readJson(join(runDir, RUN_ARTIFACT_FILES.supplementalMarketSnapshots)),
  );
  const fundamentals = recordArray(
    await readJson(join(runDir, RUN_ARTIFACT_FILES.secFundamentals)),
  );
  const validationFile = await readJson(join(runDir, RUN_ARTIFACT_FILES.alphaValidation));
  const validation = isRecord(validationFile) ? [validationFile] : recordArray(validationFile);
  return {
    snapshots: supplementalSnapshots,
    fundamentals,
    validation,
  };
}

export function buildInstrumentTimelines(
  runs: readonly LoadedHistoryRun[],
  generatedAt: string,
): readonly InstrumentTimeline[] {
  const timelines = new Map<string, InstrumentTimelineEntry[]>();

  for (const run of runs) {
    for (const { key, symbol } of reportInstrumentKeys(run.report)) {
      const current = timelines.get(key) ?? [];
      const identity = firstIdentity(run.report, symbol);
      const scope: ThesisScope =
        run.report.symbol !== undefined && run.report.symbol.toUpperCase() === symbol
          ? "instrument"
          : "market-update";
      const verifiedMarketSnapshot = [
        ...(run.verifiedMarketSnapshot === undefined ? [] : [run.verifiedMarketSnapshot]),
        ...(run.verifiedRepresentativeSnapshots ?? []),
      ].find((snapshot) => snapshot.symbol.toUpperCase() === symbol);
      current.push({
        runId: run.report.runId,
        generatedAt: run.report.generatedAt,
        jobType: run.report.jobType,
        assetClass: run.report.assetClass,
        symbol,
        instrumentKey: key,
        scope,
        confidence: researchReportEvidenceQuality(run.report),
        confidenceLegacy: run.report.evidenceQuality === undefined,
        thesis: thesisState(run.report, run.scores),
        sources: run.report.sources.filter(
          (source) => source.symbol === undefined || source.symbol.toUpperCase() === symbol,
        ),
        scores: run.scores,
        missAutopsies: run.missAutopsies,
        ...(identity !== undefined ? { identity } : {}),
        ...(verifiedMarketSnapshot !== undefined ? { verifiedMarketSnapshot } : {}),
        snapshots: run.snapshots.filter(
          (snapshot) => readString(snapshot, "symbol")?.toUpperCase() === symbol,
        ),
        fundamentals: run.fundamentals,
        validation: run.validation,
      });
      timelines.set(key, current);
    }
  }

  return [...timelines.entries()].map(([key, timelineEntries]) => {
    const colon = key.indexOf(":");
    const assetClass = key.slice(0, colon) as AssetClass;
    const symbol = key.slice(colon + 1);
    return {
      version: 1,
      generatedAt,
      instrumentKey: key,
      assetClass,
      symbol,
      entries: timelineEntries.toSorted((left, right) =>
        left.generatedAt.localeCompare(right.generatedAt),
      ),
    };
  });
}

export async function rebuildHistoryArtifacts(
  dataDir: string,
  now: Date = new Date(),
): Promise<HistoryRebuildResult> {
  const scan = await scanRunArtifacts(dataDir);
  const loaded: readonly LoadedHistoryRun[] = await Promise.all(
    scan.artifacts.map(async (artifact) => {
      const sidecars = await loadRunSidecars(join(dataDir, artifact.runDirName));
      return {
        report: artifact.report,
        scores: artifact.scores,
        missAutopsies: artifact.missAutopsies,
        ...(artifact.verifiedMarketSnapshot !== undefined
          ? { verifiedMarketSnapshot: artifact.verifiedMarketSnapshot }
          : {}),
        ...(artifact.verifiedRepresentativeSnapshots !== undefined
          ? { verifiedRepresentativeSnapshots: artifact.verifiedRepresentativeSnapshots }
          : {}),
        ...sidecars,
        snapshots: [
          ...artifact.marketSnapshots.map(
            (snapshot) => snapshot as unknown as Record<string, unknown>,
          ),
          ...sidecars.snapshots,
        ],
      };
    }),
  );
  // Stricter ADR 0002 counting: only report-present-but-broken dirs are "malformed";
  // Report-absent dirs are not counted (the prior local reader conflated the two).
  const malformedRunCount = scan.entries.filter(
    (entry) => entry.status.report === "malformed",
  ).length;
  const generatedAt = now.toISOString();
  const indexEntries = loaded.flatMap((run) =>
    searchEntriesFor(run.report, run.scores, run.fundamentals, run.validation),
  );
  const timelines = buildInstrumentTimelines(loaded, generatedAt);
  const sourceRunIds = scan.artifacts.map((artifact) => artifact.runDirName).toSorted();
  const sourceSidecars = await sourceSidecarFingerprints(dataDir, sourceRunIds);

  const dir = historyDir(dataDir);
  const instrumentsDir = join(dir, "instruments");
  await mkdir(instrumentsDir, { recursive: true });

  const index: HistoryIndex = {
    version: HISTORY_INDEX_VERSION,
    generatedAt,
    sourceRunCount: loaded.length,
    malformedRunCount,
    sourceRunIds,
    sourceSidecars,
    entries: indexEntries.toSorted((left, right) =>
      right.generatedAt.localeCompare(left.generatedAt),
    ),
  };
  const indexPath = join(dir, INDEX_FILE);
  await writeFile(indexPath, `${JSON.stringify(index, undefined, 2)}\n`, "utf8");

  await Promise.all(
    timelines.map((timeline) =>
      writeFile(
        join(instrumentsDir, instrumentFileName(timeline.instrumentKey)),
        `${JSON.stringify(timeline, undefined, 2)}\n`,
        "utf8",
      ),
    ),
  );

  return {
    historyDir: dir,
    indexPath,
    instrumentCount: timelines.length,
    sourceRunCount: loaded.length,
    malformedRunCount,
  };
}

async function readIndexForDrift(dataDir: string): Promise<HistoryIndex | undefined> {
  const path = join(historyDir(dataDir), INDEX_FILE);
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(
      `Unable to read derived history index: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error("Malformed derived history index; run `history rebuild`");
  }
  if (!isRecord(parsed) || ![1, 2, 3].includes(parsed.version as number)) {
    throw new Error("Unsupported derived history index schema; run `history rebuild`");
  }
  if (
    typeof parsed.generatedAt !== "string" ||
    typeof parsed.sourceRunCount !== "number" ||
    typeof parsed.malformedRunCount !== "number" ||
    !Array.isArray(parsed.entries)
  ) {
    throw new TypeError("Malformed derived history index; run `history rebuild`");
  }
  if (
    (parsed.version === 2 || parsed.version === 3) &&
    (!Array.isArray(parsed.sourceRunIds) ||
      !parsed.sourceRunIds.every((runId) => typeof runId === "string"))
  ) {
    throw new Error("Malformed derived history index; run `history rebuild`");
  }
  if (
    parsed.version === 3 &&
    (!Array.isArray(parsed.sourceSidecars) ||
      !parsed.sourceSidecars.every(
        (sidecar) =>
          isRecord(sidecar) &&
          typeof sidecar.runId === "string" &&
          typeof sidecar.path === "string" &&
          typeof sidecar.size === "number" &&
          typeof sidecar.modifiedAt === "number",
      ))
  ) {
    throw new Error("Malformed derived history index; run `history rebuild`");
  }
  return parsed as unknown as HistoryIndex;
}

export async function rebuildHistoryArtifactsIfStale(
  dataDir: string,
  now: Date = new Date(),
  rebuild: HistoryRebuild = rebuildHistoryArtifacts,
): Promise<HistoryRebuildResult | undefined> {
  const [index, scan] = await Promise.all([readIndexForDrift(dataDir), scanRunArtifacts(dataDir)]);
  const canonicalRunIds = scan.artifacts.map((artifact) => artifact.runDirName).toSorted();
  const sourceSidecars = await sourceSidecarFingerprints(dataDir, canonicalRunIds);
  const current =
    index?.version === HISTORY_INDEX_VERSION &&
    index.sourceRunIds !== undefined &&
    index.sourceRunIds.length === canonicalRunIds.length &&
    index.sourceRunIds.every((runId, position) => runId === canonicalRunIds[position]) &&
    sidecarFingerprintMatches(sourceSidecars, index.sourceSidecars);
  return current ? undefined : rebuild(dataDir, now);
}

async function readIndex(dataDir: string): Promise<HistoryIndex | undefined> {
  const parsed = await readJson(join(historyDir(dataDir), INDEX_FILE));
  return isRecord(parsed) &&
    (parsed.version === 1 || parsed.version === 2 || parsed.version === 3) &&
    Array.isArray(parsed.entries)
    ? (parsed as unknown as HistoryIndex)
    : undefined;
}

export async function searchHistoryIndex(
  dataDir: string,
  filters: HistorySearchFilters,
): Promise<readonly HistorySearchEntry[]> {
  const indexed = await searchHistoryEntriesFromIndex(dataDir, filters);
  if (indexed !== undefined) {
    return indexed;
  }

  const index = await readIndex(dataDir);
  if (index === undefined || filters.query.trim() === "") {
    return [];
  }
  const query = filters.query.toLowerCase();
  const symbol = filters.symbol?.toUpperCase();
  const provider = filters.provider?.toLowerCase();
  const limit = filters.limit ?? MAX_SEARCH_RESULTS;
  return index.entries
    .filter(
      (entry) =>
        entry.text.toLowerCase().includes(query) || entry.label.toLowerCase().includes(query),
    )
    .filter((entry) => symbol === undefined || entry.symbol?.toUpperCase() === symbol)
    .filter((entry) => filters.assetClass === undefined || entry.assetClass === filters.assetClass)
    .filter((entry) => filters.jobType === undefined || entry.jobType === filters.jobType)
    .filter((entry) => filters.section === undefined || entry.section === filters.section)
    .filter((entry) => provider === undefined || entry.provider?.toLowerCase() === provider)
    .filter(
      (entry) =>
        filters.from === undefined || entry.generatedAt.slice(0, 10) >= filters.from.slice(0, 10),
    )
    .filter(
      (entry) =>
        filters.to === undefined || entry.generatedAt.slice(0, 10) <= filters.to.slice(0, 10),
    )
    .slice(0, limit);
}

async function readTimeline(
  dataDir: string,
  assetClass: AssetClass,
  symbol: string,
): Promise<InstrumentTimeline | undefined> {
  const key = instrumentKey(assetClass, symbol);
  const parsed = await readJson(join(historyDir(dataDir), "instruments", instrumentFileName(key)));
  return isRecord(parsed) && parsed.version === 1
    ? (parsed as unknown as InstrumentTimeline)
    : undefined;
}

function chooseEntry(
  entries: readonly InstrumentTimelineEntry[],
  selector: string | undefined,
  fallback: "first" | "last",
): InstrumentTimelineEntry | undefined {
  if (entries.length === 0) {
    return;
  }
  if (selector === undefined) {
    return fallback === "first" ? entries[0] : entries.at(-1);
  }
  const normalized = selector.slice(0, 10);
  return (
    entries.find((entry) => entry.runId === selector) ??
    (fallback === "first"
      ? entries.find((entry) => entry.generatedAt.slice(0, 10) >= normalized)
      : entries.findLast((entry) => entry.generatedAt.slice(0, 10) <= normalized))
  );
}

function textSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.trim()).filter((value) => value !== ""));
}

function simpleDelta(before: readonly string[], after: readonly string[]): ThesisDeltaSection {
  const beforeSet = textSet(before);
  const afterSet = textSet(after);
  return {
    added: [...afterSet].filter((value) => !beforeSet.has(value)),
    removed: [...beforeSet].filter((value) => !afterSet.has(value)),
    changed:
      before.join("\n") !== after.join("\n") && before.length > 0 && after.length > 0
        ? ["Content changed"]
        : [],
  };
}

function findingTexts(items: readonly KeyFinding[]): readonly string[] {
  return items.map((item) => item.text);
}

function predictionTexts(items: readonly Prediction[]): readonly string[] {
  return items.map(
    (item) =>
      `${item.id}: ${predictionClaim(item)} (${item.measurableAs}, p=${item.probability.toFixed(2)}, ${String(
        item.horizonTradingDays,
      )} trading days)`,
  );
}

function scoreTexts(items: readonly PredictionScore[]): readonly string[] {
  return items.map(
    (item) =>
      `${item.predictionId}: ${item.resolved ? (item.outcome ?? "resolved-no-outcome") : "unresolved"}`,
  );
}

function buildDeltaSections(
  from: InstrumentTimelineEntry,
  to: InstrumentTimelineEntry,
): Record<string, ThesisDeltaSection> {
  return {
    summary: simpleDelta([from.thesis.summary], [to.thesis.summary]),
    keyFindings: simpleDelta(
      findingTexts(from.thesis.keyFindings),
      findingTexts(to.thesis.keyFindings),
    ),
    bullCase: simpleDelta(findingTexts(from.thesis.bullCase), findingTexts(to.thesis.bullCase)),
    bearCase: simpleDelta(findingTexts(from.thesis.bearCase), findingTexts(to.thesis.bearCase)),
    risks: simpleDelta(findingTexts(from.thesis.risks), findingTexts(to.thesis.risks)),
    catalysts: simpleDelta(findingTexts(from.thesis.catalysts), findingTexts(to.thesis.catalysts)),
    dataGaps: simpleDelta(from.thesis.dataGaps, to.thesis.dataGaps),
    openQuestions: simpleDelta(from.thesis.openQuestions, to.thesis.openQuestions),
    predictions: simpleDelta(
      predictionTexts(from.thesis.predictions),
      predictionTexts(to.thesis.predictions),
    ),
    scores: simpleDelta(scoreTexts(from.scores), scoreTexts(to.scores)),
    fundamentals: simpleDelta(
      from.fundamentals.map((item) => JSON.stringify(item)),
      to.fundamentals.map((item) => JSON.stringify(item)),
    ),
    validation: simpleDelta(
      from.validation.map((item) => JSON.stringify(item)),
      to.validation.map((item) => JSON.stringify(item)),
    ),
  };
}

function renderDeltaMarkdown(delta: ThesisDelta): string {
  const lines = [
    `# Research Thesis Delta: ${delta.instrumentKey}`,
    "",
    `From: ${delta.fromRunId} (${delta.fromGeneratedAt})`,
    `To: ${delta.toRunId} (${delta.toGeneratedAt})`,
    "",
  ];
  for (const [section, change] of Object.entries(delta.sections)) {
    if (change.added.length === 0 && change.removed.length === 0 && change.changed.length === 0) {
      continue;
    }
    lines.push(`## ${section}`, "");
    for (const value of change.added) {
      lines.push(`- Added: ${value}`);
    }
    for (const value of change.removed) {
      lines.push(`- Removed: ${value}`);
    }
    for (const value of change.changed) {
      lines.push(`- Changed: ${value}`);
    }
    lines.push("");
  }
  if (delta.narrative !== undefined) {
    lines.push("## Narrative", "", delta.narrative.text, "");
  }
  return `${lines.join("\n").trim()}\n`;
}

async function generateNarrative(
  delta: Omit<ThesisDelta, "narrative">,
  provider: ModelProvider,
  model: string,
): Promise<ThesisDelta["narrative"]> {
  const response = await provider.generate({
    model,
    messages: [
      {
        role: "system",
        content: withUntrustedModelInputRule(
          "Write a concise research-only narrative explaining what changed between two historical research thesis states. Do not include buy, sell, hold, sizing, execution, or portfolio language.",
        ),
      },
      {
        role: "user",
        content: JSON.stringify(delta, undefined, 2),
      },
    ],
    params: { temperature: 0.2 },
  });
  const text = response.content.trim();
  if (violatesResearchOnly(text) !== null) {
    throw new Error("Thesis-delta narrative contains trade-action language");
  }
  return {
    text,
    model,
    provider: provider.name,
    tokenEstimate: response.tokenEstimate,
    ...(response.costEstimateUsd !== undefined
      ? { costEstimateUsd: response.costEstimateUsd }
      : {}),
  };
}

export async function buildThesisDelta(input: ThesisDeltaInput): Promise<ThesisDelta> {
  const timeline = await readTimeline(input.dataDir, input.assetClass, input.symbol);
  if (timeline === undefined) {
    throw new Error(
      `No history timeline found for ${instrumentKey(input.assetClass, input.symbol)}`,
    );
  }
  const instrumentEntries = timeline.entries.filter((entry) => entry.scope === "instrument");
  const from = chooseEntry(instrumentEntries, input.since, "first");
  const to = chooseEntry(instrumentEntries, input.to, "last");
  if (from === undefined || to === undefined || from.runId === to.runId) {
    throw new Error(
      "Thesis delta requires two distinct instrument-scoped historical runs; market-update runs do not carry a per-instrument Research Thesis",
    );
  }
  const base: Omit<ThesisDelta, "narrative"> = {
    version: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    instrumentKey: timeline.instrumentKey,
    symbol: timeline.symbol,
    assetClass: timeline.assetClass,
    fromRunId: from.runId,
    toRunId: to.runId,
    fromGeneratedAt: from.generatedAt,
    toGeneratedAt: to.generatedAt,
    sections: buildDeltaSections(from, to),
  };
  const narrative =
    input.narrative === true
      ? await generateNarrative(
          base,
          input.provider ??
            ((): ModelProvider => {
              throw new Error("A model provider is required for --narrative");
            })(),
          input.model ?? "unknown",
        )
      : undefined;
  const delta: ThesisDelta = narrative === undefined ? base : { ...base, narrative };

  if (input.narrative === true) {
    const dir = join(historyDir(input.dataDir), "deltas");
    await mkdir(dir, { recursive: true });
    const baseName = `${instrumentFileName(timeline.instrumentKey).replace(/\.json$/u, "")}-${from.runId}-to-${to.runId}`;
    await writeFile(
      join(dir, `${baseName}.json`),
      `${JSON.stringify(delta, undefined, 2)}\n`,
      "utf8",
    );
    await writeFile(join(dir, `${baseName}.md`), renderDeltaMarkdown(delta), "utf8");
  }

  return delta;
}

export function renderSearchResults(results: readonly HistorySearchEntry[]): string {
  if (results.length === 0) {
    return "No history results found";
  }
  return results
    .map((result) => {
      const symbol = result.symbol === undefined ? "" : ` ${result.symbol}`;
      return `${result.generatedAt.slice(0, 10)} ${result.runId} ${result.section}${symbol}: ${result.label} - ${result.text}`;
    })
    .join("\n");
}

export function renderThesisDelta(delta: ThesisDelta): string {
  return renderDeltaMarkdown(delta);
}
