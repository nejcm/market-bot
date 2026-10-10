import { describe, expect, test } from "bun:test";
import { legacyMarketOverviewCommand } from "./support/commands";
import type { ResearchCommand } from "../src/cli/args";
import { buildStagePrompt, type StageInput } from "../src/research/prompts";
import { buildDepthProfile } from "../src/research/depth-profile";
import { verifiedMarketSnapshotEvidence } from "../src/research/prompts/evidence-payload";
import {
  MAX_PREDICTION_HORIZON_TRADING_DAYS,
  MIN_PREDICTION_HORIZON_TRADING_DAYS,
} from "../src/forecast/observable";
import type { ResearchContext } from "../src/research/research-context-types";
import {
  collectedSources,
  marketSnapshot,
  newsSource,
  verifiedMarketSnapshot,
} from "./support/fixtures";
import { config, stagePromptFromArgs } from "./support/research-context-helpers";

function kindMixSynthesisInstruction(
  command: ResearchCommand,
  sources: Partial<Parameters<typeof collectedSources>[0]> = {},
): string {
  const depthProfile = buildDepthProfile(command, config);
  const prompt = stagePromptFromArgs(
    "final-synthesis",
    command,
    collectedSources({
      rawSnapshots: [],
      marketSnapshots: [marketSnapshot()],
      newsSources: [newsSource()],
      sourceGaps: [],
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
        quickModelParams: undefined,
        synthesisModelParams: undefined,
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

function rangeReferenceCloses(count: number, step = 0.02, jump?: { at: number; ratio: number }) {
  let close = 100;
  return Array.from({ length: count }, (_, index) => {
    if (index > 0) {
      close *= index % 2 === 0 ? 1 / (1 + step) : 1 + step;
    }
    if (jump !== undefined && index === jump.at) {
      close *= jump.ratio;
    }
    return { date: `2026-05-${String(index + 1).padStart(2, "0")}`, close };
  });
}

function closesFromReturns(returns: readonly number[]) {
  let close = 100;
  return [100, ...returns].map((value, index) => {
    if (index > 0) {
      close *= Math.exp(value);
    }
    return { date: `2026-05-${String(index + 1).padStart(2, "0")}`, close };
  });
}

describe("range volatility reference", () => {
  const command: ResearchCommand = {
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    depth: "brief",
  };
  const reference = (recentCloses: readonly { date: string; close: number }[]) =>
    kindMixSynthesisInstruction(command, {
      verifiedMarketSnapshot: verifiedMarketSnapshot({ recentCloses }),
    });

  test("anchors range probabilities to a vol-scaled band from recent closes", () => {
    const instruction = reference(rangeReferenceCloses(21));

    expect(instruction).toMatch(
      /Range reference for AAPL \(deterministic, from the 20 daily log returns in verifiedMarketSnapshot\.recentCloses\): realized daily volatility \(sample standard deviation\) \d+\.\d{2}% around the last close 100\.00; ±1σ close bands \+1: /,
    );
    expect(instruction).toContain("Daily returns are fat-tailed");
    expect(instruction).not.toContain("32%");
  });

  test.each([
    ["2:1", 0.5],
    ["4:3", 0.75],
  ])("omits the reference across a %s split in the unadjusted window", (_, ratio) => {
    expect(reference(rangeReferenceCloses(21, 0.02, { at: 10, ratio }))).not.toContain(
      "Range reference",
    );
  });

  test("keeps a reference for a genuinely high-volatility series", () => {
    expect(reference(rangeReferenceCloses(21, 0.1))).toContain("Range reference");
  });

  test("keeps jump risk when most days are flat", () => {
    const returns = [
      ...Array.from({ length: 12 }, () => 0),
      ...Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? 0.2 : -0.2)),
    ];
    expect(reference(closesFromReturns(returns))).toContain(
      "realized daily volatility (sample standard deviation) 12.98%",
    );
  });

  test("omits the reference without enough closes or a verified snapshot", () => {
    expect(reference(rangeReferenceCloses(10))).not.toContain("Range reference");
    expect(kindMixSynthesisInstruction(command)).not.toContain("Range reference");
  });
});

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
        quickModelParams: undefined,
        synthesisModelParams: undefined,
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
  test("uses the default horizon as an evidence-dependent starting point", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const instruction = finalSynthesisInstruction(command);

    expect(instruction).toContain(
      "a starting horizon of 5 trading days; a forecast may depart from it when the cited evidence supports a different resolution window.",
    );
    expect(instruction).not.toContain("a default horizon near 5 trading days");
  });

  test("states the legal prediction horizon range in the DSL guidance", () => {
    const instruction = finalSynthesisInstruction({
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    });

    expect(instruction).toContain(
      `The legal range for N is ${MIN_PREDICTION_HORIZON_TRADING_DAYS}–${MAX_PREDICTION_HORIZON_TRADING_DAYS} trading days.`,
    );
  });

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
    expect(instruction).toContain(
      "Explore shape and resolution-window variety to find the most informative forecasts rather than defaulting to the same kind repeatedly, varying horizons only where the evidence supports it.",
    );
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
          eventDateStatus: "issuer-confirmed",
          sourceIds: ["earnings-aapl"],
          fetchedAt: "2026-06-01T00:00:00.000Z",
        },
        gaps: [],
      },
    });

    expect(instruction).not.toContain("earnings-direction");
    expect(instruction).not.toContain("earnings-move");
  });

  test("includes earnings shapes when earningsSetup is issuer-confirmed", () => {
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
          eventDateStatus: "issuer-confirmed",
          sourceIds: ["earnings-aapl"],
          fetchedAt: "2026-06-01T00:00:00.000Z",
        },
        gaps: [],
      },
    });

    expect(instruction).toContain("earnings-direction or earnings-move");
  });

  test("keeps provider-estimated setup contextual without earnings grammar", () => {
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
          eventDateStatus: "provider-estimated",
          sourceIds: ["earnings-aapl"],
          fetchedAt: "2026-06-01T00:00:00.000Z",
        },
        gaps: [],
      },
    });

    expect(instruction).toContain("provider-estimated and unconfirmed");
    expect(instruction).toContain("Do not emit earnings-direction");
    expect(instruction).not.toContain("earningsSetup.event.date as YYYY-MM-DD");
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

describe("buildStagePrompt final-synthesis prediction steering", () => {
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
  function buildPrompt(
    calibrationContext: ResearchContext["calibrationContext"] = context.calibrationContext,
    predictionRepromptErrors: readonly string[] = [],
  ): string {
    return stagePromptFromArgs(
      "final-synthesis",
      command,
      sources,
      config,
      { ...context, calibrationContext },
      loaded,
      priorStages,
      predictionRepromptErrors,
      [],
      allowedSourceIds,
    );
  }

  test("keeps the full evidence payload and prior-stage transcript", () => {
    const parsed = JSON.parse(buildPrompt()) as {
      readonly evidence: { readonly marketSnapshots?: unknown };
      readonly reportDraft?: unknown;
      readonly priorStages: readonly unknown[];
    };
    expect(parsed.evidence.marketSnapshots).toBeDefined();
    expect(parsed.reportDraft).toBeUndefined();
    expect(buildPrompt()).toContain("SPECIALIST_TRANSCRIPT");
  });

  test("carries the verified snapshot into evidence", () => {
    const snapshot = verifiedMarketSnapshot({
      symbol: "AAPL",
      latestSessionDate: "2026-05-01",
      latestSessionStatus: "unverified",
    });
    const prompt = stagePromptFromArgs(
      "final-synthesis",
      command,
      collectedSources({ verifiedMarketSnapshot: snapshot }),
      config,
      context,
      loaded,
      priorStages,
      [],
      [],
      allowedSourceIds,
    );
    const parsed = JSON.parse(prompt) as { readonly evidence: Record<string, unknown> };

    expect(parsed.evidence).toMatchObject(verifiedMarketSnapshotEvidence(snapshot));
    expect(parsed.evidence.verifiedMarketSnapshotSourceId).toBe("verified-snapshot-AAPL");
  });

  test("repair steering requires evidence-backed probability differentiation", () => {
    const parsed = JSON.parse(buildPrompt(undefined, ["duplicate forecast"])) as {
      readonly predictionRepair?: { readonly instruction?: string };
    };

    expect(parsed.predictionRepair?.instruction).toContain(
      "must differ in probability by more than 0.005, backed by a stated evidence-based differentiation",
    );
    expect(parsed.predictionRepair?.instruction).toContain(
      "changing only the benchmark ticker does not add signal",
    );
  });

  test("permits evidence-backed horizon variety without requiring it", () => {
    const parsed = JSON.parse(buildPrompt()) as { readonly instruction?: string };

    expect(parsed.instruction).toContain(
      "Explore shape and resolution-window variety to find the most informative forecasts rather than defaulting to the same kind repeatedly, varying horizons only where the evidence supports it.",
    );
  });

  test("explains the positive-only grammar polarity contract", () => {
    const parsed = JSON.parse(buildPrompt()) as { readonly instruction?: string };

    expect(parsed.instruction).toContain(
      "The grammar only expresses up/outside; to express a bearish or stays-within-range view, set probability below 0.40 on the up/outside expression.",
    );
  });

  test("includes material conditional activation history", () => {
    const parsed = JSON.parse(
      buildPrompt({ conditionalPredictions: { activatedCount: 4, voidedCount: 13 } }),
    ) as { readonly instruction?: string };

    expect(parsed.instruction).toContain(
      "Continue emitting Conditional Predictions when the evidence supports a genuinely conditional setup. Anchor antecedents to scheduled events such as earnings dates, index rebalances, or economic releases, or to threshold levels that the cited price history has already reached, so the antecedent can plausibly occur inside the resolution window. Activation history shows why antecedent quality matters: 4 of 17 resolved conditionals activated; 13 voided because their antecedents did not occur.",
    );
  });

  test("omits conditional activation guidance when counts are missing", () => {
    const parsed = JSON.parse(buildPrompt()) as { readonly instruction?: string };

    expect(parsed.instruction).not.toContain(
      "Activation history shows why antecedent quality matters",
    );
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
});
