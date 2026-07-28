import { describe, expect, test } from "bun:test";
import type { InstrumentCommand } from "../src/cli/args";
import { buildDeepEquityModelPacket } from "../src/deep-equity/evidence";
import type { Prediction, VerifiedMarketSnapshot } from "../src/domain/types";
import { buildDepthProfile } from "../src/research/depth-profile";
import { buildSourceList } from "../src/research/report-assembly";
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
  verifiedMarketSnapshot,
} from "./support/fixtures";
import { config } from "./support/research-context-helpers";

// Protects the NBIS deep-equity prompt-token floor measured after the 2026-07-27 live pair.
// If this cap is hit, shrink the payload; never raise this cap or lower the token floor.
const PRICE_HISTORY_JSON_CHAR_CAP = 750;

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

function snapshotWithCloses(sessionCount: number): VerifiedMarketSnapshot {
  const recentCloses = Array.from({ length: sessionCount }, (_, index) => ({
    date: new Date(Date.UTC(2026, 2, index + 1)).toISOString().slice(0, 10),
    close: Number("216.47999572753906") + index * Number("1.3700027465820312"),
  }));
  const latest = recentCloses.at(-1)!;
  return verifiedMarketSnapshot({
    latestSessionDate: latest.date,
    ohlcv: { ...verifiedMarketSnapshot().ohlcv, date: latest.date, close: latest.close },
    indicators: {
      ema10: Number("219.64999389648438"),
      sma50: Number("203.3300018310547"),
      sma200: Number("178.94000244140625"),
      rsi14: Number("58.12345678901234"),
      macd: Number("4.769999980926514"),
      macdSignal: Number("3.859999895095825"),
      macdHistogram: Number("0.9100000858306885"),
      bollUpper: Number("274.87998962402344"),
      bollMiddle: Number("218.8800048828125"),
      bollLower: Number("162.88999938964844"),
      atr14: Number("12.34999942779541"),
    },
    recentCloses,
  });
}

function packetWithSnapshot(snapshot: VerifiedMarketSnapshot) {
  const bundle = deepEquityEvidenceBundle();
  return buildDeepEquityModelPacket({
    ...bundle,
    evidence: { ...bundle.evidence, verifiedMarketSnapshot: snapshot },
  });
}

function promptEvidence(prompt: string): Record<string, unknown> {
  return (JSON.parse(prompt) as { readonly evidence: Record<string, unknown> }).evidence;
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
  // Range was withdrawn from this path on 2026-07-27 and the paired evaluation measured the
  // Withdrawal as net negative: scenario-prediction-specificity went from legacy winning 4-of-6 to
  // 6-of-6 and rubric-non-inferiority flipped -0.194 -> -0.722. It is reinstated, so the simplified
  // Steering must advertise range on the same surfaces every other path does. The band-sizing
  // Defect it was meant to fix is a missing-input problem, not a prompt problem.
  test("solicits range on every steering surface, same as the generic path", () => {
    const prompt = simplifiedFinalSynthesisPrompt();
    expect(prompt).toContain("outside [Lo, Hi] for range");
    expect(prompt).toContain("range (outside [Lo, Hi])");
    expect(prompt).toContain("stays-within-range");
    const shape = JSON.parse(prompt) as {
      readonly requiredShape: { readonly predictions: readonly { readonly kind: string }[] };
    };
    expect(shape.requiredShape.predictions[0]?.kind.split("|")).toContain("range");
  });

  test("keeps range guidance in the repair instruction", () => {
    const prompt = simplifiedFinalSynthesisPrompt({
      predictionRepromptErrors: ["Prediction pred-3: subject does not match measurableAs"],
    });
    expect(prompt).toContain("For range forecasts, vary the horizon or range bounds");
    expect(prompt).toContain("For ticker relative forecasts, use subject form TICKER:BENCHMARK");
  });

  test("names a retained range forecast in survivor guidance", () => {
    const prompt = simplifiedFinalSynthesisPrompt({
      predictionRepromptErrors: ["Prediction pred-3: subject does not match measurableAs"],
      retainedPredictions: [retainedRange, ...retained],
    });
    expect(prompt).toContain("already validated");
    expect(prompt).toContain("pred-7");
    expect(prompt).toContain("pred-2");
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
    expect(prompt).not.toContain("priceHistory");
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
    expect(prompt).not.toContain("priceHistory");
  });

  test("the equity-analysis stage requires provenance and two-sided valuation figures", async () => {
    const loadedEquityAnalysis = await loadStagePrompt("equity-analysis", command, "prompts");
    expect(loadedEquityAnalysis.goal).toContain("even when it arrives already computed");
    expect(loadedEquityAnalysis.goal).toContain("the peer median and the spread around it");
  });
});

describe("simplified deep-equity price history", () => {
  test("carries the rounded bounded series and width-relevant indicators on the primary pass", () => {
    const snapshot = snapshotWithCloses(30);
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshot(snapshot),
      }),
    );
    const priceHistory = evidence.priceHistory as Record<string, unknown>;

    expect(priceHistory.closes).toEqual(
      snapshot.recentCloses.map((bar) => Number(bar.close.toFixed(2))),
    );
    expect(priceHistory.closes).toHaveLength(30);
    expect(priceHistory.sourceId).toBe("verified-snapshot-AAPL");
    expect(priceHistory.indicators).toEqual({
      atr14: 12.35,
    });
    expect(priceHistory).not.toHaveProperty("symbol");
    expect(priceHistory).not.toHaveProperty("sessionCount");
    expect(priceHistory.latestClose).toBe(Number(snapshot.ohlcv.close.toFixed(2)));
    expect(priceHistory.latestSessionDate).toBe(snapshot.latestSessionDate);
    expect(priceHistory.usage).not.toContain("current quote");
    expect(priceHistory.usage).not.toContain("impliedPriceRange");
  });

  test("carries the same block alongside latestClose on the completion pass", () => {
    const snapshot = snapshotWithCloses(30);
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshot(snapshot),
        predictionCompletion: {
          requestedCount: 2,
          existingPredictions: retained,
          reportDraft: researchReport(),
        },
      }),
    );

    expect(evidence.priceHistory).toBeDefined();
    expect(evidence.latestClose).toBeDefined();
  });

  test("keeps only the newest 30 sessions", () => {
    const snapshot = snapshotWithCloses(60);
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshot(snapshot),
      }),
    );
    const priceHistory = evidence.priceHistory as Record<string, unknown>;

    expect(priceHistory.closes).toHaveLength(30);
    expect(priceHistory.windowStartDate).toBe(snapshot.recentCloses.at(-30)?.date);
  });

  test("keeps every available session when the window is shorter than 30", () => {
    const snapshot = snapshotWithCloses(12);
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshot(snapshot),
      }),
    );
    const priceHistory = evidence.priceHistory as Record<string, unknown>;

    expect(priceHistory.windowStartDate).toBe(snapshot.recentCloses[0]?.date);
    expect(priceHistory.closes).toEqual(
      snapshot.recentCloses.map((bar) => Number(bar.close.toFixed(2))),
    );
    expect(priceHistory.closes).toHaveLength(12);
  });

  test("keeps the projected block under its character cap", () => {
    const snapshot = snapshotWithCloses(30);
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshot(snapshot),
      }),
    );

    expect(JSON.stringify(evidence.priceHistory).length).toBeLessThan(PRICE_HISTORY_JSON_CHAR_CAP);
  });

  test("omits the block when the verified snapshot is absent", () => {
    const evidence = promptEvidence(simplifiedFinalSynthesisPrompt());

    expect(evidence).not.toHaveProperty("priceHistory");
    expect(evidence.run).toEqual({ symbol: "AAPL", analysisAsOf: "2026-05-19T00:00:00.000Z" });
    expect(evidence.canonicalSourceIndex).toBeDefined();
  });

  test("omits the block when the verified snapshot has no recent closes", () => {
    const snapshot = verifiedMarketSnapshot({ recentCloses: [] });
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshot(snapshot),
      }),
    );

    expect(evidence).not.toHaveProperty("priceHistory");
  });

  test("emits a source id that resolves through report assembly", () => {
    const snapshot = snapshotWithCloses(30);
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshot(snapshot),
      }),
    );
    const { sourceId } = evidence.priceHistory as { readonly sourceId: string };
    const sourceIds = buildSourceList(command, sources({ verifiedMarketSnapshot: snapshot })).map(
      (source) => source.id,
    );

    // Narrowly guards the instrument-command source-assembly gate; both sides intentionally share
    // The verified-snapshot ID contract, so this is not independent end-to-end ID derivation proof.
    expect(sourceIds).toContain(sourceId);
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

  // Runtime counterpart of the reinstatement: nothing between the model and report assembly may
  // Drop a range forecast on this path.
  test("keeps a range forecast through synthesis and assembly", async () => {
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
