import type { InstrumentCommand } from "../../src/cli/args";
import { buildDeepEquityModelPacket } from "../../src/deep-equity/evidence";
import type { MarketSnapshot, VerifiedMarketSnapshot } from "../../src/domain/types";
import { buildDepthProfile } from "../../src/research/depth-profile";
import { loadSimplifiedDeepEquityPlaybookContext } from "../../src/research/deep-equity-reasoning";
import { loadStagePrompt } from "../../src/research/prompt-loader";
import { buildStagePrompt, type StageInput } from "../../src/research/prompts";
import type { ResearchContext } from "../../src/research/research-context-types";
import { buildSourceList } from "../../src/research/report-assembly";
import { sanitizeMarketSnapshotMetadata } from "../../src/sources/metadata-sanitization";
import type { CollectedSources } from "../../src/sources/types";
import {
  collectedSources,
  deepEquityEvidenceBundle,
  marketSnapshot,
  newsSource,
  verifiedMarketSnapshot,
} from "./fixtures";
import { config } from "./research-context-helpers";

const ANALYSIS_AS_OF = "2026-05-19T00:00:00.000Z";

const command: InstrumentCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
};

function sanitizedSnapshot(): MarketSnapshot {
  return sanitizeMarketSnapshotMetadata(
    marketSnapshot({
      sourceId: "market-yahoo-equity-aapl",
      name: "Apple Inc.",
      identity: {
        quoteCurrency: "USD",
        providerIds: [{ provider: "yahoo", idKind: "symbol", value: "AAPL" }],
        displayName: "Apple Inc.",
        exchange: "NasdaqGS",
      },
      benchmark: {
        sourceId: "market-yahoo-equity-spy",
        symbol: "SPY",
        name: "S&P 500",
        basis: "broad-index",
        sector: "US equity",
        changePercent24h: 0.4,
        observedAt: ANALYSIS_AS_OF,
      },
      price: 198.5,
      changePercent24h: 1.25,
      volume: 52_000_000,
      marketCap: 3_000_000_000_000,
      fundamentals: {
        trailingPE: 31.2,
        forwardPE: 27.4,
        priceToBook: 45.1,
        epsTrailingTwelveMonths: 6.4,
        epsForward: 7.3,
        sharesOutstanding: 15_000_000_000,
      },
      observedAt: ANALYSIS_AS_OF,
      quoteTimeUtc: "2026-05-18T20:00:00.000Z",
    }),
    "yahoo",
  ).snapshot;
}

function sources(
  snapshot: MarketSnapshot,
  verifiedSnapshot: VerifiedMarketSnapshot,
): CollectedSources {
  if (snapshot.identity === undefined) {
    throw new Error("simplified prompt baseline snapshot requires instrument identity");
  }
  return collectedSources({
    marketSnapshots: [snapshot],
    newsSources: [
      newsSource({
        id: "news-aapl-earnings",
        title: "Apple quarterly update",
        summary: "Apple reported its quarterly results.",
        symbol: "AAPL",
      }),
    ],
    verifiedMarketSnapshot: verifiedSnapshot,
    resolvedInstrumentIdentity: snapshot.identity,
    businessFramework: {
      version: 1,
      generatedAt: ANALYSIS_AS_OF,
      symbol: "AAPL",
      phase: "capital-return",
      sections: [
        {
          name: "Business",
          posture: "criteria-supported",
          summary: "Business criteria-supported.",
          metrics: [],
          sourceIds: ["market-yahoo-equity-aapl"],
          gaps: [],
        },
      ],
      sourceIds: ["market-yahoo-equity-aapl"],
      gaps: [],
    },
  });
}

function baseContext(): ResearchContext {
  const depthProfile = buildDepthProfile(command, config);
  return {
    analysisAsOf: ANALYSIS_AS_OF,
    depthProfile,
    runParams: {
      quickModel: "quick-test",
      synthesisModel: "synthesis-test",
      analystStyle: "fuller analyst-style",
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
      proxyCount: 2,
      drivers: ["Mixed breadth"],
      sourceIds: ["market-yahoo-equity-spy"],
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

export interface SimplifiedPromptBaselineCase {
  readonly key: "equity-analysis" | "critique" | "final-synthesis";
  readonly text: string;
}

export interface SimplifiedPromptBaselineMatrix {
  readonly cases: readonly SimplifiedPromptBaselineCase[];
}

export async function simplifiedPromptBaselineMatrix(): Promise<SimplifiedPromptBaselineMatrix> {
  const sanitized = sanitizedSnapshot();
  const verifiedSnapshot = verifiedMarketSnapshot();
  const collected = sources(sanitized, verifiedSnapshot);
  if (collected.businessFramework === undefined) {
    throw new Error("simplified prompt baseline requires business framework evidence");
  }
  const context = await loadSimplifiedDeepEquityPlaybookContext(config.promptDir, baseContext());
  const bundle = deepEquityEvidenceBundle({
    evidence: {
      marketSnapshots: [sanitized],
      supplementalMarketSnapshots: [],
      newsSources: collected.newsSources,
      extendedSources: [],
      verifiedMarketSnapshot: verifiedSnapshot,
    },
    derived: {
      businessFramework: collected.businessFramework,
    },
  });
  const deepEquityModelPacket = buildDeepEquityModelPacket(bundle);
  const canonicalSources = buildSourceList(command, collected);
  const common = {
    command,
    collectedSources: collected,
    config,
    context,
    predictionRepromptErrors: [],
    reportValidationErrors: [],
    allowedSourceIds: canonicalSources.map((source) => source.id),
    deepEquityModelPacket,
    canonicalSources,
  } satisfies Omit<StageInput, "loaded" | "priorStages">;
  const equityAnalysisOutput = {
    stage: "equity-analysis",
    content:
      '{"findings":[{"text":"Quarterly evidence is mixed.","sourceIds":["news-aapl-earnings"]}],"dataGaps":[]}',
  };
  const critiqueOutput = {
    stage: "critique",
    content:
      '{"findings":[{"text":"The analysis needs stronger counterevidence.","sourceIds":["news-aapl-earnings"]}],"dataGaps":[]}',
  };
  const equityAnalysis = buildStagePrompt("equity-analysis", {
    ...common,
    loaded: await loadStagePrompt("equity-analysis", command, config.promptDir),
    priorStages: [],
  });
  const critique = buildStagePrompt("critique", {
    ...common,
    loaded: await loadStagePrompt("critique", command, config.promptDir),
    priorStages: [equityAnalysisOutput],
  });
  const finalSynthesis = buildStagePrompt("final-synthesis", {
    ...common,
    loaded: await loadStagePrompt("final-synthesis", command, config.promptDir),
    priorStages: [equityAnalysisOutput, critiqueOutput],
  });

  return {
    cases: [
      { key: "equity-analysis", text: equityAnalysis },
      { key: "critique", text: critique },
      { key: "final-synthesis", text: finalSynthesis },
    ],
  };
}
