import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunChatConfig } from "../src/config";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamingModelProvider,
} from "../src/model/types";
import { handleRunChat, type ReadyChatDeps } from "../app/chat";
import { handleResearchConsoleRequest } from "../app/server";
import { researchReport } from "./support/fixtures";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function textStream(text: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller): void {
      controller.enqueue(text);
      controller.close();
    },
  });
}

const generateStub: Pick<ModelProvider, "generate"> = {
  generate: async (): Promise<ModelResponse> => ({ content: "unused", tokenEstimate: 0 }),
};

function fakeProvider(responseText = "Model response"): StreamingModelProvider {
  return {
    name: "fake",
    ...generateStub,
    generateStream: async (): Promise<ReadableStream<string>> => textStream(responseText),
  };
}

function defaultChatConfig(overrides: Partial<RunChatConfig> = {}): RunChatConfig {
  return {
    disabled: false,
    model: "test-model",
    contextBudgetChars: 96_000,
    maxOutputTokens: 1500,
    historyTurnCap: 20,
    webSearch: false,
    ...overrides,
  };
}

function chatDeps(dataDir: string, overrides: Partial<ReadyChatDeps> = {}): ReadyChatDeps {
  return {
    status: "ready",
    provider: fakeProvider(),
    chatConfig: defaultChatConfig(),
    dataDir,
    ...overrides,
  };
}

function chatRequest(
  runId: string,
  messages: readonly { role: string; content: string }[],
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Request {
  return new Request(`http://127.0.0.1/api/runs/${encodeURIComponent(runId)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ messages }),
    ...(signal !== undefined ? { signal } : {}),
  });
}

function setupRunDir(dataDir: string, runId: string): void {
  const runDir = join(dataDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "report.json"), researchReport({ runId, summary: "Test run summary" }));
  writeFileSync(join(runDir, "report.md"), "# Test Report\n\nSome findings.\n", "utf8");
}

describe("chat endpoint", () => {
  test("happy path returns provider text as plain text body", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));
    setupRunDir(dataDir, "run-chat-1");

    const request = chatRequest("run-chat-1", [
      { role: "user", content: "What is this run about?" },
    ]);
    const url = new URL(request.url);
    const response = await handleRunChat(request, url, chatDeps(dataDir));

    expect(response).not.toBeUndefined();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response!.text()).toBe("Model response");
  });

  test("exposes streamed chunks before provider completion", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-stream-"));
    setupRunDir(dataDir, "run-stream");
    const streamState: { controller?: ReadableStreamDefaultController<string> } = {};
    const provider: StreamingModelProvider = {
      name: "streaming",
      ...generateStub,
      generateStream: async () =>
        new ReadableStream<string>({
          start(streamController): void {
            streamState.controller = streamController;
            streamController.enqueue("first ");
          },
        }),
    };
    const request = chatRequest("run-stream", [{ role: "user", content: "test" }]);
    const response = await handleRunChat(
      request,
      new URL(request.url),
      chatDeps(dataDir, { provider }),
    );
    const reader = response!.body!.getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first ");
    streamState.controller?.enqueue("second");
    streamState.controller?.close();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("second");
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  test("propagates mid-stream failures and response cancellation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-stream-error-"));
    setupRunDir(dataDir, "run-stream-error");
    let cancelled = false;
    const failureState: { controller?: ReadableStreamDefaultController<string> } = {};
    const failingProvider: StreamingModelProvider = {
      name: "streaming",
      ...generateStub,
      generateStream: async () =>
        new ReadableStream<string>({
          start(controller): void {
            failureState.controller = controller;
            controller.enqueue("partial");
          },
          cancel(): void {
            cancelled = true;
          },
        }),
    };
    const request = chatRequest("run-stream-error", [{ role: "user", content: "test" }]);
    const response = await handleRunChat(
      request,
      new URL(request.url),
      chatDeps(dataDir, { provider: failingProvider }),
    );
    const reader = response!.body!.getReader();

    const partial = await reader.read();
    expect(new TextDecoder().decode(partial.value)).toBe("partial");
    failureState.controller?.error(new Error("mid-stream failure"));
    await expect(reader.read()).rejects.toThrow("mid-stream failure");

    const cancellableProvider: StreamingModelProvider = {
      name: "streaming",
      ...generateStub,
      generateStream: async () =>
        new ReadableStream<string>({
          start(controller): void {
            controller.enqueue("partial");
          },
          cancel(): void {
            cancelled = true;
          },
        }),
    };
    const cancelRequest = chatRequest("run-stream-error", [{ role: "user", content: "test" }]);
    const cancellableResponse = await handleRunChat(
      cancelRequest,
      new URL(cancelRequest.url),
      chatDeps(dataDir, { provider: cancellableProvider }),
    );
    await cancellableResponse!.body!.cancel();
    expect(cancelled).toBe(true);
  });

  test("propagates request cancellation during stream negotiation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-negotiation-cancel-"));
    setupRunDir(dataDir, "run-negotiation-cancel");
    const requestController = new AbortController();
    const providerState: { signal?: AbortSignal } = {};
    let signalReadyResolve: (() => void) | null = null;
    const signalReady = new Promise<void>((resolve) => {
      signalReadyResolve = resolve;
    });
    const provider: StreamingModelProvider = {
      name: "streaming",
      ...generateStub,
      generateStream: async (modelRequest) => {
        if (modelRequest.signal !== undefined) {
          providerState.signal = modelRequest.signal;
        }
        signalReadyResolve?.();
        return new Promise<ReadableStream<string>>((_, reject) => {
          if (modelRequest.signal?.aborted === true) {
            reject(new Error("negotiation aborted"));
            return;
          }
          modelRequest.signal?.addEventListener(
            "abort",
            () => reject(new Error("negotiation aborted")),
            { once: true },
          );
        });
      },
    };
    const request = chatRequest(
      "run-negotiation-cancel",
      [{ role: "user", content: "test" }],
      {},
      requestController.signal,
    );
    const responsePromise = handleRunChat(
      request,
      new URL(request.url),
      chatDeps(dataDir, { provider }),
    );

    await signalReady;
    requestController.abort();
    const response = await responsePromise;

    expect(providerState.signal?.aborted).toBe(true);
    expect(response?.status).toBe(502);
    expect(await response?.text()).toContain("negotiation aborted");
  });

  test("same-origin guard rejects cross-site requests", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));
    setupRunDir(dataDir, "run-guard");

    const request = chatRequest("run-guard", [{ role: "user", content: "test" }], {
      "sec-fetch-site": "cross-site",
    });
    const url = new URL(request.url);
    const response = await handleRunChat(request, url, chatDeps(dataDir));

    expect(response).not.toBeUndefined();
    expect(response!.status).toBe(403);
    expect(await response!.text()).toBe("Chat request origin is not allowed");
  });

  test("allows same-origin Fetch Metadata even when the proxy origin host differs", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));
    setupRunDir(dataDir, "run-proxy");

    // Dev proxy: the client is served on a different port than the API, so the
    // Origin host never matches the request host. Fetch Metadata is authoritative.
    const request = chatRequest("run-proxy", [{ role: "user", content: "test" }], {
      "sec-fetch-site": "same-origin",
      origin: "http://localhost:5173",
    });
    const url = new URL(request.url);
    const response = await handleRunChat(request, url, chatDeps(dataDir));

    expect(response).not.toBeUndefined();
    expect(response!.status).toBe(200);
  });

  test("returns 404 for unknown run", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));

    const request = chatRequest("nonexistent", [{ role: "user", content: "test" }]);
    const url = new URL(request.url);
    const response = await handleRunChat(request, url, chatDeps(dataDir));

    expect(response).not.toBeUndefined();
    expect(response!.status).toBe(404);
    expect(await response!.text()).toBe("Run not found");
  });

  test("returns 503 when chat is disabled", async () => {
    const request = chatRequest("run-disabled", [{ role: "user", content: "test" }]);
    const url = new URL(request.url);
    const response = await handleRunChat(request, url, {
      status: "unavailable",
      reason: "Run chat is disabled",
    });

    expect(response).not.toBeUndefined();
    expect(response!.status).toBe(503);
    expect(await response!.text()).toBe("Run chat is disabled");
  });

  test("returns 400 for empty messages", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));
    setupRunDir(dataDir, "run-empty");

    const request = chatRequest("run-empty", []);
    const url = new URL(request.url);
    const response = await handleRunChat(request, url, chatDeps(dataDir));

    expect(response).not.toBeUndefined();
    expect(response!.status).toBe(400);
    expect(await response!.text()).toBe("No messages provided");
  });

  test("returns 400 for invalid JSON body", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));
    setupRunDir(dataDir, "run-badjson");

    const request = new Request("http://127.0.0.1/api/runs/run-badjson/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const url = new URL(request.url);
    const response = await handleRunChat(request, url, chatDeps(dataDir));

    expect(response).not.toBeUndefined();
    expect(response!.status).toBe(400);
    expect(await response!.text()).toBe("Request body must be JSON");
  });

  test("caps history to historyTurnCap", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));
    setupRunDir(dataDir, "run-cap");

    let capturedMessages: readonly { role: string; content: string }[] = [];
    const capturingProvider: StreamingModelProvider = {
      name: "capture",
      ...generateStub,
      generateStream: async (request) => {
        capturedMessages = request.messages;
        return textStream("ok");
      },
    };

    const messages = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${String(index)}`,
    }));

    const request = chatRequest("run-cap", messages);
    const url = new URL(request.url);
    await handleRunChat(
      request,
      url,
      chatDeps(dataDir, {
        provider: capturingProvider,
        chatConfig: defaultChatConfig({ historyTurnCap: 4 }),
      }),
    );

    // System message + last 4 history messages
    expect(capturedMessages.length).toBe(5);
    expect(capturedMessages[0]!.role).toBe("system");
    expect(capturedMessages[1]!.content).toBe("message 6");
    expect(capturedMessages[4]!.content).toBe("message 9");
  });

  test("maps multi-part content to flat text", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));
    setupRunDir(dataDir, "run-parts");

    let capturedMessages: readonly { role: string; content: string }[] = [];
    const capturingProvider: StreamingModelProvider = {
      name: "capture",
      ...generateStub,
      generateStream: async (request) => {
        capturedMessages = request.messages;
        return textStream("ok");
      },
    };

    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    ];

    const request = new Request("http://127.0.0.1/api/runs/run-parts/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    const url = new URL(request.url);
    await handleRunChat(request, url, chatDeps(dataDir, { provider: capturingProvider }));

    // System + 1 user message
    expect(capturedMessages.length).toBe(2);
    expect(capturedMessages[1]!.content).toBe("Hello world");
  });

  test("maps AI SDK v6 message parts to flat text", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));
    setupRunDir(dataDir, "run-v6-parts");

    let capturedMessages: readonly { role: string; content: string }[] = [];
    const capturingProvider: StreamingModelProvider = {
      name: "capture",
      ...generateStub,
      generateStream: async (request) => {
        capturedMessages = request.messages;
        return textStream("ok");
      },
    };

    // AI SDK v6 UIMessages carry text in `parts`, not `content`.
    const messages = [
      {
        role: "user",
        parts: [
          { type: "text", text: "Summarize " },
          { type: "text", text: "this run" },
        ],
      },
    ];

    const request = new Request("http://127.0.0.1/api/runs/run-v6-parts/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    const url = new URL(request.url);
    const response = await handleRunChat(
      request,
      url,
      chatDeps(dataDir, { provider: capturingProvider }),
    );

    expect(response!.status).toBe(200);
    expect(capturedMessages.length).toBe(2);
    expect(capturedMessages[1]!.content).toBe("Summarize this run");
  });

  test("returns 503 when no provider is configured", async () => {
    const request = chatRequest("run-unavailable", [{ role: "user", content: "test" }]);
    const url = new URL(request.url);
    const response = await handleRunChat(request, url, {
      status: "unavailable",
      reason: "Run chat is unavailable: no model provider is configured",
    });

    expect(response).not.toBeUndefined();
    expect(response!.status).toBe(503);
    expect(await response!.text()).toBe("Run chat is unavailable: no model provider is configured");
  });

  test("returns undefined for non-chat routes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));

    const request = new Request("http://127.0.0.1/api/runs", { method: "GET" });
    const url = new URL(request.url);
    const response = await handleRunChat(request, url, chatDeps(dataDir));

    expect(response).toBeUndefined();
  });

  test("returns 502 when provider stream negotiation fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));
    setupRunDir(dataDir, "run-fail");

    const failingProvider: StreamingModelProvider = {
      name: "failing",
      ...generateStub,
      generateStream: async () => {
        throw new Error("Provider unavailable");
      },
    };

    const request = chatRequest("run-fail", [{ role: "user", content: "test" }]);
    const url = new URL(request.url);
    const response = await handleRunChat(
      request,
      url,
      chatDeps(dataDir, { provider: failingProvider }),
    );

    expect(response).not.toBeUndefined();
    expect(response!.status).toBe(502);
    expect(await response!.text()).toContain("Provider unavailable");
  });

  test("enables web search on codex provider when chatConfig.webSearch is true", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-ws-"));
    setupRunDir(dataDir, "run-ws-codex");

    const captured = { webSearch: false as boolean | undefined, systemContent: "" };
    const codexProvider: StreamingModelProvider = {
      name: "codex",
      ...generateStub,
      webSearchCapability: async () => ({ supported: true, reason: "supported" }),
      generateStream: async (req: ModelRequest): Promise<ReadableStream<string>> => {
        captured.webSearch = req.webSearch;
        captured.systemContent = req.messages[0]?.content ?? "";
        return textStream("searched");
      },
    };

    const request = chatRequest("run-ws-codex", [{ role: "user", content: "latest news?" }]);
    const url = new URL(request.url);
    await handleRunChat(
      request,
      url,
      chatDeps(dataDir, {
        provider: codexProvider,
        chatConfig: defaultChatConfig({ webSearch: true }),
      }),
    );

    expect(captured.webSearch).toBe(true);
    expect(captured.systemContent).toContain("Web search");
    expect(captured.systemContent).toContain("live web lookup");
  });

  test("does not enable web search on codex provider when capability probe fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-ws-"));
    setupRunDir(dataDir, "run-ws-codex-probe-fail");

    const captured = { webSearch: false as boolean | undefined, systemContent: "" };
    const codexProvider: StreamingModelProvider = {
      name: "codex",
      ...generateStub,
      webSearchCapability: async () => ({ supported: false, reason: "probe-failed" }),
      generateStream: async (req: ModelRequest): Promise<ReadableStream<string>> => {
        captured.webSearch = req.webSearch;
        captured.systemContent = req.messages[0]?.content ?? "";
        return textStream("no search");
      },
    };

    const request = chatRequest("run-ws-codex-probe-fail", [
      { role: "user", content: "latest news?" },
    ]);
    const url = new URL(request.url);
    await handleRunChat(
      request,
      url,
      chatDeps(dataDir, {
        provider: codexProvider,
        chatConfig: defaultChatConfig({ webSearch: true }),
      }),
    );

    expect(captured.webSearch).toBeFalsy();
    expect(captured.systemContent).not.toContain("Web search");
  });

  test("does not enable web search on openai provider when chatConfig.webSearch is true", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-ws-"));
    setupRunDir(dataDir, "run-ws-openai");

    const captured = { webSearch: false as boolean | undefined, systemContent: "" };
    const openaiProvider: StreamingModelProvider = {
      name: "openai",
      ...generateStub,
      generateStream: async (req: ModelRequest): Promise<ReadableStream<string>> => {
        captured.webSearch = req.webSearch;
        captured.systemContent = req.messages[0]?.content ?? "";
        return textStream("no search");
      },
    };

    const request = chatRequest("run-ws-openai", [{ role: "user", content: "latest news?" }]);
    const url = new URL(request.url);
    await handleRunChat(
      request,
      url,
      chatDeps(dataDir, {
        provider: openaiProvider,
        chatConfig: defaultChatConfig({ webSearch: true }),
      }),
    );

    expect(captured.webSearch).toBeFalsy();
    expect(captured.systemContent).not.toContain("Web search");
  });

  test("does not enable web search on anthropic provider when chatConfig.webSearch is true", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-ws-"));
    setupRunDir(dataDir, "run-ws-anthropic");

    const captured = { webSearch: false as boolean | undefined, systemContent: "" };
    const anthropicProvider: StreamingModelProvider = {
      name: "anthropic",
      ...generateStub,
      generateStream: async (req: ModelRequest): Promise<ReadableStream<string>> => {
        captured.webSearch = req.webSearch;
        captured.systemContent = req.messages[0]?.content ?? "";
        return textStream("no search");
      },
    };

    const request = chatRequest("run-ws-anthropic", [{ role: "user", content: "latest news?" }]);
    const url = new URL(request.url);
    await handleRunChat(
      request,
      url,
      chatDeps(dataDir, {
        provider: anthropicProvider,
        chatConfig: defaultChatConfig({ webSearch: true }),
      }),
    );

    expect(captured.webSearch).toBeFalsy();
    expect(captured.systemContent).not.toContain("Web search");
  });

  test("does not enable web search on openai-compatible provider", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-ws-"));
    setupRunDir(dataDir, "run-ws-compatible");

    const captured = { webSearch: false as boolean | undefined, systemContent: "" };
    const compatibleProvider: StreamingModelProvider = {
      name: "openai-compatible",
      ...generateStub,
      generateStream: async (req: ModelRequest): Promise<ReadableStream<string>> => {
        captured.webSearch = req.webSearch;
        captured.systemContent = req.messages[0]?.content ?? "";
        return textStream("no search");
      },
    };

    const request = chatRequest("run-ws-compatible", [{ role: "user", content: "latest news?" }]);
    const url = new URL(request.url);
    await handleRunChat(
      request,
      url,
      chatDeps(dataDir, {
        provider: compatibleProvider,
        chatConfig: defaultChatConfig({ webSearch: true }),
      }),
    );

    expect(captured.webSearch).toBeFalsy();
    expect(captured.systemContent).not.toContain("Web search");
  });

  test("does not enable web search when chatConfig.webSearch is false", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-ws-"));
    setupRunDir(dataDir, "run-ws-off");

    const captured = { webSearch: false as boolean | undefined, systemContent: "" };
    const codexProvider: StreamingModelProvider = {
      name: "codex",
      ...generateStub,
      generateStream: async (req: ModelRequest): Promise<ReadableStream<string>> => {
        captured.webSearch = req.webSearch;
        captured.systemContent = req.messages[0]?.content ?? "";
        return textStream("no search");
      },
    };

    const request = chatRequest("run-ws-off", [{ role: "user", content: "hi" }]);
    const url = new URL(request.url);
    await handleRunChat(
      request,
      url,
      chatDeps(dataDir, {
        provider: codexProvider,
        chatConfig: defaultChatConfig({ webSearch: false }),
      }),
    );

    expect(captured.webSearch).toBeFalsy();
    expect(captured.systemContent).not.toContain("Web search");
  });

  test("reports active search capability for configured supported codex", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-cap-"));
    const codexProvider: StreamingModelProvider = {
      name: "codex",
      ...generateStub,
      webSearchCapability: async () => ({ supported: true, reason: "supported" }),
      generateStream: async () => textStream("ok"),
    };

    const request = new Request("http://127.0.0.1/api/runs/run-cap/chat/search-capability");
    const response = await handleRunChat(
      request,
      new URL(request.url),
      chatDeps(dataDir, {
        provider: codexProvider,
        chatConfig: defaultChatConfig({ webSearch: true }),
      }),
    );

    expect(response).not.toBeUndefined();
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({
      configured: true,
      supported: true,
      effective: true,
      reason: "active",
    });
  });
});

describe("chat endpoint integration via handleResearchConsoleRequest", () => {
  test("chat is accessible through the main request handler", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-integration-"));
    setupRunDir(dataDir, "run-int");

    const deps = chatDeps(dataDir);
    const request = chatRequest("run-int", [{ role: "user", content: "summarize" }]);
    const response = await handleResearchConsoleRequest(request, { dataDir, chatDeps: deps });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Model response");
  });
});
