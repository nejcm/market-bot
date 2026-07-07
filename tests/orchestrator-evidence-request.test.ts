import { describe, expect, test } from "bun:test";
import { runResearchJob } from "../src/research/orchestrator";
import { legacyMarketOverviewCommand } from "./support/commands";
import { collectedSources as collectedSourceBundle } from "./support/fixtures";
import {
  evidenceConfig,
  marketSnapshots,
  modelReport,
  newsSources,
  secEvidenceFetch,
  secFetchUnavailable,
} from "./support/orchestrator-helpers";
import type { ModelProvider } from "../src/model/types";

describe("runResearchJob evidence request loop", () => {
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
});
