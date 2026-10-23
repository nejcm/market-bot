import { describe, expect, test } from "bun:test";
import { runForecastDisagreement } from "../src/research/forecast-disagreement";
import { prediction, researchReport } from "./support/fixtures";
import type { ModelRequest } from "../src/model/types";
import {
  LIVE_STAGES,
  createRecordingProvider,
  makeReplayProvider,
} from "../src/replay/llm-cassette";

function request(stage: string, model: string): ModelRequest {
  return {
    model,
    messages: [{ role: "user", content: JSON.stringify({ stage, priorStages: [] }) }],
  };
}

const first = { content: "first", tokenEstimate: 1 };
const second = { content: "second", tokenEstimate: 2 };

describe("strict LLM cassette replay", () => {
  test("records usage and replays it verbatim; older recordings replay without usage", async () => {
    const usage = { inputTokens: 90, cachedInputTokens: 60, outputTokens: 10 };
    const recorder = createRecordingProvider({
      name: "live",
      generate: async () => ({ content: "ok", tokenEstimate: 100, usage }),
    });
    await recorder.provider.generate(request("web-gather", "m"));
    const replay = makeReplayProvider({
      entries: { ...recorder.cassette().entries, "critique|m": [first] },
    });

    const recorded = await replay.generate(request("web-gather", "m"));
    const older = await replay.generate(request("critique", "m"));

    expect(recorded.usage).toEqual(usage);
    expect(older.usage).toBeUndefined();
  });

  test("rejects a recorded usage count that is not a number instead of summing it", async () => {
    const replay = makeReplayProvider({
      entries: { "web-gather|m": [{ ...first, usage: { inputTokens: "8" } as never }] },
    });

    await expect(replay.generate(request("web-gather", "m"))).rejects.toThrow(
      "LLM cassette has invalid usage for web-gather|m call 1",
    );
  });

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

  test.each([...LIVE_STAGES])(
    "routes every invocation of selected %s live, freezing only prior-stage durations",
    async (stage) => {
      const requests: ModelRequest[] = [];
      const provider = makeReplayProvider(
        { entries: { "critique|old": [first] } },
        {
          name: "fake-live",
          generate: async (input) => {
            requests.push(input);
            return second;
          },
        },
        stage,
      );
      const input: ModelRequest = {
        model: "current",
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              stage,
              instruction: "current prompt",
              ...(stage === "final-synthesis" || stage === "critique"
                ? { priorStages: [{ durationMs: 12, content: "recorded analysis" }] }
                : {}),
            }),
          },
        ],
      };
      await Promise.all([provider.generate(input), provider.generate(input)]);
      expect(requests).toHaveLength(2);
      for (const sent of requests) {
        const prompt = JSON.parse(sent.messages[0]!.content);
        expect(prompt.stage).toBe(stage);
        expect(prompt.instruction).toBe("current prompt");
        if ("priorStages" in prompt) {
          expect(prompt.priorStages[0].durationMs).toBe(0);
        } else {
          expect(sent.messages).toEqual(input.messages);
        }
      }
      expect(JSON.parse(input.messages[0]!.content).priorStages?.[0]?.durationMs).not.toBe(0);
      expect(provider.diagnostics().consumedResponses).toEqual({});
      await expect(provider.generate(request("missing-stage", "a"))).rejects.toThrow(
        "0 recorded models",
      );
      await expect(provider.generate(input)).rejects.toThrow("Refusing live");
      expect(requests).toHaveLength(2);
    },
  );

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
