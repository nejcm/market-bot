import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { isLedgered, ledgerTotals, withModelCallLedger } from "../src/model/call-ledger";
import { withRunCapture } from "../src/replay/capture";
import type { ModelProvider, ModelRequest } from "../src/model/types";

const request = (stage: string, model: string, step?: string): ModelRequest => ({
  stage,
  model,
  ...(step !== undefined ? { step } : {}),
  messages: [{ role: "user", content: "{}" }],
});

describe("model call ledger", () => {
  test("records every call with stage, per-stage index, step, model, and usage or unknown", async () => {
    const seen: ModelRequest[] = [];
    const provider: ModelProvider = {
      name: "fake",
      generate: async (input) => {
        seen.push(input);
        if (input.model === "boom") {
          throw new Error("provider down");
        }
        return input.model === "quiet"
          ? { content: "{}", tokenEstimate: 7 }
          : { content: "{}", tokenEstimate: 30, usage: { inputTokens: 20, outputTokens: 0 } };
      },
    };
    const ledger = withModelCallLedger(provider);

    await ledger.generate(request("web-gather", "q", "round-1"));
    await ledger.generate(request("web-gather", "quiet", "round-2"));
    await expect(ledger.generate(request("forecast-disagreement", "boom"))).rejects.toThrow(
      "provider down",
    );
    await ledger.generate({
      model: "q",
      messages: [{ role: "user", content: JSON.stringify({ stage: "forecast-disagreement" }) }],
    });

    expect(ledger.modelCalls()).toEqual([
      {
        stage: "web-gather",
        call: 1,
        step: "round-1",
        model: "q",
        status: "ok",
        tokenEstimate: 30,
        usage: { inputTokens: 20, outputTokens: 0 },
      },
      {
        stage: "web-gather",
        call: 2,
        step: "round-2",
        model: "quiet",
        status: "ok",
        tokenEstimate: 7,
        usage: "unknown",
      },
      { stage: "forecast-disagreement", call: 1, model: "boom", status: "error", usage: "unknown" },
      {
        stage: "forecast-disagreement",
        call: 2,
        model: "q",
        status: "ok",
        tokenEstimate: 30,
        usage: { inputTokens: 20, outputTokens: 0 },
      },
    ]);
    expect(seen[0]?.messages).toEqual([{ role: "user", content: "{}" }]);
  });

  test("concurrent runs sharing a provider each get their own ledger and indices", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const shared = withModelCallLedger({
      name: "fake",
      generate: async () => {
        await gate;
        return { content: "{}", tokenEstimate: 1 };
      },
    });
    const run = (symbol: string, stages: readonly string[]) =>
      withRunCapture(
        {
          command: { jobType: "equity", assetClass: "equity", symbol, depth: "deep" },
          config: { captureReplay: false } as AppConfig,
          provider: shared,
          now: new Date("2026-10-23T00:00:00.000Z"),
        },
        async (runtime) => {
          const pending = stages.map((stage) => runtime.provider.generate(request(stage, symbol)));
          await Promise.all(pending);
          return { artifacts: { runDir: symbol }, provider: runtime.provider };
        },
      );
    const runs = Promise.all([
      run("AAPL", ["peer-universe-proposal", "final-synthesis"]),
      run("MSFT", ["final-synthesis"]),
    ]);
    release();
    const [a, b] = await runs;

    expect(isLedgered(a.provider) && a.provider.modelCalls()).toMatchObject([
      { stage: "peer-universe-proposal", call: 1, model: "AAPL" },
      { stage: "final-synthesis", call: 1, model: "AAPL" },
    ]);
    expect(isLedgered(b.provider) && b.provider.modelCalls()).toMatchObject([
      { stage: "final-synthesis", call: 1, model: "MSFT" },
    ]);
  });

  test("totals tokens and cost over every ledger call; an unpriced call leaves cost unknown", () => {
    const ok = { call: 1, model: "q", status: "ok", usage: "unknown" } as const;
    const pricing = { source: "table", asOf: "2026-10-01" };
    expect(
      ledgerTotals([
        {
          ...ok,
          stage: "peer-universe-proposal",
          tokenEstimate: 30,
          costEstimateUsd: 0.25,
          costPricing: pricing,
        },
        {
          ...ok,
          stage: "final-synthesis",
          tokenEstimate: 100,
          costEstimateUsd: 0.5,
          costPricing: pricing,
        },
      ]),
    ).toEqual({ tokenEstimate: 130, costEstimateUsd: 0.75, costPricing: [pricing] });
    expect(
      ledgerTotals([
        { ...ok, stage: "final-synthesis", tokenEstimate: 100, costEstimateUsd: 0.5 },
        { stage: "final-synthesis", call: 2, model: "q", status: "error", usage: "unknown" },
      ]),
    ).toEqual({ tokenEstimate: 100, costPricing: [] });
  });
});
