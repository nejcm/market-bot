import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import type { ResearchCommand } from "../src/cli/args";
import {
  buildDepthProfile,
  buildPlaybookSelectionPrompt,
  buildStagePrompt,
} from "../src/research/research-context";
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
};

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
