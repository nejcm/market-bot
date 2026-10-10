import { describe, expect, test } from "bun:test";
import { legacyMarketOverviewCommand } from "./support/commands";
import type { ResearchCommand } from "../src/cli/args";
import { buildDepthProfile } from "../src/research/depth-profile";
import { buildCalibrationSummary } from "../src/scoring/calibration";
import { REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT } from "../src/sources/extended-evidence/valuation-comps";
import { collectedSources, marketSnapshot, newsSource } from "./support/fixtures";
import {
  config,
  equityFinalSynthesisPrompt,
  equityRequiredShapeKinds,
  resolvedPair,
  stagePromptFromArgs,
} from "./support/research-context-helpers";

describe("buildStagePrompt final-synthesis shape", () => {
  test("final-synthesis shape omits model-authored prediction claims", () => {
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
          quickModelParams: undefined,
          synthesisModelParams: undefined,
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
      { system: "Research only.", instruction: "Synthesize.", goal: "Final report." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly instruction?: string;
      readonly requiredShape?: Record<string, unknown> & {
        readonly predictions?: readonly Record<string, unknown>[];
      };
    };

    expect(parsed.instruction).toContain("Do not write a claim field");
    expect(parsed.instruction).toContain(
      "Every prediction must have probability outside the inclusive 0.40-0.60 near-base-rate band",
    );
    expect(parsed.instruction).not.toContain("never emit a coin-flip");
    expect(parsed.instruction).toContain("probability is the probability that the measurableAs");
    expect(parsed.requiredShape?.predictions?.[0]).not.toHaveProperty("claim");
    expect(parsed.requiredShape).not.toHaveProperty("confidence");
    expect(parsed.requiredShape?.extras).not.toHaveProperty("spotlights");
  });

  test("final-synthesis shape carries one exemplar prediction regardless of target count", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const baseDepthProfile = buildDepthProfile(command, config);
    const prompt = stagePromptFromArgs(
      "final-synthesis",
      command,
      collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
        newsSources: [newsSource()],
      }),
      config,
      {
        // A high target count must not inflate the schema example array — the count
        // Is a soft target carried by the instruction, not by exemplar length.
        depthProfile: { ...baseDepthProfile, targetPredictions: 8 },
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "fuller analyst-style",
          minimumKeyFindings: 6,
          minimumScenarios: 3,
          targetPredictions: 8,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["AAPL"],
          focus: ["thesis"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 2 },
          quickModelParams: undefined,
          synthesisModelParams: undefined,
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
      readonly instruction?: string;
      readonly requiredShape?: { readonly predictions?: readonly { readonly id?: string }[] };
    };

    expect(parsed.requiredShape?.predictions).toHaveLength(1);
    expect(parsed.requiredShape?.predictions?.[0]?.id).toBe("pred-1");
    // The soft target count still reaches the model through the instruction text.
    expect(parsed.instruction).toContain("Emit up to 8 predictions");
  });

  test("final-synthesis evidence carries the not-meaningful revenue-multiple caveat", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "ASTS",
      depth: "deep",
    };
    const depthProfile = buildDepthProfile(command, config);
    const prompt = stagePromptFromArgs(
      "final-synthesis",
      command,
      collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "ASTS" })],
        newsSources: [newsSource()],
        extendedEvidence: {
          instrument: { symbol: "ASTS", assetClass: "equity" },
          items: [
            {
              category: "valuation",
              title: "ASTS Valuation Evidence",
              summary: REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
              sourceIds: ["market-aapl"],
              observedAt: "2026-07-01T00:00:00.000Z",
              metrics: {
                valuationSupportability: "not-meaningful",
                valuationCaveat: REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
              },
            },
          ],
          gaps: [],
        },
      }),
      config,
      {
        depthProfile,
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "fuller analyst-style",
          minimumKeyFindings: 6,
          minimumScenarios: 3,
          targetPredictions: depthProfile.targetPredictions,
          defaultPredictionHorizon: depthProfile.defaultPredictionHorizon,
          predictionSubjects: depthProfile.predictionSubjects,
          focus: depthProfile.focus,
          targetKindMix: depthProfile.targetKindMix,
          quickModelParams: undefined,
          synthesisModelParams: undefined,
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
      readonly evidence?: {
        readonly extendedEvidence?: {
          readonly items?: readonly {
            readonly summary?: string;
            readonly metrics?: Readonly<Record<string, unknown>>;
          }[];
        };
      };
    };
    const valuation = parsed.evidence?.extendedEvidence?.items?.[0];

    expect(valuation?.summary).toBe(REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT);
    expect(valuation?.metrics?.valuationSupportability).toBe("not-meaningful");
    expect(valuation?.metrics?.valuationCaveat).toBe(REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT);
  });

  test("crypto final-synthesis prompt omits equity-only IV and VIX prediction shapes", () => {
    const command: ResearchCommand = {
      jobType: "crypto",
      assetClass: "crypto",
      symbol: "BTC",
      depth: "deep",
    };
    const prompt = stagePromptFromArgs(
      "final-synthesis",
      command,
      collectedSources({
        marketSnapshots: [marketSnapshot({ assetClass: "crypto", symbol: "BTC" })],
        newsSources: [newsSource({ assetClass: "crypto" })],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "fuller analyst-style",
          minimumKeyFindings: 6,
          minimumScenarios: 3,
          targetPredictions: 5,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["BTC"],
          focus: ["thesis"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 2 },
          quickModelParams: undefined,
          synthesisModelParams: undefined,
        },
        marketRegime: {
          assetClass: "crypto",
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
      readonly instruction?: string;
      readonly requiredShape?: {
        readonly predictions?: readonly { readonly kind?: string }[];
      };
    };

    expect(parsed.instruction).not.toContain("^VIX");
    expect(parsed.instruction).not.toContain("iv(SUBJECT");
    const kinds = parsed.requiredShape?.predictions?.[0]?.kind?.split("|") ?? [];
    expect(kinds).not.toContain("iv");
    expect(kinds).not.toContain("volatility");
  });

  const optionsIvEvidence: Partial<Parameters<typeof collectedSources>[0]> = {
    extendedEvidence: {
      instrument: { symbol: "AAPL", assetClass: "equity" },
      items: [
        {
          category: "options-iv",
          title: "AAPL options IV",
          summary: "Near-term IV is elevated.",
          sourceIds: ["tradier-aapl-options"],
          observedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      gaps: [],
    },
  };

  test("equity final-synthesis shape omits volatility and iv without ^VIX or options-iv evidence", () => {
    const kinds = equityRequiredShapeKinds({ predictionSubjects: ["AAPL"] });

    expect(kinds).not.toContain("volatility");
    expect(kinds).not.toContain("iv");
    // Ungated kinds still appear, so the shape is not simply empty.
    expect(kinds).toContain("direction");
    expect(kinds).toContain("relative");
    expect(kinds).toContain("range");
  });

  test("equity final-synthesis gates macro on an allowed FRED subject", () => {
    const equityOnly = equityFinalSynthesisPrompt({ predictionSubjects: ["AAPL"] });
    expect(equityRequiredShapeKinds({ predictionSubjects: ["AAPL"] })).not.toContain("macro");
    expect(JSON.parse(equityOnly).instruction).not.toContain("fred(");
    expect(equityOnly).not.toContain("macro");

    const withFred = equityFinalSynthesisPrompt({ predictionSubjects: ["AAPL", "DGS10"] });
    expect(equityRequiredShapeKinds({ predictionSubjects: ["AAPL", "DGS10"] })).toContain("macro");
    expect(JSON.parse(withFred).instruction).toContain(
      "fred(SERIES, +N) > fred(SERIES, 0) for macro",
    );
  });

  test("equity final-synthesis shape advertises volatility only when ^VIX is an allowed subject", () => {
    expect(equityRequiredShapeKinds({ predictionSubjects: ["AAPL"] })).not.toContain("volatility");

    const withVix = equityRequiredShapeKinds({ predictionSubjects: ["AAPL", "^VIX"] });
    expect(withVix).toContain("volatility");
    // ^VIX gates volatility, not iv — no options-iv evidence here.
    expect(withVix).not.toContain("iv");
  });

  test("equity final-synthesis shape advertises iv only with citeable options-iv evidence", () => {
    expect(equityRequiredShapeKinds({ predictionSubjects: ["AAPL"] })).not.toContain("iv");

    const withIv = equityRequiredShapeKinds({
      predictionSubjects: ["AAPL"],
      sources: optionsIvEvidence,
    });
    expect(withIv).toContain("iv");
    // Options-iv evidence gates iv, not volatility — ^VIX is not an allowed subject here.
    expect(withIv).not.toContain("volatility");
  });

  test("equity final-synthesis shape omits iv when options-iv evidence carries no sourceId", () => {
    const kinds = equityRequiredShapeKinds({
      predictionSubjects: ["AAPL"],
      sources: {
        extendedEvidence: {
          instrument: { symbol: "AAPL", assetClass: "equity" },
          items: [
            {
              category: "options-iv",
              title: "AAPL options IV",
              summary: "Near-term IV is elevated.",
              sourceIds: [],
              observedAt: "2026-06-01T00:00:00.000Z",
            },
          ],
          gaps: [],
        },
      },
    });

    expect(kinds).not.toContain("iv");
  });

  test("equity final-synthesis shape gates conditional on deep depth", () => {
    expect(equityRequiredShapeKinds({ predictionSubjects: ["AAPL"], depth: "deep" })).toContain(
      "conditional",
    );
    expect(
      equityRequiredShapeKinds({ predictionSubjects: ["AAPL"], depth: "brief" }),
    ).not.toContain("conditional");
  });

  test("final-synthesis shape includes business framework extras when sidecar exists", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const prompt = stagePromptFromArgs(
      "final-synthesis",
      command,
      collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
        newsSources: [newsSource()],
        businessFramework: {
          version: 1,
          generatedAt: "2026-06-01T00:00:00.000Z",
          symbol: "AAPL",
          phase: "capital-return",
          sections: [],
          sourceIds: [],
          gaps: [],
        },
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
          predictionSubjects: ["AAPL"],
          focus: ["ticker research"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
          quickModelParams: undefined,
          synthesisModelParams: undefined,
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
      { system: "Research only.", instruction: "Synthesize.", goal: "Final report." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly instruction?: string;
      readonly requiredShape?: {
        readonly extras?: {
          readonly businessFramework?: {
            readonly sections?: readonly Record<string, unknown>[];
          };
        };
      };
    };

    expect(parsed.instruction).toContain("deterministic Business Framework");
    expect(parsed.requiredShape?.extras?.businessFramework?.sections?.[0]).toEqual({
      name: "Business|Phase|Moat|Growth|Management|Risk|Valuation",
      text: "string",
      sourceIds: ["source-id"],
    });
  });

  test("keeps legacy CalibrationSummary JSON readable but non-actionable", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
    const summary = buildCalibrationSummary([
      resolvedPair("pred-1", 0.65, "hit"),
      resolvedPair("pred-2", 0.65, "miss"),
    ]);
    // StructuredClone strips type identity to mimic a CalibrationSummary loaded from summary.json.
    const calibrationContext = structuredClone(summary) as never;

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
          quickModelParams: undefined,
          synthesisModelParams: undefined,
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

    expect(block).toBeUndefined();
  });
});
