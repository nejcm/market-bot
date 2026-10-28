import { describe, expect, test } from "bun:test";
import { rollupStageUsage } from "../src/research/stage-usage";

describe("rollupStageUsage", () => {
  test("sums reported usage per stage in first-call order", () => {
    expect(
      rollupStageUsage([
        {
          stage: "web-gather",
          tokenEstimate: 100,
          usage: { inputTokens: 80, cachedInputTokens: 50, outputTokens: 20, reasoningTokens: 5 },
        },
        { stage: "critique", tokenEstimate: 10, usage: { inputTokens: 7, outputTokens: 3 } },
        {
          stage: "web-gather",
          tokenEstimate: 40,
          usage: { inputTokens: 30, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 1 },
        },
      ]),
    ).toEqual([
      {
        stage: "web-gather",
        calls: 2,
        failedCalls: 0,
        unreportedCalls: 0,
        tokenEstimate: 140,
        inputTokens: 110,
        cachedInputTokens: 70,
        outputTokens: 30,
        reasoningTokens: 6,
      },
      {
        stage: "critique",
        calls: 1,
        failedCalls: 0,
        unreportedCalls: 0,
        tokenEstimate: 10,
        inputTokens: 7,
        cachedInputTokens: "unknown",
        outputTokens: 3,
        reasoningTokens: "unknown",
      },
    ]);
  });

  test("a call without usage makes every field unknown, never a partial or zero sum", () => {
    const [row] = rollupStageUsage([
      { stage: "web-gather", tokenEstimate: 100, usage: { inputTokens: 80, outputTokens: 20 } },
      { stage: "web-gather", tokenEstimate: 50, usage: "unknown" },
      { stage: "web-gather", tokenEstimate: 25 },
    ]);

    expect(row).toEqual({
      stage: "web-gather",
      calls: 3,
      failedCalls: 0,
      unreportedCalls: 2,
      tokenEstimate: 175,
      inputTokens: "unknown",
      cachedInputTokens: "unknown",
      outputTokens: "unknown",
      reasoningTokens: "unknown",
    });
  });

  test("no calls yields no rows", () => {
    expect(rollupStageUsage([])).toEqual([]);
  });
});
