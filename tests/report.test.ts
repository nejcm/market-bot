import { describe, expect, test } from "bun:test";
import type { MarketSnapshot, ResearchReport, Source } from "../src/domain/types";
import { sourceGap } from "../src/domain/source-gaps";
import { renderMarkdownReport } from "../src/report/markdown";
import { violatesResearchOnly } from "../src/domain/research-language";
import { validateResearchReport } from "../src/report/schema";
import { assembleResearchReport, buildSourceList } from "../src/research/report-assembly";
import type { HistoricalResearchContext } from "../src/research/historical-context";
import type { DepthProfile, ResearchContext } from "../src/research/research-context";
import type { SpotlightSelectionResult } from "../src/research/spotlights";
import { collectedSources } from "./support/fixtures";

const report: ResearchReport = {
  runId: "run-1",
  jobType: "ticker",
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
    minimumPredictions: 0,
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
      minimumPredictions: 0,
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
        readonly jobType: "ticker";
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
      { jobType: "ticker", assetClass: "crypto", symbol: "BTC", depth: "brief" },
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
      { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
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
      { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
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
      { jobType: "ticker", assetClass: "equity", symbol: "ROKU", depth: "brief" },
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
      minimumPredictions: 0,
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
        minimumPredictions: 0,
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
      jobType: "ticker" as const,
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
      minimumPredictions: 0,
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
        minimumPredictions: 0,
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
        sameCadenceSelectedCount: 0,
        crossCadenceSelectedCount: 0,
        resolvedMissRunCount: 0,
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

  test("renders cadence-specific market update titles", () => {
    const { symbol: _symbol, ...marketReport } = report;

    expect(renderMarkdownReport({ ...marketReport, jobType: "daily" })).toContain(
      "# crypto Daily Market Update",
    );
    expect(renderMarkdownReport({ ...marketReport, jobType: "weekly" })).toContain(
      "# crypto Weekly Market Update",
    );
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
    const deltaAt = markdown.indexOf("## What Changed Since Last Daily");
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
      "## What Changed Since Last Daily\n\nNo prior daily run to compare — this is the first.",
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
    const start = markdown.indexOf("## What Changed Since Last Daily");
    const section = markdown.slice(start, markdown.indexOf("## Key Findings"));
    expect(section).toContain("Regime:");
    expect(violatesResearchOnly(section)).toBeNull();
  });
});
