import { describe, expect, test } from "bun:test";
import { legacyMarketOverviewCommand } from "./support/commands";
import { sourceGap } from "../src/domain/source-gaps";
import type { ResearchCommand } from "../src/cli/args";
import { assessEvidenceQuality } from "../src/research/evidence-quality";
import {
  resolveResearchSubject,
  type ResolvedResearchSubject,
} from "../src/research/research-subject-identity";
import { assessSourcePlan, buildSourcePlan } from "../src/research/source-plan";
import type { CollectedSources } from "../src/sources/types";
import {
  collectedSources,
  marketSnapshot,
  newsSource,
  verifiedMarketSnapshot,
} from "./support/fixtures";

const generatedAt = "2026-05-19T00:00:00.000Z";

function plannedAndAssessed(
  command: ResearchCommand,
  collected: CollectedSources,
  resolvedSubject?: ResolvedResearchSubject,
) {
  const sourcePlan = buildSourcePlan(command, generatedAt, resolvedSubject);
  return assessSourcePlan(sourcePlan, collected, generatedAt);
}

describe("source plan", () => {
  test("covers only lanes backed by collected sources and records required gaps", () => {
    const plan = plannedAndAssessed(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      collectedSources({
        marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-aapl" })],
        newsSources: [newsSource({ id: "news-yahoo-aapl", provider: "yahoo-news", kind: "news" })],
        extendedSources: [
          {
            id: "extended-sec-edgar-aapl-filings",
            title: "AAPL SEC filing",
            fetchedAt: generatedAt,
            kind: "extended-evidence",
            provider: "sec-edgar",
          },
        ],
        extendedEvidence: {
          instrument: { symbol: "AAPL", assetClass: "equity" },
          items: [
            {
              category: "sec-edgar",
              title: "SEC filing",
              summary: "10-Q filing captured.",
              sourceIds: ["extended-sec-edgar-aapl-filings"],
              observedAt: generatedAt,
            },
          ],
          gaps: [],
        },
        sourceGaps: [
          sourceGap({
            source: "yahoo-verified-chart",
            message: "source request failed with status 500",
            capability: "market-data",
            cause: "fetch-failed",
            evidenceQualityImpact: "core-cap",
          }),
        ],
      }),
    );

    expect(plan.sourcePlan.version).toBe(2);
    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).toContain("derivatives-volatility");
    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).not.toContain("on-chain");
    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "market-data")).toMatchObject({
      status: "covered",
      coveredSourceIds: ["market-yahoo-equity-aapl"],
    });
    expect(
      plan.evidenceLanes.lanes.find((lane) => lane.lane === "verified-price-history"),
    ).toMatchObject({
      status: "gap",
      evidenceClass: "core",
      gapText: ["yahoo-verified-chart: source request failed with status 500"],
    });
    expect(
      plan.evidenceLanes.lanes.find((lane) => lane.lane === "regulatory-filings"),
    ).toMatchObject({
      status: "covered",
      coveredSourceIds: ["extended-sec-edgar-aapl-filings"],
    });
    expect(plan.sourceLedger.sources.map((source) => source.id)).toContain(
      "extended-sec-edgar-aapl-filings",
    );
    expect(plan.sourceLedger.sources.every((source) => source.posture === "covered")).toBe(true);
  });

  test("does not require market data for unresolved research subjects", () => {
    const plan = plannedAndAssessed(
      { jobType: "research", assetClass: "equity", subject: "unknown niche", depth: "brief" },
      collectedSources({
        newsSources: [newsSource({ id: "news-subject", provider: "yahoo-news" })],
      }),
    );

    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).toEqual([
      "supplemental-market",
      "news",
      "subject-profile",
    ]);
    expect(plan.sourcePlan.run.depth).toBe("deep");
    expect(plan.evidenceLanes.summary.coreGapLaneCount).toBe(0);
    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "subject-profile")).toMatchObject({
      status: "not-covered",
      evidenceClass: "material",
    });
    expect(assessEvidenceQuality(plan, generatedAt).label).toBe("medium");
  });

  test("keeps required market-data gap for resolved research proxy failures", () => {
    const plan = plannedAndAssessed(
      {
        jobType: "research",
        assetClass: "equity",
        subject: "biotech",
        subjectKey: "biotech",
        predictionProxySymbol: "XBI",
        depth: "brief",
      },
      collectedSources({
        newsSources: [newsSource({ id: "news-biotech", provider: "yahoo-news" })],
        sourceGaps: [
          sourceGap({
            source: "yahoo-research-proxy",
            message: "source request failed with status 500",
            capability: "market-data",
            cause: "fetch-failed",
            evidenceQualityImpact: "no-cap",
          }),
        ],
      }),
    );

    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).toContain("market-data");
    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).toContain("subject-profile");
    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "market-data")).toMatchObject({
      status: "gap",
      evidenceClass: "core",
      gapText: ["yahoo-research-proxy: source request failed with status 500"],
    });
  });

  test("attributes missing thematic web gather to material subject-profile quality", () => {
    const plan = plannedAndAssessed(
      {
        jobType: "research",
        assetClass: "equity",
        subject: "biotech",
        subjectKey: "biotech",
        predictionProxySymbol: "XBI",
        depth: "brief",
      },
      collectedSources({
        marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-xbi", symbol: "XBI" })],
        newsSources: [newsSource({ id: "news-biotech", provider: "yahoo-news" })],
        sourceGaps: [
          sourceGap({
            source: "web-gather",
            message: "search-unavailable: MARKET_BOT_EXA_API_KEY is not set; web gather skipped",
            provider: "exa",
            capability: "web-gather",
            cause: "missing-credential",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ],
      }),
    );

    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "subject-profile")).toMatchObject({
      status: "gap",
      evidenceClass: "material",
      gapText: [
        "web-gather: search-unavailable: MARKET_BOT_EXA_API_KEY is not set; web gather skipped",
      ],
    });
    expect(assessEvidenceQuality(plan, generatedAt).label).toBe("medium");
  });

  test("surfaces no-proxy gap for resolved research subjects without prediction proxy", () => {
    const command = {
      jobType: "research",
      assetClass: "equity",
      subject: "AI capex",
      subjectKey: "ai-infrastructure",
      depth: "brief",
    } as const;
    const resolvedSubject = resolveResearchSubject(command);
    const plan = plannedAndAssessed(
      command,
      collectedSources({
        resolvedSubject: resolvedSubject!,
        newsSources: [newsSource({ id: "news-ai-infra", provider: "yahoo-news" })],
      }),
      resolvedSubject,
    );

    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).toContain("market-data");
    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "market-data")).toMatchObject({
      status: "gap",
      evidenceClass: "core",
      gapText: [
        "researchSubjectProxy: subject ai-infrastructure has no listed prediction proxy; market-data lane cannot be covered",
      ],
    });
  });

  test("marks thematic market data as a gap when representative stock snapshots are missing", () => {
    const command = {
      jobType: "research",
      assetClass: "equity",
      subject: "biotech",
      subjectKey: "biotech",
      predictionProxySymbol: "XBI",
      depth: "deep",
    } as const;
    const resolvedSubject = resolveResearchSubject(command)!;
    const plan = plannedAndAssessed(
      command,
      collectedSources({
        resolvedSubject,
        marketSnapshots: [
          marketSnapshot({ sourceId: "market-yahoo-equity-xbi", symbol: "XBI" }),
          marketSnapshot({ sourceId: "market-yahoo-equity-spy", symbol: "SPY" }),
        ],
        newsSources: [
          newsSource({ id: "news-biotech-1", provider: "yahoo-news", kind: "news" }),
          newsSource({ id: "news-biotech-2", provider: "finnhub", kind: "news" }),
        ],
      }),
      resolvedSubject,
    );

    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "market-data")).toMatchObject({
      status: "gap",
      evidenceClass: "core",
      coveredSourceIds: ["market-yahoo-equity-xbi"],
      gapText: [
        "researchRepresentative: no live market snapshot for representative Amgen (AMGN)",
        "researchRepresentative: no live market snapshot for representative Gilead Sciences (GILD)",
        "researchRepresentative: no live market snapshot for representative Vertex Pharmaceuticals (VRTX)",
      ],
    });
    expect(plan.evidenceLanes.summary.coreGapLaneCount).toBe(1);
  });

  test("covers thematic representative market data with verified snapshots", () => {
    const command = {
      jobType: "research",
      assetClass: "equity",
      subject: "biotech",
      subjectKey: "biotech",
      predictionProxySymbol: "XBI",
      depth: "deep",
    } as const;
    const resolvedSubject = resolveResearchSubject(command)!;
    const plan = plannedAndAssessed(
      command,
      collectedSources({
        resolvedSubject,
        marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-xbi", symbol: "XBI" })],
        verifiedRepresentativeSnapshots: [
          verifiedMarketSnapshot({ symbol: "AMGN" }),
          verifiedMarketSnapshot({ symbol: "GILD" }),
          verifiedMarketSnapshot({ symbol: "VRTX" }),
        ],
        newsSources: [
          newsSource({ id: "news-biotech-1", provider: "yahoo-news", kind: "news" }),
          newsSource({ id: "news-biotech-2", provider: "finnhub", kind: "news" }),
        ],
      }),
      resolvedSubject,
    );

    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "market-data")).toMatchObject({
      status: "covered",
      evidenceClass: "core",
      coveredSourceIds: [
        "market-yahoo-equity-xbi",
        "verified-snapshot-AMGN",
        "verified-snapshot-GILD",
        "verified-snapshot-VRTX",
      ],
      gapText: [],
    });
    expect(
      plan.sourceLedger.sources.find((source) => source.id === "verified-snapshot-AMGN")
        ?.observedAt,
    ).toBe("2026-05-19T00:00:00.000Z");
  });

  test("marks thematic news as a gap when selected coverage is mostly generic", () => {
    const command = {
      jobType: "research",
      assetClass: "equity",
      subject: "biotech",
      subjectKey: "biotech",
      predictionProxySymbol: "XBI",
      depth: "deep",
    } as const;
    const resolvedSubject = resolveResearchSubject(command)!;
    const plan = plannedAndAssessed(
      command,
      collectedSources({
        resolvedSubject,
        marketSnapshots: [
          marketSnapshot({ sourceId: "market-yahoo-equity-xbi", symbol: "XBI" }),
          marketSnapshot({ sourceId: "market-yahoo-equity-amgn", symbol: "AMGN" }),
          marketSnapshot({ sourceId: "market-yahoo-equity-gild", symbol: "GILD" }),
          marketSnapshot({ sourceId: "market-yahoo-equity-vrtx", symbol: "VRTX" }),
        ],
        newsSources: Array.from({ length: 15 }, (_, index) =>
          newsSource({
            id: `news-equity-${String(index + 1)}`,
            provider: index === 0 ? "yahoo-news" : "finnhub",
            kind: "news",
          }),
        ),
        newsAnalytics: {
          fetchedNewsSourcesByProvider: { "yahoo-news": 1, finnhub: 14 },
          fetchedNewsSourceCount: 15,
          canonicalDedupedNewsSourceCount: 15,
          canonicalDuplicateNewsSourceCount: 0,
          persistentSuppressedNewsSourceCount: 0,
          relevantBeforeSeenFilterCount: 1,
          relevantSuppressedBySeenFilterCount: 0,
          relevantSelectedCount: 1,
          repeatFallbackKeptCount: 0,
          relevantRepeatKeptCount: 0,
          selectedNewsSourceCount: 15,
          selectedRelevantMoverNewsSourceCount: 1,
          selectedGenericMoverNewsSourceCount: 14,
          repeatFallbackUsed: false,
        },
      }),
      resolvedSubject,
    );

    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "news")).toMatchObject({
      status: "gap",
      evidenceClass: "material",
      coveredSourceIds: Array.from(
        { length: 15 },
        (_, index) => `news-equity-${String(index + 1)}`,
      ),
      gapText: ["news: thin thematic relevance (1 relevant selected, 14 generic selected)"],
    });
    expect(assessEvidenceQuality(plan, generatedAt).label).toBe("medium");
  });

  test("keeps market-data gapIds and gapText parallel when every representative snapshot is missing", () => {
    const command = {
      jobType: "research",
      assetClass: "equity",
      subject: "biotech",
      subjectKey: "biotech",
      predictionProxySymbol: "XBI",
      depth: "deep",
    } as const;
    const resolvedSubject = resolveResearchSubject(command)!;
    const plan = plannedAndAssessed(
      command,
      collectedSources({
        resolvedSubject,
        newsSources: [newsSource({ id: "news-biotech", provider: "yahoo-news", kind: "news" })],
      }),
      resolvedSubject,
    );

    const marketLane = plan.evidenceLanes.lanes.find((lane) => lane.lane === "market-data")!;
    expect(marketLane.status).toBe("gap");
    expect(marketLane.coveredSourceIds).toEqual([]);
    expect(marketLane.gapText.length).toBeGreaterThan(1);
    // Regression: the collapsed-synthetic branch used to emit a single gapId while
    // GapText carried one line per missing representative.
    expect(marketLane.gapIds).toHaveLength(marketLane.gapText.length);
    expect(plan.evidenceLanes.summary.gapCount).toBe(
      plan.evidenceLanes.lanes.reduce((total, lane) => total + lane.gapText.length, 0),
    );
  });

  test("does not flag thematic news when enough relevant movers are selected", () => {
    const command = {
      jobType: "research",
      assetClass: "equity",
      subject: "biotech",
      subjectKey: "biotech",
      predictionProxySymbol: "XBI",
      depth: "deep",
    } as const;
    const resolvedSubject = resolveResearchSubject(command)!;
    const plan = plannedAndAssessed(
      command,
      collectedSources({
        resolvedSubject,
        marketSnapshots: [
          marketSnapshot({ sourceId: "market-yahoo-equity-xbi", symbol: "XBI" }),
          marketSnapshot({ sourceId: "market-yahoo-equity-amgn", symbol: "AMGN" }),
          marketSnapshot({ sourceId: "market-yahoo-equity-gild", symbol: "GILD" }),
          marketSnapshot({ sourceId: "market-yahoo-equity-vrtx", symbol: "VRTX" }),
        ],
        newsSources: Array.from({ length: 7 }, (_, index) =>
          newsSource({
            id: `news-equity-${String(index + 1)}`,
            provider: index === 0 ? "yahoo-news" : "finnhub",
            kind: "news",
          }),
        ),
        newsAnalytics: {
          fetchedNewsSourcesByProvider: { "yahoo-news": 1, finnhub: 6 },
          fetchedNewsSourceCount: 7,
          canonicalDedupedNewsSourceCount: 7,
          canonicalDuplicateNewsSourceCount: 0,
          persistentSuppressedNewsSourceCount: 0,
          relevantBeforeSeenFilterCount: 2,
          relevantSuppressedBySeenFilterCount: 0,
          relevantSelectedCount: 2,
          repeatFallbackKeptCount: 0,
          relevantRepeatKeptCount: 0,
          selectedNewsSourceCount: 7,
          // Boundary: exactly 2 relevant selected must NOT trip the `< 2` thin check.
          selectedRelevantMoverNewsSourceCount: 2,
          selectedGenericMoverNewsSourceCount: 5,
          repeatFallbackUsed: false,
        },
      }),
      resolvedSubject,
    );

    const newsLane = plan.evidenceLanes.lanes.find((lane) => lane.lane === "news")!;
    expect(newsLane.status).toBe("covered");
    expect(newsLane.gapText).not.toContain(
      "news: thin thematic relevance (2 relevant selected, 5 generic selected)",
    );
  });

  test("attributes supplemental Massive snapshots to Massive in the source ledger", () => {
    const plan = plannedAndAssessed(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      collectedSources({
        supplementalMarketSnapshots: [
          marketSnapshot({
            sourceId: "supplemental-market-massive-equity-aapl",
            assetClass: "equity",
            symbol: "AAPL",
          }),
        ],
      }),
    );

    expect(
      plan.sourceLedger.sources.find(
        (source) => source.id === "supplemental-market-massive-equity-aapl",
      ),
    ).toMatchObject({ provider: "massive", lane: "supplemental-market" });
  });

  test("maps valuation peer-comp source IDs and gaps into the valuation lane", () => {
    const plan = plannedAndAssessed(
      { jobType: "equity", assetClass: "equity", symbol: "NVDA", depth: "deep" },
      collectedSources({
        marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-nvda", symbol: "NVDA" })],
        extendedSources: [
          {
            id: "market-yahoo-equity-amd",
            title: "AMD Yahoo valuation peer quote",
            fetchedAt: generatedAt,
            kind: "market-data",
            assetClass: "equity",
            symbol: "AMD",
            provider: "yahoo",
          },
          {
            id: "extended-sec-edgar-amd-fundamentals",
            title: "AMD SEC fundamentals",
            fetchedAt: generatedAt,
            kind: "extended-evidence",
            provider: "sec-edgar",
          },
        ],
        extendedEvidence: {
          instrument: { symbol: "NVDA", assetClass: "equity" },
          items: [
            {
              category: "valuation",
              title: "NVDA Valuation Evidence",
              summary: "Peer comps supportability: screening-only.",
              sourceIds: ["market-yahoo-equity-amd", "extended-sec-edgar-amd-fundamentals"],
              observedAt: generatedAt,
            },
          ],
          gaps: [],
        },
        sourceGaps: [
          sourceGap({
            source: "valuation",
            message: "Valuation peer comps screening-only for NVDA: 2 usable peers",
            capability: "extended-evidence",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ],
      }),
    );

    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "target-valuation")).toMatchObject(
      {
        status: "covered",
        coveredSourceIds: ["market-yahoo-equity-amd", "extended-sec-edgar-amd-fundamentals"],
        gapText: ["valuation: Valuation peer comps screening-only for NVDA: 2 usable peers"],
      },
    );
    expect(
      plan.sourceLedger.sources.find((source) => source.id === "market-yahoo-equity-amd"),
    ).toMatchObject({ lane: "target-valuation", kind: "market-data", provider: "yahoo" });
    expect(
      plan.sourceLedger.sources.find(
        (source) => source.id === "extended-sec-edgar-amd-fundamentals",
      ),
    ).toMatchObject({
      lane: "target-valuation",
      kind: "extended-evidence",
      provider: "sec-edgar",
    });
  });

  test("keeps target and peer valuation gaps in their own lanes", () => {
    const plan = plannedAndAssessed(
      { jobType: "equity", assetClass: "equity", symbol: "NVDA", depth: "deep" },
      collectedSources({
        valuationComps: {
          version: 1,
          generatedAt,
          target: {
            symbol: "NVDA",
            sourceIds: ["market-yahoo-equity-nvda"],
            usable: true,
          },
          peers: [
            {
              symbol: "AMD",
              sourceIds: ["market-yahoo-equity-amd"],
              usable: false,
            },
          ],
          excludedPeers: [],
          peerUniverseSourceIds: [],
          summary: {
            corePeerCount: 1,
            secondaryPeerCount: 0,
            usablePeerCount: 0,
            valuationSupportability: "not-supportable",
          },
          sourceIds: ["market-yahoo-equity-nvda", "market-yahoo-equity-amd"],
          freshnessFlags: {
            targetQuoteFresh: true,
            targetSecFresh: true,
            peerQuoteFresh: true,
            peerSecFresh: false,
          },
        },
        sourceGaps: [
          sourceGap({
            source: "valuation",
            message: "Valuation peer comps not-supportable for NVDA: 0 usable peers",
            capability: "extended-evidence",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
          sourceGap({
            source: "valuation-peers",
            message: "Peer AMD excluded from valuation comps: missing SEC facts",
            capability: "extended-evidence",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ],
      }),
    );

    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "target-valuation")).toMatchObject(
      {
        gapText: ["valuation: Valuation peer comps not-supportable for NVDA: 0 usable peers"],
      },
    );
    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "peer-valuation")).toMatchObject({
      gapText: ["valuation-peers: Peer AMD excluded from valuation comps: missing SEC facts"],
    });
  });

  test("marks crypto ticker on-chain as applicable without equity-only IV", () => {
    const plan = plannedAndAssessed(
      { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "deep" },
      collectedSources({
        marketSnapshots: [
          marketSnapshot({
            sourceId: "market-coingecko-bitcoin",
            assetClass: "crypto",
            symbol: "BTC",
          }),
        ],
        sourceGaps: [
          sourceGap({
            source: "glassnode-on-chain",
            message: "missing MARKET_BOT_GLASSNODE_API_KEY",
            capability: "extended-evidence",
            cause: "missing-credential",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ],
      }),
    );

    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).toContain("on-chain");
    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).toContain("subject-profile");
    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).not.toContain("derivatives-volatility");
    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "on-chain")).toMatchObject({
      status: "gap",
      evidenceClass: "supplemental",
    });
    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "subject-profile")).toMatchObject({
      status: "not-covered",
      evidenceClass: "supplemental",
    });
  });

  test("keeps derivatives supplemental regardless of dated event context", () => {
    const command = {
      jobType: "equity" as const,
      assetClass: "equity" as const,
      symbol: "AAPL",
      depth: "deep" as const,
    };
    const sourcePlan = buildSourcePlan(command, generatedAt);
    const withEventAndCapability = assessSourcePlan(
      sourcePlan,
      collectedSources({
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-06-10",
            timing: "amc",
            sourceIds: ["event-aapl"],
            fetchedAt: generatedAt,
          },
          gaps: [],
        },
        extendedEvidence: {
          instrument: { symbol: "AAPL", assetClass: "equity" },
          items: [
            {
              category: "options-iv",
              title: "AAPL options IV",
              summary: "IV term structure captured.",
              sourceIds: ["options-aapl"],
              observedAt: generatedAt,
            },
          ],
          gaps: [],
        },
      }),
      generatedAt,
    );

    expect(
      sourcePlan.lanes.find((lane) => lane.lane === "derivatives-volatility")?.evidenceClass,
    ).toBe("supplemental");
    expect(
      withEventAndCapability.evidenceLanes.lanes.find(
        (lane) => lane.lane === "derivatives-volatility",
      )?.evidenceClass,
    ).toBe("supplemental");
  });

  test("plan contents are unchanged by differing collection outcomes", () => {
    const command = {
      jobType: "equity" as const,
      assetClass: "equity" as const,
      symbol: "AAPL",
      depth: "deep" as const,
    };
    const sourcePlan = buildSourcePlan(command, generatedAt);
    const frozen = structuredClone(sourcePlan);

    const emptyOutcome = assessSourcePlan(sourcePlan, collectedSources(), generatedAt);
    const richOutcome = assessSourcePlan(
      sourcePlan,
      collectedSources({
        marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-aapl" })],
        newsSources: [newsSource({ id: "news-yahoo-aapl", provider: "yahoo-news", kind: "news" })],
        sourceGaps: [
          sourceGap({
            source: "yahoo-verified-chart",
            message: "source request failed with status 500",
            capability: "market-data",
            cause: "fetch-failed",
            evidenceQualityImpact: "core-cap",
          }),
        ],
      }),
      generatedAt,
    );

    expect(emptyOutcome.sourcePlan).toEqual(frozen);
    expect(richOutcome.sourcePlan).toEqual(frozen);
    expect(sourcePlan).toEqual(frozen);
  });

  test("assessment covers every planned lane", () => {
    const command = {
      jobType: "equity" as const,
      assetClass: "equity" as const,
      symbol: "AAPL",
      depth: "deep" as const,
    };
    const sourcePlan = buildSourcePlan(command, generatedAt);
    const assessed = assessSourcePlan(sourcePlan, collectedSources(), generatedAt);

    expect(assessed.evidenceLanes.lanes.map((lane) => lane.lane)).toEqual(
      sourcePlan.lanes.map((lane) => lane.lane),
    );
    expect(assessed.evidenceLanes.summary.plannedLaneCount).toBe(sourcePlan.lanes.length);
  });

  test("missing core evidence degrades Evidence Quality without aborting", () => {
    const command = {
      jobType: "equity" as const,
      assetClass: "equity" as const,
      symbol: "AAPL",
      depth: "deep" as const,
    };
    const assessed = assessSourcePlan(
      buildSourcePlan(command, generatedAt),
      collectedSources(),
      generatedAt,
    );
    const quality = assessEvidenceQuality(assessed, generatedAt);

    expect(quality.label).toBe("low");
    expect(
      assessed.evidenceLanes.lanes
        .filter((lane) => lane.evidenceClass === "core")
        .every((lane) => lane.status !== "covered"),
    ).toBe(true);
  });
});
