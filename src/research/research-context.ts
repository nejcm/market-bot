import type { AppConfig } from "../config";
import { resolveRunParams, type ForecastKindMix, type ResolvedRunParams } from "../config/runs";
import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import type { LoadedPrompt, StageLabel } from "./prompt-loader";
import { dedupeSourceGaps, sourceGapReportText } from "../domain/source-gaps";
import { marketUpdateHorizonOf } from "../domain/types";
import { rankMovers } from "../movers/ranking";
import type { CollectedSources } from "../sources/types";
import {
  isCompanyProfileSecSource,
  subjectKindForCommand,
  webSubjectProfileRequiredShape,
} from "../sources/extended-evidence/web-subject-profile";
import {
  missingVerifiedSnapshotGapText,
  verifiedSnapshotCitationRule,
  verifiedSnapshotSourceId,
} from "./verified-snapshot-contract";
import { MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS } from "../forecast/observable";
import type { HistoricalResearchContext } from "./historical-context";
import type { LoadedPlaybook, PlaybookCandidate, PlaybookStage } from "./playbooks";
import type {
  CalibrationContext,
  DepthProfile,
  EvidenceRequestContext,
  ResearchContext,
  WebGatherContext,
} from "./research-context-types";
import {
  buildMarketForecastErrorBlock,
  buildPriorThesisErrorBlock,
  buildResearchForecastErrorBlock,
} from "./prior-forecast-errors";
import { buildCalibrationBlock } from "./calibration-context";
import type { SpotlightCandidate, SpotlightSelectionResult } from "./spotlights";

export type {
  CalibrationContext,
  DepthProfile,
  EvidenceRequestContext,
  ResearchContext,
  WebGatherContext,
};

// ---------------------------------------------------------------------------
// Deterministic source gaps — disclosed in the prompt and in the final report
// ---------------------------------------------------------------------------

export const EQUITY_MARKET_OVERVIEW_MOVER_UNIVERSE_GAP =
  "Market overview mover universe is seeded from Yahoo day_gainers, day_losers, and most_actives — a single-day multi-screener set, not a trailing horizon mover screener";

export function deterministicSourceGaps(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): readonly string[] {
  const gaps = dedupeSourceGaps(collectedSources.sourceGaps).map((gap) => sourceGapReportText(gap));
  const marketGaps =
    collectedSources.marketSnapshots.length === 0
      ? ["No usable market data snapshots were collected"]
      : [];
  const newsGaps =
    collectedSources.newsSources.length === 0 ? ["No usable news sources were collected"] : [];
  const tickerGaps =
    isInstrumentCommand(command) &&
    collectedSources.marketSnapshots.every((snapshot) => snapshot.symbol !== command.symbol)
      ? [`No market snapshot matched ticker ${command.symbol}`]
      : [];
  const marketUpdateHorizon = marketUpdateHorizonOf(command);
  const overviewMoverGaps =
    marketUpdateHorizon !== undefined && marketUpdateHorizon > 5
      ? [
          command.assetClass === "equity"
            ? EQUITY_MARKET_OVERVIEW_MOVER_UNIVERSE_GAP
            : "Market overview crypto mover data uses CoinGecko 24h change fields; trailing horizon mover changes are not available in the current source payload",
        ]
      : [];

  const verifiedSnapshotGaps =
    isInstrumentCommand(command) &&
    command.assetClass === "equity" &&
    collectedSources.verifiedMarketSnapshot === undefined
      ? [missingVerifiedSnapshotGapText(command.symbol)]
      : [];

  // Research subject: flag representative instruments with no live market snapshot so the
  // Model can cite the gap instead of silently substituting a mover (Phase 2.2).
  const researchRepresentativeGaps: string[] = [];
  if (command.jobType === "research") {
    const { resolvedSubject } = collectedSources;
    if (resolvedSubject?.representativeInstruments !== undefined) {
      const liveSymbols = new Set(
        collectedSources.marketSnapshots.map((s) => s.symbol.toUpperCase()),
      );
      for (const instrument of resolvedSubject.representativeInstruments) {
        if (!liveSymbols.has(instrument.symbol.toUpperCase())) {
          const label =
            instrument.name !== undefined
              ? `${instrument.name} (${instrument.symbol})`
              : instrument.symbol;
          researchRepresentativeGaps.push(
            `researchRepresentative: no live market snapshot for representative ${label}; cite the registry sourceId instead`,
          );
        }
      }
    }
  }

  return [
    ...gaps,
    ...marketGaps,
    ...newsGaps,
    ...tickerGaps,
    ...overviewMoverGaps,
    ...verifiedSnapshotGaps,
    ...researchRepresentativeGaps,
  ];
}

// Resolve the analysis cutoff stamped into evidence payloads and selection prompts.
// Real entry points (runResearchJob, alpha-search workflow) always set context.analysisAsOf
// To the run's generatedAt/startedAt, so the wall-clock branch is an unreachable defensive
// Fallback kept only to satisfy the optional type; reaching it would reintroduce
// Nondeterminism into prompts, so it must never fire on a real run.
function resolveAnalysisAsOf(context: ResearchContext): string {
  return context.analysisAsOf ?? new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Depth profile
// ---------------------------------------------------------------------------

export function buildDepthProfileFromParams(
  command: ResearchCommand,
  params: ResolvedRunParams,
): DepthProfile {
  return {
    depth: command.depth,
    analystStyle: params.analystStyle,
    minimumKeyFindings: params.minimumKeyFindings,
    minimumScenarios: params.minimumScenarios,
    targetPredictions: params.targetPredictions,
    defaultPredictionHorizon: params.defaultPredictionHorizon,
    predictionSubjects: params.predictionSubjects,
    focus: params.focus,
    targetKindMix: params.targetKindMix,
  };
}

export function buildDepthProfile(command: ResearchCommand, appConfig: AppConfig): DepthProfile {
  return buildDepthProfileFromParams(command, resolveRunParams(command, appConfig));
}

// ---------------------------------------------------------------------------
// Evidence payload — the JSON blob handed to each model stage
// ---------------------------------------------------------------------------

// Config-driven mover cap for the command's asset class. Shared so the orchestrator's
// Market-update mover set matches the ranked movers handed to the model.
export function moverLimitFor(command: ResearchCommand, config: AppConfig): number {
  return command.assetClass === "equity"
    ? config.sourceOptions.equityMoverLimit
    : config.sourceOptions.cryptoMoverLimit;
}

/*
 * Each collected-source evidence kind projects itself into the stage prompt payload.
 * A projector contributes its keys when its CollectedSources field is present and the
 * command qualifies; otherwise it contributes nothing. Adding a new collected-source
 * evidence kind means adding one projector to EVIDENCE_PROJECTORS — not editing the
 * builder body.
 */
type EvidenceProjector = (
  stage: StageLabel,
  command: ResearchCommand,
  collectedSources: CollectedSources,
) => Record<string, unknown>;

const projectMarketContext: EvidenceProjector = (_stage, _command, collectedSources) =>
  collectedSources.marketContext !== undefined
    ? { marketContext: collectedSources.marketContext }
    : {};

const projectExtendedEvidence: EvidenceProjector = (_stage, command, collectedSources) =>
  isInstrumentCommand(command) && collectedSources.extendedEvidence !== undefined
    ? { extendedEvidence: collectedSources.extendedEvidence }
    : {};

const projectEarningsSetup: EvidenceProjector = (_stage, command, collectedSources) =>
  isInstrumentCommand(command) && collectedSources.earningsSetup !== undefined
    ? { earningsSetup: collectedSources.earningsSetup }
    : {};

// Compact verified snapshot for prompts: latest OHLCV, indicators, recent closes only.
// The full bar series stays on disk (rawSnapshots / normalized sidecar).
const projectVerifiedMarketSnapshot: EvidenceProjector = (_stage, _command, collectedSources) =>
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

const projectResolvedInstrumentIdentity: EvidenceProjector = (_stage, _command, collectedSources) =>
  collectedSources.resolvedInstrumentIdentity !== undefined
    ? {
        resolvedInstrumentIdentity: collectedSources.resolvedInstrumentIdentity,
        resolvedIdentityInstruction:
          "This is the canonical instrument identity for this run. Use this identity; do not substitute a different company.",
      }
    : {};

const projectWebSources: EvidenceProjector = (stage, command, collectedSources) => {
  const subjectKind = subjectKindForCommand(command);
  if (subjectKind === undefined) {
    return {};
  }
  const includeModelVisibleText = stage === "web-subject-profile";
  // The company profile stage may cite SEC 10-K/10-Q filing text alongside web
  // Sources, so surface their model-visible snippet/summary here too. SEC text is
  // High-trust primary (normalized at fetch time), not the untrusted web content
  // The stage prompt warns about.
  const includeSecSources = includeModelVisibleText && subjectKind === "company";
  return {
    webSources: collectedSources.extendedSources
      .filter(
        (source) =>
          source.kind === "web" || (includeSecSources && isCompanyProfileSecSource(source)),
      )
      .map((source) => ({
        id: source.id,
        title: source.title,
        ...(source.publisher !== undefined ? { publisher: source.publisher } : {}),
        fetchedAt: source.fetchedAt,
        ...(includeModelVisibleText && source.summary !== undefined
          ? { summary: source.summary }
          : {}),
        ...(includeModelVisibleText && source.snippet !== undefined
          ? { snippet: source.snippet }
          : {}),
      })),
  };
};

const projectWebSubjectProfile: EvidenceProjector = (_stage, command, collectedSources) => {
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
  projectResolvedInstrumentIdentity,
  projectWebSources,
  projectWebSubjectProfile,
];

function buildEvidencePayload(
  stage: StageLabel,
  command: ResearchCommand,
  collectedSources: CollectedSources,
  config: AppConfig,
  context: ResearchContext,
): Record<string, unknown> {
  const movers = rankMovers(
    collectedSources.marketSnapshots.filter(
      (snapshot) => snapshot.assetClass === command.assetClass,
    ),
    moverLimitFor(command, config),
  );
  const calibrationBlock = buildCalibrationBlock(context.calibrationContext, context);
  const priorThesisErrors = buildPriorThesisErrorBlock(command, context.historicalContext);
  const priorMarketForecastErrors = buildMarketForecastErrorBlock(command, context);
  const priorThematicForecastErrors = buildResearchForecastErrorBlock(
    command,
    context.historicalContext,
  );
  const deterministicCitationGuidance =
    "For exact numeric market claims, cite deterministic snapshot sourceIds from marketSnapshots, supplementalMarketSnapshots, marketContext, extendedEvidence, or verifiedMarketSnapshot when available. Use history-report-* sources for narrative prior-context claims, not as the only citation for a specific number.";

  const evidenceProjections = EVIDENCE_PROJECTORS.reduce<Record<string, unknown>>(
    (payload, project) => ({ ...payload, ...project(stage, command, collectedSources) }),
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
        collectedSources.marketSnapshots.map((s) => s.symbol.toUpperCase()),
      );
      registrySubjectBlock.registrySubject = {
        subjectKey: resolvedSubject.subjectKey,
        displayName: resolvedSubject.displayName,
        representativeInstruments: resolvedSubject.representativeInstruments.map((instrument) => ({
          symbol: instrument.symbol,
          ...(instrument.name !== undefined ? { name: instrument.name } : {}),
          instrumentType: instrument.instrumentType,
          sourceIds: instrument.sourceIds,
          hasLiveSnapshot: liveSymbols.has(instrument.symbol.toUpperCase()),
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
    ...(context.historicalContext !== undefined
      ? { historicalContext: compactHistoricalContext(context.historicalContext) }
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

function compactHistoricalContext(context: HistoricalResearchContext): Record<string, unknown> {
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

function compactSpotlightSelection(selection: SpotlightSelectionResult): Record<string, unknown> {
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

function finalReportShape(
  command: ResearchCommand,
  depthProfile: DepthProfile,
  hasEarningsSetup: boolean,
  hasBusinessFramework: boolean,
  hasWebSubjectProfile: boolean,
  webSubjectKind: ReturnType<typeof subjectKindForCommand>,
): Record<string, unknown> {
  const exampleSubject = depthProfile.predictionSubjects[0] ?? "SPY";
  const predictionKinds = [
    "direction",
    "relative",
    ...(command.assetClass === "equity" ? ["volatility", "iv"] : []),
    "range",
    "macro",
    "conditional",
    ...(hasEarningsSetup ? ["earnings-direction", "earnings-move"] : []),
  ].join("|");
  const earningsSetupShape = hasEarningsSetup
    ? {
        earningsSetup: {
          expectationBar: [{ text: "string", sourceIds: ["source-id"] }],
          qualityLandmines: [{ text: "string", sourceIds: ["source-id"] }],
          guidanceCredibility: [{ text: "string", sourceIds: ["source-id"] }],
        },
      }
    : {};
  const businessFrameworkShape = hasBusinessFramework
    ? {
        businessFramework: {
          sections: [
            {
              name: "Business|Phase|Moat|Growth|Management|Risk|Valuation",
              text: "string",
              sourceIds: ["source-id"],
            },
          ],
        },
      }
    : {};
  const webSubjectProfileShape = hasWebSubjectProfile
    ? {
        webSubjectProfile: webSubjectProfileRequiredShape(webSubjectKind ?? "company"),
      }
    : {};
  return {
    summary: "string",
    keyFindings: [{ text: "string", sourceIds: ["source-id"] }],
    bullCase: [{ text: "string", sourceIds: ["source-id"] }],
    bearCase: [{ text: "string", sourceIds: ["source-id"] }],
    risks: [{ text: "string", sourceIds: ["source-id"] }],
    catalysts: [{ text: "string", sourceIds: ["source-id"] }],
    scenarios: [{ name: "string", description: "string", sourceIds: ["source-id"] }],
    dataGaps: ["string"],
    predictions: Array.from({ length: depthProfile.targetPredictions }, (_, idx) => ({
      id: `pred-${String(idx + 1)}`,
      kind: predictionKinds,
      subject: exampleSubject,
      measurableAs: `close(${exampleSubject}, +${String(depthProfile.defaultPredictionHorizon)}) > close(${exampleSubject}, 0)`,
      horizonTradingDays: depthProfile.defaultPredictionHorizon,
      probability: 0.6,
      sourceIds: ["source-id"],
    })),
    extras: {
      historicalContext: {
        summary: "string",
        sourceIds: ["history-report-run-id"],
        items: [{ text: "string", sourceIds: ["history-report-run-id"] }],
        gaps: ["string"],
      },
      spotlights: {
        items: [{ symbol: "string", rationale: "string", sourceIds: ["source-id"] }],
      },
      ...earningsSetupShape,
      ...businessFrameworkShape,
      ...webSubjectProfileShape,
    },
  };
}

function evidenceRequestShape(): Record<string, unknown> {
  return {
    requests: [
      {
        tool: "tradier_iv_term_structure",
        args: { symbol: "run symbol only" },
        rationale: "string",
      },
    ],
  };
}

function webGatherShape(): Record<string, unknown> {
  return {
    requests: [
      {
        tool: "web_search",
        args: {
          query: "must mention run symbol or company name",
          searchType: "news|market|current-subject|background",
        },
        rationale: "string",
      },
      {
        tool: "web_fetch",
        args: { url: "search-result URL only" },
        rationale: "string",
      },
    ],
  };
}

function playbookSelectionShape(): Record<string, unknown> {
  return {
    rationale: "short string",
    selections: [{ stage: "stage label", playbookIds: ["playbook-id"] }],
  };
}

function spotlightSelectionShape(): Record<string, unknown> {
  return {
    rationale: "short string",
    selections: [
      { symbol: "ticker", rationale: "string", sourceIds: ["current-market-source-id"] },
    ],
  };
}

function stagePlaybooks(
  stage: StageLabel,
  context: ResearchContext,
): readonly LoadedPlaybook[] | undefined {
  if (
    stage === "evidence-request" ||
    stage === "web-gather" ||
    stage === "web-subject-profile" ||
    stage === "playbook-selection" ||
    stage === "spotlight-selection"
  ) {
    return undefined;
  }
  return context.domainPlaybooks?.find((entry) => entry.stage === stage)?.playbooks;
}

function evidenceCategories(
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

// Bounded steering field shared by the spotlight-selection and final-synthesis
// Stages so an optional market-overview prompt steers both (A3) without
// Replacing the deterministic market overview evidence.
function userSteeringField(command: ResearchCommand): Record<string, unknown> {
  if (command.jobType !== "market-overview" || command.prompt === undefined) {
    return {};
  }
  return {
    userSteeringPrompt: {
      text: command.prompt,
      instruction:
        "Use this as steering for spotlight selection and final synthesis. Do not replace the deterministic market overview evidence.",
    },
  };
}

export function buildPlaybookSelectionPrompt(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  context: ResearchContext,
  loaded: LoadedPrompt,
  plannedStages: readonly PlaybookStage[],
  candidates: readonly PlaybookCandidate[],
): string {
  return JSON.stringify(
    {
      instruction: loaded.instruction,
      stage: "playbook-selection",
      analysisAsOf: resolveAnalysisAsOf(context),
      stageGoal: loaded.goal,
      command,
      depthProfile: context.depthProfile,
      plannedStages,
      candidates,
      marketRegime: { label: context.marketRegime.label },
      evidenceCategories: evidenceCategories(collectedSources, context),
      sourceGaps: deterministicSourceGaps(command, collectedSources),
      requiredShape: playbookSelectionShape(),
    },
    undefined,
    2,
  );
}

export function buildSpotlightSelectionPrompt(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  context: ResearchContext,
  loaded: LoadedPrompt,
  candidates: readonly SpotlightCandidate[],
  cap: number,
): string {
  return JSON.stringify(
    {
      instruction: loaded.instruction,
      stage: "spotlight-selection",
      analysisAsOf: resolveAnalysisAsOf(context),
      stageGoal: loaded.goal,
      command,
      ...userSteeringField(command),
      depthProfile: context.depthProfile,
      selectionCap: cap,
      candidates,
      marketRegime: { label: context.marketRegime.label },
      historicalContext:
        context.historicalContext === undefined
          ? undefined
          : compactHistoricalContext(context.historicalContext),
      evidenceCategories: evidenceCategories(collectedSources, context),
      sourceGaps: deterministicSourceGaps(command, collectedSources),
      requiredShape: spotlightSelectionShape(),
    },
    undefined,
    2,
  );
}

// ---------------------------------------------------------------------------
// Stage prompt
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prediction-kind mix guidance (audit finding #10 — emission policy)
//
// Soft guidance only: steers `final-synthesis` toward the run type's favored,
// More-informative kinds (e.g. `relative`, `macro`, `range`) instead of
// Leaning on bare `direction`, whose short-horizon base rate sits near 0.5.
// Not a validation gate — no reprompt branch reads this.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deep instrument forecast-shape diversity guidance (quality-preserving nudge)
//
// For deep instrument runs, enumerates distinct forecast shapes the
// Deterministic context supports so the model considers each before stopping.
// This is a soft nudge, not a hard gate — a below-target result still ships
// Via ADR 0021's predictionShortfall disclosure.
// ---------------------------------------------------------------------------

function buildForecastDiversityGuidance(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): string {
  if (command.depth !== "deep" || !isInstrumentCommand(command)) {
    return "";
  }
  const shapes: string[] = [
    "direction (close up/down)",
    "relative (vs benchmark)",
    "range (outside [Lo, Hi])",
  ];
  if (
    collectedSources.extendedEvidence?.items.some((item) => item.category === "options-iv") ===
      true ||
    collectedSources.sourceGaps.some(
      (gap) => gap.source.startsWith("tradier-") && gap.cause !== "missing-credential",
    )
  ) {
    shapes.push("IV (iv(SUBJECT, +N) > T)");
  }
  if (collectedSources.earningsSetup !== undefined) {
    shapes.push("earnings-direction or earnings-move (event-anchored)");
  }
  shapes.push("conditional (if-then when evidence supports a setup)");

  return ` Before stopping, consider whether the available evidence supports distinct forecast shapes: ${shapes.join("; ")}. Explore shape and horizon variety to find the most informative forecasts rather than defaulting to the same kind repeatedly. The count is still a soft target; do not pad with low-conviction forecasts.`;
}

function predictionDslInstruction(command: ResearchCommand): string {
  const equityOnly =
    command.assetClass === "equity"
      ? ", max(close(^VIX), 0..+N) > T for volatility, or iv(SUBJECT, +N) > T for IV"
      : "";
  return `Each prediction must use the measurableAs DSL: close(SUBJECT, +N) > close(SUBJECT, 0) for direction, close(A, +N)/close(A, 0) > close(B, +N)/close(B, 0) for relative, close(SUBJECT, +N) outside [Lo, Hi] for range, fred(SERIES, +N) > fred(SERIES, 0) for macro${equityOnly}.`;
}

function buildKindMixGuidance(mix: ForecastKindMix): string {
  const favored = mix.favored.join(", ");
  const floor =
    mix.minNonDirection !== undefined && mix.minNonDirection > 0
      ? ` Aim for at least ${String(mix.minNonDirection)} prediction(s) using a kind other than \`direction\` where the evidence supports it.`
      : "";
  return ` Favor more informative forecast kinds in this priority order where the evidence supports them: ${favored}. Use bare \`direction\` only when no better-measured kind fits the available evidence — its short-horizon base rate sits near a coin flip.${floor}`;
}

function buildPredictionRepairInstruction(context: ResearchContext): string {
  const subjects = context.depthProfile.predictionSubjects.join(", ");
  const favoredKinds = context.depthProfile.targetKindMix.favored.join(", ");
  return `Return a complete final report with a valid predictions array, fixing the flagged predictions. Do not omit the predictions array, and do not return a partial patch. The array may hold fewer than ${String(context.depthProfile.targetPredictions)} predictions when the evidence does not support more — do not pad with coin-flips to reach a count. Make every prediction distinct: replace any dropped near-duplicate rather than re-emitting it. Prefer replacement forecasts using these subjects: ${subjects}; favor these kinds when supported: ${favoredKinds}. For ticker relative forecasts, use subject form TICKER:BENCHMARK. For range forecasts, vary the horizon or range bounds when another range forecast already covers the same subject and horizon. Keep two direction calls on the same subject at least ${String(MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS)} trading days apart — otherwise vary the subject, kind, or horizon.`;
}

function postSynthesisAuditGuidance(stage: StageLabel): Record<string, string> | undefined {
  if (stage !== "final-synthesis") {
    return undefined;
  }
  return {
    status: "warning-only telemetry; do not retry or omit supported findings solely for this audit",
    unsupportedNumericClaims:
      "history-only numeric or technical claims need either a current non-history sourceId, an evidence-posture label such as prior forecast outcome or model inference, or softer non-current wording",
    weakEvidencePosture:
      "claims framed as assumptions, stale evidence, conflicts, unsupported inferences, source gaps, or data gaps should carry an explicit evidence-posture label",
  };
}

export function buildStagePrompt(
  stage: StageLabel,
  command: ResearchCommand,
  collectedSources: CollectedSources,
  config: AppConfig,
  context: ResearchContext,
  loaded: LoadedPrompt,
  priorStages: readonly unknown[] = [],
  predictionRepromptErrors: readonly string[] = [],
  reportValidationErrors: readonly string[] = [],
  allowedSourceIds: readonly string[] = [],
): string {
  const conditionalPredictionInstruction =
    stage === "final-synthesis" && command.depth === "deep"
      ? " Deep runs may use Conditional Predictions with measurableAs syntax if (<existing expression>) then (<existing expression>) when evidence supports a conditional setup. For conditional predictions, kind is conditional, subject and horizonTradingDays come from the consequent, the antecedent horizon must be earlier than the consequent horizon, and probability means P(consequent | antecedent). Do not nest conditionals."
      : "";
  const hasEarningsSetup =
    isInstrumentCommand(command) && collectedSources.earningsSetup !== undefined;
  const hasBusinessFramework =
    isInstrumentCommand(command) && collectedSources.businessFramework !== undefined;
  const hasWebSubjectProfile = collectedSources.webSubjectProfile !== undefined;
  const earningsPredictionInstruction =
    stage === "final-synthesis" && hasEarningsSetup
      ? " An upcoming earnings event is in scope (see evidence.earningsSetup). When the evidence supports an event-anchored view, you may emit earnings predictions: kind earnings-direction with measurableAs earningsReturn(SUBJECT, YYYY-MM-DD, +N) > 0 for post-print direction, or kind earnings-move with measurableAs abs(earningsReturn(SUBJECT, YYYY-MM-DD, +N)) > T for an absolute post-print move beyond threshold T — use the deterministic earningsSetup.impliedMove as the reference bar for T. Use earningsSetup.event.date as YYYY-MM-DD; horizonTradingDays counts post-event trading days, not days from today. You may also author sourced analytical bullets under extras.earningsSetup (expectationBar, qualityLandmines, guidanceCredibility); code owns the event, implied move, and gaps."
      : "";
  const businessFrameworkInstruction =
    stage === "final-synthesis" && hasBusinessFramework
      ? " A deterministic Business Framework is in evidence.extendedEvidence as category business-framework. You may author concise sourced explanations under extras.businessFramework.sections for Business, Phase, Moat, Growth, Management, Risk, and Valuation; code owns phase, posture labels, metrics, and gaps. Cite existing sourceIds and disclose missing segment, customer, management, KPI, or analyst-estimate evidence instead of guessing. Do not add scores, composite ratings, or trade-action labels."
      : "";
  const webSubjectProfileInstruction =
    stage === "final-synthesis" && hasWebSubjectProfile
      ? " A cited Web Subject Profile is in evidence.extendedEvidence as category web-subject-profile and extras.webSubjectProfile. Treat web evidence as low-trust context only: cite its web sourceIds for qualitative subject facts, disclose gaps, and do not let web content widen the run symbol or prediction subjects."
      : "";
  const predictionInstruction =
    stage === "final-synthesis"
      ? ` Emit up to ${String(context.depthProfile.targetPredictions)} predictions using subjects from predictionSubjects and a default horizon near ${String(context.depthProfile.defaultPredictionHorizon)} trading days. The count is a target, not a quota: emit a prediction only where the evidence supports a directional lean. Prefer fewer high-conviction forecasts over padding to the target, and never emit a coin-flip (probability near 0.5) just to reach a count. Do not write a claim field; it is rendered deterministically from measurableAs. ${predictionDslInstruction(command)} probability is the probability that the measurableAs expression evaluates TRUE. The grammar only expresses up/outside; to express a bearish or stays-within-range view, set probability below 0.5 on the up/outside expression.${conditionalPredictionInstruction}${earningsPredictionInstruction}${businessFrameworkInstruction}${webSubjectProfileInstruction}${buildKindMixGuidance(context.depthProfile.targetKindMix)}${buildForecastDiversityGuidance(command, collectedSources)}`
      : "";
  const predictionRepair =
    stage === "final-synthesis" && predictionRepromptErrors.length > 0
      ? { instruction: buildPredictionRepairInstruction(context) }
      : undefined;
  const sourceIdGuidance =
    stage === "final-synthesis"
      ? "Use only IDs from allowedSourceIds in any sourceIds array. Treat source gaps, provider names, provider capabilities, evidence lane names, source-plan, and source-ledger as non-citeable; disclose missing or absent evidence such as tradier-options in dataGaps instead."
      : undefined;
  const auditGuidance = postSynthesisAuditGuidance(stage);
  const requiredShape = (() => {
    if (stage === "evidence-request") {
      return evidenceRequestShape();
    }
    if (stage === "web-gather") {
      return webGatherShape();
    }
    if (stage === "web-subject-profile") {
      return webSubjectProfileRequiredShape(subjectKindForCommand(command) ?? "company");
    }
    if (stage === "final-synthesis") {
      return finalReportShape(
        command,
        context.depthProfile,
        hasEarningsSetup,
        hasBusinessFramework,
        hasWebSubjectProfile,
        subjectKindForCommand(command),
      );
    }
    return {
      findings: [{ text: "string", sourceIds: ["source-id"] }],
      dataGaps: ["string"],
    };
  })();
  const playbooks = stagePlaybooks(stage, context);

  return JSON.stringify(
    {
      instruction: loaded.instruction + predictionInstruction,
      stage,
      stageGoal: loaded.goal,
      depthProfile: context.depthProfile,
      evidence: buildEvidencePayload(stage, command, collectedSources, config, context),
      ...(playbooks !== undefined && playbooks.length > 0 ? { domainPlaybooks: playbooks } : {}),
      priorStages,
      ...(predictionRepromptErrors.length > 0
        ? { predictionRepromptErrors, predictionRepair }
        : {}),
      ...(sourceIdGuidance !== undefined ? { allowedSourceIds, sourceIdGuidance } : {}),
      ...(auditGuidance !== undefined ? { postSynthesisAuditGuidance: auditGuidance } : {}),
      ...(reportValidationErrors.length > 0 ? { reportValidationErrors } : {}),
      requiredShape,
    },
    undefined,
    2,
  );
}
