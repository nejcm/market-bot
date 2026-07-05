export interface CostPricing {
  readonly source: string;
  readonly asOf: string;
}

interface ModelPricing {
  readonly inputUsdPerMillionTokens: number;
  readonly cachedInputUsdPerMillionTokens?: number;
  readonly outputUsdPerMillionTokens: number;
  readonly longContext?: {
    readonly thresholdInputTokens: number;
    readonly inputUsdPerMillionTokens: number;
    readonly cachedInputUsdPerMillionTokens: number;
    readonly outputUsdPerMillionTokens: number;
  };
  readonly metadata: CostPricing;
}

const OPENAI_PRICING: Readonly<Record<string, ModelPricing>> = {
  "gpt-5.5": openAIPrice(5, 0.5, 30, {
    thresholdInputTokens: 272_000,
    inputUsdPerMillionTokens: 10,
    cachedInputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 45,
  }),
  "gpt-5.4": openAIPrice(2.5, 0.25, 15, {
    thresholdInputTokens: 272_000,
    inputUsdPerMillionTokens: 5,
    cachedInputUsdPerMillionTokens: 0.5,
    outputUsdPerMillionTokens: 22.5,
  }),
  "gpt-5.4-mini": openAIPrice(0.75, 0.075, 4.5),
};

const ANTHROPIC_PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-opus-4-8": anthropicPrice(5, 25),
  "claude-sonnet-4-6": anthropicPrice(3, 15),
};

function openAIPrice(
  inputUsdPerMillionTokens: number,
  cachedInputUsdPerMillionTokens: number,
  outputUsdPerMillionTokens: number,
  longContext?: ModelPricing["longContext"],
): ModelPricing {
  return {
    inputUsdPerMillionTokens,
    cachedInputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
    ...(longContext !== undefined ? { longContext } : {}),
    metadata: {
      source: "https://developers.openai.com/api/docs/pricing",
      asOf: "2026-07-05",
    },
  };
}

function anthropicPrice(
  inputUsdPerMillionTokens: number,
  outputUsdPerMillionTokens: number,
): ModelPricing {
  return {
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
    metadata: {
      source: "https://claude.com/pricing#api",
      asOf: "2026-07-05",
    },
  };
}

function estimateCost(
  pricing: ModelPricing | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cachedInputTokens: number | undefined = 0,
  additionalCostUsd: number | undefined = 0,
): { readonly costEstimateUsd: number; readonly costPricing: CostPricing } | undefined {
  const cachedTokens = cachedInputTokens ?? 0;
  const additionalCost = additionalCostUsd ?? 0;
  if (
    pricing === undefined ||
    !isUsageCount(inputTokens) ||
    !isUsageCount(outputTokens) ||
    !isUsageCount(cachedTokens) ||
    !Number.isFinite(additionalCost) ||
    additionalCost < 0 ||
    cachedTokens > inputTokens
  ) {
    return undefined;
  }
  const rates =
    pricing.longContext !== undefined && inputTokens > pricing.longContext.thresholdInputTokens
      ? pricing.longContext
      : pricing;
  const uncachedInputTokens = inputTokens - cachedTokens;
  const cachedInputRate = rates.cachedInputUsdPerMillionTokens ?? rates.inputUsdPerMillionTokens;
  return {
    costEstimateUsd:
      (uncachedInputTokens * rates.inputUsdPerMillionTokens +
        cachedTokens * cachedInputRate +
        outputTokens * rates.outputUsdPerMillionTokens) /
        1_000_000 +
      additionalCost,
    costPricing: pricing.metadata,
  };
}

function isUsageCount(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

function webSearchCost(webSearchCalls: number | undefined): number {
  return webSearchCalls === undefined || isUsageCount(webSearchCalls)
    ? (webSearchCalls ?? 0) * 0.01
    : Number.NaN;
}

export function estimateOpenAICost(
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cachedInputTokens?: number,
  webSearchCalls?: number,
): { readonly costEstimateUsd: number; readonly costPricing: CostPricing } | undefined {
  return estimateCost(
    OPENAI_PRICING[model],
    inputTokens,
    outputTokens,
    cachedInputTokens,
    webSearchCost(webSearchCalls),
  );
}

export function estimateAnthropicCost(
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  webSearchCalls?: number,
): { readonly costEstimateUsd: number; readonly costPricing: CostPricing } | undefined {
  return estimateCost(
    ANTHROPIC_PRICING[model],
    inputTokens,
    outputTokens,
    0,
    webSearchCost(webSearchCalls),
  );
}

export function sumKnownCosts(costs: readonly (number | undefined)[]): number | undefined {
  let total = 0;
  for (const cost of costs) {
    if (cost === undefined) {
      return undefined;
    }
    total += cost;
  }
  return total;
}
