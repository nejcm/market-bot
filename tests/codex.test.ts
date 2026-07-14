import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  type AppServerProcess,
  type AppServerSpawnImpl,
  type AppServerSpawnOptions,
} from "../src/model/codex-app-server";
import { createCodexProvider, type SpawnImpl } from "../src/model/codex";
import type { AppConfig } from "../src/config";

const baseConfig: AppConfig = {
  provider: "codex",
  quickModel: "gpt-5.4-mini",
  synthesisModel: "gpt-5.5",
  modelTimeoutMs: 5000,
  dataDir: "data/runs",
  promptDir: "prompts",
  sourceOptions: {
    equityMoverLimit: 5,
    cryptoMoverLimit: 5,
    newsLimit: 8,
    sourceTimeoutMs: 1000,
  },
  evidenceRequestOptions: {
    maxRounds: 0,
    maxToolCalls: 0,
    sourceBudget: 0,
  },
  webGatherOptions: {
    maxRounds: 0,
    maxToolCalls: 0,
    sourceBudget: 0,
  },
  webGatherDisabled: false,
  webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
  alphaSearchOptions: {
    apeWisdomFilter: "all-stocks",
    apeWisdomBriefPageLimit: 5,
    apeWisdomDeepPageLimit: 10,
    validationCandidateLimit: 25,
    leadLimit: 15,
    topCandidateLimit: 15,
    secDiscoveryLimit: 25,
    secFormTypes: ["S-1", "F-1", "8-K", "6-K"],
    minPrice: 0.5,
    minVolume: 100_000,
    minMarketCap: 50_000_000,
    maxMarketCap: 10_000_000_000,
  },
};

function makeSpawn(overrides: {
  version?: { exitCode: number; stdout: string };
  auth?: { exitCode: number; stderr?: string };
  exec?: { exitCode: number; stdout: string; stderr?: string };
}): SpawnImpl {
  return async (args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    if (args[1] === "--version") {
      const v = overrides.version ?? { exitCode: 0, stdout: "0.125.0" };
      return { stdout: v.stdout, stderr: "", exitCode: v.exitCode };
    }
    if (args[1] === "auth") {
      const a = overrides.auth ?? { exitCode: 0 };
      return { stdout: "", stderr: a.stderr ?? "", exitCode: a.exitCode };
    }
    const e = overrides.exec ?? { exitCode: 0, stdout: "" };
    return { stdout: e.stdout, stderr: e.stderr ?? "", exitCode: e.exitCode };
  };
}

function agentMessageStream(text: string, tokens = 0): string {
  const events = [
    JSON.stringify({ type: "thread.started" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: tokens, output_tokens: tokens, reasoning_output_tokens: 0 },
    }),
  ];
  return `${events.join("\n")}\n`;
}

interface FakeAppServer {
  readonly spawn: AppServerSpawnImpl;
  readonly args: readonly string[];
  readonly options: AppServerSpawnOptions | undefined;
  readonly messages: readonly Record<string, unknown>[];
  readonly killed: boolean;
  emit(message: unknown, splitUtf8?: boolean): void;
  finish(exitCode: number, stderr?: string): void;
}

function fakeAppServer(
  onMessage?: (message: Record<string, unknown>, server: FakeAppServer) => void,
): FakeAppServer {
  const encoder = new TextEncoder();
  const messages: Record<string, unknown>[] = [];
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined = undefined;
  let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined = undefined;
  let resolveExit: ((exitCode: number) => void) | undefined = undefined;
  let args: readonly string[] = [];
  let options: AppServerSpawnOptions | undefined = undefined;
  let killed = false;
  let finished = false;

  const server: FakeAppServer = {
    get args() {
      return args;
    },
    get options() {
      return options;
    },
    get messages() {
      return messages;
    },
    get killed() {
      return killed;
    },
    emit(message: unknown, splitUtf8 = false): void {
      const bytes = encoder.encode(`${JSON.stringify(message)}\n`);
      if (!splitUtf8) {
        stdoutController?.enqueue(bytes);
        return;
      }
      const split = bytes.indexOf(240);
      stdoutController?.enqueue(bytes.slice(0, split + 1));
      stdoutController?.enqueue(bytes.slice(split + 1));
    },
    finish(exitCode: number, stderr = ""): void {
      if (finished) {
        return;
      }
      finished = true;
      if (stderr !== "") {
        stderrController?.enqueue(encoder.encode(stderr));
      }
      stdoutController?.close();
      stderrController?.close();
      resolveExit?.(exitCode);
    },
    spawn(spawnArgs, spawnOptions): AppServerProcess {
      args = spawnArgs;
      options = spawnOptions;
      const stdout = new ReadableStream<Uint8Array>({
        start(controller): void {
          stdoutController = controller;
        },
      });
      const stderr = new ReadableStream<Uint8Array>({
        start(controller): void {
          stderrController = controller;
        },
      });
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      return {
        stdin: {
          write(data): void {
            const message = JSON.parse(data.trim()) as Record<string, unknown>;
            messages.push(message);
            onMessage?.(message, server);
          },
          end(): void {},
        },
        stdout,
        stderr,
        exited,
        kill(): void {
          killed = true;
          server.finish(-1);
        },
      };
    },
  };
  return server;
}

function appServerHandshake(
  message: Record<string, unknown>,
  server: FakeAppServer,
  afterTurnStart?: () => void,
): void {
  const { method } = message;
  if (method === "initialize") {
    server.emit({ id: 0, result: {} });
  } else if (method === "thread/start") {
    server.emit({ id: 1, result: { thread: { id: "thread-1" } } });
  } else if (method === "turn/start") {
    server.emit({ id: 2, result: {} });
    afterTurnStart?.();
  }
}

async function collectText(stream: ReadableStream<string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
  }
  return text;
}

describe("createCodexProvider — preflight", () => {
  test("throws when codex binary is not found", async () => {
    const spawn = makeSpawn({ version: { exitCode: 1, stdout: "" } });
    const provider = createCodexProvider(baseConfig, spawn);
    await expect(
      provider.generate({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("codex CLI not found on PATH");
  });

  test("throws when codex version is too old", async () => {
    const spawn = makeSpawn({ version: { exitCode: 0, stdout: "0.100.0" } });
    const provider = createCodexProvider(baseConfig, spawn);
    await expect(
      provider.generate({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("0.125.0+ required");
  });

  test("throws when not logged in", async () => {
    const spawn = makeSpawn({ auth: { exitCode: 1 } });
    const provider = createCodexProvider(baseConfig, spawn);
    await expect(
      provider.generate({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("Not signed into Codex");
  });

  test("continues when current codex CLI does not support auth status", async () => {
    const spawn = makeSpawn({
      auth: { exitCode: 1, stderr: "error: unrecognized subcommand 'status'" },
      exec: { exitCode: 0, stdout: agentMessageStream("ok") },
    });
    const provider = createCodexProvider(baseConfig, spawn);
    const result = await provider.generate({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe("ok");
  });

  test("runs preflight only once across multiple generate calls", async () => {
    let versionCalls = 0;
    const spawn: SpawnImpl = async (args) => {
      if (args[1] === "--version") {
        versionCalls++;
        return { stdout: "0.125.0", stderr: "", exitCode: 0 };
      }
      if (args[1] === "auth") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: agentMessageStream("ok"), stderr: "", exitCode: 0 };
    };

    const provider = createCodexProvider(baseConfig, spawn);
    await provider.generate({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "a" }] });
    await provider.generate({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "b" }] });
    expect(versionCalls).toBe(1);
  });
});

describe("createCodexProvider — generate", () => {
  test("probes web search capability once from codex help", async () => {
    const calls: string[][] = [];
    const spawn: SpawnImpl = async (args) => {
      calls.push(args);
      if (args[1] === "--help") {
        return { stdout: "Usage: codex exec --search", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const provider = createCodexProvider(baseConfig, spawn);

    expect(provider.webSearchCapability).not.toBeUndefined();
    await expect(provider.webSearchCapability!()).resolves.toEqual({
      supported: true,
      reason: "supported",
    });
    await expect(provider.webSearchCapability!()).resolves.toEqual({
      supported: true,
      reason: "supported",
    });

    expect(calls.filter((args) => args[1] === "--help")).toHaveLength(1);
  });

  test("reports failed web search capability probe", async () => {
    const failure = { stdout: "", stderr: "boom", exitCode: 1 };
    const spawn: SpawnImpl = async () => failure;
    const provider = createCodexProvider(baseConfig, spawn);

    expect(provider.webSearchCapability).not.toBeUndefined();
    await expect(provider.webSearchCapability!()).resolves.toEqual({
      supported: false,
      reason: "probe-failed",
    });
  });

  test("parses agent_message content from event stream", async () => {
    const spawn = makeSpawn({
      exec: { exitCode: 0, stdout: agentMessageStream("hello world", 20) },
    });
    const provider = createCodexProvider(baseConfig, spawn);
    const result = await provider.generate({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "say hello" }],
    });

    expect(result.content).toBe("hello world");
    expect(result.tokenEstimate).toBe(40);
    expect(result.costEstimateUsd).toBeUndefined();
  });

  test("strips JSON fences when responseFormat is json", async () => {
    const raw = '```json\n{"summary":"ok"}\n```';
    const spawn = makeSpawn({ exec: { exitCode: 0, stdout: agentMessageStream(raw) } });
    const provider = createCodexProvider(baseConfig, spawn);
    const result = await provider.generate({
      model: "gpt-5.4-mini",
      responseFormat: "json",
      messages: [{ role: "user", content: "return json" }],
    });

    expect(result.content).toBe('{"summary":"ok"}');
  });

  test("does not strip fences when responseFormat is not json", async () => {
    const raw = '```json\n{"summary":"ok"}\n```';
    const spawn = makeSpawn({ exec: { exitCode: 0, stdout: agentMessageStream(raw) } });
    const provider = createCodexProvider(baseConfig, spawn);
    const result = await provider.generate({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "return something" }],
    });

    expect(result.content).toBe(raw);
  });

  test("throws when response has no agent_message", async () => {
    const emptyStream = `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`;
    const spawn = makeSpawn({ exec: { exitCode: 0, stdout: emptyStream } });
    const provider = createCodexProvider(baseConfig, spawn);
    await expect(
      provider.generate({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("did not include an agent_message");
  });

  test("throws with auth hint when exec fails with auth error", async () => {
    const spawn = makeSpawn({ exec: { exitCode: 1, stdout: "", stderr: "auth token expired" } });
    const provider = createCodexProvider(baseConfig, spawn);
    await expect(
      provider.generate({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("codex login");
  });

  test("throws with exit code when exec fails without auth message", async () => {
    const spawn = makeSpawn({ exec: { exitCode: 2, stdout: "", stderr: "rate limited" } });
    const provider = createCodexProvider(baseConfig, spawn);
    await expect(
      provider.generate({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("exit 2");
  });

  test("applies codex model override for quickModel", async () => {
    const called: string[] = [];
    const spawn: SpawnImpl = async (args) => {
      if (args[1] === "--version") {
        return { stdout: "0.125.0", stderr: "", exitCode: 0 };
      }
      if (args[1] === "auth") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      const mFlag = args.indexOf("-m");
      if (mFlag !== -1) {
        called.push(args[mFlag + 1] ?? "");
      }
      return { stdout: agentMessageStream("ok"), stderr: "", exitCode: 0 };
    };

    const config: AppConfig = { ...baseConfig, codexQuickModel: "gpt-5.4" };
    const provider = createCodexProvider(config, spawn);
    await provider.generate({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(called).toEqual(["gpt-5.4"]);
  });

  test("falls back to heuristic token estimate when usage is missing", async () => {
    const stream =
      `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } })}\n` +
      `${JSON.stringify({ type: "turn.completed" })}\n`;
    const spawn = makeSpawn({ exec: { exitCode: 0, stdout: stream } });
    const provider = createCodexProvider(baseConfig, spawn);
    const result = await provider.generate({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  test("passes prompt via stdin (args do not contain prompt text)", async () => {
    const capturedArgs: string[][] = [];
    const capturedStdin: string[] = [];
    const capturedOptions: Parameters<SpawnImpl>[2][] = [];
    const spawn: SpawnImpl = async (args, stdin, options) => {
      if (args[1] === "--version") {
        return { stdout: "0.125.0", stderr: "", exitCode: 0 };
      }
      if (args[1] === "auth") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      capturedArgs.push(args);
      capturedStdin.push(stdin);
      capturedOptions.push(options);
      return { stdout: agentMessageStream("ok"), stderr: "", exitCode: 0 };
    };

    const provider = createCodexProvider(baseConfig, spawn);
    await provider.generate({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "secret prompt text" }],
    });

    expect(capturedArgs[0]).not.toContain("secret prompt text");
    expect(capturedStdin[0]).toContain("secret prompt text");
    expect(capturedArgs[0]).toContain("-");
    expect(capturedArgs[0]).toContain("--ignore-user-config");
    expect(capturedArgs[0]).toContain("--sandbox");
    expect(capturedArgs[0]).toContain("read-only");
    expect(capturedArgs[0]).toContain("--cd");
    expect(capturedOptions[0]?.cwd).toBe(
      capturedArgs[0]?.[(capturedArgs[0]?.indexOf("--cd") ?? -1) + 1],
    );
    expect(capturedOptions[0]?.timeoutMs).toBe(baseConfig.modelTimeoutMs);
    expect(capturedOptions[0]?.env?.MARKET_BOT_OPENAI_API_KEY).toBeUndefined();
    expect(capturedOptions[0]?.env?.OPENAI_API_KEY).toBeUndefined();
  });

  test("passes reasoningEffort as -c model_reasoning_effort arg", async () => {
    const capturedArgs: string[][] = [];
    const spawn: SpawnImpl = async (args) => {
      if (args[1] === "--version") {
        return { stdout: "0.125.0", stderr: "", exitCode: 0 };
      }
      if (args[1] === "auth") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      capturedArgs.push(args);
      return { stdout: agentMessageStream("ok"), stderr: "", exitCode: 0 };
    };
    const provider = createCodexProvider(baseConfig, spawn);
    await provider.generate({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
      params: { reasoningEffort: "high" },
    });

    const args = capturedArgs[0] ?? [];
    const cIdx = args.indexOf("-c");
    expect(cIdx).toBeGreaterThan(-1);
    expect(args[cIdx + 1]).toBe("model_reasoning_effort=high");
  });

  test("omits -c arg when reasoningEffort is not set", async () => {
    const capturedArgs: string[][] = [];
    const spawn: SpawnImpl = async (args) => {
      if (args[1] === "--version") {
        return { stdout: "0.125.0", stderr: "", exitCode: 0 };
      }
      if (args[1] === "auth") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      capturedArgs.push(args);
      return { stdout: agentMessageStream("ok"), stderr: "", exitCode: 0 };
    };
    const provider = createCodexProvider(baseConfig, spawn);
    await provider.generate({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(capturedArgs[0]).not.toContain("-c");
  });

  test("passes web search config args when webSearch is true", async () => {
    const capturedArgs: string[][] = [];
    const spawn: SpawnImpl = async (args) => {
      if (args[1] === "--version") {
        return { stdout: "0.125.0", stderr: "", exitCode: 0 };
      }
      if (args[1] === "auth") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      capturedArgs.push(args);
      return { stdout: agentMessageStream("ok"), stderr: "", exitCode: 0 };
    };
    const provider = createCodexProvider(baseConfig, spawn);
    await provider.generate({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
      webSearch: true,
    });

    const args = capturedArgs[0] ?? [];
    expect(args).toContain("-c");
    // Must pass both enable flag and live mode.
    const webSearchIdx = args.indexOf("tools.web_search=true");
    expect(webSearchIdx).toBeGreaterThan(-1);
    expect(args[webSearchIdx - 1]).toBe("-c");
    const liveModeIdx = args.indexOf("web_search=live");
    expect(liveModeIdx).toBeGreaterThan(-1);
    expect(args[liveModeIdx - 1]).toBe("-c");
  });

  test("omits web search args when webSearch is false or unset", async () => {
    const capturedArgs: string[][] = [];
    const spawn: SpawnImpl = async (args) => {
      if (args[1] === "--version") {
        return { stdout: "0.125.0", stderr: "", exitCode: 0 };
      }
      if (args[1] === "auth") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      capturedArgs.push(args);
      return { stdout: agentMessageStream("ok"), stderr: "", exitCode: 0 };
    };
    const provider = createCodexProvider(baseConfig, spawn);
    // Explicit false
    await provider.generate({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
      webSearch: false,
    });
    // Unset (undefined)
    await provider.generate({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    for (const args of capturedArgs) {
      expect(args).not.toContain("tools.web_search=true");
      expect(args).not.toContain("web_search=live");
    }
  });

  test("ignores non-reasoningEffort params (temperature etc.) silently", async () => {
    const capturedArgs: string[][] = [];
    const spawn: SpawnImpl = async (args) => {
      if (args[1] === "--version") {
        return { stdout: "0.125.0", stderr: "", exitCode: 0 };
      }
      if (args[1] === "auth") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      capturedArgs.push(args);
      return { stdout: agentMessageStream("ok"), stderr: "", exitCode: 0 };
    };
    const provider = createCodexProvider(baseConfig, spawn);
    await provider.generate({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
      params: { temperature: 0.7, top_p: 0.9, seed: 42 },
    });

    expect(capturedArgs[0]).not.toContain("-c");
    expect(capturedArgs[0]).not.toContain("temperature");
    expect(capturedArgs[0]).not.toContain("0.7");
  });

  test("times out stalled exec calls", async () => {
    const spawn: SpawnImpl = async (args) => {
      if (args[1] === "--version") {
        return { stdout: "0.125.0", stderr: "", exitCode: 0 };
      }
      if (args[1] === "auth") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      return { stdout: agentMessageStream("late"), stderr: "", exitCode: 0 };
    };

    const provider = createCodexProvider({ ...baseConfig, modelTimeoutMs: 1 }, spawn);
    await expect(
      provider.generate({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("timed out");
  });
});

describe("createCodexProvider — generateStream", () => {
  test("performs the app-server handshake and streams final-answer deltas only", async () => {
    const appServer = fakeAppServer((message, server) => {
      appServerHandshake(message, server, () => {
        server.emit({
          method: "item/started",
          params: {
            turnId: "turn-1",
            item: { type: "agentMessage", id: "commentary", phase: "commentary", text: "" },
          },
        });
        server.emit({
          method: "item/agentMessage/delta",
          params: { turnId: "turn-1", itemId: "commentary", delta: "hidden" },
        });
        server.emit({
          method: "item/started",
          params: {
            turnId: "turn-1",
            item: { type: "agentMessage", id: "final", phase: "final_answer", text: "" },
          },
        });
        server.emit({
          method: "item/agentMessage/delta",
          params: { turnId: "turn-1", itemId: "final", delta: "Hello " },
        });
        server.emit(
          {
            method: "item/agentMessage/delta",
            params: { turnId: "turn-1", itemId: "final", delta: "🙂" },
          },
          true,
        );
        server.emit({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: { type: "agentMessage", id: "final", phase: "final_answer", text: "Hello 🙂" },
          },
        });
        server.emit({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        });
      });
    });
    const spawn = makeSpawn({ exec: { exitCode: 0, stdout: "app-server help" } });
    const provider = createCodexProvider(
      { ...baseConfig, codexQuickModel: "gpt-5.4" },
      spawn,
      appServer.spawn,
    );

    const content = await collectText(
      await provider.generateStream({
        model: "gpt-5.4-mini",
        messages: [
          { role: "system", content: "System" },
          { role: "user", content: "Question" },
        ],
        params: { reasoningEffort: "high" },
        webSearch: true,
      }),
    );

    expect(content).toBe("Hello 🙂");
    expect(appServer.messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    const threadStart = appServer.messages[2]?.params as Record<string, unknown>;
    expect(threadStart).toMatchObject({
      model: "gpt-5.4",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      config: { tools: { web_search: true } },
    });
    const turnStart = appServer.messages[3]?.params as Record<string, unknown>;
    expect(turnStart).toMatchObject({
      model: "gpt-5.4",
      effort: "high",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      input: [{ type: "text", text: "System\n\nQuestion", text_elements: [] }],
    });
    expect(appServer.args).toContain("features.shell_tool=false");
    expect(appServer.args).toContain("features.apps=false");
    expect(appServer.args).toContain("features.hooks=false");
    expect(appServer.args).toContain("features.multi_agent=false");
    expect(appServer.args).toContain("features.plugins=false");
    expect(appServer.args).toContain("mcp_servers={}");
    expect(appServer.args).toContain("tools.web_search=true");
    expect(appServer.args).toContain("web_search=live");
    expect(appServer.options?.env.OPENAI_API_KEY).toBeUndefined();
    expect(appServer.killed).toBe(true);
    expect(existsSync(appServer.options?.cwd ?? "")).toBe(false);
  });

  test("falls back to a completed final message when no deltas arrive", async () => {
    const appServer = fakeAppServer((message, server) => {
      appServerHandshake(message, server, () => {
        server.emit({
          method: "item/completed",
          params: {
            item: { type: "agentMessage", id: "final", phase: "final_answer", text: "Fallback" },
          },
        });
        server.emit({
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "completed" } },
        });
      });
    });
    const provider = createCodexProvider(baseConfig, makeSpawn({}), appServer.spawn);

    expect(
      await collectText(
        await provider.generateStream({
          model: "gpt-5.4-mini",
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    ).toBe("Fallback");
  });

  test("kills the process and removes the temporary cwd on cancellation", async () => {
    const appServer = fakeAppServer((message, server) => {
      appServerHandshake(message, server, () => {
        server.emit({
          method: "item/started",
          params: { item: { type: "agentMessage", id: "final", phase: "final_answer" } },
        });
        server.emit({
          method: "item/agentMessage/delta",
          params: { itemId: "final", delta: "partial" },
        });
      });
    });
    const provider = createCodexProvider(baseConfig, makeSpawn({}), appServer.spawn);
    const stream = await provider.generateStream({ model: "gpt-5.4-mini", messages: [] });
    const reader = stream.getReader();

    expect(await reader.read()).toEqual({ done: false, value: "partial" });
    await reader.cancel();

    expect(appServer.killed).toBe(true);
    expect(existsSync(appServer.options?.cwd ?? "")).toBe(false);
  });

  test("surfaces timeout, process failure, and unsupported app-server errors", async () => {
    const stalled = fakeAppServer((message, server) => appServerHandshake(message, server));
    const stalledProvider = createCodexProvider(
      { ...baseConfig, modelTimeoutMs: 1 },
      makeSpawn({}),
      stalled.spawn,
    );
    await expect(
      collectText(await stalledProvider.generateStream({ model: "gpt-5.4-mini", messages: [] })),
    ).rejects.toThrow("timed out");

    const failed = fakeAppServer((message, server) => {
      appServerHandshake(message, server, () => server.finish(3, "boom"));
    });
    const failedProvider = createCodexProvider(baseConfig, makeSpawn({}), failed.spawn);
    await expect(
      collectText(await failedProvider.generateStream({ model: "gpt-5.4-mini", messages: [] })),
    ).rejects.toThrow("exit 3");

    const unsupportedSpawn: SpawnImpl = async (args) => {
      if (args[1] === "--version") {
        return { stdout: "0.125.0", stderr: "", exitCode: 0 };
      }
      if (args[1] === "auth") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[1] === "app-server") {
        return { stdout: "", stderr: "unsupported", exitCode: 1 };
      }
      return { stdout: agentMessageStream("batch still works"), stderr: "", exitCode: 0 };
    };
    const unsupported = createCodexProvider(baseConfig, unsupportedSpawn, failed.spawn);
    await expect(
      unsupported.generateStream({ model: "gpt-5.4-mini", messages: [] }),
    ).rejects.toThrow("app-server streaming is unavailable");
    await expect(
      unsupported.generate({ model: "gpt-5.4-mini", messages: [] }),
    ).resolves.toMatchObject({ content: "batch still works" });
  });

  test("rejects JSON streaming before starting app-server", async () => {
    const appServer = fakeAppServer();
    const provider = createCodexProvider(baseConfig, makeSpawn({}), appServer.spawn);

    await expect(
      provider.generateStream({ model: "gpt-5.4-mini", messages: [], responseFormat: "json" }),
    ).rejects.toThrow("does not support JSON");
    expect(appServer.messages).toHaveLength(0);
  });
});
