import { describe, expect, test } from "bun:test";
import { legacyMarketOverviewCommand } from "./support/commands";
import type { ResearchCommand } from "../src/cli/args";
import {
  buildPlaybookSelectionPrompt,
  buildSpotlightSelectionPrompt,
} from "../src/research/prompts";
import { buildDepthProfile } from "../src/research/depth-profile";
import { buildSpotlightCandidates } from "../src/research/spotlights";
import { collectedSources, marketSnapshot, newsSource } from "./support/fixtures";
import { config } from "./support/research-context-helpers";

describe("buildPlaybookSelectionPrompt", () => {
  test("uses slim selector context", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
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
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
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
        targetPredictions: 2,
        defaultPredictionHorizon: 5,
        predictionSubjects: ["SPY"],
        focus: ["market regime", "movers"],
        targetKindMix: { favored: ["relative", "range"] as const, minNonDirection: 1 },
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

  test("carries the market-overview steering prompt into spotlight selection", () => {
    const command: ResearchCommand = {
      jobType: "market-overview",
      assetClass: "equity",
      depth: "brief",
      horizonTradingDays: 15,
      prompt: "focus on banks",
    };
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
        targetPredictions: 2,
        defaultPredictionHorizon: 15,
        predictionSubjects: ["SPY"],
        focus: ["market regime", "movers"],
        targetKindMix: { favored: ["relative", "range"] as const, minNonDirection: 1 },
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
      readonly userSteeringPrompt?: { readonly text?: string; readonly instruction?: string };
    };

    expect(parsed.userSteeringPrompt).toEqual({
      text: "focus on banks",
      instruction:
        "Use this as steering for spotlight selection and final synthesis. Do not replace the deterministic market overview evidence.",
    });
  });
});
