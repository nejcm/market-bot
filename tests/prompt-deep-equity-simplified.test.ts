import { describe, expect, test } from "bun:test";
import type { InstrumentCommand } from "../src/cli/args";
import { buildDeepEquityModelPacket } from "../src/deep-equity/evidence";
import type { MarketSnapshot, Prediction, VerifiedMarketSnapshot } from "../src/domain/types";
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
import type {
  FundamentalHistoryArtifact,
  FundamentalHistorySeries,
} from "../src/sources/extended-evidence/fundamental-history";
import type {
  PeerImpliedRange,
  ValuationCompsArtifact,
} from "../src/sources/extended-evidence/valuation-comps";
import type { CollectedSources } from "../src/sources/types";
import {
  collectedSources,
  deepEquityEvidenceBundle,
  marketSnapshot,
  newsSource,
  prediction,
  researchReport,
  valuationWorkbench,
  verifiedMarketSnapshot,
} from "./support/fixtures";
import {
  captureProvider,
  type CapturedModelCall,
  type CapturedModelExchange,
} from "./support/model-call-capture";
import { config } from "./support/research-context-helpers";
import { loadFixture, runFixture } from "./support/run-fixtures";
import { makeReplayProvider } from "./support/run-fixtures/llm-cassette";

// Protects the NBIS deep-equity prompt-token floor measured after the 2026-07-27 live pair.
// Raised from 750 to 850 on 2026-07-29 by explicit user decision, and the distinction matters.
// This is a re-baseline against inputs the old number never covered, not a floor lowered to pass.
// The payload did not grow: five-digit closes reach 751-753 characters and six-digit closes reach 785.
// A JPY or KRW listing quotes in five digits and BRK-A quotes in six, and the CLI accepts both.
// The cost of carrying them is roughly 9-25 prompt tokens against a tripwire at 33.80% median versus a 25% floor.
// Shrinking instead would have cost sessions from the 30-close window that centred simplified bands at 0.00%.
// The original instruction still holds in its intended sense: if payload growth hits this cap, shrink the payload.
const PRICE_HISTORY_JSON_CHAR_CAP = 850;

// Protects the token-reduction floor for the added centring input.
// If this cap is hit, shrink the payload; never raise this cap or lower the token floor.
const CURRENT_PRICE_JSON_CHAR_CAP = 550;

// Protects the token-reduction headroom for the bounded report-writing evidence.
// If this cap is hit, shrink the projection; do not raise it without re-running the token gate.
const FINAL_FIGURE_JSON_CHAR_CAP = 6500;

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

// The snapshotWithCloses ramp has a width pinned by construction, so the cap cannot fail on it.
// Number(x.toFixed(2)) also drops trailing-zero cents there, making it narrower than it looks.
// This helper is the widest realistic shape: six-digit closes whose cents never end in zero.
// A US listing quotes there (BRK-A) and so does any JPY or KRW listing, so it is not an exotic input.
function snapshotWithWideCloses(sessionCount: number): VerifiedMarketSnapshot {
  const recentCloses = Array.from({ length: sessionCount }, (_, index) => ({
    date: new Date(Date.UTC(2026, 2, index + 1)).toISOString().slice(0, 10),
    close: Number((780_000 + index * 137 + (((index * 7) % 9) + 1) / 100).toFixed(2)),
  }));
  const latest = recentCloses.at(-1)!;
  const base = verifiedMarketSnapshot();
  return verifiedMarketSnapshot({
    latestSessionDate: latest.date,
    ohlcv: { ...base.ohlcv, date: latest.date, close: latest.close },
    indicators: { ...base.indicators, atr14: 123.45 },
    recentCloses,
  });
}

// The committed deep-equity fixtures that reach final synthesis with a verified snapshot.
const PRICE_HISTORY_CAP_FIXTURES = [
  "equity-aapl-deep",
  "equity-nbis-deep",
  "equity-fpi-quarterly",
  "equity-fpi-ifrs-semiannual",
  "equity-analysis-comprehensive",
  "equity-analysis-estimated-suppressed",
] as const;

function packetWithSnapshot(snapshot: VerifiedMarketSnapshot) {
  const bundle = deepEquityEvidenceBundle();
  return buildDeepEquityModelPacket({
    ...bundle,
    evidence: { ...bundle.evidence, verifiedMarketSnapshot: snapshot },
  });
}

function packetWithSnapshotAndQuote(snapshot: VerifiedMarketSnapshot, quote: MarketSnapshot) {
  const bundle = deepEquityEvidenceBundle();
  return buildDeepEquityModelPacket({
    ...bundle,
    evidence: {
      ...bundle.evidence,
      marketSnapshots: [quote],
      verifiedMarketSnapshot: snapshot,
    },
  });
}

const derivedImpliedPriceRange: PeerImpliedRange = {
  status: "derived",
  label: "peer-implied price reference range",
  basis: "peer EV/annualized revenue percentiles applied to target annualized revenue",
  formula: "impliedPrice(m) = (m × annualizedRevenue − netDebt) / sharesOutstanding",
  inputs: {
    peerP25EvToAnnualizedRevenue: 2,
    peerMedianEvToAnnualizedRevenue: 3,
    peerP75EvToAnnualizedRevenue: 4,
    annualizedRevenue: 1000,
    netDebt: 100,
    sharesOutstanding: 50,
    currentPrice: 59,
    quoteCurrency: "USD",
    quoteObservedAt: "2026-05-19T00:00:00.000Z",
  },
  low: 38,
  mid: 58,
  high: 78,
  position: "within-range",
};

const projectedDerivedImpliedPriceRange = {
  status: "derived",
  label: "peer-implied price reference range",
  basis: "peer EV/annualized revenue percentiles applied to target annualized revenue",
  formula: "impliedPrice(m) = (m × annualizedRevenue − netDebt) / sharesOutstanding",
  inputs: {
    peerP25EvToAnnualizedRevenue: 2,
    peerMedianEvToAnnualizedRevenue: 3,
    peerP75EvToAnnualizedRevenue: 4,
    annualizedRevenue: 1000,
    netDebt: 100,
    sharesOutstanding: 50,
    quoteCurrency: "USD",
  },
  low: 38,
  mid: 58,
  high: 78,
} as const;

const suppressedImpliedPriceRange: PeerImpliedRange = {
  status: "suppressed",
  label: "peer-implied price reference range",
  basis: "peer EV/annualized revenue percentiles applied to target annualized revenue",
  formula: "impliedPrice(m) = (m × annualizedRevenue − netDebt) / sharesOutstanding",
  inputs: {
    peerP25EvToAnnualizedRevenue: null,
    peerMedianEvToAnnualizedRevenue: null,
    peerP75EvToAnnualizedRevenue: null,
    annualizedRevenue: null,
    netDebt: null,
    sharesOutstanding: null,
    currentPrice: null,
    quoteCurrency: null,
    quoteObservedAt: null,
  },
  suppressedReason: "peer percentile inputs are unavailable",
};

function emptyFundamentalHistorySeries(
  key: FundamentalHistorySeries["key"],
  label: string,
  unit: FundamentalHistorySeries["unit"],
): FundamentalHistorySeries {
  return {
    key,
    label,
    unit,
    annual: [],
    notes: [],
  };
}

function fundamentalHistoryFixture(): FundamentalHistoryArtifact {
  return {
    version: 1,
    generatedAt: "2026-05-19T00:00:00.000Z",
    symbol: "AAPL",
    sourceId: "extended-sec-edgar-aapl-fundamentals",
    series: {
      revenue: {
        key: "revenue",
        label: "Revenue",
        unit: "currency",
        annual: [],
        ttm: {
          value: 420_000_000_000,
          form: "TTM",
          fy: 2026,
          fp: "TTM",
          periodStart: "2025-04-01",
          periodEnd: "2026-03-31",
          periodMonths: 12,
          filedAt: "2026-05-01",
          currency: "USD",
        },
        cagr: {
          percent: 8.2,
          years: 3,
          periodStart: "2023-03-31",
          periodEnd: "2026-03-31",
        },
        notes: ["TTM is derived from reported quarterly periods."],
      },
      grossProfit: emptyFundamentalHistorySeries("grossProfit", "Gross profit", "currency"),
      operatingIncome: emptyFundamentalHistorySeries(
        "operatingIncome",
        "Operating income",
        "currency",
      ),
      netIncome: emptyFundamentalHistorySeries("netIncome", "Net income", "currency"),
      dilutedEps: emptyFundamentalHistorySeries("dilutedEps", "Diluted EPS", "per-share"),
      operatingCashFlow: emptyFundamentalHistorySeries(
        "operatingCashFlow",
        "Operating cash flow",
        "currency",
      ),
      capex: emptyFundamentalHistorySeries("capex", "Capital expenditures", "currency"),
      freeCashFlowProxy: emptyFundamentalHistorySeries(
        "freeCashFlowProxy",
        "Free cash flow proxy",
        "currency",
      ),
      grossMargin: emptyFundamentalHistorySeries("grossMargin", "Gross margin", "ratio"),
      operatingMargin: emptyFundamentalHistorySeries(
        "operatingMargin",
        "Operating margin",
        "ratio",
      ),
      netMargin: emptyFundamentalHistorySeries("netMargin", "Net margin", "ratio"),
    },
  };
}

function valuationCompsFixture(
  impliedPriceRange: PeerImpliedRange | undefined = derivedImpliedPriceRange,
): ValuationCompsArtifact {
  return {
    version: 1,
    generatedAt: "2026-05-19T00:00:00.000Z",
    target: { symbol: "AAPL", sourceIds: ["market-aapl"], usable: true },
    peers: [],
    excludedPeers: [
      {
        symbol: "PEER",
        role: "core",
        reason: "market-cap gate failed",
        sourceIds: ["market-peer"],
      },
    ],
    peerUniverseSourceIds: [],
    summary: {
      corePeerCount: 1,
      secondaryPeerCount: 0,
      usablePeerCount: 0,
      valuationSupportability: "screening-only",
    },
    ...(impliedPriceRange !== undefined ? { impliedPriceRange } : {}),
    sourceIds: ["market-aapl"],
    freshnessFlags: {
      targetQuoteFresh: true,
      targetSecFresh: true,
      peerQuoteFresh: false,
      peerSecFresh: false,
    },
  };
}

function packetWithFinalFigures(
  quote: MarketSnapshot = marketSnapshot({
    sourceId: "market-aapl",
    marketCap: 3_100_000_000_000,
    fundamentals: {
      trailingPE: 31.2,
      forwardPE: 27.4,
      epsForward: 7.3,
      epsTrailingTwelveMonths: 6.4,
      sharesOutstanding: 15_000_000_000,
      priceToBook: 45.1,
      bookValue: 4.5,
    },
  }),
  impliedPriceRange: PeerImpliedRange | undefined = derivedImpliedPriceRange,
) {
  const bundle = deepEquityEvidenceBundle();
  return buildDeepEquityModelPacket({
    ...bundle,
    evidence: { ...bundle.evidence, marketSnapshots: [quote] },
    derived: {
      ...bundle.derived,
      fundamentalHistory: fundamentalHistoryFixture(),
      valuationComps: valuationCompsFixture(impliedPriceRange),
      valuationWorkbench: valuationWorkbench(),
    },
  });
}

function promptEvidence(prompt: string): Record<string, unknown> {
  return (JSON.parse(prompt) as { readonly evidence: Record<string, unknown> }).evidence;
}

function boundedFigurePayload(evidence: Record<string, unknown>): Record<string, unknown> {
  return {
    issuerFundamentals: evidence.issuerFundamentals,
    valuation: evidence.valuation,
    fundamentalHistory: evidence.fundamentalHistory,
    figureUsage: evidence.figureUsage,
  };
}

async function capturedPrimaryFinalEvidence(fixtureName: string): Promise<Record<string, unknown>> {
  const fixture = await loadFixture(fixtureName);
  const modelCalls: CapturedModelCall[] = [];
  const transcript: CapturedModelExchange[] = [];
  const result = await runFixture(fixtureName, {
    llm: "replay",
    reasoningVariant: "simplified",
    provider: captureProvider(makeReplayProvider(fixture.llmCassette), modelCalls, transcript),
  });
  try {
    const exchange = transcript.find((entry) => entry.stage === "final-synthesis");
    const content = exchange?.messages.findLast((message) => message.role === "user")?.content;
    if (content === undefined) {
      throw new Error(`missing primary final-synthesis prompt for ${fixtureName}`);
    }
    return (JSON.parse(content) as { readonly evidence: Record<string, unknown> }).evidence;
  } finally {
    await result.cleanup();
  }
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
    expect(prompt).not.toContain("currentPriceReference");
    expect(prompt).toContain("outside [Lo, Hi] for range");
  });

  test("defines derived by provenance, not by who did the arithmetic", () => {
    const prompt = simplifiedFinalSynthesisPrompt();
    expect(prompt).toContain("observed only where a filing, statement, or quote reports it");
    expect(prompt).toContain("even when the packet supplies it already computed");
    expect(prompt).toContain("peer-implied range");
    expect(prompt).toContain("do not merge the two into one market state");
  });

  test("treats a material live-versus-verified price gap as a contradiction to surface", () => {
    const prompt = simplifiedFinalSynthesisPrompt();
    expect(prompt).toContain("a contradiction in the evidence rather than a labelling detail");
    expect(prompt).toContain("carry it into the downside and counterevidence discussion");
    expect(prompt).toContain("name it in the uncertainty and gap disclosure");
    // The immaterial and no-quote paths must not be pushed into inventing a conflict.
    expect(prompt).toContain("do not construct a conflict the figures do not show");
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
    expect(prompt).not.toContain("currentPriceReference");
    expect(prompt).not.toContain("issuerFundamentals");
    expect(prompt).not.toContain('"valuation"');
    expect(prompt).not.toContain("fundamentalHistory");
    expect(prompt).not.toContain("figureUsage");
  });

  test("the equity-analysis stage requires provenance and two-sided valuation figures", async () => {
    const loadedEquityAnalysis = await loadStagePrompt("equity-analysis", command, "prompts");
    expect(loadedEquityAnalysis.goal).toContain("even when it arrives already computed");
    expect(loadedEquityAnalysis.goal).toContain("the peer median and the spread around it");
  });
});

describe("simplified deep-equity final figure evidence", () => {
  test("projects issuer, valuation, and headline history fields on the primary pass", () => {
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({ deepEquityModelPacket: packetWithFinalFigures() }),
    );
    const issuerFundamentals = evidence.issuerFundamentals as Record<string, unknown>;
    const valuation = evidence.valuation as {
      readonly valuationComps: Record<string, unknown>;
      readonly valuationWorkbench: {
        readonly historicalMultiples: Record<string, unknown>;
      };
    };
    const fundamentalHistory = evidence.fundamentalHistory as {
      readonly sourceId: string;
      readonly series: { readonly revenue: Record<string, unknown> };
    };

    expect(issuerFundamentals).toEqual({
      sourceId: "market-aapl",
      marketCap: 3_100_000_000_000,
      trailingPE: 31.2,
      forwardPE: 27.4,
      priceToBook: 45.1,
      bookValue: 4.5,
      epsTrailingTwelveMonths: 6.4,
      epsForward: 7.3,
      sharesOutstanding: 15_000_000_000,
    });
    expect(issuerFundamentals).not.toHaveProperty("price");
    expect(issuerFundamentals).not.toHaveProperty("observedAt");
    expect(valuation.valuationComps).toEqual({
      summary: valuationCompsFixture().summary,
      impliedPriceRange: projectedDerivedImpliedPriceRange,
      excludedPeers: valuationCompsFixture().excludedPeers,
    });
    expect(valuation.valuationComps.impliedPriceRange).not.toHaveProperty("inputs.currentPrice");
    expect(valuation.valuationComps.impliedPriceRange).not.toHaveProperty("inputs.quoteObservedAt");
    expect(valuation.valuationComps.impliedPriceRange).not.toHaveProperty("position");
    expect(valuation.valuationWorkbench).toEqual({
      historicalMultiples: {
        trailingBasis: valuationWorkbench().historicalMultiples.trailingBasis,
        priceSelectionRule: valuationWorkbench().historicalMultiples.priceSelectionRule,
        suppressionReasons: valuationWorkbench().historicalMultiples.suppressionReasons,
      },
    });
    expect(fundamentalHistory.sourceId).toBe("extended-sec-edgar-aapl-fundamentals");
    expect(fundamentalHistory.series.revenue).toEqual({
      ttm: fundamentalHistoryFixture().series.revenue.ttm,
      cagr: fundamentalHistoryFixture().series.revenue.cagr,
      notes: fundamentalHistoryFixture().series.revenue.notes,
    });
    expect(fundamentalHistory.series.revenue).not.toHaveProperty("annual");
    expect(fundamentalHistory.series.revenue).not.toHaveProperty("label");
    expect(fundamentalHistory.series.revenue).not.toHaveProperty("unit");
    expect(evidence.figureUsage).toContain("reportConstraints.derivedFigures");
    expect(evidence.figureUsage).toContain("omits live-price comparison fields");
    expect(JSON.stringify(boundedFigurePayload(evidence))).not.toContain("null");
  });

  test("omits suppressed ranges and undefined fundamentals without emitting nulls", () => {
    const quote = marketSnapshot({
      fundamentals: {
        forwardPE: 27.4,
      },
    });
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithFinalFigures(quote, suppressedImpliedPriceRange),
      }),
    );
    const issuerFundamentals = evidence.issuerFundamentals as Record<string, unknown>;
    const valuation = evidence.valuation as {
      readonly valuationComps: Record<string, unknown>;
    };
    const boundedPayload = boundedFigurePayload(evidence);

    expect(issuerFundamentals).toEqual({ sourceId: "market-aapl", forwardPE: 27.4 });
    expect(issuerFundamentals).not.toHaveProperty("marketCap");
    expect(issuerFundamentals).not.toHaveProperty("trailingPE");
    expect(issuerFundamentals).not.toHaveProperty("sharesOutstanding");
    expect(valuation.valuationComps).not.toHaveProperty("impliedPriceRange");
    expect(JSON.stringify(boundedPayload)).not.toContain("null");
  });

  test("keeps report-writing figures off the distilled completion pass", () => {
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithFinalFigures(),
        predictionCompletion: {
          requestedCount: 2,
          existingPredictions: retained,
          reportDraft: researchReport(),
        },
      }),
    );

    expect(evidence).not.toHaveProperty("issuerFundamentals");
    expect(evidence).not.toHaveProperty("valuation");
    expect(evidence).not.toHaveProperty("fundamentalHistory");
    expect(evidence).not.toHaveProperty("figureUsage");
  });

  test("keeps the real comprehensive payload price-clean and under its character cap", async () => {
    const evidence = await capturedPrimaryFinalEvidence("equity-analysis-comprehensive");
    const currentPriceReference = evidence.currentPriceReference as {
      readonly price: number;
      readonly observedAt: string;
    };
    const serialized = JSON.stringify(boundedFigurePayload(evidence));

    expect(serialized.length).toBeLessThan(FINAL_FIGURE_JSON_CHAR_CAP);
    expect(serialized).not.toContain(String(currentPriceReference.price));
    expect(serialized).not.toContain(currentPriceReference.observedAt);
    expect(serialized).not.toContain("observedAt");
    expect(serialized).not.toContain("quoteObservedAt");
    // A position verdict states where the live price sits, leaking the quote by implication.
    expect(serialized).not.toContain("position");
    expect(serialized).not.toContain('"currentPrice"');
    expect(serialized).not.toContain("null");
  }, 30_000);
});

describe("simplified deep-equity current price reference", () => {
  // The quoteTimeUtc field is persisted evidence with no consumer yet (ADR 0004, amended 2026-07-29).
  // The canonicalFacts field carries snapshots into equity-analysis and critique wholesale.
  // The forPrompt projection prevents the field from changing prompt bytes on every deep run.
  // The final-synthesis stage does not embed canonicalFacts, so this test targets earlier stages.
  test.each(["equity-analysis", "critique"] as const)(
    "keeps quoteTimeUtc out of the %s prompt payload",
    (stage) => {
      const snapshot = snapshotWithCloses(30);
      const quote = {
        ...marketSnapshot({
          symbol: "aapl",
          sourceId: "market-yahoo-equity-aapl",
          price: 198.5,
          observedAt: "2026-05-19T14:31:00.000Z",
          quoteTimeUtc: "2026-05-19T14:29:07.000Z",
        }),
        futurePersistedField: "model-invisible-until-allowed",
      };

      const prompt = buildStagePrompt(
        stage,
        stageInput({ deepEquityModelPacket: packetWithSnapshotAndQuote(snapshot, quote) }),
      );

      // Proves the snapshot really reached this prompt, so the assertions below are not vacuous.
      expect(prompt).toContain("market-yahoo-equity-aapl");
      expect(prompt).toContain("2026-05-19T14:31:00.000Z");
      expect(prompt).not.toContain("quoteTimeUtc");
      expect(prompt).not.toContain("2026-05-19T14:29:07.000Z");
      expect(prompt).not.toContain("futurePersistedField");
      expect(prompt).not.toContain("model-invisible-until-allowed");
    },
  );

  test("emits the live quote as the current price reference", () => {
    const snapshot = snapshotWithCloses(30);
    const quote = marketSnapshot({
      symbol: "aapl",
      sourceId: "market-yahoo-equity-aapl",
      price: 198.5,
      observedAt: "2026-05-19T14:31:00.000Z",
    });
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshotAndQuote(snapshot, quote),
      }),
    );

    expect(evidence.currentPriceReference).toEqual({
      status: "quote-observed",
      price: 198.5,
      observedAt: quote.observedAt,
      sourceId: "market-yahoo-equity-aapl",
      usage:
        "Most recent observed price for the run symbol: a live quote fetched at observedAt; cite sourceId for it. Use it — not a bar close or an implied range — wherever a claim needs the current market level, and carry observedAt with it. Where it diverges materially from priceHistory.latestClose, handle that gap as reportConstraints.snapshotRecency requires.",
    });
  });

  test("emits the live quote when no verified snapshot exists", () => {
    const bundle = deepEquityEvidenceBundle();
    const quote = marketSnapshot({
      price: 198.5,
      observedAt: "2026-05-19T14:31:00.000Z",
    });
    const packet = buildDeepEquityModelPacket({
      ...bundle,
      evidence: { ...bundle.evidence, marketSnapshots: [quote] },
    });
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({ deepEquityModelPacket: packet }),
    );
    const currentPriceReference = evidence.currentPriceReference as Record<string, unknown>;

    expect(currentPriceReference.status).toBe("quote-observed");
    expect(currentPriceReference.price).toBe(198.5);
    expect(currentPriceReference.observedAt).toBe(quote.observedAt);
  });

  test("passes quote currency through when identity carries it", () => {
    const snapshot = snapshotWithCloses(30);
    const quoteWithCurrency = marketSnapshot({
      identity: { quoteCurrency: "USD" },
      observedAt: "2026-05-19T14:31:00.000Z",
    });
    const quoteWithoutCurrency = marketSnapshot({
      observedAt: "2026-05-19T14:31:00.000Z",
    });
    const withCurrency = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshotAndQuote(snapshot, quoteWithCurrency),
      }),
    ).currentPriceReference as Record<string, unknown>;
    const withoutCurrency = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshotAndQuote(snapshot, quoteWithoutCurrency),
      }),
    ).currentPriceReference as Record<string, unknown>;

    expect(withCurrency.quoteCurrency).toBe("USD");
    expect(withoutCurrency).not.toHaveProperty("quoteCurrency");
  });

  test("never presents the dated bar as the current price", () => {
    const snapshot = snapshotWithCloses(30);
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshot(snapshot),
      }),
    );
    const currentPriceReference = evidence.currentPriceReference as Record<string, unknown>;

    expect(currentPriceReference.status).toBe("unavailable");
    expect(currentPriceReference.reason).toBe("no-quote");
    expect(currentPriceReference.usage).toContain("do not present it as the current price");
  });

  test("does not use a peer snapshot as the run symbol's current price", () => {
    const snapshot = snapshotWithCloses(30);
    const peerQuote = marketSnapshot({
      symbol: "MSFT",
      price: 420,
      observedAt: "2026-05-19T14:31:00.000Z",
    });
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshotAndQuote(snapshot, peerQuote),
      }),
    );
    const currentPriceReference = evidence.currentPriceReference as Record<string, unknown>;

    expect(currentPriceReference.status).toBe("unavailable");
    expect(currentPriceReference.reason).toBe("no-quote");
    expect(currentPriceReference).not.toHaveProperty("price");
  });

  test("does not claim recency for a quote older than the latest bar", () => {
    const snapshot = verifiedMarketSnapshot({ latestSessionDate: "2026-03-30" });
    const quote = marketSnapshot({
      price: 198.5,
      observedAt: "2026-02-01T14:31:00.000Z",
    });
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshotAndQuote(snapshot, quote),
      }),
    );
    const currentPriceReference = evidence.currentPriceReference as Record<string, unknown>;

    expect(currentPriceReference.status).toBe("unavailable");
    expect(currentPriceReference.reason).toBe("quote-older-than-latest-bar");
    expect(currentPriceReference).not.toHaveProperty("price");
  });

  test("omits the block when neither a quote nor a verified snapshot exists", () => {
    const evidence = promptEvidence(simplifiedFinalSynthesisPrompt());

    expect(evidence).not.toHaveProperty("currentPriceReference");
  });

  test("keeps the current price reference under its character cap", () => {
    const snapshot = snapshotWithCloses(30);
    const quote = marketSnapshot({
      identity: { quoteCurrency: "USD" },
      observedAt: "2026-05-19T14:31:00.000Z",
    });
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshotAndQuote(snapshot, quote),
      }),
    );

    expect(JSON.stringify(evidence.currentPriceReference).length).toBeLessThan(
      CURRENT_PRICE_JSON_CHAR_CAP,
    );
  });

  test("resolves the quote source id through report assembly", () => {
    const snapshot = snapshotWithCloses(30);
    const quote = marketSnapshot({
      sourceId: "market-yahoo-equity-aapl",
      observedAt: "2026-05-19T14:31:00.000Z",
    });
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshotAndQuote(snapshot, quote),
      }),
    );
    const { sourceId } = evidence.currentPriceReference as { readonly sourceId: string };
    const sourceIds = buildSourceList(
      command,
      sources({ marketSnapshots: [quote], verifiedMarketSnapshot: snapshot }),
    ).map((source) => source.id);

    expect(sourceIds).toContain(sourceId);
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
    const quote = marketSnapshot({ observedAt: "2026-05-19T14:31:00.000Z" });
    const evidence = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshotAndQuote(snapshot, quote),
        predictionCompletion: {
          requestedCount: 2,
          existingPredictions: retained,
          reportDraft: researchReport(),
        },
      }),
    );

    expect(evidence.currentPriceReference).toBeDefined();
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

  test("keeps the widest realistic price magnitude under its character cap", () => {
    const wide = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshot(snapshotWithWideCloses(30)),
      }),
    ).priceHistory as { readonly closes: readonly number[] };
    const ramp = promptEvidence(
      simplifiedFinalSynthesisPrompt({
        deepEquityModelPacket: packetWithSnapshot(snapshotWithCloses(30)),
      }),
    ).priceHistory;

    // Every close must serialize at its full width, or this guard is measuring the narrower shape.
    expect(wide.closes.every((close) => String(close).length === 9)).toBe(true);
    expect(JSON.stringify(wide).length).toBeGreaterThan(JSON.stringify(ramp).length);
    expect(JSON.stringify(wide).length).toBeLessThan(PRICE_HISTORY_JSON_CHAR_CAP);
  });

  test("keeps every committed fixture's emitted block under its character cap", async () => {
    for (const fixture of PRICE_HISTORY_CAP_FIXTURES) {
      const { priceHistory } = await capturedPrimaryFinalEvidence(fixture);

      expect(priceHistory).toBeDefined();
      expect(JSON.stringify(priceHistory).length).toBeLessThan(PRICE_HISTORY_JSON_CHAR_CAP);
    }
  }, 120_000);

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
