import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  AssetClass,
  InstrumentIdentity,
  JobType,
  KeyFinding,
  Prediction,
  ResearchReport,
  Source,
} from "../domain/types";
import type { ModelProvider } from "../model/types";
import { violatesResearchOnly } from "../domain/research-language";
import type { PredictionScore } from "../scoring/types";

export const HISTORY_SECTIONS = [
  "summary",
  "keyFindings",
  "bullCase",
  "bearCase",
  "risks",
  "catalysts",
  "dataGaps",
  "predictions",
  "sources",
  "openQuestions",
  "fundamentals",
  "validation",
] as const;

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
  readonly version: 1;
  readonly generatedAt: string;
  readonly sourceRunCount: number;
  readonly malformedRunCount: number;
  readonly entries: readonly HistorySearchEntry[];
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
  readonly thesis: ResearchThesisState;
  readonly sources: readonly Source[];
  readonly scores: readonly PredictionScore[];
  readonly identity?: InstrumentIdentity;
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
    readonly costEstimateUsd: number;
  };
}

const HISTORY_DIR = "history";
const INDEX_FILE = "index.json";
const MAX_SEARCH_RESULTS = 100;

function dataRootFromRunsDir(dataDir: string): string {
  return basename(dataDir) === "runs" ? dirname(dataDir) : dataDir;
}

function historyDir(dataDir: string): string {
  return join(dataRootFromRunsDir(dataDir), HISTORY_DIR);
}

function instrumentKey(assetClass: AssetClass, symbol: string): string {
  return `${assetClass}:${symbol.toUpperCase()}`;
}

function instrumentFileName(key: string): string {
  return `${key.replace(":", "-").replaceAll(/[^A-Z0-9._-]/giu, "_")}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAssetClass(value: unknown): value is AssetClass {
  return value === "equity" || value === "crypto";
}

function isJobType(value: unknown): value is JobType {
  return value === "daily" || value === "weekly" || value === "ticker" || value === "alpha-search";
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readFindings(value: unknown): readonly KeyFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly KeyFinding[] => {
    if (!isRecord(item) || typeof item.text !== "string") {
      return [];
    }
    return [{ text: item.text, sourceIds: readStringArray(item.sourceIds) }];
  });
}

function readPredictions(value: unknown): readonly Prediction[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly Prediction[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.claim !== "string" ||
      typeof item.kind !== "string" ||
      typeof item.subject !== "string" ||
      typeof item.measurableAs !== "string" ||
      typeof item.horizonTradingDays !== "number" ||
      typeof item.probability !== "number"
    ) {
      return [];
    }
    return [
      {
        id: item.id,
        claim: item.claim,
        kind: item.kind as Prediction["kind"],
        subject: item.subject,
        measurableAs: item.measurableAs,
        horizonTradingDays: item.horizonTradingDays,
        probability: item.probability,
        sourceIds: readStringArray(item.sourceIds),
      },
    ];
  });
}

function readSources(value: unknown): readonly Source[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly Source[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.fetchedAt !== "string" ||
      typeof item.kind !== "string"
    ) {
      return [];
    }
    return [item as unknown as Source];
  });
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
    confidence:
      value.confidence === "high" || value.confidence === "medium" || value.confidence === "low"
        ? value.confidence
        : "low",
    dataGaps: readStringArray(value.dataGaps),
    predictions: readPredictions(value.predictions),
    sources: readSources(value.sources),
    notFinancialAdvice: true,
    ...(isRecord(value.extras) ? { extras: value.extras } : {}),
  };
}

async function readJson(path: string): Promise<unknown | undefined> {
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

function scoresFrom(value: unknown): readonly PredictionScore[] {
  if (!isRecord(value) || !Array.isArray(value.scores)) {
    return [];
  }
  return value.scores.filter((score): score is PredictionScore => isRecord(score));
}

function openQuestions(
  report: ResearchReport,
  scores: readonly PredictionScore[],
): readonly string[] {
  const resolved = new Set(
    scores.filter((score) => score.resolved).map((score) => score.predictionId),
  );
  return [
    ...report.dataGaps.map((gap) => `Data gap: ${gap}`),
    ...report.predictions
      .filter((prediction) => !resolved.has(prediction.id))
      .map((prediction) => `Unresolved prediction: ${prediction.claim}`),
  ];
}

function reportInstrumentKeys(report: ResearchReport): readonly { key: string; symbol: string }[] {
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
    const subject = prediction.subject.split(":")[0]?.trim();
    if (subject !== undefined && /^[A-Z0-9._-]+$/u.test(subject)) {
      symbols.add(subject.toUpperCase());
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

function searchEntriesFor(
  report: ResearchReport,
  scores: readonly PredictionScore[],
  fundamentals: readonly Record<string, unknown>[],
  validation: readonly Record<string, unknown>[],
): readonly HistorySearchEntry[] {
  const entries: HistorySearchEntry[] = [];
  addEntry(entries, report, "summary", "Summary", report.summary);
  for (const section of ["keyFindings", "bullCase", "bearCase", "risks", "catalysts"] as const) {
    for (const [index, finding] of report[section].entries()) {
      addEntry(
        entries,
        report,
        section,
        `${section} ${String(index + 1)}`,
        finding.text,
        finding.sourceIds,
      );
    }
  }
  for (const [index, gap] of report.dataGaps.entries()) {
    addEntry(entries, report, "dataGaps", `Data gap ${String(index + 1)}`, gap);
  }
  for (const prediction of report.predictions) {
    addEntry(
      entries,
      report,
      "predictions",
      prediction.id,
      prediction.claim,
      prediction.sourceIds,
      {
        predictionId: prediction.id,
      },
    );
  }
  for (const source of report.sources) {
    addEntry(
      entries,
      report,
      "sources",
      source.id,
      [source.title, source.summary, source.snippet].join(" "),
      [source.id],
      {
        ...(source.provider !== undefined ? { provider: source.provider } : {}),
        sourceKind: source.kind,
        ...(source.symbol !== undefined
          ? {
              symbol: source.symbol.toUpperCase(),
              instrumentKey: instrumentKey(report.assetClass, source.symbol),
            }
          : {}),
      },
    );
  }
  for (const [index, question] of openQuestions(report, scores).entries()) {
    addEntry(entries, report, "openQuestions", `Open question ${String(index + 1)}`, question);
  }
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

async function loadRun(runDir: string): Promise<
  | {
      readonly report: ResearchReport;
      readonly scores: readonly PredictionScore[];
      readonly snapshots: readonly Record<string, unknown>[];
      readonly fundamentals: readonly Record<string, unknown>[];
      readonly validation: readonly Record<string, unknown>[];
    }
  | undefined
> {
  const report = readReport(await readJson(join(runDir, "report.json")));
  if (report === undefined) {
    return;
  }
  const scores = scoresFrom(await readJson(join(runDir, "score.json")));
  const marketSnapshots = recordArray(
    await readJson(join(runDir, "normalized", "market-snapshots.json")),
  );
  const supplementalSnapshots = recordArray(
    await readJson(join(runDir, "normalized", "supplemental-market-snapshots.json")),
  );
  const fundamentals = recordArray(
    await readJson(join(runDir, "normalized", "sec-fundamentals.json")),
  );
  const validationFile = await readJson(join(runDir, "alpha-validation.json"));
  const validation = isRecord(validationFile) ? [validationFile] : recordArray(validationFile);
  return {
    report,
    scores,
    snapshots: [...marketSnapshots, ...supplementalSnapshots],
    fundamentals,
    validation,
  };
}

export async function rebuildHistoryArtifacts(
  dataDir: string,
  now: Date = new Date(),
): Promise<HistoryRebuildResult> {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({ name: entry.name, run: await loadRun(join(dataDir, entry.name)) })),
  );
  const loaded = runs.filter(
    (item): item is { name: string; run: NonNullable<(typeof item)["run"]> } =>
      item.run !== undefined,
  );
  const generatedAt = now.toISOString();
  const indexEntries = loaded.flatMap((item) =>
    searchEntriesFor(item.run.report, item.run.scores, item.run.fundamentals, item.run.validation),
  );
  const timelines = new Map<string, InstrumentTimelineEntry[]>();

  for (const { run } of loaded) {
    for (const { key, symbol } of reportInstrumentKeys(run.report)) {
      const current = timelines.get(key) ?? [];
      const identity = firstIdentity(run.report, symbol);
      const scope: ThesisScope =
        run.report.symbol !== undefined && run.report.symbol.toUpperCase() === symbol
          ? "instrument"
          : "market-update";
      current.push({
        runId: run.report.runId,
        generatedAt: run.report.generatedAt,
        jobType: run.report.jobType,
        assetClass: run.report.assetClass,
        symbol,
        instrumentKey: key,
        scope,
        confidence: run.report.confidence,
        thesis: thesisState(run.report, run.scores),
        sources: run.report.sources.filter(
          (source) => source.symbol === undefined || source.symbol.toUpperCase() === symbol,
        ),
        scores: run.scores,
        ...(identity !== undefined ? { identity } : {}),
        snapshots: run.snapshots.filter(
          (snapshot) => readString(snapshot, "symbol")?.toUpperCase() === symbol,
        ),
        fundamentals: run.fundamentals,
        validation: run.validation,
      });
      timelines.set(key, current);
    }
  }

  const dir = historyDir(dataDir);
  const instrumentsDir = join(dir, "instruments");
  await mkdir(instrumentsDir, { recursive: true });

  const index: HistoryIndex = {
    version: 1,
    generatedAt,
    sourceRunCount: loaded.length,
    malformedRunCount: runs.length - loaded.length,
    entries: indexEntries.toSorted((left, right) =>
      right.generatedAt.localeCompare(left.generatedAt),
    ),
  };
  const indexPath = join(dir, INDEX_FILE);
  await writeFile(indexPath, `${JSON.stringify(index, undefined, 2)}\n`, "utf8");

  await Promise.all(
    [...timelines.entries()].map(([key, timelineEntries]) => {
      const colon = key.indexOf(":");
      const assetClass = key.slice(0, colon) as AssetClass;
      const symbol = key.slice(colon + 1);
      const timeline: InstrumentTimeline = {
        version: 1,
        generatedAt,
        instrumentKey: key,
        assetClass,
        symbol,
        entries: timelineEntries.toSorted((left, right) =>
          left.generatedAt.localeCompare(right.generatedAt),
        ),
      };
      return writeFile(
        join(instrumentsDir, instrumentFileName(key)),
        `${JSON.stringify(timeline, undefined, 2)}\n`,
        "utf8",
      );
    }),
  );

  return {
    historyDir: dir,
    indexPath,
    instrumentCount: timelines.size,
    sourceRunCount: loaded.length,
    malformedRunCount: runs.length - loaded.length,
  };
}

async function readIndex(dataDir: string): Promise<HistoryIndex | undefined> {
  const parsed = await readJson(join(historyDir(dataDir), INDEX_FILE));
  return isRecord(parsed) && parsed.version === 1 && Array.isArray(parsed.entries)
    ? (parsed as unknown as HistoryIndex)
    : undefined;
}

export async function searchHistoryIndex(
  dataDir: string,
  filters: HistorySearchFilters,
): Promise<readonly HistorySearchEntry[]> {
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
      `${item.id}: ${item.claim} (${item.measurableAs}, p=${item.probability.toFixed(2)}, ${String(
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
        content:
          "Write a concise research-only narrative explaining what changed between two historical research thesis states. Do not include buy, sell, hold, sizing, execution, or portfolio language.",
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
    costEstimateUsd: response.costEstimateUsd,
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
