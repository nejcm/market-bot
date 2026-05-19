export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly responseFormat?: "json";
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
