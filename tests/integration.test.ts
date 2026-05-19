import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import type { MarketSnapshot, Source } from "../src/domain/types";
import type { ModelProvider } from "../src/model/types";
import { runResearchJob } from "../src/research/orchestrator";

const config: AppConfig = {
  provider: "openai",
  quickModel: "quick",
  synthesisModel: "synthesis",
  dataDir: "data/runs",
  sourceOptions: {
    equityMoverLimit: 3,
    cryptoMoverLimit: 3,
    newsLimit: 3,
  },
};

function snapshot(assetClass: "equity" | "crypto", symbol: string): MarketSnapshot {
  return {
    sourceId: `market-${symbol.toLowerCase()}`,
    assetClass,
    symbol,
    price: 100,
    changePercent24h: 3,
    volume: 1000000,
    observedAt: "2026-05-19T00:00:00.000Z",
  };
}

function news(assetClass: "equity" | "crypto"): Source {
  return {
    id: `news-${assetClass}-1`,
    title: `${assetClass} update`,
    fetchedAt: "2026-05-19T00:00:00.000Z",
    kind: "news",
    assetClass,
  };
}

const provider: ModelProvider = {
  name: "mock",
  generate: async (request) => {
    const command = request.messages[1]?.content.includes("\"jobType\": \"ticker\"") ? "ticker" : "daily";

    return {
      content: JSON.stringify({
        summary: `${command} report from supplied sources.`,
        keyFindings: [{ text: "Market source is present.", sourceIds: ["market-btc"] }],
        bullCase: [],
        bearCase: [],
        risks: [],
        catalysts: [],
        scenarios: [],
        confidence: "medium",
        dataGaps: ["Only mocked sources were supplied"],
      }),
      tokenEstimate: 10,
      costEstimateUsd: 0,
    };
  },
};

describe("mocked research workflows", () => {
  test("runs daily crypto and ticker crypto with identical artifact layout", async () => {
    const collectedSources = {
      rawSnapshots: [],
      marketSnapshots: [snapshot("crypto", "BTC")],
      newsSources: [news("crypto")],
    };
    const daily = await runResearchJob({
      command: { jobType: "daily", assetClass: "crypto", depth: "brief" },
      config,
      provider,
      collectedSources,
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const ticker = await runResearchJob({
      command: { jobType: "ticker", assetClass: "crypto", symbol: "BTC", depth: "deep" },
      config,
      provider,
      collectedSources,
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(daily.report.symbol).toBeUndefined();
    expect(ticker.report.symbol).toBe("BTC");
    expect(daily.markdown).toContain("[market-btc]");
    expect(ticker.markdown).toContain("[market-btc]");
    expect(ticker.trace.depth).toBe("deep");
  });
});
