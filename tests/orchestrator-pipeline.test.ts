import { afterEach, describe, expect, test } from "bun:test";
import { persistResearchJob, runResearchJob } from "../src/research/orchestrator";
import { runScorePass } from "../src/scoring";
import { legacyMarketOverviewCommand } from "./support/commands";
import { collectedSources as collectedSourceBundle } from "./support/fixtures";
import { providerReturning } from "./support/mocks";
import {
  config,
  createDataDirRegistry,
  emptySelectionStageReport,
  evidenceConfig,
  historicalContextGaps,
  marketSnapshots,
  mockPredictions,
  modelReport,
  newsSources,
  priorStageNames,
  secEvidenceFetch,
  writeHistoricalRun,
} from "./support/orchestrator-helpers";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunConfig } from "../src/config/runs";
import type { ModelProvider } from "../src/model/types";

const { cleanupDataDirs, tempDataDir } = createDataDirRegistry();

afterEach(cleanupDataDirs);

describe("runResearchJob pipeline stages", () => {
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
});
