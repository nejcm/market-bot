// Shared fixtures and helpers for the orchestrator test suite. The suite is split
// Into thematic files (orchestrator-*.test.ts); everything they hold in common lives
// Here so each file imports the same config, provider fixtures, and builders.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../../src/config";
import type { MarketContext, MarketSnapshot, Source } from "../../src/domain/types";
import type { runResearchJob } from "../../src/research/orchestrator";
import { isRecord } from "../../src/sources/guards";
import { marketSnapshot, newsSource } from "./fixtures";

const defaultDataDir = join(
  tmpdir(),
  `market-bot-orchestrator-empty-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);

export const config: AppConfig = {
  provider: "openai",
  quickModel: "quick-test",
  synthesisModel: "synthesis-test",
  modelTimeoutMs: 120_000,
  dataDir: defaultDataDir,
  promptDir: "prompts",
  sourceOptions: {
    equityMoverLimit: 2,
    cryptoMoverLimit: 2,
    newsLimit: 2,
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

export const evidenceConfig: AppConfig = {
  ...config,
  sourceOptions: {
    ...config.sourceOptions,
    secUserAgent: "market-bot test@example.test",
  },
  evidenceRequestOptions: {
    maxRounds: 2,
    maxToolCalls: 2,
    sourceBudget: 8,
  },
};

export const marketSnapshots: readonly MarketSnapshot[] = [
  marketSnapshot({ price: 190, volume: 80_000_000 }),
];

export const newsSources: readonly Source[] = [
  newsSource({ title: "Apple supplier demand improves" }),
];

export const marketContextSources: readonly Source[] = [
  {
    id: "market-context-fred-macro",
    title: "FRED macro Market Context",
    fetchedAt: "2026-05-19T00:00:00.000Z",
    kind: "market-context",
    assetClass: "equity",
    provider: "fred",
  },
];

export const marketContext: MarketContext = {
  assetClass: "equity",
  items: [
    {
      category: "fred-macro",
      title: "FRED macro Market Context",
      summary: "Latest FRED macro observations captured for DGS10.",
      sourceIds: ["market-context-fred-macro"],
      observedAt: "2026-05-19T00:00:00.000Z",
      metrics: {
        DGS10: 4.25,
        DGS10Change: 0.15,
      },
    },
  ],
  gaps: [],
};

export interface DataDirRegistry {
  readonly dataDirs: string[];
  readonly tempDataDir: (prefix: string) => string;
  readonly cleanupDataDirs: () => Promise<void>;
}

// Each split file owns its own registry so afterEach cleanup is scoped per file.
export function createDataDirRegistry(): DataDirRegistry {
  const dataDirs: string[] = [];
  return {
    dataDirs,
    tempDataDir(prefix: string): string {
      const dataDir = join(
        tmpdir(),
        `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      dataDirs.push(dataDir);
      return dataDir;
    },
    async cleanupDataDirs(): Promise<void> {
      await Promise.all(
        dataDirs.splice(0).map((dataDir) => rm(dataDir, { recursive: true, force: true })),
      );
    },
  };
}

export async function writeHistoricalRun(input: {
  readonly dataDir: string;
  readonly runId: string;
  readonly jobType: "daily" | "weekly" | "equity" | "crypto";
  readonly generatedAt: string;
  readonly symbol?: string;
  readonly snapshots?: readonly MarketSnapshot[];
  readonly predictions?: readonly unknown[];
}): Promise<void> {
  const runDir = join(input.dataDir, input.runId);
  await mkdir(join(runDir, "normalized"), { recursive: true });
  await writeFile(
    join(runDir, "report.json"),
    JSON.stringify({
      runId: input.runId,
      jobType: input.jobType,
      assetClass: "equity",
      ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
      generatedAt: input.generatedAt,
      summary: `${input.runId} prior research summary.`,
      keyFindings: [{ text: "Prior sourced finding.", sourceIds: ["prior-source"] }],
      bullCase: [],
      bearCase: [],
      risks: [{ text: "Prior risk.", sourceIds: ["prior-source"] }],
      catalysts: [{ text: "Prior catalyst.", sourceIds: ["prior-source"] }],
      scenarios: [],
      evidenceQuality: "medium",
      dataGaps: [],
      predictions: input.predictions ?? [],
      sources: [],
      notFinancialAdvice: true,
    }),
    "utf8",
  );
  await writeFile(
    join(runDir, "normalized", "market-snapshots.json"),
    JSON.stringify(input.snapshots ?? []),
    "utf8",
  );
}

export function mockPredictions(count: number, subject = "SPY"): unknown[] {
  // Space horizons by 2 trading days so same-subject direction calls stay distinct.
  // MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS drops adjacent same-direction horizons.
  return Array.from({ length: count }, (_, idx) => {
    const horizon = idx * 2 + 5;
    return {
      id: `pred-${String(idx + 1)}`,
      claim: `${subject} closes higher over ${String(horizon)} trading days.`,
      kind: "direction",
      subject,
      measurableAs: `close(${subject}, +${String(horizon)}) > close(${subject}, 0)`,
      horizonTradingDays: horizon,
      probability: 0.6,
      sourceIds: ["market-aapl"],
      // Model-provided policy metadata must never survive report assembly.
      scoringPolicyVersion: 99,
    };
  });
}

export function modelReport(subject = "AAPL", sourceId = "market-aapl"): string {
  return JSON.stringify({
    summary: `${subject} evidence is sourced.`,
    keyFindings: [{ text: `${subject} has sourced evidence.`, sourceIds: [sourceId] }],
    bullCase: [{ text: "Evidence supports the setup.", sourceIds: [sourceId] }],
    bearCase: [{ text: "Coverage remains incomplete.", sourceIds: [sourceId] }],
    risks: [{ text: "Source coverage can change.", sourceIds: [sourceId] }],
    catalysts: [{ text: "New evidence is visible.", sourceIds: [sourceId] }],
    scenarios: [{ name: "Base", description: "Evidence remains relevant.", sourceIds: [sourceId] }],
    confidence: "medium",
    dataGaps: [],
    predictions: mockPredictions(6, subject),
  });
}

// Returns an empty-selection payload for the gating stages (spotlight/playbook) and a
// Full report otherwise, so a market-update run completes without selecting any spotlight.
export function emptySelectionStageReport(stage: unknown): string {
  if (stage === "spotlight-selection") {
    return JSON.stringify({ rationale: "no movers", selections: [] });
  }
  if (stage === "playbook-selection") {
    return JSON.stringify({ selections: [] });
  }
  return modelReport("AAPL");
}

export function historicalContextGaps(
  result: Awaited<ReturnType<typeof runResearchJob>>,
): readonly string[] {
  const extra = result.report.extras?.historicalContext;
  return isRecord(extra) && Array.isArray(extra.gaps)
    ? extra.gaps.filter((gap): gap is string => typeof gap === "string")
    : [];
}

export function priorStageNames(prompt: Record<string, unknown>): readonly string[] {
  const priorStages = prompt.priorStages as readonly { readonly stage?: string }[] | undefined;
  return priorStages?.map((stage) => stage.stage ?? "") ?? [];
}

export function secEvidenceFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url.includes("company_tickers")) {
    return Promise.resolve(
      Response.json({ "0": { cik_str: 320_193, ticker: "AAPL", title: "Apple Inc." } }),
    );
  }
  if (url.includes("submissions")) {
    return Promise.resolve(
      Response.json({
        filings: {
          recent: {
            form: ["10-Q"],
            filingDate: ["2026-05-01"],
            reportDate: ["2026-03-31"],
            accessionNumber: ["0000320193-26-000077"],
            primaryDocument: ["a10q.htm"],
          },
        },
      }),
    );
  }
  if (url.includes("Archives")) {
    return Promise.resolve(
      new Response(
        "<html><body><p>ITEM 2-MANAGEMENT Latest filing evidence with enough text to clear the section packet threshold.</p></body></html>",
      ),
    );
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

export function secFetchUnavailable(_input: string | URL | Request): Promise<Response> {
  return Promise.resolve(new Response("not found", { status: 404 }));
}
