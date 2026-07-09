import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config";
import { isInstrumentCommand, type ResearchCommand } from "./cli/args";
import { writeJson, type RunArtifactPaths } from "./artifacts";
import { compactUnmappedSecFilingGaps } from "./domain/source-gaps";
import {
  isMarketUpdateJobType,
  type Mover,
  type ResearchReport,
  type RunTrace,
  type SourceGap,
} from "./domain/types";
import { RUN_ARTIFACT_FILES, type RunArtifactFileName } from "./run-artifact-layout";
import type { AlphaSearchRunAnalytics } from "./alpha-search/workflow";
import type { AlphaCandidateProfile } from "./alpha-search/candidate-state";
import type { AlphaSearchCandidate } from "./alpha-search/candidates";
import type { AlphaSearchFundamentals } from "./alpha-search/fundamentals";
import type { ListedUniverseEntry } from "./alpha-search/listed-universe";
import type { AlphaSearchLead, AlphaSearchRejectedCandidate } from "./alpha-search/report-extras";
import type { SecDiscoveryCandidate } from "./alpha-search/sec-discovery";
import type { SocialMomentumRankedCandidate } from "./alpha-search/social-momentum-ranking";
import type { ForecastDisagreementArtifact } from "./research/forecast-disagreement";
import type { HistoricalResearchContext } from "./research/historical-context";
import { emptySpotlightSelectionFor } from "./research/market-update-phase";
import type {
  SourcePlanArtifact,
  EvidenceLanesArtifact,
  SourceLedgerArtifact,
} from "./research/source-plan";
import type { SpotlightCandidate, SpotlightSelectionResult } from "./research/spotlights";
import { compactOversizedRawSnapshots } from "./sources/raw-snapshots";
import type { CollectedSources, RawSourceSnapshot } from "./sources/types";

export interface RunArtifactWrite {
  readonly file: RunArtifactFileName;
  readonly kind: "json" | "text";
  readonly value: unknown;
}

export interface ResearchRunManifestResult {
  readonly report: ResearchReport;
  readonly markdown: string;
  readonly trace: RunTrace;
  readonly analytics: unknown;
  readonly stageOutputs: readonly unknown[];
  readonly collectedSources: CollectedSources;
  readonly historicalContext: HistoricalResearchContext;
  readonly sourcePlan: SourcePlanArtifact;
  readonly evidenceLanes: EvidenceLanesArtifact;
  readonly sourceLedger: SourceLedgerArtifact;
  readonly forecastDisagreement?: ForecastDisagreementArtifact;
  readonly spotlightCandidates?: readonly SpotlightCandidate[];
  readonly spotlightSelection?: SpotlightSelectionResult;
  readonly marketUpdateMovers?: readonly Mover[];
}

export interface AlphaSearchManifestInput {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly socialCandidates: readonly SocialMomentumRankedCandidate[];
  readonly secDiscoveryCandidates: readonly SecDiscoveryCandidate[];
  readonly alphaSearchCandidates: readonly AlphaSearchCandidate[];
  readonly listedUniverse: readonly ListedUniverseEntry[];
  readonly researchLeads: readonly AlphaSearchLead[];
  readonly secFundamentals: readonly AlphaSearchFundamentals[];
  readonly secFundamentalsSourceGaps: readonly SourceGap[];
  readonly candidateProfiles: readonly AlphaCandidateProfile[];
  readonly rejectedCandidates: readonly AlphaSearchRejectedCandidate[];
  readonly sourceGaps: readonly SourceGap[];
  readonly analytics: AlphaSearchRunAnalytics;
  readonly report: ResearchReport;
  readonly markdown: string;
  readonly trace: RunTrace;
}

interface CollectedSourceSidecar {
  readonly file: RunArtifactFileName;
  readonly value: (result: ResearchRunManifestResult) => unknown;
}

const COMMON_COLLECTED_SOURCE_SIDECARS: readonly CollectedSourceSidecar[] = [
  {
    file: RUN_ARTIFACT_FILES.webSubjectProfile,
    value: (result) => result.collectedSources.webSubjectProfile ?? null,
  },
  {
    file: RUN_ARTIFACT_FILES.extendedEvidence,
    value: (result) => result.collectedSources.extendedEvidence ?? null,
  },
  {
    file: RUN_ARTIFACT_FILES.marketContext,
    value: (result) => result.collectedSources.marketContext ?? null,
  },
];

const INSTRUMENT_COLLECTED_SOURCE_SIDECARS: readonly CollectedSourceSidecar[] = [
  {
    file: RUN_ARTIFACT_FILES.verifiedMarketSnapshot,
    value: (result) => result.collectedSources.verifiedMarketSnapshot ?? null,
  },
  {
    file: RUN_ARTIFACT_FILES.instrumentIdentity,
    value: (result) => result.collectedSources.resolvedInstrumentIdentity ?? null,
  },
  {
    file: RUN_ARTIFACT_FILES.valuationComps,
    value: (result) => result.collectedSources.valuationComps ?? null,
  },
  {
    file: RUN_ARTIFACT_FILES.financialLenses,
    value: (result) => result.collectedSources.financialLenses ?? null,
  },
  {
    file: RUN_ARTIFACT_FILES.businessFramework,
    value: (result) => result.collectedSources.businessFramework ?? null,
  },
];

function sidecarWrites(
  result: ResearchRunManifestResult,
  sidecars: readonly CollectedSourceSidecar[],
): readonly RunArtifactWrite[] {
  return sidecars.map((sidecar) => ({
    file: sidecar.file,
    kind: "json",
    value: sidecar.value(result),
  }));
}

export function buildResearchRunManifest(
  command: ResearchCommand,
  config: AppConfig,
  result: ResearchRunManifestResult,
): readonly RunArtifactWrite[] {
  const writes: RunArtifactWrite[] = [
    {
      file: RUN_ARTIFACT_FILES.rawSnapshots,
      kind: "json",
      value: compactOversizedRawSnapshots(result.collectedSources.rawSnapshots),
    },
    {
      file: RUN_ARTIFACT_FILES.marketSnapshots,
      kind: "json",
      value: result.collectedSources.marketSnapshots,
    },
    {
      file: RUN_ARTIFACT_FILES.supplementalMarketSnapshots,
      kind: "json",
      value: result.collectedSources.supplementalMarketSnapshots,
    },
    {
      file: RUN_ARTIFACT_FILES.newsSources,
      kind: "json",
      value: result.collectedSources.newsSources,
    },
    {
      file: RUN_ARTIFACT_FILES.extendedSources,
      kind: "json",
      value: result.collectedSources.extendedSources,
    },
    {
      file: RUN_ARTIFACT_FILES.sourceGaps,
      kind: "json",
      value: result.collectedSources.sourceGaps,
    },
    { file: RUN_ARTIFACT_FILES.sourcePlan, kind: "json", value: result.sourcePlan },
    { file: RUN_ARTIFACT_FILES.evidenceLanes, kind: "json", value: result.evidenceLanes },
    { file: RUN_ARTIFACT_FILES.sourceLedger, kind: "json", value: result.sourceLedger },
    {
      file: RUN_ARTIFACT_FILES.historicalContext,
      kind: "json",
      value: result.historicalContext,
    },
    ...sidecarWrites(result, COMMON_COLLECTED_SOURCE_SIDECARS),
  ];

  if (command.jobType === "research") {
    writes.push(
      {
        file: RUN_ARTIFACT_FILES.resolvedSubject,
        kind: "json",
        value: result.collectedSources.resolvedSubject ?? null,
      },
      {
        file: RUN_ARTIFACT_FILES.verifiedRepresentativeSnapshots,
        kind: "json",
        value: result.collectedSources.verifiedRepresentativeSnapshots ?? [],
      },
    );
  }

  if (result.trace.webGatherLoop !== undefined) {
    writes.push({
      file: RUN_ARTIFACT_FILES.webGatherAudit,
      kind: "json",
      value: result.trace.webGatherLoop,
    });
  }

  if (isInstrumentCommand(command)) {
    writes.push(...sidecarWrites(result, INSTRUMENT_COLLECTED_SOURCE_SIDECARS));
  }

  if (isMarketUpdateJobType(command.jobType)) {
    writes.push(
      {
        file: RUN_ARTIFACT_FILES.spotlightCandidates,
        kind: "json",
        value: result.spotlightCandidates ?? [],
      },
      {
        file: RUN_ARTIFACT_FILES.spotlightSelection,
        kind: "json",
        value: result.spotlightSelection ?? emptySpotlightSelectionFor(command, config),
      },
      {
        file: RUN_ARTIFACT_FILES.movers,
        kind: "json",
        value: result.marketUpdateMovers ?? [],
      },
    );
  }

  writes.push(
    { file: RUN_ARTIFACT_FILES.stages, kind: "json", value: result.stageOutputs },
    { file: RUN_ARTIFACT_FILES.analytics, kind: "json", value: result.analytics },
  );

  if (result.forecastDisagreement !== undefined) {
    writes.push({
      file: RUN_ARTIFACT_FILES.forecastDisagreement,
      kind: "json",
      value: result.forecastDisagreement,
    });
  }

  writes.push(
    { file: RUN_ARTIFACT_FILES.report, kind: "json", value: result.report },
    { file: RUN_ARTIFACT_FILES.reportMarkdown, kind: "text", value: result.markdown },
    { file: RUN_ARTIFACT_FILES.trace, kind: "json", value: result.trace },
  );

  return writes;
}

export function buildAlphaSearchManifest(
  input: AlphaSearchManifestInput,
): readonly RunArtifactWrite[] {
  return [
    {
      file: RUN_ARTIFACT_FILES.rawSnapshots,
      kind: "json",
      value: compactOversizedRawSnapshots(input.rawSnapshots),
    },
    { file: RUN_ARTIFACT_FILES.socialCandidates, kind: "json", value: input.socialCandidates },
    {
      file: RUN_ARTIFACT_FILES.secDiscoveryCandidates,
      kind: "json",
      value: input.secDiscoveryCandidates,
    },
    {
      file: RUN_ARTIFACT_FILES.alphaSearchCandidates,
      kind: "json",
      value: input.alphaSearchCandidates,
    },
    { file: RUN_ARTIFACT_FILES.listedUniverse, kind: "json", value: input.listedUniverse },
    { file: RUN_ARTIFACT_FILES.researchLeads, kind: "json", value: input.researchLeads },
    { file: RUN_ARTIFACT_FILES.secFundamentals, kind: "json", value: input.secFundamentals },
    {
      file: RUN_ARTIFACT_FILES.secFundamentalsSourceGaps,
      kind: "json",
      value: input.secFundamentalsSourceGaps,
    },
    { file: RUN_ARTIFACT_FILES.candidateProfiles, kind: "json", value: input.candidateProfiles },
    { file: RUN_ARTIFACT_FILES.rejectedCandidates, kind: "json", value: input.rejectedCandidates },
    {
      file: RUN_ARTIFACT_FILES.sourceGaps,
      kind: "json",
      value: compactUnmappedSecFilingGaps(input.sourceGaps),
    },
    { file: RUN_ARTIFACT_FILES.analytics, kind: "json", value: input.analytics },
    { file: RUN_ARTIFACT_FILES.report, kind: "json", value: input.report },
    { file: RUN_ARTIFACT_FILES.reportMarkdown, kind: "text", value: input.markdown },
    { file: RUN_ARTIFACT_FILES.trace, kind: "json", value: input.trace },
  ];
}

export async function persistRunArtifactWrites(
  artifacts: RunArtifactPaths,
  writes: readonly RunArtifactWrite[],
): Promise<void> {
  // Manifests must not contain duplicate files; callers build one value per sidecar.
  await Promise.all(writes.map((write) => persistRunArtifactWrite(artifacts, write)));
}

async function persistRunArtifactWrite(
  artifacts: RunArtifactPaths,
  write: RunArtifactWrite,
): Promise<void> {
  const path = join(artifacts.runDir, write.file);
  if (write.kind === "json") {
    await writeJson(path, write.value);
    return;
  }
  if (typeof write.value !== "string") {
    throw new TypeError(`Expected text artifact ${write.file} to be a string`);
  }
  await writeFile(path, write.value, "utf8");
}
