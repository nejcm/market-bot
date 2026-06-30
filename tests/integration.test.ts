import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config";
import type { AssetClass, MarketSnapshot, Source } from "../src/domain/types";
import type { ModelProvider } from "../src/model/types";
import { persistResearchJob } from "../src/research/orchestrator";
import type { CollectedSources } from "../src/sources/types";
import { parseArgs, type ResearchCommand } from "../src/cli/args";
import {
  collectedSources as collectedSourceBundle,
  marketSnapshot,
  newsSource,
} from "./support/fixtures";

const config: AppConfig = {
  provider: "openai",
  quickModel: "quick",
  synthesisModel: "synthesis",
  modelTimeoutMs: 120_000,
  dataDir: "data/runs",
  promptDir: "prompts",
  sourceOptions: {
    equityMoverLimit: 3,
    cryptoMoverLimit: 3,
    newsLimit: 3,
    sourceTimeoutMs: 1000,
  },
  evidenceRequestOptions: {
    maxRounds: 0,
    maxToolCalls: 0,
    sourceBudget: 0,
  },
  webGatherOptions: {
    maxRounds: 0,
    maxToolCalls: 0,
    sourceBudget: 0,
  },
  webGatherDisabled: false,
  webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
  alphaSearchOptions: {
    apeWisdomFilter: "all-stocks",
    apeWisdomBriefPageLimit: 5,
    apeWisdomDeepPageLimit: 10,
    validationCandidateLimit: 25,
    leadLimit: 15,
    topCandidateLimit: 15,
    secDiscoveryLimit: 25,
    secFormTypes: ["S-1", "F-1", "8-K", "6-K"],
    minPrice: 0.5,
    minVolume: 100_000,
    minMarketCap: 50_000_000,
    maxMarketCap: 10_000_000_000,
  },
};

const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dataDirs.splice(0).map((dataDir) => rm(dataDir, { recursive: true, force: true })),
  );
});

function snapshot(assetClass: AssetClass, symbol: string): MarketSnapshot {
  return marketSnapshot({
    sourceId: `market-${symbol.toLowerCase()}`,
    assetClass,
    symbol,
    changePercent24h: 3,
  });
}

function news(assetClass: AssetClass): Source {
  return newsSource({ id: `news-${assetClass}-1`, title: `${assetClass} update`, assetClass });
}

function collectedSources(assetClass: AssetClass, symbol: string): CollectedSources {
  return collectedSourceBundle({
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
  });
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

function parseResearchCommand(args: readonly string[]): ResearchCommand {
  const command = parseArgs(args);
  if (
    command.jobType === "market-overview" ||
    command.jobType === "equity" ||
    command.jobType === "crypto"
  ) {
    return command;
  }
  throw new Error("Expected research command");
}

describe("mocked research workflows", () => {
  test("persists daily, weekly, and ticker workflows with matching artifact layout", async () => {
    const workflows = [
      await runWorkflow(
        {
          jobType: "market-overview",
          assetClass: "equity",
          depth: "brief",
          horizonTradingDays: 5,
          legacyAlias: "daily",
        },
        "AAPL",
      ),
      await runWorkflow(
        {
          jobType: "market-overview",
          assetClass: "crypto",
          depth: "brief",
          horizonTradingDays: 5,
          legacyAlias: "daily",
        },
        "BTC",
      ),
      await runWorkflow(
        {
          jobType: "market-overview",
          assetClass: "equity",
          depth: "brief",
          horizonTradingDays: 15,
          legacyAlias: "weekly",
        },
        "AAPL",
      ),
      await runWorkflow(
        { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
        "AAPL",
      ),
      await runWorkflow(
        { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "deep" },
        "BTC",
      ),
    ];

    for (const workflow of workflows) {
      await expect(readdir(workflow.artifacts.runDir)).resolves.toEqual(
        expect.arrayContaining([
          "normalized",
          "raw",
          "analytics.json",
          "report.json",
          "report.md",
          "stages.json",
          "trace.json",
        ]),
      );
      await expect(readdir(workflow.artifacts.rawDir)).resolves.toEqual(["snapshots.json"]);
      await expect(readdir(workflow.artifacts.normalizedDir)).resolves.toEqual(
        expect.arrayContaining([
          "extended-evidence.json",
          "extended-sources.json",
          "market-context.json",
          "market-snapshots.json",
          "news-sources.json",
          "source-gaps.json",
        ]),
      );
      await expect(
        readFile(join(workflow.artifacts.runDir, "report.md"), "utf8"),
      ).resolves.toContain("Research-only note");
      await expect(
        readFile(join(workflow.artifacts.runDir, "stages.json"), "utf8"),
      ).resolves.toContain("final-synthesis");
    }

    expect(workflows.map((workflow) => workflow.report.jobType)).toEqual([
      "market-overview",
      "market-overview",
      "market-overview",
      "equity",
      "crypto",
    ]);
    expect(workflows.map((workflow) => workflow.report.assetClass)).toEqual([
      "equity",
      "crypto",
      "equity",
      "equity",
      "crypto",
    ]);
    expect(workflows[0]?.report.symbol).toBeUndefined();
    expect(workflows[2]?.trace.legacyMarketUpdateAlias).toBe("weekly");
    expect(workflows[3]?.report.symbol).toBe("AAPL");
    expect(workflows[4]?.trace.depth).toBe("deep");
    expect(workflows[4]?.report.extras?.depth).toBe("deep");
  });

  test("persists canonical market-overview fields from CLI-shaped commands", async () => {
    const overview = await runWorkflow(
      parseResearchCommand(["market-overview", "--asset", "equity", "--horizon", "7"]),
      "AAPL",
    );
    const alias = await runWorkflow(parseResearchCommand(["daily", "--asset", "equity"]), "AAPL");

    expect(overview.report.jobType).toBe("market-overview");
    expect(overview.report.horizonTradingDays).toBe(7);
    expect(overview.report.extras?.marketUpdateHorizonBucket).toBe("6-10d");
    expect(overview.trace.jobType).toBe("market-overview");
    expect(overview.trace.marketUpdateHorizonBucket).toBe("6-10d");

    expect(alias.report.jobType).toBe("market-overview");
    expect(alias.report.horizonTradingDays).toBe(5);
    expect(alias.report.extras?.legacyMarketUpdateAlias).toBe("daily");
    expect(alias.report.extras?.marketUpdateHorizonBucket).toBe("1-5d");
    expect(alias.trace.legacyMarketUpdateAlias).toBe("daily");
  });
});
