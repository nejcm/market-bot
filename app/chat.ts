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
  readonly content: unknown;
}

interface ChatRequestBody {
  readonly id?: string;
  readonly messages?: readonly UIMessage[];
}

export interface ChatEndpointDeps {
  readonly provider: ModelProvider;
  readonly chatConfig: RunChatConfig;
  readonly dataDir: string;
  readonly systemPromptPath?: string;
}

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

function flattenMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
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

  return "";
}

function mapUIMessages(messages: readonly UIMessage[], cap: number): readonly ModelMessage[] {
  const mapped: ModelMessage[] = [];

  for (const message of messages) {
    const { role } = message;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const content = flattenMessageContent(message.content);
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

export async function handleRunChat(
  request: Request,
  url: URL,
  deps: ChatEndpointDeps,
): Promise<Response | undefined> {
  const chatMatch = /^\/api\/runs\/([^/]+)\/chat$/u.exec(url.pathname);
  if (chatMatch === null || request.method !== "POST") {
    return undefined;
  }

  if (!isSameOriginPost(request, url)) {
    return textResponse("Chat request origin is not allowed", 403);
  }

  if (deps.chatConfig.disabled) {
    return textResponse("Run chat is disabled", 503);
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

  const model = deps.chatConfig.model ?? deps.provider.name;
  const messages: ModelMessage[] = [{ role: "system", content: systemContent }, ...history];

  try {
    const response = await deps.provider.generate({
      model,
      messages,
      params: { max_completion_tokens: deps.chatConfig.maxOutputTokens },
    });

    return textResponse(response.content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return textResponse(`Chat generation failed: ${message}`, 502);
  }
}
