import { describe, expect, test } from "bun:test";
import type { MarketContext, MarketSnapshot, ResearchReport, Source } from "../src/domain/types";
import { sourceGap } from "../src/domain/source-gaps";
import { renderMarkdownReport } from "../src/report/markdown";
import { violatesResearchOnly } from "../src/domain/research-language";
import { validateResearchReport } from "../src/report/schema";
import { assembleResearchReport, buildSourceList } from "../src/research/report-assembly";
import type { HistoricalResearchContext } from "../src/research/historical-context";
import type { DepthProfile, ResearchContext } from "../src/research/research-context";
import type { SpotlightSelectionResult } from "../src/research/spotlights";
import { collectedSources, marketSnapshot, newsSource, prediction } from "./support/fixtures";

const report: ResearchReport = {
  runId: "run-1",
  jobType: "crypto",
  assetClass: "crypto",
  symbol: "BTC",
  generatedAt: "2026-05-19T00:00:00.000Z",
  summary: "BTC evidence is mixed.",
  keyFindings: [{ text: "BTC liquidity remains high.", sourceIds: ["source-1"] }],
  bullCase: [],
  bearCase: [],
  risks: [{ text: "Volatility remains elevated.", sourceIds: ["source-1"] }],
  catalysts: [],
  scenarios: [
    { name: "Base", description: "Range-bound conditions persist.", sourceIds: ["source-1"] },
  ],
  confidence: "medium",
  dataGaps: ["No derivatives data"],
  predictions: [],
  sources: [
    {
      id: "source-1",
      title: "BTC market snapshot",
      fetchedAt: "2026-05-19T00:00:00.000Z",
      kind: "market-data",
      assetClass: "crypto",
      symbol: "BTC",
      identity: {
        quoteCurrency: "USD",
        providerIds: [{ provider: "coingecko", idKind: "coin-id", value: "bitcoin" }],
      },
    },
  ],
  notFinancialAdvice: true,
};

const spotlightSource: Source = {
  id: "market-yahoo-equity-roku",
  title: "ROKU market snapshot",
  fetchedAt: "2026-06-01T00:00:00.000Z",
  kind: "market-data",
  assetClass: "equity",
  symbol: "ROKU",
};

const assemblyTargetKindMix = { favored: ["relative", "range"] as const, minNonDirection: 1 };

function assemblyDepthProfile(subject = "SPY"): DepthProfile {
  return {
    depth: "brief",
    analystStyle: "concise brief",
    minimumKeyFindings: 0,
    minimumScenarios: 0,
    targetPredictions: 0,
    defaultPredictionHorizon: 5,
    predictionSubjects: [subject],
    focus: ["source gaps"],
    targetKindMix: assemblyTargetKindMix,
  };
}

function spotlightSelection(rationale = "Selector rationale"): SpotlightSelectionResult {
  return {
    rationale: "Selected current mover.",
    selected: [
      {
        symbol: "ROKU",
        rationale,
        sourceIds: [spotlightSource.id],
        candidate: {
          id: "spotlight-roku",
          symbol: "ROKU",
          assetClass: "equity",
          sourceIds: [spotlightSource.id],
          currentSnapshot: {
            price: 72,
            changePercent24h: 9.1,
            volume: 12_000_000,
            observedAt: "2026-06-01T00:00:00.000Z",
          },
          mover: {
            rank: 1,
            score: 90,
            features: {
              movementMagnitude: 9.1,
              benchmarkSymbol: "SPY",
              benchmarkChangePercent24h: 0.5,
              relativeChangePercent24h: 8.6,
              relativeMovementMagnitude: 8.6,
              liquidityLog: 20,
              baseScore: 90,
              unusualVolumeBoost: 0,
              gapBoost: 0,
              finalMultiplier: 1,
              reasons: ["large current move"],
            },
          },
          history: {
            tickerRunIds: [],
            marketRunIds: [],
          },
        },
      },
    ],
    rejected: [],
    audit: {
      cap: 2,
      candidateCount: 1,
      selectedCount: 1,
      rejectedCount: 0,
      malformed: false,
    },
  };
}

function assemblyContext(
  depthProfile: DepthProfile,
  selection?: SpotlightSelectionResult,
): ResearchContext {
  return {
    depthProfile,
    runParams: {
      quickModel: "quick",
      synthesisModel: "synthesis",
      modelParams: undefined,
      minimumKeyFindings: 0,
      minimumScenarios: 0,
      targetPredictions: 0,
      defaultPredictionHorizon: 5,
      predictionSubjects: depthProfile.predictionSubjects,
      focus: ["source gaps"],
      analystStyle: "concise brief",
      targetKindMix: assemblyTargetKindMix,
    },
    marketRegime: {
      assetClass: "equity",
      label: "insufficient-data",
      proxyCount: 0,
      drivers: [],
      sourceIds: [],
    },
    calibrationContext: undefined,
    ...(selection !== undefined ? { spotlightSelection: selection } : {}),
  };
}

function assembleWithSpotlights(
  extras: Record<string, unknown> | undefined,
  context: ResearchContext,
  command?:
    | { readonly jobType: "daily"; readonly assetClass: "equity"; readonly depth: "brief" }
    | {
        readonly jobType: "equity";
        readonly assetClass: "equity";
        readonly symbol: "ROKU";
        readonly depth: "brief";
      },
): ResearchReport {
  const resolvedCommand = command ?? { jobType: "daily", assetClass: "equity", depth: "brief" };
  return assembleResearchReport({
    runId: "spotlight-run",
    generatedAt: "2026-06-01T00:00:00.000Z",
    command: resolvedCommand,
    payload: {
      summary: "Spotlight assembly test.",
      confidence: "medium",
      ...(extras !== undefined ? { extras } : {}),
    },
    predResult: { predictions: [], errors: [] },
    collectedSources: collectedSources(),
    depthProfile: context.depthProfile,
    context,
    sources: [spotlightSource],
  });
}

describe("report schema and rendering", () => {
  test("validates source-linked findings", () => {
    expect(validateResearchReport(report)).toEqual(report);
  });

  test("validates web sources and web-subject-profile extended evidence", () => {
    const answer = {
      answer: "Apple sells devices and services.",
      sourceIds: ["web-aapl-12345678"],
    };
    const webReport: ResearchReport = {
      ...report,
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      keyFindings: [{ text: "AAPL web profile is cited.", sourceIds: ["web-aapl-12345678"] }],
      risks: [],
      scenarios: [],
      sources: [
        {
          id: "web-aapl-12345678",
          title: "AAPL company page",
          fetchedAt: "2026-05-19T00:00:00.000Z",
          kind: "web",
          assetClass: "equity",
          symbol: "AAPL",
          provider: "exa",
        },
      ],
      extendedEvidence: {
        instrument: { assetClass: "equity", symbol: "AAPL" },
        items: [
          {
            category: "web-subject-profile",
            title: "Web Subject Profile",
            summary: "Public web evidence captured for AAPL.",
            sourceIds: ["web-aapl-12345678"],
            observedAt: "2026-05-19T00:00:00.000Z",
          },
        ],
        gaps: [],
      },
      extras: {
        webSubjectProfile: {
          version: 2,
          generatedAt: "2026-05-19T00:00:00.000Z",
          subjectKind: "company",
          subjectId: "AAPL",
          subjectLabel: "Apple Inc.",
          symbol: "AAPL",
          companyName: "Apple Inc.",
          subjectSummary: answer,
          questions: {
            whatItDoes: answer,
            howItMakesMoney: answer,
            customers: answer,
            geography: answer,
            purchaseRecurrence: answer,
            pricingPower: answer,
            recessionCyclicality: answer,
          },
          recentMaterialEvents: [
            { claim: "Apple reports services revenue.", sourceIds: ["web-aapl-12345678"] },
          ],
          factLedger: [
            { claim: "Apple sells devices and services.", sourceIds: ["web-aapl-12345678"] },
          ],
          openGaps: [],
          sourceIds: ["web-aapl-12345678"],
        },
      },
    };

    const markdown = renderMarkdownReport(validateResearchReport(webReport));

    expect(markdown).toContain("AAPL web profile is cited. [web-aapl-12345678]");
    expect(markdown).toContain("## Extended Evidence");
    expect(markdown).toContain("## Web Subject Profile");
    expect(markdown).toContain("### Fact Ledger");
    expect(markdown).toContain("Apple sells devices and services. [web-aapl-12345678]");
    expect(markdown).toContain("- [web-aapl-12345678] AAPL company page");
  });

  test("rejects unknown source IDs in web-subject-profile extras", () => {
    const answer = { answer: "Apple sells devices and services.", sourceIds: ["unknown-web"] };
    const webReport: ResearchReport = {
      ...report,
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      keyFindings: [{ text: "AAPL web profile is cited.", sourceIds: ["web-aapl-12345678"] }],
      risks: [],
      scenarios: [],
      sources: [
        {
          id: "web-aapl-12345678",
          title: "AAPL company page",
          fetchedAt: "2026-05-19T00:00:00.000Z",
          kind: "web",
          assetClass: "equity",
          symbol: "AAPL",
          provider: "exa",
        },
      ],
      extras: {
        webSubjectProfile: {
          version: 2,
          generatedAt: "2026-05-19T00:00:00.000Z",
          subjectKind: "company",
          subjectId: "AAPL",
          subjectLabel: "Apple Inc.",
          symbol: "AAPL",
          companyName: "Apple Inc.",
          subjectSummary: answer,
          questions: {
            whatItDoes: answer,
            howItMakesMoney: answer,
            customers: answer,
            geography: answer,
            purchaseRecurrence: answer,
            pricingPower: answer,
            recessionCyclicality: answer,
          },
          recentMaterialEvents: [],
          factLedger: [{ claim: "Apple sells devices.", sourceIds: ["web-aapl-12345678"] }],
          openGaps: [],
          sourceIds: ["web-aapl-12345678"],
        },
      },
    };

    expect(() => validateResearchReport(webReport)).toThrow("Unknown source ID: unknown-web");
  });

  test("rejects unknown source kinds", () => {
    expect(() =>
      validateResearchReport({
        ...report,
        sources: [{ ...report.sources[0]!, kind: "unknown-kind" as never }],
      }),
    ).toThrow("Invalid Source kind: unknown-kind");
  });

  test("copies market snapshot identity into report sources", () => {
    const snapshot: MarketSnapshot = {
      sourceId: "market-coingecko-crypto-btc",
      assetClass: "crypto",
      symbol: "BTC",
      identity: {
        quoteCurrency: "USD",
        providerIds: [{ provider: "coingecko", idKind: "coin-id", value: "bitcoin" }],
      },
      price: 103_000,
      changePercent24h: 2,
      volume: 40_000_000_000,
      observedAt: "2026-05-19T00:00:00.000Z",
    };

    const sources = buildSourceList(
      { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "brief" },
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [snapshot],
        newsSources: [],
      }),
    );

    expect(sources[0]?.identity).toEqual(snapshot.identity);
    expect(sources[0]?.provider).toBe("coingecko");
  });

  test("stamps the asset-class market-data provider on mover snapshots", () => {
    const snapshot: MarketSnapshot = {
      sourceId: "market-yahoo-equity-aapl",
      assetClass: "equity",
      symbol: "AAPL",
      price: 200,
      changePercent24h: 1.2,
      volume: 50_000_000,
      observedAt: "2026-06-13T00:00:00.000Z",
    };

    const sources = buildSourceList(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [snapshot],
        newsSources: [],
      }),
    );

    expect(sources[0]?.provider).toBe("yahoo");
  });

  test("stamps the asset-class provider on supplemental market snapshots", () => {
    const snapshot: MarketSnapshot = {
      sourceId: "supplemental-market-massive-equity-aapl",
      assetClass: "equity",
      symbol: "AAPL",
      price: 200,
      changePercent24h: 1.2,
      volume: 50_000_000,
      observedAt: "2026-06-13T00:00:00.000Z",
    };

    const sources = buildSourceList(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      collectedSources({
        rawSnapshots: [],
        supplementalMarketSnapshots: [snapshot],
        newsSources: [],
      }),
    );

    expect(sources[0]?.provider).toBe("yahoo");
  });

  test("uses selected spotlights when model returns an empty spotlight list", () => {
    const depthProfile = assemblyDepthProfile();
    const assembled = assembleWithSpotlights(
      { spotlights: { items: [] } },
      assemblyContext(depthProfile, spotlightSelection()),
    );

    expect(assembled.extras?.spotlights).toEqual({
      rationale: "Selected current mover.",
      items: [
        {
          symbol: "ROKU",
          rationale: "Selector rationale",
          sourceIds: [spotlightSource.id],
        },
      ],
    });
  });

  test("uses selected spotlights when model omits spotlights", () => {
    const depthProfile = assemblyDepthProfile();
    const assembled = assembleWithSpotlights(
      undefined,
      assemblyContext(depthProfile, spotlightSelection("Default selected rationale")),
    );

    expect(assembled.extras?.spotlights).toEqual({
      rationale: "Selected current mover.",
      items: [
        {
          symbol: "ROKU",
          rationale: "Default selected rationale",
          sourceIds: [spotlightSource.id],
        },
      ],
    });
  });

  test("lets model refine rationale for selected spotlight without changing source IDs", () => {
    const depthProfile = assemblyDepthProfile();
    const assembled = assembleWithSpotlights(
      {
        spotlights: {
          rationale: "Model section rationale.",
          items: [
            {
              symbol: "ROKU",
              rationale: "Model refined rationale.",
              sourceIds: ["model-source-id"],
            },
          ],
        },
      },
      assemblyContext(depthProfile, spotlightSelection()),
    );

    expect(assembled.extras?.spotlights).toEqual({
      rationale: "Model section rationale.",
      items: [
        {
          symbol: "ROKU",
          rationale: "Model refined rationale.",
          sourceIds: [spotlightSource.id],
        },
      ],
    });
  });

  test("lets model refine selected spotlight rationale from text", () => {
    const depthProfile = assemblyDepthProfile();
    const assembled = assembleWithSpotlights(
      {
        spotlights: {
          items: [
            {
              symbol: "ROKU",
              text: "Model text rationale.",
              sourceIds: ["model-source-id"],
            },
          ],
        },
      },
      assemblyContext(depthProfile, spotlightSelection()),
    );

    expect(assembled.extras?.spotlights).toEqual({
      rationale: "Selected current mover.",
      items: [
        {
          symbol: "ROKU",
          rationale: "Model text rationale.",
          sourceIds: [spotlightSource.id],
        },
      ],
    });
  });

  test("ignores model spotlight symbols outside the selected set", () => {
    const depthProfile = assemblyDepthProfile();
    const assembled = assembleWithSpotlights(
      {
        spotlights: {
          items: [
            {
              symbol: "AAPL",
              rationale: "Model replacement rationale.",
              sourceIds: [spotlightSource.id],
            },
          ],
        },
      },
      assemblyContext(depthProfile, spotlightSelection()),
    );

    expect(assembled.extras?.spotlights).toEqual({
      rationale: "Selected current mover.",
      items: [
        {
          symbol: "ROKU",
          rationale: "Selector rationale",
          sourceIds: [spotlightSource.id],
        },
      ],
    });
  });

  test("keeps ticker model spotlights when no selected spotlights exist", () => {
    const depthProfile = assemblyDepthProfile("ROKU");
    const assembled = assembleWithSpotlights(
      {
        spotlights: {
          items: [
            {
              symbol: "ROKU",
              rationale: "Ticker-authored spotlight.",
              sourceIds: [spotlightSource.id],
            },
          ],
        },
      },
      assemblyContext(depthProfile),
      { jobType: "equity", assetClass: "equity", symbol: "ROKU", depth: "brief" },
    );

    expect(assembled.extras?.spotlights).toEqual({
      items: [
        {
          symbol: "ROKU",
          rationale: "Ticker-authored spotlight.",
          sourceIds: [spotlightSource.id],
        },
      ],
    });
  });

  test("builds, validates, renders, and scans market-overview catalyst calendar", () => {
    const macroSource: Source = {
      id: "market-context-fred",
      title: "FRED market context",
      fetchedAt: "2026-06-01T00:00:00.000Z",
      kind: "market-data",
      assetClass: "equity",
    };
    const marketContext: MarketContext = {
      assetClass: "equity",
      items: [
        {
          category: "fred-macro",
          title: "10Y yield update",
          summary: "Rates moved.",
          sourceIds: [macroSource.id],
          observedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      gaps: [],
    };
    const depthProfile = assemblyDepthProfile();
    const context = assemblyContext(depthProfile);
    const assembled = assembleResearchReport({
      runId: "run-1",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command: {
        jobType: "market-overview",
        assetClass: "equity",
        depth: "brief",
        horizonTradingDays: 7,
      },
      payload: {
        summary: "Market overview.",
        confidence: "medium",
        catalysts: [{ text: "CPI release on calendar.", sourceIds: [macroSource.id] }],
      },
      predResult: {
        predictions: [
          prediction({
            id: "pred-1",
            claim: "SPY closes higher over 7 trading days.",
            horizonTradingDays: 7,
            measurableAs: "close(SPY, +7) > close(SPY, 0)",
            sourceIds: [macroSource.id],
          }),
        ],
        errors: [],
      },
      collectedSources: collectedSources({
        marketContext,
        marketContextSources: [macroSource],
      }),
      depthProfile,
      context,
      sources: [macroSource],
    });
    const markdown = renderMarkdownReport(assembled);

    expect(assembled.extras?.catalystCalendar).toEqual({
      items: [
        {
          label: "CPI release on calendar.",
          sourceIds: [macroSource.id],
          sourceStatus: "sourced catalyst",
          researchRelevance: "watch item",
        },
        {
          date: "2026-06-01",
          label: "10Y yield update",
          sourceIds: [macroSource.id],
          sourceStatus: "observed macro context",
          researchRelevance: "macro release context",
        },
        {
          date: "2026-06-10",
          label: "Prediction pred-1 resolution date",
          sourceIds: [macroSource.id],
          sourceStatus: "observable forecast",
          researchRelevance: "prediction resolution",
        },
      ],
    });
    expect(markdown).toContain("## Catalyst Calendar");
    expect(markdown).toContain(
      "- CPI release on calendar. (sourced catalyst)[market-context-fred]",
    );
    expect(markdown).toContain(
      "- 2026-06-10: Prediction pred-1 resolution date (observable forecast)[market-context-fred]",
    );
    expect(
      violatesResearchOnly(markdown.slice(markdown.indexOf("## Catalyst Calendar"))),
    ).toBeNull();
  });

  test("rejects catalyst calendar entries with unknown source IDs", () => {
    expect(() =>
      validateResearchReport({
        ...report,
        extras: {
          catalystCalendar: {
            items: [{ label: "Unsourced calendar item", sourceIds: ["missing-source"] }],
          },
        },
      }),
    ).toThrow("Unknown source ID: missing-source");
  });

  test("dedupes model and deterministic data gaps by normalized text", () => {
    const command = {
      jobType: "daily" as const,
      assetClass: "equity" as const,
      depth: "brief" as const,
    };
    const targetKindMix = { favored: ["relative", "range"] as const, minNonDirection: 1 };
    const depthProfile: DepthProfile = {
      depth: "brief",
      analystStyle: "concise brief",
      minimumKeyFindings: 0,
      minimumScenarios: 0,
      targetPredictions: 0,
      defaultPredictionHorizon: 5,
      predictionSubjects: ["SPY"],
      focus: ["source gaps"],
      targetKindMix,
    };
    const context: ResearchContext = {
      depthProfile,
      runParams: {
        quickModel: "quick",
        synthesisModel: "synthesis",
        modelParams: undefined,
        minimumKeyFindings: 0,
        minimumScenarios: 0,
        targetPredictions: 0,
        defaultPredictionHorizon: 5,
        predictionSubjects: ["SPY"],
        focus: ["source gaps"],
        analystStyle: "concise brief",
        targetKindMix,
      },
      marketRegime: {
        assetClass: "equity",
        label: "insufficient-data",
        proxyCount: 0,
        drivers: [],
        sourceIds: [],
      },
      calibrationContext: undefined,
    };

    const assembled = assembleResearchReport({
      runId: "run-1",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command,
      payload: {
        summary: "Source coverage was constrained.",
        confidence: "low",
        dataGaps: ["massive-news: source request failed with status 403"],
      },
      predResult: { predictions: [], errors: [] },
      collectedSources: collectedSources({
        marketSnapshots: [
          {
            sourceId: "market-yahoo-equity-spy",
            assetClass: "equity",
            symbol: "SPY",
            price: 500,
            changePercent24h: 0.2,
            volume: 1_000_000,
            observedAt: "2026-06-01T00:00:00.000Z",
          },
        ],
        newsSources: [
          {
            id: "news-1",
            title: "Market update",
            fetchedAt: "2026-06-01T00:00:00.000Z",
            kind: "news",
          },
        ],
        sourceGaps: [
          sourceGap({
            source: "massive-news",
            message: " source request failed   with status 403 ",
            cause: "fetch-failed",
          }),
        ],
      }),
      depthProfile,
      context,
      sources: [],
    });

    expect(assembled.dataGaps).toEqual(["massive-news: source request failed with status 403"]);
  });

  test("dedupes model provider gap prose against deterministic source gaps", () => {
    const command = {
      jobType: "equity" as const,
      assetClass: "equity" as const,
      symbol: "AAPL",
      depth: "brief" as const,
    };
    const targetKindMix = { favored: ["relative", "range"] as const, minNonDirection: 1 };
    const depthProfile: DepthProfile = {
      depth: "brief",
      analystStyle: "concise brief",
      minimumKeyFindings: 0,
      minimumScenarios: 0,
      targetPredictions: 0,
      defaultPredictionHorizon: 5,
      predictionSubjects: ["AAPL"],
      focus: ["source gaps"],
      targetKindMix,
    };
    const context: ResearchContext = {
      depthProfile,
      runParams: {
        quickModel: "quick",
        synthesisModel: "synthesis",
        modelParams: undefined,
        minimumKeyFindings: 0,
        minimumScenarios: 0,
        targetPredictions: 0,
        defaultPredictionHorizon: 5,
        predictionSubjects: ["AAPL"],
        focus: ["source gaps"],
        analystStyle: "concise brief",
        targetKindMix,
      },
      marketRegime: {
        assetClass: "equity",
        label: "insufficient-data",
        proxyCount: 0,
        drivers: [],
        sourceIds: [],
      },
      calibrationContext: undefined,
    };

    const assembled = assembleResearchReport({
      runId: "run-1",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command,
      payload: {
        summary: "Source coverage was constrained.",
        confidence: "medium",
        dataGaps: ["Tradier unavailable for options evidence.", "Issuer transcript unavailable."],
      },
      predResult: { predictions: [], errors: [] },
      collectedSources: collectedSources({
        marketSnapshots: [
          {
            sourceId: "market-yahoo-equity-aapl",
            assetClass: "equity",
            symbol: "AAPL",
            price: 190,
            changePercent24h: 0.2,
            volume: 1_000_000,
            observedAt: "2026-06-01T00:00:00.000Z",
          },
        ],
        newsSources: [
          {
            id: "news-1",
            title: "AAPL update",
            fetchedAt: "2026-06-01T00:00:00.000Z",
            kind: "news",
          },
        ],
        sourceGaps: [
          sourceGap({
            source: "tradier-options",
            provider: "tradier",
            message: "MARKET_BOT_TRADIER_API_TOKEN is not set",
            cause: "missing-credential",
          }),
        ],
      }),
      depthProfile,
      context,
      sources: [],
    });

    expect(assembled.dataGaps).toEqual([
      "Issuer transcript unavailable.",
      "tradier-options: MARKET_BOT_TRADIER_API_TOKEN is not set",
      "No Verified Market Snapshot for AAPL: exact numeric technical-indicator claims are ungrounded for this run",
    ]);
  });

  test("keeps deterministic options and supplemental gaps over model restatements", () => {
    const command = {
      jobType: "equity" as const,
      assetClass: "equity" as const,
      symbol: "AAPL",
      depth: "brief" as const,
    };
    const depthProfile = assemblyDepthProfile("AAPL");

    const assembled = assembleResearchReport({
      runId: "run-1",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command,
      payload: {
        summary: "Source coverage was constrained.",
        confidence: "medium",
        dataGaps: [
          "Options IV evidence unavailable.",
          "Supplemental market snapshots unavailable.",
          "Issuer transcript unavailable.",
        ],
      },
      predResult: { predictions: [], errors: [] },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-aapl" })],
        newsSources: [
          {
            id: "news-1",
            title: "AAPL update",
            fetchedAt: "2026-06-01T00:00:00.000Z",
            kind: "news",
          },
        ],
        sourceGaps: [
          sourceGap({
            source: "tradier-options",
            provider: "tradier",
            message: "MARKET_BOT_TRADIER_API_TOKEN is not set",
            cause: "missing-credential",
          }),
          sourceGap({
            source: "massive-supplemental-market",
            provider: "massive",
            message: "supplemental market snapshot request failed with status 403",
            capability: "market-data",
            cause: "fetch-failed",
            evidenceQualityImpact: "no-cap",
          }),
        ],
      }),
      depthProfile,
      context: assemblyContext(depthProfile),
      sources: [],
    });

    expect(assembled.dataGaps).toEqual([
      "Issuer transcript unavailable.",
      "tradier-options: MARKET_BOT_TRADIER_API_TOKEN is not set",
      "massive-supplemental-market: supplemental market snapshot request failed with status 403",
      "No Verified Market Snapshot for AAPL: exact numeric technical-indicator claims are ungrounded for this run",
    ]);
  });

  test("keeps deterministic mover-universe gap over model restatements", () => {
    const command = {
      jobType: "market-overview" as const,
      assetClass: "equity" as const,
      horizonTradingDays: 15,
      depth: "brief" as const,
    };
    const depthProfile = assemblyDepthProfile("SPY");

    const assembled = assembleResearchReport({
      runId: "run-1",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command,
      payload: {
        summary: "Source coverage was constrained.",
        confidence: "medium",
        dataGaps: ["Mover universe is limited to a single day."],
      },
      predResult: { predictions: [], errors: [] },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-spy", symbol: "SPY" })],
        newsSources: [
          {
            id: "news-1",
            title: "Market update",
            fetchedAt: "2026-06-01T00:00:00.000Z",
            kind: "news",
          },
        ],
      }),
      depthProfile,
      context: assemblyContext(depthProfile),
      sources: [],
    });

    expect(assembled.dataGaps).toEqual([
      "Market overview mover universe is seeded from Yahoo day_gainers, day_losers, and most_actives — a single-day multi-screener set, not a trailing horizon mover screener",
    ]);
  });

  test("dedupes observed mover-universe restatement from recent runs", () => {
    const command = {
      jobType: "market-overview" as const,
      assetClass: "equity" as const,
      horizonTradingDays: 15,
      depth: "brief" as const,
    };
    const depthProfile = assemblyDepthProfile("SPY");

    const assembled = assembleResearchReport({
      runId: "run-1",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command,
      payload: {
        summary: "Source coverage was constrained.",
        confidence: "medium",
        dataGaps: [
          "The mover universe is seeded from Yahoo day gainers, day losers, and most active screens, not a trailing-horizon leadership dataset.",
        ],
      },
      predResult: { predictions: [], errors: [] },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-spy", symbol: "SPY" })],
        newsSources: [newsSource()],
      }),
      depthProfile,
      context: assemblyContext(depthProfile),
      sources: [],
    });

    expect(assembled.dataGaps).toEqual([
      "Market overview mover universe is seeded from Yahoo day_gainers, day_losers, and most_actives — a single-day multi-screener set, not a trailing horizon mover screener",
    ]);
  });

  test("retains unrelated mover-universe caveat", () => {
    const command = {
      jobType: "market-overview" as const,
      assetClass: "equity" as const,
      horizonTradingDays: 15,
      depth: "brief" as const,
    };
    const depthProfile = assemblyDepthProfile("SPY");

    const assembled = assembleResearchReport({
      runId: "run-1",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command,
      payload: {
        summary: "Source coverage was constrained.",
        confidence: "medium",
        dataGaps: ["The mover universe excludes ADRs with limited U.S. session liquidity."],
      },
      predResult: { predictions: [], errors: [] },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-spy", symbol: "SPY" })],
        newsSources: [newsSource()],
      }),
      depthProfile,
      context: assemblyContext(depthProfile),
      sources: [],
    });

    expect(assembled.dataGaps).toEqual([
      "The mover universe excludes ADRs with limited U.S. session liquidity.",
      "Market overview mover universe is seeded from Yahoo day_gainers, day_losers, and most_actives — a single-day multi-screener set, not a trailing horizon mover screener",
    ]);
  });

  test("does not lower high confidence for optional news-provider gaps when usable news exists", () => {
    const command = {
      jobType: "equity" as const,
      assetClass: "equity" as const,
      symbol: "AAPL",
      depth: "brief" as const,
    };
    const depthProfile = assemblyDepthProfile("AAPL");

    const assembled = assembleResearchReport({
      runId: "run-1",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command,
      payload: {
        summary: "AAPL coverage includes usable Yahoo news.",
        confidence: "high",
        dataGaps: [],
      },
      predResult: { predictions: [], errors: [] },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-aapl" })],
        newsSources: [newsSource()],
        sourceGaps: [
          sourceGap({
            source: "finnhub-news",
            provider: "finnhub",
            capability: "news",
            cause: "fetch-failed",
            message: "finnhub-news source request failed with status 403",
            evidenceQualityImpact: "no-cap",
          }),
        ],
      }),
      depthProfile,
      context: assemblyContext(depthProfile),
      sources: [],
    });

    expect(assembled.confidence).toBe("high");
    expect(assembled.dataGaps).toContain(
      "finnhub-news: finnhub-news source request failed with status 403",
    );
  });

  test("adds historical report sources to report source lists", () => {
    const history: HistoricalResearchContext = {
      generatedAt: "2026-05-19T00:00:00.000Z",
      recentDays: 90,
      anchorMonths: [3, 6, 12],
      runs: [],
      sources: [
        {
          id: "history-report-prior-run",
          title: "Prior daily equity report",
          fetchedAt: "2026-05-01T00:00:00.000Z",
          kind: "model",
          assetClass: "equity",
          rawRef: "prior-run/report.json",
          provider: "market-bot",
        },
      ],
      gaps: [],
      audit: {
        scannedRunCount: 1,
        malformedRunCount: 0,
        malformedScoreCount: 0,
        candidateRunCount: 1,
        selectedRunCount: 1,
        recentSelectedCount: 1,
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
    };

    const sources = buildSourceList(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [],
        newsSources: [],
      }),
      history,
    );

    expect(sources).toContainEqual({
      id: "history-report-prior-run",
      title: "Prior daily equity report",
      fetchedAt: "2026-05-01T00:00:00.000Z",
      kind: "model",
      assetClass: "equity",
      rawRef: "prior-run/report.json",
      provider: "market-bot",
    });
  });

  test("prefers snapshot citations for numeric claims cited only to history reports", () => {
    const history: HistoricalResearchContext = {
      generatedAt: "2026-05-19T00:00:00.000Z",
      recentDays: 90,
      anchorMonths: [],
      runs: [
        {
          runId: "prior-run",
          sourceId: "history-report-prior-run",
          jobType: "equity",
          assetClass: "equity",
          symbol: "AAPL",
          generatedAt: "2026-05-01T00:00:00.000Z",
          selectionReasons: ["recent", "same-symbol"],
          summary: "Prior narrative context.",
          confidence: "medium",
          keyFindings: [],
          risks: [],
          catalysts: [],
          dataGaps: [],
          predictions: [],
          scoreSummary: { total: 0, resolved: 0, hit: 0, miss: 0, unresolved: 0 },
          marketSnapshots: [],
        },
      ],
      sources: [
        {
          id: "history-report-prior-run",
          title: "Prior AAPL report",
          fetchedAt: "2026-05-01T00:00:00.000Z",
          kind: "model",
          assetClass: "equity",
          symbol: "AAPL",
          rawRef: "prior-run/report.json",
          provider: "market-bot",
        },
      ],
      gaps: [],
      audit: {
        scannedRunCount: 1,
        malformedRunCount: 0,
        malformedScoreCount: 0,
        candidateRunCount: 1,
        selectedRunCount: 1,
        recentSelectedCount: 1,
        anchorSelectedCount: 0,
        sameSymbolSelectedCount: 1,
        spotlightSymbolSelectedCount: 0,
        sameSubjectSelectedCount: 0,
        sameHorizonSelectedCount: 0,
        crossHorizonSelectedCount: 0,
        resolvedMissRunCount: 0,
        missCorrectionSelectedCount: 0,
        gapCount: 0,
      },
      artifactDeltas: [],
    };
    const command = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "brief",
    } as const;
    const collected = collectedSources({
      marketSnapshots: [marketSnapshot({ symbol: "AAPL", sourceId: "market-aapl", price: 100 })],
    });
    const depthProfile = assemblyDepthProfile("AAPL");
    const assembled = assembleResearchReport({
      runId: "ticker-aapl",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command,
      payload: {
        summary: "AAPL evidence is mixed.",
        keyFindings: [
          {
            text: "AAPL traded near 100 in the current snapshot.",
            sourceIds: ["history-report-prior-run"],
          },
        ],
        risks: [
          {
            text: "Prior narrative context remains relevant.",
            sourceIds: ["history-report-prior-run"],
          },
        ],
        confidence: "medium",
      },
      predResult: { predictions: [], errors: [] },
      collectedSources: collected,
      depthProfile,
      context: { ...assemblyContext(depthProfile), historicalContext: history },
      sources: buildSourceList(command, collected, history),
    });

    expect(assembled.keyFindings[0]?.sourceIds).toEqual(["market-aapl"]);
    expect(assembled.risks[0]?.sourceIds).toEqual(["history-report-prior-run"]);
    expect(assembled.extras?.historicalContext).toMatchObject({
      items: [{ sourceIds: ["history-report-prior-run"] }],
    });
  });

  test("keeps prior forecast numeric narrative cited to history reports", () => {
    const historySourceId = "history-report-prior-run";
    const command = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "brief",
    } as const;
    const collected = collectedSources({
      marketSnapshots: [marketSnapshot({ symbol: "AAPL", sourceId: "market-aapl", price: 100 })],
    });
    const depthProfile = assemblyDepthProfile("AAPL");
    const assembled = assembleResearchReport({
      runId: "ticker-aapl",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command,
      payload: {
        summary: "AAPL evidence is mixed.",
        keyFindings: [
          {
            text: "Prior AAPL forecast had p=0.72 and missed after 5 days.",
            sourceIds: [historySourceId],
          },
        ],
        confidence: "medium",
      },
      predResult: { predictions: [], errors: [] },
      collectedSources: collected,
      depthProfile,
      context: assemblyContext(depthProfile),
      sources: [
        ...buildSourceList(command, collected),
        {
          id: historySourceId,
          title: "Prior AAPL report",
          fetchedAt: "2026-05-01T00:00:00.000Z",
          kind: "model",
          assetClass: "equity",
          symbol: "AAPL",
          rawRef: "prior-run/report.json",
          provider: "market-bot",
        },
      ],
    });

    expect(assembled.keyFindings[0]?.sourceIds).toEqual([historySourceId]);
  });

  test("uses deterministic historical context instead of model-authored history extras", () => {
    const depthProfile = assemblyDepthProfile("AAPL");
    const historySource: Source = {
      id: "history-report-prior-aapl",
      title: "Prior AAPL report",
      fetchedAt: "2026-05-01T00:00:00.000Z",
      kind: "model",
      assetClass: "equity",
      symbol: "AAPL",
      provider: "market-bot",
      rawRef: "prior-aapl/report.json",
    };
    const context: ResearchContext = {
      ...assemblyContext(depthProfile),
      historicalContext: {
        generatedAt: "2026-06-01T00:00:00.000Z",
        recentDays: 90,
        anchorMonths: [3, 6, 12],
        runs: [
          {
            runId: "prior-aapl",
            sourceId: historySource.id,
            jobType: "equity",
            assetClass: "equity",
            symbol: "AAPL",
            generatedAt: "2026-05-01T00:00:00.000Z",
            selectionReasons: ["same-symbol"],
            summary: "Prior AAPL summary.",
            confidence: "medium",
            keyFindings: [],
            risks: [],
            catalysts: [],
            dataGaps: [],
            predictions: [],
            scoreSummary: { total: 0, resolved: 0, hit: 0, miss: 0, unresolved: 0 },
            marketSnapshots: [],
          },
        ],
        sources: [historySource],
        gaps: [],
        audit: {
          scannedRunCount: 1,
          malformedRunCount: 0,
          malformedScoreCount: 0,
          candidateRunCount: 1,
          selectedRunCount: 1,
          recentSelectedCount: 1,
          anchorSelectedCount: 0,
          sameSymbolSelectedCount: 1,
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
    };

    const assembled = assembleResearchReport({
      runId: "run-1",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      payload: {
        summary: "History-informed report.",
        keyFindings: [{ text: "Prior context is relevant.", sourceIds: [historySource.id] }],
        confidence: "medium",
        extras: {
          historicalContext: {
            summary: "Model-authored stale history.",
            sourceIds: ["history-report-missing"],
            items: [{ text: "Missing history.", sourceIds: ["history-report-missing"] }],
          },
        },
      },
      predResult: { predictions: [], errors: [] },
      collectedSources: collectedSources(),
      depthProfile,
      context,
      sources: [historySource],
    });

    expect(assembled.extras?.historicalContext).toEqual({
      summary: "Historical context includes 1 prior run artifact(s).",
      sourceIds: [historySource.id],
      items: [{ text: "prior-aapl: Prior AAPL summary.", sourceIds: [historySource.id] }],
      gaps: [],
    });
  });

  test("merges model-authored business framework text into deterministic sections", () => {
    const source: Source = {
      id: "market-aapl",
      title: "AAPL market snapshot",
      fetchedAt: "2026-06-01T00:00:00.000Z",
      kind: "market-data",
      assetClass: "equity",
      symbol: "AAPL",
    };
    const assembled = assembleResearchReport({
      runId: "framework-run",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      payload: {
        summary: "AAPL framework evidence is cited.",
        confidence: "medium",
        extras: {
          businessFramework: {
            sections: [
              {
                name: "Business",
                text: "AAPL has cited revenue evidence and disclosed segment gaps.",
                sourceIds: ["market-aapl"],
              },
            ],
          },
        },
      },
      predResult: { predictions: [], errors: [] },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ sourceId: "market-aapl", symbol: "AAPL" })],
        businessFramework: {
          version: 1,
          generatedAt: "2026-06-01T00:00:00.000Z",
          symbol: "AAPL",
          phase: "capital-return",
          sections: [
            {
              name: "Business",
              posture: "criteria-supported",
              summary: "Business criteria-supported.",
              metrics: [],
              sourceIds: ["market-aapl"],
              gaps: ["Segment mix unavailable"],
            },
          ],
          sourceIds: ["market-aapl"],
          gaps: ["Segment mix unavailable"],
        },
      }),
      depthProfile: assemblyDepthProfile("AAPL"),
      context: assemblyContext(assemblyDepthProfile("AAPL")),
      sources: [source],
    });

    expect(assembled.extras?.businessFramework).toMatchObject({
      phase: "capital-return",
      sections: [
        {
          name: "Business",
          posture: "criteria-supported",
          text: "AAPL has cited revenue evidence and disclosed segment gaps.",
          sourceIds: ["market-aapl"],
        },
      ],
    });
  });

  test("writes canonical research subject extras", () => {
    const depthProfile = assemblyDepthProfile("SMH");
    const assembled = assembleResearchReport({
      runId: "research-semis",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "semis",
        subjectKey: "semiconductors",
        predictionProxySymbol: "SMH",
        depth: "brief",
      },
      payload: {
        summary: "Semiconductor evidence is mixed.",
        confidence: "medium",
      },
      predResult: { predictions: [], errors: [] },
      collectedSources: collectedSources(),
      depthProfile,
      context: assemblyContext(depthProfile),
      sources: [],
    });

    expect(assembled.extras?.researchSubject).toEqual({
      input: "semis",
      subjectKey: "semiconductors",
    });
    expect(assembled.extras?.proxyResolution).toEqual({
      predictionProxySymbol: "SMH",
    });
  });

  test("gates research predictions to resolved proxy with matching snapshot", () => {
    const depthProfile = assemblyDepthProfile("XBI");
    const assembled = assembleResearchReport({
      runId: "research-biotech",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "AI biotech",
        subjectKey: "biotech",
        predictionProxySymbol: "XBI",
        depth: "brief",
      },
      payload: {
        summary: "AI biotech evidence is mixed.",
        confidence: "medium",
      },
      predResult: {
        predictions: [
          prediction({
            id: "pred-vix",
            kind: "volatility",
            subject: "^VIX",
            measurableAs: "max(close(^VIX), 0..+15) > 20",
            horizonTradingDays: 15,
          }),
          prediction({
            id: "pred-xbi",
            subject: "XBI",
            measurableAs: "close(XBI, +15) > close(XBI, 0)",
            horizonTradingDays: 15,
          }),
        ],
        errors: [],
      },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-xbi", symbol: "XBI" })],
      }),
      depthProfile,
      context: assemblyContext(depthProfile),
      sources: [
        {
          ...spotlightSource,
          id: "market-yahoo-equity-xbi",
          title: "XBI market snapshot",
          symbol: "XBI",
        },
      ],
    });

    expect(assembled.predictions.map((item) => item.subject)).toEqual(["XBI"]);
    expect(assembled.dataGaps).toContain(
      "researchProxyForecastGate: dropped non-proxy predictions; allowed subject is XBI",
    );
  });

  test("drops research predictions when proxy snapshot is missing", () => {
    const depthProfile = assemblyDepthProfile("XBI");
    const assembled = assembleResearchReport({
      runId: "research-biotech",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "AI biotech",
        subjectKey: "biotech",
        predictionProxySymbol: "XBI",
        depth: "brief",
      },
      payload: {
        summary: "AI biotech evidence is mixed.",
        confidence: "medium",
      },
      predResult: {
        predictions: [
          prediction({
            subject: "XBI",
            measurableAs: "close(XBI, +15) > close(XBI, 0)",
            horizonTradingDays: 15,
          }),
        ],
        errors: [],
      },
      collectedSources: collectedSources(),
      depthProfile,
      context: assemblyContext(depthProfile),
      sources: [],
    });

    expect(assembled.predictions).toEqual([]);
    expect(assembled.dataGaps).toContain(
      "researchProxyForecastGate: dropped predictions because no market snapshot matched proxy XBI",
    );
  });

  test("adds de-duped benchmark market sources from market snapshots", () => {
    const snapshots: readonly MarketSnapshot[] = [
      {
        sourceId: "market-yahoo-equity-aapl",
        assetClass: "equity",
        symbol: "AAPL",
        price: 190,
        changePercent24h: 2,
        volume: 80_000_000,
        observedAt: "2026-05-19T00:00:00.000Z",
        benchmark: {
          sourceId: "market-yahoo-equity-xlk",
          symbol: "XLK",
          basis: "sector-etf",
          sector: "Technology",
          changePercent24h: -1,
          observedAt: "2026-05-19T00:00:00.000Z",
        },
      },
      {
        sourceId: "market-yahoo-equity-msft",
        assetClass: "equity",
        symbol: "MSFT",
        price: 420,
        changePercent24h: 3,
        volume: 50_000_000,
        observedAt: "2026-05-19T00:00:00.000Z",
        benchmark: {
          sourceId: "market-yahoo-equity-xlk",
          symbol: "XLK",
          basis: "sector-etf",
          sector: "Technology",
          changePercent24h: -1,
          observedAt: "2026-05-19T00:00:00.000Z",
        },
      },
    ];

    const sources = buildSourceList(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: snapshots,
        newsSources: [],
      }),
    );

    expect(sources.filter((source) => source.id === "market-yahoo-equity-xlk")).toEqual([
      expect.objectContaining({
        title: "XLK benchmark snapshot",
        kind: "market-data",
        assetClass: "equity",
        symbol: "XLK",
        provider: "yahoo",
      }),
    ]);
  });

  test("does not duplicate a benchmark source already present as a market snapshot", () => {
    const snapshots: readonly MarketSnapshot[] = [
      {
        sourceId: "market-yahoo-equity-aapl",
        assetClass: "equity",
        symbol: "AAPL",
        price: 190,
        changePercent24h: 2,
        volume: 80_000_000,
        observedAt: "2026-05-19T00:00:00.000Z",
        benchmark: {
          sourceId: "market-yahoo-equity-spy",
          symbol: "SPY",
          basis: "broad-index",
          changePercent24h: 0.4,
          observedAt: "2026-05-19T00:00:00.000Z",
        },
      },
      {
        sourceId: "market-yahoo-equity-spy",
        assetClass: "equity",
        symbol: "SPY",
        price: 510,
        changePercent24h: 0.4,
        volume: 70_000_000,
        observedAt: "2026-05-19T00:00:00.000Z",
      },
    ];

    const sources = buildSourceList(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: snapshots,
        newsSources: [],
      }),
    );

    expect(sources.filter((source) => source.id === "market-yahoo-equity-spy")).toEqual([
      expect.objectContaining({
        title: "SPY market snapshot",
        symbol: "SPY",
      }),
    ]);
  });

  test("rejects missing source references", () => {
    expect(() =>
      validateResearchReport({
        ...report,
        keyFindings: [{ text: "Unsupported finding.", sourceIds: ["missing"] }],
      }),
    ).toThrow("Unknown source ID");
  });

  test("renders Markdown with source references, gaps, and one note", () => {
    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("[source-1]");
    expect(markdown).toContain("No derivatives data");
    expect(markdown.match(/Research-only note/gu)?.length).toBe(1);
  });

  test("renders cited sources first and summarizes uncited sources", () => {
    const markdown = renderMarkdownReport({
      ...report,
      sources: [
        ...report.sources,
        {
          id: "uncited-news",
          title: "Uncited broad market story",
          fetchedAt: "2026-05-19T00:00:00.000Z",
          kind: "news",
          provider: "yahoo",
        },
        {
          id: "uncited-market",
          title: "Uncited market snapshot",
          fetchedAt: "2026-05-19T00:00:00.000Z",
          kind: "market-data",
          provider: "coingecko",
        },
      ],
    });

    expect(markdown).toContain("- [source-1] BTC market snapshot");
    expect(markdown).not.toContain("Uncited broad market story");
    expect(markdown).not.toContain("Uncited market snapshot");
    expect(markdown).toContain(
      "2 uncited normalized source(s) omitted from markdown (coingecko/market-data:1, yahoo/news:1)",
    );
  });

  test("renders ticker Extended Evidence from report contract", () => {
    const markdown = renderMarkdownReport({
      ...report,
      sources: [
        ...report.sources,
        {
          id: "extended-fred-macro",
          title: "FRED macro pack",
          fetchedAt: "2026-05-19T00:00:00.000Z",
          kind: "extended-evidence",
        },
      ],
      extendedEvidence: {
        instrument: { assetClass: "crypto", symbol: "BTC" },
        items: [
          {
            category: "fred-macro",
            title: "FRED macro pack",
            summary: "Latest FRED macro observations captured.",
            sourceIds: ["extended-fred-macro"],
            observedAt: "2026-05-19T00:00:00.000Z",
          },
        ],
        gaps: [],
      },
    });

    expect(markdown).toContain("## Extended Evidence");
    expect(markdown).toContain("[extended-fred-macro]");
  });

  test("escapes generic report metadata in Markdown", () => {
    const markdown = renderMarkdownReport({
      ...report,
      dataGaps: ["Provider <gap> [link](https://bad.example)"],
      sources: [
        {
          id: "source-[1]",
          title: "Provider [title](https://bad.example)",
          fetchedAt: "2026-05-19T00:00:00.000Z",
          kind: "market-data",
          assetClass: "crypto",
          symbol: "BTC",
        },
      ],
      keyFindings: [{ text: "BTC liquidity remains high.", sourceIds: ["source-[1]"] }],
      risks: [{ text: "Volatility remains elevated.", sourceIds: ["source-[1]"] }],
      scenarios: [
        {
          name: "Base",
          description: "Range-bound conditions persist.",
          sourceIds: ["source-[1]"],
        },
      ],
      extendedEvidence: {
        instrument: { assetClass: "crypto", symbol: "BTC" },
        items: [
          {
            category: "fred-macro",
            title: "Provider <title>",
            summary: "Provider [summary](https://bad.example)",
            sourceIds: ["source-[1]"],
            observedAt: "2026-05-19T00:00:00.000Z",
          },
        ],
        gaps: [],
      },
    });

    expect(markdown).toContain(String.raw`Provider &lt;gap&gt; \[link\]\(https://bad.example\)`);
    expect(markdown).toContain(String.raw`[source-\[1\]]`);
    expect(markdown).toContain(String.raw`Provider \[title\]\(https://bad.example\)`);
    expect(markdown).toContain(String.raw`Provider &lt;title&gt;`);
    expect(markdown).toContain(String.raw`Provider \[summary\]\(https://bad.example\)`);
  });

  test("renders historical context and spotlights with escaped known-source citations", () => {
    const markdown = renderMarkdownReport({
      ...report,
      jobType: "daily",
      extras: {
        historicalContext: {
          summary: "Prior [run] <changed>",
          sourceIds: ["source-1"],
          items: [
            { text: "Old *finding* held.", sourceIds: ["source-1"] },
            { text: "Unknown source item", sourceIds: ["missing"] },
          ],
          gaps: ["No [older] artifact"],
        },
        spotlights: {
          items: [
            { symbol: "A[APL]", rationale: "Mover <up> [link](x)", sourceIds: ["source-1"] },
            { symbol: "BAD", rationale: "Unknown source", sourceIds: ["missing"] },
          ],
        },
      },
    });

    expect(markdown).toContain("## Historical Context");
    expect(markdown).toContain(String.raw`Prior \[run\] &lt;changed&gt; [source-1]`);
    expect(markdown).toContain(String.raw`Old \*finding\* held.`);
    expect(markdown).toContain(String.raw`No \[older\] artifact`);
    expect(markdown).toContain("## Market Spotlights");
    expect(markdown).toContain(String.raw`A\[APL\]`);
    expect(markdown).toContain(String.raw`Mover &lt;up&gt; \[link\]\(x\)`);
    expect(markdown).not.toContain("Unknown source item");
    expect(markdown).not.toContain("BAD");
  });

  test("omits research spotlights when no prediction proxy resolved", () => {
    const { symbol: _symbol, ...researchReport } = report;
    const markdown = renderMarkdownReport({
      ...researchReport,
      jobType: "research",
      extras: {
        depthProfile: {
          predictionSubjects: [],
        },
        spotlights: {
          items: [{ symbol: "AAPL", rationale: "Off-subject spotlight.", sourceIds: ["source-1"] }],
        },
      },
    });

    expect(markdown).not.toContain("## Market Spotlights");
    expect(markdown).not.toContain("Off-subject spotlight.");
  });

  test("renders market overview titles", () => {
    const { symbol: _symbol, ...marketReport } = report;

    expect(renderMarkdownReport({ ...marketReport, jobType: "daily" })).toContain(
      "# crypto Market Overview",
    );
    expect(renderMarkdownReport({ ...marketReport, jobType: "weekly" })).toContain(
      "# crypto Market Overview",
    );
  });

  test("renders research title as thematic research view", () => {
    const { symbol: _symbol, ...base } = report;

    expect(renderMarkdownReport({ ...base, jobType: "research" })).toContain(
      "# crypto Thematic Research View",
    );
  });

  test("omits prediction language from alpha-search research-only note", () => {
    const markdown = renderMarkdownReport({
      ...report,
      jobType: "alpha-search",
      assetClass: "equity",
      predictions: [],
      extras: {
        researchLeads: [],
        rejectedCandidates: [],
      },
    });

    expect(markdown).toContain("Research-only note:");
    expect(markdown).not.toContain("Predictions are probabilistic statements");
  });

  test("rejects trade-action language in alpha-search reports", () => {
    expect(() =>
      validateResearchReport({
        ...report,
        jobType: "alpha-search",
        assetClass: "equity",
        summary: "Alpha search says buy this instrument.",
        keyFindings: [{ text: "AAPL was discussed.", sourceIds: ["source-1"] }],
        predictions: [],
        extras: {
          researchLeads: [],
          rejectedCandidates: [],
        },
      }),
    ).toThrow("trade-action language");
  });

  test("rejects rendered extras with unknown source IDs or trade-action language", () => {
    expect(() =>
      validateResearchReport({
        ...report,
        extras: {
          historicalContext: {
            items: [{ text: "Prior run evidence.", sourceIds: ["missing"] }],
          },
        },
      }),
    ).toThrow("Unknown source ID");

    expect(() =>
      validateResearchReport({
        ...report,
        extras: {
          spotlights: {
            items: [
              { symbol: "BTC", rationale: "Buy after the catalyst.", sourceIds: ["source-1"] },
            ],
          },
        },
      }),
    ).toThrow("trade-action language");

    expect(() =>
      validateResearchReport({
        ...report,
        extras: {
          businessFramework: {
            sections: [{ name: "Business", text: "Framework evidence.", sourceIds: ["missing"] }],
          },
        },
      }),
    ).toThrow("Unknown source ID");

    expect(() =>
      validateResearchReport({
        ...report,
        extras: {
          businessFramework: {
            sections: [
              { name: "Valuation", text: "Buy after the rerating.", sourceIds: ["source-1"] },
            ],
          },
        },
      }),
    ).toThrow("trade-action language");
  });

  test("renders business framework extras in markdown", () => {
    const markdown = renderMarkdownReport({
      ...report,
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      sources: [
        {
          id: "source-1",
          title: "AAPL framework source",
          fetchedAt: "2026-05-19T00:00:00.000Z",
          kind: "market-data",
          assetClass: "equity",
          symbol: "AAPL",
        },
      ],
      extras: {
        businessFramework: {
          phase: "capital-return",
          gaps: ["Management evidence unavailable"],
          sections: [
            {
              name: "Business",
              posture: "criteria-supported",
              text: "Revenue evidence is available.",
              sourceIds: ["source-1"],
            },
            {
              name: "Phase",
              posture: "criteria-supported",
              summary: "Phase classification (Phase capital-return)",
              sourceIds: ["source-1"],
            },
          ],
        },
      },
    });

    expect(markdown).toContain("## Business Framework");
    expect(markdown).toContain("Phase: capital-return");
    expect(markdown).toContain("Revenue evidence is available. [source-1]");
    expect(markdown).toContain(
      String.raw`- **Phase**: Phase classification \(Phase capital-return\) [source-1]`,
    );
    expect(markdown).not.toContain("**Phase** (criteria-supported)");
    expect(markdown).toContain("Management evidence unavailable");
  });

  test("renders only well-shaped alpha-search extras", () => {
    const markdown = renderMarkdownReport({
      ...report,
      jobType: "alpha-search",
      assetClass: "equity",
      predictions: [],
      extras: {
        researchLeads: [
          {
            symbol: "AAPL",
            exchange: "NMS",
            price: 190,
            volume: 80_000_000,
            marketCap: 2_900_000_000,
            discoverySources: ["apewisdom"],
            socialRank: 1,
            socialMomentumScore: 50,
            mentions: 2,
            upvotes: 10,
            sourceIds: ["source-1"],
          },
          { symbol: "BAD", price: "not-a-number", sourceIds: ["source-1"] },
        ],
        rejectedCandidates: [
          {
            symbol: "OTCM",
            socialRank: 2,
            socialMomentumScore: 30,
            discoverySources: ["apewisdom"],
            reason: "OTC or pink-sheet instrument",
            sourceIds: ["source-1"],
          },
          { symbol: "BROKEN", reason: 123, sourceIds: ["source-1"] },
        ],
      },
    });

    expect(markdown).toContain("AAPL");
    expect(markdown).toContain("OTCM");
    expect(markdown).not.toContain("\n\n\n## Data Gaps");
    expect(markdown).not.toContain("BAD");
    expect(markdown).not.toContain("BROKEN");
  });

  test("escapes alpha-search provider-controlled markdown fields", () => {
    const markdown = renderMarkdownReport({
      ...report,
      jobType: "alpha-search",
      assetClass: "equity",
      dataGaps: ["<script>alert(1)</script>"],
      predictions: [],
      sources: [
        {
          id: "source-1",
          title: "Provider [title](https://bad.example)",
          fetchedAt: "2026-05-19T00:00:00.000Z",
          kind: "market-data",
        },
      ],
      extras: {
        researchLeads: [
          {
            symbol: "SAFE",
            name: "Name <b>Buy</b>",
            exchange: "NMS",
            price: 10,
            volume: 100_000,
            marketCap: 100_000_000,
            discoverySources: ["sec-filings"],
            sourceIds: ["source-1"],
          },
        ],
        rejectedCandidates: [
          {
            symbol: "NOPE",
            discoverySources: ["sec-filings"],
            reason: "Provider says [buy](https://bad.example)",
            sourceIds: ["source-1"],
          },
        ],
      },
    });

    expect(markdown).toContain(String.raw`&lt;script&gt;alert\(1\)&lt;/script&gt;`);
    expect(markdown).toContain("Name &lt;b&gt;Buy&lt;/b&gt;");
    expect(markdown).toContain(String.raw`Provider \[title\]\(https://bad.example\)`);
    expect(markdown).toContain(String.raw`Provider says \[buy\]\(https://bad.example\)`);
  });
});

function marketUpdateReport(delta: Record<string, unknown>): ResearchReport {
  return {
    runId: "run-2",
    jobType: "daily",
    assetClass: "equity",
    generatedAt: "2026-06-01T00:00:00.000Z",
    summary: "Equity tape was steady.",
    keyFindings: [{ text: "Breadth firmed.", sourceIds: ["s1"] }],
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    confidence: "medium",
    dataGaps: [],
    predictions: [],
    sources: [
      { id: "s1", title: "snapshot", fetchedAt: "2026-06-01T00:00:00.000Z", kind: "market-data" },
    ],
    notFinancialAdvice: true,
    extras: { marketUpdateDelta: delta },
  };
}

describe("registry provenance sources in buildSourceList (phase 2.1)", () => {
  test("attaches registry sources as kind:reference for resolved research subjects", () => {
    const sources = buildSourceList(
      {
        jobType: "research",
        assetClass: "equity",
        subject: "chip stocks",
        subjectKey: "semiconductors",
        predictionProxySymbol: "SMH",
        depth: "brief",
      },
      collectedSources(),
      undefined,
      "2026-06-01T00:00:00.000Z",
    );

    const referenceSources = sources.filter((s) => s.kind === "reference");
    // Semiconductors registry has 4 sources: vaneck-smh + 3 Nasdaq listings
    expect(referenceSources.length).toBeGreaterThan(0);
    expect(referenceSources[0]).toMatchObject({
      id: "vaneck-smh",
      title: "VanEck Semiconductor ETF",
      url: "https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/",
      fetchedAt: "2026-06-01T00:00:00.000Z",
      kind: "reference",
    });
    const ids = referenceSources.map((s) => s.id);
    expect(ids).toContain("nasdaq-nvda");
    expect(ids).toContain("nasdaq-amd");
  });

  test("omits registry sources for unresolved research subjects", () => {
    const sources = buildSourceList(
      {
        jobType: "research",
        assetClass: "equity",
        subject: "unknown niche sector",
        depth: "brief",
      },
      collectedSources(),
      undefined,
      "2026-06-01T00:00:00.000Z",
    );

    expect(sources.filter((s) => s.kind === "reference")).toHaveLength(0);
  });

  test("requires caller timestamp for resolved registry source provenance", () => {
    expect(() =>
      buildSourceList(
        {
          jobType: "research",
          assetClass: "equity",
          subject: "chip stocks",
          subjectKey: "semiconductors",
          predictionProxySymbol: "SMH",
          depth: "brief",
        },
        collectedSources(),
        undefined,
        undefined as never,
      ),
    ).toThrow();
  });

  test("omits registry sources for non-research job types", () => {
    const sources = buildSourceList(
      { jobType: "equity", assetClass: "equity", symbol: "NVDA", depth: "brief" },
      collectedSources(),
      undefined,
      "2026-06-01T00:00:00.000Z",
    );

    expect(sources.filter((s) => s.kind === "reference")).toHaveLength(0);
  });
});

describe("researchPredictionGate gap text (phase 2.4)", () => {
  test("always emits gap when resolved subject has no proxy, even with zero model predictions", () => {
    const depthProfile = assemblyDepthProfile("SMH");
    const assembled = assembleResearchReport({
      runId: "research-ai-infra",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "AI capex",
        subjectKey: "ai-infrastructure",
        depth: "brief",
      },
      payload: { summary: "AI infrastructure evidence.", confidence: "medium" },
      predResult: { predictions: [], errors: [] },
      collectedSources: collectedSources(),
      depthProfile,
      context: assemblyContext(depthProfile),
      sources: [],
    });

    expect(assembled.predictions).toHaveLength(0);
    expect(assembled.dataGaps).toContain(
      "researchProxyForecastGate: subject ai-infrastructure has no listed prediction proxy; predictions cannot be emitted",
    );
  });

  test("drops predictions and emits gap for resolved-no-proxy subject even when model emits some", () => {
    const depthProfile = assemblyDepthProfile("NVDA");
    const assembled = assembleResearchReport({
      runId: "research-ai-infra-2",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "AI capex",
        subjectKey: "ai-infrastructure",
        depth: "brief",
      },
      payload: { summary: "AI infrastructure evidence.", confidence: "medium" },
      predResult: {
        predictions: [
          prediction({
            subject: "NVDA",
            measurableAs: "close(NVDA, +5) > close(NVDA, 0)",
            horizonTradingDays: 5,
          }),
        ],
        errors: [],
      },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-nvda", symbol: "NVDA" })],
      }),
      depthProfile,
      context: assemblyContext(depthProfile),
      sources: [],
    });

    expect(assembled.predictions).toHaveLength(0);
    expect(assembled.dataGaps).toContain(
      "researchProxyForecastGate: subject ai-infrastructure has no listed prediction proxy; predictions cannot be emitted",
    );
  });

  test("omits gap for unresolved subject when model emits zero predictions", () => {
    const depthProfile = assemblyDepthProfile("SPY");
    const assembled = assembleResearchReport({
      runId: "research-unresolved",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "some unknown niche sector",
        depth: "brief",
      },
      payload: { summary: "Niche sector evidence.", confidence: "medium" },
      predResult: { predictions: [], errors: [] },
      collectedSources: collectedSources(),
      depthProfile,
      context: assemblyContext(depthProfile),
      sources: [],
    });

    expect(assembled.predictions).toHaveLength(0);
    const gateGaps = assembled.dataGaps.filter((g) => g.startsWith("researchProxyForecastGate"));
    expect(gateGaps).toHaveLength(0);
  });

  test("omits resolved-subject gap when subjectKey is set but subject string does not resolve in registry", () => {
    // Guards the HIGH fix: identity.subjectKey is caller-provided and not proof of registry
    // Resolution. The gate must use resolveResearchSubjectProxy(command.subject) instead.
    const depthProfile = assemblyDepthProfile("SPY");
    const assembled = assembleResearchReport({
      runId: "research-unresolved-with-key",
      generatedAt: "2026-06-01T00:00:00.000Z",
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "completely-unknown-sector-xyz123",
        subjectKey: "unknown-sector-key",
        depth: "brief",
      },
      payload: { summary: "Unknown sector evidence.", confidence: "medium" },
      predResult: { predictions: [], errors: [] },
      collectedSources: collectedSources(),
      depthProfile,
      context: assemblyContext(depthProfile),
      sources: [],
    });

    expect(assembled.predictions).toHaveLength(0);
    // No gate gap: the subject does not resolve, and zero predictions were emitted.
    const gateGaps = assembled.dataGaps.filter((g) => g.startsWith("researchProxyForecastGate"));
    expect(gateGaps).toHaveLength(0);
  });
});

describe("market update delta rendering", () => {
  test("renders the What Changed section after Summary and before Key Findings", () => {
    const markdown = renderMarkdownReport(
      marketUpdateReport({
        hasBaseline: true,
        currentRegime: "risk-on",
        priorRegime: "risk-off",
        regimeChanged: true,
        flippedDrivers: ["breadth", "trend"],
        moversEntered: ["NVDA"],
        moversExited: ["TSLA"],
        resolvedSince: [
          {
            runId: "run-1",
            predictionId: "p1",
            claim: "SPY closes higher.",
            probability: 0.65,
            outcome: "hit",
            observedAt: "2026-05-31T00:00:00.000Z",
          },
        ],
      }),
    );
    const summaryAt = markdown.indexOf("## Summary");
    const deltaAt = markdown.indexOf("## What Changed Since Last 1-5d Market Overview");
    const findingsAt = markdown.indexOf("## Key Findings");
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(deltaAt).toBeGreaterThan(summaryAt);
    expect(findingsAt).toBeGreaterThan(deltaAt);
    expect(markdown).toContain("Regime: risk-off → risk-on (flipped drivers: breadth, trend).");
    expect(markdown).toContain("Movers entered: NVDA; exited: TSLA.");
    expect(markdown).toContain("- [hit] p=65% SPY closes higher. (run run-1)");
  });

  test("renders a single empty-state line when there is no baseline", () => {
    const markdown = renderMarkdownReport(
      marketUpdateReport({
        hasBaseline: false,
        currentRegime: "risk-on",
        regimeChanged: false,
        flippedDrivers: [],
        moversEntered: [],
        moversExited: [],
        resolvedSince: [],
      }),
    );
    expect(markdown).toContain(
      "## What Changed Since Last 1-5d Market Overview\n\nNo prior comparable market-overview run to compare — this is the first.",
    );
    expect(markdown).not.toContain("Regime:");
  });

  test("delta section carries no trade-action language", () => {
    const markdown = renderMarkdownReport(
      marketUpdateReport({
        hasBaseline: true,
        currentRegime: "risk-on",
        priorRegime: "risk-off",
        regimeChanged: true,
        flippedDrivers: ["breadth"],
        moversEntered: ["NVDA"],
        moversExited: ["TSLA"],
        resolvedSince: [
          {
            runId: "run-1",
            predictionId: "p1",
            claim: "SPY closes higher.",
            probability: 0.65,
            outcome: "hit",
            observedAt: "2026-05-31T00:00:00.000Z",
          },
        ],
      }),
    );
    const start = markdown.indexOf("## What Changed Since Last 1-5d Market Overview");
    const section = markdown.slice(start, markdown.indexOf("## Key Findings"));
    expect(section).toContain("Regime:");
    expect(violatesResearchOnly(section)).toBeNull();
  });
});
