import { describe, expect, test } from "bun:test";
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
  researchGatherOptions: {
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
  webProfileReuseDays: 30,
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
    expect(result.costEstimateUsd).toBe(0);
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
