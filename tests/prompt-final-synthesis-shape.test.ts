import { describe, expect, test } from "bun:test";
import { legacyMarketOverviewCommand } from "./support/commands";
import type { ResearchCommand } from "../src/cli/args";
import { buildDepthProfile } from "../src/research/depth-profile";
import { buildCalibrationSummary } from "../src/scoring/calibration";
import type { Prediction } from "../src/domain/types";
import { REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT } from "../src/sources/extended-evidence/valuation-comps";
import { collectedSources, marketSnapshot, newsSource, researchReport } from "./support/fixtures";
import {
  completionInstruction,
  config,
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
          modelParams: undefined,
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
    expect(kinds).toContain("macro");
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

    expect(block).toBeUndefined();
  });

  test("surfaces only qualifying applicable calibration slices during completion", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
    const calibrationContext = {
      brierScore: 0.9,
      resolvedCount: 100,
      byKind: { direction: { brierScore: 0.9, count: 100 } },
      byAssetClass: {
        equity: {
          brierScore: 0.4,
          count: 30,
          runCount: 10,
          brierStandardError: 0.05,
        },
      },
      byHorizonBucket: {
        "1-5d": {
          brierScore: 0.3,
          count: 30,
          runCount: 10,
          brierStandardError: 0.03,
        },
      },
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
        calibrationContext,
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
      [],
      [],
      [],
      [],
      { requestedCount: 1, existingPredictions: [], reportDraft: researchReport() },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: { readonly priorCalibration?: string };
      readonly predictionCompletion?: unknown;
    };
    const block = parsed.evidence?.priorCalibration;

    expect(block).toBeDefined();
    expect(block).toContain("asset class equity");
    expect(block).not.toContain("Overall");
    expect(block).not.toContain("direction");
    expect(block).not.toContain("default horizon 1-5d");
    expect(block).toContain("only to discipline probability confidence");
    expect(parsed.predictionCompletion).toBeDefined();
  });

  test("steers completion toward uncovered kinds and reports covered exact horizons", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "deep",
    });
    const existingPrediction = {
      id: "pred-1",
      claim: "SPY closes higher than today over 5 trading days",
      kind: "direction" as const,
      subject: "SPY",
      measurableAs: "close(SPY, +5) > close(SPY, 0)",
      horizonTradingDays: 5,
      probability: 0.6,
      sourceIds: ["market-spy"],
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
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
      [],
      [],
      [],
      ["market-spy"],
      {
        requestedCount: 2,
        existingPredictions: [existingPrediction],
        reportDraft: researchReport(),
      },
    );
    const parsed = JSON.parse(prompt) as { readonly instruction: string };

    expect(parsed.instruction).toContain("covered kinds: direction");
    // `iv` is gated out — this run carries no citeable options-iv evidence — while `volatility`
    // Stays because ^VIX is an allowed subject in the market-overview depth profile.
    expect(parsed.instruction).toContain(
      "supported kinds not yet represented: relative, volatility, range, macro, conditional",
    );
    expect(parsed.instruction).toContain("covered exact horizons: 5d");
    expect(parsed.instruction).toContain(
      "Use a different exact horizon only when evidence supports that horizon",
    );
    // Allowed-subject + benchmark-equivalence steering names the enforced semantics so the
    // Completion pass stops proposing disallowed subjects and broad-index redundancies.
    expect(parsed.instruction).toContain("Allowed prediction subjects for this run:");
    expect(parsed.instruction).toContain(
      "the primary (pre-colon) symbol must be one of these allowed subjects",
    );
    expect(parsed.instruction).toContain(
      "Relative forecasts against any of SPY, QQQ, DIA, IVV, VOO share the broad-us-index class",
    );
    // The one existing prediction is a bare `direction` call, so no broad-index slot is occupied.
    expect(parsed.instruction).not.toContain("already occupy these broad-us-index slots");
  });

  test("completion names occupied broad-us-index slots from existing relative predictions", () => {
    const existing: Prediction = {
      id: "pred-1",
      claim: "AAPL outperforms SPY over 5 trading days",
      kind: "relative",
      subject: "AAPL:SPY",
      measurableAs: "close(AAPL, +5)/close(AAPL, 0) > close(SPY, +5)/close(SPY, 0)",
      horizonTradingDays: 5,
      probability: 0.6,
      sourceIds: ["market-aapl"],
    };
    const instruction = completionInstruction({
      predictionSubjects: ["AAPL"],
      existingPredictions: [existing],
    });

    expect(instruction).toContain(
      "Existing predictions already occupy these broad-us-index slots: AAPL relative @ 5d (broad-us-index)",
    );
  });

  test("completion gates the volatility/^VIX shape on ^VIX being an allowed subject", () => {
    const withoutVix = completionInstruction({ predictionSubjects: ["AAPL"] });
    expect(withoutVix).not.toContain("^VIX");
    expect(withoutVix).not.toContain("volatility");

    const withVix = completionInstruction({ predictionSubjects: ["AAPL", "^VIX"] });
    expect(withVix).toContain("max(close(^VIX), 0..+N) > T for volatility");
    expect(withVix).toContain("volatility");
  });

  test("completion gates the iv shape on citeable options-iv evidence", () => {
    const withoutIv = completionInstruction({ predictionSubjects: ["AAPL"] });
    expect(withoutIv).not.toContain("iv(SUBJECT");

    const withIv = completionInstruction({
      predictionSubjects: ["AAPL"],
      sources: {
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
      },
    });
    expect(withIv).toContain("iv(SUBJECT, +N) > T for IV");
  });

  test("completion omits the iv shape when options-iv evidence carries no sourceId", () => {
    const instruction = completionInstruction({
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
    expect(instruction).not.toContain("iv(SUBJECT");
  });

  test("completion pairs advertised earnings and conditional kinds with their measurableAs grammar", () => {
    // Run-review finding #3: completion advertised earnings-direction/earnings-move and conditional
    // As supported kinds via coverage guidance but only showed the plain direction close() grammar,
    // So the model emitted an advertised earnings kind with close() and the validator rejected the
    // Kind/measurableAs mismatch. The completion pass must now show each advertised kind's grammar.
    const instruction = completionInstruction({
      predictionSubjects: ["AAPL"],
      sources: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-30",
            timing: "amc",
            sourceIds: ["earnings-aapl"],
            fetchedAt: "2026-06-01T00:00:00.000Z",
          },
          gaps: [],
        },
      },
    });

    expect(instruction).toContain(
      "kind earnings-direction with measurableAs earningsReturn(SUBJECT, YYYY-MM-DD, +N) > 0",
    );
    expect(instruction).toContain(
      "kind earnings-move with measurableAs abs(earningsReturn(SUBJECT, YYYY-MM-DD, +N)) > T",
    );
    expect(instruction).toContain(
      "kind conditional with measurableAs syntax if (<existing expression>) then (<existing expression>)",
    );
  });

  test("completion omits earnings grammar when no earnings event is in scope", () => {
    const instruction = completionInstruction({ predictionSubjects: ["AAPL"] });
    expect(instruction).not.toContain("earningsReturn(SUBJECT");
  });

  test("brief completion neither advertises nor explains the conditional kind", () => {
    // Conditional is a deep-only kind. supportedPredictionKinds gates it on depth === "deep" and
    // BuildCompletionKindGrammar must gate its grammar identically; a brief run must not advertise
    // Conditional in coverage guidance nor show its grammar. Guards against gate drift between the
    // Two so a brief run never nudges a kind it cannot validate.
    const instruction = completionInstruction({ predictionSubjects: ["AAPL"], depth: "brief" });
    expect(instruction).not.toContain("conditional");
    expect(instruction).not.toContain("if (<existing expression>) then (<existing expression>)");
  });
});
