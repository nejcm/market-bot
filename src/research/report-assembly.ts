import type { ResearchCommand } from "../cli/args";
import {
  isMarketUpdateJobType,
  marketUpdateHorizonBucketOf,
  type EvidenceQuality,
  type KeyFinding,
  type MarketSnapshot,
  type Prediction,
  type ResearchReport,
  type Scenario,
  type Source,
  type SourceGap,
} from "../domain/types";
import type { ObservableForecastIssue } from "../forecast/observable";
import {
  dedupeSourceGaps,
  isCoreEvidenceQualityGap,
  isExtendedEvidenceQualityGap,
} from "../domain/source-gaps";
import { validatePredictions, validateResearchReport } from "../report/schema";
import { resolutionDate } from "../scoring/exchange-calendar";
import { isRecord, nonEmptyStringArrayValue, readString } from "../sources/guards";
import type { CollectedSources } from "../sources/types";
import { verifiedSnapshotSource } from "./verified-snapshot-contract";
import type { HistoricalResearchContext } from "./historical-context";
import {
  deterministicSourceGaps,
  type DepthProfile,
  type ResearchContext,
} from "./research-context";
import { researchIdentityExtras } from "./research-subject-identity";
import type { SpotlightSelectionResult } from "./spotlights";

// ---------------------------------------------------------------------------
// Raw model payload
// ---------------------------------------------------------------------------

export interface ModelReportPayload {
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

export function parseModelPayload(content: string): ModelReportPayload {
  const parsed = JSON.parse(content) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("Model report payload must be a JSON object");
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Field readers — narrow unknown model output to domain types
// ---------------------------------------------------------------------------

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readFindings(value: unknown): readonly KeyFinding[] {
  return readArray(value)
    .map((item): KeyFinding | undefined => {
      if (!isRecord(item) || typeof item.text !== "string") {
        return undefined;
      }

      return {
        text: item.text,
        sourceIds: nonEmptyStringArrayValue(item.sourceIds),
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
        sourceIds: nonEmptyStringArrayValue(item.sourceIds),
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

// ---------------------------------------------------------------------------
// Source list — normalized Sources the report attaches
// ---------------------------------------------------------------------------

// Primary mover/market snapshots come from the asset-class market-data provider.
// Equity uses Yahoo and crypto uses CoinGecko; a resolved identity alias wins.
// Stamping the provider keeps these Sources out of the analytics "unknown" bucket.
function marketSnapshotProvider(snapshot: MarketSnapshot): string {
  return (
    snapshot.identity?.aliases?.[0]?.provider ??
    (snapshot.assetClass === "crypto" ? "coingecko" : "yahoo")
  );
}

export function buildSourceList(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  historicalContext?: HistoricalResearchContext,
): readonly Source[] {
  const benchmarkSourcesById = new Map<string, Source>();
  const marketSources = collectedSources.marketSnapshots.map((snapshot): Source => {
    if (snapshot.benchmark !== undefined) {
      benchmarkSourcesById.set(snapshot.benchmark.sourceId, {
        id: snapshot.benchmark.sourceId,
        title: `${snapshot.benchmark.symbol} benchmark snapshot`,
        fetchedAt: snapshot.benchmark.observedAt,
        kind: "market-data",
        assetClass: snapshot.assetClass,
        symbol: snapshot.benchmark.symbol,
        provider: "yahoo",
      });
    }

    return {
      id: snapshot.sourceId,
      title: `${snapshot.symbol} market snapshot`,
      fetchedAt: snapshot.observedAt,
      kind: "market-data",
      assetClass: snapshot.assetClass,
      symbol: snapshot.symbol,
      provider: marketSnapshotProvider(snapshot),
      ...(snapshot.identity !== undefined ? { identity: snapshot.identity } : {}),
    };
  });
  const supplementalMarketSources = collectedSources.supplementalMarketSnapshots.map(
    (snapshot): Source => ({
      id: snapshot.sourceId,
      title: `${snapshot.symbol} supplemental market snapshot`,
      fetchedAt: snapshot.observedAt,
      kind: "market-data",
      assetClass: snapshot.assetClass,
      symbol: snapshot.symbol,
      provider: marketSnapshotProvider(snapshot),
      ...(snapshot.identity !== undefined ? { identity: snapshot.identity } : {}),
    }),
  );
  const marketSourceIds = new Set(marketSources.map((source) => source.id));
  const benchmarkSources = [...benchmarkSourcesById.values()].filter(
    (source) => !marketSourceIds.has(source.id),
  );

  // Verified Market Snapshot — citeable Source for exact numeric technical claims (ADR 0019)
  const verifiedSnapshotSources: Source[] =
    command.jobType === "ticker" && collectedSources.verifiedMarketSnapshot !== undefined
      ? [verifiedSnapshotSource(collectedSources.verifiedMarketSnapshot)]
      : [];

  return [
    ...marketSources,
    ...benchmarkSources,
    ...supplementalMarketSources,
    ...verifiedSnapshotSources,
    ...collectedSources.newsSources,
    ...(isMarketUpdateJobType(command.jobType) ? collectedSources.marketContextSources : []),
    ...(command.jobType === "ticker" ? collectedSources.extendedSources : []),
    ...(historicalContext?.sources ?? []),
  ];
}

// ---------------------------------------------------------------------------
// Evidence quality cap
// ---------------------------------------------------------------------------

function deterministicQualityCap(collectedSources: CollectedSources): EvidenceQuality {
  if (collectedSources.marketSnapshots.length === 0) {
    return "low";
  }

  const coreGaps = collectedSources.sourceGaps.filter((gap) => isCoreEvidenceQualityGap(gap));
  const extendedCategoryCount =
    collectedSources.extendedEvidence === undefined
      ? 0
      : new Set(collectedSources.extendedEvidence.items.map((item) => item.category)).size;
  const extendedGapCount =
    collectedSources.extendedEvidence?.gaps.filter(isExtendedEvidenceQualityGap).length ?? 0;

  if (
    coreGaps.length > 0 ||
    collectedSources.newsSources.length === 0 ||
    extendedGapCount > extendedCategoryCount
  ) {
    return "medium";
  }

  return "high";
}

// ---------------------------------------------------------------------------
// Prediction reader — validate and collect errors
// ---------------------------------------------------------------------------

export function readPredictions(
  value: unknown,
  knownSourceIds: ReadonlySet<string>,
): {
  predictions: readonly Prediction[];
  errors: readonly string[];
  issues: readonly ObservableForecastIssue[];
} {
  const result = validatePredictions(readArray(value), knownSourceIds);
  return { predictions: result.valid, errors: result.errors, issues: result.issues };
}

function historicalContextExtra(context: HistoricalResearchContext | undefined): unknown {
  if (context === undefined) {
    return undefined;
  }
  if (context.runs.length === 0) {
    return {
      summary: "No prior run artifacts matched this research scope.",
      sourceIds: [],
      gaps: context.gaps,
    };
  }
  return {
    summary: `Historical context includes ${String(context.runs.length)} prior run artifact(s).`,
    sourceIds: context.sources.map((source) => source.id),
    items: context.runs.map((run) => ({
      text: `${run.runId}: ${run.summary}`,
      sourceIds: [run.sourceId],
    })),
    gaps: context.gaps,
  };
}

function spotlightsExtra(selection: SpotlightSelectionResult | undefined): unknown {
  if (selection === undefined || selection.selected.length === 0) {
    return undefined;
  }
  return {
    ...(selection.rationale !== undefined ? { rationale: selection.rationale } : {}),
    items: selection.selected.map((item) => ({
      symbol: item.symbol,
      rationale: item.rationale,
      sourceIds: item.sourceIds,
    })),
  };
}

function spotlightItemRationale(item: unknown): string | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  return readString(item, "rationale") ?? readString(item, "text");
}

function modelSpotlightRationaleBySymbol(modelSpotlights: unknown): ReadonlyMap<string, string> {
  if (!isRecord(modelSpotlights) || !Array.isArray(modelSpotlights.items)) {
    return new Map();
  }

  const bySymbol = new Map<string, string>();
  for (const item of modelSpotlights.items) {
    if (!isRecord(item)) {
      continue;
    }
    const symbol = readString(item, "symbol")?.toUpperCase();
    const rationale = spotlightItemRationale(item);
    if (symbol !== undefined && rationale !== undefined) {
      bySymbol.set(symbol, rationale);
    }
  }
  return bySymbol;
}

function mergeSpotlightsExtra(modelSpotlights: unknown, defaultSpotlights: unknown): unknown {
  if (!isRecord(defaultSpotlights) || !Array.isArray(defaultSpotlights.items)) {
    return modelSpotlights;
  }
  if (defaultSpotlights.items.length === 0) {
    return modelSpotlights;
  }

  const rationaleBySymbol = modelSpotlightRationaleBySymbol(modelSpotlights);
  const items = defaultSpotlights.items.map((item) => {
    if (!isRecord(item)) {
      return item;
    }
    const symbol = readString(item, "symbol")?.toUpperCase();
    const rationale = symbol === undefined ? undefined : rationaleBySymbol.get(symbol);
    return rationale === undefined ? item : { ...item, rationale };
  });
  const modelRationale = isRecord(modelSpotlights) ? modelSpotlights.rationale : undefined;

  return {
    ...defaultSpotlights,
    ...(typeof modelRationale === "string" ? { rationale: modelRationale } : {}),
    items,
  };
}

function catalystCalendarExtra(input: {
  readonly generatedAt: string;
  readonly catalysts: readonly KeyFinding[];
  readonly predictions: readonly Prediction[];
  readonly collectedSources: CollectedSources;
}): unknown {
  const catalystItems = input.catalysts.map((catalyst) => ({
    label: catalyst.text,
    sourceIds: catalyst.sourceIds,
    sourceStatus: "sourced catalyst",
    researchRelevance: "watch item",
  }));
  const macroItems = (input.collectedSources.marketContext?.items ?? []).map((item) => ({
    date: item.observedAt.slice(0, 10),
    label: item.title,
    sourceIds: item.sourceIds,
    sourceStatus: "observed macro context",
    researchRelevance: "macro release context",
  }));
  const predictionItems = input.predictions.map((prediction) => ({
    date: resolutionDate(input.generatedAt, prediction.horizonTradingDays)
      .toISOString()
      .slice(0, 10),
    label: `Prediction ${prediction.id} resolution date`,
    sourceIds: prediction.sourceIds,
    sourceStatus: "observable forecast",
    researchRelevance: "prediction resolution",
  }));
  const items = [...catalystItems, ...macroItems, ...predictionItems];
  return items.length === 0 ? undefined : { items };
}

function marketUpdateExtras(command: ResearchCommand): Record<string, unknown> {
  const marketUpdateHorizonBucket = marketUpdateHorizonBucketOf(command);
  if (marketUpdateHorizonBucket === undefined) {
    return {};
  }
  if (command.jobType === "market-overview") {
    return {
      marketUpdateHorizonBucket,
      ...(command.legacyAlias !== undefined
        ? { legacyMarketUpdateAlias: command.legacyAlias }
        : {}),
    };
  }
  if (command.jobType === "daily" || command.jobType === "weekly") {
    return { marketUpdateCadence: command.jobType, marketUpdateHorizonBucket };
  }
  return {};
}

function dataGapKey(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

function uniqueDataGaps(gaps: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return gaps.filter((gap) => {
    const key = dataGapKey(gap);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeGapNeedle(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();
}

function sourceGapNeedles(gap: SourceGap): readonly string[] {
  return [gap.source, gap.provider]
    .filter((value): value is string => value !== undefined && value.trim() !== "")
    .map((value) => normalizeGapNeedle(value))
    .filter((value) => value.length >= 4);
}

function mentionsSourceGap(modelGap: string, deterministicGap: SourceGap): boolean {
  const normalized = normalizeGapNeedle(modelGap);
  return sourceGapNeedles(deterministicGap).some((needle) => normalized.includes(needle));
}

function withoutModelProviderGapDuplicates(
  modelGaps: readonly string[],
  sourceGaps: readonly SourceGap[],
): readonly string[] {
  const deterministicGaps = dedupeSourceGaps(sourceGaps);
  return modelGaps.filter(
    (modelGap) => !deterministicGaps.some((gap) => mentionsSourceGap(modelGap, gap)),
  );
}

function gapTokens(value: string): Set<string> {
  return new Set(
    normalizeGapNeedle(value)
      .split(" ")
      .filter((token) => token.length >= 3),
  );
}

/*
 * True when the model gap restates a deterministic gap — most of its meaningful
 * tokens are already covered by the deterministic phrasing. Punctuation and
 * inserted clauses (e.g. "— a single-day multi-screener set,") would otherwise
 * defeat the exact-text dedupe in uniqueDataGaps.
 */
function restatesDeterministicGap(modelGap: string, deterministicGap: string): boolean {
  const modelTokens = gapTokens(modelGap);
  if (modelTokens.size === 0) {
    return false;
  }
  const deterministicTokens = gapTokens(deterministicGap);
  let shared = 0;
  for (const token of modelTokens) {
    if (deterministicTokens.has(token)) {
      shared += 1;
    }
  }
  return shared / modelTokens.size >= 0.8;
}

function withoutDeterministicGapRestatements(
  modelGaps: readonly string[],
  deterministicGapTexts: readonly string[],
): readonly string[] {
  return modelGaps.filter(
    (modelGap) => !deterministicGapTexts.some((text) => restatesDeterministicGap(modelGap, text)),
  );
}

// ---------------------------------------------------------------------------
// Report assembly — combine parsed payload + context into a validated report
// ---------------------------------------------------------------------------

export interface AssembleResearchReportInput {
  readonly runId: string;
  readonly generatedAt: string;
  readonly command: ResearchCommand;
  readonly payload: ModelReportPayload;
  readonly predResult: {
    readonly predictions: readonly Prediction[];
    readonly errors: readonly string[];
  };
  readonly collectedSources: CollectedSources;
  readonly depthProfile: DepthProfile;
  readonly context: ResearchContext;
  readonly sources: readonly Source[];
}

export function assembleResearchReport(input: AssembleResearchReportInput): ResearchReport {
  const {
    runId,
    generatedAt,
    command,
    payload,
    predResult,
    collectedSources,
    depthProfile,
    context,
    sources,
  } = input;

  const deterministicGaps = deterministicSourceGaps(command, collectedSources);
  const dataGapsRaw = uniqueDataGaps([
    ...withoutDeterministicGapRestatements(
      withoutModelProviderGapDuplicates(
        nonEmptyStringArrayValue(payload.dataGaps),
        collectedSources.sourceGaps,
      ),
      deterministicGaps,
    ),
    ...deterministicGaps,
  ]);
  const shortfall = predResult.predictions.length < depthProfile.targetPredictions;
  const dataGaps = shortfall
    ? [
        ...dataGapsRaw,
        `predictionShortfall: emitted ${String(predResult.predictions.length)} of ${String(depthProfile.targetPredictions)} target predictions; evidence did not support more`,
      ]
    : dataGapsRaw;

  const confidence = lowerQuality(
    readEvidenceQuality(payload.confidence),
    deterministicQualityCap(collectedSources),
  );
  const modelExtras =
    typeof payload.extras === "object" && payload.extras !== null && !Array.isArray(payload.extras)
      ? (payload.extras as Record<string, unknown>)
      : {};
  const defaultHistoricalContext = historicalContextExtra(context.historicalContext);
  const defaultSpotlights = spotlightsExtra(context.spotlightSelection);
  const resolvedSpotlights = mergeSpotlightsExtra(modelExtras.spotlights, defaultSpotlights);
  const catalysts = readFindings(payload.catalysts);
  const catalystCalendar =
    command.jobType === "market-overview"
      ? catalystCalendarExtra({
          generatedAt,
          catalysts,
          predictions: predResult.predictions,
          collectedSources,
        })
      : undefined;

  return validateResearchReport({
    runId,
    jobType: command.jobType,
    assetClass: command.assetClass,
    ...(command.jobType === "ticker" ? { symbol: command.symbol } : {}),
    ...(command.jobType === "market-overview"
      ? { horizonTradingDays: command.horizonTradingDays }
      : {}),
    generatedAt,
    summary: typeof payload.summary === "string" ? payload.summary : "",
    keyFindings: readFindings(payload.keyFindings),
    bullCase: readFindings(payload.bullCase),
    bearCase: readFindings(payload.bearCase),
    risks: readFindings(payload.risks),
    catalysts,
    scenarios: readScenarios(payload.scenarios),
    confidence,
    dataGaps,
    predictions: predResult.predictions,
    sources,
    ...(command.jobType === "ticker" && collectedSources.extendedEvidence !== undefined
      ? { extendedEvidence: collectedSources.extendedEvidence }
      : {}),
    notFinancialAdvice: true,
    extras: {
      ...modelExtras,
      ...(modelExtras.historicalContext === undefined && defaultHistoricalContext !== undefined
        ? { historicalContext: defaultHistoricalContext }
        : {}),
      ...(resolvedSpotlights !== undefined ? { spotlights: resolvedSpotlights } : {}),
      ...(catalystCalendar !== undefined ? { catalystCalendar } : {}),
      depth: command.depth,
      depthProfile,
      ...marketUpdateExtras(command),
      ...researchIdentityExtras(command),
      ...(isMarketUpdateJobType(command.jobType) && context.marketUpdateDelta !== undefined
        ? { marketUpdateDelta: context.marketUpdateDelta }
        : {}),
      marketRegime: context.marketRegime,
      ...(isMarketUpdateJobType(command.jobType) && collectedSources.marketContext !== undefined
        ? { marketContext: collectedSources.marketContext }
        : {}),
    },
  });
}
