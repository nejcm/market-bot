import type { AppConfig } from "../config";
import { decodeServerSentEvents, mapSseEventsToText, type SseTextResult } from "./sse";
import type { ModelMessage, ModelRequest, ModelResponse, StreamingModelProvider } from "./types";
import { estimateAnthropicCost } from "./pricing";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_WEB_SEARCH_TOOL_TYPE = "web_search_20260318";
const DEFAULT_MAX_TOKENS = 16_384;
const JSON_INSTRUCTION =
  "IMPORTANT: Respond with a valid JSON object only. No prose, no markdown, no code fences.";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface AnthropicContentBlock {
  readonly type?: string;
  readonly text?: string;
}

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly server_tool_use?: {
    readonly web_search_requests?: number;
  };
}

interface AnthropicResponse {
  readonly content?: readonly AnthropicContentBlock[];
  readonly usage?: AnthropicUsage;
}

interface AnthropicErrorResponse {
  readonly error?: {
    readonly type?: string;
    readonly message?: string;
  };
  readonly request_id?: string;
}

function readAnthropicResponse(value: unknown): AnthropicResponse {
  return typeof value === "object" && value !== null ? (value as AnthropicResponse) : {};
}

function readAnthropicErrorResponse(value: unknown): AnthropicErrorResponse {
  return typeof value === "object" && value !== null ? (value as AnthropicErrorResponse) : {};
}

function buildSystem(
  messages: readonly ModelMessage[],
  responseFormat: "json" | undefined,
): string | undefined {
  const systemContent = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  if (responseFormat !== "json") {
    return systemContent.trim() !== "" ? systemContent : undefined;
  }

  return systemContent.trim() !== "" ? `${systemContent}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION;
}

function estimateTokens(messages: readonly ModelMessage[]): number {
  return Math.ceil(messages.reduce((total, message) => total + message.content.length / 4, 0));
}

function anthropicRequestBody(request: ModelRequest, stream = false): Record<string, unknown> {
  const system = buildSystem(request.messages, request.responseFormat);
  const messages = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));

  return {
    model: request.model,
    max_tokens: request.params?.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
    ...(system !== undefined ? { system } : {}),
    messages,
    ...(stream ? { stream: true } : {}),
    ...(request.webSearch === true
      ? { tools: [{ type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE, name: "web_search" }] }
      : {}),
    ...(request.params?.reasoningEffort !== undefined
      ? { output_config: { effort: request.params.reasoningEffort } }
      : {}),
  };
}

function parseAnthropicStreamEvent(event: string | undefined, data: string): SseTextResult {
  let payload: unknown = undefined;
  try {
    payload = JSON.parse(data) as unknown;
  } catch {
    throw new Error("Anthropic stream included malformed JSON");
  }
  if (event === "error") {
    const errorPayload = readAnthropicErrorResponse(payload);
    const detail = errorPayload.error?.message ?? errorPayload.error?.type ?? data;
    throw new Error(`Anthropic stream failed: ${detail}`);
  }
  if (event === "message_stop") {
    return { done: true };
  }
  if (event !== "content_block_delta" || typeof payload !== "object" || payload === null) {
    return {};
  }
  const { delta } = payload as { readonly delta?: unknown };
  if (typeof delta !== "object" || delta === null) {
    return {};
  }
  const typedDelta = delta as { readonly type?: unknown; readonly text?: unknown };
  return typedDelta.type === "text_delta" && typeof typedDelta.text === "string"
    ? { text: typedDelta.text }
    : {};
}

async function buildErrorMessage(response: Response): Promise<string> {
  const status = String(response.status);
  const body = await response.text();

  if (body.trim() === "") {
    return `Anthropic request failed with status ${status}`;
  }

  try {
    const payload = readAnthropicErrorResponse(JSON.parse(body));
    const details = [
      payload.error?.message,
      payload.error?.type !== undefined ? `type=${payload.error.type}` : undefined,
      payload.request_id !== undefined ? `request_id=${payload.request_id}` : undefined,
    ].filter((detail) => detail !== undefined);

    if (details.length > 0) {
      return `Anthropic request failed with status ${status}: ${details.join("; ")}`;
    }
  } catch {
    // Fall through to the raw body for non-JSON provider errors.
  }

  return `Anthropic request failed with status ${status}: ${body}`;
}

export function createAnthropicProvider(
  config: AppConfig,
  fetchImpl: FetchLike = fetch,
): StreamingModelProvider {
  if (config.apiKey === undefined) {
    throw new Error("ANTHROPIC_API_KEY or MARKET_BOT_ANTHROPIC_API_KEY is required");
  }
  const { apiKey } = config;

  return {
    name: "anthropic",
    generateStream: async (request: ModelRequest): Promise<ReadableStream<string>> => {
      if (request.responseFormat === "json") {
        throw new Error("Anthropic streaming does not support JSON response format");
      }
      if (request.webSearch === true) {
        throw new Error("Anthropic streaming does not support web search");
      }

      request.signal?.throwIfAborted();
      const abortController = new AbortController();
      const abortFromRequest = (): void => abortController.abort(request.signal?.reason);
      if (request.signal?.aborted === true) {
        abortFromRequest();
      } else {
        request.signal?.addEventListener("abort", abortFromRequest, { once: true });
      }
      const response = await fetchImpl(`${ANTHROPIC_BASE_URL}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(anthropicRequestBody(request, true)),
        signal: abortController.signal,
      });
      if (!response.ok) {
        const message = await buildErrorMessage(response);
        abortController.abort();
        throw new Error(message);
      }
      if (response.body === null) {
        abortController.abort();
        throw new Error("Anthropic streaming response did not include a body");
      }

      return mapSseEventsToText(decodeServerSentEvents(response.body), {
        providerName: "Anthropic",
        parse: (event) => parseAnthropicStreamEvent(event.event, event.data),
        cancel: () => abortController.abort(),
      });
    },
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      const response = await fetchImpl(`${ANTHROPIC_BASE_URL}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(anthropicRequestBody(request)),
      });

      if (!response.ok) {
        throw new Error(await buildErrorMessage(response));
      }

      const payload = readAnthropicResponse(await response.json());
      const content =
        payload.content
          ?.filter((block) => block.type === "text" && block.text !== undefined)
          .map((block) => block.text)
          .join("") ?? "";

      if (content.trim() === "") {
        throw new Error("Anthropic response did not include content");
      }

      const tokenEstimate =
        payload.usage?.input_tokens !== undefined || payload.usage?.output_tokens !== undefined
          ? (payload.usage.input_tokens ?? 0) + (payload.usage.output_tokens ?? 0)
          : estimateTokens(request.messages);
      const cost = estimateAnthropicCost(
        request.model,
        payload.usage?.input_tokens,
        payload.usage?.output_tokens,
        payload.usage?.server_tool_use?.web_search_requests,
      );

      return {
        content,
        tokenEstimate,
        ...cost,
      };
    },
  };
}
