import type { AppConfig } from "../config";
import type { ModelProvider, ModelRequest, ModelResponse } from "./types";

interface OpenAIChoice {
  readonly message?: {
    readonly content?: string;
  };
}

interface OpenAIUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

interface OpenAIResponse {
  readonly choices?: readonly OpenAIChoice[];
  readonly usage?: OpenAIUsage;
}

interface OpenAIResponsesOutputContent {
  readonly type?: string;
  readonly text?: string;
}

interface OpenAIResponsesOutputItem {
  readonly type?: string;
  readonly content?: readonly OpenAIResponsesOutputContent[];
}

interface OpenAIResponsesResponse {
  readonly output_text?: string;
  readonly output?: readonly OpenAIResponsesOutputItem[];
  readonly usage?: OpenAIUsage;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function readOpenAIResponse(value: unknown): OpenAIResponse {
  return typeof value === "object" && value !== null ? (value as OpenAIResponse) : {};
}

function readOpenAIResponsesResponse(value: unknown): OpenAIResponsesResponse {
  return typeof value === "object" && value !== null ? (value as OpenAIResponsesResponse) : {};
}

function openAIResponsesInput(messages: ModelRequest["messages"]): readonly {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function openAIResponsesContent(payload: OpenAIResponsesResponse): string | undefined {
  if (payload.output_text !== undefined && payload.output_text.trim() !== "") {
    return payload.output_text;
  }
  const text = payload.output
    ?.filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text" && content.text !== undefined)
    .map((content) => content.text)
    .join("");
  return text !== undefined && text.trim() !== "" ? text : undefined;
}

export function createOpenAIProvider(
  config: AppConfig,
  fetchImpl: FetchLike = fetch,
): ModelProvider {
  if (config.apiKey === undefined) {
    throw new Error("OPENAI_API_KEY or MARKET_BOT_OPENAI_API_KEY is required");
  }

  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";

  return {
    name: config.provider,
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      if (request.webSearch === true) {
        const response = await fetchImpl(`${baseUrl}/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: request.model,
            input: openAIResponsesInput(request.messages),
            tools: [{ type: "web_search" }],
            ...(request.params?.temperature !== undefined
              ? { temperature: request.params.temperature }
              : {}),
            ...(request.params?.top_p !== undefined ? { top_p: request.params.top_p } : {}),
            ...(request.params?.max_completion_tokens !== undefined
              ? { max_output_tokens: request.params.max_completion_tokens }
              : {}),
            ...(request.params?.reasoningEffort !== undefined
              ? { reasoning: { effort: request.params.reasoningEffort } }
              : {}),
          }),
        });

        if (!response.ok) {
          throw new Error(`OpenAI request failed with status ${response.status}`);
        }

        const payload = readOpenAIResponsesResponse(await response.json());
        const content = openAIResponsesContent(payload);

        if (content === undefined) {
          throw new Error("OpenAI response did not include content");
        }

        const tokenEstimate =
          payload.usage?.total_tokens ??
          request.messages.reduce((total, message) => total + message.content.length / 4, 0);

        return {
          content,
          tokenEstimate,
          costEstimateUsd: 0,
        };
      }

      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          response_format: request.responseFormat === "json" ? { type: "json_object" } : undefined,
          ...(request.params?.temperature !== undefined
            ? { temperature: request.params.temperature }
            : {}),
          ...(request.params?.top_p !== undefined ? { top_p: request.params.top_p } : {}),
          ...(request.params?.max_completion_tokens !== undefined
            ? { max_completion_tokens: request.params.max_completion_tokens }
            : {}),
          ...(request.params?.seed !== undefined ? { seed: request.params.seed } : {}),
          ...(request.params?.frequency_penalty !== undefined
            ? { frequency_penalty: request.params.frequency_penalty }
            : {}),
          ...(request.params?.presence_penalty !== undefined
            ? { presence_penalty: request.params.presence_penalty }
            : {}),
          ...(request.params?.stop !== undefined ? { stop: request.params.stop } : {}),
          ...(request.params?.reasoningEffort !== undefined
            ? { reasoning_effort: request.params.reasoningEffort }
            : {}),
          ...(request.params?.verbosity !== undefined
            ? { verbosity: request.params.verbosity }
            : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI request failed with status ${response.status}`);
      }

      const payload = readOpenAIResponse(await response.json());
      const content = payload.choices?.[0]?.message?.content;

      if (content === undefined || content.trim() === "") {
        throw new Error("OpenAI response did not include content");
      }

      const tokenEstimate =
        payload.usage?.total_tokens ??
        request.messages.reduce((total, message) => total + message.content.length / 4, 0);

      return {
        content,
        tokenEstimate,
        costEstimateUsd: 0,
      };
    },
  };
}
