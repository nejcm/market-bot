import type { ResearchCommand } from "../cli/args";
import {
  isMarketUpdateJobType,
  type EvidenceQuality,
  type KeyFinding,
  type Prediction,
  type ResearchReport,
  type Scenario,
  type Source,
} from "../domain/types";
import { isCoreEvidenceQualityGap, isExtendedEvidenceQualityGap } from "../domain/source-gaps";
import { validatePredictions, validateResearchReport } from "../report/schema";
import { isRecord, nonEmptyStringArrayValue } from "../sources/guards";
import type { CollectedSources } from "../sources/types";
import { verifiedSnapshotSource } from "./verified-snapshot-contract";
import type { HistoricalResearchContext } from "./historical-context";
import {
  deterministicSourceGaps,
  type DepthProfile,
  type ResearchContext,
} from "./research-context";
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
      ...(snapshot.identity?.aliases?.[0]?.provider !== undefined
        ? { provider: snapshot.identity.aliases[0].provider }
        : {}),
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
): { predictions: readonly Prediction[]; errors: readonly string[] } {
  const result = validatePredictions(readArray(value), knownSourceIds);
  return { predictions: result.valid, errors: result.errors };
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

  const dataGapsRaw = uniqueDataGaps([
    ...nonEmptyStringArrayValue(payload.dataGaps),
    ...deterministicSourceGaps(command, collectedSources),
  ]);
  const shortfall = predResult.predictions.length < depthProfile.minimumPredictions;
  const dataGaps = shortfall
    ? [
        ...dataGapsRaw,
        `predictionShortfall: emitted ${String(predResult.predictions.length)} of ${String(depthProfile.minimumPredictions)} required`,
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

  return validateResearchReport({
    runId,
    jobType: command.jobType,
    assetClass: command.assetClass,
    ...(command.jobType === "ticker" ? { symbol: command.symbol } : {}),
    generatedAt,
    summary: typeof payload.summary === "string" ? payload.summary : "",
    keyFindings: readFindings(payload.keyFindings),
    bullCase: readFindings(payload.bullCase),
    bearCase: readFindings(payload.bearCase),
    risks: readFindings(payload.risks),
    catalysts: readFindings(payload.catalysts),
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
      ...(modelExtras.spotlights === undefined && defaultSpotlights !== undefined
        ? { spotlights: defaultSpotlights }
        : {}),
      depth: command.depth,
      depthProfile,
      ...(isMarketUpdateJobType(command.jobType) ? { marketUpdateCadence: command.jobType } : {}),
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
