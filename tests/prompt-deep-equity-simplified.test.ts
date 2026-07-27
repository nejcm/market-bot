import { describe, expect, test } from "bun:test";
import type { InstrumentCommand } from "../src/cli/args";
import { buildDeepEquityModelPacket } from "../src/deep-equity/evidence";
import type { Prediction } from "../src/domain/types";
import { buildDepthProfile } from "../src/research/depth-profile";
import { loadStagePrompt } from "../src/research/prompt-loader";
import { synthesizeReportUntilValid, type StageReprompt } from "../src/research/final-synthesis";
import {
  buildRecordedStageSteering,
  buildStagePrompt,
  type StageInput,
} from "../src/research/prompts";
import type { ResearchContext } from "../src/research/research-context-types";
import { buildFinalSynthesisStagePrompt } from "../src/research/prompts/final-synthesis";
import type { CollectedSources } from "../src/sources/types";
import {
  collectedSources,
  deepEquityEvidenceBundle,
  marketSnapshot,
  newsSource,
  prediction,
  researchReport,
} from "./support/fixtures";
import { config } from "./support/research-context-helpers";

const command: InstrumentCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
};

const loaded = { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." };

function context(): ResearchContext {
  const depthProfile = buildDepthProfile(command, config);
  return {
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
      assetClass: "equity",
      label: "mixed",
      proxyCount: 1,
      drivers: [],
      sourceIds: [],
    },
    calibrationContext: undefined,
    evidenceQualityAssessment: {
      version: 1,
      rubricVersion: 2,
      label: "high",
      checks: [],
      limitingReasons: [],
    },
  };
}

function sources(overrides: Partial<CollectedSources> = {}) {
  return collectedSources({
    rawSnapshots: [],
    marketSnapshots: [marketSnapshot()],
    newsSources: [newsSource()],
    sourceGaps: [],
    ...overrides,
  });
}

// No eventDateStatus, so the date is provider-estimated: report assembly suppresses every earnings
// Forecast built on it via applyEarningsForecastPolicy's "confirmed-only" policy.
const estimatedEarningsSetup = {
  event: {
    symbol: "AAPL",
    date: "2026-07-24",
    timing: "bmo",
    sourceIds: ["news-equity-1"],
    fetchedAt: "2026-05-14T00:00:00.000Z",
  },
  gaps: [],
} as const;

function stageInput(overrides: Partial<StageInput> = {}): StageInput {
  return {
    command,
    collectedSources: sources(),
    config,
    context: context(),
    loaded,
    priorStages: [],
    predictionRepromptErrors: [],
    reportValidationErrors: [],
    allowedSourceIds: [],
    deepEquityModelPacket: buildDeepEquityModelPacket(deepEquityEvidenceBundle()),
    canonicalSources: [newsSource()],
    ...overrides,
  };
}

function simplifiedFinalSynthesisPrompt(overrides: Partial<StageInput> = {}): string {
  return buildStagePrompt("final-synthesis", stageInput(overrides));
}

const retained: readonly Prediction[] = [
  prediction({
    id: "pred-2",
    kind: "direction",
    subject: "AAPL",
    measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
    probability: 0.62,
    sourceIds: ["news-equity-1"],
  }),
];

const retainedRange: Prediction = prediction({
  id: "pred-7",
  kind: "range",
  subject: "AAPL",
  measurableAs: "close(AAPL, +5) outside [190, 207]",
  probability: 0.37,
  sourceIds: ["news-equity-1"],
});

// The 2026-07-27 live pair used valuationComps.impliedPriceRange (a peer EV/revenue percentile
// Band) verbatim as 5- and 10-day range-forecast bounds, and asserted computed TTM aggregates as
// Observed facts alongside a stale verified bar. These guard the corrections, on the simplified
// Path only.
describe("simplified deep-equity report quality steering", () => {
  // Neither the primary nor the completion pass sees the evidence packet, so neither has the
  // Multi-session price history an [Lo, Hi] band must be sized from. Range is withdrawn here rather
  // Than sized from prose, which is how a peer EV/revenue percentile band became a 5-day forecast.
  test("withdraws range from every steering surface, not by appending a ban", () => {
    const prompt = simplifiedFinalSynthesisPrompt();
    // DSL exposition, coverage notes, favoured mix and diversity guidance must all omit it.
    expect(prompt).not.toContain("outside [Lo, Hi] for range");
    expect(prompt).not.toContain("range (outside [Lo, Hi])");
    expect(prompt).not.toMatch(/favor these kinds when supported:[^."]*range/u);
    expect(prompt).not.toMatch(/priority order where the evidence supports them:[^."]*range/u);
    // The kinds it can support are untouched.
    expect(prompt).toContain("close(SUBJECT, +N) > close(SUBJECT, 0) for direction");
    expect(prompt).toContain("relative (vs benchmark)");
  });

  test("stops teaching the stays-within-range polarity trick", () => {
    const simplified = simplifiedFinalSynthesisPrompt();
    expect(simplified).not.toContain("stays-within-range");
    expect(simplified).not.toContain("up/outside");
    expect(simplified).toContain("The grammar only expresses up;");
    const {
      deepEquityModelPacket: _packet,
      canonicalSources: _canonical,
      ...generic
    } = stageInput();
    expect(buildStagePrompt("final-synthesis", generic)).toContain("stays-within-range");
  });

  test("withdraws range from the advertised kind union without touching other kinds", () => {
    const shape = JSON.parse(simplifiedFinalSynthesisPrompt()) as {
      readonly requiredShape: { readonly predictions: readonly { readonly kind: string }[] };
    };
    const kinds = shape.requiredShape.predictions[0]?.kind.split("|") ?? [];
    expect(kinds).not.toContain("range");
    expect(kinds).toContain("direction");
    expect(kinds).toContain("relative");
  });

  test("withdraws range in the prediction-completion pass too", () => {
    const prompt = simplifiedFinalSynthesisPrompt({
      predictionCompletion: {
        requestedCount: 2,
        existingPredictions: retained,
        reportDraft: researchReport(),
      },
    });
    const shape = JSON.parse(prompt) as {
      readonly requiredShape: { readonly predictions: readonly { readonly kind: string }[] };
    };
    expect(prompt).not.toContain("outside [Lo, Hi] for range");
    expect(shape.requiredShape.predictions[0]?.kind.split("|")).not.toContain("range");
  });

  test("drops range guidance from the repair instruction", () => {
    const prompt = simplifiedFinalSynthesisPrompt({
      predictionRepromptErrors: ["Prediction pred-3: subject does not match measurableAs"],
    });
    expect(prompt).not.toContain("For range forecasts, vary the horizon or range bounds");
    expect(prompt).toContain("For ticker relative forecasts, use subject form TICKER:BENCHMARK");
  });

  // Survivor guidance must never order a withdrawn kind re-emitted, same as the earnings filter.
  test("filters a retained range forecast out of survivor guidance", () => {
    const prompt = simplifiedFinalSynthesisPrompt({
      predictionRepromptErrors: ["Prediction pred-3: subject does not match measurableAs"],
      retainedPredictions: [retainedRange, ...retained],
    });
    expect(prompt).toContain("already validated");
    expect(prompt).toContain("pred-2");
    expect(prompt).not.toContain("pred-7");
  });

  test("emits no survivor guidance when every retained forecast is a withdrawn kind", () => {
    const prompt = simplifiedFinalSynthesisPrompt({
      predictionRepromptErrors: ["Prediction pred-3: subject does not match measurableAs"],
      retainedPredictions: [retainedRange],
    });
    expect(prompt).not.toContain("already validated");
  });

  // The completion payload briefly carried a stale price-movement block. It is gone, and the
  // Generic-path completion prompt must be byte-identical to the shared builder's own output.
  test("leaves the generic-path completion prompt to the shared builder", () => {
    const {
      deepEquityModelPacket: _packet,
      canonicalSources: _canonical,
      ...generic
    } = stageInput({
      predictionCompletion: {
        requestedCount: 2,
        existingPredictions: retained,
        reportDraft: researchReport(),
      },
    });
    const prompt = buildStagePrompt("final-synthesis", generic);
    expect(prompt).toBe(buildFinalSynthesisStagePrompt(generic));
    expect(prompt).not.toContain("priceMovementScale");
    expect(prompt).toContain("outside [Lo, Hi] for range");
  });

  test("defines derived by provenance, not by who did the arithmetic", () => {
    const prompt = simplifiedFinalSynthesisPrompt();
    expect(prompt).toContain("observed only where a filing, statement, or quote reports it");
    expect(prompt).toContain("even when the packet supplies it already computed");
    expect(prompt).toContain("peer-implied range");
    expect(prompt).toContain("do not merge the two into one market state");
  });

  test("leaves the generic-path final-synthesis prompt untouched", () => {
    const {
      deepEquityModelPacket: _packet,
      canonicalSources: _canonical,
      ...generic
    } = stageInput();
    const prompt = buildStagePrompt("final-synthesis", generic);
    expect(prompt).toContain("outside [Lo, Hi] for range");
    expect(prompt).not.toContain("observed only where a filing, statement, or quote reports it");
    expect(prompt).not.toContain("priceMovementScale");
  });

  test("the equity-analysis stage requires provenance and two-sided valuation figures", async () => {
    const loadedEquityAnalysis = await loadStagePrompt("equity-analysis", command, "prompts");
    expect(loadedEquityAnalysis.goal).toContain("even when it arrives already computed");
    expect(loadedEquityAnalysis.goal).toContain("the peer median and the spread around it");
  });
});

describe("simplified deep-equity final-synthesis prompt", () => {
  test("repair reprompt names the predictions that already validated", () => {
    const prompt = simplifiedFinalSynthesisPrompt({
      predictionRepromptErrors: ["Prediction pred-3: subject does not match measurableAs"],
      retainedPredictions: retained,
    });
    expect(prompt).toContain("already validated");
    expect(prompt).toContain("close(AAPL, +5) > close(AAPL, 0)");
    expect(prompt).toContain("Re-emit every one of them unchanged");
  });

  // A report-only validation retry carries no predictionRepromptErrors, so the prediction-repair
  // Block never renders — but it regenerates the whole report, predictions included.
  test("report-only validation retry also names the predictions that already validated", () => {
    const prompt = simplifiedFinalSynthesisPrompt({
      reportValidationErrors: ["Major findings must reference source IDs"],
      retainedPredictions: retained,
    });
    expect(prompt).not.toContain("predictionRepair");
    expect(prompt).toContain("already validated");
    expect(prompt).toContain("close(AAPL, +5) > close(AAPL, 0)");
  });

  test("a first attempt carries no survivor guidance", () => {
    expect(simplifiedFinalSynthesisPrompt()).not.toContain("already validated");
  });

  // The recorded StageOutput.steering is what makes a prompt gap decidable from a run directory.
  // It must be the same text the prompt carries, not a path-agnostic approximation of it.
  test("recorded steering matches the steering the prompt carries", () => {
    const overrides = {
      predictionRepromptErrors: ["Prediction pred-3: subject does not match measurableAs"],
      retainedPredictions: retained,
    };
    const steering = buildRecordedStageSteering("final-synthesis", stageInput(overrides));
    expect(steering).toContain("already validated");
    const prompt = simplifiedFinalSynthesisPrompt(overrides);
    for (const segment of (steering ?? "").split("\n\n")) {
      expect(prompt).toContain(JSON.stringify(segment).slice(1, -1));
    }
  });
});

// Behavioral guard on the plumbing: the repair reprompt has to carry the surviving predictions
// From the attempt it is repairing, otherwise the stateless regeneration cannot preserve them.
function reportPayload(
  predictions: readonly unknown[],
  findingSourceIds: readonly string[] = ["news-equity-1"],
): string {
  return JSON.stringify({
    summary: "AAPL evidence summary.",
    keyFindings: [{ text: "Price observed.", sourceIds: findingSourceIds }],
    bullCase: [{ text: "Cash generation is steady.", sourceIds: ["news-equity-1"] }],
    bearCase: [{ text: "Valuation is elevated.", sourceIds: ["news-equity-1"] }],
    risks: [{ text: "Evidence is thin.", sourceIds: ["news-equity-1"] }],
    catalysts: [{ text: "Next filing.", sourceIds: ["news-equity-1"] }],
    scenarios: [
      { name: "Base", description: "Trends persist.", sourceIds: ["news-equity-1"] },
      { name: "Bear", description: "Trends reverse.", sourceIds: ["news-equity-1"] },
    ],
    dataGaps: [],
    predictions,
  });
}

// Subject names neither the primary nor the pair, so it survives the subject normalization widened
// In forecast/observable.ts and is still a hard field mismatch.
function brokenPrediction(id: string): Record<string, unknown> {
  return {
    id,
    kind: "conditional",
    subject: "SPY",
    measurableAs:
      "if (close(SPY, +2) > close(SPY, 0)) then (close(AAPL, +5)/close(AAPL, 0) > close(SPY, +5)/close(SPY, 0))",
    horizonTradingDays: 5,
    probability: 0.62,
    sourceIds: ["news-equity-1"],
  };
}

describe("prediction repair reprompt", () => {
  test("carries the predictions that survived the failed attempt", async () => {
    const reprompts: StageReprompt[] = [];
    const validPrediction = {
      id: "pred-1",
      kind: "range",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) outside [190, 207]",
      horizonTradingDays: 5,
      probability: 0.37,
      sourceIds: ["news-equity-1"],
    };

    const result = await synthesizeReportUntilValid({
      runId: "run-1",
      generatedAt: "2026-05-19T00:00:00.000Z",
      command,
      collectedSources: sources(),
      context: context(),
      sources: [newsSource()],
      knownSourceIds: new Set(["news-equity-1"]),
      allowedSubjects: new Set(["AAPL"]),
      priorStages: [],
      maxPredictionReprompts: 1,
      runFinalSynthesis: (_priorStages, reprompt) => {
        if (reprompt !== undefined) {
          reprompts.push(reprompt);
        }
        const first = reprompts.length <= 1;
        return Promise.resolve({
          stage: "final-synthesis" as const,
          content: reportPayload(
            first ? [validPrediction, brokenPrediction("pred-2")] : [validPrediction],
          ),
          tokenEstimate: 1,
        });
      },
    });

    const repair = reprompts.find((entry) => (entry.predictionErrors?.length ?? 0) > 0);
    expect(repair?.predictionErrors).toContain(
      "Prediction pred-2: subject does not match measurableAs",
    );
    expect(repair?.retainedPredictions?.map((entry) => entry.id)).toEqual(["pred-1"]);
    expect(result.report.predictions).toHaveLength(1);
  });

  // A repair chain must not ratchet downward. If attempt N returns fewer predictions than N-1
  // Despite the survivor guidance, attempt N+1 has to anchor to the best set seen so far, not to
  // N's shrunken one — otherwise each shrink compounds into the next repair.
  test("does not anchor to a shrunken attempt part-way through a repair chain", async () => {
    const reprompts: StageReprompt[] = [];
    const valid = [
      {
        id: "pred-1",
        kind: "range",
        subject: "AAPL",
        measurableAs: "close(AAPL, +5) outside [190, 207]",
        horizonTradingDays: 5,
        probability: 0.37,
        sourceIds: ["news-equity-1"],
      },
      {
        id: "pred-2",
        kind: "direction",
        subject: "AAPL",
        measurableAs: "close(AAPL, +10) > close(AAPL, 0)",
        horizonTradingDays: 10,
        probability: 0.62,
        sourceIds: ["news-equity-1"],
      },
      {
        id: "pred-3",
        kind: "relative",
        subject: "AAPL:SPY",
        measurableAs: "close(AAPL, +5)/close(AAPL, 0) > close(SPY, +5)/close(SPY, 0)",
        horizonTradingDays: 5,
        probability: 0.61,
        sourceIds: ["news-equity-1"],
      },
    ];
    let calls = 0;
    // Attempt 1 validates three predictions, attempt 2 shrinks to one, attempt 3 must still be
    // Shown all three. Both early attempts carry an invalid prediction to force the next repair.
    const attempts = [
      [...valid, brokenPrediction("bad-a")],
      [valid[0], brokenPrediction("bad-b")],
      valid,
    ];

    await synthesizeReportUntilValid({
      runId: "run-1",
      generatedAt: "2026-05-19T00:00:00.000Z",
      command,
      collectedSources: sources(),
      context: context(),
      sources: [newsSource()],
      knownSourceIds: new Set(["news-equity-1"]),
      allowedSubjects: new Set(["AAPL"]),
      priorStages: [],
      maxPredictionReprompts: 2,
      runFinalSynthesis: (_priorStages, reprompt) => {
        calls += 1;
        if (reprompt !== undefined) {
          reprompts.push(reprompt);
        }
        return Promise.resolve({
          stage: "final-synthesis" as const,
          content: reportPayload(attempts[calls - 1] ?? valid),
          tokenEstimate: 1,
        });
      },
    });

    const repairs = reprompts.filter((entry) => (entry.predictionErrors?.length ?? 0) > 0);
    expect(repairs[0]?.retainedPredictions?.map((entry) => entry.id)).toEqual([
      "pred-1",
      "pred-2",
      "pred-3",
    ]);
    // The second repair follows the shrunken attempt but must not inherit its single prediction.
    expect(repairs[1]?.predictionErrors).toContain(
      "Prediction bad-b: subject does not match measurableAs",
    );
    expect(repairs[1]?.retainedPredictions?.map((entry) => entry.id)).toEqual([
      "pred-1",
      "pred-2",
      "pred-3",
    ]);
  });

  // Survivor guidance orders a forecast re-emitted unchanged, so it must not name one that
  // Deterministic report assembly will always suppress. An earnings forecast on a provider-
  // Estimated event date passes readPredictions but never survives applyEarningsForecastPolicy.
  test("omits a forecast that report assembly suppresses", async () => {
    const reprompts: StageReprompt[] = [];
    const validPrediction = {
      id: "pred-1",
      kind: "range",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) outside [190, 207]",
      horizonTradingDays: 5,
      probability: 0.37,
      sourceIds: ["news-equity-1"],
    };
    const earningsPrediction = {
      id: "pred-2",
      kind: "earnings-direction",
      subject: "AAPL",
      measurableAs: "earningsReturn(AAPL, 2026-07-24, +1) > 0",
      horizonTradingDays: 1,
      probability: 0.62,
      sourceIds: ["news-equity-1"],
    };
    let calls = 0;

    await synthesizeReportUntilValid({
      runId: "run-1",
      generatedAt: "2026-05-19T00:00:00.000Z",
      command,
      collectedSources: sources({ earningsSetup: estimatedEarningsSetup }),
      context: context(),
      sources: [newsSource()],
      knownSourceIds: new Set(["news-equity-1"]),
      allowedSubjects: new Set(["AAPL"]),
      priorStages: [],
      maxPredictionReprompts: 1,
      runFinalSynthesis: (_priorStages, reprompt) => {
        calls += 1;
        if (reprompt !== undefined) {
          reprompts.push(reprompt);
        }
        return Promise.resolve({
          stage: "final-synthesis" as const,
          content: reportPayload(
            calls === 1
              ? [validPrediction, earningsPrediction, brokenPrediction("bad-a")]
              : [validPrediction],
          ),
          tokenEstimate: 1,
        });
      },
    });

    const repair = reprompts.find((entry) => (entry.predictionErrors?.length ?? 0) > 0);
    expect(repair?.retainedPredictions?.map((entry) => entry.id)).toEqual(["pred-1"]);
  });

  // RequiredShape is prompt text, not enforcement: readPredictions still accepts the global `range`
  // Kind. This is the backstop for a model that emits one regardless.
  test("drops a disobeyed range forecast before assembly and records why", async () => {
    const validPrediction = {
      id: "pred-1",
      kind: "direction",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
      horizonTradingDays: 5,
      probability: 0.62,
      sourceIds: ["news-equity-1"],
    };
    const disobeyedRange = {
      id: "pred-2",
      kind: "range",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) outside [145.6, 264.7]",
      horizonTradingDays: 5,
      probability: 0.18,
      sourceIds: ["news-equity-1"],
    };

    const result = await synthesizeReportUntilValid({
      runId: "run-1",
      generatedAt: "2026-05-19T00:00:00.000Z",
      command,
      collectedSources: sources(),
      context: context(),
      sources: [newsSource()],
      knownSourceIds: new Set(["news-equity-1"]),
      allowedSubjects: new Set(["AAPL"]),
      disallowedPredictionKinds: ["range"],
      priorStages: [],
      maxPredictionReprompts: 1,
      runFinalSynthesis: () =>
        Promise.resolve({
          stage: "final-synthesis" as const,
          content: reportPayload([validPrediction, disobeyedRange]),
          tokenEstimate: 1,
        }),
    });

    expect(result.report.predictions.map((entry) => entry.id)).toEqual(["pred-1"]);
    expect(result.predictionTrimWarnings).toContain(
      "Prediction pred-2: range forecasts are not solicited on this path; dropped before validation",
    );
    // Not an error: a withdrawn kind must not burn a repair attempt.
    expect(result.predictionErrors).toEqual([]);
  });

  // A withdrawn candidate must never cost a valid forecast. Filtering after batch validation let a
  // Colliding id take the duplicate slot and evict the good one, and let a malformed withdrawn
  // Candidate raise retry errors that trigger a repair for something we discard anyway.
  test("an id-colliding withdrawn candidate cannot evict a valid forecast", async () => {
    const result = await synthesizeReportUntilValid({
      runId: "run-1",
      generatedAt: "2026-05-19T00:00:00.000Z",
      command,
      collectedSources: sources(),
      context: context(),
      sources: [newsSource()],
      knownSourceIds: new Set(["news-equity-1"]),
      allowedSubjects: new Set(["AAPL"]),
      disallowedPredictionKinds: ["range"],
      priorStages: [],
      maxPredictionReprompts: 1,
      runFinalSynthesis: () =>
        Promise.resolve({
          stage: "final-synthesis" as const,
          content: reportPayload([
            {
              id: "pred-1",
              kind: "range",
              subject: "AAPL",
              measurableAs: "close(AAPL, +5) outside [145.6, 264.7]",
              horizonTradingDays: 5,
              probability: 0.18,
              sourceIds: ["news-equity-1"],
            },
            {
              id: "pred-1",
              kind: "direction",
              subject: "AAPL",
              measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
              horizonTradingDays: 5,
              probability: 0.62,
              sourceIds: ["news-equity-1"],
            },
          ]),
          tokenEstimate: 1,
        }),
    });

    expect(result.report.predictions.map((entry) => entry.kind)).toEqual(["direction"]);
    expect(result.predictionErrors).toEqual([]);
  });

  test("a malformed withdrawn candidate does not trigger a repair", async () => {
    const reprompts: StageReprompt[] = [];
    const result = await synthesizeReportUntilValid({
      runId: "run-1",
      generatedAt: "2026-05-19T00:00:00.000Z",
      command,
      collectedSources: sources(),
      context: context(),
      sources: [newsSource()],
      knownSourceIds: new Set(["news-equity-1"]),
      allowedSubjects: new Set(["AAPL"]),
      disallowedPredictionKinds: ["range"],
      priorStages: [],
      maxPredictionReprompts: 1,
      runFinalSynthesis: (_priorStages, reprompt) => {
        if (reprompt !== undefined) {
          reprompts.push(reprompt);
        }
        return Promise.resolve({
          stage: "final-synthesis" as const,
          content: reportPayload([
            {
              id: "pred-1",
              kind: "direction",
              subject: "AAPL",
              measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
              horizonTradingDays: 5,
              probability: 0.62,
              sourceIds: ["news-equity-1"],
            },
            // Malformed: subject does not match measurableAs. Withdrawn, so never validated.
            {
              id: "pred-2",
              kind: "range",
              subject: "SPY",
              measurableAs: "close(AAPL, +5) outside [190, 207]",
              horizonTradingDays: 5,
              probability: 0.37,
              sourceIds: ["news-equity-1"],
            },
          ]),
          tokenEstimate: 1,
        });
      },
    });

    expect(result.predictionErrors).toEqual([]);
    expect(result.predictionRetryErrors).toEqual([]);
    // No reprompt carried prediction errors: the withdrawn candidate never reached validation.
    expect(reprompts.filter((entry) => entry.predictionErrors !== undefined)).toEqual([]);
    expect(result.report.predictions.map((entry) => entry.id)).toEqual(["pred-1"]);
  });

  // RejectedCandidateCount does not advance on accepted candidates, so using it as a position
  // Reports an id-less withdrawn candidate under the index of whatever preceded it. The audit is
  // The only record of why a completion candidate was refused; pointing at the wrong one sends the
  // Next reader to the wrong place.
  test("labels an id-less withdrawn completion candidate with its real index", async () => {
    let call = 0;
    const result = await synthesizeReportUntilValid({
      runId: "run-1",
      generatedAt: "2026-05-19T00:00:00.000Z",
      command,
      collectedSources: sources(),
      context: context(),
      sources: [newsSource()],
      knownSourceIds: new Set(["news-equity-1"]),
      allowedSubjects: new Set(["AAPL"]),
      disallowedPredictionKinds: ["range"],
      priorStages: [],
      maxPredictionReprompts: 1,
      runFinalSynthesis: (_priorStages, reprompt) => {
        call += 1;
        if (reprompt?.predictionCompletion === undefined) {
          return Promise.resolve({
            stage: "final-synthesis" as const,
            content: reportPayload([
              {
                id: "pred-1",
                kind: "direction",
                subject: "AAPL",
                measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
                horizonTradingDays: 5,
                probability: 0.62,
                sourceIds: ["news-equity-1"],
              },
            ]),
            tokenEstimate: 1,
          });
        }
        return Promise.resolve({
          stage: "final-synthesis" as const,
          content: JSON.stringify({
            predictions: [
              // Index 0: accepted, so it never advances the rejection counter.
              {
                id: "pred-2",
                kind: "direction",
                subject: "AAPL",
                measurableAs: "close(AAPL, +10) > close(AAPL, 0)",
                horizonTradingDays: 10,
                probability: 0.62,
                sourceIds: ["news-equity-1"],
              },
              // Index 1: withdrawn and id-less, so the label falls back to the position.
              {
                kind: "range",
                subject: "AAPL",
                measurableAs: "close(AAPL, +5) outside [190, 207]",
                horizonTradingDays: 5,
                probability: 0.37,
                sourceIds: ["news-equity-1"],
              },
            ],
          }),
          tokenEstimate: 1,
        });
      },
    });

    expect(call).toBe(2);
    expect(result.predictionCompletion?.acceptedPredictionIds).toEqual(["pred-2"]);
    expect(result.predictionCompletion?.rejectionReasons).toContain(
      "Prediction at index 1: range forecasts are not solicited on this path",
    );
  });

  test("keeps range when no kind is withdrawn", async () => {
    const rangePrediction = {
      id: "pred-1",
      kind: "range",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) outside [190, 207]",
      horizonTradingDays: 5,
      probability: 0.37,
      sourceIds: ["news-equity-1"],
    };
    const result = await synthesizeReportUntilValid({
      runId: "run-1",
      generatedAt: "2026-05-19T00:00:00.000Z",
      command,
      collectedSources: sources(),
      context: context(),
      sources: [newsSource()],
      knownSourceIds: new Set(["news-equity-1"]),
      allowedSubjects: new Set(["AAPL"]),
      priorStages: [],
      maxPredictionReprompts: 1,
      runFinalSynthesis: () =>
        Promise.resolve({
          stage: "final-synthesis" as const,
          content: reportPayload([rangePrediction]),
          tokenEstimate: 1,
        }),
    });
    expect(result.report.predictions.map((entry) => entry.id)).toEqual(["pred-1"]);
    expect(result.predictionTrimWarnings).toEqual([]);
  });

  // The recursive report-repair call in buildReportWithRepair: reached only when a report is still
  // Invalid after the first validation retry. Predictions parse cleanly throughout, so this site
  // Carries no predictionErrors — and used to carry no survivors either.
  test("carries survivors on a recursive report repair with no prediction errors", async () => {
    const reprompts: StageReprompt[] = [];
    const validPrediction = {
      id: "pred-1",
      kind: "range",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) outside [190, 207]",
      horizonTradingDays: 5,
      probability: 0.37,
      sourceIds: ["news-equity-1"],
    };
    let calls = 0;

    await synthesizeReportUntilValid({
      runId: "run-1",
      generatedAt: "2026-05-19T00:00:00.000Z",
      command,
      collectedSources: sources(),
      context: context(),
      sources: [newsSource()],
      knownSourceIds: new Set(["news-equity-1"]),
      allowedSubjects: new Set(["AAPL"]),
      priorStages: [],
      maxPredictionReprompts: 1,
      runFinalSynthesis: (_priorStages, reprompt) => {
        calls += 1;
        if (reprompt !== undefined) {
          reprompts.push(reprompt);
        }
        // Findings without sourceIds fail report validation while the predictions stay valid.
        return Promise.resolve({
          stage: "final-synthesis" as const,
          content: reportPayload([validPrediction], calls <= 2 ? [] : ["news-equity-1"]),
          tokenEstimate: 1,
        });
      },
    });

    const recursiveRepair = reprompts.find(
      (entry) =>
        entry.predictionErrors === undefined && (entry.reportValidationErrors?.length ?? 0) > 0,
    );
    expect(recursiveRepair?.reportValidationErrors).toEqual([
      "Major findings must reference source IDs",
    ]);
    expect(recursiveRepair?.predictionErrors).toBeUndefined();
    expect(recursiveRepair?.retainedPredictions?.map((entry) => entry.id)).toEqual(["pred-1"]);
  });
});
