import { afterEach, describe, expect, test } from "bun:test";
import type { ResearchCommand } from "../src/cli/job-registry";
import type { ModelProvider } from "../src/model/types";
import { runResearchJob } from "../src/research/orchestrator";
import type { StageLabel } from "../src/research/prompt-loader";
import { collectedSources as collectedSourceBundle } from "./support/fixtures";
import {
  config,
  createDataDirRegistry,
  marketSnapshots,
  modelReport,
  newsSources,
} from "./support/orchestrator-helpers";

const { cleanupDataDirs, tempDataDir } = createDataDirRegistry();

afterEach(cleanupDataDirs);

const ROUTING_STAGES = new Set([
  "specialist-analysis",
  "regime-context-analysis",
  "mover-theme-analysis",
  "instrument-evidence-analysis",
  "market-behavior-analysis",
  "equity-analysis",
]);

function routingProvider(): ModelProvider {
  return {
    name: "routing-guard",
    generate: async (request) => {
      const prompt = JSON.parse(
        request.messages.findLast((message) => message.role === "user")?.content ?? "{}",
      ) as Record<string, unknown>;
      if (prompt.stage === "spotlight-selection") {
        return {
          content: JSON.stringify({ rationale: "routing guard", selections: [] }),
          tokenEstimate: 10,
        };
      }
      if (prompt.stage === "playbook-selection") {
        return { content: JSON.stringify({ selections: [] }), tokenEstimate: 10 };
      }
      if (prompt.stage === "final-synthesis") {
        const report = JSON.parse(modelReport()) as Record<string, unknown>;
        return { content: JSON.stringify({ ...report, predictions: [] }), tokenEstimate: 10 };
      }
      return {
        content: JSON.stringify({ analysis: `routing guard ${String(prompt.stage)}` }),
        tokenEstimate: 10,
      };
    },
  };
}

const ROUTING_CASES: {
  readonly name: string;
  readonly command: ResearchCommand;
  readonly reasoningVariant?: "simplified";
  readonly expectedStages: readonly StageLabel[];
}[] = [
  {
    name: "brief-equity",
    command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
    expectedStages: ["specialist-analysis"],
  },
  {
    name: "simplified-brief-equity",
    command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
    reasoningVariant: "simplified",
    expectedStages: ["specialist-analysis"],
  },
  {
    name: "deep-equity-default",
    command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
    expectedStages: [
      "specialist-analysis",
      "instrument-evidence-analysis",
      "market-behavior-analysis",
    ],
  },
  {
    name: "deep-crypto",
    command: { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "deep" },
    expectedStages: [
      "specialist-analysis",
      "instrument-evidence-analysis",
      "market-behavior-analysis",
    ],
  },
  {
    name: "simplified-deep-crypto",
    command: { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "deep" },
    reasoningVariant: "simplified",
    expectedStages: [
      "specialist-analysis",
      "instrument-evidence-analysis",
      "market-behavior-analysis",
    ],
  },
  {
    name: "deep-research",
    command: {
      jobType: "research",
      assetClass: "equity",
      subject: "artificial intelligence",
      depth: "deep",
    },
    expectedStages: [
      "specialist-analysis",
      "instrument-evidence-analysis",
      "market-behavior-analysis",
    ],
  },
  {
    name: "deep-market-overview",
    command: {
      jobType: "market-overview",
      assetClass: "equity",
      depth: "deep",
      horizonTradingDays: 5,
    },
    expectedStages: ["specialist-analysis", "regime-context-analysis", "mover-theme-analysis"],
  },
  {
    name: "simplified-deep-equity",
    command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
    reasoningVariant: "simplified",
    expectedStages: ["equity-analysis"],
  },
];

describe("production reasoning routing guard", () => {
  test.each(ROUTING_CASES)("keeps the expected reasoning stages for $name", async (fixture) => {
    const result = await runResearchJob({
      command: fixture.command,
      config: { ...config, dataDir: tempDataDir(`market-bot-routing-${fixture.name}`) },
      provider: routingProvider(),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-07-27T00:00:00.000Z"),
      ...(fixture.reasoningVariant !== undefined
        ? { reasoningVariant: fixture.reasoningVariant }
        : {}),
    });

    expect(
      result.stageOutputs
        .map((output) => output.stage)
        .filter((stage) => ROUTING_STAGES.has(stage)),
    ).toEqual([...fixture.expectedStages]);
  });
});

// `range` is withdrawn from the simplified deep-equity prompts, but requiredShape is prompt text
// Only — readPredictions still accepts the global kind. This guards the orchestrator wiring that
// Turns the withdrawal into enforcement, and that no other variant is affected.
function rangeEmittingProvider(): ModelProvider {
  return {
    name: "range-emitting",
    generate: async (request) => {
      const prompt = JSON.parse(
        request.messages.findLast((message) => message.role === "user")?.content ?? "{}",
      ) as Record<string, unknown>;
      if (prompt.stage === "spotlight-selection") {
        return {
          content: JSON.stringify({ rationale: "range guard", selections: [] }),
          tokenEstimate: 10,
        };
      }
      if (prompt.stage === "playbook-selection") {
        return { content: JSON.stringify({ selections: [] }), tokenEstimate: 10 };
      }
      if (prompt.stage === "final-synthesis") {
        const report = JSON.parse(modelReport()) as Record<string, unknown>;
        return {
          content: JSON.stringify({
            ...report,
            predictions: [
              {
                id: "pred-1",
                kind: "direction",
                subject: "AAPL",
                measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
                horizonTradingDays: 5,
                probability: 0.62,
                sourceIds: ["market-aapl"],
              },
              {
                id: "pred-2",
                kind: "range",
                subject: "AAPL",
                measurableAs: "close(AAPL, +5) outside [145.6, 264.7]",
                horizonTradingDays: 5,
                probability: 0.18,
                sourceIds: ["market-aapl"],
              },
            ],
          }),
          tokenEstimate: 10,
        };
      }
      return {
        content: JSON.stringify({ analysis: `range guard ${String(prompt.stage)}` }),
        tokenEstimate: 10,
      };
    },
  };
}

async function runRangeGuard(
  name: string,
  reasoningVariant?: "simplified",
): Promise<Awaited<ReturnType<typeof runResearchJob>>> {
  return runResearchJob({
    command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
    config: { ...config, dataDir: tempDataDir(`market-bot-range-${name}`) },
    provider: rangeEmittingProvider(),
    collectedSources: collectedSourceBundle({
      rawSnapshots: [],
      marketSnapshots,
      newsSources,
      sourceGaps: [],
    }),
    now: new Date("2026-07-27T00:00:00.000Z"),
    ...(reasoningVariant !== undefined ? { reasoningVariant } : {}),
  });
}

describe("withdrawn prediction kinds", () => {
  test("a range forecast emitted on the simplified path never reaches the report", async () => {
    const result = await runRangeGuard("simplified", "simplified");
    expect(result.report.predictions.map((prediction) => prediction.kind)).not.toContain("range");
    expect(result.trace.predictionTrimWarnings ?? []).toContain(
      "Prediction pred-2: range forecasts are not solicited on this path; dropped before validation",
    );
  });

  test("the legacy deep-equity path still accepts range", async () => {
    const result = await runRangeGuard("legacy");
    expect(result.report.predictions.map((prediction) => prediction.kind)).toContain("range");
    expect(result.trace.predictionTrimWarnings ?? []).toEqual([]);
  });
});
