import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import {
  isMarketUpdateJobType,
  type AssetClass,
  type Source,
  type SourceGap,
} from "../domain/types";
import { verifiedSnapshotSourceId } from "./verified-snapshot-contract";
import type { CollectedSources } from "../sources/types";
import { isUsListing } from "../sources/instrument-capability";
import { resolveResearchSubject, type ResolvedResearchSubject } from "./research-subject-identity";

export const EVIDENCE_LANES = [
  "market-data",
  "supplemental-market",
  "news",
  "market-context",
  "verified-price-history",
  "regulatory-filings",
  "corporate-events",
  "macro-indicators",
  "derivatives-volatility",
  "on-chain",
  "target-valuation",
  "peer-valuation",
  "subject-profile",
] as const;

export const LEGACY_EVIDENCE_LANES = [
  "macro-context",
  "verified-snapshot",
  "sec-edgar",
  "equity-events",
  "extended-fred-macro",
  "options-iv",
  "valuation",
] as const;

export type EvidenceLane = (typeof EVIDENCE_LANES)[number] | (typeof LEGACY_EVIDENCE_LANES)[number];

export type EvidenceClass = "core" | "material" | "supplemental";
export type LaneRequirement = "required" | "optional";

export type LaneCoverageStatus = "covered" | "gap" | "not-covered";

// ---------------------------------------------------------------------------
// Persisted artifact shapes (disk boundary)
//
// These tolerate BOTH the legacy v1 schema (requirement/required/providerPath,
// Required/optional lane counts) and the current v2 schema (evidenceClass,
// Core/material/supplemental counts). Fields are optional only because a single
// Type has to describe whichever version was on disk. The reader in
// `src/run-artifacts.ts` is the only producer; consumers that need a guaranteed
// V2 shape use the strict `*V2` types below, which `buildSourcePlan` emits.
// ---------------------------------------------------------------------------

export interface SourcePlanLane {
  readonly lane: EvidenceLane;
  readonly evidenceClass?: EvidenceClass;
  readonly requirement?: "required" | "optional";
  readonly appliesToRun: boolean;
  readonly capability?: EvidenceLane;
  readonly providerPath?: string;
}

export interface SourcePlanRun {
  readonly jobType: ResearchCommand["jobType"];
  readonly assetClass: AssetClass;
  readonly symbol?: string;
  readonly subject?: string;
  readonly depth: ResearchCommand["depth"];
}

export interface SourcePlanArtifact {
  readonly version: 1 | 2;
  readonly generatedAt: string;
  readonly run: SourcePlanRun;
  readonly lanes: readonly SourcePlanLane[];
}

export interface EvidenceLaneCoverage {
  readonly lane: EvidenceLane;
  readonly evidenceClass?: EvidenceClass;
  readonly required?: boolean;
  readonly status: LaneCoverageStatus;
  readonly coveredSourceIds: readonly string[];
  readonly gapIds: readonly string[];
  readonly gapText: readonly string[];
  readonly freshnessNotes: readonly string[];
}

export interface EvidenceLanesArtifact {
  readonly version: 1 | 2;
  readonly generatedAt: string;
  readonly lanes: readonly EvidenceLaneCoverage[];
  readonly summary: EvidenceLaneSummary;
}

export interface SourceLedgerEntry {
  readonly id: string;
  readonly kind: Source["kind"];
  readonly provider?: string;
  readonly fetchedAt?: string;
  readonly observedAt?: string;
  readonly lane: EvidenceLane;
  readonly posture: "covered";
  readonly relatedGapIds: readonly string[];
}

export interface SourceLedgerArtifact {
  readonly version: 1 | 2;
  readonly generatedAt: string;
  readonly sources: readonly SourceLedgerEntry[];
}

export interface EvidenceLaneSummary {
  readonly plannedLaneCount: number;
  readonly coreLaneCount?: number;
  readonly materialLaneCount?: number;
  readonly supplementalLaneCount?: number;
  readonly requiredLaneCount?: number;
  readonly optionalLaneCount?: number;
  readonly coveredLaneCount: number;
  readonly gapLaneCount: number;
  readonly coreGapLaneCount?: number;
  readonly materialGapLaneCount?: number;
  readonly requiredGapLaneCount?: number;
  readonly sourceCount: number;
  readonly gapCount: number;
  readonly coverageRatio: number;
}

// ---------------------------------------------------------------------------
// Fresh-build artifact shapes (v2 only)
//
// `buildSourcePlan` always emits these: every field is populated, so in-memory
// Consumers (evidence-quality, orchestrator trace, run-analytics) read them
// Without fallbacks. A strict v2 value is structurally assignable to the
// Persisted shape above, so it serializes through the disk boundary unchanged.
// ---------------------------------------------------------------------------

export interface SourcePlanLaneV2 {
  readonly lane: EvidenceLane;
  readonly evidenceClass: EvidenceClass;
  readonly appliesToRun: boolean;
  readonly capability: EvidenceLane;
}

export interface SourcePlanArtifactV2 {
  readonly version: 2;
  readonly generatedAt: string;
  readonly run: SourcePlanRun;
  readonly lanes: readonly SourcePlanLaneV2[];
}

export interface EvidenceLaneCoverageV2 {
  readonly lane: EvidenceLane;
  readonly evidenceClass: EvidenceClass;
  readonly status: LaneCoverageStatus;
  readonly coveredSourceIds: readonly string[];
  readonly gapIds: readonly string[];
  readonly gapText: readonly string[];
  readonly freshnessNotes: readonly string[];
}

export interface EvidenceLaneSummaryV2 {
  readonly plannedLaneCount: number;
  readonly coreLaneCount: number;
  readonly materialLaneCount: number;
  readonly supplementalLaneCount: number;
  readonly coveredLaneCount: number;
  readonly gapLaneCount: number;
  readonly coreGapLaneCount: number;
  readonly materialGapLaneCount: number;
  readonly sourceCount: number;
  readonly gapCount: number;
  readonly coverageRatio: number;
}

export interface EvidenceLanesArtifactV2 {
  readonly version: 2;
  readonly generatedAt: string;
  readonly lanes: readonly EvidenceLaneCoverageV2[];
  readonly summary: EvidenceLaneSummaryV2;
}

export interface SourceLedgerArtifactV2 {
  readonly version: 2;
  readonly generatedAt: string;
  readonly sources: readonly SourceLedgerEntry[];
}

export interface BuildSourcePlanResult {
  readonly sourcePlan: SourcePlanArtifactV2;
  readonly evidenceLanes: EvidenceLanesArtifactV2;
  readonly sourceLedger: SourceLedgerArtifactV2;
}

// Lane applicability and evidence class are pre-collection policy: they derive
// Only from the resolved command, checked-in research subject, asset class, and
// Depth — never from collected outcomes, credentials, provider availability, or
// Successful fetches. sourceIds/gapMatches run post-collection in assessment.
interface LaneDefinition {
  readonly lane: EvidenceLane;
  readonly evidenceClass: (command: ResearchCommand) => EvidenceClass;
  readonly applies: (
    command: ResearchCommand,
    resolvedSubject: ResolvedResearchSubject | undefined,
  ) => boolean;
  readonly sourceIds: (collectedSources: CollectedSources) => readonly string[];
  readonly gapMatches: (gap: SourceGap) => boolean;
}

function isMarketDataLaneGap(gap: SourceGap): boolean {
  return (
    gap.capability === "market-data" &&
    gap.source !== "yahoo-verified-chart" &&
    gap.source !== "massive-supplemental-market"
  );
}

function marketDataApplies(
  command: ResearchCommand,
  resolvedSubject: ResolvedResearchSubject | undefined,
): boolean {
  return (
    command.jobType !== "research" ||
    command.predictionProxySymbol !== undefined ||
    resolvedSubject?.status === "resolved"
  );
}

const LANE_DEFINITIONS: readonly LaneDefinition[] = [
  {
    lane: "market-data",
    evidenceClass: () => "core",
    applies: marketDataApplies,
    sourceIds: (sources) => [
      ...sources.marketSnapshots.map((snapshot) => snapshot.sourceId),
      ...sources.marketSnapshots.flatMap((snapshot) =>
        snapshot.benchmark === undefined ? [] : [snapshot.benchmark.sourceId],
      ),
    ],
    gapMatches: isMarketDataLaneGap,
  },
  {
    lane: "supplemental-market",
    evidenceClass: () => "supplemental",
    applies: (command) => command.assetClass === "equity",
    sourceIds: (sources) =>
      sources.supplementalMarketSnapshots.map((snapshot) => snapshot.sourceId),
    gapMatches: (gap) => gap.source === "massive-supplemental-market",
  },
  {
    lane: "news",
    evidenceClass: () => "material",
    applies: () => true,
    sourceIds: (sources) => sources.newsSources.map((source) => source.id),
    gapMatches: (gap) => gap.capability === "news",
  },
  {
    lane: "market-context",
    evidenceClass: () => "material",
    applies: (command) => isMarketUpdateJobType(command.jobType),
    sourceIds: (sources) => sources.marketContext?.items.flatMap((item) => item.sourceIds) ?? [],
    gapMatches: (gap) => gap.capability === "market-context",
  },
  {
    lane: "verified-price-history",
    evidenceClass: () => "core",
    applies: (command) => isInstrumentCommand(command) && command.assetClass === "equity",
    sourceIds: (sources) =>
      sources.verifiedMarketSnapshot === undefined
        ? []
        : [verifiedSnapshotSourceId(sources.verifiedMarketSnapshot.symbol)],
    gapMatches: (gap) => gap.source === "yahoo-verified-chart",
  },
  {
    lane: "regulatory-filings",
    evidenceClass: () => "material",
    applies: (command) =>
      isInstrumentCommand(command) &&
      command.assetClass === "equity" &&
      isUsListing(command.symbol),
    sourceIds: (sources) => extendedEvidenceSourceIds(sources, "sec-edgar"),
    gapMatches: (gap) => gap.source.startsWith("sec-"),
  },
  {
    lane: "corporate-events",
    evidenceClass: (command) => (command.depth === "deep" ? "material" : "supplemental"),
    applies: (command) =>
      isInstrumentCommand(command) &&
      command.assetClass === "equity" &&
      isUsListing(command.symbol),
    sourceIds: (sources) => extendedEvidenceSourceIds(sources, "equity-events"),
    gapMatches: (gap) => gap.source.startsWith("finnhub-events"),
  },
  {
    lane: "macro-indicators",
    evidenceClass: (command) => (command.depth === "deep" ? "material" : "supplemental"),
    applies: (command) => isInstrumentCommand(command),
    sourceIds: (sources) => extendedEvidenceSourceIds(sources, "fred-macro"),
    gapMatches: (gap) => gap.capability === "extended-evidence" && gap.source.startsWith("fred-"),
  },
  {
    lane: "derivatives-volatility",
    evidenceClass: () => "supplemental",
    applies: (command) =>
      isInstrumentCommand(command) &&
      command.assetClass === "equity" &&
      isUsListing(command.symbol),
    sourceIds: (sources) => extendedEvidenceSourceIds(sources, "options-iv"),
    gapMatches: (gap) => gap.source.startsWith("tradier-"),
  },
  {
    lane: "on-chain",
    evidenceClass: () => "supplemental",
    applies: (command) => isInstrumentCommand(command) && command.assetClass === "crypto",
    sourceIds: (sources) => extendedEvidenceSourceIds(sources, "on-chain"),
    gapMatches: (gap) => gap.source.startsWith("glassnode-"),
  },
  {
    lane: "target-valuation",
    evidenceClass: () => "material",
    applies: (command) => isInstrumentCommand(command) && command.assetClass === "equity",
    sourceIds: (sources) =>
      sources.valuationComps?.target.sourceIds ?? extendedEvidenceSourceIds(sources, "valuation"),
    gapMatches: (gap) => gap.source === "valuation",
  },
  {
    lane: "peer-valuation",
    evidenceClass: () => "supplemental",
    applies: (command) =>
      isInstrumentCommand(command) && command.assetClass === "equity" && command.depth === "deep",
    sourceIds: (sources) => sources.valuationComps?.peers.flatMap((peer) => peer.sourceIds) ?? [],
    gapMatches: (gap) => gap.source === "valuation-peers",
  },
  {
    lane: "subject-profile",
    evidenceClass: () => "supplemental",
    applies: (command) =>
      command.depth === "deep" &&
      (command.jobType === "research" ||
        (isInstrumentCommand(command) &&
          (command.assetClass === "equity" || command.assetClass === "crypto"))),
    sourceIds: (sources) => sources.webSubjectProfile?.sourceIds ?? [],
    gapMatches: (gap) => gap.source === "web-subject-profile",
  },
];

function extendedEvidenceSourceIds(
  sources: CollectedSources,
  category: NonNullable<CollectedSources["extendedEvidence"]>["items"][number]["category"],
): readonly string[] {
  return (
    sources.extendedEvidence?.items
      .filter((item) => item.category === category)
      .flatMap((item) => item.sourceIds) ?? []
  );
}

function gapId(lane: EvidenceLane, index: number): string {
  return `${lane}:gap:${String(index + 1)}`;
}

function gapText(gap: SourceGap): string {
  return `${gap.source}: ${gap.message}`;
}

function syntheticMissingGap(lane: EvidenceLane): readonly string[] {
  return [`${lane}: required evidence lane had no backing source`];
}

function sourceProvider(source: Source): string | undefined {
  return source.provider ?? source.providerAliases?.[0]?.provider;
}

function marketProvider(assetClass: AssetClass, sourceId: string): string {
  if (sourceId.startsWith("massive-") || sourceId.startsWith("supplemental-market-massive-")) {
    return "massive";
  }
  return assetClass === "crypto" ? "coingecko" : "yahoo";
}

function ledgerEntriesForLane(
  lane: EvidenceLane,
  sourceIds: readonly string[],
  collectedSources: CollectedSources,
  relatedGapIds: readonly string[],
): readonly SourceLedgerEntry[] {
  const reportSources = [
    ...collectedSources.newsSources,
    ...collectedSources.extendedSources,
    ...collectedSources.marketContextSources,
  ];
  const sourceById = new Map(reportSources.map((source) => [source.id, source]));

  return sourceIds.map((id): SourceLedgerEntry => {
    const source = sourceById.get(id);
    if (source !== undefined) {
      const provider = sourceProvider(source);
      return {
        id,
        kind: source.kind,
        ...(provider !== undefined ? { provider } : {}),
        fetchedAt: source.fetchedAt,
        lane,
        posture: "covered",
        relatedGapIds,
      };
    }
    const snapshot = [
      ...collectedSources.marketSnapshots,
      ...collectedSources.supplementalMarketSnapshots,
    ].find((item) => item.sourceId === id || item.benchmark?.sourceId === id);
    if (snapshot !== undefined) {
      return {
        id,
        kind: "market-data",
        provider: marketProvider(snapshot.assetClass, id),
        observedAt:
          snapshot.benchmark?.sourceId === id ? snapshot.benchmark.observedAt : snapshot.observedAt,
        lane,
        posture: "covered",
        relatedGapIds,
      };
    }
    const observedAt = collectedSources.verifiedMarketSnapshot?.fetchedAt;
    return {
      id,
      kind: "market-data",
      provider: "yahoo",
      ...(observedAt !== undefined ? { observedAt } : {}),
      lane,
      posture: "covered",
      relatedGapIds,
    };
  });
}

function freshnessNotes(entries: readonly SourceLedgerEntry[]): readonly string[] {
  const latest = entries
    .map((entry) => entry.observedAt ?? entry.fetchedAt)
    .filter((value): value is string => value !== undefined)
    .toSorted()
    .at(-1);
  return latest === undefined ? [] : [`latest evidence timestamp ${latest}`];
}

function summary(lanes: readonly EvidenceLaneCoverageV2[]): EvidenceLaneSummaryV2 {
  const coveredLaneCount = lanes.filter((lane) => lane.status === "covered").length;
  const gapLaneCount = lanes.filter((lane) => lane.status === "gap").length;
  const plannedLaneCount = lanes.length;
  return {
    plannedLaneCount,
    coreLaneCount: lanes.filter((lane) => lane.evidenceClass === "core").length,
    materialLaneCount: lanes.filter((lane) => lane.evidenceClass === "material").length,
    supplementalLaneCount: lanes.filter((lane) => lane.evidenceClass === "supplemental").length,
    coveredLaneCount,
    gapLaneCount,
    coreGapLaneCount: lanes.filter(
      (lane) => lane.evidenceClass === "core" && lane.status !== "covered",
    ).length,
    materialGapLaneCount: lanes.filter(
      (lane) => lane.evidenceClass === "material" && lane.status !== "covered",
    ).length,
    sourceCount: lanes.reduce((total, lane) => total + lane.coveredSourceIds.length, 0),
    gapCount: lanes.reduce((total, lane) => total + lane.gapIds.length, 0),
    coverageRatio: plannedLaneCount === 0 ? 1 : coveredLaneCount / plannedLaneCount,
  };
}

function coverageStatus(
  sourceIds: readonly string[],
  gapIds: readonly string[],
): LaneCoverageStatus {
  if (sourceIds.length > 0) {
    return "covered";
  }
  return gapIds.length > 0 ? "gap" : "not-covered";
}

function noProxySourcePlanGap(
  run: SourcePlanRun,
  collectedSources: CollectedSources,
  lane: EvidenceLane,
): readonly string[] | undefined {
  if (
    lane !== "market-data" ||
    run.jobType !== "research" ||
    collectedSources.resolvedSubject?.status !== "resolved" ||
    collectedSources.resolvedSubject.subjectKey === undefined ||
    collectedSources.resolvedSubject.predictionProxySymbol !== undefined
  ) {
    return undefined;
  }
  return [
    `researchSubjectProxy: subject ${collectedSources.resolvedSubject.subjectKey} has no listed prediction proxy; market-data lane cannot be covered`,
  ];
}

// Builds the immutable v2 Source Plan from the resolved command and checked-in
// Research subject only. Call it before the first source-provider I/O so the
// Plan records pre-collection intent; collection outcomes cannot change it.
export function buildSourcePlan(
  command: ResearchCommand,
  generatedAt: string,
  resolvedSubject?: ResolvedResearchSubject,
): SourcePlanArtifactV2 {
  const subject = resolvedSubject ?? resolveResearchSubject(command);
  const planned = LANE_DEFINITIONS.filter((definition) => definition.applies(command, subject));
  return {
    version: 2,
    generatedAt,
    run: {
      jobType: command.jobType,
      assetClass: command.assetClass,
      ...(isInstrumentCommand(command) ? { symbol: command.symbol } : {}),
      ...(command.jobType === "research" ? { subject: command.subject } : {}),
      depth: command.depth,
    },
    lanes: planned.map((definition) => ({
      lane: definition.lane,
      evidenceClass: definition.evidenceClass(command),
      appliesToRun: true,
      capability: definition.lane,
    })),
  };
}

const LANE_DEFINITIONS_BY_LANE = new Map(
  LANE_DEFINITIONS.map((definition) => [definition.lane, definition]),
);

// Grades collected sources against the frozen plan after collection: every
// Planned lane gets a coverage entry, and lane identity plus evidence class
// Come from the plan, never from collection outcomes.
export function assessSourcePlan(
  sourcePlan: SourcePlanArtifactV2,
  collectedSources: CollectedSources,
  generatedAt: string,
): BuildSourcePlanResult {
  const ledger: SourceLedgerEntry[] = [];
  const coverage = sourcePlan.lanes.map((planLane): EvidenceLaneCoverageV2 => {
    const definition = LANE_DEFINITIONS_BY_LANE.get(planLane.lane);
    const { evidenceClass } = planLane;
    const sourceIds =
      definition === undefined ? [] : [...new Set(definition.sourceIds(collectedSources))];
    const matchedGaps =
      definition === undefined
        ? []
        : collectedSources.sourceGaps.filter((gap) => definition.gapMatches(gap));
    const sourceGapIds = matchedGaps.map((_, index) => gapId(planLane.lane, index));
    const syntheticNoProxyGap = noProxySourcePlanGap(
      sourcePlan.run,
      collectedSources,
      planLane.lane,
    );
    const gapIds =
      sourceIds.length === 0 &&
      evidenceClass === "core" &&
      (sourceGapIds.length === 0 || syntheticNoProxyGap !== undefined)
        ? [gapId(planLane.lane, 0)]
        : sourceGapIds;
    const gapLines =
      syntheticNoProxyGap ??
      (sourceIds.length === 0 && evidenceClass === "core" && matchedGaps.length === 0
        ? syntheticMissingGap(planLane.lane)
        : matchedGaps.map((gap) => gapText(gap)));
    const entries = ledgerEntriesForLane(planLane.lane, sourceIds, collectedSources, gapIds);
    ledger.push(...entries);
    return {
      lane: planLane.lane,
      evidenceClass,
      status: coverageStatus(sourceIds, gapIds),
      coveredSourceIds: sourceIds,
      gapIds,
      gapText: gapLines,
      freshnessNotes: freshnessNotes(entries),
    };
  });

  return {
    sourcePlan,
    evidenceLanes: {
      version: 2,
      generatedAt,
      lanes: coverage,
      summary: summary(coverage),
    },
    sourceLedger: {
      version: 2,
      generatedAt,
      sources: ledger,
    },
  };
}
