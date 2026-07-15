import type { AppConfig } from "../../src/config";
import type { ResearchCommand } from "../../src/cli/args";
import type { Prediction, PredictionKind } from "../../src/domain/types";
import { buildStagePrompt, type StageInput } from "../../src/research/prompts";
import { buildDepthProfile } from "../../src/research/depth-profile";
import type { HistoricalResearchContext } from "../../src/research/historical-context";
import type { ResearchContext } from "../../src/research/research-context-types";
import type { ResolvedPair } from "../../src/scoring/calibration";
import { collectedSources, marketSnapshot, newsSource, researchReport } from "./fixtures";

// Shared fixtures for the carved research-context prompt tests (formerly one monolith).

export const config: AppConfig = {
  provider: "openai",
  quickModel: "quick-test",
  synthesisModel: "synthesis-test",
  modelTimeoutMs: 120_000,
  dataDir: "data/runs",
  promptDir: "prompts",
  sourceOptions: {
    equityMoverLimit: 2,
    cryptoMoverLimit: 2,
    newsLimit: 2,
    sourceTimeoutMs: 1000,
  },
  evidenceRequestOptions: {
    maxRounds: 0,
    maxToolCalls: 0,
    sourceBudget: 0,
  },
  webGatherOptions: {
    maxRounds: 0,
    maxToolCalls: 0,
    sourceBudget: 0,
  },
  webGatherDisabled: false,
  webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
  alphaSearchOptions: {
    apeWisdomFilter: "all-stocks",
    apeWisdomBriefPageLimit: 5,
    apeWisdomDeepPageLimit: 10,
    validationCandidateLimit: 25,
    leadLimit: 15,
    topCandidateLimit: 15,
    secDiscoveryLimit: 25,
    secFormTypes: ["S-1", "F-1", "8-K", "6-K"],
    minPrice: 0.5,
    minVolume: 100_000,
    minMarketCap: 50_000_000,
    maxMarketCap: 10_000_000_000,
  },
};

// BuildStagePrompt narrowed to (stage, StageInput). These prompt-content regression tests keep
// Their original positional stage inputs through this adapter; the StageInput assembly describe
// Block exercises the object form directly.
export function stagePromptFromArgs(
  stage: Parameters<typeof buildStagePrompt>[0],
  command: StageInput["command"],
  sources: StageInput["collectedSources"],
  appConfig: StageInput["config"],
  context: StageInput["context"],
  loaded: StageInput["loaded"],
  priorStages: NonNullable<StageInput["priorStages"]> = [],
  predictionRepromptErrors: NonNullable<StageInput["predictionRepromptErrors"]> = [],
  reportValidationErrors: NonNullable<StageInput["reportValidationErrors"]> = [],
  allowedSourceIds: NonNullable<StageInput["allowedSourceIds"]> = [],
  predictionCompletion?: StageInput["predictionCompletion"],
): string {
  return buildStagePrompt(stage, {
    command,
    collectedSources: sources,
    config: appConfig,
    context,
    loaded,
    priorStages,
    predictionRepromptErrors,
    reportValidationErrors,
    allowedSourceIds,
    ...(predictionCompletion !== undefined ? { predictionCompletion } : {}),
  });
}

export function contextWithHistory(
  command: ResearchCommand,
  historicalContext?: HistoricalResearchContext,
): ResearchContext {
  return {
    depthProfile: buildDepthProfile(command, config),
    runParams: {
      quickModel: "quick-test",
      synthesisModel: "synthesis-test",
      analystStyle: "concise brief",
      minimumKeyFindings: 3,
      minimumScenarios: 2,
      targetPredictions: 2,
      defaultPredictionHorizon: 5,
      predictionSubjects: ["AAPL"],
      focus: ["instrument"],
      targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
      modelParams: undefined,
    },
    marketRegime: {
      assetClass: "equity",
      label: "mixed",
      proxyCount: 1,
      drivers: [],
      sourceIds: [],
    },
    calibrationContext: undefined,
    ...(historicalContext !== undefined ? { historicalContext } : {}),
  };
}

export function researchContext(command: ResearchCommand): ResearchContext {
  return {
    depthProfile: buildDepthProfile(command, config),
    runParams: {
      quickModel: "quick-test",
      synthesisModel: "synthesis-test",
      analystStyle: "concise brief",
      minimumKeyFindings: 3,
      minimumScenarios: 2,
      targetPredictions: 2,
      defaultPredictionHorizon: 5,
      predictionSubjects: ["SMH"],
      focus: ["market regime"],
      targetKindMix: { favored: ["direction"], minNonDirection: 0 },
      modelParams: undefined,
    },
    marketRegime: {
      assetClass: "equity",
      label: "insufficient-data",
      proxyCount: 0,
      drivers: [],
      sourceIds: [],
    },
    calibrationContext: undefined,
  };
}

export function directionPrediction(id: string, probability: number): Prediction {
  return {
    id,
    claim: "SPY closes higher",
    kind: "direction",
    subject: "SPY",
    measurableAs: "close(SPY, +5) > close(SPY, 0)",
    horizonTradingDays: 5,
    probability,
    sourceIds: [],
  };
}

export function resolvedPair(
  id: string,
  probability: number,
  outcome: "hit" | "miss",
): ResolvedPair {
  return {
    prediction: directionPrediction(id, probability),
    score: {
      predictionId: id,
      runId: "run-1",
      resolved: true,
      outcome,
      observedAt: "2026-06-01T00:00:00.000Z",
      attemptCount: 1,
      evidence: {},
    },
    assetClass: "equity",
    jobType: "daily",
    marketUpdateHorizonBucket: "1-5d",
    runId: "run-1",
  };
}

// Returns the individual kinds the equity final-synthesis required shape advertises for pred-1.
// The model-visible shape must stay gated in lockstep with the prose: volatility only when ^VIX
// Is an allowed subject, iv only with citeable options-iv evidence (2026-07-05 review — an
// Ungated shape advertised ^VIX/iv the subject gate then rejected).
export function equityRequiredShapeKinds(opts: {
  readonly predictionSubjects: readonly string[];
  readonly sources?: Partial<Parameters<typeof collectedSources>[0]>;
  readonly depth?: "brief" | "deep";
}): readonly string[] {
  const command: ResearchCommand = {
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    depth: opts.depth ?? "deep",
  };
  const baseProfile = buildDepthProfile(command, config);
  const prompt = stagePromptFromArgs(
    "final-synthesis",
    command,
    collectedSources({
      marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
      newsSources: [newsSource()],
      ...opts.sources,
    }),
    config,
    {
      depthProfile: { ...baseProfile, predictionSubjects: opts.predictionSubjects },
      runParams: {
        quickModel: "quick-test",
        synthesisModel: "synthesis-test",
        analystStyle: "fuller analyst-style",
        minimumKeyFindings: 6,
        minimumScenarios: 3,
        targetPredictions: 5,
        defaultPredictionHorizon: 5,
        predictionSubjects: opts.predictionSubjects,
        focus: ["thesis"],
        targetKindMix: { favored: ["relative", "range"], minNonDirection: 2 },
        modelParams: undefined,
      },
      marketRegime: {
        assetClass: "equity",
        label: "mixed",
        proxyCount: 1,
        drivers: [],
        sourceIds: [],
      },
      calibrationContext: undefined,
    },
    { system: "Research only.", instruction: "Synthesize.", goal: "Final report." },
  );
  const parsed = JSON.parse(prompt) as {
    readonly requiredShape?: { readonly predictions?: readonly { readonly kind?: string }[] };
  };
  return parsed.requiredShape?.predictions?.[0]?.kind?.split("|") ?? [];
}

// Builds the completion-pass instruction for an AAPL equity deep run with full control over the
// Allowed subjects, kind mix, collected evidence, and existing predictions the pass sees.
export function completionInstruction(opts: {
  readonly predictionSubjects: readonly string[];
  readonly favoredKinds?: readonly PredictionKind[];
  readonly sources?: Partial<Parameters<typeof collectedSources>[0]>;
  readonly existingPredictions?: readonly Prediction[];
  readonly depth?: "deep" | "brief";
}): string {
  const command: ResearchCommand = {
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    depth: opts.depth ?? "deep",
  };
  const baseProfile = buildDepthProfile(command, config);
  const prompt = stagePromptFromArgs(
    "final-synthesis",
    command,
    collectedSources({
      marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
      newsSources: [newsSource()],
      ...opts.sources,
    }),
    config,
    {
      depthProfile: {
        ...baseProfile,
        predictionSubjects: opts.predictionSubjects,
        targetKindMix: {
          favored: opts.favoredKinds ?? ["relative", "range"],
          minNonDirection: 1,
        },
      },
      runParams: {
        quickModel: "quick-test",
        synthesisModel: "synthesis-test",
        analystStyle: "fuller analyst-style",
        minimumKeyFindings: 5,
        minimumScenarios: 3,
        targetPredictions: 5,
        defaultPredictionHorizon: 5,
        predictionSubjects: opts.predictionSubjects,
        focus: ["thesis"],
        targetKindMix: {
          favored: opts.favoredKinds ?? ["relative", "range"],
          minNonDirection: 1,
        },
        modelParams: undefined,
      },
      marketRegime: {
        assetClass: "equity",
        label: "mixed",
        proxyCount: 1,
        drivers: [],
        sourceIds: [],
      },
      calibrationContext: undefined,
    },
    { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    [],
    [],
    [],
    [],
    {
      requestedCount: 2,
      existingPredictions: opts.existingPredictions ?? [],
      reportDraft: researchReport(),
    },
  );
  return (JSON.parse(prompt) as { readonly instruction: string }).instruction;
}
