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
  readonly reasoningEffort?: "low" | "medium" | "high";
  readonly verbosity?: "low" | "medium" | "high";
}

export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly responseFormat?: "json";
  readonly webSearch?: boolean;
  readonly params?: ModelParams;
}

export interface ModelResponse {
  readonly content: string;
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
}

export interface ModelProvider {
  readonly name: string;
  readonly generate: (request: ModelRequest) => Promise<ModelResponse>;
}
