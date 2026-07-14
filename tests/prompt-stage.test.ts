import { describe, expect, test } from "bun:test";
import { legacyMarketOverviewCommand } from "./support/commands";
import type { ResearchCommand } from "../src/cli/args";
import { buildDepthProfile } from "../src/research/depth-profile";
import { collectedSources, marketSnapshot, newsSource } from "./support/fixtures";
import {
  config,
  contextWithHistory,
  stagePromptFromArgs,
} from "./support/research-context-helpers";

describe("buildStagePrompt", () => {
  test("includes mover feature breakdown in evidence payload", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
    const prompt = stagePromptFromArgs(
      "final-synthesis",
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
        analysisAsOf: "2026-06-01T00:00:00.000Z",
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
          focus: ["market regime", "movers"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
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
        readonly analysisAsOf?: string;
        readonly movers?: readonly {
          readonly features?: {
            readonly unusualVolumeRatio?: number;
            readonly gapPercent?: number;
            readonly reasons?: readonly string[];
          };
        }[];
      };
    };

    expect(parsed.evidence?.analysisAsOf).toBe("2026-06-01T00:00:00.000Z");
    expect(parsed.evidence?.movers?.[0]?.features?.unusualVolumeRatio).toBe(2);
    expect(parsed.evidence?.movers?.[0]?.features?.gapPercent).toBe(5);
    expect(parsed.evidence?.movers?.[0]?.features?.reasons).toContain("5% absolute 24h move");
    expect(parsed.evidence?.movers?.[0]?.features?.reasons).toContain("log10 volume 6");
    expect(parsed.evidence?.movers?.[0]?.features?.reasons).toContain("volume 2x average");
    expect(parsed.evidence?.movers?.[0]?.features?.reasons).toContain("5% absolute opening gap");
  });

  test("uses the non-final required shape for coverage panel stages", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "deep",
    });
    const prompt = stagePromptFromArgs(
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
          targetPredictions: 3,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers", "cross-asset themes", "risks", "source gaps"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
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
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
    const prompt = stagePromptFromArgs(
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
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
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
      },
      { system: "Research only.", instruction: "Synthesize.", goal: "Final report." },
      [],
      ["predictionShortfall: required 2, received 1"],
    );
    const parsed = JSON.parse(prompt) as {
      readonly predictionRepair?: {
        readonly instruction?: string;
      };
      readonly predictionRepromptErrors?: readonly string[];
    };

    expect(parsed.predictionRepromptErrors).toEqual([
      "predictionShortfall: required 2, received 1",
    ]);
    expect(parsed.predictionRepair).toEqual({
      instruction: expect.stringContaining(
        "Return a complete final report with a valid predictions array, fixing the flagged predictions.",
      ),
    });
    expect(parsed.predictionRepair?.instruction).toContain(
      "Prefer replacement forecasts using these subjects: SPY",
    );
    expect(parsed.predictionRepair?.instruction).toContain(
      "favor these kinds when supported: relative, macro, volatility",
    );
    expect(parsed.predictionRepair?.instruction).toContain(
      "For ticker relative forecasts, use subject form TICKER:BENCHMARK.",
    );
    // Repair handles the same disallowed-subject / broad-index-redundancy rejection classes as the
    // Completion pass, so it carries the same allowed-subject + benchmark-equivalence steering.
    expect(parsed.predictionRepair?.instruction).toContain(
      "Allowed prediction subjects for this run:",
    );
    expect(parsed.predictionRepair?.instruction).toContain(
      "Relative forecasts against any of SPY, QQQ, DIA, IVV, VOO share the broad-us-index class",
    );
    expect(parsed.predictionRepair?.instruction).toContain(
      "For range forecasts, vary the horizon or range bounds",
    );
    expect(parsed.predictionRepair?.instruction).toContain("at least 2 trading days apart");
  });

  test("threads redundancy-rejection reasons into the final-synthesis retry prompt", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
    const redundancyReason =
      "Prediction pred-2: redundant direction forecast for AAPL at 6 trading days (within 2 trading days of accepted 5d)";
    const prompt = stagePromptFromArgs(
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
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
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
      },
      { system: "Research only.", instruction: "Synthesize.", goal: "Final report." },
      [],
      [redundancyReason, "predictionShortfall: required 2, received 1"],
    );
    const parsed = JSON.parse(prompt) as {
      readonly predictionRepromptErrors?: readonly string[];
    };

    expect(parsed.predictionRepromptErrors).toEqual([
      redundancyReason,
      "predictionShortfall: required 2, received 1",
    ]);
  });

  test("injects statistically actionable current-regime calibration", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
    const prompt = stagePromptFromArgs(
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
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
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
        calibrationContext: {
          byMarketRegime: {
            mixed: {
              brierScore: 0.4,
              count: 30,
              runCount: 10,
              brierStandardError: 0.05,
            },
          },
        },
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: { readonly priorCalibration?: string };
    };

    expect(parsed.evidence?.priorCalibration).toContain("current regime mixed");
    expect(parsed.evidence?.priorCalibration).toContain("n=30");
    expect(parsed.evidence?.priorCalibration).toContain("must not suppress prediction count");
    expect(parsed.evidence?.priorCalibration).not.toContain("trim");
    expect(parsed.evidence?.priorCalibration).not.toContain("retry");
  });

  test("omits statistically inconclusive current-regime calibration", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
    const prompt = stagePromptFromArgs(
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
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
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
        calibrationContext: {
          byMarketRegime: {
            mixed: {
              brierScore: 0.3,
              count: 30,
              runCount: 10,
              brierStandardError: 0.03,
            },
          },
        },
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: { readonly priorCalibration?: string };
    };

    expect(parsed.evidence?.priorCalibration).toBeUndefined();
  });

  test("injects domain playbooks as a separate prompt field", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
    const prompt = stagePromptFromArgs(
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
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
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

  test("adds citation guidance that reserves history reports for narrative context", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
    const prompt = stagePromptFromArgs(
      "specialist-analysis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      contextWithHistory(command),
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: { readonly deterministicCitationGuidance?: string };
    };

    expect(parsed.evidence?.deterministicCitationGuidance).toContain("exact numeric market claims");
    expect(parsed.evidence?.deterministicCitationGuidance).toContain("history-report-*");
  });

  test("adds warn-only post-synthesis audit guidance to final synthesis", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "brief",
    };
    const prompt = stagePromptFromArgs(
      "final-synthesis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      contextWithHistory(command),
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
      [],
      [],
      [],
      ["market-aapl", "news-equity-1"],
    );
    const parsed = JSON.parse(prompt) as {
      readonly postSynthesisAuditGuidance?: {
        readonly status?: string;
        readonly unsupportedNumericClaims?: string;
        readonly requiredPostureLabels?: string;
      };
    };

    expect(parsed.postSynthesisAuditGuidance?.status).toContain("warning-only");
    expect(parsed.postSynthesisAuditGuidance?.unsupportedNumericClaims).toContain(
      "history-only numeric or technical claims",
    );
    expect(parsed.postSynthesisAuditGuidance?.requiredPostureLabels).toContain(
      "observed fact, issuer claim, derived calculation, model inference, assumption, stale evidence, conflicting evidence, missing required source, prior forecast outcome, historical forecast outcome",
    );
  });

  test("injects market-overview prompt as steering evidence only", () => {
    const command: ResearchCommand = {
      jobType: "market-overview",
      assetClass: "equity",
      depth: "brief",
      horizonTradingDays: 7,
      prompt: "focus on banks",
    };
    const prompt = stagePromptFromArgs(
      "final-synthesis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      contextWithHistory(command),
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: {
        readonly userSteeringPrompt?: { readonly text?: string; readonly instruction?: string };
      };
    };

    expect(parsed.evidence?.userSteeringPrompt).toEqual({
      text: "focus on banks",
      instruction:
        "Use this as steering for spotlight selection and final synthesis. Do not replace the deterministic market overview evidence.",
    });
  });
});
