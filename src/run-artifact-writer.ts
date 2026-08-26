import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config";
import { isInstrumentCommand, type ResearchCommand } from "./cli/args";
import { writeJson, type RunArtifactPaths } from "./artifacts";
import { compactUnmappedSecFilingGaps } from "./domain/source-gaps";
import { violatesResearchOnly } from "./domain/research-language";
import {
  type CodeVersion,
  type EvidenceQualityAssessment,
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
import type { StageOutput } from "./research/final-synthesis";
import type { HistoricalResearchContext } from "./research/historical-context";
import { emptySpotlightSelectionFor } from "./research/market-update-phase";
import type {
  SourcePlanArtifact,
  EvidenceLanesArtifact,
  SourceLedgerArtifact,
} from "./research/source-plan";
import type { SpotlightCandidate, SpotlightSelectionResult } from "./research/spotlights";
import { compactOversizedRawSnapshots } from "./sources/raw-snapshots";
import { isRecord } from "./guards";
import type { CollectedSources, RawSourceSnapshot } from "./sources/types";
import type { DeepEquityEvidenceBundleV1 } from "./deep-equity/types";
import { sumKnownCosts } from "./model/pricing";
import type { ModelReportPayload } from "./research/report-assembly";

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
  readonly deepEquityEvidenceBundle?: DeepEquityEvidenceBundleV1;
  readonly forecastDisagreement?: ForecastDisagreementArtifact;
  readonly spotlightCandidates?: readonly SpotlightCandidate[];
  readonly spotlightSelection?: SpotlightSelectionResult;
  readonly marketUpdateMovers?: readonly Mover[];
}

interface FailedRunManifestInput {
  readonly command: ResearchCommand;
  readonly runId: string;
  readonly generatedAt: string;
  readonly failedAt: string;
  readonly message: string;
  readonly reportValidationErrors: readonly string[];
  readonly predictionErrors: readonly string[];
  readonly totalCalls: number;
  readonly reportRepairReprompts: number;
  readonly stageOutputs: readonly StageOutput[];
  readonly payload: ModelReportPayload;
  readonly collectedSources: CollectedSources;
  readonly historicalContext: HistoricalResearchContext;
  readonly sourcePlan: SourcePlanArtifact;
  readonly evidenceLanes: EvidenceLanesArtifact;
  readonly sourceLedger: SourceLedgerArtifact;
  readonly evidenceQuality: EvidenceQualityAssessment;
  readonly codeVersion: CodeVersion;
  readonly sourceStateHash?: string;
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
  readonly omitWhenUndefined?: boolean;
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
    file: RUN_ARTIFACT_FILES.valuationWorkbench,
    value: (result) => result.collectedSources.valuationWorkbench ?? null,
  },
  {
    file: RUN_ARTIFACT_FILES.reverseDcf,
    value: (result) => result.collectedSources.reverseDcf ?? null,
  },
  {
    file: RUN_ARTIFACT_FILES.financialLenses,
    value: (result) => result.collectedSources.financialLenses ?? null,
  },
  {
    file: RUN_ARTIFACT_FILES.fundamentalHistory,
    value: (result) => result.collectedSources.fundamentalHistory ?? null,
  },
  {
    file: RUN_ARTIFACT_FILES.financialStatements,
    value: (result) => result.collectedSources.financialStatements ?? null,
  },
  {
    file: RUN_ARTIFACT_FILES.untaggedFinancialStatements,
    value: (result) => result.collectedSources.untaggedFinancialStatements,
    omitWhenUndefined: true,
  },
  {
    file: RUN_ARTIFACT_FILES.subsequentFinancing,
    value: (result) => result.collectedSources.subsequentFinancing,
    omitWhenUndefined: true,
  },
  {
    file: RUN_ARTIFACT_FILES.capitalOwnership,
    value: (result) => result.collectedSources.capitalOwnership,
    omitWhenUndefined: true,
  },
  {
    file: RUN_ARTIFACT_FILES.businessFramework,
    value: (result) => result.collectedSources.businessFramework ?? null,
  },
];

const DEEP_EQUITY_BUNDLE_COMPONENT_FILES: ReadonlySet<RunArtifactFileName> = new Set([
  RUN_ARTIFACT_FILES.marketSnapshots,
  RUN_ARTIFACT_FILES.supplementalMarketSnapshots,
  RUN_ARTIFACT_FILES.newsSources,
  RUN_ARTIFACT_FILES.extendedSources,
  RUN_ARTIFACT_FILES.extendedEvidence,
  RUN_ARTIFACT_FILES.sourceGaps,
  RUN_ARTIFACT_FILES.sourcePlan,
  RUN_ARTIFACT_FILES.evidenceLanes,
  RUN_ARTIFACT_FILES.sourceLedger,
  RUN_ARTIFACT_FILES.historicalContext,
  RUN_ARTIFACT_FILES.verifiedMarketSnapshot,
  RUN_ARTIFACT_FILES.instrumentIdentity,
  RUN_ARTIFACT_FILES.valuationComps,
  RUN_ARTIFACT_FILES.valuationWorkbench,
  RUN_ARTIFACT_FILES.reverseDcf,
  RUN_ARTIFACT_FILES.financialLenses,
  RUN_ARTIFACT_FILES.fundamentalHistory,
  RUN_ARTIFACT_FILES.financialStatements,
  RUN_ARTIFACT_FILES.subsequentFinancing,
  RUN_ARTIFACT_FILES.capitalOwnership,
  RUN_ARTIFACT_FILES.businessFramework,
  RUN_ARTIFACT_FILES.webSubjectProfile,
]);

function sidecarWrites(
  result: ResearchRunManifestResult,
  sidecars: readonly CollectedSourceSidecar[],
): readonly RunArtifactWrite[] {
  return sidecars.flatMap((sidecar): readonly RunArtifactWrite[] => {
    const value = sidecar.value(result);
    return sidecar.omitWhenUndefined === true && value === undefined
      ? []
      : [{ file: sidecar.file, kind: "json", value }];
  });
}

// The Theme Catalyst Calendar items assembled onto the report extras, persisted
// As their own normalized sidecar for research runs. Empty array when absent.
function catalystCalendarItems(report: ResearchReport): readonly unknown[] {
  const calendar = report.extras?.catalystCalendar;
  return isRecord(calendar) && Array.isArray(calendar.items) ? calendar.items : [];
}

function languageViolations(payload: ModelReportPayload): readonly {
  readonly field: string;
  readonly match: string;
}[] {
  return Object.entries(payload).flatMap(([field, value]) => {
    const text = JSON.stringify(value);
    if (text === undefined) {
      return [];
    }
    const violation = violatesResearchOnly(text);
    return violation === null ? [] : [{ field, match: violation.match }];
  });
}

export function buildFailedRunManifest(input: FailedRunManifestInput): {
  readonly writes: readonly RunArtifactWrite[];
  readonly failure: RunArtifactWrite;
} {
  const costEstimateUsd = sumKnownCosts(input.stageOutputs.map((output) => output.costEstimateUsd));
  const writes: readonly RunArtifactWrite[] = [
    {
      file: RUN_ARTIFACT_FILES.rawSnapshots,
      kind: "json",
      value: compactOversizedRawSnapshots(input.collectedSources.rawSnapshots),
    },
    {
      file: RUN_ARTIFACT_FILES.marketSnapshots,
      kind: "json",
      value: input.collectedSources.marketSnapshots,
    },
    {
      file: RUN_ARTIFACT_FILES.supplementalMarketSnapshots,
      kind: "json",
      value: input.collectedSources.supplementalMarketSnapshots,
    },
    {
      file: RUN_ARTIFACT_FILES.newsSources,
      kind: "json",
      value: input.collectedSources.newsSources,
    },
    {
      file: RUN_ARTIFACT_FILES.extendedSources,
      kind: "json",
      value: input.collectedSources.extendedSources,
    },
    {
      file: RUN_ARTIFACT_FILES.sourceGaps,
      kind: "json",
      value: input.collectedSources.sourceGaps,
    },
    { file: RUN_ARTIFACT_FILES.sourcePlan, kind: "json", value: input.sourcePlan },
    { file: RUN_ARTIFACT_FILES.evidenceLanes, kind: "json", value: input.evidenceLanes },
    { file: RUN_ARTIFACT_FILES.sourceLedger, kind: "json", value: input.sourceLedger },
    {
      file: RUN_ARTIFACT_FILES.historicalContext,
      kind: "json",
      value: input.historicalContext,
    },
    {
      file: RUN_ARTIFACT_FILES.webSubjectProfile,
      kind: "json",
      value: input.collectedSources.webSubjectProfile ?? null,
    },
    {
      file: RUN_ARTIFACT_FILES.extendedEvidence,
      kind: "json",
      value: input.collectedSources.extendedEvidence ?? null,
    },
    {
      file: RUN_ARTIFACT_FILES.marketContext,
      kind: "json",
      value: input.collectedSources.marketContext ?? null,
    },
    { file: RUN_ARTIFACT_FILES.stages, kind: "json", value: input.stageOutputs },
    { file: RUN_ARTIFACT_FILES.rejectedReport, kind: "json", value: input.payload },
  ];

  return {
    writes,
    failure: {
      file: RUN_ARTIFACT_FILES.failure,
      kind: "json",
      value: {
        schemaVersion: 1,
        runId: input.runId,
        generatedAt: input.generatedAt,
        failedAt: input.failedAt,
        phase: "final-synthesis",
        jobType: input.command.jobType,
        assetClass: input.command.assetClass,
        ...(isInstrumentCommand(input.command) ? { symbol: input.command.symbol } : {}),
        depth: input.command.depth,
        message: input.message,
        reportValidationErrors: input.reportValidationErrors,
        predictionErrors: input.predictionErrors,
        totalCalls: input.totalCalls,
        reportRepairReprompts: input.reportRepairReprompts,
        // Field attribution is a hint: JSON delimiters can create cross-element matches, phrases
        // Spanning nested fields are missed, and only the first match per top-level field is kept.
        // ReportValidationErrors is authoritative; [] means the draft had no detected match, so the
        // Violation came from assembly output (researchQualityDriver, extendedEvidence, renderedExtras;
        // Schema.ts:128-138), not the draft.
        languageViolations: languageViolations(input.payload),
        evidenceQuality: input.evidenceQuality,
        cost: {
          tokenEstimate: input.stageOutputs.reduce(
            (total, output) => total + output.tokenEstimate,
            0,
          ),
          ...(costEstimateUsd !== undefined ? { costEstimateUsd } : {}),
        },
        sourceGapsAsOf: "pre-synthesis",
        codeVersion: input.codeVersion,
        ...(input.sourceStateHash !== undefined ? { sourceStateHash: input.sourceStateHash } : {}),
      },
    },
  };
}

export function buildResearchRunManifest(
  command: ResearchCommand,
  config: AppConfig,
  result: ResearchRunManifestResult,
): readonly RunArtifactWrite[] {
  const isDeepEquity =
    command.jobType === "equity" && command.assetClass === "equity" && command.depth === "deep";
  if (isDeepEquity && result.deepEquityEvidenceBundle === undefined) {
    throw new Error("Deep-equity runs require an evidence bundle artifact");
  }
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
      {
        file: RUN_ARTIFACT_FILES.themeCatalysts,
        kind: "json",
        value: catalystCalendarItems(result.report),
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

  if (!isDeepEquity) {
    return writes;
  }
  return [
    ...writes.filter((write) => !DEEP_EQUITY_BUNDLE_COMPONENT_FILES.has(write.file)),
    {
      file: RUN_ARTIFACT_FILES.evidenceBundle,
      kind: "json",
      value: result.deepEquityEvidenceBundle,
    },
  ];
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

export async function persistFailedRunArtifactWrites(
  artifacts: RunArtifactPaths,
  manifest: ReturnType<typeof buildFailedRunManifest>,
  persist: typeof persistRunArtifactWrites = persistRunArtifactWrites,
): Promise<void> {
  await persist(artifacts, manifest.writes);
  // Failure.json is the completeness marker. Write it only after every diagnostic sidecar.
  await persist(artifacts, [manifest.failure]);
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
