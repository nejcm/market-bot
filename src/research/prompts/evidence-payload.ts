import type { AppConfig } from "../../config";
import { isInstrumentCommand, type ResearchCommand } from "../../cli/args";
import { rankMovers } from "../../movers/ranking";
import type { CollectedSources } from "../../sources/types";
import {
  isCompanyProfileSecSource,
  subjectKindForCommand,
} from "../../sources/extended-evidence/web-subject-profile";
import {
  verifiedSnapshotCitationRule,
  verifiedSnapshotSourceId,
} from "../verified-snapshot-contract";
import type { HistoricalResearchContext } from "../historical-context";
import type { ResearchContext } from "../research-context-types";
import {
  buildMarketForecastErrorBlock,
  buildPriorThesisErrorBlock,
  buildResearchForecastErrorBlock,
} from "../prior-forecast-errors";
import { buildCalibrationBlock } from "../calibration-context";
import type { SpotlightSelectionResult } from "../spotlights";
import { deterministicSourceGaps } from "../deterministic-gaps";
import { moverLimitFor } from "../depth-profile";
import { isFreshWebSource, userSteeringField } from "./steering";

function normalizedSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

// Resolve the analysis cutoff stamped into evidence payloads and selection prompts.
// Real entry points (runResearchJob, alpha-search workflow) always set context.analysisAsOf
// To the run's generatedAt/startedAt, so the wall-clock branch is an unreachable defensive
// Fallback kept only to satisfy the optional type; reaching it would reintroduce
// Nondeterminism into prompts, so it must never fire on a real run.
export function resolveAnalysisAsOf(context: ResearchContext): string {
  return context.analysisAsOf ?? new Date().toISOString();
}

// Stage-specific projection knobs supplied by each stage module, so this shared payload
// Builder carries no stage conditionals.
export interface EvidencePayloadOptions {
  // Final-synthesis attaches the prior-calibration block.
  readonly includePriorCalibration: boolean;
  // Which web-source text projection applies: the profile stage carries summary+snippet
  // (and company SEC filing text); final-synthesis surfaces text for fresh web sources
  // Only; every other stage projects bare metadata.
  readonly webSourceText: "profile" | "fresh-only" | "metadata";
}

/*
 * Each collected-source evidence kind projects itself into the stage prompt payload.
 * A projector contributes its keys when its CollectedSources field is present and the
 * command qualifies; otherwise it contributes nothing. Adding a new collected-source
 * evidence kind means adding one prompt-payload projector to EVIDENCE_PROJECTORS — not
 * editing the builder body. Report extras use the separate registry in
 * extended-evidence-projections.ts because they merge model-authored sections with
 * deterministic collected artifacts after synthesis.
 */
type EvidenceProjector = (
  options: EvidencePayloadOptions,
  command: ResearchCommand,
  collectedSources: CollectedSources,
) => Record<string, unknown>;

const projectMarketContext: EvidenceProjector = (_options, _command, collectedSources) =>
  collectedSources.marketContext !== undefined
    ? { marketContext: collectedSources.marketContext }
    : {};

const projectExtendedEvidence: EvidenceProjector = (_options, command, collectedSources) =>
  isInstrumentCommand(command) && collectedSources.extendedEvidence !== undefined
    ? { extendedEvidence: collectedSources.extendedEvidence }
    : {};

const projectEarningsSetup: EvidenceProjector = (_options, command, collectedSources) =>
  isInstrumentCommand(command) && collectedSources.earningsSetup !== undefined
    ? { earningsSetup: collectedSources.earningsSetup }
    : {};

// Compact verified snapshot for prompts: latest OHLCV, indicators, recent closes only.
// The full bar series stays on disk (rawSnapshots / normalized sidecar).
const projectVerifiedMarketSnapshot: EvidenceProjector = (_options, _command, collectedSources) =>
  collectedSources.verifiedMarketSnapshot !== undefined
    ? {
        verifiedMarketSnapshot: collectedSources.verifiedMarketSnapshot,
        verifiedMarketSnapshotSourceId: verifiedSnapshotSourceId(
          collectedSources.verifiedMarketSnapshot.symbol,
        ),
        verifiedMarketSnapshotCitationRule: verifiedSnapshotCitationRule(
          collectedSources.verifiedMarketSnapshot.symbol,
        ),
      }
    : {};

const projectVerifiedRepresentativeSnapshots: EvidenceProjector = (
  _options,
  command,
  collectedSources,
) =>
  command.jobType === "research" &&
  collectedSources.verifiedRepresentativeSnapshots !== undefined &&
  collectedSources.verifiedRepresentativeSnapshots.length > 0
    ? {
        verifiedRepresentativeSnapshots: collectedSources.verifiedRepresentativeSnapshots,
        verifiedRepresentativeSnapshotSourceIds:
          collectedSources.verifiedRepresentativeSnapshots.map((snapshot) =>
            verifiedSnapshotSourceId(snapshot.symbol),
          ),
      }
    : {};

const projectResolvedInstrumentIdentity: EvidenceProjector = (
  _options,
  _command,
  collectedSources,
) =>
  collectedSources.resolvedInstrumentIdentity !== undefined
    ? {
        resolvedInstrumentIdentity: collectedSources.resolvedInstrumentIdentity,
        resolvedIdentityInstruction:
          "This is the canonical instrument identity for this run. Use this identity; do not substitute a different company.",
      }
    : {};

const projectWebSources: EvidenceProjector = (options, command, collectedSources) => {
  const subjectKind = subjectKindForCommand(command);
  if (subjectKind === undefined) {
    return {};
  }
  const isProfileStage = options.webSourceText === "profile";
  // The company profile stage may cite SEC 10-K/10-Q filing text alongside web
  // Sources, so surface their model-visible snippet/summary here too. SEC text is
  // High-trust primary (normalized at fetch time), not the untrusted web content
  // The stage prompt warns about.
  const includeSecSources = isProfileStage && subjectKind === "company";
  // At final-synthesis, fresh web sources gathered this run are otherwise projected
  // As bare metadata, so the model can only cite the reused-profile digest. Surface
  // Their sanitized summary here (snippet as a fallback) — but only for web sources
  // The attached profile does not already carry as a pre-cited fact, keeping the
  // Low-trust text surface bounded.
  const profileCoveredIds = new Set(collectedSources.webSubjectProfile?.sourceIds);
  return {
    webSources: collectedSources.extendedSources
      .filter(
        (source) =>
          source.kind === "web" || (includeSecSources && isCompanyProfileSecSource(source)),
      )
      .map((source) => {
        const includeFreshWebText =
          options.webSourceText === "fresh-only" && isFreshWebSource(source, profileCoveredIds);
        const includeSummary =
          (isProfileStage || includeFreshWebText) && source.summary !== undefined;
        // Profile stage carries both fields; fresh final-synthesis text uses snippet
        // Only when summary is absent, to keep the added token surface small.
        const includeSnippet =
          source.snippet !== undefined &&
          (isProfileStage || (includeFreshWebText && source.summary === undefined));
        return {
          id: source.id,
          title: source.title,
          ...(source.publisher !== undefined ? { publisher: source.publisher } : {}),
          fetchedAt: source.fetchedAt,
          ...(includeSummary ? { summary: source.summary } : {}),
          ...(includeSnippet ? { snippet: source.snippet } : {}),
        };
      }),
  };
};

const projectWebSubjectProfile: EvidenceProjector = (_options, command, collectedSources) => {
  if (subjectKindForCommand(command) === undefined) {
    return {};
  }
  const profile = collectedSources.webSubjectProfile;
  if (profile === undefined || profile.sourceIds.length === 0) {
    return {};
  }
  return {
    webSubjectProfile: {
      subjectSummary: profile.subjectSummary,
      questions: profile.questions,
      factLedger: profile.factLedger,
      recentMaterialEvents: profile.recentMaterialEvents,
      openGaps: profile.openGaps,
    },
  };
};

const EVIDENCE_PROJECTORS: readonly EvidenceProjector[] = [
  projectMarketContext,
  projectExtendedEvidence,
  projectEarningsSetup,
  projectVerifiedMarketSnapshot,
  projectVerifiedRepresentativeSnapshots,
  projectResolvedInstrumentIdentity,
  projectWebSources,
  projectWebSubjectProfile,
];

export function buildEvidencePayload(
  options: EvidencePayloadOptions,
  command: ResearchCommand,
  collectedSources: CollectedSources,
  config: AppConfig,
  context: ResearchContext,
): Record<string, unknown> {
  const { historicalContext } = context;
  const movers = rankMovers(
    collectedSources.marketSnapshots.filter(
      (snapshot) => snapshot.assetClass === command.assetClass,
    ),
    moverLimitFor(command, config),
  );
  const calibrationBlock = options.includePriorCalibration
    ? buildCalibrationBlock(context.calibrationContext, command, context)
    : undefined;
  const priorThesisErrors = buildPriorThesisErrorBlock(command, historicalContext);
  const priorMarketForecastErrors = buildMarketForecastErrorBlock(command, context);
  const priorThematicForecastErrors = buildResearchForecastErrorBlock(command, historicalContext);
  const deterministicCitationGuidance =
    "For exact numeric market claims, cite deterministic snapshot sourceIds from marketSnapshots, supplementalMarketSnapshots, marketContext, extendedEvidence, verifiedMarketSnapshot, or verifiedRepresentativeSnapshots when available. Use history-report-* sources for narrative prior-context claims, not as the only citation for a specific number.";

  const evidenceProjections = EVIDENCE_PROJECTORS.reduce<Record<string, unknown>>(
    (payload, project) => ({ ...payload, ...project(options, command, collectedSources) }),
    {},
  );

  // Research subject: surface registry representatives + provenance in the evidence payload
  // So the model quotes named representatives instead of generic movers (Phase 2.2).
  const registrySubjectBlock: Record<string, unknown> = {};
  if (command.jobType === "research") {
    const resolvedSubject = context.resolvedSubject ?? collectedSources.resolvedSubject;
    if (
      resolvedSubject?.subjectKey !== undefined &&
      resolvedSubject.representativeInstruments !== undefined &&
      resolvedSubject.sources !== undefined
    ) {
      const liveSymbols = new Set(
        collectedSources.marketSnapshots.map((s) => normalizedSymbol(s.symbol)),
      );
      registrySubjectBlock.registrySubject = {
        subjectKey: resolvedSubject.subjectKey,
        displayName: resolvedSubject.displayName,
        representativeInstruments: resolvedSubject.representativeInstruments.map((instrument) => ({
          symbol: instrument.symbol,
          ...(instrument.name !== undefined ? { name: instrument.name } : {}),
          instrumentType: instrument.instrumentType,
          sourceIds: instrument.sourceIds,
          hasLiveSnapshot: liveSymbols.has(normalizedSymbol(instrument.symbol)),
        })),
        provenanceSources: resolvedSubject.sources.map((src) => ({
          sourceId: src.sourceId,
          title: src.title,
          ...(src.url !== undefined ? { url: src.url } : {}),
        })),
        ...(resolvedSubject.predictionProxySymbol !== undefined
          ? { predictionProxy: { symbol: resolvedSubject.predictionProxySymbol } }
          : {}),
        instruction:
          "Quote the named representative instruments and cite their sourceIds in findings and predictions. Prefer registry representatives over generic market movers for this subject.",
      };
    }
  }

  return {
    analysisAsOf: resolveAnalysisAsOf(context),
    command,
    ...userSteeringField(command),
    movers,
    marketRegime: context.marketRegime,
    marketSnapshots: collectedSources.marketSnapshots,
    supplementalMarketSnapshots: collectedSources.supplementalMarketSnapshots,
    newsSources: collectedSources.newsSources,
    ...evidenceProjections,
    ...(historicalContext !== undefined
      ? { historicalContext: compactHistoricalContext(historicalContext) }
      : {}),
    ...(context.spotlightCandidates !== undefined
      ? { spotlightCandidates: context.spotlightCandidates }
      : {}),
    ...(context.spotlightSelection !== undefined
      ? { spotlightSelection: compactSpotlightSelection(context.spotlightSelection) }
      : {}),
    ...(context.evidenceRequest !== undefined ? { evidenceRequest: context.evidenceRequest } : {}),
    ...(context.webGather !== undefined ? { webGather: context.webGather } : {}),
    sourceGaps: deterministicSourceGaps(command, collectedSources),
    ...(context.sourcePlanning !== undefined
      ? {
          sourcePlan: context.sourcePlanning.sourcePlan,
          evidenceLanes: context.sourcePlanning.evidenceLanes,
        }
      : {}),
    deterministicCitationGuidance,
    ...(calibrationBlock !== undefined ? { priorCalibration: calibrationBlock } : {}),
    ...(priorThesisErrors !== undefined ? { priorThesisErrors } : {}),
    ...(priorMarketForecastErrors !== undefined ? { priorMarketForecastErrors } : {}),
    ...(priorThematicForecastErrors !== undefined ? { priorThematicForecastErrors } : {}),
    ...registrySubjectBlock,
  };
}

export function compactHistoricalContext(
  context: HistoricalResearchContext,
): Record<string, unknown> {
  return {
    generatedAt: context.generatedAt,
    recentDays: context.recentDays,
    anchorMonths: context.anchorMonths,
    sourceIds: context.sources.map((source) => source.id),
    runs: context.runs,
    gaps: context.gaps,
    audit: context.audit,
    artifactDeltas: context.artifactDeltas,
  };
}

export function compactSpotlightSelection(
  selection: SpotlightSelectionResult,
): Record<string, unknown> {
  return {
    ...(selection.rationale !== undefined ? { rationale: selection.rationale } : {}),
    selected: selection.selected.map((item) => ({
      symbol: item.symbol,
      rationale: item.rationale,
      sourceIds: item.sourceIds,
      candidateId: item.candidate.id,
    })),
    rejected: selection.rejected,
    audit: selection.audit,
  };
}

export function evidenceCategories(
  collectedSources: CollectedSources,
  context?: ResearchContext,
): readonly string[] {
  const categories = new Set<string>();
  if (collectedSources.marketSnapshots.length > 0) {
    categories.add("market-data");
  }
  if (collectedSources.supplementalMarketSnapshots.length > 0) {
    categories.add("supplemental-market-data");
  }
  if (collectedSources.newsSources.length > 0) {
    categories.add("news");
  }
  if ((collectedSources.marketContext?.items ?? []).length > 0) {
    categories.add("market-context");
  }
  for (const item of collectedSources.extendedEvidence?.items ?? []) {
    categories.add(item.category);
  }
  if ((context?.historicalContext?.runs.length ?? 0) > 0) {
    categories.add("historical-context");
  }
  if ((context?.spotlightSelection?.selected.length ?? 0) > 0) {
    categories.add("market-spotlights");
  }
  return [...categories].toSorted();
}
