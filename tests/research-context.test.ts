import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import type { ResearchCommand } from "../src/cli/args";
import {
  buildDepthProfile,
  buildPlaybookSelectionPrompt,
  buildSpotlightSelectionPrompt,
  buildStagePrompt,
  type ResearchContext,
} from "../src/research/research-context";
import { buildSpotlightCandidates } from "../src/research/spotlights";
import { buildCalibrationSummary, type ResolvedPair } from "../src/scoring/calibration";
import type {
  HistoricalPredictionSummary,
  HistoricalResearchContext,
  HistoricalRunContext,
} from "../src/research/historical-context";
import type { Prediction } from "../src/domain/types";
import { collectedSources, marketSnapshot, newsSource } from "./support/fixtures";

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

function directionPrediction(id: string, probability: number): Prediction {
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

function resolvedPair(id: string, probability: number, outcome: "hit" | "miss"): ResolvedPair {
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
    marketUpdateCadence: "daily",
    runId: "run-1",
  };
}

describe("buildStagePrompt", () => {
  test("includes mover feature breakdown in evidence payload", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const prompt = buildStagePrompt(
      "specialist-analysis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [
          marketSnapshot({
            symbol: "AAPL",
            changePercent24h: 5,
            volume: 1_000_000,
            averageVolume: 500_000,
            open: 105,
            previousClose: 100,
          }),
        ],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          minimumPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
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
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: {
        readonly movers?: readonly {
          readonly features?: {
            readonly unusualVolumeRatio?: number;
            readonly gapPercent?: number;
            readonly reasons?: readonly string[];
          };
        }[];
      };
    };

    expect(parsed.evidence?.movers?.[0]?.features?.unusualVolumeRatio).toBe(2);
    expect(parsed.evidence?.movers?.[0]?.features?.gapPercent).toBe(5);
    expect(parsed.evidence?.movers?.[0]?.features?.reasons).toContain("5% absolute 24h move");
    expect(parsed.evidence?.movers?.[0]?.features?.reasons).toContain("log10 volume 6");
    expect(parsed.evidence?.movers?.[0]?.features?.reasons).toContain("volume 2x average");
    expect(parsed.evidence?.movers?.[0]?.features?.reasons).toContain("5% absolute opening gap");
  });

  test("uses the non-final required shape for coverage panel stages", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "deep" };
    const prompt = buildStagePrompt(
      "regime-context-analysis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "fuller analyst-style",
          minimumKeyFindings: 5,
          minimumScenarios: 3,
          minimumPredictions: 3,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers", "cross-asset themes", "risks", "source gaps"],
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
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Expand coverage." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly stage?: string;
      readonly requiredShape?: {
        readonly findings?: readonly { readonly text?: string; readonly sourceIds?: string[] }[];
        readonly dataGaps?: readonly string[];
      };
    };

    expect(parsed.stage).toBe("regime-context-analysis");
    expect(parsed.requiredShape).toEqual({
      findings: [{ text: "string", sourceIds: ["source-id"] }],
      dataGaps: ["string"],
    });
  });

  test("adds explicit prediction repair guidance on final-synthesis retries", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const prompt = buildStagePrompt(
      "final-synthesis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          minimumPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
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
      [],
      ["predictionShortfall: required 2, received 1"],
    );
    const parsed = JSON.parse(prompt) as {
      readonly predictionRepair?: {
        readonly requiredPredictionCount?: number;
        readonly instruction?: string;
      };
      readonly predictionRepromptErrors?: readonly string[];
    };

    expect(parsed.predictionRepromptErrors).toEqual([
      "predictionShortfall: required 2, received 1",
    ]);
    expect(parsed.predictionRepair).toEqual({
      requiredPredictionCount: 2,
      instruction:
        "Return a complete final report with exactly 2 valid predictions. Do not omit the predictions array, and do not return a partial patch.",
    });
  });

  test("renders prior calibration from real CalibrationSummary JSON without undefined", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const summary = buildCalibrationSummary([
      resolvedPair("pred-1", 0.65, "hit"),
      resolvedPair("pred-2", 0.65, "miss"),
    ]);
    // StructuredClone strips type identity to mimic a CalibrationSummary loaded from summary.json.
    const calibrationContext = structuredClone(summary) as never;

    const prompt = buildStagePrompt(
      "specialist-analysis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          minimumPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "mixed",
          proxyCount: 1,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext,
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: { readonly priorCalibration?: string };
    };
    const block = parsed.evidence?.priorCalibration;

    expect(block).toBeDefined();
    expect(block).not.toContain("undefined");
    expect(block).not.toContain("NaN");
    // Renders the real bin label, hit rate, and sample count from CalibrationSummary.
    expect(block).toContain("0.6-0.7");
    expect(block).toContain("0.50");
    expect(block).toContain("n=2");
  });

  test("surfaces overall skill and per-kind / per-horizon calibration slices", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const summary = buildCalibrationSummary([
      resolvedPair("pred-1", 0.65, "hit"),
      resolvedPair("pred-2", 0.65, "miss"),
    ]);
    const calibrationContext = structuredClone(summary) as never;

    const prompt = buildStagePrompt(
      "specialist-analysis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          minimumPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "mixed",
          proxyCount: 1,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext,
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: { readonly priorCalibration?: string };
    };
    const block = parsed.evidence?.priorCalibration;

    expect(block).toBeDefined();
    expect(block).not.toContain("undefined");
    expect(block).not.toContain("NaN");
    // Overall Brier skill vs the 0.5 baseline is surfaced alongside raw Brier.
    expect(block).toContain("Brier skill");
    // Per-kind slice (direction) and per-horizon bucket (1-5d) are surfaced as directives.
    expect(block).toContain("direction");
    expect(block).toContain("1-5d");
    expect(block).toContain("base rates");
  });

  test("injects domain playbooks as a separate prompt field", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const prompt = buildStagePrompt(
      "critique",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          minimumPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
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
        domainPlaybooks: [
          {
            stage: "critique",
            playbooks: [
              {
                id: "critique-discipline",
                title: "Critique Discipline",
                summary: "Stress-test weak claims.",
                file: "critique-discipline.md",
                jobTypes: ["daily", "weekly", "ticker"],
                assetClasses: ["equity", "crypto"],
                depths: ["brief", "deep"],
                stages: ["critique"],
                instruction: "Challenge weak claims.",
              },
            ],
          },
        ],
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Review evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly instruction?: string;
      readonly domainPlaybooks?: readonly { readonly instruction?: string }[];
    };

    expect(parsed.instruction).toBe("Analyze.");
    expect(parsed.domainPlaybooks?.[0]?.instruction).toBe("Challenge weak claims.");
  });
});

function missSummary(
  id: string,
  overrides: Partial<HistoricalPredictionSummary> = {},
): HistoricalPredictionSummary {
  return {
    id,
    claim: "AAPL closes higher",
    subject: "AAPL",
    horizonTradingDays: 5,
    probability: 0.72,
    scoreStatus: "resolved",
    scoreOutcome: "miss",
    ...overrides,
  };
}

function tickerRun(
  runId: string,
  symbol: string,
  predictions: readonly HistoricalPredictionSummary[],
  generatedAt = "2026-05-20T00:00:00.000Z",
): HistoricalRunContext {
  return {
    runId,
    sourceId: `history-report-${runId}`,
    jobType: "ticker",
    assetClass: "equity",
    symbol,
    generatedAt,
    selectionReasons: ["recent"],
    summary: "",
    confidence: "medium",
    keyFindings: [],
    risks: [],
    catalysts: [],
    dataGaps: [],
    predictions,
    scoreSummary: { total: predictions.length, resolved: 0, hit: 0, miss: 0, unresolved: 0 },
    marketSnapshots: [],
  };
}

function historicalContextWith(runs: readonly HistoricalRunContext[]): HistoricalResearchContext {
  return {
    generatedAt: "2026-06-01T00:00:00.000Z",
    recentDays: 14,
    anchorMonths: [],
    runs,
    sources: [],
    gaps: [],
    audit: {
      scannedRunCount: runs.length,
      malformedRunCount: 0,
      malformedScoreCount: 0,
      candidateRunCount: runs.length,
      selectedRunCount: runs.length,
      recentSelectedCount: runs.length,
      anchorSelectedCount: 0,
    },
    artifactDeltas: [],
  };
}

function contextWithHistory(
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
      minimumPredictions: 2,
      defaultPredictionHorizon: 5,
      predictionSubjects: ["AAPL"],
      focus: ["instrument"],
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

function priorThesisErrorsFor(
  command: ResearchCommand,
  context: ResearchContext,
): string | undefined {
  const prompt = buildStagePrompt(
    "specialist-analysis",
    command,
    collectedSources({
      rawSnapshots: [],
      marketSnapshots: [marketSnapshot()],
      newsSources: [newsSource()],
      sourceGaps: [],
    }),
    config,
    context,
    { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
  );
  const parsed = JSON.parse(prompt) as {
    readonly evidence?: { readonly priorThesisErrors?: string };
  };
  return parsed.evidence?.priorThesisErrors;
}

describe("buildStagePrompt prior-thesis error correction", () => {
  const tickerCommand: ResearchCommand = {
    jobType: "ticker",
    assetClass: "equity",
    symbol: "AAPL",
    depth: "brief",
  };

  test("surfaces prior-miss bullets with run id, claim, probability, outcome, and citation", () => {
    const context = contextWithHistory(
      tickerCommand,
      historicalContextWith([tickerRun("run-aapl-1", "AAPL", [missSummary("p1")])]),
    );

    const block = priorThesisErrorsFor(tickerCommand, context);

    expect(block).toBeDefined();
    expect(block).not.toContain("undefined");
    expect(block).toContain("AAPL");
    expect(block).toContain("run-aapl-1");
    expect(block).toContain("AAPL closes higher");
    expect(block).toContain("p=0.72");
    expect(block).toContain("MISS");
    expect(block).toContain("history-report-run-aapl-1");
  });

  test("caps the number of prior-miss bullets and keeps the most recent", () => {
    const olderMisses = Array.from({ length: 6 }, (_, idx) =>
      missSummary(`old-${String(idx)}`, { claim: `older claim ${String(idx)}` }),
    );
    const context = contextWithHistory(
      tickerCommand,
      historicalContextWith([
        tickerRun(
          "run-recent",
          "AAPL",
          [missSummary("recent", { claim: "recent claim" })],
          "2026-05-25T00:00:00.000Z",
        ),
        tickerRun("run-old", "AAPL", olderMisses, "2026-04-01T00:00:00.000Z"),
      ]),
    );

    const block = priorThesisErrorsFor(tickerCommand, context) ?? "";
    const bulletCount = block.split("\n").filter((line) => line.trim().startsWith("- run")).length;

    expect(bulletCount).toBe(5);
    expect(block).toContain("recent claim");
  });

  test("omits the block when no prior predictions on the instrument resolved as misses", () => {
    const context = contextWithHistory(
      tickerCommand,
      historicalContextWith([
        tickerRun("run-aapl-1", "AAPL", [missSummary("p1", { scoreOutcome: "hit" })]),
      ]),
    );

    expect(priorThesisErrorsFor(tickerCommand, context)).toBeUndefined();
  });

  test("excludes misses from a different instrument", () => {
    const context = contextWithHistory(
      tickerCommand,
      historicalContextWith([
        tickerRun("run-msft", "MSFT", [
          missSummary("p-msft", { claim: "MSFT closes higher", subject: "MSFT" }),
        ]),
      ]),
    );

    expect(priorThesisErrorsFor(tickerCommand, context)).toBeUndefined();
  });

  test("does not surface an instrument error block for market-update (daily) runs", () => {
    const dailyCommand: ResearchCommand = {
      jobType: "daily",
      assetClass: "equity",
      depth: "brief",
    };
    const context = contextWithHistory(
      dailyCommand,
      historicalContextWith([tickerRun("run-aapl-1", "AAPL", [missSummary("p1")])]),
    );

    expect(priorThesisErrorsFor(dailyCommand, context)).toBeUndefined();
  });
});

describe("buildPlaybookSelectionPrompt", () => {
  test("uses slim selector context", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const prompt = buildPlaybookSelectionPrompt(
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [{ source: "marketaux", message: "missing token" }],
      }),
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          minimumPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "mixed",
          proxyCount: 1,
          drivers: ["SPY higher"],
          sourceIds: ["market-aapl"],
        },
        calibrationContext: undefined,
      },
      { system: "Select.", instruction: "Choose playbooks.", goal: "Keep prompts focused." },
      ["specialist-analysis", "critique", "final-synthesis"],
      [
        {
          id: "market-regime",
          title: "Market Regime",
          summary: "Regime context.",
          eligibleStages: ["specialist-analysis", "critique"],
        },
      ],
    );
    const parsed = JSON.parse(prompt) as {
      readonly stage?: string;
      readonly plannedStages?: readonly string[];
      readonly candidates?: readonly unknown[];
      readonly marketRegime?: { readonly label?: string; readonly drivers?: readonly string[] };
      readonly evidenceCategories?: readonly string[];
      readonly sourceGaps?: readonly string[];
      readonly evidence?: unknown;
      readonly priorStages?: unknown;
    };

    expect(parsed.stage).toBe("playbook-selection");
    expect(parsed.plannedStages).toEqual(["specialist-analysis", "critique", "final-synthesis"]);
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.marketRegime).toEqual({ label: "mixed" });
    expect(parsed.evidenceCategories).toEqual(["market-data", "news"]);
    expect(parsed.sourceGaps).toEqual(["marketaux: missing token"]);
    expect(parsed.evidence).toBeUndefined();
    expect(parsed.priorStages).toBeUndefined();
  });
});

describe("buildSpotlightSelectionPrompt", () => {
  test("uses candidate-only selector context", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const sources = collectedSources({
      rawSnapshots: [],
      marketSnapshots: [marketSnapshot()],
      newsSources: [newsSource()],
      sourceGaps: [],
    });
    const context = {
      depthProfile: buildDepthProfile(command, config),
      runParams: {
        quickModel: "quick-test",
        synthesisModel: "synthesis-test",
        analystStyle: "concise brief" as const,
        minimumKeyFindings: 3,
        minimumScenarios: 2,
        minimumPredictions: 2,
        defaultPredictionHorizon: 5,
        predictionSubjects: ["SPY"],
        focus: ["market regime", "movers"],
        modelParams: undefined,
      },
      marketRegime: {
        assetClass: "equity" as const,
        label: "mixed" as const,
        proxyCount: 1,
        drivers: ["SPY higher"],
        sourceIds: ["market-aapl"],
      },
      calibrationContext: undefined,
    };
    const prompt = buildSpotlightSelectionPrompt(
      command,
      sources,
      context,
      { system: "Select.", instruction: "Choose spotlights.", goal: "Keep focus." },
      buildSpotlightCandidates({ marketSnapshots: sources.marketSnapshots }),
      2,
    );
    const parsed = JSON.parse(prompt) as {
      readonly stage?: string;
      readonly selectionCap?: number;
      readonly candidates?: readonly { readonly symbol?: string; readonly sourceIds?: string[] }[];
      readonly evidence?: unknown;
      readonly requiredShape?: { readonly selections?: readonly unknown[] };
    };

    expect(parsed.stage).toBe("spotlight-selection");
    expect(parsed.selectionCap).toBe(2);
    expect(parsed.candidates?.[0]).toMatchObject({ symbol: "AAPL", sourceIds: ["market-aapl"] });
    expect(parsed.evidence).toBeUndefined();
    expect(parsed.requiredShape?.selections).toHaveLength(1);
  });
});
