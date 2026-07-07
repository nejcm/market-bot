import { afterEach, describe, expect, test } from "bun:test";
import { legacyMarketOverviewCommand } from "./support/commands";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../src/config";
import type { RunConfig } from "../src/config/runs";
import { marketContextGap, sourceGap } from "../src/domain/source-gaps";
import type { MarketContext, MarketSnapshot, Source } from "../src/domain/types";
import type { ModelProvider } from "../src/model/types";
import { persistResearchJob, runResearchJob } from "../src/research/orchestrator";
import { runScorePass } from "../src/scoring";
import { resolveResearchSubject } from "../src/research/research-subject-identity";
import { isRecord } from "../src/sources/guards";
import { readNewsSeenEntries } from "../src/sources/news-seen";
import {
  collectedSources as collectedSourceBundle,
  marketSnapshot,
  newsSource,
} from "./support/fixtures";
import { providerReturning } from "./support/mocks";

const defaultDataDir = join(
  tmpdir(),
  `market-bot-orchestrator-empty-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);

const config: AppConfig = {
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

const marketSnapshots: readonly MarketSnapshot[] = [
  marketSnapshot({ price: 190, volume: 80_000_000 }),
];

const newsSources: readonly Source[] = [newsSource({ title: "Apple supplier demand improves" })];

const evidenceConfig: AppConfig = {
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

const marketContextSources: readonly Source[] = [
  {
    id: "market-context-fred-macro",
    title: "FRED macro Market Context",
    fetchedAt: "2026-05-19T00:00:00.000Z",
    kind: "market-context",
    assetClass: "equity",
    provider: "fred",
  },
];

const marketContext: MarketContext = {
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

const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dataDirs.splice(0).map((dataDir) => rm(dataDir, { recursive: true, force: true })),
  );
});

function tempDataDir(prefix: string): string {
  const dataDir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  dataDirs.push(dataDir);
  return dataDir;
}

async function writeHistoricalRun(input: {
  readonly dataDir: string;
  readonly runId: string;
  readonly jobType: "daily" | "weekly" | "equity" | "crypto";
  readonly generatedAt: string;
  readonly symbol?: string;
  readonly snapshots?: readonly MarketSnapshot[];
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
      predictions: [],
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

function mockPredictions(count: number, subject = "SPY"): unknown[] {
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

function modelReport(subject = "AAPL", sourceId = "market-aapl"): string {
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
function emptySelectionStageReport(stage: unknown): string {
  if (stage === "spotlight-selection") {
    return JSON.stringify({ rationale: "no movers", selections: [] });
  }
  if (stage === "playbook-selection") {
    return JSON.stringify({ selections: [] });
  }
  return modelReport("AAPL");
}

function historicalContextGaps(
  result: Awaited<ReturnType<typeof runResearchJob>>,
): readonly string[] {
  const extra = result.report.extras?.historicalContext;
  return isRecord(extra) && Array.isArray(extra.gaps)
    ? extra.gaps.filter((gap): gap is string => typeof gap === "string")
    : [];
}

function priorStageNames(prompt: Record<string, unknown>): readonly string[] {
  const priorStages = prompt.priorStages as readonly { readonly stage?: string }[] | undefined;
  return priorStages?.map((stage) => stage.stage ?? "") ?? [];
}

function secEvidenceFetch(input: string | URL | Request): Promise<Response> {
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

function secFetchUnavailable(_input: string | URL | Request): Promise<Response> {
  return Promise.resolve(new Response("not found", { status: 404 }));
}

describe("runResearchJob", () => {
  test("uses resolved run models and model params for provider calls and trace", async () => {
    const requests: { readonly model: string; readonly params: unknown }[] = [];
    const runConfig: RunConfig = {
      "market-overview-equity": {
        quickModel: "combo-quick",
        synthesisModel: "combo-synthesis",
        modelParams: { temperature: 0.2, reasoningEffort: "medium" },
        targetPredictions: 2,
      },
      "market-overview-crypto": {},
      "research-equity": {},
      equity: {},
      crypto: {},
    };
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        requests.push({ model: request.model, params: request.params });

        return {
          content: JSON.stringify({
            summary: "Equity market breadth is constructive but source coverage is limited.",
            keyFindings: [{ text: "AAPL is a liquid positive mover.", sourceIds: ["market-aapl"] }],
            bullCase: [{ text: "Demand news supports the move.", sourceIds: ["news-equity-1"] }],
            bearCase: [
              {
                text: "Single-name evidence may not represent the whole market.",
                sourceIds: ["market-aapl"],
              },
            ],
            risks: [{ text: "Macro data is missing.", sourceIds: ["market-aapl"] }],
            catalysts: [
              {
                text: "Supplier demand update is the main catalyst.",
                sourceIds: ["news-equity-1"],
              },
            ],
            scenarios: [
              {
                name: "Base",
                description: "Momentum continues if liquidity persists.",
                sourceIds: ["market-aapl"],
              },
            ],
            confidence: "medium",
            dataGaps: [],
            predictions: mockPredictions(2),
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      runConfig,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
      endClock: () => new Date("2026-05-19T00:00:04.250Z"),
    });

    expect(requests).toEqual([
      { model: "combo-quick", params: { temperature: 0.2, reasoningEffort: "medium" } },
      { model: "combo-quick", params: { temperature: 0.2, reasoningEffort: "medium" } },
      { model: "combo-quick", params: { temperature: 0.2, reasoningEffort: "medium" } },
      { model: "combo-quick", params: { temperature: 0.2, reasoningEffort: "medium" } },
      { model: "combo-synthesis", params: { temperature: 0.2, reasoningEffort: "medium" } },
    ]);
    expect(result.trace.quickModel).toBe("combo-quick");
    expect(result.trace.synthesisModel).toBe("combo-synthesis");
    expect(result.trace.startedAt).toBe("2026-05-19T00:00:00.000Z");
    expect(result.trace.completedAt).toBe("2026-05-19T00:00:04.250Z");
    expect(Date.parse(result.trace.completedAt) - Date.parse(result.trace.startedAt)).toBe(4250);
    expect(result.analytics.calibrationAtGeneration).toMatchObject({
      generatedAt: "2026-05-19T00:00:00.000Z",
      resolvedCount: 0,
    });
  });

  test("continues without calibration context when the run-start refresh fails", async () => {
    const root = tempDataDir("market-bot-calibration-refresh-failure");
    const dataDir = join(root, "runs");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "calibration"), "blocks calibration directory creation", "utf8");
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        return {
          content: emptySelectionStageReport(prompt.stage),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config: { ...config, dataDir },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.analytics.calibrationAtGeneration).toBeUndefined();
  });

  test("runs deep market updates through the coverage panel before critique and synthesis", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        return {
          content: JSON.stringify({
            summary: "Deep equity review from supplied sources.",
            keyFindings: [{ text: "AAPL has sourced momentum.", sourceIds: ["market-aapl"] }],
            bullCase: [
              { text: "News supports the sourced momentum.", sourceIds: ["news-equity-1"] },
            ],
            bearCase: [
              { text: "Single-source breadth limits confidence.", sourceIds: ["market-aapl"] },
            ],
            risks: [{ text: "Macro context is incomplete.", sourceIds: ["market-aapl"] }],
            catalysts: [
              { text: "Supplier news is the visible catalyst.", sourceIds: ["news-equity-1"] },
            ],
            scenarios: [
              {
                name: "Base",
                description: "Momentum persists if liquidity remains.",
                sourceIds: ["market-aapl"],
              },
            ],
            confidence: "medium",
            dataGaps: [],
            predictions: mockPredictions(3),
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "deep" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const rolePrompts = prompts.filter(
      (prompt) =>
        prompt.stage === "regime-context-analysis" || prompt.stage === "mover-theme-analysis",
    );
    const critiquePrompt = prompts.find((prompt) => prompt.stage === "critique") ?? {};
    const finalPrompt = (prompts.find((prompt) => prompt.stage === "final-synthesis") ?? {}) as {
      readonly depthProfile?: {
        readonly depth?: string;
        readonly analystStyle?: string;
        readonly minimumKeyFindings?: number;
        readonly minimumScenarios?: number;
      };
      readonly evidence?: {
        readonly marketRegime?: {
          readonly label?: string;
          readonly sourceIds?: readonly string[];
        };
      };
    };

    expect(result.trace.stages).toEqual([
      "source-collection",
      "spotlight-selection",
      "playbook-selection",
      "specialist-analysis",
      "regime-context-analysis",
      "mover-theme-analysis",
      "critique",
      "final-synthesis",
    ]);
    expect(result.stageOutputs.map((output) => output.stage)).toEqual([
      "spotlight-selection",
      "playbook-selection",
      "specialist-analysis",
      "regime-context-analysis",
      "mover-theme-analysis",
      "critique",
      "final-synthesis",
    ]);
    expect(new Set(rolePrompts.map((prompt) => prompt.stage))).toEqual(
      new Set(["regime-context-analysis", "mover-theme-analysis"]),
    );
    expect(rolePrompts.map((prompt) => priorStageNames(prompt))).toEqual([
      ["specialist-analysis"],
      ["specialist-analysis"],
    ]);
    expect(priorStageNames(critiquePrompt)).toEqual([
      "specialist-analysis",
      "regime-context-analysis",
      "mover-theme-analysis",
    ]);
    expect(priorStageNames(finalPrompt)).toEqual([
      "specialist-analysis",
      "regime-context-analysis",
      "mover-theme-analysis",
      "critique",
    ]);
    expect(result.report.extras?.depth).toBe("deep");
    expect(finalPrompt.depthProfile).toMatchObject({
      depth: "deep",
      analystStyle: "fuller analyst-style",
      minimumKeyFindings: 5,
      minimumScenarios: 3,
    });
    expect(finalPrompt.evidence?.marketRegime).toMatchObject({
      label: "insufficient-data",
      sourceIds: [],
    });
  });

  test("runs empty evidence request round before deep equity ticker analysis", async () => {
    const calls: {
      readonly model: string;
      readonly prompt: Record<string, unknown>;
      readonly requestKeys: readonly string[];
    }[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        calls.push({ model: request.model, prompt, requestKeys: Object.keys(request) });
        if (prompt.stage === "evidence-request") {
          return {
            content: JSON.stringify({ requests: [] }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        return {
          content: modelReport(),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        sourceOptions: { ...evidenceConfig.sourceOptions, tradierApiToken: "tradier-token" },
      },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      sourceFetchImpl: secFetchUnavailable,
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(calls[0]?.prompt.stage).toBe("evidence-request");
    expect(calls[1]?.prompt.stage).toBe("playbook-selection");
    expect(calls[2]?.prompt.stage).toBe("specialist-analysis");
    expect(new Set(calls.slice(3, 5).map((call) => call.prompt.stage))).toEqual(
      new Set(["instrument-evidence-analysis", "market-behavior-analysis"]),
    );
    expect(calls.slice(5).map((call) => call.prompt.stage)).toEqual([
      "critique",
      "final-synthesis",
    ]);
    expect(calls[0]?.model).toBe("quick-test");
    expect(calls[0]?.requestKeys).not.toContain("tools");
    expect(calls[0]?.prompt.requiredShape).toEqual({
      requests: [
        {
          tool: "tradier_iv_term_structure",
          args: { symbol: "run symbol only" },
          rationale: "string",
        },
      ],
    });
    const evidenceRequestPrompt = calls[0]?.prompt.evidence as
      | {
          readonly evidenceRequest?: {
            readonly availableTools?: readonly string[];
            readonly toolUnits?: Record<string, number>;
          };
        }
      | undefined;
    expect(evidenceRequestPrompt?.evidenceRequest).toMatchObject({
      availableTools: ["tradier_iv_term_structure"],
      toolUnits: { sec_latest_filing: 5, tradier_iv_term_structure: 5 },
    });
    expect(result.trace.stages).toEqual([
      "source-collection",
      "evidence-request",
      "playbook-selection",
      "specialist-analysis",
      "instrument-evidence-analysis",
      "market-behavior-analysis",
      "critique",
      "final-synthesis",
    ]);
    expect(result.trace.evidenceRequestLoop).toMatchObject({
      rounds: 1,
      sourceUnitsUsed: 0,
      executedTools: [],
    });
  });

  test("loads ticker history before the evidence request loop", async () => {
    const dataDir = tempDataDir("market-bot-history-prompt");
    await writeHistoricalRun({
      dataDir,
      runId: "prior-aapl-ticker",
      jobType: "equity",
      symbol: "AAPL",
      generatedAt: "2026-05-01T00:00:00.000Z",
      snapshots: marketSnapshots,
    });
    await writeHistoricalRun({
      dataDir,
      runId: "prior-daily-equity",
      jobType: "daily",
      generatedAt: "2026-05-02T00:00:00.000Z",
      snapshots: marketSnapshots,
    });
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        return {
          content:
            prompt.stage === "evidence-request" || prompt.stage === "playbook-selection"
              ? JSON.stringify({ selections: [], requests: [] })
              : modelReport("AAPL"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        dataDir,
        sourceOptions: { ...evidenceConfig.sourceOptions, tradierApiToken: "tradier-token" },
      },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      sourceFetchImpl: secEvidenceFetch,
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const evidencePrompt = prompts[0] as {
      readonly evidence?: {
        readonly historicalContext?: {
          readonly runs?: readonly { readonly runId?: string }[];
          readonly sourceIds?: readonly string[];
        };
      };
    };

    expect(prompts[0]?.stage).toBe("evidence-request");
    expect(evidencePrompt.evidence?.historicalContext?.runs?.map((run) => run.runId)).toEqual([
      "prior-daily-equity",
      "prior-aapl-ticker",
    ]);
    expect(evidencePrompt.evidence?.historicalContext?.sourceIds).toContain(
      "history-report-prior-aapl-ticker",
    );
    expect(result.report.sources.map((source) => source.id)).toContain(
      "history-report-prior-aapl-ticker",
    );
    expect(result.report.extras?.historicalContext).toBeDefined();
    expect(result.trace.historicalContext?.selectedRunCount).toBe(2);
  });

  test("allows final reports to cite loaded historical report sources", async () => {
    const dataDir = tempDataDir("market-bot-history-source-validation");
    await writeHistoricalRun({
      dataDir,
      runId: "prior-aapl-ticker",
      jobType: "equity",
      symbol: "AAPL",
      generatedAt: "2026-05-01T00:00:00.000Z",
      snapshots: marketSnapshots,
    });

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config: { ...config, dataDir },
      provider: providerReturning(modelReport("AAPL", "history-report-prior-aapl-ticker")),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.keyFindings[0]?.sourceIds).toEqual(["history-report-prior-aapl-ticker"]);
    expect(result.report.sources.map((source) => source.id)).toContain(
      "history-report-prior-aapl-ticker",
    );
  });

  test("surfaces an unreadable alpha-watchlist gap for market-update runs but not ticker runs", async () => {
    const dataDir = tempDataDir("market-bot-alpha-gap");
    // Present-but-unreadable watchlist → loadAlphaWatchlistForSpotlights returns a gap.
    await mkdir(join(dataDir, "alpha-search"), { recursive: true });
    await writeFile(join(dataDir, "alpha-search", "watchlist.json"), "{not-json", "utf8");
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        return {
          content: emptySelectionStageReport(prompt.stage),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };
    const collected = collectedSourceBundle({
      rawSnapshots: [],
      marketSnapshots,
      newsSources,
      sourceGaps: [],
    });
    const ALPHA_GAP = "Unable to read alpha-search watchlist for spotlight enrichment";

    const ticker = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config: { ...config, dataDir },
      provider,
      collectedSources: collected,
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const daily = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config: { ...config, dataDir },
      provider,
      collectedSources: collected,
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    // The watchlist is only consumed for market-update spotlight enrichment, so its load
    // Failure is a meaningful gap only for daily/weekly runs — never ticker runs.
    expect(historicalContextGaps(ticker)).not.toContain(ALPHA_GAP);
    expect(historicalContextGaps(daily)).toContain(ALPHA_GAP);
  });

  test("runs market spotlight selection before playbooks and exposes selected extras", async () => {
    const dataDir = tempDataDir("market-bot-spotlight");
    await writeHistoricalRun({
      dataDir,
      runId: "prior-aapl-ticker",
      jobType: "equity",
      symbol: "AAPL",
      generatedAt: "2026-05-01T00:00:00.000Z",
      snapshots: marketSnapshots,
    });
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "spotlight-selection") {
          return {
            content: JSON.stringify({
              rationale: "AAPL has the strongest current mover evidence.",
              selections: [
                {
                  symbol: "AAPL",
                  rationale: "Liquid positive mover with current market evidence.",
                  sourceIds: ["market-aapl"],
                },
              ],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        return {
          content: modelReport("AAPL"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config: { ...config, dataDir },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const stageNames = prompts.map((prompt) => prompt.stage);
    const spotlightPrompt = prompts.find((prompt) => prompt.stage === "spotlight-selection") as
      | {
          readonly candidates?: readonly {
            readonly symbol?: string;
            readonly history?: { readonly tickerRunIds?: readonly string[] };
          }[];
        }
      | undefined;

    expect(stageNames.indexOf("spotlight-selection")).toBeLessThan(
      stageNames.indexOf("playbook-selection"),
    );
    expect(spotlightPrompt?.candidates?.[0]?.history?.tickerRunIds).toEqual(["prior-aapl-ticker"]);
    expect(result.trace.spotlightSelection).toMatchObject({
      cap: 2,
      candidateCount: 1,
      selectedCount: 1,
      rejectedCount: 0,
      malformed: false,
    });
    expect(result.report.extras?.spotlights).toMatchObject({
      items: [{ symbol: "AAPL", sourceIds: ["market-aapl"] }],
    });
    expect(result.report.sources.map((source) => source.id)).toContain(
      "history-report-prior-aapl-ticker",
    );
    expect(result.markdown).toContain("## Market Spotlights");
  });

  test("merges deterministic SEC evidence output before specialist analysis", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        return {
          content: modelReport("AAPL", "extended-sec-edgar-aapl-10q"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        evidenceRequestOptions: { ...evidenceConfig.evidenceRequestOptions, maxRounds: 1 },
      },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      sourceFetchImpl: secEvidenceFetch,
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const specialistPrompt = prompts.find((prompt) => prompt.stage === "specialist-analysis") as
      | {
          readonly evidence?: {
            readonly extendedEvidence?: {
              readonly items?: readonly { readonly title?: string }[];
            };
          };
        }
      | undefined;

    expect(
      specialistPrompt?.evidence?.extendedEvidence?.items?.some(
        (item) => item.title === "AAPL SEC 10-Q",
      ),
    ).toBe(true);
    expect(result.collectedSources.rawSnapshots.map((snapshot) => snapshot.adapter)).toContain(
      "sec-filing-text",
    );
    expect(result.report.sources.map((source) => source.id)).toContain(
      "extended-sec-edgar-aapl-10q",
    );
    expect(result.trace.evidenceRequestLoop?.acceptedRequests).toHaveLength(0);
    expect(result.trace.evidenceRequestLoop?.sourceUnitsUsed).toBe(0);
    expect(result.trace.evidenceRequestLoop?.executedTools).toEqual(["sec_latest_filing"]);
  });

  test("runs deterministic SEC retrieval when optional evidence loop budgets are disabled", async () => {
    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        evidenceRequestOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
      },
      provider: providerReturning(modelReport("AAPL", "extended-sec-edgar-aapl-10q")),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      sourceFetchImpl: secEvidenceFetch,
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.trace.stages).not.toContain("evidence-request");
    expect(result.trace.evidenceRequestLoop).toMatchObject({
      rounds: 0,
      acceptedRequests: [],
      rejectedRequests: [],
      sourceUnitsUsed: 0,
      executedTools: ["sec_latest_filing"],
    });
    expect(result.report.sources.map((source) => source.id)).toContain(
      "extended-sec-edgar-aapl-10q",
    );
  });

  test("selects playbooks after evidence request and injects them downstream", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({
              rationale: "ticker evidence needs instrument and critique playbooks",
              selections: [
                { stage: "specialist-analysis", playbookIds: ["instrument-evidence"] },
                { stage: "critique", playbookIds: ["critique-discipline"] },
              ],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        return {
          content: modelReport("AAPL", "extended-sec-edgar-aapl-10q"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        evidenceRequestOptions: { ...evidenceConfig.evidenceRequestOptions, maxRounds: 1 },
      },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      sourceFetchImpl: secEvidenceFetch,
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const selectorPrompt = prompts.find((prompt) => prompt.stage === "playbook-selection") as
      | {
          readonly evidenceCategories?: readonly string[];
          readonly plannedStages?: readonly string[];
        }
      | undefined;
    const specialistPrompt = prompts.find((prompt) => prompt.stage === "specialist-analysis") as
      | {
          readonly domainPlaybooks?: readonly { readonly id?: string }[];
        }
      | undefined;
    const critiquePrompt = prompts.find((prompt) => prompt.stage === "critique") as
      | {
          readonly domainPlaybooks?: readonly { readonly id?: string }[];
        }
      | undefined;
    const finalPrompt = prompts.find((prompt) => prompt.stage === "final-synthesis") as
      | {
          readonly domainPlaybooks?: readonly { readonly id?: string }[];
        }
      | undefined;

    expect(selectorPrompt?.evidenceCategories).toContain("sec-edgar");
    expect(selectorPrompt?.plannedStages).toEqual([
      "specialist-analysis",
      "instrument-evidence-analysis",
      "market-behavior-analysis",
      "critique",
      "final-synthesis",
    ]);
    expect(specialistPrompt?.domainPlaybooks?.map((playbook) => playbook.id)).toEqual([
      "instrument-evidence",
    ]);
    expect(critiquePrompt?.domainPlaybooks?.map((playbook) => playbook.id)).toEqual([
      "critique-discipline",
    ]);
    expect(finalPrompt?.domainPlaybooks?.map((playbook) => playbook.id)).toEqual([
      "synthesis-discipline",
    ]);
    expect(result.trace.domainPlaybooks).toMatchObject({
      selected: [
        { stage: "final-synthesis", playbookIds: ["synthesis-discipline"] },
        { stage: "specialist-analysis", playbookIds: ["instrument-evidence"] },
        { stage: "critique", playbookIds: ["critique-discipline"] },
      ],
      rejected: [],
    });
    expect(result.trace.stages).toContain("playbook-selection");
    expect(result.trace.tokenEstimate).toBe(
      result.stageOutputs.reduce((total, output) => total + output.tokenEstimate, 0),
    );
    const stageCosts = result.stageOutputs.map((output) => output.costEstimateUsd);
    expect(stageCosts.every((cost) => cost !== undefined)).toBe(true);
    expect(result.trace.costEstimateUsd).toBe(
      stageCosts
        .filter((cost): cost is number => cost !== undefined)
        .reduce((total, cost) => total + cost, 0),
    );
  });

  test("continues when playbook selector returns invalid choices", async () => {
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        return {
          content:
            prompt.stage === "playbook-selection"
              ? JSON.stringify({
                  rationale: "bad choices",
                  selections: [
                    { stage: "evidence-request", playbookIds: ["market-regime"] },
                    { stage: "critique", playbookIds: ["unknown-playbook"] },
                  ],
                })
              : modelReport(),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.summary).toBe("AAPL evidence is sourced.");
    expect(result.trace.domainPlaybooks.selected).toEqual([
      { stage: "final-synthesis", playbookIds: ["synthesis-discipline"] },
    ]);
    expect(result.trace.domainPlaybooks.rejected).toEqual([
      { stage: "evidence-request", reason: "invalid stage" },
      {
        stage: "critique",
        playbookId: "unknown-playbook",
        reason: "playbook is not eligible",
      },
    ]);
  });

  test("emits non-blocking post-synthesis audit warnings", async () => {
    const dataDir = tempDataDir("market-bot-audit");
    await writeHistoricalRun({
      dataDir,
      runId: "prior-aapl",
      jobType: "equity",
      generatedAt: "2026-05-18T00:00:00.000Z",
      symbol: "AAPL",
    });
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        return {
          content: JSON.stringify({
            summary: "AAPL evidence is sourced.",
            keyFindings: [
              { text: "Sector RSI14 is 70.", sourceIds: ["history-report-prior-aapl"] },
            ],
            bullCase: [{ text: "Evidence supports the setup.", sourceIds: ["market-aapl"] }],
            bearCase: [{ text: "Coverage remains incomplete.", sourceIds: ["market-aapl"] }],
            risks: [{ text: "Source coverage can change.", sourceIds: ["market-aapl"] }],
            catalysts: [{ text: "New evidence is visible.", sourceIds: ["market-aapl"] }],
            scenarios: [
              {
                name: "Base",
                description: "Evidence remains relevant.",
                sourceIds: ["market-aapl"],
              },
            ],
            confidence: "medium",
            dataGaps: [],
            predictions: mockPredictions(6, "AAPL"),
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config: { ...config, dataDir },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    // The warn-only Post-Synthesis Audit still records both warnings on the
    // Pre-prune report, while the Report Integrity Audit removes the uncited
    // Technical finding before persistence and stamps the report grades.
    expect(result.report.keyFindings.map((finding) => finding.text)).toEqual([]);
    expect(result.report.predictions).toHaveLength(6);
    // Assembly stamps the current scoring policy; the model-provided
    // ScoringPolicyVersion: 99 in the mock payload must not survive.
    expect(
      result.report.predictions.every((prediction) => prediction.scoringPolicyVersion === 3),
    ).toBe(true);
    expect(result.report.reportIntegrity).toBe("low");
    expect(result.report.researchQuality).toBe("low");
    expect(result.trace.postSynthesisAudit?.warningCount).toBe(2);
    expect(result.trace.postSynthesisAudit?.warnings.map((warning) => warning.code)).toEqual([
      "unsupported-numeric-claim",
      "weak-evidence-posture-missing",
    ]);
    expect(result.analytics.postSynthesisAudit).toEqual({
      warningCount: 2,
      byCode: {
        "unsupported-numeric-claim": 1,
        "weak-evidence-posture-missing": 1,
      },
    });
    expect(result.trace.reportIntegrityAudit).toMatchObject({
      reportIntegrity: "low",
      researchQuality: "low",
      prunedItemCount: 1,
      pruned: [expect.objectContaining({ location: "keyFindings[0]" })],
    });
    expect(result.analytics.reportIntegrity).toEqual({
      label: "low",
      researchQuality: "low",
      prunedItemCount: 1,
      advisoryWarningCount: result.trace.reportIntegrityAudit?.advisoryWarningCount ?? -1,
    });
  });

  test("pruned predictions are absent from persisted reports and scoring input", async () => {
    const dataDir = tempDataDir("market-bot-integrity-scoring");
    await writeHistoricalRun({
      dataDir,
      runId: "prior-aapl",
      jobType: "equity",
      generatedAt: "2026-05-18T00:00:00.000Z",
      symbol: "AAPL",
    });
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        // The last prediction becomes a range forecast whose canonical claim
        // Renders numeric bounds, supported only by a history source (not
        // Eligible support), so the Report Integrity Audit must prune it
        // Before persistence and scoring. Model claim text never survives
        // Assembly — renderClaim rebuilds it from measurableAs.
        const predictions = mockPredictions(6, "AAPL").map((prediction, index) =>
          index === 5
            ? {
                ...(prediction as Record<string, unknown>),
                kind: "range",
                measurableAs: "close(AAPL, +15) outside [180, 200]",
                sourceIds: ["history-report-prior-aapl"],
              }
            : prediction,
        );
        return {
          content: JSON.stringify({
            ...(JSON.parse(modelReport("AAPL")) as Record<string, unknown>),
            predictions,
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await persistResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config: { ...config, dataDir },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const keptIds = ["pred-1", "pred-2", "pred-3", "pred-4", "pred-5"];
    expect(result.report.predictions.map((prediction) => prediction.id)).toEqual(keptIds);
    expect(result.trace.reportIntegrityAudit?.pruned).toEqual([
      expect.objectContaining({ location: "predictions[5]" }),
    ]);

    const persisted = JSON.parse(
      await readFile(join(result.artifacts.runDir, "report.json"), "utf8"),
    ) as { readonly predictions: readonly { readonly id: string }[] };
    expect(persisted.predictions.map((prediction) => prediction.id)).toEqual(keptIds);

    // Scoring loads the persisted report, so the pruned prediction must never
    // Receive a score entry even before any horizon elapses.
    await runScorePass(dataDir, new Date("2026-05-19T12:00:00.000Z"));
    const scoreFile = JSON.parse(
      await readFile(join(result.artifacts.runDir, "score.json"), "utf8"),
    ) as { readonly scores: readonly { readonly predictionId: string }[] };
    expect(scoreFile.scores.map((score) => score.predictionId)).toEqual(keptIds);
  });

  test("audits rejected duplicate, invalid, and over-budget evidence requests", async () => {
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        return {
          content:
            prompt.stage === "evidence-request"
              ? JSON.stringify({
                  requests: [
                    {
                      tool: "tradier_iv_term_structure",
                      args: { symbol: "AAPL" },
                      rationale: "term structure",
                    },
                    {
                      tool: "tradier_iv_term_structure",
                      args: { symbol: "AAPL" },
                      rationale: "repeat",
                    },
                    { tool: "private_account", args: { symbol: "AAPL" }, rationale: "bad" },
                  ],
                })
              : modelReport(),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        sourceOptions: { ...evidenceConfig.sourceOptions, tradierApiToken: "tradier-token" },
        evidenceRequestOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 7 },
      },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      sourceFetchImpl: secEvidenceFetch,
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.trace.evidenceRequestLoop?.acceptedRequests).toHaveLength(1);
    expect(result.trace.evidenceRequestLoop?.rejectedRequests.map((entry) => entry.reason)).toEqual(
      ["duplicate evidence request", "tool is not an allowed public evidence request tool"],
    );
    expect(result.trace.evidenceRequestLoop?.emittedGaps.map((gap) => gap.message)).toContain(
      "private_account: tool is not an allowed public evidence request tool",
    );
  });

  test("rejects evidence requests for a different symbol", async () => {
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        return {
          content:
            prompt.stage === "evidence-request"
              ? JSON.stringify({
                  requests: [
                    {
                      tool: "tradier_iv_term_structure",
                      args: { symbol: "MSFT" },
                      rationale: "wrong symbol",
                    },
                  ],
                })
              : modelReport(),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        sourceOptions: { ...evidenceConfig.sourceOptions, tradierApiToken: "tradier-token" },
        evidenceRequestOptions: { ...evidenceConfig.evidenceRequestOptions, maxRounds: 1 },
      },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      sourceFetchImpl: secEvidenceFetch,
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.trace.evidenceRequestLoop?.acceptedRequests).toEqual([]);
    expect(result.trace.evidenceRequestLoop?.rejectedRequests).toEqual([
      expect.objectContaining({
        tool: "tradier_iv_term_structure",
        args: { symbol: "MSFT" },
        reason: "requested symbol must match run symbol",
        status: "rejected",
      }),
    ]);
    expect(result.trace.evidenceRequestLoop?.emittedGaps).toContainEqual(
      expect.objectContaining({
        source: "evidence-request",
        message: "tradier_iv_term_structure: requested symbol must match run symbol",
      }),
    );
  });

  test("runs bounded multi-round loop and rejects duplicates across rounds", async () => {
    let evidenceRounds = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "evidence-request") {
          evidenceRounds += 1;
          return {
            content: JSON.stringify({
              requests: [
                {
                  tool: "tradier_iv_term_structure",
                  args: { symbol: "AAPL" },
                  rationale: "term structure",
                },
              ],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        return { content: modelReport(), tokenEstimate: 100, costEstimateUsd: 0.01 };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        sourceOptions: { ...evidenceConfig.sourceOptions, tradierApiToken: "tradier-token" },
      },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      sourceFetchImpl: secEvidenceFetch,
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(evidenceRounds).toBe(2);
    expect(result.trace.stages.filter((stage) => stage === "evidence-request")).toHaveLength(2);
    expect(result.trace.evidenceRequestLoop?.rounds).toBe(2);
    expect(result.trace.evidenceRequestLoop?.acceptedRequests).toHaveLength(1);
    expect(result.trace.evidenceRequestLoop?.rejectedRequests).toEqual([
      expect.objectContaining({ round: 2, reason: "duplicate evidence request" }),
    ]);
    expect(result.trace.evidenceRequestLoop?.sourceUnitsUsed).toBe(5);
  });

  test("emits source gap and continues when evidence request JSON is invalid", async () => {
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        return {
          content: prompt.stage === "evidence-request" ? "not-json" : modelReport(),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        sourceOptions: { ...evidenceConfig.sourceOptions, tradierApiToken: "tradier-token" },
      },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      sourceFetchImpl: secFetchUnavailable,
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.dataGaps).toContain(
      "evidence-request: Evidence request stage returned invalid JSON",
    );
    expect(result.trace.evidenceRequestLoop?.emittedGaps).toContainEqual(
      expect.objectContaining({
        source: "evidence-request",
        message: "Evidence request stage returned invalid JSON",
      }),
    );
  });

  test("skips evidence request loop outside deep equity ticker scope", async () => {
    const commands = [
      {
        jobType: "equity" as const,
        assetClass: "equity" as const,
        symbol: "AAPL",
        depth: "brief" as const,
      },
      {
        jobType: "crypto" as const,
        assetClass: "crypto" as const,
        symbol: "BTC",
        depth: "deep" as const,
      },
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "deep" }),
      legacyMarketOverviewCommand("weekly", { assetClass: "equity", depth: "deep" }),
    ];

    for (const command of commands) {
      let calls = 0;
      const result = await runResearchJob({
        command,
        config: evidenceConfig,
        provider: {
          name: "mock",
          generate: async () => {
            calls += 1;
            return {
              content: modelReport(
                command.jobType === "equity" || command.jobType === "crypto"
                  ? command.symbol
                  : "SPY",
              ),
              tokenEstimate: 100,
              costEstimateUsd: 0.01,
            };
          },
        },
        collectedSources: collectedSourceBundle({
          rawSnapshots: [],
          marketSnapshots,
          newsSources,
          sourceGaps: [],
        }),
        now: new Date("2026-05-19T00:00:00.000Z"),
      });

      let expectedCalls = command.depth === "deep" ? 6 : 4;
      if (command.jobType === "market-overview") {
        expectedCalls = command.depth === "deep" ? 7 : 5;
      }
      expect(calls).toBe(expectedCalls);
      expect(result.trace.stages).not.toContain("evidence-request");
      if (command.jobType === "crypto") {
        expect(result.trace.stages).toEqual([
          "source-collection",
          "playbook-selection",
          "specialist-analysis",
          "instrument-evidence-analysis",
          "market-behavior-analysis",
          "critique",
          "final-synthesis",
        ]);
      }
      expect(result.trace.evidenceRequestLoop).toBeUndefined();
    }
  });

  test("creates a daily Research View from mocked sources and model output", async () => {
    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Equity market breadth is constructive but source coverage is limited.",
          keyFindings: [{ text: "AAPL is a liquid positive mover.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Demand news supports the move.", sourceIds: ["news-equity-1"] }],
          bearCase: [
            {
              text: "Single-name evidence may not represent the whole market.",
              sourceIds: ["market-aapl"],
            },
          ],
          risks: [{ text: "Macro data is missing.", sourceIds: ["market-aapl"] }],
          catalysts: [
            { text: "Supplier demand update is the main catalyst.", sourceIds: ["news-equity-1"] },
          ],
          scenarios: [
            {
              name: "Base",
              description: "Momentum continues if liquidity persists.",
              sourceIds: ["market-aapl"],
            },
          ],
          confidence: "medium",
          dataGaps: ["Macro breadth source unavailable"],
          predictions: mockPredictions(2),
        }),
      ),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report).toMatchObject({
      jobType: "market-overview",
      assetClass: "equity",
      evidenceQuality: "medium",
      notFinancialAdvice: true,
    });
    expect(result.markdown).toContain("Research-only note");
    expect(result.markdown).not.toContain("Weekly Market Update");
    expect(result.trace.sourceGaps).toEqual(["Macro breadth source unavailable"]);
    expect(result.trace.stages).toEqual([
      "source-collection",
      "spotlight-selection",
      "playbook-selection",
      "specialist-analysis",
      "critique",
      "final-synthesis",
    ]);
    expect(result.stageOutputs).toHaveLength(5);
    expect(result.trace.tokenEstimate).toBe(500);
  });

  test("surfaces Market Context in market update prompts, extras, citations, and regime drivers", async () => {
    const prompts: string[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        prompts.push(request.messages[1]?.content ?? "");
        return {
          content: JSON.stringify({
            summary: "Daily market evidence includes macro context.",
            keyFindings: [
              {
                text: "FRED macro context is available.",
                sourceIds: ["market-context-fred-macro"],
              },
            ],
            bullCase: [{ text: "Market data is constructive.", sourceIds: ["market-aapl"] }],
            bearCase: [{ text: "News coverage is narrow.", sourceIds: ["news-equity-1"] }],
            risks: [{ text: "Macro data can change.", sourceIds: ["market-context-fred-macro"] }],
            catalysts: [{ text: "Company news is visible.", sourceIds: ["news-equity-1"] }],
            scenarios: [
              {
                name: "Base",
                description: "Market remains tied to macro evidence.",
                sourceIds: ["market-context-fred-macro"],
              },
            ],
            confidence: "high",
            dataGaps: [],
            predictions: [
              {
                id: "pred-macro",
                claim: "DGS10 rises over 5 trading days.",
                kind: "macro",
                subject: "DGS10",
                measurableAs: "fred(DGS10, +5) > fred(DGS10, 0)",
                horizonTradingDays: 5,
                probability: 0.6,
                sourceIds: ["market-context-fred-macro"],
              },
              ...mockPredictions(1),
            ],
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        marketContext,
        marketContextSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompt = JSON.parse(
      prompts.find((prompt) => JSON.parse(prompt).stage === "final-synthesis") ?? "{}",
    ) as {
      readonly evidence?: {
        readonly marketContext?: unknown;
        readonly marketRegime?: {
          readonly label?: string;
          readonly drivers?: readonly string[];
          readonly sourceIds?: readonly string[];
        };
      };
    };

    expect(finalPrompt.evidence?.marketContext).toBeDefined();
    expect(finalPrompt.evidence?.marketRegime?.label).toBe("insufficient-data");
    expect(finalPrompt.evidence?.marketRegime?.drivers).toContain("FRED macro context: DGS10 4.25");
    expect(finalPrompt.evidence?.marketRegime?.sourceIds).toContain("market-context-fred-macro");
    expect(result.report.sources.map((source) => source.id)).toContain("market-context-fred-macro");
    expect(result.report.extras?.marketContext).toEqual(marketContext);
    expect(result.report.extras?.marketRegime).toMatchObject({
      label: "insufficient-data",
      sourceIds: ["market-context-fred-macro"],
    });
    expect(result.report.predictions[0]?.kind).toBe("macro");
  });

  test("surfaces ticker Extended Evidence in prompt, report, and markdown", async () => {
    const prompts: string[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        prompts.push(request.messages[1]?.content ?? "");
        return {
          content: JSON.stringify({
            summary: "AAPL ticker evidence includes macro context.",
            keyFindings: [{ text: "SEC evidence is available.", sourceIds: ["extended-sec"] }],
            bullCase: [{ text: "Market data is constructive.", sourceIds: ["market-aapl"] }],
            bearCase: [{ text: "News coverage is narrow.", sourceIds: ["news-equity-1"] }],
            risks: [{ text: "Company filing data can change.", sourceIds: ["extended-sec"] }],
            catalysts: [{ text: "Company news is visible.", sourceIds: ["news-equity-1"] }],
            scenarios: [
              {
                name: "Base",
                description: "Ticker remains tied to market data.",
                sourceIds: ["market-aapl"],
              },
            ],
            confidence: "high",
            dataGaps: [],
            predictions: mockPredictions(3, "AAPL"),
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        extendedSources: [
          {
            id: "extended-sec",
            title: "AAPL SEC filings",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            kind: "extended-evidence",
            assetClass: "equity",
            symbol: "AAPL",
            provider: "sec-edgar",
            identity: {
              providerIds: [{ provider: "sec-edgar", idKind: "cik", value: "0000320193" }],
              aliases: [{ provider: "sec-edgar", idKind: "ticker", value: "AAPL" }],
            },
          },
        ],
        extendedEvidence: {
          instrument: { assetClass: "equity", symbol: "AAPL" },
          items: [
            {
              category: "sec-edgar",
              title: "AAPL SEC filings",
              summary: "Recent SEC filings captured.",
              sourceIds: ["extended-sec"],
              observedAt: "2026-05-19T00:00:00.000Z",
              identity: {
                providerIds: [{ provider: "sec-edgar", idKind: "cik", value: "0000320193" }],
                aliases: [{ provider: "sec-edgar", idKind: "ticker", value: "AAPL" }],
              },
            },
          ],
          gaps: [],
        },
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompt = JSON.parse(
      prompts.find((prompt) => JSON.parse(prompt).stage === "final-synthesis") ?? "{}",
    ) as {
      readonly evidence?: {
        readonly extendedEvidence?: {
          readonly items?: readonly { readonly identity?: unknown }[];
        };
      };
    };

    expect(finalPrompt.evidence?.extendedEvidence).toBeDefined();
    expect(finalPrompt.evidence?.extendedEvidence?.items?.[0]?.identity).toEqual({
      providerIds: [{ provider: "sec-edgar", idKind: "cik", value: "0000320193" }],
      aliases: [{ provider: "sec-edgar", idKind: "ticker", value: "AAPL" }],
    });
    expect(result.report.extendedEvidence).toBeDefined();
    expect(result.markdown).toContain("## Extended Evidence");
    expect(result.markdown).toContain("[extended-sec]");
  });

  test("ignores extended sources for market update source lists", async () => {
    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Daily market breadth is sourced.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Supplier news supports breadth.", sourceIds: ["news-equity-1"] }],
          bearCase: [{ text: "Single-name breadth is limited.", sourceIds: ["market-aapl"] }],
          risks: [{ text: "Breadth can reverse.", sourceIds: ["market-aapl"] }],
          catalysts: [{ text: "Supplier demand is visible.", sourceIds: ["news-equity-1"] }],
          scenarios: [
            {
              name: "Base",
              description: "Momentum continues if liquidity persists.",
              sourceIds: ["market-aapl"],
            },
          ],
          confidence: "medium",
          dataGaps: [],
          predictions: mockPredictions(2),
        }),
      ),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        extendedSources: [
          {
            id: "extended-fred-macro",
            title: "FRED macro pack",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            kind: "extended-evidence",
            assetClass: "equity",
          },
        ],
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.sources.map((source) => source.id)).not.toContain("extended-fred-macro");
  });

  test("creates a weekly market update with weekly horizon metadata and source gap", async () => {
    const prompts: string[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        prompts.push(request.messages[1]?.content ?? "");

        return {
          content: JSON.stringify({
            summary: "Weekly equity overview is sourced but mover data is approximate.",
            keyFindings: [{ text: "AAPL is a liquid positive mover.", sourceIds: ["market-aapl"] }],
            bullCase: [{ text: "Demand news supports the move.", sourceIds: ["news-equity-1"] }],
            bearCase: [
              {
                text: "Single-name evidence may not represent the whole market.",
                sourceIds: ["market-aapl"],
              },
            ],
            risks: [{ text: "Macro data is missing.", sourceIds: ["market-aapl"] }],
            catalysts: [
              {
                text: "Supplier demand update is the main catalyst.",
                sourceIds: ["news-equity-1"],
              },
            ],
            scenarios: [
              {
                name: "Base",
                description: "Momentum continues if liquidity persists.",
                sourceIds: ["market-aapl"],
              },
            ],
            confidence: "medium",
            dataGaps: [],
            predictions: mockPredictions(2).map((prediction) => ({
              ...(prediction as Record<string, unknown>),
              claim: "SPY closes higher over 15 trading days.",
              measurableAs: "close(SPY, +15) > close(SPY, 0)",
              horizonTradingDays: 15,
            })),
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("weekly", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompt = JSON.parse(
      prompts.find((prompt) => JSON.parse(prompt).stage === "final-synthesis") ?? "{}",
    ) as {
      readonly depthProfile?: {
        readonly defaultPredictionHorizon?: number;
        readonly targetPredictions?: number;
      };
      readonly requiredShape?: {
        readonly predictions?: readonly { readonly horizonTradingDays?: number }[];
      };
    };

    expect(result.report.jobType).toBe("market-overview");
    expect(result.report.extras?.legacyMarketUpdateAlias).toBe("weekly");
    expect(result.trace.legacyMarketUpdateAlias).toBe("weekly");
    expect(result.markdown).toContain("# equity Market Overview");
    expect(result.report.predictions[0]?.horizonTradingDays).toBe(15);
    expect(result.report.dataGaps).toContain(
      "Market overview mover universe is seeded from Yahoo day_gainers, day_losers, and most_actives — a single-day multi-screener set, not a trailing horizon mover screener",
    );
    expect(finalPrompt.depthProfile?.defaultPredictionHorizon).toBe(15);
    expect(finalPrompt.depthProfile?.targetPredictions).toBe(2);
    expect(finalPrompt.requiredShape?.predictions?.[0]?.horizonTradingDays).toBe(15);
  });

  test("drops a model data gap that restates the deterministic weekly mover gap", async () => {
    const provider: ModelProvider = {
      name: "mock",
      generate: async () => ({
        content: JSON.stringify({
          summary: "Weekly equity overview is sourced but mover data is approximate.",
          keyFindings: [{ text: "AAPL is a liquid positive mover.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Demand news supports the move.", sourceIds: ["news-equity-1"] }],
          bearCase: [
            {
              text: "Single-name evidence may not represent the whole market.",
              sourceIds: ["market-aapl"],
            },
          ],
          risks: [{ text: "Macro data is missing.", sourceIds: ["market-aapl"] }],
          catalysts: [
            { text: "Supplier demand update is the main catalyst.", sourceIds: ["news-equity-1"] },
          ],
          scenarios: [
            {
              name: "Base",
              description: "Momentum continues if liquidity persists.",
              sourceIds: ["market-aapl"],
            },
          ],
          confidence: "medium",
          dataGaps: [
            "Market overview mover universe is seeded from Yahoo day_gainers, day_losers, and most_actives, not a trailing horizon mover screener.",
          ],
          predictions: mockPredictions(2),
        }),
        tokenEstimate: 100,
        costEstimateUsd: 0.01,
      }),
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("weekly", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const moverGaps = result.report.dataGaps.filter((gap) =>
      gap.includes("trailing horizon mover screener"),
    );
    expect(moverGaps).toEqual([
      "Market overview mover universe is seeded from Yahoo day_gainers, day_losers, and most_actives — a single-day multi-screener set, not a trailing horizon mover screener",
    ]);
  });

  test("rejects reports with trade-action language", async () => {
    await expect(
      runResearchJob({
        command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
        config,
        provider: providerReturning(
          JSON.stringify({
            summary: "Buy AAPL after the catalyst.",
            keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
            bullCase: [],
            bearCase: [],
            risks: [],
            catalysts: [],
            scenarios: [],
            confidence: "low",
            dataGaps: [],
          }),
        ),
        collectedSources: collectedSourceBundle({
          rawSnapshots: [],
          marketSnapshots,
          newsSources,
          sourceGaps: [],
        }),
        now: new Date("2026-05-19T00:00:00.000Z"),
      }),
    ).rejects.toThrow("trade-action language");
  });

  test("persists raw, normalized, report, markdown, and trace artifacts", async () => {
    const dataDir = join(tmpdir(), `market-bot-test-${Date.now()}`);
    dataDirs.push(dataDir);
    const result = await persistResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config: {
        ...config,
        dataDir,
      },
      provider: providerReturning(
        JSON.stringify({
          summary: "Equity market breadth is constructive.",
          keyFindings: [{ text: "AAPL is liquid.", sourceIds: ["market-aapl"] }],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          confidence: "medium",
          dataGaps: [],
        }),
      ),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [
          {
            id: "raw-1",
            adapter: "mock",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            payload: { ok: true },
          },
          {
            id: "raw-large",
            adapter: "mock-large",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            payload: { body: "x".repeat(1024 * 1024 + 1) },
          },
        ],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    await expect(
      readFile(join(result.artifacts.rawDir, "snapshots.json"), "utf8"),
    ).resolves.toContain("raw-1");
    const rawSnapshots = JSON.parse(
      await readFile(join(result.artifacts.rawDir, "snapshots.json"), "utf8"),
    ) as readonly { readonly id: string; readonly payloadCompacted?: boolean }[];
    expect(rawSnapshots.find((snapshot) => snapshot.id === "raw-large")).toMatchObject({
      payloadCompacted: true,
    });
    await expect(
      readFile(join(result.artifacts.normalizedDir, "market-snapshots.json"), "utf8"),
    ).resolves.toContain("market-aapl");
    await expect(
      readFile(join(result.artifacts.normalizedDir, "historical-context.json"), "utf8"),
    ).resolves.toContain("selectedRunCount");
    await expect(
      readFile(join(result.artifacts.normalizedDir, "spotlight-candidates.json"), "utf8"),
    ).resolves.toContain("market-aapl");
    await expect(
      readFile(join(result.artifacts.normalizedDir, "spotlight-selection.json"), "utf8"),
    ).resolves.toContain("malformed");
    await expect(
      readFile(join(result.artifacts.normalizedDir, "movers.json"), "utf8"),
    ).resolves.toContain("market-aapl");
    const sourcePlanJson = await readFile(
      join(result.artifacts.normalizedDir, "source-plan.json"),
      "utf8",
    );
    expect(JSON.parse(sourcePlanJson)).toMatchObject({ version: 2 });
    expect(sourcePlanJson).toContain("market-data");
    await expect(
      readFile(join(result.artifacts.normalizedDir, "evidence-lanes.json"), "utf8"),
    ).resolves.toContain("coveredLaneCount");
    await expect(
      readFile(join(result.artifacts.normalizedDir, "source-ledger.json"), "utf8"),
    ).resolves.toContain("market-aapl");
    expect(result.trace.sourcePlan?.plannedLaneCount).toBeGreaterThan(0);
    expect(result.analytics.evidenceLanes?.coveredLaneCount).toBeGreaterThan(0);
    expect(result.trace.codeVersion?.dirty).toEqual(expect.any(Boolean));
    expect(result.analytics.codeVersion).toEqual(result.trace.codeVersion);
    expect(result.trace.reproducibility?.effectiveConfigHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.analytics.reproducibility).toEqual(result.trace.reproducibility);
    expect(result.trace.evidenceQualityAssessment?.label).toBe(result.report.evidenceQuality);
    expect(result.trace.schemaVersion).toBe(2);
    expect(result.trace.modelInputSanitization).toBeDefined();
    expect(result.analytics.modelInputSanitization).toEqual(result.trace.modelInputSanitization);
    expect(result.analytics.evidenceQuality.assessment).toEqual(
      result.trace.evidenceQualityAssessment,
    );
    const reportJson = await readFile(join(result.artifacts.runDir, "report.json"), "utf8");
    expect(reportJson).toContain("Equity market breadth");
    expect(reportJson).toContain('"evidenceQuality"');
    expect(reportJson).not.toContain('"confidence"');
    await expect(readFile(join(result.artifacts.runDir, "report.md"), "utf8")).resolves.toContain(
      "Research-only note",
    );
    await expect(readFile(join(result.artifacts.runDir, "trace.json"), "utf8")).resolves.toContain(
      "codeVersion",
    );
    await expect(
      readFile(join(result.artifacts.runDir, "analytics.json"), "utf8"),
    ).resolves.toContain("codeVersion");
    await expect(readFile(join(result.artifacts.runDir, "trace.json"), "utf8")).resolves.toContain(
      "quick-test",
    );
    await expect(readFile(join(result.artifacts.runDir, "stages.json"), "utf8")).resolves.toContain(
      "spotlight-selection",
    );
  });

  test("persists resolved research subject sidecar", async () => {
    const dataDir = join(tmpdir(), `market-bot-research-subject-${Date.now()}`);
    dataDirs.push(dataDir);
    const command = {
      jobType: "research",
      assetClass: "equity",
      subject: "chip stocks",
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
      depth: "brief",
    } as const;
    const resolvedSubject = resolveResearchSubject(command)!;
    const result = await persistResearchJob({
      command,
      config: { ...config, dataDir },
      provider: providerReturning(
        JSON.stringify({
          summary: "Semiconductor evidence is sourced.",
          keyFindings: [{ text: "SMH is liquid.", sourceIds: ["market-smh"] }],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          confidence: "medium",
          dataGaps: [],
          predictions: [],
        }),
      ),
      collectedSources: collectedSourceBundle({
        resolvedSubject,
        marketSnapshots: [marketSnapshot({ sourceId: "market-smh", symbol: "SMH" })],
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const sidecar = JSON.parse(
      await readFile(join(result.artifacts.normalizedDir, "resolved-subject.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(sidecar).toMatchObject({
      input: "chip stocks",
      normalizedInput: "chip stocks",
      status: "resolved",
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
    });
  });

  test("skips completion when thematic research has no prediction proxy", async () => {
    const command = {
      jobType: "research",
      assetClass: "equity",
      subject: "AI capex",
      subjectKey: "ai-infrastructure",
      depth: "brief",
    } as const;
    const resolvedSubject = resolveResearchSubject(command)!;
    const result = await runResearchJob({
      command,
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "AI infrastructure evidence is sourced.",
          keyFindings: [{ text: "NVDA is liquid.", sourceIds: ["market-nvda"] }],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          dataGaps: [],
          predictions: [],
        }),
      ),
      collectedSources: collectedSourceBundle({
        resolvedSubject,
        marketSnapshots: [marketSnapshot({ sourceId: "market-nvda", symbol: "NVDA" })],
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.trace.predictionCompletion).toBeUndefined();
    expect(result.report.dataGaps).toContain(
      "researchProxyForecastGate: subject ai-infrastructure has no listed prediction proxy; predictions cannot be emitted",
    );
  });

  test("persists ticker valuation comps sidecar", async () => {
    const dataDir = join(tmpdir(), `market-bot-valuation-comps-${Date.now()}`);
    dataDirs.push(dataDir);
    const result = await persistResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...config,
        dataDir,
      },
      provider: providerReturning(
        JSON.stringify({
          summary: "AAPL valuation evidence is cited.",
          keyFindings: [{ text: "AAPL valuation evidence is cited.", sourceIds: ["market-aapl"] }],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          confidence: "medium",
          dataGaps: [],
        }),
      ),
      collectedSources: collectedSourceBundle({
        marketSnapshots,
        newsSources,
        valuationComps: {
          version: 1,
          generatedAt: "2026-05-19T00:00:00.000Z",
          target: {
            symbol: "AAPL",
            sourceIds: ["market-aapl"],
            usable: true,
          },
          peers: [],
          excludedPeers: [],
          peerUniverseSourceIds: [],
          summary: {
            corePeerCount: 0,
            secondaryPeerCount: 0,
            usablePeerCount: 0,
            valuationSupportability: "screening-only",
          },
          sourceIds: ["market-aapl"],
          freshnessFlags: {
            targetQuoteFresh: true,
            targetSecFresh: true,
            peerQuoteFresh: true,
            peerSecFresh: true,
          },
        },
        financialLenses: {
          version: 1,
          generatedAt: "2026-05-19T00:00:00.000Z",
          symbol: "AAPL",
          lenses: [
            {
              name: "Quality",
              posture: "criteria-supported",
              metrics: [
                {
                  key: "grossMargin",
                  label: "Gross margin",
                  value: 0.4,
                  unit: "ratio-percent",
                  sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
                },
              ],
              sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
            },
          ],
          sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
        },
        extendedSources: [
          {
            id: "extended-sec-edgar-aapl-fundamentals",
            title: "AAPL SEC fundamentals",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            kind: "extended-evidence",
            assetClass: "equity",
            symbol: "AAPL",
            provider: "sec-edgar",
          },
        ],
        businessFramework: {
          version: 1,
          generatedAt: "2026-05-19T00:00:00.000Z",
          symbol: "AAPL",
          phase: "capital-return",
          sections: [
            {
              name: "Phase",
              posture: "criteria-supported",
              summary: "Phase criteria-supported (Phase capital-return)",
              metrics: [
                {
                  key: "phase",
                  label: "Phase",
                  value: "capital-return",
                  unit: "text",
                  sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
                },
              ],
              sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
              gaps: [],
            },
          ],
          sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
          gaps: [],
        },
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    await expect(
      readFile(join(result.artifacts.normalizedDir, "valuation-comps.json"), "utf8"),
    ).resolves.toContain('"valuationSupportability": "screening-only"');
    await expect(
      readFile(join(result.artifacts.normalizedDir, "financial-lenses.json"), "utf8"),
    ).resolves.toContain('"posture": "criteria-supported"');
    await expect(
      readFile(join(result.artifacts.normalizedDir, "business-framework.json"), "utf8"),
    ).resolves.toContain('"phase": "capital-return"');
  });

  test("extracts and persists Web Subject Profile after web gather", async () => {
    const dataDir = tempDataDir("market-bot-web-subject-profile");
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-gather") {
          return {
            content: JSON.stringify({
              requests: [
                {
                  tool: "web_search",
                  args: {
                    query: "AAPL Apple business model customers",
                    searchType: "background",
                  },
                  rationale: "company profile evidence",
                },
              ],
            }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "web-subject-profile") {
          const evidence = isRecord(prompt.evidence) ? prompt.evidence : {};
          const sources = Array.isArray(evidence.webSources) ? evidence.webSources : [];
          const source = sources.find((item) => isRecord(item)) ?? {};
          const sourceId = typeof source.id === "string" ? source.id : "missing-source";
          const answer = {
            answer: "Apple sells hardware, software, and services.",
            sourceIds: [sourceId],
          };
          return {
            content: JSON.stringify({
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
                managementTrackRecord: answer,
                capitalAllocation: answer,
                companyKpis: answer,
                riskFactors: answer,
              },
              recentMaterialEvents: [
                { claim: "Apple reports services revenue.", sourceIds: [sourceId] },
              ],
              factLedger: [{ claim: "Apple sells hardware and services.", sourceIds: [sourceId] }],
              openGaps: [],
            }),
            tokenEstimate: 12,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await persistResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...config,
        dataDir,
        sourceOptions: { ...config.sourceOptions, exaApiKey: "exa-key" },
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      provider,
      collectedSources: collectedSourceBundle({ marketSnapshots, newsSources }),
      sourceFetchImpl: async () =>
        Response.json({
          results: [
            {
              id: "exa-search-1",
              url: "https://example.com/apple-profile",
              title: "Apple business profile",
              summary: "Apple sells hardware and services.",
            },
          ],
        }),
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(prompts.map((prompt) => prompt.stage)).toContain("web-subject-profile");
    expect(result.trace.webGatherLoop?.acceptedRequests).toHaveLength(1);
    expect(result.report.extras?.webSubjectProfile).toMatchObject({
      companyName: "Apple Inc.",
      factLedger: [expect.objectContaining({ claim: "Apple sells hardware and services." })],
    });
    await expect(
      readFile(join(result.artifacts.normalizedDir, "web-subject-profile.json"), "utf8"),
    ).resolves.toContain('"companyName": "Apple Inc."');
    const webGatherAudit = JSON.parse(
      await readFile(join(result.artifacts.normalizedDir, "web-gather-audit.json"), "utf8"),
    ) as {
      readonly acceptedRequests: readonly {
        readonly tool: string;
        readonly sanitizer?: { readonly sourceCount: number };
      }[];
      readonly sanitizer?: { readonly sourceCount: number };
    };
    expect(webGatherAudit.acceptedRequests[0]).toMatchObject({
      tool: "web_search",
      sanitizer: { sourceCount: 1 },
    });
    expect(webGatherAudit.sanitizer).toMatchObject({ sourceCount: 1 });
    await expect(readFile(join(result.artifacts.runDir, "report.md"), "utf8")).resolves.toContain(
      "## Web Subject Profile",
    );
  });

  test("builds a SEC-only company profile when Exa is absent on equity --deep", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-subject-profile") {
          const evidence = isRecord(prompt.evidence) ? prompt.evidence : {};
          const sources = Array.isArray(evidence.webSources) ? evidence.webSources : [];
          const source = sources.find((item) => isRecord(item)) ?? {};
          const sourceId = typeof source.id === "string" ? source.id : "missing-source";
          const answer = {
            answer: "Apple sells hardware and services per the filing.",
            sourceIds: [sourceId],
          };
          return {
            content: JSON.stringify({
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
                managementTrackRecord: answer,
                capitalAllocation: answer,
                companyKpis: answer,
                riskFactors: answer,
              },
              recentMaterialEvents: [],
              factLedger: [{ claim: "Apple sells hardware and services.", sourceIds: [sourceId] }],
              openGaps: [],
            }),
            tokenEstimate: 12,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      sourceFetchImpl: secEvidenceFetch,
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const stages = prompts.map((prompt) => prompt.stage);
    expect(stages).toContain("web-subject-profile");
    expect(stages).not.toContain("web-gather");
    expect(result.collectedSources.webSubjectProfile).toMatchObject({
      companyName: "Apple Inc.",
      subjectKind: "company",
    });
    // The SEC-only profile cites the filing source.
    expect(result.collectedSources.webSubjectProfile?.sourceIds).toEqual([
      "extended-sec-edgar-aapl-10q",
    ]);
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "search-unavailable: MARKET_BOT_EXA_API_KEY is not set; web gather skipped",
        cause: "missing-credential",
      }),
    );
    expect(result.markdown).toContain("## Web Subject Profile");
    expect(result.markdown).toContain("**Basis:** 10-Q for period 2026-03-31.");
  });

  test("does not build a SEC-only company profile from fundamentals-only SEC evidence", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-subject-profile") {
          throw new Error("unexpected web-subject-profile");
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config,
      provider,
      collectedSources: collectedSourceBundle({
        marketSnapshots,
        newsSources,
        extendedSources: [
          {
            id: "extended-sec-edgar-aapl-fundamentals",
            title: "AAPL SEC fundamentals",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            kind: "extended-evidence",
            assetClass: "equity",
            symbol: "AAPL",
            provider: "sec-edgar",
          },
        ],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(prompts.map((prompt) => prompt.stage)).not.toContain("web-subject-profile");
    expect(result.collectedSources.webSubjectProfile).toBeUndefined();
  });

  test("reuses fresh Web Subject Profile, gathers again, and skips profile extraction", async () => {
    const dataDir = tempDataDir("market-bot-web-subject-profile-reuse");
    const priorRunDir = join(dataDir, "prior-aapl");
    const priorWebSource: Source = {
      id: "web-aapl-prior",
      title: "Apple prior web profile",
      url: "https://example.com/apple-prior",
      fetchedAt: "2026-05-01T00:00:00.000Z",
      kind: "web",
      assetClass: "equity",
      symbol: "AAPL",
      provider: "exa",
    };
    const answer = {
      answer: "Apple sells hardware and services.",
      sourceIds: [priorWebSource.id],
    };
    await mkdir(join(priorRunDir, "normalized"), { recursive: true });
    await writeFile(
      join(priorRunDir, "report.json"),
      JSON.stringify({
        runId: "prior-aapl",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-01T00:00:00.000Z",
        summary: "Prior Apple web profile.",
        keyFindings: [],
        bullCase: [],
        bearCase: [],
        risks: [],
        catalysts: [],
        scenarios: [],
        confidence: "medium",
        dataGaps: [],
        predictions: [],
        sources: [priorWebSource],
        notFinancialAdvice: true,
        extras: { depth: "deep" },
      }),
      "utf8",
    );
    await writeFile(
      join(priorRunDir, "normalized", "web-subject-profile.json"),
      JSON.stringify({
        version: 3,
        generatedAt: "2026-05-01T00:00:00.000Z",
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
          managementTrackRecord: answer,
          capitalAllocation: answer,
          companyKpis: answer,
          riskFactors: answer,
        },
        recentMaterialEvents: [],
        factLedger: [
          { claim: "Apple sells hardware and services.", sourceIds: [priorWebSource.id] },
        ],
        openGaps: [],
        sourceIds: [priorWebSource.id],
        secFilingBasisDate: "2026-05-01",
      }),
      "utf8",
    );

    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-subject-profile") {
          throw new Error(`unexpected ${String(prompt.stage)}`);
        }
        if (prompt.stage === "web-gather") {
          return {
            content: JSON.stringify({ requests: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        dataDir,
        sourceOptions: { ...evidenceConfig.sourceOptions, exaApiKey: "exa-key" },
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      provider,
      collectedSources: collectedSourceBundle({ marketSnapshots, newsSources }),
      sourceFetchImpl: secEvidenceFetch,
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(prompts.filter((prompt) => prompt.stage === "web-gather")).toHaveLength(1);
    expect(
      (
        prompts.find((prompt) => prompt.stage === "web-gather")?.evidence as {
          webGather?: { reusedProfileCoverage?: unknown };
        }
      )?.webGather?.reusedProfileCoverage,
    ).toEqual({
      present: true,
      topics: [
        "capitalAllocation",
        "companyKpis",
        "customers",
        "geography",
        "howItMakesMoney",
        "managementTrackRecord",
        "pricingPower",
        "purchaseRecurrence",
        "recessionCyclicality",
        "riskFactors",
        "whatItDoes",
      ],
    });
    expect(prompts.map((prompt) => prompt.stage)).not.toContain("web-subject-profile");
    expect(result.collectedSources.webSubjectProfile).toMatchObject({
      subjectKind: "company",
      companyName: "Apple Inc.",
    });
    expect(result.collectedSources.extendedSources).toContainEqual(priorWebSource);
    expect(result.report.dataGaps).toContain(
      "web-subject-profile: Reused web subject profile from 2026-05-01T00:00:00.000Z (18 days old); latest SEC filing basis 2026-05-01.",
    );
    expect(result.report.extras?.webSubjectProfile).toMatchObject({
      companyName: "Apple Inc.",
      sourceIds: [priorWebSource.id],
    });
  });

  test("does not reuse Web Subject Profile when web gather is disabled", async () => {
    const dataDir = tempDataDir("market-bot-web-subject-profile-reuse-disabled");
    const priorRunDir = join(dataDir, "prior-aapl");
    const priorWebSource: Source = {
      id: "web-aapl-prior",
      title: "Apple prior web profile",
      url: "https://example.com/apple-prior",
      fetchedAt: "2026-05-01T00:00:00.000Z",
      kind: "web",
      assetClass: "equity",
      symbol: "AAPL",
      provider: "exa",
    };
    const answer = {
      answer: "Apple sells hardware and services.",
      sourceIds: [priorWebSource.id],
    };
    await mkdir(join(priorRunDir, "normalized"), { recursive: true });
    await writeFile(
      join(priorRunDir, "report.json"),
      JSON.stringify({
        runId: "prior-aapl",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-01T00:00:00.000Z",
        summary: "Prior Apple web profile.",
        keyFindings: [],
        bullCase: [],
        bearCase: [],
        risks: [],
        catalysts: [],
        scenarios: [],
        confidence: "medium",
        dataGaps: [],
        predictions: [],
        sources: [priorWebSource],
        notFinancialAdvice: true,
        extras: { depth: "deep" },
      }),
      "utf8",
    );
    await writeFile(
      join(priorRunDir, "normalized", "web-subject-profile.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        symbol: "AAPL",
        companyName: "Apple Inc.",
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
        factLedger: [
          { claim: "Apple sells hardware and services.", sourceIds: [priorWebSource.id] },
        ],
        openGaps: [],
        sourceIds: [priorWebSource.id],
        secFilingBasisDate: "2026-05-01",
      }),
      "utf8",
    );

    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-gather") {
          throw new Error(`unexpected ${String(prompt.stage)}`);
        }
        if (prompt.stage === "web-subject-profile") {
          const evidence = isRecord(prompt.evidence) ? prompt.evidence : {};
          const sources = Array.isArray(evidence.webSources) ? evidence.webSources : [];
          const source = sources.find((item) => isRecord(item)) ?? {};
          const sourceId = typeof source.id === "string" ? source.id : "missing-source";
          const freshAnswer = {
            answer: "Apple sells hardware and services per the latest filing.",
            sourceIds: [sourceId],
          };
          return {
            content: JSON.stringify({
              companyName: "Apple Inc.",
              subjectSummary: freshAnswer,
              questions: {
                whatItDoes: freshAnswer,
                howItMakesMoney: freshAnswer,
                customers: freshAnswer,
                geography: freshAnswer,
                purchaseRecurrence: freshAnswer,
                pricingPower: freshAnswer,
                recessionCyclicality: freshAnswer,
                managementTrackRecord: freshAnswer,
                capitalAllocation: freshAnswer,
                companyKpis: freshAnswer,
                riskFactors: freshAnswer,
              },
              recentMaterialEvents: [],
              factLedger: [{ claim: "Apple sells hardware and services.", sourceIds: [sourceId] }],
              openGaps: [],
            }),
            tokenEstimate: 12,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        dataDir,
        sourceOptions: { ...evidenceConfig.sourceOptions, exaApiKey: "exa-key" },
        webGatherDisabled: true,
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      provider,
      collectedSources: collectedSourceBundle({ marketSnapshots, newsSources }),
      sourceFetchImpl: secEvidenceFetch,
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    // Web gather stays disabled, but a fresh SEC-only profile is built — the prior
    // Profile must not be reused (its web source is never reattached).
    expect(prompts.map((prompt) => prompt.stage)).not.toContain("web-gather");
    expect(result.collectedSources.extendedSources).not.toContainEqual(priorWebSource);
    expect(result.collectedSources.webSubjectProfile?.sourceIds).toEqual([
      "extended-sec-edgar-aapl-10q",
    ]);
    expect(result.collectedSources.webSubjectProfile?.sourceIds).not.toContain(priorWebSource.id);
  });

  test("persists empty Web Subject Profile when extraction stage fails", async () => {
    const dataDir = tempDataDir("market-bot-web-subject-profile-failure");
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-gather") {
          return {
            content: JSON.stringify({
              requests: [
                {
                  tool: "web_search",
                  args: {
                    query: "AAPL Apple business model customers",
                    searchType: "background",
                  },
                  rationale: "company profile evidence",
                },
              ],
            }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "web-subject-profile") {
          throw new Error("profile timeout");
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await persistResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...config,
        dataDir,
        sourceOptions: { ...config.sourceOptions, exaApiKey: "exa-key" },
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      provider,
      collectedSources: collectedSourceBundle({ marketSnapshots, newsSources }),
      sourceFetchImpl: async () =>
        Response.json({
          results: [
            {
              id: "exa-search-1",
              url: "https://example.com/apple-profile",
              title: "Apple business profile",
              summary: "Apple sells hardware and services.",
            },
          ],
        }),
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(prompts.map((prompt) => prompt.stage)).toContain("web-subject-profile");
    expect(result.collectedSources.webSubjectProfile).toMatchObject({
      sourceIds: [],
      factLedger: [],
      openGaps: [expect.stringContaining("profile timeout")],
    });
    expect(result.collectedSources.extendedEvidence?.gaps).toContainEqual(
      expect.objectContaining({
        source: "web-subject-profile",
        cause: "malformed-response",
      }),
    );
    await expect(
      readFile(join(result.artifacts.normalizedDir, "web-subject-profile.json"), "utf8"),
    ).resolves.toContain("profile timeout");
  });

  test("skips Web Subject Profile extraction when web gather produces no web sources", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-gather") {
          return {
            content: JSON.stringify({ requests: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...config,
        sourceOptions: { ...config.sourceOptions, exaApiKey: "exa-key" },
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      provider,
      collectedSources: collectedSourceBundle({ marketSnapshots, newsSources }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(prompts.map((prompt) => prompt.stage)).toContain("web-gather");
    expect(prompts.map((prompt) => prompt.stage)).not.toContain("web-subject-profile");
    expect(result.collectedSources.webSubjectProfile).toBeUndefined();
  });

  test("persists configured deep Forecast Disagreement as partial non-fatal evidence", async () => {
    const dataDir = join(tmpdir(), `market-bot-forecast-disagreement-${Date.now()}`);
    dataDirs.push(dataDir);
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "forecast-disagreement") {
          if (request.model === "challenger-bad") {
            throw new Error("challenger timeout");
          }
          const report = isRecord(prompt.report) ? prompt.report : {};
          const predictions = Array.isArray(report.predictions) ? report.predictions : [];
          return {
            content: JSON.stringify({
              predictions: predictions.flatMap((prediction) =>
                isRecord(prediction) && typeof prediction.id === "string"
                  ? [{ id: prediction.id, probability: 0.8 }]
                  : [],
              ),
            }),
            tokenEstimate: 25,
            costEstimateUsd: 0.002,
          };
        }
        return {
          content: modelReport("AAPL"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await persistResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...config,
        dataDir,
        forecastDisagreementOptions: { challengerModels: ["challenger-ok", "challenger-bad"] },
      },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const sidecar = JSON.parse(
      await readFile(join(result.artifacts.normalizedDir, "forecast-disagreement.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(result.trace.stages.filter((stage) => stage === "forecast-disagreement")).toHaveLength(
      2,
    );
    expect(result.trace.forecastDisagreement).toEqual({
      configuredModelCount: 2,
      challengerModelCount: 2,
      participantCount: 3,
      successfulParticipantCount: 2,
      errorCount: 1,
    });
    expect(result.analytics.predictions.forecastDisagreement).toEqual({
      participantCount: 3,
      successfulParticipantCount: 2,
      errorCount: 1,
      highDisagreementCount: 6,
    });
    expect(result.report.dataGaps).toContain(
      "forecastDisagreement: 1 configured challenger model(s) failed; partial uncertainty signal only",
    );
    expect(result.report.extras?.forecastDisagreement).toMatchObject({
      participantCount: 3,
      successfulParticipantCount: 2,
      errorCount: 1,
    });
    expect(sidecar).toMatchObject({
      provider: "mock",
      baselineModel: "synthesis-test",
      challengerModels: ["challenger-ok", "challenger-bad"],
      participantCount: 3,
      successfulParticipantCount: 2,
      errorCount: 1,
    });
    expect(JSON.stringify(sidecar)).toContain("challenger timeout");
    await expect(readFile(join(result.artifacts.runDir, "report.json"), "utf8")).resolves.toContain(
      "forecastDisagreement",
    );
  });

  test("does not persist movers.json for ticker runs", async () => {
    const dataDir = join(tmpdir(), `market-bot-ticker-movers-${Date.now()}`);
    dataDirs.push(dataDir);
    const result = await persistResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config: { ...config, dataDir },
      provider: providerReturning(
        JSON.stringify({
          summary: "AAPL evidence is mixed.",
          keyFindings: [{ text: "AAPL is liquid.", sourceIds: ["market-aapl"] }],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          confidence: "medium",
          dataGaps: [],
        }),
      ),
      collectedSources: collectedSourceBundle({ marketSnapshots, newsSources, sourceGaps: [] }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    await expect(access(join(result.artifacts.normalizedDir, "movers.json"))).rejects.toThrow();
  });

  test("caps Evidence Quality and adds deterministic gaps for sparse sources", async () => {
    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Evidence is sparse.",
          keyFindings: [],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          confidence: "high",
          dataGaps: [],
        }),
      ),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots: [],
        newsSources: [],
        sourceGaps: [{ source: "yahoo", message: "source request failed with status 500" }],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.evidenceQuality).toBe("low");
    expect(result.report.dataGaps).toContain("No usable market data snapshots were collected");
    expect(result.report.dataGaps).toContain("No usable news sources were collected");
    expect(result.report.dataGaps).toContain("yahoo: source request failed with status 500");
    expect(result.trace.predictionCompletion).toBeUndefined();
  });

  test("does not cap Evidence Quality for missing Market Context", async () => {
    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Core market evidence is available.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Supplier news supports breadth.", sourceIds: ["news-equity-1"] }],
          bearCase: [{ text: "Single-name breadth is limited.", sourceIds: ["market-aapl"] }],
          risks: [{ text: "Breadth can reverse.", sourceIds: ["market-aapl"] }],
          catalysts: [{ text: "Supplier demand is visible.", sourceIds: ["news-equity-1"] }],
          scenarios: [
            {
              name: "Base",
              description: "Momentum continues if liquidity persists.",
              sourceIds: ["market-aapl"],
            },
          ],
          confidence: "high",
          dataGaps: [],
          predictions: mockPredictions(2),
        }),
      ),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        marketContext: {
          assetClass: "equity",
          items: [],
          gaps: [
            marketContextGap(
              sourceGap({ source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" }),
            ),
          ],
        },
        marketContextSources: [],
        sourceGaps: [
          marketContextGap(
            sourceGap({ source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" }),
          ),
        ],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.evidenceQuality).toBe("medium");
    expect(result.report.dataGaps).toContain("fred-macro: MARKET_BOT_FRED_API_KEY is not set");
  });

  test("does not cap Evidence Quality for missing optional news credentials", async () => {
    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Core market evidence is available.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Supplier news supports breadth.", sourceIds: ["news-equity-1"] }],
          bearCase: [{ text: "Single-name breadth is limited.", sourceIds: ["market-aapl"] }],
          risks: [{ text: "Breadth can reverse.", sourceIds: ["market-aapl"] }],
          catalysts: [{ text: "Supplier demand is visible.", sourceIds: ["news-equity-1"] }],
          scenarios: [
            {
              name: "Base",
              description: "Momentum continues if liquidity persists.",
              sourceIds: ["market-aapl"],
            },
          ],
          confidence: "high",
          dataGaps: [],
          predictions: mockPredictions(2),
        }),
      ),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [
          sourceGap({
            source: "marketaux-news",
            message: "missing MARKET_BOT_MARKETAUX_API_TOKEN",
            provider: "marketaux",
            capability: "news",
            cause: "missing-credential",
            evidenceQualityImpact: "no-cap",
          }),
          sourceGap({
            source: "finnhub-news",
            message: "missing MARKET_BOT_FINNHUB_API_TOKEN",
            provider: "finnhub",
            capability: "news",
            cause: "missing-credential",
            evidenceQualityImpact: "no-cap",
          }),
        ],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.evidenceQuality).toBe("medium");
    expect(result.report.dataGaps).toEqual([
      "marketaux-news: missing MARKET_BOT_MARKETAUX_API_TOKEN",
      "finnhub-news: missing MARKET_BOT_FINNHUB_API_TOKEN",
    ]);
  });

  test("caps Evidence Quality at medium when extended evidence is all gaps", async () => {
    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Ticker evidence has core sources.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Supplier news supports the ticker.", sourceIds: ["news-equity-1"] }],
          bearCase: [{ text: "Extended evidence is unavailable.", sourceIds: ["market-aapl"] }],
          risks: [
            { text: "Missing macro evidence limits confidence.", sourceIds: ["market-aapl"] },
          ],
          catalysts: [{ text: "Supplier demand is visible.", sourceIds: ["news-equity-1"] }],
          scenarios: [
            {
              name: "Base",
              description: "Momentum continues if liquidity persists.",
              sourceIds: ["market-aapl"],
            },
          ],
          confidence: "high",
          dataGaps: [],
          predictions: mockPredictions(3, "AAPL"),
        }),
      ),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        extendedSources: [],
        extendedEvidence: {
          instrument: { assetClass: "equity", symbol: "AAPL" },
          items: [],
          gaps: [
            { source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" },
            {
              source: "tradier-options",
              message: "MARKET_BOT_TRADIER_API_TOKEN is not set",
            },
          ],
        },
        sourceGaps: [
          { source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" },
          { source: "tradier-options", message: "MARKET_BOT_TRADIER_API_TOKEN is not set" },
        ],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.evidenceQuality).toBe("low");
  });

  test("allows Web Subject Profile evidence to offset one extended evidence gap", async () => {
    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Ticker evidence has core and web profile sources.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Supplier news supports the ticker.", sourceIds: ["news-equity-1"] }],
          bearCase: [
            { text: "Optional macro evidence is unavailable.", sourceIds: ["market-aapl"] },
          ],
          risks: [{ text: "Macro context is incomplete.", sourceIds: ["market-aapl"] }],
          catalysts: [{ text: "Supplier demand is visible.", sourceIds: ["news-equity-1"] }],
          scenarios: [
            {
              name: "Base",
              description: "Momentum continues if liquidity persists.",
              sourceIds: ["market-aapl"],
            },
          ],
          confidence: "high",
          dataGaps: [],
          predictions: mockPredictions(3, "AAPL"),
        }),
      ),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        extendedSources: [],
        extendedEvidence: {
          instrument: { assetClass: "equity", symbol: "AAPL" },
          items: [
            {
              category: "web-subject-profile",
              title: "Web Subject Profile",
              summary: "Cited Web Subject Profile captured for AAPL.",
              sourceIds: ["web-aapl-profile"],
              observedAt: "2026-05-19T00:00:00.000Z",
            },
          ],
          gaps: [
            {
              source: "fred-macro",
              message: "MARKET_BOT_FRED_API_KEY is not set",
              evidenceQualityImpact: "extended-evidence-cap",
            },
          ],
        },
        sourceGaps: [
          {
            source: "fred-macro",
            message: "MARKET_BOT_FRED_API_KEY is not set",
            evidenceQualityImpact: "extended-evidence-cap",
          },
        ],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.evidenceQuality).toBe("low");
  });

  test("attempts completion once and keeps the shortfall when no candidate is returned", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        return {
          content: JSON.stringify({
            summary: "Evidence is sourced.",
            keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
            bullCase: [],
            bearCase: [],
            risks: [],
            catalysts: [],
            scenarios: [],
            confidence: "medium",
            dataGaps: ["A fifth prediction was not emitted because evidence was weak."],
            predictions: [],
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    expect(finalPrompts).toHaveLength(2);
    expect(finalPrompts[1]?.predictionCompletion).toMatchObject({
      requestedCount: 2,
      existingPredictions: [],
    });
    expect(result.trace.predictionRetryErrors ?? []).toEqual([]);
    expect(result.trace.predictionCompletion).toMatchObject({
      initialCount: 0,
      targetCount: 2,
      acceptedPredictionIds: [],
      outcome: "no-eligible-candidates",
    });
    expect(result.report.predictions).toHaveLength(0);
    expect(result.report.dataGaps.filter((gap) => gap.includes("prediction"))).toEqual([
      "predictionShortfall: emitted 0 of 2 target predictions; evidence did not support more",
    ]);
  });

  test("records redundancy trims without reprompting when post-trim count meets target", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage !== "final-synthesis") {
          return {
            content: emptySelectionStageReport(prompt.stage),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        finalCalls += 1;
        if (finalCalls === 1) {
          // Emit 4 predictions; one is a redundant adjacent → trimmed to 3.
          // Deep market-overview-equity target is 3, so 3 >= 3 — no completion pass.
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "SPY moved.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: [
                {
                  id: "pred-1",
                  claim: "SPY closes higher over 5 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +5) > close(SPY, 0)",
                  horizonTradingDays: 5,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
                {
                  id: "pred-adjacent",
                  claim: "SPY closes higher over 6 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +6) > close(SPY, 0)",
                  horizonTradingDays: 6,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
                {
                  id: "pred-range",
                  claim: "SPY breaks out of range.",
                  kind: "range",
                  subject: "SPY",
                  measurableAs: "close(SPY, +10) outside [520, 560]",
                  horizonTradingDays: 10,
                  probability: 0.65,
                  sourceIds: ["market-aapl"],
                },
                {
                  id: "pred-vol",
                  claim: "VIX spikes above 20.",
                  kind: "volatility",
                  subject: "^VIX",
                  measurableAs: "max(close(^VIX), 0..+10) > 20",
                  horizonTradingDays: 10,
                  probability: 0.55,
                  sourceIds: ["market-aapl"],
                },
              ],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        throw new Error("at-target redundancy trims must not trigger completion");
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "deep" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const redundancyReason =
      "Prediction pred-adjacent: redundant direction forecast for SPY at 6 trading days (within 2 trading days of accepted 5d)";

    expect(finalPrompts).toHaveLength(1);
    expect(finalPrompts[0]?.predictionRepromptErrors).toBeUndefined();
    expect(result.trace.predictionRetryErrors ?? []).toEqual([]);
    expect(result.trace.predictionTrimWarnings).toContain(redundancyReason);
    expect(result.trace.predictionReplacementAttempted).toBeUndefined();
    expect(result.report.predictions).toHaveLength(3);
    expect(result.report.predictions.map((p) => p.id)).toEqual([
      "pred-1",
      "pred-range",
      "pred-vol",
    ]);
    expect(result.report.dataGaps.some((gap) => gap.includes("predictionShortfall"))).toBe(false);
    expect(priorStageNames(finalPrompts[0] ?? {})).toEqual([
      "specialist-analysis",
      "regime-context-analysis",
      "mover-theme-analysis",
      "critique",
    ]);
  });

  test("ships non-redundant forecasts when adjacent direction forecasts are trimmed", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage !== "final-synthesis") {
          return {
            content: emptySelectionStageReport(prompt.stage),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        finalCalls += 1;
        if (finalCalls === 1) {
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "SPY moved.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: [
                {
                  id: "pred-1",
                  claim: "SPY closes higher over 5 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +5) > close(SPY, 0)",
                  horizonTradingDays: 5,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
                {
                  id: "pred-adjacent",
                  claim: "SPY closes higher over 6 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +6) > close(SPY, 0)",
                  horizonTradingDays: 6,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
                {
                  id: "pred-distinct",
                  claim: "SPY closes higher over 8 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +8) > close(SPY, 0)",
                  horizonTradingDays: 8,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
              ],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        throw new Error("at-target redundancy trims must not trigger completion");
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const redundancyReason =
      "Prediction pred-adjacent: redundant direction forecast for SPY at 6 trading days (within 2 trading days of accepted 5d)";

    expect(finalPrompts).toHaveLength(1);
    expect(finalPrompts[0]?.predictionRepromptErrors).toBeUndefined();
    expect(result.trace.predictionRetryErrors ?? []).toEqual([]);
    expect(result.trace.predictionTrimWarnings).toContain(redundancyReason);
    expect(result.report.predictions.map((prediction) => prediction.id)).toEqual([
      "pred-1",
      "pred-distinct",
    ]);
    expect(result.report.dataGaps.some((gap) => gap.includes("predictionShortfall"))).toBe(false);
  });

  test("fires exactly one completion pass when redundant trim drops below target", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage !== "final-synthesis") {
          return {
            content: emptySelectionStageReport(prompt.stage),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        finalCalls += 1;
        if (finalCalls === 1) {
          // Emit 2 predictions; one is redundant-adjacent → trimmed to 1.
          // Deep market-overview-equity target is 3, so 1 < 3 → replacement fires.
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "SPY moved.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: [
                {
                  id: "pred-1",
                  claim: "SPY closes higher over 5 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +5) > close(SPY, 0)",
                  horizonTradingDays: 5,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
                {
                  id: "pred-adjacent",
                  claim: "SPY closes higher over 6 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +6) > close(SPY, 0)",
                  horizonTradingDays: 6,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
              ],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        if (finalCalls === 2) {
          // Completion response includes the existing prediction plus two additions.
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "SPY moved.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: mockPredictions(3),
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        throw new Error("completion pass must fire at most once");
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "deep" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const redundancyReason =
      "Prediction pred-adjacent: redundant direction forecast for SPY at 6 trading days (within 2 trading days of accepted 5d)";

    expect(finalPrompts).toHaveLength(2);
    expect(finalPrompts[0]?.predictionRepromptErrors).toBeUndefined();
    expect(finalPrompts[1]?.predictionRepromptErrors).toBeUndefined();
    expect(finalPrompts[1]?.predictionCompletion).toMatchObject({
      requestedCount: 2,
      existingPredictions: [{ id: "pred-1" }],
    });
    expect(result.report.predictions).toHaveLength(3);
    expect(result.trace.predictionRetryErrors ?? []).toEqual([]);
    expect(result.trace.predictionTrimWarnings).toContainEqual(redundancyReason);
    expect(result.trace.predictionCompletion).toMatchObject({
      initialCount: 1,
      targetCount: 3,
      acceptedPredictionIds: ["pred-2", "pred-3"],
      rejectedCandidateCount: 1,
      outcome: "improved",
    });
    expect(result.report.dataGaps.some((gap) => gap.includes("predictionShortfall"))).toBe(false);
  });

  test("accepts partial completion without a second pass", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage !== "final-synthesis") {
          return {
            content: emptySelectionStageReport(prompt.stage),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        finalCalls += 1;
        if (finalCalls === 1) {
          // 2 predictions, 1 redundant → 1 after trim < 3 target → replacement fires.
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "SPY moved.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: [
                {
                  id: "pred-1",
                  claim: "SPY closes higher over 5 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +5) > close(SPY, 0)",
                  horizonTradingDays: 5,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
                {
                  id: "pred-adjacent",
                  claim: "SPY closes higher over 6 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +6) > close(SPY, 0)",
                  horizonTradingDays: 6,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
              ],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        if (finalCalls === 2) {
          // One duplicate and one addition leave the report below target.
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "SPY moved.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: mockPredictions(2),
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        throw new Error("residual shortfall must not trigger a second completion pass");
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "deep" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");

    expect(finalPrompts).toHaveLength(2);
    expect(result.trace.predictionCompletion).toMatchObject({
      acceptedPredictionIds: ["pred-2"],
      outcome: "improved",
    });
    expect(result.report.predictions).toHaveLength(2);
    // Shortfall gap present because 2 < 3 target.
    expect(result.report.dataGaps.some((gap) => gap.includes("predictionShortfall"))).toBe(true);
  });

  test("attempts completion for a clean shortfall without replacing accepted predictions", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage !== "final-synthesis") {
          return {
            content: emptySelectionStageReport(prompt.stage),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        // Emit 1 prediction — below deep target 3 but no redundancy.
        return {
          content: JSON.stringify({
            summary: "Evidence is sourced.",
            keyFindings: [{ text: "SPY moved.", sourceIds: ["market-aapl"] }],
            bullCase: [],
            bearCase: [],
            risks: [],
            catalysts: [],
            scenarios: [],
            confidence: "medium",
            dataGaps: [],
            predictions: mockPredictions(1),
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "deep" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");

    expect(finalPrompts).toHaveLength(2);
    expect(result.trace.predictionCompletion).toMatchObject({
      acceptedPredictionIds: [],
      outcome: "no-eligible-candidates",
    });
    expect(result.report.predictions).toHaveLength(1);
    expect(result.report.dataGaps.some((gap) => gap.includes("predictionShortfall"))).toBe(true);
  });

  test("merges only informative valid completion candidates and preserves the base report", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage !== "final-synthesis") {
          return {
            content: emptySelectionStageReport(prompt.stage),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        finalCalls += 1;
        if (finalCalls === 1) {
          return {
            content: JSON.stringify({
              summary: "Base report remains authoritative.",
              keyFindings: [{ text: "SPY evidence is sourced.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              dataGaps: [],
              predictions: [mockPredictions(1)[0]],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        return {
          content: JSON.stringify({
            summary: "This completion prose must be ignored.",
            predictions: [
              mockPredictions(1)[0],
              {
                ...(mockPredictions(2)[1] as Record<string, unknown>),
                id: "near-low",
                probability: 0.45,
              },
              {
                ...(mockPredictions(3)[2] as Record<string, unknown>),
                id: "near-high",
                probability: 0.55,
              },
              {
                ...(mockPredictions(2, "AAPL")[1] as Record<string, unknown>),
                id: "off-subject",
              },
              {
                ...(mockPredictions(4)[3] as Record<string, unknown>),
                id: "unknown-source",
                sourceIds: ["missing-source"],
              },
              {
                id: "shorter-collision",
                kind: "direction",
                subject: "SPY",
                measurableAs: "close(SPY, +4) > close(SPY, 0)",
                horizonTradingDays: 4,
                probability: 0.6,
                sourceIds: ["market-aapl"],
              },
              {
                id: "valid-range",
                kind: "range",
                subject: "SPY",
                measurableAs: "close(SPY, +10) outside [450, 550]",
                horizonTradingDays: 10,
                probability: 0.65,
                sourceIds: ["market-aapl"],
              },
            ],
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "deep" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const [, completionPrompt] = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    expect(Object.keys((completionPrompt?.requiredShape ?? {}) as object)).toEqual(["predictions"]);
    // The completion pass records completion steering, not the primary prediction instruction.
    const completionOutput = result.stageOutputs.findLast(
      (output) => output.stage === "final-synthesis",
    );
    expect(completionOutput?.steering).toContain(
      "Return a JSON object containing only a predictions array with up to",
    );
    expect(result.report.summary).toBe("Base report remains authoritative.");
    expect(result.report.predictions.map((prediction) => prediction.id)).toEqual([
      "pred-1",
      "valid-range",
    ]);
    expect(result.trace.predictionCompletion).toMatchObject({
      acceptedPredictionIds: ["valid-range"],
      rejectedCandidateCount: 6,
      outcome: "improved",
    });
    expect(result.trace.predictionCompletion?.rejectionReasons.join(" ")).toContain(
      "near-base-rate",
    );
    expect(result.trace.predictionCompletion?.rejectionReasons.join(" ")).toContain(
      "unknown sourceId",
    );
  });

  test("keeps the accepted report when completion fails", async () => {
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage !== "final-synthesis") {
          return {
            content: emptySelectionStageReport(prompt.stage),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        finalCalls += 1;
        if (finalCalls === 2) {
          throw new Error("completion unavailable");
        }
        return {
          content: JSON.stringify({
            summary: "Base report remains available.",
            keyFindings: [{ text: "SPY evidence is sourced.", sourceIds: ["market-aapl"] }],
            bullCase: [],
            bearCase: [],
            risks: [],
            catalysts: [],
            scenarios: [],
            dataGaps: [],
            predictions: [mockPredictions(1)[0]],
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "deep" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.summary).toBe("Base report remains available.");
    expect(result.report.predictions.map((prediction) => prediction.id)).toEqual(["pred-1"]);
    expect(result.trace.predictionCompletion).toMatchObject({
      acceptedPredictionIds: [],
      outcome: "failed",
      failureReason: "completion unavailable",
    });
  });

  test("keeps the accepted report when completion returns malformed JSON", async () => {
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage !== "final-synthesis") {
          return {
            content: emptySelectionStageReport(prompt.stage),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        finalCalls += 1;
        return {
          content:
            finalCalls === 2
              ? "{not-json"
              : JSON.stringify({
                  summary: "Base report remains available.",
                  keyFindings: [{ text: "SPY evidence is sourced.", sourceIds: ["market-aapl"] }],
                  bullCase: [],
                  bearCase: [],
                  risks: [],
                  catalysts: [],
                  scenarios: [],
                  dataGaps: [],
                  predictions: [mockPredictions(1)[0]],
                }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "deep" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.predictions.map((prediction) => prediction.id)).toEqual(["pred-1"]);
    expect(result.trace.predictionCompletion?.outcome).toBe("failed");
    expect(result.trace.predictionCompletion?.failureReason).toContain("JSON");
  });

  test("re-prompts synthesis once when report findings omit source IDs", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
        }

        if (prompt.stage === "final-synthesis" && finalCalls === 1) {
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "AAPL moved.", sourceIds: [] }],
              bullCase: [{ text: "Supplier news supports breadth.", sourceIds: [] }],
              bearCase: [{ text: "Single-name breadth is limited.", sourceIds: [] }],
              risks: [{ text: "Breadth can reverse.", sourceIds: [] }],
              catalysts: [{ text: "Supplier demand is visible.", sourceIds: [] }],
              scenarios: [
                {
                  name: "Base",
                  description: "Momentum continues if liquidity persists.",
                  sourceIds: [],
                },
              ],
              confidence: "medium",
              dataGaps: [],
              predictions: mockPredictions(2),
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        return {
          content: modelReport("SPY"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const retryPrompt = finalPrompts[1] ?? {};

    expect(finalPrompts).toHaveLength(2);
    expect(result.report.keyFindings[0]?.sourceIds).toEqual(["market-aapl"]);
    expect(result.trace.stages).toEqual([
      "source-collection",
      "spotlight-selection",
      "playbook-selection",
      "specialist-analysis",
      "critique",
      "final-synthesis",
      "final-synthesis",
    ]);
    expect(retryPrompt.reportValidationErrors).toContain(
      "Major findings must reference source IDs",
    );
    expect(retryPrompt.allowedSourceIds).toEqual(["market-aapl", "news-equity-1"]);
    expect(result.trace.reportValidationRetryErrors).toEqual([
      "Major findings must reference source IDs",
    ]);
  });

  test("discloses absent Tradier options as a data gap without source-id retry", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0,
          };
        }

        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
          const allowedSourceIds = Array.isArray(prompt.allowedSourceIds)
            ? prompt.allowedSourceIds.filter((value): value is string => typeof value === "string")
            : [];
          const guidance =
            typeof prompt.sourceIdGuidance === "string" ? prompt.sourceIdGuidance : "";
          const hasGapGuidance =
            allowedSourceIds.includes("market-aapl") &&
            !allowedSourceIds.includes("tradier-options") &&
            guidance.includes("tradier-options") &&
            guidance.includes("dataGaps");

          return {
            content: JSON.stringify({
              summary: "AAPL evidence is sourced.",
              keyFindings: [
                {
                  text: "AAPL has a current market snapshot.",
                  sourceIds: [hasGapGuidance ? "market-aapl" : "tradier-options"],
                },
              ],
              bullCase: [
                { text: "Market evidence supports the setup.", sourceIds: ["market-aapl"] },
              ],
              bearCase: [{ text: "Options IV evidence is absent.", sourceIds: ["market-aapl"] }],
              risks: [
                { text: "Options coverage remains unavailable.", sourceIds: ["market-aapl"] },
              ],
              catalysts: [
                { text: "Market data is the visible input.", sourceIds: ["market-aapl"] },
              ],
              scenarios: [
                {
                  name: "Base",
                  description: "Evidence remains limited without options IV.",
                  sourceIds: ["market-aapl"],
                },
              ],
              confidence: "medium",
              dataGaps: hasGapGuidance
                ? ["tradier-options: missing MARKET_BOT_TRADIER_API_TOKEN"]
                : [],
              predictions: mockPredictions(2, "AAPL"),
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        return {
          content: modelReport("AAPL"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config: { ...config, dataDir: tempDataDir("market-bot-tradier-gap") },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [
          sourceGap({
            source: "tradier-options",
            message: "missing MARKET_BOT_TRADIER_API_TOKEN",
            capability: "extended-evidence",
            cause: "missing-credential",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const finalPrompt = finalPrompts[0] ?? {};

    expect(finalCalls).toBe(1);
    expect(finalPrompts).toHaveLength(1);
    expect(finalPrompt.allowedSourceIds).toEqual(["market-aapl", "news-equity-1"]);
    expect(finalPrompt.sourceIdGuidance).toContain("dataGaps");
    expect(result.trace.reportValidationRetryErrors).toBeUndefined();
    expect(result.report.dataGaps).toContain(
      "tradier-options: missing MARKET_BOT_TRADIER_API_TOKEN",
    );
    expect(result.report.keyFindings[0]?.sourceIds).toEqual(["market-aapl"]);
  });

  test("keeps prediction retry guidance when report validation also retries synthesis", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const invalidRelativePrediction = {
      id: "bad-relative",
      claim: "QQQ outperforms SPY over 5 trading days.",
      kind: "relative",
      subject: "DIA",
      measurableAs: "close(QQQ, +5)/close(QQQ, 0) > close(SPY, +5)/close(SPY, 0)",
      horizonTradingDays: 5,
      probability: 0.55,
      sourceIds: ["market-aapl"],
    };
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
        }

        if (prompt.stage === "final-synthesis" && finalCalls === 1) {
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: [invalidRelativePrediction, ...mockPredictions(1)],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        if (prompt.stage === "final-synthesis" && (finalCalls === 2 || finalCalls === 3)) {
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "AAPL moved.", sourceIds: [] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: [invalidRelativePrediction, ...mockPredictions(1)],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        return {
          content: modelReport("SPY"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const reportRetryPrompt = finalPrompts[3] ?? {};

    expect(finalPrompts).toHaveLength(4);
    expect(reportRetryPrompt.reportValidationErrors).toContain(
      "Major findings must reference source IDs",
    );
    expect(reportRetryPrompt.predictionRepromptErrors).toContain(
      "Prediction bad-relative: subject does not match measurableAs",
    );
    // The validation error keeps the reprompt alive; a count shortfall never does (ADR 0004).
    expect(
      (reportRetryPrompt.predictionRepromptErrors as readonly string[] | undefined)?.some(
        (reason) => reason.includes("predictionShortfall"),
      ),
    ).toBe(false);
    expect(result.trace.predictionRetryErrors).toContain(
      "Prediction bad-relative: subject does not match measurableAs",
    );
    const finalOutputs = result.stageOutputs.filter((output) => output.stage === "final-synthesis");
    expect(finalOutputs[0]?.attempt).toBe(1);
    expect(finalOutputs[0]?.repromptReason).toBeUndefined();
    // Attempt 1 records the primary prediction steering and no repair steering.
    expect(finalOutputs[0]?.steering).toContain(
      "predictions using subjects from predictionSubjects",
    );
    expect(finalOutputs[0]?.steering).not.toContain("fixing the flagged predictions");
    expect(finalOutputs[1]?.attempt).toBe(2);
    expect(finalOutputs[1]?.repromptReason?.predictionErrors).toContain(
      "Prediction bad-relative: subject does not match measurableAs",
    );
    // Attempt 2 is a prediction reprompt, so its steering carries the repair instruction.
    expect(finalOutputs[1]?.steering).toContain("fixing the flagged predictions");
    const traceFinalRecords = result.trace.stageRecords?.filter(
      (record) => record.stage === "final-synthesis",
    );
    expect(traceFinalRecords?.[0]?.attempt).toBe(1);
    expect(traceFinalRecords?.[1]?.attempt).toBe(2);
    const analyticsFinalRecords = result.analytics.runShape.stages.filter(
      (record) => record.stage === "final-synthesis",
    );
    expect(analyticsFinalRecords[0]?.attempt).toBe(1);
    expect(analyticsFinalRecords[1]?.repromptReason?.predictionErrors).toContain(
      "Prediction bad-relative: subject does not match measurableAs",
    );
  });

  test("normalizes duplicate source gaps before source planning and analytics", async () => {
    const grossProfitGap = sourceGap({
      source: "sec-edgar",
      message: "Missing SEC company facts: grossProfit",
      capability: "extended-evidence",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });
    const grossProfitDuplicate = sourceGap({
      source: "sec-edgar",
      message: " Missing SEC   company facts: grossProfit ",
      capability: "extended-evidence",
      cause: "validation-failed",
      evidenceQualityImpact: "core-cap",
    });
    const overlappingGap = sourceGap({
      source: "sec-edgar",
      message: "Missing SEC company facts: grossProfit, capex",
      capability: "extended-evidence",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });
    const macroContextGap = sourceGap({
      source: "fred-market-context",
      message: "Missing macro context: DGS10",
      capability: "market-context",
      cause: "provider-data-missing",
    });
    const macroContextDuplicate = sourceGap({
      source: "fred-market-context",
      message: " Missing macro   context: DGS10 ",
      capability: "market-context",
      cause: "validation-failed",
    });
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 100, costEstimateUsd: 0.01 };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config: { ...config, dataDir: tempDataDir("market-bot-source-gap-dedupe") },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        extendedEvidence: {
          instrument: { symbol: "AAPL", assetClass: "equity" },
          items: [],
          gaps: [grossProfitGap, grossProfitDuplicate, overlappingGap],
        },
        marketContext: {
          assetClass: "equity",
          items: [],
          gaps: [macroContextGap, macroContextDuplicate],
        },
        sourceGaps: [grossProfitGap, grossProfitDuplicate, overlappingGap],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const regulatoryLane = result.evidenceLanes.lanes.find(
      (lane) => lane.lane === "regulatory-filings",
    );

    expect(result.collectedSources.sourceGaps).toEqual([grossProfitGap, overlappingGap]);
    expect(result.collectedSources.extendedEvidence?.gaps).toEqual([
      grossProfitGap,
      overlappingGap,
    ]);
    expect(result.collectedSources.marketContext?.gaps).toEqual([macroContextGap]);
    expect(regulatoryLane?.gapText).toEqual([
      "sec-edgar: Missing SEC company facts: grossProfit",
      "sec-edgar: Missing SEC company facts: grossProfit, capex",
    ]);
    expect(regulatoryLane?.gapIds).toHaveLength(2);
    expect(result.analytics.sourceFunnel.sourceGaps).toEqual({
      total: 2,
      bySource: { "sec-edgar": 2 },
    });
    expect(result.analytics.evidenceQuality.extendedEvidence.gapCount).toBe(2);
    expect(result.analytics.evidenceQuality.marketContext.gapCount).toBe(1);
    expect(result.analytics.evidenceLanes?.gapCount).toBe(result.evidenceLanes.summary.gapCount);
    expect(result.trace.evidenceLanes?.gapCount).toBe(result.evidenceLanes.summary.gapCount);
    expect(result.report.dataGaps).toContain("sec-edgar: Missing SEC company facts: grossProfit");
    expect(result.report.dataGaps).toContain(
      "sec-edgar: Missing SEC company facts: grossProfit, capex",
    );
  });

  test("re-prompts when report validation retry regresses prediction validity", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const invalidRelativePrediction = {
      id: "bad-relative",
      claim: "QQQ outperforms SPY over 5 trading days.",
      kind: "relative",
      subject: "DIA",
      measurableAs: "close(QQQ, +5)/close(QQQ, 0) > close(SPY, +5)/close(SPY, 0)",
      horizonTradingDays: 5,
      probability: 0.55,
      sourceIds: ["market-aapl"],
    };
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
        }

        if (prompt.stage === "final-synthesis" && finalCalls === 1) {
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "AAPL moved.", sourceIds: [] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: mockPredictions(2),
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        if (prompt.stage === "final-synthesis" && finalCalls === 2) {
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: [invalidRelativePrediction, ...mockPredictions(1)],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        return {
          content: modelReport("SPY"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const combinedRetryPrompt = finalPrompts[2] ?? {};

    expect(finalPrompts).toHaveLength(3);
    expect(combinedRetryPrompt.reportValidationErrors).toContain(
      "Major findings must reference source IDs",
    );
    expect(combinedRetryPrompt.predictionRepromptErrors).toContain(
      "Prediction bad-relative: subject does not match measurableAs",
    );
    expect(result.report.predictions.length).toBeGreaterThanOrEqual(2);
  });

  test("logs prediction validation errors to trace when malformed predictions are dropped", async () => {
    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Evidence is sourced.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          confidence: "medium",
          dataGaps: [],
          predictions: [
            {
              id: "bad-1",
              kind: "invalid-kind",
              claim: "x",
              subject: "SPY",
              measurableAs: "close(SPY, +5) > close(SPY, 0)",
              horizonTradingDays: 5,
              probability: 0.6,
              sourceIds: [],
            },
            {
              id: "bad-2",
              kind: "direction",
              claim: "x",
              subject: "SPY",
              measurableAs: "close(SPY, +5) > close(SPY, 0)",
              horizonTradingDays: 30,
              probability: 0.6,
              sourceIds: [],
            },
            ...mockPredictions(2),
          ],
        }),
      ),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.predictions).toHaveLength(2);
    expect(result.trace.predictionErrors).toBeDefined();
    expect(result.trace.predictionErrors?.length).toBe(2);
  });

  test("records attached report news in the seen index after persistence", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-news-seen-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const newsSeenPath = join(dataDir, "news-seen.json");
    dataDirs.push(dataDir);

    const result = await persistResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config: {
        ...config,
        dataDir,
        sourceOptions: {
          ...config.sourceOptions,
          newsSeenPath,
          newsSeenRetentionDays: 30,
        },
      },
      provider: providerReturning(
        JSON.stringify({
          summary: "Core market evidence is available.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Supplier news supports breadth.", sourceIds: ["news-equity-1"] }],
          bearCase: [{ text: "Single-name breadth is limited.", sourceIds: ["market-aapl"] }],
          risks: [{ text: "Breadth can reverse.", sourceIds: ["market-aapl"] }],
          catalysts: [{ text: "Supplier demand is visible.", sourceIds: ["news-equity-1"] }],
          scenarios: [
            {
              name: "Base",
              description: "Momentum continues if liquidity persists.",
              sourceIds: ["market-aapl"],
            },
          ],
          confidence: "high",
          dataGaps: [],
          predictions: mockPredictions(2),
        }),
      ),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources: [
          newsSource({
            title: "Apple supplier demand improves",
            url: "https://example.test/apple-suppliers?utm_source=feed",
            provider: "yahoo-news",
          }),
        ],
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const entries = await readNewsSeenEntries(newsSeenPath);

    expect(await Bun.file(join(result.artifacts.runDir, "report.json")).exists()).toBe(true);
    expect(entries).toMatchObject([
      {
        lane: "market-overview:equity",
        canonicalUrl: "https://example.test/apple-suppliers",
        title: "Apple supplier demand improves",
        provider: "yahoo-news",
        firstRunId: result.report.runId,
        lastRunId: result.report.runId,
      },
    ]);
  });
});
