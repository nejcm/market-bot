import type { ModelProvider, ModelRequest } from "../../src/model/types";

export interface CapturedModelCall {
  readonly order: number;
  readonly stage: string;
  readonly model: string;
  readonly promptCharacterEstimate: number;
  readonly promptTokenEstimate: number;
  readonly providerTokenEstimate: number;
}

export interface ModelCallTotals {
  readonly callCount: number;
  readonly promptCharacterEstimate: number;
  readonly promptTokenEstimate: number;
  readonly providerTokenEstimate: number;
}

function requestStage(request: ModelRequest): string {
  const content = request.messages.findLast((message) => message.role === "user")?.content;
  if (content === undefined) {
    return "unknown";
  }
  try {
    const parsed = JSON.parse(content) as { readonly stage?: unknown };
    return typeof parsed.stage === "string" ? parsed.stage : "unknown";
  } catch {
    return "unknown";
  }
}

function withoutVolatileTiming(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => withoutVolatileTiming(item));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "durationMs")
      .map(([key, item]) => [key, withoutVolatileTiming(item)]),
  );
}

function stablePromptContent(content: string): string {
  try {
    return JSON.stringify(withoutVolatileTiming(JSON.parse(content) as unknown));
  } catch {
    return content;
  }
}

export function captureProvider(
  provider: ModelProvider,
  captured: CapturedModelCall[],
): ModelProvider {
  let order = 0;
  return {
    name: provider.name,
    generate: async (request) => {
      const currentOrder = order;
      order += 1;
      const response = await provider.generate(request);
      const promptCharacterEstimate = request.messages.reduce(
        (total, message) => total + stablePromptContent(message.content).length,
        0,
      );
      captured[currentOrder] = {
        order: currentOrder + 1,
        stage: requestStage(request),
        model: request.model,
        promptCharacterEstimate,
        promptTokenEstimate: Math.ceil(promptCharacterEstimate / 4),
        providerTokenEstimate: response.tokenEstimate,
      };
      return response;
    },
  };
}

export function modelCallTotals(captured: readonly CapturedModelCall[]): ModelCallTotals {
  return captured.reduce<ModelCallTotals>(
    (totals, call) => ({
      callCount: totals.callCount + 1,
      promptCharacterEstimate: totals.promptCharacterEstimate + call.promptCharacterEstimate,
      promptTokenEstimate: totals.promptTokenEstimate + call.promptTokenEstimate,
      providerTokenEstimate: totals.providerTokenEstimate + call.providerTokenEstimate,
    }),
    {
      callCount: 0,
      promptCharacterEstimate: 0,
      promptTokenEstimate: 0,
      providerTokenEstimate: 0,
    },
  );
}
