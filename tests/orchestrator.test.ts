import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../src/config";
import type { RunConfig } from "../src/config/runs";
import { marketContextGap, sourceGap } from "../src/domain/source-gaps";
import type { MarketContext, MarketSnapshot, Source } from "../src/domain/types";
import type { ModelProvider } from "../src/model/types";
import { persistResearchJob, runResearchJob } from "../src/research/orchestrator";
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
  readonly jobType: "daily" | "weekly" | "ticker";
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
      confidence: "medium",
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
  return Array.from({ length: count }, (_, idx) => ({
    id: `pred-${String(idx + 1)}`,
    claim: `${subject} closes higher over ${String(idx + 5)} trading days.`,
    kind: "direction",
    subject,
    measurableAs: `close(${subject}, +${String(idx + 5)}) > close(${subject}, 0)`,
    horizonTradingDays: idx + 5,
    probability: 0.6,
    sourceIds: ["market-aapl"],
  }));
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
      new Response("<html><body><p>Latest filing evidence.</p></body></html>"),
    );
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

describe("runResearchJob", () => {
  test("uses resolved run models and model params for provider calls and trace", async () => {
    const requests: { readonly model: string; readonly params: unknown }[] = [];
    const runConfig: RunConfig = {
      "daily-equity": {
        quickModel: "combo-quick",
        synthesisModel: "combo-synthesis",
        modelParams: { temperature: 0.2, reasoningEffort: "medium" },
        minimumPredictions: 2,
      },
      "daily-crypto": {},
      "weekly-equity": {},
      "weekly-crypto": {},
      ticker: {},
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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
      command: { jobType: "daily", assetClass: "equity", depth: "deep" },
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
      command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: evidenceConfig,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
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
          tool: "sec_latest_filing|tradier_iv_term_structure",
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
      availableTools: ["sec_latest_filing"],
      toolUnits: { sec_latest_filing: 3, tradier_iv_term_structure: 5 },
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
      jobType: "ticker",
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
      command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: { ...evidenceConfig, dataDir },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
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

  test("runs market spotlight selection before playbooks and exposes selected extras", async () => {
    const dataDir = tempDataDir("market-bot-spotlight");
    await writeHistoricalRun({
      dataDir,
      runId: "prior-aapl-ticker",
      jobType: "ticker",
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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

  test("merges accepted evidence tool output before specialist analysis", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        return {
          content:
            prompt.stage === "evidence-request"
              ? JSON.stringify({
                  requests: [
                    {
                      tool: "sec_latest_filing",
                      args: { symbol: "AAPL" },
                      rationale: "latest periodic filing",
                    },
                  ],
                })
              : modelReport("AAPL", "extended-sec-edgar-aapl-latest-filing"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
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
    const specialistPrompt = prompts[2] as {
      readonly evidence?: {
        readonly extendedEvidence?: {
          readonly items?: readonly { readonly title?: string }[];
        };
      };
    };

    expect(specialistPrompt.evidence?.extendedEvidence?.items?.[0]?.title).toBe(
      "AAPL latest SEC 10-Q",
    );
    expect(result.collectedSources.rawSnapshots.map((snapshot) => snapshot.adapter)).toContain(
      "sec-filing-text",
    );
    expect(result.report.sources.map((source) => source.id)).toContain(
      "extended-sec-edgar-aapl-latest-filing",
    );
    expect(result.trace.evidenceRequestLoop?.acceptedRequests).toHaveLength(1);
    expect(result.trace.evidenceRequestLoop?.sourceUnitsUsed).toBe(3);
  });

  test("selects playbooks after evidence request and injects them downstream", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "evidence-request") {
          return {
            content: JSON.stringify({
              requests: [
                {
                  tool: "sec_latest_filing",
                  args: { symbol: "AAPL" },
                  rationale: "latest filing",
                },
              ],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
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
          content: modelReport("AAPL", "extended-sec-edgar-aapl-latest-filing"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
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
    expect(result.trace.domainPlaybooks).toMatchObject({
      selected: [
        { stage: "specialist-analysis", playbookIds: ["instrument-evidence"] },
        { stage: "critique", playbookIds: ["critique-discipline"] },
      ],
      rejected: [],
    });
    expect(result.trace.stages).toContain("playbook-selection");
    expect(result.trace.tokenEstimate).toBe(
      result.stageOutputs.reduce((total, output) => total + output.tokenEstimate, 0),
    );
    expect(result.trace.costEstimateUsd).toBe(
      result.stageOutputs.reduce((total, output) => total + output.costEstimateUsd, 0),
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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
    expect(result.trace.domainPlaybooks.selected).toEqual([]);
    expect(result.trace.domainPlaybooks.rejected).toEqual([
      { stage: "evidence-request", reason: "invalid stage" },
      {
        stage: "critique",
        playbookId: "unknown-playbook",
        reason: "playbook is not eligible",
      },
    ]);
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
                    { tool: "sec_latest_filing", args: { symbol: "AAPL" }, rationale: "filing" },
                    { tool: "sec_latest_filing", args: { symbol: "AAPL" }, rationale: "repeat" },
                    {
                      tool: "tradier_iv_term_structure",
                      args: { symbol: "AAPL" },
                      rationale: "term structure",
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
      command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
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
      [
        "duplicate evidence request",
        "evidence request source budget exceeded",
        "tool is not an allowed public evidence request tool",
      ],
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
                      tool: "sec_latest_filing",
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
      command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
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
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.trace.evidenceRequestLoop?.acceptedRequests).toEqual([]);
    expect(result.trace.evidenceRequestLoop?.rejectedRequests).toEqual([
      expect.objectContaining({
        tool: "sec_latest_filing",
        args: { symbol: "MSFT" },
        reason: "requested symbol must match run symbol",
        status: "rejected",
      }),
    ]);
    expect(result.trace.evidenceRequestLoop?.emittedGaps).toContainEqual(
      expect.objectContaining({
        source: "evidence-request",
        message: "sec_latest_filing: requested symbol must match run symbol",
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
                { tool: "sec_latest_filing", args: { symbol: "AAPL" }, rationale: "filing" },
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
      command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: evidenceConfig,
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
    expect(result.trace.evidenceRequestLoop?.sourceUnitsUsed).toBe(3);
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
      command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: evidenceConfig,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.dataGaps).toContain(
      "evidence-request: Evidence request stage returned invalid JSON",
    );
    expect(result.trace.evidenceRequestLoop?.emittedGaps).toEqual([
      expect.objectContaining({
        source: "evidence-request",
        message: "Evidence request stage returned invalid JSON",
      }),
    ]);
  });

  test("skips evidence request loop outside deep equity ticker scope", async () => {
    const commands = [
      {
        jobType: "ticker" as const,
        assetClass: "equity" as const,
        symbol: "AAPL",
        depth: "brief" as const,
      },
      {
        jobType: "ticker" as const,
        assetClass: "crypto" as const,
        symbol: "BTC",
        depth: "deep" as const,
      },
      { jobType: "daily" as const, assetClass: "equity" as const, depth: "deep" as const },
      { jobType: "weekly" as const, assetClass: "equity" as const, depth: "deep" as const },
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
              content: modelReport(command.jobType === "ticker" ? command.symbol : "SPY"),
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
      if (command.jobType === "daily" || command.jobType === "weekly") {
        expectedCalls = command.depth === "deep" ? 7 : 5;
      }
      expect(calls).toBe(expectedCalls);
      expect(result.trace.stages).not.toContain("evidence-request");
      if (command.jobType === "ticker" && command.assetClass === "crypto") {
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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
      jobType: "daily",
      assetClass: "equity",
      confidence: "medium",
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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
      command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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
      command: { jobType: "weekly", assetClass: "equity", depth: "brief" },
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
        readonly minimumPredictions?: number;
      };
      readonly requiredShape?: {
        readonly predictions?: readonly { readonly horizonTradingDays?: number }[];
      };
    };

    expect(result.report.jobType).toBe("weekly");
    expect(result.report.extras?.marketUpdateCadence).toBe("weekly");
    expect(result.trace.marketUpdateCadence).toBe("weekly");
    expect(result.markdown).toContain("# equity Weekly Market Update");
    expect(result.report.predictions[0]?.horizonTradingDays).toBe(15);
    expect(result.report.dataGaps).toContain(
      "Weekly equity mover universe is seeded from Yahoo day_gainers, not a true trailing 5-session mover screener",
    );
    expect(finalPrompt.depthProfile?.defaultPredictionHorizon).toBe(15);
    expect(finalPrompt.depthProfile?.minimumPredictions).toBe(2);
    expect(finalPrompt.requiredShape?.predictions?.[0]?.horizonTradingDays).toBe(15);
  });

  test("rejects reports with trade-action language", async () => {
    await expect(
      runResearchJob({
        command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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
    await expect(readFile(join(result.artifacts.runDir, "report.json"), "utf8")).resolves.toContain(
      "Equity market breadth",
    );
    await expect(readFile(join(result.artifacts.runDir, "report.md"), "utf8")).resolves.toContain(
      "Research-only note",
    );
    await expect(readFile(join(result.artifacts.runDir, "trace.json"), "utf8")).resolves.toContain(
      "quick-test",
    );
    await expect(readFile(join(result.artifacts.runDir, "stages.json"), "utf8")).resolves.toContain(
      "spotlight-selection",
    );
  });

  test("caps Evidence Quality and adds deterministic gaps for sparse sources", async () => {
    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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

    expect(result.report.confidence).toBe("low");
    expect(result.report.dataGaps).toContain("No usable market data snapshots were collected");
    expect(result.report.dataGaps).toContain("No usable news sources were collected");
    expect(result.report.dataGaps).toContain("yahoo: source request failed with status 500");
  });

  test("does not cap Evidence Quality for missing Market Context", async () => {
    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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

    expect(result.report.confidence).toBe("high");
    expect(result.report.dataGaps).toContain("fred-macro: MARKET_BOT_FRED_API_KEY is not set");
  });

  test("caps Evidence Quality at medium when extended evidence is all gaps", async () => {
    const result = await runResearchJob({
      command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
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

    expect(result.report.confidence).toBe("medium");
  });

  test("re-prompts synthesis twice when predictions fall below minimum, then ships with shortfall gap", async () => {
    let callCount = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async () => {
        callCount += 1;
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
            predictions: [],
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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

    expect(callCount).toBe(7);
    expect(result.report.predictions).toHaveLength(0);
    expect(result.report.dataGaps.some((gap) => gap.includes("predictionShortfall"))).toBe(true);
  });

  test("re-prompts deep synthesis with coverage panel prior stages when predictions fall short", async () => {
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
            dataGaps: [],
            predictions: [],
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "deep" },
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

    expect(prompts).toHaveLength(9);
    expect(finalPrompts).toHaveLength(3);
    expect(finalPrompts[1]?.predictionRepromptErrors).toContain(
      "predictionShortfall: required 3, received 0",
    );
    expect(finalPrompts[2]?.predictionRepromptErrors).toContain(
      "predictionShortfall: required 3, received 0",
    );
    expect(result.trace.predictionRetryErrors).toEqual([
      "predictionShortfall: required 3, received 0",
    ]);
    expect(priorStageNames(finalPrompts[1] ?? {})).toEqual([
      "specialist-analysis",
      "regime-context-analysis",
      "mover-theme-analysis",
      "critique",
    ]);
    expect(priorStageNames(finalPrompts[2] ?? {})).toEqual([
      "specialist-analysis",
      "regime-context-analysis",
      "mover-theme-analysis",
      "critique",
    ]);
    expect(result.trace.stages).toEqual([
      "source-collection",
      "spotlight-selection",
      "playbook-selection",
      "specialist-analysis",
      "regime-context-analysis",
      "mover-theme-analysis",
      "critique",
      "final-synthesis",
      "final-synthesis",
      "final-synthesis",
    ]);
    expect(result.report.predictions).toHaveLength(0);
    expect(result.report.dataGaps.some((gap) => gap.includes("predictionShortfall"))).toBe(true);
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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
    expect(result.trace.reportValidationErrors).toEqual([
      "Major findings must reference source IDs",
    ]);
  });

  test("keeps prediction retry guidance when report validation also retries synthesis", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const invalidRelativePrediction = {
      id: "bad-relative",
      claim: "QQQ outperforms SPY over 5 trading days.",
      kind: "relative",
      subject: "QQQ",
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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
      'Prediction bad-relative: relative subject must be "A:B" form, got "QQQ"',
    );
    expect(reportRetryPrompt.predictionRepromptErrors).toContain(
      "predictionShortfall: required 2, received 1",
    );
    expect(result.trace.predictionRetryErrors).toContain(
      'Prediction bad-relative: relative subject must be "A:B" form, got "QQQ"',
    );
  });

  test("re-prompts when report validation retry regresses prediction validity", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const invalidRelativePrediction = {
      id: "bad-relative",
      claim: "QQQ outperforms SPY over 5 trading days.",
      kind: "relative",
      subject: "QQQ",
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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
      'Prediction bad-relative: relative subject must be "A:B" form, got "QQQ"',
    );
    expect(result.report.predictions.length).toBeGreaterThanOrEqual(2);
  });

  test("logs prediction validation errors to trace when malformed predictions are dropped", async () => {
    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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
        lane: "daily:equity",
        canonicalUrl: "https://example.test/apple-suppliers",
        title: "Apple supplier demand improves",
        provider: "yahoo-news",
        firstRunId: result.report.runId,
        lastRunId: result.report.runId,
      },
    ]);
  });
});
