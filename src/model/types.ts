import type { CostPricing } from "./pricing";

export type ReasoningEffort = "low" | "medium" | "high";

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ModelParams {
  readonly temperature?: number;
  readonly top_p?: number;
  readonly max_completion_tokens?: number;
  readonly seed?: number;
  readonly frequency_penalty?: number;
  readonly presence_penalty?: number;
  readonly stop?: readonly string[];
  readonly reasoningEffort?: ReasoningEffort;
  readonly verbosity?: "low" | "medium" | "high";
}

export interface ModelRequest {
  readonly stage?: string;
  // Call-ledger telemetry only (e.g. "round-2"); providers never send it.
  readonly step?: string;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly signal?: AbortSignal;
  readonly responseFormat?: "json";
  readonly webSearch?: boolean;
  readonly params?: ModelParams;
}

// Provider-reported counts (input includes cached); an unreturned field is absent, a reported 0 stays 0.
export interface ModelUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
}

export const USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
] as const satisfies readonly (keyof ModelUsage)[];

export function isModelUsage(value: unknown): value is ModelUsage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([field, count]) =>
        USAGE_FIELDS.some((known) => known === field) &&
        typeof count === "number" &&
        Number.isFinite(count) &&
        count >= 0,
    )
  );
}

export function reportedUsage(usage: {
  readonly [Field in keyof ModelUsage]-?: unknown;
}): ModelUsage | undefined {
  const reported = Object.entries(usage).filter(
    ([, value]) => typeof value === "number" && Number.isFinite(value),
  );
  return reported.length > 0 ? (Object.fromEntries(reported) as ModelUsage) : undefined;
}

export interface ModelResponse {
  readonly content: string;
  readonly tokenEstimate: number;
  readonly usage?: ModelUsage;
  readonly costEstimateUsd?: number;
  readonly costPricing?: CostPricing;
}

type WebSearchCapabilityReason = "provider-unsupported" | "probe-failed" | "supported";

export interface WebSearchCapability {
  readonly supported: boolean;
  readonly reason: WebSearchCapabilityReason;
}

export interface ModelProvider {
  readonly name: string;
  readonly generate: (request: ModelRequest) => Promise<ModelResponse>;
  readonly webSearchCapability?: () => Promise<WebSearchCapability>;
}

export interface StreamingModelProvider extends ModelProvider {
  readonly generateStream: (request: ModelRequest) => Promise<ReadableStream<string>>;
}
