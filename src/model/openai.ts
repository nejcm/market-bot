import type { AppConfig } from "../config";
import { decodeServerSentEvents, mapSseEventsToText, type SseTextResult } from "./sse";
import type { ModelRequest, ModelResponse, StreamingModelProvider } from "./types";
import { estimateOpenAICost } from "./pricing";

interface OpenAIChoice {
  readonly message?: {
    readonly content?: string;
  };
}

interface OpenAIStreamChoice {
  readonly delta?: {
    readonly content?: string;
  };
}

interface OpenAIStreamChunk {
  readonly choices?: readonly OpenAIStreamChoice[];
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
  };
}

interface OpenAIUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly prompt_tokens_details?: {
    readonly cached_tokens?: number;
  };
  readonly input_tokens_details?: {
    readonly cached_tokens?: number;
  };
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

function chatCompletionsBody(request: ModelRequest, stream = false): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    ...(stream ? { stream: true } : {}),
    ...(!stream && request.responseFormat === "json"
      ? { response_format: { type: "json_object" } }
      : {}),
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
    ...(request.params?.verbosity !== undefined ? { verbosity: request.params.verbosity } : {}),
  };
}

function parseOpenAIStreamEvent(data: string): SseTextResult {
  let payload: OpenAIStreamChunk = {};
  try {
    payload = JSON.parse(data) as OpenAIStreamChunk;
  } catch {
    throw new Error("OpenAI stream included malformed JSON");
  }
  if (payload.error !== undefined) {
    const detail = payload.error.message ?? payload.error.type ?? "unknown provider error";
    throw new Error(`OpenAI stream failed: ${detail}`);
  }
  const text = payload.choices?.map((choice) => choice.delta?.content ?? "").join("");
  return text !== undefined ? { text } : {};
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
): StreamingModelProvider {
  if (config.apiKey === undefined) {
    throw new Error("OPENAI_API_KEY or MARKET_BOT_OPENAI_API_KEY is required");
  }

  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";

  return {
    name: config.provider,
    generateStream: async (request: ModelRequest): Promise<ReadableStream<string>> => {
      if (request.responseFormat === "json") {
        throw new Error("OpenAI streaming does not support JSON response format");
      }
      if (request.webSearch === true) {
        throw new Error("OpenAI streaming does not support web search");
      }

      request.signal?.throwIfAborted();
      const abortController = new AbortController();
      const abortFromRequest = (): void => abortController.abort(request.signal?.reason);
      if (request.signal?.aborted === true) {
        abortFromRequest();
      } else {
        request.signal?.addEventListener("abort", abortFromRequest, { once: true });
      }
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(chatCompletionsBody(request, true)),
        signal: abortController.signal,
      });
      if (!response.ok) {
        abortController.abort();
        throw new Error(`OpenAI request failed with status ${response.status}`);
      }
      if (response.body === null) {
        abortController.abort();
        throw new Error("OpenAI streaming response did not include a body");
      }

      return mapSseEventsToText(decodeServerSentEvents(response.body), {
        providerName: "OpenAI",
        parse: (event) => {
          if (event.event === "error") {
            throw new Error(`OpenAI stream failed: ${event.data}`);
          }
          return parseOpenAIStreamEvent(event.data);
        },
        cancel: () => abortController.abort(),
      });
    },
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      if (request.webSearch === true) {
        if (request.responseFormat === "json") {
          throw new Error("OpenAI web search does not support JSON response format");
        }
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
        const cost =
          config.provider === "openai"
            ? estimateOpenAICost(
                request.model,
                payload.usage?.input_tokens,
                payload.usage?.output_tokens,
                payload.usage?.input_tokens_details?.cached_tokens,
                payload.output?.filter((item) => item.type === "web_search_call").length,
              )
            : undefined;

        return {
          content,
          tokenEstimate,
          ...cost,
        };
      }

      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(chatCompletionsBody(request)),
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
      const cost =
        config.provider === "openai"
          ? estimateOpenAICost(
              request.model,
              payload.usage?.prompt_tokens,
              payload.usage?.completion_tokens,
              payload.usage?.prompt_tokens_details?.cached_tokens,
            )
          : undefined;

      return {
        content,
        tokenEstimate,
        ...cost,
      };
    },
  };
}
