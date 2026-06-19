import type { ResearchCommand } from "../cli/args";
import type { AssetClass, Source, SourceGap } from "../domain/types";
import { verifiedSnapshotSourceId } from "./verified-snapshot-contract";
import type { CollectedSources } from "../sources/types";

export type EvidenceLane =
  | "market-data"
  | "supplemental-market"
  | "news"
  | "macro-context"
  | "verified-snapshot"
  | "sec-edgar"
  | "equity-events"
  | "extended-fred-macro"
  | "options-iv"
  | "on-chain"
  | "valuation";

export type LaneRequirement = "required" | "optional";

export type LaneCoverageStatus = "covered" | "gap" | "not-covered";

export interface SourcePlanLane {
  readonly lane: EvidenceLane;
  readonly requirement: LaneRequirement;
  readonly appliesToRun: boolean;
  readonly providerPath: string;
}

export interface SourcePlanArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly run: {
    readonly jobType: ResearchCommand["jobType"];
    readonly assetClass: AssetClass;
    readonly symbol?: string;
    readonly subject?: string;
    readonly depth: ResearchCommand["depth"];
  };
  readonly lanes: readonly SourcePlanLane[];
}

export interface EvidenceLaneCoverage {
  readonly lane: EvidenceLane;
  readonly status: LaneCoverageStatus;
  readonly required: boolean;
  readonly coveredSourceIds: readonly string[];
  readonly gapIds: readonly string[];
  readonly gapText: readonly string[];
  readonly freshnessNotes: readonly string[];
}

export interface EvidenceLanesArtifact {
  readonly version: 1;
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
  readonly version: 1;
  readonly generatedAt: string;
  readonly sources: readonly SourceLedgerEntry[];
}

export interface EvidenceLaneSummary {
  readonly plannedLaneCount: number;
  readonly requiredLaneCount: number;
  readonly optionalLaneCount: number;
  readonly coveredLaneCount: number;
  readonly gapLaneCount: number;
  readonly requiredGapLaneCount: number;
  readonly sourceCount: number;
  readonly gapCount: number;
  readonly coverageRatio: number;
}

export interface BuildSourcePlanResult {
  readonly sourcePlan: SourcePlanArtifact;
  readonly evidenceLanes: EvidenceLanesArtifact;
  readonly sourceLedger: SourceLedgerArtifact;
}

interface LaneDefinition {
  readonly lane: EvidenceLane;
  readonly requirement: LaneRequirement;
  readonly providerPath: string;
  readonly applies: (command: ResearchCommand, collectedSources: CollectedSources) => boolean;
  readonly sourceIds: (collectedSources: CollectedSources) => readonly string[];
  readonly gapMatches: (gap: SourceGap) => boolean;
}

const LANE_DEFINITIONS: readonly LaneDefinition[] = [
  {
    lane: "market-data",
    requirement: "required",
    providerPath: "yahoo equity market data or coingecko crypto market data",
    applies: (command, collectedSources) =>
      command.jobType !== "research" || collectedSources.marketSnapshots.length > 0,
    sourceIds: (sources) => [
      ...sources.marketSnapshots.map((snapshot) => snapshot.sourceId),
      ...sources.marketSnapshots.flatMap((snapshot) =>
        snapshot.benchmark === undefined ? [] : [snapshot.benchmark.sourceId],
      ),
    ],
    gapMatches: (gap) =>
      gap.capability === "market-data" &&
      gap.source !== "yahoo-verified-chart" &&
      gap.source !== "massive-supplemental-market",
  },
  {
    lane: "supplemental-market",
    requirement: "optional",
    providerPath: "massive supplemental equity snapshots",
    applies: (command) => command.assetClass === "equity",
    sourceIds: (sources) =>
      sources.supplementalMarketSnapshots.map((snapshot) => snapshot.sourceId),
    gapMatches: (gap) => gap.source === "massive-supplemental-market",
  },
  {
    lane: "news",
    requirement: "optional",
    providerPath: "marketaux, finnhub, yahoo news, or massive news",
    applies: () => true,
    sourceIds: (sources) => sources.newsSources.map((source) => source.id),
    gapMatches: (gap) => gap.capability === "news",
  },
  {
    lane: "macro-context",
    requirement: "optional",
    providerPath: "market-context adapter backed by FRED",
    applies: (command) =>
      command.jobType === "market-overview" ||
      command.jobType === "daily" ||
      command.jobType === "weekly",
    sourceIds: (sources) => sources.marketContext?.items.flatMap((item) => item.sourceIds) ?? [],
    gapMatches: (gap) => gap.capability === "market-context",
  },
  {
    lane: "verified-snapshot",
    requirement: "required",
    providerPath: "yahoo verified chart for equity ticker runs",
    applies: (command) => command.jobType === "ticker" && command.assetClass === "equity",
    sourceIds: (sources) =>
      sources.verifiedMarketSnapshot === undefined
        ? []
        : [verifiedSnapshotSourceId(sources.verifiedMarketSnapshot.symbol)],
    gapMatches: (gap) => gap.source === "yahoo-verified-chart",
  },
  {
    lane: "sec-edgar",
    requirement: "optional",
    providerPath: "SEC EDGAR extended evidence for equity ticker runs",
    applies: (command) => command.jobType === "ticker" && command.assetClass === "equity",
    sourceIds: (sources) => extendedEvidenceSourceIds(sources, "sec-edgar"),
    gapMatches: (gap) => gap.source.startsWith("sec-"),
  },
  {
    lane: "equity-events",
    requirement: "optional",
    providerPath: "Finnhub events extended evidence for equity ticker runs",
    applies: (command) => command.jobType === "ticker" && command.assetClass === "equity",
    sourceIds: (sources) => extendedEvidenceSourceIds(sources, "equity-events"),
    gapMatches: (gap) => gap.source.startsWith("finnhub-events"),
  },
  {
    lane: "extended-fred-macro",
    requirement: "optional",
    providerPath: "FRED macro extended evidence for ticker runs",
    applies: (command) => command.jobType === "ticker",
    sourceIds: (sources) => extendedEvidenceSourceIds(sources, "fred-macro"),
    gapMatches: (gap) => gap.capability === "extended-evidence" && gap.source.startsWith("fred-"),
  },
  {
    lane: "options-iv",
    requirement: "optional",
    providerPath: "Tradier IV term structure for equity ticker runs",
    applies: (command) => command.jobType === "ticker" && command.assetClass === "equity",
    sourceIds: (sources) => extendedEvidenceSourceIds(sources, "options-iv"),
    gapMatches: (gap) => gap.source.startsWith("tradier-"),
  },
  {
    lane: "on-chain",
    requirement: "optional",
    providerPath: "Glassnode on-chain extended evidence for crypto ticker runs",
    applies: (command) => command.jobType === "ticker" && command.assetClass === "crypto",
    sourceIds: (sources) => extendedEvidenceSourceIds(sources, "on-chain"),
    gapMatches: (gap) => gap.source.startsWith("glassnode-"),
  },
  {
    lane: "valuation",
    requirement: "optional",
    providerPath: "derived from Yahoo market cap and SEC fundamentals for equity ticker runs",
    applies: (command) => command.jobType === "ticker" && command.assetClass === "equity",
    sourceIds: (sources) => extendedEvidenceSourceIds(sources, "valuation"),
    gapMatches: (gap) => gap.source === "valuation",
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

function summary(lanes: readonly EvidenceLaneCoverage[]): EvidenceLaneSummary {
  const coveredLaneCount = lanes.filter((lane) => lane.status === "covered").length;
  const gapLaneCount = lanes.filter((lane) => lane.status === "gap").length;
  const plannedLaneCount = lanes.length;
  return {
    plannedLaneCount,
    requiredLaneCount: lanes.filter((lane) => lane.required).length,
    optionalLaneCount: lanes.filter((lane) => !lane.required).length,
    coveredLaneCount,
    gapLaneCount,
    requiredGapLaneCount: lanes.filter((lane) => lane.required && lane.status === "gap").length,
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

export function buildSourcePlan(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  generatedAt: string,
): BuildSourcePlanResult {
  const planned = LANE_DEFINITIONS.filter((definition) =>
    definition.applies(command, collectedSources),
  );
  const ledger: SourceLedgerEntry[] = [];
  const coverage = planned.map((definition): EvidenceLaneCoverage => {
    const sourceIds = [...new Set(definition.sourceIds(collectedSources))];
    const matchedGaps = collectedSources.sourceGaps.filter((gap) => definition.gapMatches(gap));
    const sourceGapIds = matchedGaps.map((_, index) => gapId(definition.lane, index));
    const gapIds =
      sourceIds.length === 0 && definition.requirement === "required" && sourceGapIds.length === 0
        ? [gapId(definition.lane, 0)]
        : sourceGapIds;
    const gapLines =
      sourceIds.length === 0 && definition.requirement === "required" && matchedGaps.length === 0
        ? syntheticMissingGap(definition.lane)
        : matchedGaps.map((gap) => gapText(gap));
    const entries = ledgerEntriesForLane(definition.lane, sourceIds, collectedSources, gapIds);
    ledger.push(...entries);
    return {
      lane: definition.lane,
      status: coverageStatus(sourceIds, gapIds),
      required: definition.requirement === "required",
      coveredSourceIds: sourceIds,
      gapIds,
      gapText: gapLines,
      freshnessNotes: freshnessNotes(entries),
    };
  });

  return {
    sourcePlan: {
      version: 1,
      generatedAt,
      run: {
        jobType: command.jobType,
        assetClass: command.assetClass,
        ...(command.jobType === "ticker" ? { symbol: command.symbol } : {}),
        ...(command.jobType === "research" ? { subject: command.subject } : {}),
        depth: command.depth,
      },
      lanes: planned.map((definition) => ({
        lane: definition.lane,
        requirement: definition.requirement,
        appliesToRun: true,
        providerPath: definition.providerPath,
      })),
    },
    evidenceLanes: {
      version: 1,
      generatedAt,
      lanes: coverage,
      summary: summary(coverage),
    },
    sourceLedger: {
      version: 1,
      generatedAt,
      sources: ledger,
    },
  };
}
