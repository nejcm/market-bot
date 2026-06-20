import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunChatConfig } from "../src/config";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/model/types";
import { handleRunChat, type ChatEndpointDeps } from "../app/chat";
import { handleResearchConsoleRequest } from "../app/server";
import { researchReport } from "./support/fixtures";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fakeProvider(responseText = "Model response"): ModelProvider {
  return {
    name: "fake",
    generate: async (_request: ModelRequest): Promise<ModelResponse> => ({
      content: responseText,
      tokenEstimate: 100,
      costEstimateUsd: 0,
    }),
  };
}

function defaultChatConfig(overrides: Partial<RunChatConfig> = {}): RunChatConfig {
  return {
    disabled: false,
    model: "test-model",
    contextBudgetChars: 96_000,
    maxOutputTokens: 1500,
    historyTurnCap: 20,
    ...overrides,
  };
}

function chatDeps(dataDir: string, overrides: Partial<ChatEndpointDeps> = {}): ChatEndpointDeps {
  return {
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
): Request {
  return new Request(`http://127.0.0.1/api/runs/${encodeURIComponent(runId)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ messages }),
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
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));
    setupRunDir(dataDir, "run-disabled");

    const request = chatRequest("run-disabled", [{ role: "user", content: "test" }]);
    const url = new URL(request.url);
    const response = await handleRunChat(
      request,
      url,
      chatDeps(dataDir, { chatConfig: defaultChatConfig({ disabled: true }) }),
    );

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
    const capturingProvider: ModelProvider = {
      name: "capture",
      generate: async (request) => {
        capturedMessages = request.messages;
        return { content: "ok", tokenEstimate: 10, costEstimateUsd: 0 };
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
    const capturingProvider: ModelProvider = {
      name: "capture",
      generate: async (request) => {
        capturedMessages = request.messages;
        return { content: "ok", tokenEstimate: 10, costEstimateUsd: 0 };
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
    const capturingProvider: ModelProvider = {
      name: "capture",
      generate: async (request) => {
        capturedMessages = request.messages;
        return { content: "ok", tokenEstimate: 10, costEstimateUsd: 0 };
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
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));
    setupRunDir(dataDir, "run-unavailable");

    const request = chatRequest("run-unavailable", [{ role: "user", content: "test" }]);
    const url = new URL(request.url);
    const response = await handleRunChat(
      request,
      url,
      chatDeps(dataDir, {
        unavailableReason: "Run chat is unavailable: no model provider is configured",
      }),
    );

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

  test("returns 502 when provider generate fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));
    setupRunDir(dataDir, "run-fail");

    const failingProvider: ModelProvider = {
      name: "failing",
      generate: async () => {
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
