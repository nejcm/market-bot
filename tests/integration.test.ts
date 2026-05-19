import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config";
import type { AssetClass, MarketSnapshot, Source } from "../src/domain/types";
import type { ModelProvider } from "../src/model/types";
import { persistResearchJob, type CollectedSources } from "../src/research/orchestrator";
import type { ResearchCommand } from "../src/cli/args";

const config: AppConfig = {
  provider: "openai",
  quickModel: "quick",
  synthesisModel: "synthesis",
  dataDir: "data/runs",
  sourceOptions: {
    equityMoverLimit: 3,
    cryptoMoverLimit: 3,
    newsLimit: 3,
    sourceTimeoutMs: 1000,
  },
};

const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dataDirs.splice(0).map((dataDir) => rm(dataDir, { recursive: true, force: true })),
  );
});

function snapshot(assetClass: AssetClass, symbol: string): MarketSnapshot {
  return {
    sourceId: `market-${symbol.toLowerCase()}`,
    assetClass,
    symbol,
    price: 100,
    changePercent24h: 3,
    volume: 1_000_000,
    observedAt: "2026-05-19T00:00:00.000Z",
  };
}

function news(assetClass: AssetClass): Source {
  return {
    id: `news-${assetClass}-1`,
    title: `${assetClass} update`,
    fetchedAt: "2026-05-19T00:00:00.000Z",
    kind: "news",
    assetClass,
  };
}

function collectedSources(assetClass: AssetClass, symbol: string): CollectedSources {
  return {
    rawSnapshots: [
      {
        id: `raw-${assetClass}-${symbol}`,
        adapter: "mock",
        fetchedAt: "2026-05-19T00:00:00.000Z",
        payload: { symbol },
      },
    ],
    marketSnapshots: [snapshot(assetClass, symbol)],
    newsSources: [news(assetClass)],
    sourceGaps: [],
  };
}

const provider: ModelProvider = {
  name: "mock",
  generate: async (request) => {
    const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as {
      readonly evidence?: {
        readonly command?: ResearchCommand;
        readonly marketSnapshots?: readonly MarketSnapshot[];
      };
    };
    const command = prompt.evidence?.command;
    const marketSourceId = prompt.evidence?.marketSnapshots?.[0]?.sourceId ?? "market-unknown";

    return {
      content: JSON.stringify({
        summary: `${command?.jobType ?? "unknown"} ${command?.assetClass ?? "unknown"} report from supplied sources.`,
        keyFindings: [{ text: "Market source is present.", sourceIds: [marketSourceId] }],
        bullCase: [{ text: "Source trend is constructive.", sourceIds: [marketSourceId] }],
        bearCase: [{ text: "Evidence remains limited.", sourceIds: [marketSourceId] }],
        risks: [{ text: "Mocked data limits interpretation.", sourceIds: [marketSourceId] }],
        catalysts: [
          { text: "Observed move is the visible catalyst.", sourceIds: [marketSourceId] },
        ],
        scenarios: [
          {
            name: "Base",
            description: "Conditions remain source-dependent.",
            sourceIds: [marketSourceId],
          },
        ],
        confidence: "medium",
        dataGaps: ["Only mocked sources were supplied"],
      }),
      tokenEstimate: 10,
      costEstimateUsd: 0,
    };
  },
};

async function runWorkflow(command: ResearchCommand, symbol: string) {
  const dataDir = join(
    tmpdir(),
    `market-bot-integration-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  dataDirs.push(dataDir);

  return persistResearchJob({
    command,
    config: {
      ...config,
      dataDir,
    },
    provider,
    collectedSources: collectedSources(command.assetClass, symbol),
    now: new Date("2026-05-19T00:00:00.000Z"),
  });
}

describe("mocked research workflows", () => {
  test("persists daily, weekly, and ticker workflows with matching artifact layout", async () => {
    const workflows = [
      await runWorkflow({ jobType: "daily", assetClass: "equity", depth: "brief" }, "AAPL"),
      await runWorkflow({ jobType: "daily", assetClass: "crypto", depth: "brief" }, "BTC"),
      await runWorkflow({ jobType: "weekly", assetClass: "equity", depth: "brief" }, "AAPL"),
      await runWorkflow(
        { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
        "AAPL",
      ),
      await runWorkflow(
        { jobType: "ticker", assetClass: "crypto", symbol: "BTC", depth: "deep" },
        "BTC",
      ),
    ];

    for (const workflow of workflows) {
      await expect(readdir(workflow.artifacts.runDir)).resolves.toEqual(
        expect.arrayContaining([
          "normalized",
          "raw",
          "report.json",
          "report.md",
          "stages.json",
          "trace.json",
        ]),
      );
      await expect(readdir(workflow.artifacts.rawDir)).resolves.toEqual(["snapshots.json"]);
      await expect(readdir(workflow.artifacts.normalizedDir)).resolves.toEqual([
        "market-snapshots.json",
        "news-sources.json",
        "source-gaps.json",
      ]);
      await expect(
        readFile(join(workflow.artifacts.runDir, "report.md"), "utf8"),
      ).resolves.toContain("Research-only note");
      await expect(
        readFile(join(workflow.artifacts.runDir, "stages.json"), "utf8"),
      ).resolves.toContain("final-synthesis");
    }

    expect(workflows.map((workflow) => workflow.report.jobType)).toEqual([
      "daily",
      "daily",
      "weekly",
      "ticker",
      "ticker",
    ]);
    expect(workflows.map((workflow) => workflow.report.assetClass)).toEqual([
      "equity",
      "crypto",
      "equity",
      "equity",
      "crypto",
    ]);
    expect(workflows[0]?.report.symbol).toBeUndefined();
    expect(workflows[2]?.trace.marketUpdateCadence).toBe("weekly");
    expect(workflows[3]?.report.symbol).toBe("AAPL");
    expect(workflows[4]?.trace.depth).toBe("deep");
    expect(workflows[4]?.report.extras?.depth).toBe("deep");
  });
});
