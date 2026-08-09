import type { AppConfig } from "../config";
import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import {
  marketUpdateMetadataOf,
  type CodeVersion,
  type PostSynthesisAuditWarning,
  type RelocatedGapClaim,
  type ResearchReport,
  type RunTrace,
  type Source,
  type SourceTextResearchOnlyAudit,
  type SourceTextResearchOnlySummary,
} from "../domain/types";
import { violatesResearchOnly } from "../domain/research-language";
import type { CostPricing } from "../model/pricing";
import type { ModelProvider } from "../model/types";
import { effectiveConfigHash } from "../reproducibility";
import type { CollectedSources } from "../sources/types";
import { buildWebSourceSynthesisInputs } from "./prompts";
import type { StageOutput } from "./final-synthesis";
import type { ForecastDisagreementArtifact } from "./forecast-disagreement";
import type { HistoricalResearchContext } from "./historical-context";
import type { PlaybookSelectionAudit } from "./playbooks";
import type { ReportIntegrityAuditResult } from "./report-integrity-audit";
import type { ResolvedRunParams } from "../config/runs";
import type { BuildSourcePlanResult } from "./source-plan";
import type { SpotlightSelectionResult } from "./spotlights";
import { readEarningsForecastTelemetry } from "../forecast/earnings-eligibility";
import { buildWebEvidenceUtilization } from "../web-evidence";

interface TraceJobInput {
  readonly command: ResearchCommand;
  readonly config: AppConfig;
  readonly provider: Pick<ModelProvider, "name">;
}

function marketUpdateTraceFields(command: ResearchCommand): Partial<RunTrace> {
  return marketUpdateMetadataOf(command) ?? {};
}

export function auditSourceTextResearchOnly(
  sources: readonly Source[],
): SourceTextResearchOnlyAudit {
  const items: SourceTextResearchOnlyAudit["items"][number][] = [];
  const flaggedByKind: Record<string, number> = {};
  const flaggedByProvider: Record<string, number> = {};
  let flaggedCount = 0;

  for (const source of sources) {
    const provider = source.provider ?? source.providerAliases?.[0]?.provider ?? "unknown";
    let flagged = false;
    for (const field of ["title", "summary", "snippet"] as const) {
      const text = source[field];
      if (text === undefined) {
        continue;
      }
      const violation = violatesResearchOnly(text);
      if (violation === null) {
        continue;
      }
      flagged = true;
      items.push({
        sourceId: source.id,
        kind: source.kind,
        provider,
        field,
        match: violation.match,
      });
    }
    if (!flagged) {
      continue;
    }
    flaggedCount += 1;
    flaggedByKind[source.kind] = (flaggedByKind[source.kind] ?? 0) + 1;
    flaggedByProvider[provider] = (flaggedByProvider[provider] ?? 0) + 1;
  }

  return {
    scannedCount: sources.length,
    flaggedCount,
    flaggedByKind,
    flaggedByProvider,
    items,
  };
}

export function summarizeSourceTextResearchOnly(
  audit: SourceTextResearchOnlyAudit,
): SourceTextResearchOnlySummary {
  return {
    scannedCount: audit.scannedCount,
    flaggedCount: audit.flaggedCount,
    flaggedByKind: audit.flaggedByKind,
    flaggedByProvider: audit.flaggedByProvider,
  };
}

export function buildRunTrace(input: {
  readonly jobInput: TraceJobInput;
  readonly runId: string;
  readonly generatedAt: string;
  readonly completedAt: string;
  readonly runParams: ResolvedRunParams;
  readonly codeVersion: CodeVersion;
  readonly sourceStateHash?: string;
  readonly evidenceQualityAssessment: NonNullable<RunTrace["evidenceQualityAssessment"]>;
  readonly report: ResearchReport;
  readonly stageOutputs: readonly StageOutput[];
  readonly costEstimateUsd?: number;
  readonly costPricing: readonly CostPricing[];
  readonly collectedSources: CollectedSources;
  readonly evidenceRequestLoop?: RunTrace["evidenceRequestLoop"];
  readonly webGatherLoop?: RunTrace["webGatherLoop"];
  readonly historicalContext: HistoricalResearchContext;
  readonly spotlightSelection?: SpotlightSelectionResult;
  readonly playbookAudit: PlaybookSelectionAudit;
  readonly predictionRetryErrors: readonly string[];
  readonly predictionTrimWarnings: readonly string[];
  readonly predictionCompletion: RunTrace["predictionCompletion"];
  readonly predictionErrors: readonly string[];
  readonly reportValidationErrors: readonly string[];
  readonly relocatedGapClaims?: readonly RelocatedGapClaim[];
  readonly postSynthesisWarnings: readonly PostSynthesisAuditWarning[];
  readonly integrityAudit: ReportIntegrityAuditResult;
  readonly sourcePlanning: BuildSourcePlanResult;
  readonly configuredForecastDisagreementModels: readonly string[];
  readonly challengerModels: readonly string[];
  readonly forecastDisagreement?: ForecastDisagreementArtifact;
}): RunTrace {
  const { command, config, provider } = input.jobInput;
  const webSourceSynthesisInputs = buildWebSourceSynthesisInputs(command, input.collectedSources);
  const webEvidenceUtilization = buildWebEvidenceUtilization(
    input.report,
    input.collectedSources,
    input.webGatherLoop !== undefined,
  );
  const earningsForecasts = readEarningsForecastTelemetry(input.report);
  return {
    schemaVersion: 2,
    runId: input.runId,
    jobType: command.jobType,
    ...marketUpdateTraceFields(command),
    assetClass: command.assetClass,
    ...(isInstrumentCommand(command) ? { symbol: command.symbol } : {}),
    depth: command.depth,
    provider: provider.name,
    codeVersion: input.codeVersion,
    reproducibility: {
      effectiveConfigHash: effectiveConfigHash(config),
      ...(input.sourceStateHash !== undefined ? { dirtySourceHash: input.sourceStateHash } : {}),
    },
    evidenceQualityAssessment: input.evidenceQualityAssessment,
    quickModel: input.runParams.quickModel,
    synthesisModel: input.runParams.synthesisModel,
    startedAt: input.generatedAt,
    completedAt: input.completedAt,
    sourceGaps: input.report.dataGaps,
    stages: ["source-collection", ...input.stageOutputs.map((output) => output.stage)],
    stageRecords: input.stageOutputs.map((output) => ({
      stage: output.stage,
      ...(output.durationMs !== undefined ? { durationMs: output.durationMs } : {}),
      ...(output.attempt !== undefined ? { attempt: output.attempt } : {}),
      ...(output.repromptReason !== undefined ? { repromptReason: output.repromptReason } : {}),
    })),
    tokenEstimate: input.stageOutputs.reduce((total, output) => total + output.tokenEstimate, 0),
    ...(input.costEstimateUsd !== undefined ? { costEstimateUsd: input.costEstimateUsd } : {}),
    ...(input.costPricing.length > 0 ? { costPricing: input.costPricing } : {}),
    modelInputSanitization: input.collectedSources.modelInputSanitization ?? { entries: [] },
    ...(input.evidenceRequestLoop !== undefined
      ? { evidenceRequestLoop: input.evidenceRequestLoop }
      : {}),
    ...(input.webGatherLoop !== undefined ? { webGatherLoop: input.webGatherLoop } : {}),
    ...(webEvidenceUtilization !== undefined ? { webEvidenceUtilization } : {}),
    ...(webSourceSynthesisInputs !== undefined ? { webSourceSynthesisInputs } : {}),
    sourceTextResearchOnly: auditSourceTextResearchOnly(input.report.sources),
    historicalContext: input.historicalContext.audit,
    ...(input.spotlightSelection !== undefined
      ? { spotlightSelection: input.spotlightSelection.audit }
      : {}),
    domainPlaybooks: input.playbookAudit,
    ...(input.predictionRetryErrors.length > 0
      ? { predictionRetryErrors: input.predictionRetryErrors }
      : {}),
    ...(input.predictionTrimWarnings.length > 0
      ? { predictionTrimWarnings: input.predictionTrimWarnings }
      : {}),
    ...(input.predictionCompletion !== undefined
      ? { predictionCompletion: input.predictionCompletion }
      : {}),
    ...(input.predictionErrors.length > 0 ? { predictionErrors: input.predictionErrors } : {}),
    ...(earningsForecasts !== undefined ? { earningsForecasts } : {}),
    ...(input.reportValidationErrors.length > 0
      ? { reportValidationRetryErrors: input.reportValidationErrors }
      : {}),
    ...(input.relocatedGapClaims !== undefined && input.relocatedGapClaims.length > 0
      ? {
          relocatedGapClaims: {
            count: input.relocatedGapClaims.length,
            items: input.relocatedGapClaims,
          },
        }
      : {}),
    ...(input.postSynthesisWarnings.length > 0
      ? {
          postSynthesisAudit: {
            warningCount: input.postSynthesisWarnings.length,
            warnings: input.postSynthesisWarnings,
          },
        }
      : {}),
    reportIntegrityAudit: {
      reportIntegrity: input.integrityAudit.reportIntegrity,
      researchQuality: input.integrityAudit.researchQuality,
      prunedItemCount: input.integrityAudit.prunedItemCount,
      advisoryWarningCount: input.integrityAudit.advisoryWarningCount,
      ...(input.integrityAudit.advisories.length > 0
        ? { advisories: input.integrityAudit.advisories }
        : {}),
      pruned: input.integrityAudit.pruned,
    },
    sourcePlan: {
      plannedLaneCount: input.sourcePlanning.evidenceLanes.summary.plannedLaneCount,
      coreLaneCount: input.sourcePlanning.evidenceLanes.summary.coreLaneCount,
      materialLaneCount: input.sourcePlanning.evidenceLanes.summary.materialLaneCount,
      supplementalLaneCount: input.sourcePlanning.evidenceLanes.summary.supplementalLaneCount,
    },
    evidenceLanes: {
      coveredLaneCount: input.sourcePlanning.evidenceLanes.summary.coveredLaneCount,
      gapLaneCount: input.sourcePlanning.evidenceLanes.summary.gapLaneCount,
      coreGapLaneCount: input.sourcePlanning.evidenceLanes.summary.coreGapLaneCount,
      materialGapLaneCount: input.sourcePlanning.evidenceLanes.summary.materialGapLaneCount,
      sourceCount: input.sourcePlanning.evidenceLanes.summary.sourceCount,
      gapCount: input.sourcePlanning.evidenceLanes.summary.gapCount,
      coverageRatio: input.sourcePlanning.evidenceLanes.summary.coverageRatio,
    },
    ...(input.forecastDisagreement !== undefined
      ? {
          forecastDisagreement: {
            configuredModelCount: input.configuredForecastDisagreementModels.length,
            challengerModelCount: input.challengerModels.length,
            participantCount: input.forecastDisagreement.participantCount,
            successfulParticipantCount: input.forecastDisagreement.successfulParticipantCount,
            errorCount: input.forecastDisagreement.errorCount,
          },
        }
      : {}),
  };
}
