import { describe, expect, test } from "bun:test";
import { sourceGap } from "../src/domain/source-gaps";
import { buildSourcePlan } from "../src/research/source-plan";
import { collectedSources, marketSnapshot, newsSource } from "./support/fixtures";

const generatedAt = "2026-05-19T00:00:00.000Z";

describe("source plan", () => {
  test("covers only lanes backed by collected sources and records required gaps", () => {
    const plan = buildSourcePlan(
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
      generatedAt,
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
    const plan = buildSourcePlan(
      { jobType: "research", assetClass: "equity", subject: "unknown niche", depth: "brief" },
      collectedSources({
        newsSources: [newsSource({ id: "news-subject", provider: "yahoo-news" })],
      }),
      generatedAt,
    );

    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).toEqual(["supplemental-market", "news"]);
    expect(plan.evidenceLanes.summary.coreGapLaneCount).toBe(0);
  });

  test("keeps required market-data gap for resolved research proxy failures", () => {
    const plan = buildSourcePlan(
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
      generatedAt,
    );

    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).toContain("market-data");
    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "market-data")).toMatchObject({
      status: "gap",
      evidenceClass: "core",
      gapText: ["yahoo-research-proxy: source request failed with status 500"],
    });
  });

  test("attributes supplemental Massive snapshots to Massive in the source ledger", () => {
    const plan = buildSourcePlan(
      {
        jobType: "market-overview",
        assetClass: "equity",
        depth: "brief",
        horizonTradingDays: 5,
        legacyAlias: "daily",
      },
      collectedSources({
        supplementalMarketSnapshots: [
          marketSnapshot({
            sourceId: "supplemental-market-massive-equity-aapl",
            assetClass: "equity",
            symbol: "AAPL",
          }),
        ],
      }),
      generatedAt,
    );

    expect(
      plan.sourceLedger.sources.find(
        (source) => source.id === "supplemental-market-massive-equity-aapl",
      ),
    ).toMatchObject({ provider: "massive", lane: "supplemental-market" });
  });

  test("maps valuation peer-comp source IDs and gaps into the valuation lane", () => {
    const plan = buildSourcePlan(
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
      generatedAt,
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

  test("marks crypto ticker on-chain as applicable without equity-only IV", () => {
    const plan = buildSourcePlan(
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
      generatedAt,
    );

    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).toContain("on-chain");
    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).not.toContain("derivatives-volatility");
    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "on-chain")).toMatchObject({
      status: "gap",
      evidenceClass: "supplemental",
    });
  });

  test("makes derivatives material only for a dated event context", () => {
    const command = {
      jobType: "equity" as const,
      assetClass: "equity" as const,
      symbol: "AAPL",
      depth: "deep" as const,
    };
    const withoutEvent = buildSourcePlan(command, collectedSources(), generatedAt);
    const withEventAndCapability = buildSourcePlan(
      command,
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
      withoutEvent.sourcePlan.lanes.find((lane) => lane.lane === "derivatives-volatility")
        ?.evidenceClass,
    ).toBe("supplemental");
    expect(
      withEventAndCapability.sourcePlan.lanes.find((lane) => lane.lane === "derivatives-volatility")
        ?.evidenceClass,
    ).toBe("material");
  });
});
