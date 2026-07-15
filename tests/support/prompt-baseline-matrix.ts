import type { AppConfig } from "../../src/config";
import type { ResearchCommand } from "../../src/cli/args";
import type {
  EvidenceRequestContext,
  ResearchContext,
  WebGatherContext,
} from "../../src/research/research-context-types";
import { buildDepthProfile } from "../../src/research/depth-profile";
import {
  buildPlaybookSelectionPrompt,
  buildSpotlightSelectionPrompt,
  buildStagePrompt,
  buildStageSteeringSegment,
  buildWebSourceSynthesisInputs,
  type PredictionCompletionPrompt,
  type StageInput,
} from "../../src/research/prompts";
import type { LoadedPrompt, StageLabel } from "../../src/research/prompt-loader";
import type { HistoricalResearchContext } from "../../src/research/historical-context";
import type { PlaybookCandidate, PlaybookStage } from "../../src/research/playbooks";
import type { SpotlightCandidate, SpotlightSelectionResult } from "../../src/research/spotlights";
import type { BusinessFrameworkArtifact } from "../../src/sources/extended-evidence/business-framework";
import type { WebSubjectProfileArtifact } from "../../src/web-evidence";
import type { CollectedSources } from "../../src/sources/types";
import type { Source } from "../../src/domain/types";
import {
  collectedSources,
  marketSnapshot,
  newsSource,
  prediction,
  researchReport,
  verifiedMarketSnapshot,
} from "./fixtures";

// Fixed input matrix for the prompt byte-identity baseline (phase 2 step 0 of the
// Deepen-modules refactor). Every input is a constant: no wall clock, no randomness.
// The matrix covers all 13 StageLabels plus the special branches — final-synthesis
// Primary/completion/repair/language-repair, each Web Subject Profile subject kind,
// Both selector prompts, the steering segment, and the web-source synthesis inputs.

const ANALYSIS_AS_OF = "2026-06-01T00:00:00.000Z";

const config: AppConfig = {
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

const equityCommand: ResearchCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
};

const cryptoCommand: ResearchCommand = {
  jobType: "crypto",
  assetClass: "crypto",
  symbol: "BTC-USD",
  depth: "brief",
};

const overviewCommand: ResearchCommand = {
  jobType: "market-overview",
  assetClass: "equity",
  depth: "deep",
  horizonTradingDays: 5,
  legacyAlias: "daily",
  prompt: "Focus on semiconductor supply-chain movers.",
};

const researchCommand: ResearchCommand = {
  jobType: "research",
  assetClass: "equity",
  subject: "chip stocks",
  subjectKey: "semiconductors",
  predictionProxySymbol: "SMH",
  depth: "brief",
};

const loadedPrompt: LoadedPrompt = {
  system: "Research only.",
  instruction: "Analyze the evidence.",
  goal: "Find sourced evidence.",
};

const companyProfile: WebSubjectProfileArtifact = {
  version: 2,
  generatedAt: "2026-05-28T00:00:00.000Z",
  subjectKind: "company",
  subjectId: "AAPL",
  symbol: "AAPL",
  subjectSummary: { answer: "Apple sells devices", sourceIds: ["web-1"] },
  questions: {
    whatItDoes: { answer: "Consumer electronics", sourceIds: ["web-1"] },
    howItMakesMoney: { answer: "Hardware + services", sourceIds: ["web-1"] },
    customers: { answer: "Global consumers", sourceIds: ["web-1"] },
    geography: { answer: "Worldwide", sourceIds: ["web-1"] },
    purchaseRecurrence: { answer: "High", sourceIds: ["web-1"] },
    pricingPower: { answer: "Premium", sourceIds: ["web-1"] },
    recessionCyclicality: { answer: "Moderate", sourceIds: ["web-1"] },
  },
  recentMaterialEvents: [{ claim: "Launched a device", sourceIds: ["web-1"] }],
  factLedger: [{ claim: "Revenue grew", sourceIds: ["web-1"] }],
  openGaps: ["No segment split"],
  sourceIds: ["web-1"],
};

const profileCoveredWebSource: Source = {
  id: "web-1",
  title: "Apple overview",
  fetchedAt: ANALYSIS_AS_OF,
  kind: "web",
  assetClass: "equity",
  publisher: "example.com",
  summary: "Apple overview summary.",
  snippet: "Apple overview snippet.",
};

const freshWebSource: Source = {
  id: "web-2",
  title: "Apple fresh development",
  fetchedAt: ANALYSIS_AS_OF,
  kind: "web",
  assetClass: "equity",
  publisher: "news.example.com",
  summary: "A fresh development this run.",
  snippet: "Fresh snippet.",
};

const historicalContext = {
  generatedAt: "2026-05-30T00:00:00.000Z",
  recentDays: 14,
  anchorMonths: 3,
  sources: [
    {
      id: "history-report-run-0",
      title: "Prior run",
      fetchedAt: "2026-05-30T00:00:00.000Z",
      kind: "history",
      assetClass: "equity",
    },
  ],
  runs: [
    {
      runId: "run-0",
      generatedAt: "2026-05-20T00:00:00.000Z",
      jobType: "equity",
      summary: "Prior thesis summary.",
    },
  ],
  gaps: ["Sparse history"],
  audit: { scannedRunCount: 1, selectedRunCount: 1 },
  artifactDeltas: [],
} as unknown as HistoricalResearchContext;

const spotlightCandidate: SpotlightCandidate = {
  id: "cand-nvda",
  symbol: "NVDA",
  assetClass: "equity",
  name: "NVIDIA",
  sourceIds: ["market-nvda"],
  currentSnapshot: {
    price: 500,
    changePercent24h: 4,
    volume: 2_000_000,
    observedAt: ANALYSIS_AS_OF,
  },
  mover: {
    rank: 1,
    score: 0.9,
    features: {
      movementMagnitude: 4,
      liquidityLog: 6.3,
      baseScore: 0.9,
      unusualVolumeBoost: 0,
      gapBoost: 0,
      finalMultiplier: 1,
      reasons: ["4% absolute 24h move"],
    },
  },
  history: { tickerRunIds: [], marketRunIds: [] },
};

const spotlightSelection: SpotlightSelectionResult = {
  rationale: "High-signal mover.",
  selected: [
    {
      symbol: "NVDA",
      rationale: "Datacenter momentum.",
      sourceIds: ["market-nvda"],
      candidate: spotlightCandidate,
    },
  ],
  rejected: [],
  audit: { cap: 2, candidateCount: 1, selectedCount: 1, rejectedCount: 0, malformed: false },
};

const evidenceRequestContext = {
  round: 1,
  availableTools: ["tradier_iv_term_structure"],
  toolUnits: { tradier_iv_term_structure: 1 },
  sourceUnitsUsed: 0,
  toolCallsUsed: 0,
  maxRounds: 2,
  maxToolCalls: 4,
  sourceBudget: 6,
} as unknown as EvidenceRequestContext;

const webGatherContext = {
  round: 1,
  availableTools: ["web_search", "web_fetch"],
  toolUnits: { web_search: 1, web_fetch: 1 },
  sourceUnitsUsed: 1,
  toolCallsUsed: 1,
  maxRounds: 2,
  maxToolCalls: 6,
  sourceBudget: 8,
  surfacedUrls: ["https://news.example.com/apple"],
  subjectTerms: ["AAPL", "Apple"],
} as unknown as WebGatherContext;

function richEquitySources(): CollectedSources {
  return collectedSources({
    marketSnapshots: [marketSnapshot()],
    newsSources: [newsSource()],
    extendedSources: [profileCoveredWebSource, freshWebSource],
    verifiedMarketSnapshot: verifiedMarketSnapshot(),
    webSubjectProfile: companyProfile,
    webSubjectProfileReuse: {
      runDirName: "2026-05-28T00-00-00-000Z-prior",
      generatedAt: "2026-05-28T00:00:00.000Z",
    },
    earningsSetup: {
      event: {
        symbol: "AAPL",
        date: "2026-07-30",
        timing: "amc",
        sourceIds: ["earnings-aapl"],
        fetchedAt: ANALYSIS_AS_OF,
        epsEstimate: 2.1,
      },
      impliedMove: {
        expiration: "2026-07-31",
        strike: 110,
        spot: 108,
        straddleMidpoint: 6.5,
        impliedMovePct: 6,
        sourceIds: ["tradier-aapl-options"],
        observedAt: ANALYSIS_AS_OF,
      },
      gaps: [],
    },
    extendedEvidence: {
      instrument: { symbol: "AAPL", assetClass: "equity" },
      items: [
        {
          category: "options-iv",
          title: "AAPL options IV",
          summary: "Near-term IV is elevated.",
          sourceIds: ["tradier-aapl-options"],
          observedAt: ANALYSIS_AS_OF,
        },
      ],
      gaps: [],
    },
    businessFramework: { sections: [] } as unknown as BusinessFrameworkArtifact,
  });
}

function equityContext(): ResearchContext {
  return {
    analysisAsOf: ANALYSIS_AS_OF,
    depthProfile: buildDepthProfile(equityCommand, config),
    runParams: {
      quickModel: "quick-test",
      synthesisModel: "synthesis-test",
      analystStyle: "fuller analyst-style",
      minimumKeyFindings: 3,
      minimumScenarios: 2,
      targetPredictions: 4,
      defaultPredictionHorizon: 5,
      predictionSubjects: ["AAPL", "^VIX", "SPY"],
      focus: ["earnings", "options"],
      targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
      modelParams: undefined,
    },
    marketRegime: {
      assetClass: "equity",
      label: "risk-on",
      proxyCount: 2,
      drivers: ["breadth"],
      sourceIds: ["market-spy"],
    },
    calibrationContext: undefined,
    evidenceRequest: evidenceRequestContext,
    webGather: webGatherContext,
    historicalContext,
    spotlightCandidates: [spotlightCandidate],
    spotlightSelection,
    domainPlaybooks: [
      {
        stage: "critique",
        playbooks: [
          {
            id: "critique-discipline",
            title: "Critique Discipline",
            summary: "Stress-test weak claims.",
            file: "critique-discipline.md",
            jobTypes: ["daily", "weekly", "equity", "crypto"],
            assetClasses: ["equity", "crypto"],
            depths: ["brief", "deep"],
            stages: ["critique"],
            instruction: "Challenge weak claims.",
          },
        ],
      },
      {
        stage: "final-synthesis",
        playbooks: [
          {
            id: "synthesis-discipline",
            title: "Synthesis Discipline",
            summary: "Cite every claim.",
            file: "synthesis-discipline.md",
            jobTypes: ["daily", "weekly", "equity", "crypto"],
            assetClasses: ["equity", "crypto"],
            depths: ["brief", "deep"],
            stages: ["final-synthesis"],
            instruction: "Cite every claim.",
          },
        ],
      },
    ],
  };
}

function contextFor(command: ResearchCommand): ResearchContext {
  return {
    analysisAsOf: ANALYSIS_AS_OF,
    depthProfile: buildDepthProfile(command, config),
    runParams: {
      quickModel: "quick-test",
      synthesisModel: "synthesis-test",
      analystStyle: "concise brief",
      minimumKeyFindings: 3,
      minimumScenarios: 2,
      targetPredictions: 2,
      defaultPredictionHorizon: 5,
      predictionSubjects: ["SPY"],
      focus: ["market regime"],
      targetKindMix: { favored: ["direction"], minNonDirection: 0 },
      modelParams: undefined,
    },
    marketRegime: {
      assetClass: command.assetClass,
      label: "insufficient-data",
      proxyCount: 0,
      drivers: [],
      sourceIds: [],
    },
    calibrationContext: undefined,
  };
}

function stageInput(overrides: Partial<StageInput> = {}): StageInput {
  return {
    command: equityCommand,
    collectedSources: richEquitySources(),
    config,
    context: equityContext(),
    loaded: loadedPrompt,
    allowedSourceIds: ["market-aapl", "news-equity-1", "web-1", "web-2"],
    ...overrides,
  };
}

const completion: PredictionCompletionPrompt = {
  requestedCount: 2,
  existingPredictions: [prediction({ sourceIds: ["market-aapl"] })],
  reportDraft: researchReport({
    summary: "Draft summary.",
    keyFindings: [{ text: "Finding.", sourceIds: ["market-aapl"] }],
    dataGaps: ["gap"],
    sources: [profileCoveredWebSource, freshWebSource, newsSource()],
    predictions: [prediction({ sourceIds: ["market-aapl"] })],
  }),
};

const completionPriorStages: readonly unknown[] = [
  { stage: "specialist-analysis", content: "analysis text" },
  { stage: "critique", content: "critique text" },
];

const GENERIC_STAGES: readonly StageLabel[] = [
  "specialist-analysis",
  "regime-context-analysis",
  "mover-theme-analysis",
  "instrument-evidence-analysis",
  "market-behavior-analysis",
  "critique",
  "forecast-disagreement",
];

const playbookCandidates: readonly PlaybookCandidate[] = [
  {
    id: "critique-discipline",
    title: "Critique Discipline",
    summary: "Stress-test weak claims.",
    eligibleStages: ["critique"],
  },
];

const plannedStages: readonly PlaybookStage[] = ["specialist-analysis", "critique"];

export interface PromptBaselineCase {
  readonly key: string;
  readonly text: string;
}

export function promptBaselineCases(): readonly PromptBaselineCase[] {
  const cases: PromptBaselineCase[] = [];
  const add = (key: string, text: string | undefined): void => {
    cases.push({ key, text: text ?? "<undefined>" });
  };

  for (const stage of GENERIC_STAGES) {
    add(`stage:${stage}`, buildStagePrompt(stage, stageInput()));
  }

  add("stage:evidence-request", buildStagePrompt("evidence-request", stageInput()));
  add("stage:web-gather", buildStagePrompt("web-gather", stageInput()));

  add("stage:web-subject-profile:company", buildStagePrompt("web-subject-profile", stageInput()));
  add(
    "stage:web-subject-profile:crypto-asset",
    buildStagePrompt(
      "web-subject-profile",
      stageInput({
        command: cryptoCommand,
        collectedSources: collectedSources({
          marketSnapshots: [
            marketSnapshot({ sourceId: "market-btc", assetClass: "crypto", symbol: "BTC-USD" }),
          ],
          newsSources: [newsSource({ id: "news-crypto-1", assetClass: "crypto" })],
          extendedSources: [freshWebSource],
        }),
        context: contextFor(cryptoCommand),
      }),
    ),
  );
  add(
    "stage:web-subject-profile:theme",
    buildStagePrompt(
      "web-subject-profile",
      stageInput({
        command: researchCommand,
        collectedSources: collectedSources({
          marketSnapshots: [marketSnapshot({ sourceId: "market-smh", symbol: "SMH" })],
          newsSources: [newsSource()],
          extendedSources: [freshWebSource],
        }),
        context: contextFor(researchCommand),
      }),
    ),
  );

  add("stage:final-synthesis:primary", buildStagePrompt("final-synthesis", stageInput()));
  add(
    "stage:final-synthesis:completion",
    buildStagePrompt(
      "final-synthesis",
      stageInput({ predictionCompletion: completion, priorStages: completionPriorStages }),
    ),
  );
  add(
    "stage:final-synthesis:repair",
    buildStagePrompt(
      "final-synthesis",
      stageInput({ predictionRepromptErrors: ["duplicate prediction pred-1"] }),
    ),
  );
  add(
    "stage:final-synthesis:language-repair",
    buildStagePrompt(
      "final-synthesis",
      stageInput({
        reportValidationErrors: ['summary contains trade-action language: "buy the dip"'],
      }),
    ),
  );
  add(
    "stage:final-synthesis:overview-steering",
    buildStagePrompt(
      "final-synthesis",
      stageInput({
        command: overviewCommand,
        collectedSources: collectedSources({
          marketSnapshots: [marketSnapshot()],
          newsSources: [newsSource()],
        }),
        context: { ...contextFor(overviewCommand), spotlightSelection },
      }),
    ),
  );
  add(
    "stage:final-synthesis:research-registry",
    buildStagePrompt(
      "final-synthesis",
      stageInput({
        command: researchCommand,
        collectedSources: collectedSources({
          marketSnapshots: [marketSnapshot({ sourceId: "market-smh", symbol: "SMH" })],
          newsSources: [newsSource()],
          resolvedSubject: {
            subjectKey: "semiconductors",
            displayName: "Semiconductors",
            representativeInstruments: [
              {
                symbol: "SMH",
                name: "VanEck Semiconductor ETF",
                instrumentType: "etf",
                sourceIds: ["registry-semis"],
              },
            ],
            sources: [{ sourceId: "registry-semis", title: "Subject registry" }],
            predictionProxySymbol: "SMH",
          } as unknown as NonNullable<CollectedSources["resolvedSubject"]>,
        }),
        context: contextFor(researchCommand),
      }),
    ),
  );

  add(
    "selector:playbook-selection",
    buildPlaybookSelectionPrompt(
      equityCommand,
      richEquitySources(),
      equityContext(),
      loadedPrompt,
      plannedStages,
      playbookCandidates,
    ),
  );
  add(
    "selector:spotlight-selection",
    buildSpotlightSelectionPrompt(
      overviewCommand,
      collectedSources({ marketSnapshots: [marketSnapshot()], newsSources: [newsSource()] }),
      { ...contextFor(overviewCommand), historicalContext },
      loadedPrompt,
      [spotlightCandidate],
      2,
    ),
  );

  add(
    "segment:steering:primary",
    buildStageSteeringSegment(
      "final-synthesis",
      equityCommand,
      richEquitySources(),
      equityContext(),
    ),
  );
  add(
    "segment:steering:completion",
    buildStageSteeringSegment(
      "final-synthesis",
      equityCommand,
      richEquitySources(),
      equityContext(),
      [],
      completion,
    ),
  );
  add(
    "segment:steering:repair",
    buildStageSteeringSegment(
      "final-synthesis",
      equityCommand,
      richEquitySources(),
      equityContext(),
      ["duplicate prediction pred-1"],
    ),
  );
  add(
    "segment:steering:non-synthesis",
    buildStageSteeringSegment("critique", equityCommand, richEquitySources(), equityContext()),
  );

  add(
    "segment:web-source-synthesis-inputs",
    JSON.stringify(buildWebSourceSynthesisInputs(equityCommand, richEquitySources())),
  );

  return cases;
}
