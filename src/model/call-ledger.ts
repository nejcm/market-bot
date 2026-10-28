import { requestStage } from "../replay/llm-cassette";
import { sumKnownCosts, type CostPricing } from "./pricing";
import type { ModelProvider, ModelUsage } from "./types";

export interface ModelCallRecord {
  readonly stage: string;
  // 1-based order of dispatch within the stage; for final synthesis it equals the attempt.
  readonly call: number;
  readonly step?: string;
  readonly model: string;
  readonly status: "ok" | "error";
  readonly tokenEstimate?: number;
  readonly costEstimateUsd?: number;
  readonly costPricing?: CostPricing;
  readonly usage: ModelUsage | "unknown";
}

export interface LedgeredModelProvider extends ModelProvider {
  readonly modelCalls: () => readonly ModelCallRecord[];
}

export function isLedgered(provider: ModelProvider): provider is LedgeredModelProvider {
  return "modelCalls" in provider && typeof provider.modelCalls === "function";
}

// Always a fresh ledger: call it once per run boundary so concurrent runs never share one.
export function withModelCallLedger(provider: ModelProvider): LedgeredModelProvider {
  const calls: ModelCallRecord[] = [];
  const perStage = new Map<string, number>();
  return {
    ...provider,
    modelCalls: () => [...calls],
    generate: async (request) => {
      const stage = requestStage(request);
      const call = (perStage.get(stage) ?? 0) + 1;
      perStage.set(stage, call);
      const identity = {
        stage,
        call,
        ...(request.step !== undefined ? { step: request.step } : {}),
        model: request.model,
      };
      try {
        const response = await provider.generate(request);
        calls.push({
          ...identity,
          status: "ok",
          tokenEstimate: response.tokenEstimate,
          ...(response.costEstimateUsd !== undefined
            ? { costEstimateUsd: response.costEstimateUsd }
            : {}),
          ...(response.costPricing !== undefined ? { costPricing: response.costPricing } : {}),
          usage: response.usage ?? "unknown",
        });
        return response;
      } catch (error: unknown) {
        calls.push({ ...identity, status: "error", usage: "unknown" });
        throw error;
      }
    },
  };
}

export function ledgerTotals(calls: readonly ModelCallRecord[]): {
  readonly tokenEstimate: number;
  readonly costEstimateUsd?: number;
  readonly costPricing: readonly CostPricing[];
} {
  const costEstimateUsd = sumKnownCosts(calls.map((call) => call.costEstimateUsd));
  return {
    tokenEstimate: calls.reduce((total, call) => total + (call.tokenEstimate ?? 0), 0),
    ...(costEstimateUsd !== undefined ? { costEstimateUsd } : {}),
    costPricing: [
      ...new Map(
        calls.flatMap(({ costPricing }) =>
          costPricing === undefined
            ? []
            : [[`${costPricing.source}\n${costPricing.asOf}`, costPricing]],
        ),
      ).values(),
    ],
  };
}
