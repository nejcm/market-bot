import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunChatConfig } from "../src/config";
import type { ModelMessage, ModelProvider } from "../src/model/types";
import { readRunDetail } from "./artifacts";
import { buildRunChatContext } from "./chat-context";
import { isSameOriginPost } from "./server";

const SYSTEM_PROMPT_PATH = join(import.meta.dir, "../prompts/console-run-chat.md");

interface UIMessage {
  readonly role: string;
  // AI SDK v6 UIMessages carry text in `parts`; hand-crafted/legacy payloads may use `content`.
  readonly parts?: unknown;
  readonly content?: unknown;
}

interface ChatRequestBody {
  readonly id?: string;
  readonly messages?: readonly UIMessage[];
}

type RunChatSearchCapabilityReason =
  | "provider-unsupported"
  | "probe-failed"
  | "codex-search-unsupported"
  | "disabled-by-server-policy"
  | "active";

export interface RunChatSearchCapability {
  readonly configured: boolean;
  readonly supported: boolean;
  readonly effective: boolean;
  readonly reason: RunChatSearchCapabilityReason;
}

export interface ReadyChatDeps {
  readonly status: "ready";
  readonly provider: ModelProvider;
  readonly chatConfig: RunChatConfig;
  readonly dataDir: string;
  readonly systemPromptPath?: string;
}

// The route is matched but returns 503 with this reason (e.g. disabled, or no provider configured).
export interface UnavailableChatDeps {
  readonly status: "unavailable";
  readonly reason: string;
}

export type ChatEndpointDeps = ReadyChatDeps | UnavailableChatDeps;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatRequestBody(value: unknown): value is ChatRequestBody {
  if (!isRecord(value)) {
    return false;
  }
  if (value.messages !== undefined && !Array.isArray(value.messages)) {
    return false;
  }
  return true;
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function flattenTextParts(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (isRecord(part) && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function extractMessageText(message: UIMessage): string {
  // Prefer AI SDK v6 `parts`; fall back to `content` for hand-crafted/legacy payloads.
  if (Array.isArray(message.parts)) {
    return flattenTextParts(message.parts);
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return flattenTextParts(message.content);
  }
  return "";
}

function mapUIMessages(messages: readonly UIMessage[], cap: number): readonly ModelMessage[] {
  const mapped: ModelMessage[] = [];

  for (const message of messages) {
    const { role } = message;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const content = extractMessageText(message);
    if (content.trim() === "") {
      continue;
    }

    mapped.push({ role, content });
  }

  return mapped.length > cap ? mapped.slice(mapped.length - cap) : mapped;
}

async function loadSystemPrompt(promptPath: string): Promise<string> {
  try {
    return await readFile(promptPath, "utf8");
  } catch {
    return "You are an analyst answering questions about a research run's artifacts. Be accurate and grounded in the data.";
  }
}

// Appended to the system prompt only when live web search is active (codex only).
// Web findings are ephemeral conversational context — not persisted Sources/Evidence.
const WEB_SEARCH_GUIDANCE = `
# Web search

You have access to live web search. Use it **only** when the run artifacts above do not contain sufficient information to answer the question. Prefer artifact-grounded answers at all times.

When you do consult the web:
- Cite the URL and title of each source inline (e.g. "According to [Title](URL), ...").
- Make clear when a claim comes from a live web lookup rather than the run's artifacts.
- Web findings are ephemeral context for this conversation only — they are not persisted research Sources and do not affect scored predictions or evidence quality.`.trimStart();

export async function runChatSearchCapability(
  deps: ChatEndpointDeps,
): Promise<RunChatSearchCapability> {
  if (deps.status === "unavailable") {
    return {
      configured: false,
      supported: false,
      effective: false,
      reason: "provider-unsupported",
    };
  }

  if (!deps.chatConfig.webSearch) {
    return {
      configured: false,
      supported: false,
      effective: false,
      reason: "disabled-by-server-policy",
    };
  }

  if (deps.provider.name !== "codex" || deps.provider.webSearchCapability === undefined) {
    return {
      configured: true,
      supported: false,
      effective: false,
      reason: "provider-unsupported",
    };
  }

  const capability = await deps.provider
    .webSearchCapability()
    .catch(() => ({ supported: false, reason: "probe-failed" as const }));
  if (!capability.supported) {
    return {
      configured: true,
      supported: false,
      effective: false,
      reason: capability.reason === "probe-failed" ? "probe-failed" : "codex-search-unsupported",
    };
  }

  return {
    configured: true,
    supported: true,
    effective: true,
    reason: "active",
  };
}

export async function handleRunChat(
  request: Request,
  url: URL,
  deps: ChatEndpointDeps,
): Promise<Response | undefined> {
  const chatMatch = /^\/api\/runs\/([^/]+)\/chat$/u.exec(url.pathname);
  const searchCapabilityMatch = /^\/api\/runs\/([^/]+)\/chat\/search-capability$/u.exec(
    url.pathname,
  );
  if (searchCapabilityMatch !== null && request.method === "GET") {
    return jsonResponse(await runChatSearchCapability(deps));
  }

  if (chatMatch === null || request.method !== "POST") {
    return undefined;
  }

  if (!isSameOriginPost(request, url)) {
    return textResponse("Chat request origin is not allowed", 403);
  }

  if (deps.status === "unavailable") {
    return textResponse(deps.reason, 503);
  }

  const runId = decodeURIComponent(chatMatch[1] ?? "");
  if (runId === "") {
    return textResponse("Invalid run id", 400);
  }

  let body: unknown = undefined;
  try {
    body = await request.json();
  } catch {
    return textResponse("Request body must be JSON", 400);
  }

  if (!isChatRequestBody(body)) {
    return textResponse("Invalid chat request body", 400);
  }

  const uiMessages = body.messages ?? [];
  const history = mapUIMessages(uiMessages, deps.chatConfig.historyTurnCap);
  if (history.length === 0) {
    return textResponse("No messages provided", 400);
  }

  const detail = await readRunDetail(deps.dataDir, runId);
  if (detail === undefined) {
    return textResponse("Run not found", 404);
  }

  const systemPrompt = await loadSystemPrompt(deps.systemPromptPath ?? SYSTEM_PROMPT_PATH);
  const contextBlock = buildRunChatContext(detail, deps.chatConfig.contextBudgetChars);
  const systemContent =
    contextBlock.trim() !== ""
      ? `${systemPrompt}\n\n# Run artifacts\n\n${contextBlock}`
      : systemPrompt;

  const searchCapability = await runChatSearchCapability(deps);
  const webSearchActive = searchCapability.effective;
  const finalSystemContent = webSearchActive
    ? `${systemContent}\n\n${WEB_SEARCH_GUIDANCE}`
    : systemContent;

  const model = deps.chatConfig.model ?? deps.provider.name;
  const messages: ModelMessage[] = [{ role: "system", content: finalSystemContent }, ...history];

  try {
    const response = await deps.provider.generate({
      model,
      messages,
      webSearch: webSearchActive,
      params: { max_completion_tokens: deps.chatConfig.maxOutputTokens },
    });

    return textResponse(response.content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return textResponse(`Chat generation failed: ${message}`, 502);
  }
}
