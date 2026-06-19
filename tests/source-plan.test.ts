import { describe, expect, test } from "bun:test";
import { sourceGap } from "../src/domain/source-gaps";
import { buildSourcePlan } from "../src/research/source-plan";
import { collectedSources, marketSnapshot, newsSource } from "./support/fixtures";

const generatedAt = "2026-05-19T00:00:00.000Z";

describe("source plan", () => {
  test("covers only lanes backed by collected sources and records required gaps", () => {
    const plan = buildSourcePlan(
      { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
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

    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).toContain("options-iv");
    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).not.toContain("on-chain");
    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "market-data")).toMatchObject({
      status: "covered",
      coveredSourceIds: ["market-yahoo-equity-aapl"],
    });
    expect(
      plan.evidenceLanes.lanes.find((lane) => lane.lane === "verified-snapshot"),
    ).toMatchObject({
      status: "gap",
      required: true,
      gapText: ["yahoo-verified-chart: source request failed with status 500"],
    });
    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "sec-edgar")).toMatchObject({
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
    expect(plan.evidenceLanes.summary.requiredGapLaneCount).toBe(0);
  });

  test("marks crypto ticker on-chain as applicable without equity-only IV", () => {
    const plan = buildSourcePlan(
      { jobType: "ticker", assetClass: "crypto", symbol: "BTC", depth: "deep" },
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
    expect(plan.sourcePlan.lanes.map((lane) => lane.lane)).not.toContain("options-iv");
    expect(plan.evidenceLanes.lanes.find((lane) => lane.lane === "on-chain")).toMatchObject({
      status: "gap",
      required: false,
    });
  });
});
