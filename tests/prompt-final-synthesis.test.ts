import { describe, expect, test } from "bun:test";
import { legacyMarketOverviewCommand } from "./support/commands";
import type { ResearchCommand } from "../src/cli/args";
import { buildStagePrompt, type StageInput } from "../src/research/prompts";
import { buildDepthProfile } from "../src/research/depth-profile";
import type { ResearchContext } from "../src/research/research-context-types";
import type { Prediction } from "../src/domain/types";
import {
  collectedSources,
  marketSnapshot,
  newsSource,
  prediction,
  researchReport,
} from "./support/fixtures";
import { config, stagePromptFromArgs } from "./support/research-context-helpers";

function kindMixSynthesisInstruction(command: ResearchCommand): string {
  const depthProfile = buildDepthProfile(command, config);
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
      depthProfile,
      runParams: {
        quickModel: "quick-test",
        synthesisModel: "synthesis-test",
        analystStyle: "concise brief",
        minimumKeyFindings: 3,
        minimumScenarios: 2,
        targetPredictions: depthProfile.targetPredictions,
        defaultPredictionHorizon: depthProfile.defaultPredictionHorizon,
        predictionSubjects: depthProfile.predictionSubjects,
        focus: depthProfile.focus,
        targetKindMix: depthProfile.targetKindMix,
        modelParams: undefined,
      },
      marketRegime: {
        assetClass: command.assetClass,
        label: "mixed",
        proxyCount: 1,
        drivers: [],
        sourceIds: [],
      },
      calibrationContext: undefined,
    },
    { system: "Research only.", instruction: "Synthesize.", goal: "Final report." },
  );
  const parsed = JSON.parse(prompt) as { readonly instruction?: string };
  return parsed.instruction ?? "";
}

describe("buildStagePrompt prediction kind-mix guidance (#10)", () => {
  test("daily-equity (market-update) instruction favors relative/macro/volatility over bare direction", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
    const instruction = kindMixSynthesisInstruction(command);

    expect(instruction).toContain(
      "Favor more informative forecast kinds in this priority order where the evidence supports them: relative, macro, volatility.",
    );
    expect(instruction).toContain("Use bare `direction` only when no better-measured kind fits");
    expect(instruction).toContain(
      "Favoring a kind reflects measurement quality, not conviction: a better-measured kind still earns its place only when its probability moves off 0.5",
    );
    expect(instruction).toContain(
      "Aim for at least 1 prediction(s) using a kind other than `direction`",
    );
  });

  test("ticker instruction favors its own mix (relative, range)", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "brief",
    };
    const instruction = kindMixSynthesisInstruction(command);

    expect(instruction).toContain(
      "Favor more informative forecast kinds in this priority order where the evidence supports them: relative, range.",
    );
  });

  test("daily-crypto instruction favors relative/range and never advertises macro or iv", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "crypto",
      depth: "brief",
    });
    const instruction = kindMixSynthesisInstruction(command);

    expect(instruction).toContain(
      "Favor more informative forecast kinds in this priority order where the evidence supports them: relative, range.",
    );
    // Crypto has no point forecasts (macro/iv are equity-only — see src/scoring/observations.ts),
    // So the favored-kind guidance must not steer the model toward kinds it cannot fulfill.
    const guidanceStart = instruction.indexOf("Favor more informative forecast kinds");
    const favoredClause = instruction.slice(guidanceStart, instruction.indexOf(".", guidanceStart));
    const favoredKinds = favoredClause
      .slice(favoredClause.indexOf(":") + 1)
      .split(",")
      .map((kind) => kind.trim());
    expect(favoredKinds).not.toContain("macro");
    expect(favoredKinds).not.toContain("iv");
  });

  test("deep daily-equity raises the non-direction floor over the brief profile", () => {
    const briefCommand: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
    const deepCommand: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "deep",
    });

    const briefInstruction = kindMixSynthesisInstruction(briefCommand);
    const deepInstruction = kindMixSynthesisInstruction(deepCommand);

    expect(briefInstruction).toContain("Aim for at least 1 prediction(s)");
    expect(deepInstruction).toContain("Aim for at least 2 prediction(s)");
  });
});

function finalSynthesisInstruction(
  command: ResearchCommand,
  sources: Partial<Parameters<typeof collectedSources>[0]> = {},
): string {
  const depthProfile = buildDepthProfile(command, config);
  const prompt = stagePromptFromArgs(
    "final-synthesis",
    command,
    collectedSources({
      marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
      newsSources: [newsSource()],
      ...sources,
    }),
    config,
    {
      depthProfile,
      runParams: {
        quickModel: "quick-test",
        synthesisModel: "synthesis-test",
        analystStyle: "concise brief",
        minimumKeyFindings: 3,
        minimumScenarios: 2,
        targetPredictions: depthProfile.targetPredictions,
        defaultPredictionHorizon: depthProfile.defaultPredictionHorizon,
        predictionSubjects: depthProfile.predictionSubjects,
        focus: depthProfile.focus,
        targetKindMix: depthProfile.targetKindMix,
        modelParams: undefined,
      },
      marketRegime: {
        assetClass: command.assetClass,
        label: "mixed",
        proxyCount: 1,
        drivers: [],
        sourceIds: [],
      },
      calibrationContext: undefined,
    },
    { system: "Research only.", instruction: "Synthesize.", goal: "Final report." },
  );
  const parsed = JSON.parse(prompt) as { readonly instruction?: string };
  return parsed.instruction ?? "";
}

describe("buildStagePrompt forecast diversity guidance", () => {
  test("deep instrument runs include forecast-shape diversity guidance", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const instruction = finalSynthesisInstruction(command);

    expect(instruction).toContain(
      "consider whether the available evidence supports distinct forecast shapes",
    );
    expect(instruction).toContain("direction (close up/down)");
    expect(instruction).toContain("relative (vs benchmark)");
    expect(instruction).toContain("range (outside [Lo, Hi])");
    expect(instruction).toContain("conditional");
    expect(instruction).toContain("soft target");
    // Distinguishes informative kind from informative probability: a better-measured
    // Kind near 0.5 against correlated benchmarks is not automatically informative.
    expect(instruction).toContain("informative only when its probability departs from 0.5");
    expect(instruction).toContain("restate one view rather than adding independent signal");
    // Guidance only — no post-emission rejection/trim/retry vocabulary is introduced.
    expect(instruction).not.toContain("reject");
    expect(instruction).not.toContain("trim");
    expect(instruction).not.toContain("retry");
  });

  test("brief instrument runs do not include forecast diversity guidance", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "brief",
    };
    const instruction = finalSynthesisInstruction(command);

    expect(instruction).not.toContain(
      "consider whether the available evidence supports distinct forecast shapes",
    );
  });

  test("market-overview runs do not include forecast diversity guidance", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "deep",
    });
    const instruction = finalSynthesisInstruction(command);

    expect(instruction).not.toContain(
      "consider whether the available evidence supports distinct forecast shapes",
    );
  });

  test("market-overview coverage excludes instrument-only earnings kinds", () => {
    const command: ResearchCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "deep",
    });
    const instruction = finalSynthesisInstruction(command, {
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
    });

    expect(instruction).not.toContain("earnings-direction");
    expect(instruction).not.toContain("earnings-move");
  });

  test("includes earnings shapes when earningsSetup is present", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const instruction = finalSynthesisInstruction(command, {
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
    });

    expect(instruction).toContain("earnings-direction or earnings-move");
  });

  test("uses on-subject IV guidance instead of VIX volatility for instrument options evidence", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const instruction = finalSynthesisInstruction(command, {
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
    });

    expect(instruction).toContain("IV (iv(SUBJECT, +N) > T)");
    expect(instruction).not.toContain("volatility (VIX threshold)");
  });

  test("omits earnings shapes when no earningsSetup", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const instruction = finalSynthesisInstruction(command);

    expect(instruction).not.toContain("earnings-direction or earnings-move");
  });
});

// Run-review finding #1: the completion pass replayed the full evidence payload and prior-stage
// Transcript to add a prediction or two. It now receives a distilled context — report narrative +
// Critique + compact source index — while the primary synthesis prompt stays byte-for-byte the same.
describe("buildStagePrompt scoped prediction completion payload (#1)", () => {
  const command: ResearchCommand = {
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    depth: "deep",
  };
  const context: ResearchContext = {
    depthProfile: buildDepthProfile(command, config),
    runParams: {
      quickModel: "quick-test",
      synthesisModel: "synthesis-test",
      analystStyle: "fuller analyst-style",
      minimumKeyFindings: 5,
      minimumScenarios: 3,
      targetPredictions: 5,
      defaultPredictionHorizon: 5,
      predictionSubjects: ["AAPL"],
      focus: ["thesis"],
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
  };
  const sources = collectedSources({
    marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
    newsSources: [newsSource()],
  });
  const loaded = { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." };
  const allowedSourceIds = ["news-equity-1", "web-aapl-1", "market-aapl"];
  const priorStages = [
    { stage: "specialist-analysis", content: "SPECIALIST_TRANSCRIPT", tokenEstimate: 10 },
    { stage: "critique", content: "CRITIQUE_TRANSCRIPT", tokenEstimate: 5 },
  ];
  const reportDraft = researchReport({
    summary: "AAPL_DRAFT_SUMMARY",
    keyFindings: [{ text: "drafted finding", sourceIds: ["news-equity-1"] }],
    predictions: [prediction({ id: "pred-1", subject: "AAPL" })],
    sources: [
      newsSource(),
      newsSource({
        id: "web-aapl-1",
        kind: "web",
        title: "Fresh web piece",
        snippet: "web snippet",
        publisher: "Example Wire",
      }),
      newsSource({ id: "market-aapl", kind: "market-data", title: "AAPL quote", summary: "quote" }),
    ],
  });

  function buildPrompt(predictionCompletion?: {
    readonly requestedCount: number;
    readonly existingPredictions: readonly Prediction[];
    readonly reportDraft: typeof reportDraft;
  }): string {
    return stagePromptFromArgs(
      "final-synthesis",
      command,
      sources,
      config,
      context,
      loaded,
      priorStages,
      [],
      [],
      allowedSourceIds,
      predictionCompletion,
    );
  }

  test("distills the completion prompt to report draft, critique, and a compact source index", () => {
    const prompt = buildPrompt({
      requestedCount: 2,
      existingPredictions: reportDraft.predictions,
      reportDraft,
    });
    const parsed = JSON.parse(prompt) as {
      readonly evidence: {
        readonly sources?: readonly { readonly id: string; readonly snippet?: string }[];
        readonly webSources?: readonly {
          readonly id: string;
          readonly title: string;
          readonly fetchedAt: string;
          readonly snippet?: string;
          readonly publisher?: string;
        }[];
        readonly marketSnapshots?: unknown;
      };
      readonly priorStages: readonly { readonly stage: string; readonly content: string }[];
      readonly reportDraft?: { readonly summary?: string; readonly predictions?: unknown };
      readonly allowedSourceIds?: readonly string[];
      readonly predictionCompletion?: { readonly reportDraft?: unknown };
    };

    // Evidence is a compact source index, not the full payload.
    expect(parsed.evidence.marketSnapshots).toBeUndefined();
    expect(parsed.evidence.sources?.map((source) => source.id).toSorted()).toEqual([
      "market-aapl",
      "news-equity-1",
    ]);
    // Web sources stay under evidence.webSources so the fresh-web steering reference resolves.
    expect(parsed.evidence.webSources).toEqual([
      {
        id: "web-aapl-1",
        title: "Fresh web piece",
        fetchedAt: "2026-05-19T00:00:00.000Z",
        publisher: "Example Wire",
        snippet: "web snippet",
      },
    ]);

    // Only the critique survives from the prior-stage transcript.
    expect(parsed.priorStages).toEqual([{ stage: "critique", content: "CRITIQUE_TRANSCRIPT" }]);
    expect(prompt).not.toContain("SPECIALIST_TRANSCRIPT");

    // The report narrative is threaded in; predictions/sources are not duplicated there.
    expect(parsed.reportDraft?.summary).toBe("AAPL_DRAFT_SUMMARY");
    expect(parsed.reportDraft?.predictions).toBeUndefined();

    // Citation authority is unchanged and the report draft is never leaked into the audit block.
    expect(parsed.allowedSourceIds).toEqual(allowedSourceIds);
    expect(parsed.predictionCompletion?.reportDraft).toBeUndefined();
  });

  test("leaves the primary synthesis prompt on the full evidence payload", () => {
    const parsed = JSON.parse(buildPrompt()) as {
      readonly evidence: { readonly marketSnapshots?: unknown };
      readonly reportDraft?: unknown;
      readonly priorStages: readonly unknown[];
    };
    expect(parsed.evidence.marketSnapshots).toBeDefined();
    expect(parsed.reportDraft).toBeUndefined();
    expect(buildPrompt()).toContain("SPECIALIST_TRANSCRIPT");
  });

  test("completion instruction references deterministic anchors present in the distilled evidence", () => {
    const prompt = stagePromptFromArgs(
      "final-synthesis",
      command,
      collectedSources({
        marketSnapshots: [
          marketSnapshot({
            symbol: "AAPL",
            price: 192.3,
            observedAt: "2026-07-07T20:00:00.000Z",
            identity: { quoteCurrency: "USD" },
          }),
        ],
        newsSources: [newsSource()],
        extendedEvidence: {
          items: [
            {
              category: "options-iv",
              title: "AAPL IV term structure",
              summary: "30D IV 0.320.",
              sourceIds: ["extended-tradier-iv-term-aapl"],
              observedAt: "2026-07-07T20:00:00.000Z",
              metrics: { iv30: 0.32 },
            },
          ],
          gaps: [],
        },
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-28",
            timing: "amc",
            sourceIds: ["earnings-aapl"],
            fetchedAt: "2026-07-07T20:00:00.000Z",
          },
          impliedMove: {
            expiration: "2026-07-31",
            strike: 195,
            spot: 192.3,
            straddleMidpoint: 9.62,
            impliedMovePct: 0.05,
            sourceIds: ["extended-tradier-iv-term-aapl"],
            observedAt: "2026-07-07T20:00:00.000Z",
          },
          gaps: [],
        },
      }),
      config,
      context,
      loaded,
      priorStages,
      [],
      [],
      allowedSourceIds,
      {
        requestedCount: 2,
        existingPredictions: reportDraft.predictions,
        reportDraft,
      },
    );
    const parsed = JSON.parse(prompt) as {
      readonly instruction: string;
      readonly evidence: {
        readonly marketSnapshots?: unknown;
        readonly extendedEvidence?: unknown;
        readonly latestClose?: {
          readonly subject?: string;
          readonly price?: number;
          readonly observedAt?: string;
          readonly sourceId?: string;
          readonly quoteCurrency?: string;
        };
        readonly earningsSetup?: {
          readonly event?: { readonly date?: string };
          readonly impliedMove?: { readonly impliedMovePct?: number };
        };
        readonly optionsIv?: readonly {
          readonly sourceIds?: readonly string[];
          readonly metrics?: { readonly iv30?: number };
        }[];
      };
    };

    expect(parsed.instruction).toContain("earningsSetup.event.date");
    expect(parsed.instruction).toContain("iv(SUBJECT, +N) > T for IV");
    expect(parsed.instruction).toContain("close(SUBJECT, +N) outside [Lo, Hi] for range");
    expect(parsed.evidence.earningsSetup?.event?.date).toBe("2026-07-28");
    expect(parsed.evidence.earningsSetup?.impliedMove?.impliedMovePct).toBe(0.05);
    expect(parsed.evidence.optionsIv?.[0]?.sourceIds).toEqual(["extended-tradier-iv-term-aapl"]);
    expect(parsed.evidence.optionsIv?.[0]?.metrics?.iv30).toBe(0.32);
    expect(parsed.evidence.latestClose).toEqual({
      subject: "AAPL",
      price: 192.3,
      observedAt: "2026-07-07T20:00:00.000Z",
      sourceId: "market-aapl",
      quoteCurrency: "USD",
    });
    expect(parsed.evidence.marketSnapshots).toBeUndefined();
    expect(parsed.evidence.extendedEvidence).toBeUndefined();
  });
});

describe("StageInput assembly", () => {
  const assemblyCommand: ResearchCommand = legacyMarketOverviewCommand("daily", {
    assetClass: "equity",
    depth: "brief",
  });

  function baseStageInput(overrides: Partial<StageInput> = {}): StageInput {
    return {
      command: assemblyCommand,
      collectedSources: collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      context: {
        depthProfile: buildDepthProfile(assemblyCommand, config),
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
      loaded: { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
      ...overrides,
    };
  }

  test("routes allowedSourceIds and sourceId guidance to final-synthesis only", () => {
    const finalPrompt = JSON.parse(
      buildStagePrompt("final-synthesis", baseStageInput({ allowedSourceIds: ["market-aapl"] })),
    ) as { readonly allowedSourceIds?: readonly string[]; readonly sourceIdGuidance?: string };
    expect(finalPrompt.allowedSourceIds).toEqual(["market-aapl"]);
    expect(finalPrompt.sourceIdGuidance).toBeDefined();

    const specialistPrompt = JSON.parse(
      buildStagePrompt(
        "specialist-analysis",
        baseStageInput({ allowedSourceIds: ["market-aapl"] }),
      ),
    ) as { readonly allowedSourceIds?: readonly string[]; readonly sourceIdGuidance?: string };
    expect(specialistPrompt.allowedSourceIds).toBeUndefined();
    expect(specialistPrompt.sourceIdGuidance).toBeUndefined();
  });

  test("omits reportValidationErrors unless provided", () => {
    const without = JSON.parse(buildStagePrompt("final-synthesis", baseStageInput())) as {
      readonly reportValidationErrors?: readonly string[];
    };
    expect(without.reportValidationErrors).toBeUndefined();

    const withErrors = JSON.parse(
      buildStagePrompt(
        "final-synthesis",
        baseStageInput({ reportValidationErrors: ["missing keyFindings"] }),
      ),
    ) as { readonly reportValidationErrors?: readonly string[] };
    expect(withErrors.reportValidationErrors).toEqual(["missing keyFindings"]);
  });

  test("passes priorStages through to the prompt payload", () => {
    const prompt = JSON.parse(
      buildStagePrompt(
        "critique",
        baseStageInput({ priorStages: [{ stage: "specialist-analysis", content: "prior" }] }),
      ),
    ) as { readonly priorStages?: readonly { readonly stage?: string }[] };
    expect(prompt.priorStages).toHaveLength(1);
    expect(prompt.priorStages?.[0]?.stage).toBe("specialist-analysis");
  });

  test("routes the prediction repair block to final-synthesis only", () => {
    const finalPrompt = JSON.parse(
      buildStagePrompt(
        "final-synthesis",
        baseStageInput({ predictionRepromptErrors: ["duplicate forecast"] }),
      ),
    ) as {
      readonly predictionRepromptErrors?: readonly string[];
      readonly predictionRepair?: { readonly instruction?: string };
    };
    expect(finalPrompt.predictionRepromptErrors).toEqual(["duplicate forecast"]);
    expect(finalPrompt.predictionRepair?.instruction).toBeDefined();

    const specialistPrompt = JSON.parse(
      buildStagePrompt(
        "specialist-analysis",
        baseStageInput({ predictionRepromptErrors: ["duplicate forecast"] }),
      ),
    ) as { readonly predictionRepair?: { readonly instruction?: string } };
    expect(specialistPrompt.predictionRepair).toBeUndefined();
  });

  test("swaps stage goal and required shape when predictionCompletion is set", () => {
    const prompt = JSON.parse(
      buildStagePrompt(
        "final-synthesis",
        baseStageInput({
          predictionCompletion: {
            requestedCount: 2,
            existingPredictions: [],
            reportDraft: researchReport(),
          },
        }),
      ),
    ) as {
      readonly stageGoal?: string;
      readonly requiredShape?: Record<string, unknown>;
      readonly predictionCompletion?: { readonly requestedCount?: number };
    };
    expect(prompt.stageGoal).toBe(
      "Add only distinct, evidence-backed observable forecasts without changing the accepted report.",
    );
    expect(Object.keys(prompt.requiredShape ?? {})).toEqual(["predictions"]);
    expect(prompt.predictionCompletion?.requestedCount).toBe(2);
  });
});
