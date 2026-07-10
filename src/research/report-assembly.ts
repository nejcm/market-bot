import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import type { ResearchSubjectCommand } from "../cli/job-registry";
import {
  isMarketUpdateJobType,
  marketUpdateMetadataOf,
  type KeyFinding,
  type MarketSnapshot,
  type Prediction,
  type ResearchReport,
  type Scenario,
  type Source,
  type SourceGap,
  type SourceGapEvidenceQualityImpact,
} from "../domain/types";
import type { ObservableForecastIssue } from "../forecast/observable";
import { dedupeSourceGaps } from "../domain/source-gaps";
import { validatePredictions, validateResearchReport } from "../report/schema";
import { resolutionDate } from "../scoring/exchange-calendar";
import { CURRENT_SCORING_POLICY_VERSION } from "../scoring/policy";
import { isRecord, nonEmptyStringArrayValue, readString } from "../sources/guards";
import type { CollectedSources } from "../sources/types";
import { extractCatalystDate } from "./catalyst-date";
import { verifiedSnapshotSource, verifiedSnapshotSourceId } from "./verified-snapshot-contract";
import { projectExtendedEvidenceReportExtras } from "./extended-evidence-projections";
import type { HistoricalResearchContext } from "./historical-context";
import {
  deterministicSourceGapEntries,
  EQUITY_MARKET_OVERVIEW_MOVER_UNIVERSE_GAP,
  type DepthProfile,
  type ResearchContext,
} from "./research-context";
import {
  commandResearchSubjectIdentity,
  researchIdentityExtras,
} from "./research-subject-identity";
import type { SpotlightSelectionResult } from "./spotlights";
import { assessEvidenceQuality } from "./evidence-quality";
import { assessSourcePlan, buildSourcePlan } from "./source-plan";

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
  /** Legacy model field accepted but ignored for new report assembly. */
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

// Build registry provenance sources for research commands. Registry sources
// Are static reference entries (kind "reference") so findings and predictions can
// Cite them instead of leaning on generic mover fallback (Phase 2.1).
function registryProvenanceSources(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  fetchedAt: string,
): readonly Source[] {
  if (command.jobType !== "research") {
    return [];
  }
  const { resolvedSubject } = collectedSources;
  if (resolvedSubject?.sources === undefined) {
    return [];
  }
  return resolvedSubject.sources.map(
    (srcEntry): Source => ({
      id: srcEntry.sourceId,
      title: srcEntry.title,
      ...(srcEntry.url !== undefined ? { url: srcEntry.url } : {}),
      fetchedAt,
      kind: "reference",
    }),
  );
}

function missingRegistryProvenanceFetchedAt(command: ResearchSubjectCommand): never {
  throw new Error(
    `buildSourceList requires fetchedAt for resolved research subject provenance: ${command.subject}`,
  );
}

type NonResearchCommand = Exclude<ResearchCommand, ResearchSubjectCommand>;

export function buildSourceList(
  command: NonResearchCommand,
  collectedSources: CollectedSources,
  historicalContext?: HistoricalResearchContext,
  fetchedAt?: string,
): readonly Source[];
export function buildSourceList(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  historicalContext: HistoricalResearchContext | undefined,
  fetchedAt: string,
): readonly Source[];
export function buildSourceList(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  historicalContext?: HistoricalResearchContext,
  fetchedAt?: string,
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
  const verifiedSnapshotSources: Source[] = [
    ...(isInstrumentCommand(command) && collectedSources.verifiedMarketSnapshot !== undefined
      ? [verifiedSnapshotSource(collectedSources.verifiedMarketSnapshot)]
      : []),
    ...(command.jobType === "research"
      ? (collectedSources.verifiedRepresentativeSnapshots ?? []).map((snapshot) =>
          verifiedSnapshotSource(snapshot),
        )
      : []),
  ];

  // Registry provenance sources for research — kind:"reference" so the model can cite
  // Checked-in subject registry entries in findings/predictions (Phase 2.1).
  const registrySources =
    command.jobType === "research"
      ? registryProvenanceSources(
          command,
          collectedSources,
          fetchedAt ?? missingRegistryProvenanceFetchedAt(command),
        )
      : [];

  return [
    ...marketSources,
    ...benchmarkSources,
    ...supplementalMarketSources,
    ...verifiedSnapshotSources,
    ...collectedSources.newsSources,
    ...(isMarketUpdateJobType(command.jobType) ? collectedSources.marketContextSources : []),
    ...(isInstrumentCommand(command) || command.jobType === "research"
      ? collectedSources.extendedSources
      : []),
    ...(historicalContext?.sources ?? []),
    ...registrySources,
  ];
}

// ---------------------------------------------------------------------------
// Prediction reader — validate and collect errors
// ---------------------------------------------------------------------------

export function readPredictions(
  value: unknown,
  knownSourceIds: ReadonlySet<string>,
  allowedSubjects?: ReadonlySet<string>,
): {
  predictions: readonly Prediction[];
  errors: readonly string[];
  issues: readonly ObservableForecastIssue[];
} {
  const result = validatePredictions(readArray(value), knownSourceIds, allowedSubjects);
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
  const catalystItems = input.catalysts.map((catalyst) => {
    const date = extractCatalystDate(catalyst.text);
    return {
      ...(date !== undefined ? { date } : {}),
      label: catalyst.text,
      sourceIds: catalyst.sourceIds,
      sourceStatus: "sourced catalyst",
      researchRelevance: "watch item",
    };
  });
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
  // Calendar items must cite sources (schema-enforced for traceability). Research
  // Catalysts and predictions can be uncited; drop those rather than emit an
  // Unsourced entry that would fail validation.
  const items = [...catalystItems, ...macroItems, ...predictionItems].filter(
    (item) => item.sourceIds.length > 0,
  );
  return items.length === 0 ? undefined : { items };
}

function marketUpdateExtras(command: ResearchCommand): Record<string, unknown> {
  return marketUpdateMetadataOf(command) ?? {};
}

function dataGapKey(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

interface ReportDataGapEntry {
  readonly text: string;
  readonly impact?: SourceGapEvidenceQualityImpact;
  readonly origin: "model" | "deterministic" | "source-gap" | "prediction-gate";
}

function reportDataGapEntry(
  text: string,
  origin: ReportDataGapEntry["origin"],
): ReportDataGapEntry {
  return { text, origin };
}

function uniqueDataGapEntries(
  entries: readonly ReportDataGapEntry[],
): readonly ReportDataGapEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = dataGapKey(entry.text);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dataGapTier(entry: ReportDataGapEntry): number {
  if (entry.impact === "core-cap") {
    return 0;
  }
  if (entry.impact === "extended-evidence-cap") {
    return 1;
  }
  if (entry.impact === "no-cap") {
    return 3;
  }
  return 2;
}

function orderedDataGapEntries(
  entries: readonly ReportDataGapEntry[],
): readonly ReportDataGapEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .toSorted(
      (left, right) =>
        dataGapTier(left.entry) - dataGapTier(right.entry) || left.index - right.index,
    )
    .map(({ entry }) => entry);
}

function hasMarketSnapshotFor(
  collectedSources: CollectedSources,
  symbol: string | undefined,
): boolean {
  if (symbol === undefined) {
    return false;
  }
  const target = symbol.toUpperCase();
  return collectedSources.marketSnapshots.some(
    (snapshot) => snapshot.symbol.toUpperCase() === target,
  );
}

function researchPredictionGate(input: {
  readonly command: ResearchCommand;
  readonly predictions: readonly Prediction[];
  readonly collectedSources: CollectedSources;
}): { readonly predictions: readonly Prediction[]; readonly gaps: readonly string[] } {
  if (input.command.jobType !== "research") {
    return { predictions: input.predictions, gaps: [] };
  }
  const identity = commandResearchSubjectIdentity(input.command);
  const proxy = identity.predictionProxySymbol;
  if (proxy === undefined) {
    // Resolved subject with no proxy (e.g. ai-infrastructure): always emit an explicit gap.
    // So the absence of predictions is disclosed, not implicit (Phase 2.4).
    // Use registry resolution as the discriminator — identity.subjectKey is caller-provided
    // And not proof that the subject actually matched a registry entry.
    const { resolvedSubject } = input.collectedSources;
    if (resolvedSubject?.subjectKey !== undefined) {
      return {
        predictions: [],
        gaps: [
          `researchProxyForecastGate: subject ${resolvedSubject.subjectKey} has no listed prediction proxy; predictions cannot be emitted`,
        ],
      };
    }
    // Unresolved subject: only emit gap if there were predictions to drop.
    return {
      predictions: [],
      gaps:
        input.predictions.length === 0
          ? []
          : [
              "researchProxyForecastGate: dropped predictions because no listed prediction proxy was resolved",
            ],
    };
  }
  if (!hasMarketSnapshotFor(input.collectedSources, proxy)) {
    return {
      predictions: [],
      gaps: [
        `researchProxyForecastGate: dropped predictions because no market snapshot matched proxy ${proxy}`,
      ],
    };
  }
  const predictions = input.predictions.filter(
    (prediction) => prediction.subject.toUpperCase() === proxy,
  );
  return {
    predictions,
    gaps:
      predictions.length === input.predictions.length
        ? []
        : [`researchProxyForecastGate: dropped non-proxy predictions; allowed subject is ${proxy}`],
  };
}

function normalizeGapNeedle(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();
}

function sourceGapNeedles(gap: SourceGap): readonly string[] {
  return [gap.source, gap.provider, ...sourceGapAliasNeedles(gap)]
    .filter((value): value is string => value !== undefined && value.trim() !== "")
    .map((value) => normalizeGapNeedle(value))
    .filter((value) => value.length >= 4);
}

function sourceGapAliasNeedles(gap: SourceGap): readonly string[] {
  const source = gap.source.toLowerCase();
  return [
    ...(source.includes("tradier") ? ["options iv", "options evidence"] : []),
    ...(source.includes("supplemental-market") ? ["supplemental market"] : []),
  ];
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

function isMoverUniverseRestatement(modelGap: string, deterministicGap: string): boolean {
  const model = normalizeGapNeedle(modelGap);
  if (deterministicGap !== EQUITY_MARKET_OVERVIEW_MOVER_UNIVERSE_GAP) {
    return false;
  }
  return (
    model.includes("mover universe") &&
    model.includes("yahoo") &&
    model.includes("day gainers") &&
    model.includes("day losers") &&
    model.includes("most active") &&
    model.includes("trailing horizon")
  );
}

/*
 * True when the model gap restates a deterministic gap — most of its meaningful
 * tokens are already covered by the deterministic phrasing. Punctuation and
 * inserted clauses (e.g. "— a single-day multi-screener set,") would otherwise
 * defeat the exact-text dedupe in uniqueDataGaps.
 */
function restatesDeterministicGap(modelGap: string, deterministicGap: string): boolean {
  if (isMoverUniverseRestatement(modelGap, deterministicGap)) {
    return true;
  }
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

function withoutModelPredictionCountGaps(modelGaps: readonly string[]): readonly string[] {
  return modelGaps.filter((gap) => {
    const normalized = gap.toLowerCase();
    return !(
      /\bpredictions?\b/u.test(normalized) &&
      /\b(?:count|emit|emits|emitted|emitting|fewer|more|shortfall|target)\b/u.test(normalized)
    );
  });
}

const NUMERIC_CLAIM_PATTERN = /(?:[$€£]?\d+(?:\.\d+)?%?|\b\d+(?:\.\d+)?\b)/u;
const TECHNICAL_INDICATOR_PATTERN = /\b(?:ema|sma|rsi|macd|bollinger|atr)\b/iu;
const CURRENT_SNAPSHOT_CLAIM_PATTERN =
  /\b(?:current|latest|snapshot|traded|trading|price|priced|quote|volume|market cap|change|open|close|closed|previous close|average volume)\b/iu;

function citesOnlyHistoryReports(sourceIds: readonly string[]): boolean {
  return (
    sourceIds.length > 0 && sourceIds.every((sourceId) => sourceId.startsWith("history-report-"))
  );
}

function firstSnapshotSourceIdForText(input: {
  readonly text: string;
  readonly collectedSources: CollectedSources;
}): string | undefined {
  const text = input.text.toUpperCase();
  const snapshots = [
    ...input.collectedSources.marketSnapshots,
    ...input.collectedSources.supplementalMarketSnapshots,
  ];
  const snapshot = snapshots.find((candidate) => text.includes(candidate.symbol.toUpperCase()));
  if (snapshot !== undefined) {
    return snapshot.sourceId;
  }
  const verified = input.collectedSources.verifiedMarketSnapshot;
  if (
    verified !== undefined &&
    TECHNICAL_INDICATOR_PATTERN.test(input.text) &&
    text.includes(verified.symbol.toUpperCase())
  ) {
    return verifiedSnapshotSourceId(verified.symbol);
  }
  const representativeVerified = input.collectedSources.verifiedRepresentativeSnapshots?.find(
    (candidate) =>
      TECHNICAL_INDICATOR_PATTERN.test(input.text) && text.includes(candidate.symbol.toUpperCase()),
  );
  if (representativeVerified !== undefined) {
    return verifiedSnapshotSourceId(representativeVerified.symbol);
  }
  return undefined;
}

function preferSnapshotCitationForFinding(input: {
  readonly finding: KeyFinding;
  readonly collectedSources: CollectedSources;
}): KeyFinding {
  if (
    !NUMERIC_CLAIM_PATTERN.test(input.finding.text) ||
    !(
      CURRENT_SNAPSHOT_CLAIM_PATTERN.test(input.finding.text) ||
      TECHNICAL_INDICATOR_PATTERN.test(input.finding.text)
    ) ||
    !citesOnlyHistoryReports(input.finding.sourceIds)
  ) {
    return input.finding;
  }
  const sourceId = firstSnapshotSourceIdForText({
    text: input.finding.text,
    collectedSources: input.collectedSources,
  });
  return sourceId === undefined ? input.finding : { ...input.finding, sourceIds: [sourceId] };
}

function preferSnapshotCitationsForFindings(
  findings: readonly KeyFinding[],
  collectedSources: CollectedSources,
): readonly KeyFinding[] {
  return findings.map((finding) => preferSnapshotCitationForFinding({ finding, collectedSources }));
}

function preferSnapshotCitationsForScenarios(
  scenarios: readonly Scenario[],
  collectedSources: CollectedSources,
): readonly Scenario[] {
  return scenarios.map((scenario) => {
    if (
      !NUMERIC_CLAIM_PATTERN.test(scenario.description) ||
      !(
        CURRENT_SNAPSHOT_CLAIM_PATTERN.test(scenario.description) ||
        TECHNICAL_INDICATOR_PATTERN.test(scenario.description)
      ) ||
      !citesOnlyHistoryReports(scenario.sourceIds)
    ) {
      return scenario;
    }
    const sourceId = firstSnapshotSourceIdForText({
      text: scenario.description,
      collectedSources,
    });
    return sourceId === undefined ? scenario : { ...scenario, sourceIds: [sourceId] };
  });
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

  const gatedPredictions = researchPredictionGate({
    command,
    predictions: predResult.predictions,
    collectedSources,
  });
  const deterministicGapEntries = deterministicSourceGapEntries(command, collectedSources);
  const deterministicGapTexts = deterministicGapEntries.map((gap) => gap.text);
  const modelGapEntries = withoutDeterministicGapRestatements(
    withoutModelProviderGapDuplicates(
      withoutModelPredictionCountGaps(nonEmptyStringArrayValue(payload.dataGaps)),
      collectedSources.sourceGaps,
    ),
    deterministicGapTexts,
  ).map((gap) => reportDataGapEntry(gap, "model"));
  const dataGapsRaw = orderedDataGapEntries(
    uniqueDataGapEntries([
      ...modelGapEntries,
      ...deterministicGapEntries,
      ...gatedPredictions.gaps.map((gap) => reportDataGapEntry(gap, "prediction-gate")),
    ]),
  ).map((gap) => gap.text);
  // Stamp the current scoring policy on every accepted Prediction. The stamp
  // Is deterministic: model-provided policy metadata never survives assembly.
  const stampedPredictions = gatedPredictions.predictions.map((candidate) => ({
    ...candidate,
    scoringPolicyVersion: CURRENT_SCORING_POLICY_VERSION,
  }));
  const shortfall = gatedPredictions.predictions.length < depthProfile.targetPredictions;
  const dataGaps = shortfall
    ? [
        ...dataGapsRaw,
        `predictionShortfall: emitted ${String(gatedPredictions.predictions.length)} of ${String(depthProfile.targetPredictions)} target predictions; evidence did not support more`,
      ]
    : dataGapsRaw;

  // The orchestrator assesses evidence quality once, before synthesis, and stamps the
  // Result onto context.evidenceQualityAssessment, so the real flow always takes the
  // First arm. The fallbacks below exist only for direct callers (unit tests) that
  // Assemble a report without pre-running the assessment; reaching them recomputes
  // The same deterministic label from the source plan.
  const evidenceQuality =
    context.evidenceQualityAssessment?.label ??
    assessEvidenceQuality(
      context.sourcePlanning ??
        assessSourcePlan(buildSourcePlan(command, generatedAt), collectedSources, generatedAt),
      generatedAt,
    ).label;
  const modelExtras =
    typeof payload.extras === "object" && payload.extras !== null && !Array.isArray(payload.extras)
      ? (payload.extras as Record<string, unknown>)
      : {};
  const defaultHistoricalContext = historicalContextExtra(context.historicalContext);
  const defaultSpotlights = spotlightsExtra(context.spotlightSelection);
  const resolvedSpotlights = mergeSpotlightsExtra(modelExtras.spotlights, defaultSpotlights);
  const extendedEvidenceExtras = projectExtendedEvidenceReportExtras({
    modelExtras,
    collectedSources,
  });
  const keyFindings = preferSnapshotCitationsForFindings(
    readFindings(payload.keyFindings),
    collectedSources,
  );
  const bullCase = preferSnapshotCitationsForFindings(
    readFindings(payload.bullCase),
    collectedSources,
  );
  const bearCase = preferSnapshotCitationsForFindings(
    readFindings(payload.bearCase),
    collectedSources,
  );
  const risks = preferSnapshotCitationsForFindings(readFindings(payload.risks), collectedSources);
  const catalysts = preferSnapshotCitationsForFindings(
    readFindings(payload.catalysts),
    collectedSources,
  );
  const scenarios = preferSnapshotCitationsForScenarios(
    readScenarios(payload.scenarios),
    collectedSources,
  );
  const catalystCalendar =
    command.jobType === "market-overview" || command.jobType === "research"
      ? catalystCalendarExtra({
          generatedAt,
          catalysts,
          predictions: stampedPredictions,
          collectedSources,
        })
      : undefined;

  return validateResearchReport({
    runId,
    jobType: command.jobType,
    assetClass: command.assetClass,
    ...(isInstrumentCommand(command) ? { symbol: command.symbol } : {}),
    ...(command.jobType === "market-overview"
      ? { horizonTradingDays: command.horizonTradingDays }
      : {}),
    generatedAt,
    summary: typeof payload.summary === "string" ? payload.summary : "",
    keyFindings,
    bullCase,
    bearCase,
    risks,
    catalysts,
    scenarios,
    evidenceQuality,
    dataGaps,
    predictions: stampedPredictions,
    sources,
    ...((isInstrumentCommand(command) || command.jobType === "research") &&
    collectedSources.extendedEvidence !== undefined
      ? { extendedEvidence: collectedSources.extendedEvidence }
      : {}),
    ...(command.jobType === "research" &&
    collectedSources.verifiedRepresentativeSnapshots !== undefined &&
    collectedSources.verifiedRepresentativeSnapshots.length > 0
      ? { verifiedRepresentativeSnapshots: collectedSources.verifiedRepresentativeSnapshots }
      : {}),
    notFinancialAdvice: true,
    extras: {
      ...modelExtras,
      ...(defaultHistoricalContext !== undefined
        ? { historicalContext: defaultHistoricalContext }
        : {}),
      ...(resolvedSpotlights !== undefined ? { spotlights: resolvedSpotlights } : {}),
      ...(catalystCalendar !== undefined ? { catalystCalendar } : {}),
      ...extendedEvidenceExtras,
      depth: command.depth,
      depthProfile,
      ...marketUpdateExtras(command),
      ...researchIdentityExtras(
        command,
        context.resolvedSubject ?? collectedSources.resolvedSubject,
      ),
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
