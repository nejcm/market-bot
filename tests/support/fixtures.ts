import type {
  MarketSnapshot,
  Prediction,
  ResearchReport,
  RunTrace,
  Source,
  VerifiedMarketSnapshot,
} from "../../src/domain/types";
import { buildFailedRunManifest } from "../../src/run-artifact-writer";
import { RUN_ARTIFACT_FILES } from "../../src/run-artifact-layout";
import type { PredictionScore } from "../../src/scoring/types";
import type { CollectedSources } from "../../src/sources/types";
import type { DeepEquityEvidenceBundleV1 } from "../../src/deep-equity/types";
import type {
  ValuationMetricResult,
  ValuationWorkbenchArtifact,
} from "../../src/sources/extended-evidence/valuation-workbench-contract";
import {
  buildReverseDcf,
  type ReverseDcfArtifact,
} from "../../src/sources/extended-evidence/reverse-dcf";

const DEFAULT_OBSERVED_AT = "2026-05-19T00:00:00.000Z";

export function researchReport(overrides: Partial<ResearchReport> = {}): ResearchReport {
  return {
    runId: "run-1",
    jobType: "daily",
    assetClass: "equity",
    generatedAt: DEFAULT_OBSERVED_AT,
    summary: "",
    keyFindings: [],
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    confidence: "medium",
    dataGaps: [],
    predictions: [],
    sources: [],
    notFinancialAdvice: true,
    ...overrides,
  };
}

export function prediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    id: "pred-1",
    claim: "SPY closes higher over 5 trading days.",
    kind: "direction",
    subject: "SPY",
    measurableAs: "close(SPY, +5) > close(SPY, 0)",
    horizonTradingDays: 5,
    probability: 0.65,
    sourceIds: [],
    ...overrides,
  };
}

export function marketSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    sourceId: "market-aapl",
    assetClass: "equity",
    symbol: "AAPL",
    price: 100,
    changePercent24h: 2,
    volume: 1_000_000,
    observedAt: DEFAULT_OBSERVED_AT,
    ...overrides,
  };
}

export function newsSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "news-equity-1",
    title: "equity update",
    fetchedAt: DEFAULT_OBSERVED_AT,
    kind: "news",
    assetClass: "equity",
    ...overrides,
  };
}

export function verifiedMarketSnapshot(
  overrides: Partial<VerifiedMarketSnapshot> = {},
): VerifiedMarketSnapshot {
  return {
    symbol: "AAPL",
    assetClass: "equity",
    analysisDate: "2026-05-19",
    fetchedAt: DEFAULT_OBSERVED_AT,
    latestSessionDate: "2026-05-18",
    ohlcv: {
      date: "2026-05-18",
      open: 100,
      high: 110,
      low: 99,
      close: 108,
      volume: 1_000_000,
    },
    indicators: {
      ema10: 101,
      sma50: 102,
      sma200: null,
      rsi14: 55,
      macd: 1,
      macdSignal: 0.5,
      macdHistogram: 0.5,
      bollUpper: 120,
      bollMiddle: 100,
      bollLower: 80,
      atr14: 3,
    },
    recentCloses: [
      { date: "2026-05-15", close: 105 },
      { date: "2026-05-18", close: 108 },
    ],
    ...overrides,
  };
}

export function collectedSources(overrides: Partial<CollectedSources> = {}): CollectedSources {
  return {
    rawSnapshots: [],
    marketSnapshots: [],
    supplementalMarketSnapshots: [],
    newsSources: [],
    extendedSources: [],
    marketContextSources: [],
    sourceGaps: [],
    ...overrides,
  };
}

export function deepEquityEvidenceBundle(
  overrides: Partial<DeepEquityEvidenceBundleV1> = {},
): DeepEquityEvidenceBundleV1 {
  return {
    schemaVersion: 1,
    run: { symbol: "AAPL", analysisAsOf: DEFAULT_OBSERVED_AT },
    evidence: {
      marketSnapshots: [],
      supplementalMarketSnapshots: [],
      newsSources: [],
      extendedSources: [],
    },
    derived: {},
    governance: {
      sourceGaps: [],
      sourcePlan: {
        version: 2,
        generatedAt: DEFAULT_OBSERVED_AT,
        run: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
        lanes: [],
      },
      evidenceLanes: {
        version: 2,
        generatedAt: DEFAULT_OBSERVED_AT,
        lanes: [],
        summary: {
          plannedLaneCount: 0,
          coveredLaneCount: 0,
          gapLaneCount: 0,
          sourceCount: 0,
          gapCount: 0,
          coverageRatio: 0,
        },
      },
      sourceLedger: { version: 2, generatedAt: DEFAULT_OBSERVED_AT, sources: [] },
    },
    context: {
      historicalContext: {
        generatedAt: DEFAULT_OBSERVED_AT,
        recentDays: 90,
        anchorMonths: [],
        runs: [],
        sources: [],
        gaps: [],
        audit: {
          scannedRunCount: 0,
          malformedRunCount: 0,
          malformedScoreCount: 0,
          candidateRunCount: 0,
          selectedRunCount: 0,
          recentSelectedCount: 0,
          anchorSelectedCount: 0,
          sameSymbolSelectedCount: 0,
          spotlightSymbolSelectedCount: 0,
          sameSubjectSelectedCount: 0,
          sameHorizonSelectedCount: 0,
          crossHorizonSelectedCount: 0,
          resolvedMissRunCount: 0,
          missCorrectionSelectedCount: 0,
          gapCount: 0,
        },
        artifactDeltas: [],
      },
    },
    ...overrides,
  };
}

function populatedValuationMetric(
  value: number,
  numerator: number,
  denominator: number,
): ValuationMetricResult {
  return {
    status: "populated",
    value,
    display: `${value.toFixed(2)}x`,
    numerator,
    denominator,
    formula: "fixture numerator / fixture denominator",
    sourceIds: ["sec-fixture", "verified-snapshot-AAPL"],
  };
}

export function valuationWorkbench(
  overrides: Partial<ValuationWorkbenchArtifact> = {},
): ValuationWorkbenchArtifact {
  const input = {
    value: 100,
    label: "Revenue",
    periodEnd: "2025-12-31",
    publicAt: "2026-02-01",
    currency: "USD",
    unit: "USD",
    sourceIds: ["sec-fixture"],
  };
  return {
    version: 1,
    generatedAt: DEFAULT_OBSERVED_AT,
    analysisAsOf: DEFAULT_OBSERVED_AT,
    symbol: "AAPL",
    reportingCurrency: "USD",
    quoteCurrency: "USD",
    historicalMultiples: {
      priceSelectionRule: "first verified close within 7 calendar days on or after publicAt",
      observations: [
        {
          basis: "annual",
          periodEnd: "2025-12-31",
          publicAt: "2026-02-01",
          price: {
            close: 200,
            sessionDate: "2026-02-02",
            currency: "USD",
            sourceId: "verified-snapshot-AAPL",
          },
          inputs: {
            revenue: input,
            netIncome: { ...input, label: "Net income", value: 10 },
            dilutedEps: { ...input, label: "Diluted EPS", value: 2, unit: "USD/shares" },
            dilutedShares: {
              ...input,
              label: "Diluted shares",
              value: 50,
              currency: null,
              unit: "shares",
            },
            freeCashFlow: { ...input, label: "Free cash flow", value: 8 },
            cash: { ...input, label: "Cash", value: 5 },
            debt: { ...input, label: "Debt", value: 10 },
          },
          metrics: {
            priceToEarnings: populatedValuationMetric(100, 200, 2),
            priceToSales: populatedValuationMetric(100, 10_000, 100),
            enterpriseValueToRevenue: populatedValuationMetric(100.05, 10_005, 100),
            priceToFreeCashFlow: populatedValuationMetric(1250, 10_000, 8),
          },
          sourceIds: ["sec-fixture", "verified-snapshot-AAPL"],
        },
      ],
      trailingBasis: {
        status: "suppressed",
        reason: "canonical-ttm-unavailable",
        detail:
          "Canonical reconciled TTM is unavailable; retained quarter-only periods are not combined into an unreconciled TTM.",
        sourceIds: ["sec-fixture"],
      },
      suppressionReasons: [],
    },
    peerComparison: {
      status: "suppressed",
      reason: "peer-data-unavailable",
      detail: "Peer comparison data is unavailable for this run.",
      sourceIds: [],
    },
    sourceIds: ["sec-fixture", "verified-snapshot-AAPL"],
    ...overrides,
  };
}

export function reverseDcfWorkbench(): ValuationWorkbenchArtifact {
  const base = valuationWorkbench();
  const [observation] = base.historicalMultiples.observations;
  if (observation === undefined) {
    throw new Error("valuation workbench fixture observation missing");
  }
  return {
    ...base,
    historicalMultiples: {
      ...base.historicalMultiples,
      observations: [{ ...observation, basis: "ttm" }],
      trailingBasis: {
        status: "available",
        periodEnd: observation.periodEnd,
        publicAt: observation.publicAt,
        sourceIds: observation.sourceIds,
      },
    },
    peerComparison: {
      status: "available",
      valuationComps: {
        version: 1,
        generatedAt: DEFAULT_OBSERVED_AT,
        target: {
          symbol: "AAPL",
          enterpriseValue: 1000,
          quoteCurrency: "USD",
          quoteObservedAt: "2026-02-02",
          sourceIds: ["verified-snapshot-AAPL"],
          usable: true,
        },
        peers: [],
        excludedPeers: [],
        peerUniverseSourceIds: [],
        summary: {
          corePeerCount: 0,
          secondaryPeerCount: 0,
          usablePeerCount: 0,
          valuationSupportability: "screening-only",
        },
        sourceIds: ["verified-snapshot-AAPL"],
        freshnessFlags: {
          targetQuoteFresh: true,
          targetSecFresh: true,
          peerQuoteFresh: false,
          peerSecFresh: false,
        },
      },
    },
  };
}

export function reverseDcfArtifact(): ReverseDcfArtifact {
  return buildReverseDcf({
    generatedAt: DEFAULT_OBSERVED_AT,
    symbol: "AAPL",
    valuationWorkbench: reverseDcfWorkbench(),
  });
}

export function predictionScore(
  outcome: "hit" | "miss",
  overrides: Partial<PredictionScore> = {},
): PredictionScore {
  return {
    predictionId: "p",
    runId: "r",
    resolved: true,
    outcome,
    observedAt: DEFAULT_OBSERVED_AT,
    attemptCount: 1,
    evidence: {},
    ...overrides,
  };
}

// Writer-produced `outcomes.json` value for a Failed Run Artifact.
//
// Provider Health reads the `web-search-provider` outcome detail to report web-search degradation
// On runs that never wrote `analytics.json`. Hand-writing that shape in a reader test would let the
// Producer rename or drop a count without failing anything, so consumers build it through
// `buildFailedRunManifest` instead and the seam stays pinned.
export function failedRunOutcomesArtifact(
  webGatherAudit: NonNullable<RunTrace["webGatherLoop"]>,
): unknown {
  const generatedAt = DEFAULT_OBSERVED_AT;
  const { writes } = buildFailedRunManifest({
    command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
    runId: "failed-run",
    generatedAt,
    failedAt: generatedAt,
    message: "Report failed validation",
    reportValidationErrors: ["Report failed validation"],
    predictionErrors: [],
    totalCalls: 1,
    reportRepairReprompts: 0,
    stageOutputs: [],
    payload: {},
    collectedSources: collectedSources(),
    historicalContext: {
      generatedAt,
      recentDays: 90,
      anchorMonths: [],
      runs: [],
      sources: [],
      gaps: [],
      artifactDeltas: [],
      audit: {
        scannedRunCount: 0,
        malformedRunCount: 0,
        malformedScoreCount: 0,
        candidateRunCount: 0,
        selectedRunCount: 0,
        recentSelectedCount: 0,
        anchorSelectedCount: 0,
        sameSymbolSelectedCount: 0,
        spotlightSymbolSelectedCount: 0,
        sameSubjectSelectedCount: 0,
        sameHorizonSelectedCount: 0,
        crossHorizonSelectedCount: 0,
        resolvedMissRunCount: 0,
        missCorrectionSelectedCount: 0,
        gapCount: 0,
      },
    },
    sourcePlan: {
      version: 2,
      generatedAt,
      run: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      lanes: [],
    },
    evidenceLanes: {
      version: 2,
      generatedAt,
      lanes: [],
      summary: {
        plannedLaneCount: 0,
        coreLaneCount: 0,
        materialLaneCount: 0,
        supplementalLaneCount: 0,
        coveredLaneCount: 0,
        gapLaneCount: 0,
        coreGapLaneCount: 0,
        materialGapLaneCount: 0,
        sourceCount: 0,
        gapCount: 0,
        coverageRatio: 0,
      },
    },
    sourceLedger: { version: 2, generatedAt, sources: [] },
    webGatherAudit,
    playbookAudit: { selected: [], rejected: [] },
    evidenceQuality: {
      version: 1,
      rubricVersion: 3,
      label: "low",
      checks: [],
      limitingReasons: [],
      advisoryReasons: [],
    },
    codeVersion: { dirty: false },
  });
  return writes.find((write) => write.file === RUN_ARTIFACT_FILES.outcomes)?.value;
}
