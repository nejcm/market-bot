import { describe, expect, test } from "bun:test";
import { runForecastDisagreement } from "../src/research/forecast-disagreement";
import { prediction, researchReport } from "./support/fixtures";
import type { ModelRequest } from "../src/model/types";
import { makeReplayProvider } from "./support/run-fixtures/llm-cassette";

function request(stage: string, model: string): ModelRequest {
  return {
    model,
    messages: [{ role: "user", content: JSON.stringify({ stage, priorStages: [] }) }],
  };
}

const first = { content: "first", tokenEstimate: 1 };
const second = { content: "second", tokenEstimate: 2 };

describe("strict LLM cassette replay", () => {
  test("orders repeated calls per exact model, including concurrent challengers and unique-model aliases", async () => {
    const replay = makeReplayProvider({
      entries: {
        "forecast-disagreement|a": [first, second],
        "forecast-disagreement|b": [second, first],
        "critique|old": [first, second],
        "unused|old": [first],
      },
    });
    expect(
      await Promise.all([
        replay.generate(request("forecast-disagreement", "a")),
        replay.generate(request("forecast-disagreement", "b")),
        replay.generate(request("forecast-disagreement", "a")),
        replay.generate(request("forecast-disagreement", "b")),
      ]),
    ).toEqual([first, second, second, first]);
    expect(await replay.generate(request("critique", "new"))).toEqual(first);
    expect(await replay.generate(request("critique", "old"))).toEqual(second);
    expect(replay.diagnostics()).toEqual({
      consumedResponses: {
        "forecast-disagreement|a": 2,
        "forecast-disagreement|b": 2,
        "critique|old": 2,
      },
      unusedResponses: { "unused|old": 1 },
    });
  });

  test("replays concurrent challengers emitted by the real Forecast Disagreement phase", async () => {
    const report = researchReport({ predictions: [prediction()] });
    const provider = makeReplayProvider({
      entries: {
        "forecast-disagreement|a": [
          {
            content: JSON.stringify({ predictions: [{ id: "pred-1", probability: 0.3 }] }),
            tokenEstimate: 1,
          },
        ],
        "forecast-disagreement|b": [
          {
            content: JSON.stringify({ predictions: [{ id: "pred-1", probability: 0.8 }] }),
            tokenEstimate: 2,
          },
        ],
      },
    });
    const result = await runForecastDisagreement({
      generatedAt: report.generatedAt,
      provider,
      providerName: provider.name,
      baselineModel: "baseline",
      challengerModels: ["a", "b"],
      report,
      loaded: { system: "system", instruction: "instruction", goal: "goal" },
    });
    expect(result.artifact.errorCount).toBe(0);
    expect(result.artifact.participants.filter(({ role }) => role === "challenger")).toEqual([
      expect.objectContaining({
        model: "a",
        status: "ok",
        predictions: [{ predictionId: "pred-1", probability: 0.3 }],
      }),
      expect.objectContaining({
        model: "b",
        status: "ok",
        predictions: [{ predictionId: "pred-1", probability: 0.8 }],
      }),
    ]);
    expect(provider.diagnostics().consumedResponses).toEqual({
      "forecast-disagreement|a": 1,
      "forecast-disagreement|b": 1,
    });
  });

  test("rejects missing keys, empty sequences, and overflow without fabricating responses", async () => {
    const replay = makeReplayProvider({ entries: { "critique|a": [first], "web-gather|a": [] } });
    expect(await replay.generate(request("critique", "a"))).toEqual(first);
    await expect(replay.generate(request("critique", "a"))).rejects.toThrow("call 2");
    await expect(replay.generate(request("web-gather", "a"))).rejects.toThrow("call 1");
    await expect(replay.generate(request("evidence-request", "a"))).rejects.toThrow(
      "0 recorded models",
    );
    expect(replay.diagnostics().consumedResponses).toEqual({ "critique|a": 1 });
  });

  test("refuses ambiguous fallback even after exact responses have been consumed and blocks spending", async () => {
    let liveCalls = 0;
    const provider = makeReplayProvider(
      {
        entries: {
          "forecast-disagreement|a": [first],
          "forecast-disagreement|b": [second],
        },
      },
      {
        name: "fake-live",
        webSearchCapability: async () => ({ supported: true, reason: "supported" }),
        generate: async () => {
          liveCalls += 1;
          return first;
        },
      },
    );
    await expect(provider.webSearchCapability!()).resolves.toEqual({
      supported: true,
      reason: "supported",
    });
    expect(await provider.generate(request("forecast-disagreement", "a"))).toEqual(first);
    await expect(provider.generate(request("forecast-disagreement", "new"))).rejects.toThrow(
      "2 recorded models",
    );
    await expect(provider.generate(request("final-synthesis", "live"))).rejects.toThrow(
      "Refusing live",
    );
    expect(liveCalls).toBe(0);
  });

  test.each([undefined, "peer proposal prose", "{}", '{"stage":"unknown"}'])(
    "rejects requests without supported stage identity instead of sharing unknown recordings: %s",
    async (content) => {
      const replay = makeReplayProvider({ entries: { "unknown|a": [first, second] } });
      await expect(
        replay.generate({
          model: "a",
          messages: content === undefined ? [] : [{ role: "user", content }],
        }),
      ).rejects.toThrow("unsupported request without stage identity");
    },
  );
});
