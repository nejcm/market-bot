import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config";
import {
  createCodexAppServerStream,
  defaultAppServerSpawn,
  type AppServerSpawnImpl,
} from "./codex-app-server";
import type {
  ModelRequest,
  ModelResponse,
  StreamingModelProvider,
  WebSearchCapability,
} from "./types";

const MIN_CODEX_VERSION = [0, 125, 0] as const;

export interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
}

export type SpawnImpl = (
  args: string[],
  stdin: string,
  options?: SpawnOptions,
) => Promise<SpawnResult>;

interface CodexEvent {
  readonly type?: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly reasoning_output_tokens?: number;
  };
  readonly item?: {
    readonly type?: string;
    readonly text?: string;
  };
}

function parseVersion(raw: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(raw.trim());
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(
  actual: [number, number, number],
  min: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if ((actual[i] ?? 0) > (min[i] ?? 0)) {
      return true;
    }
    if ((actual[i] ?? 0) < (min[i] ?? 0)) {
      return false;
    }
  }
  return true;
}

function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/iu, "")
    .replace(/\n?```\s*$/iu, "")
    .trim();
}

function parseEventStream(jsonl: string): { content: string; tokenEstimate: number } {
  let content = "";
  let tokenEstimate = 0;

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }

    let event: CodexEvent = {};
    try {
      event = JSON.parse(trimmed) as CodexEvent;
    } catch {
      continue;
    }

    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      content = event.item.text ?? "";
    }

    if (event.type === "turn.completed" && event.usage !== undefined) {
      const { input_tokens = 0, output_tokens = 0, reasoning_output_tokens = 0 } = event.usage;
      tokenEstimate = input_tokens + output_tokens + reasoning_output_tokens;
    }
  }

  return { content, tokenEstimate };
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

function codexChildEnv(): Record<string, string | undefined> {
  return {
    PATH: readEnv("PATH"),
    Path: readEnv("Path"),
    PATHEXT: readEnv("PATHEXT"),
    SYSTEMROOT: readEnv("SYSTEMROOT"),
    SystemRoot: readEnv("SystemRoot"),
    WINDIR: readEnv("WINDIR"),
    COMSPEC: readEnv("COMSPEC"),
    HOME: readEnv("HOME"),
    USERPROFILE: readEnv("USERPROFILE"),
    APPDATA: readEnv("APPDATA"),
    LOCALAPPDATA: readEnv("LOCALAPPDATA"),
    CODEX_HOME: readEnv("CODEX_HOME"),
  };
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`Codex request timed out after ${String(timeoutMs)}ms`);
}

function abortError(): Error {
  const error = new Error("Codex request was aborted");
  error.name = "AbortError";
  return error;
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    throw abortError();
  }

  let onAbort: (() => void) | undefined = undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function authStatusUnsupported(result: SpawnResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return output.includes("unrecognized subcommand") && output.includes("status");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: Timer | undefined = undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function defaultSpawn(
  args: string[],
  stdin: string,
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  const proc = Bun.spawn(args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeout: options.timeoutMs, killSignal: "SIGKILL" }
      : {}),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(stdin);
  proc.stdin.end();

  const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout: stdoutBuf, stderr: stderrBuf, exitCode };
}

async function preflight(spawnImpl: SpawnImpl): Promise<void> {
  const versionResult = await spawnImpl(["codex", "--version"], "").catch(() => null);

  if (versionResult === null || versionResult.exitCode !== 0) {
    throw new Error(
      "codex CLI not found on PATH. Install with: npm i -g @openai/codex (requires Node ≥ 22)",
    );
  }

  const parsed = parseVersion(versionResult.stdout + versionResult.stderr);
  if (parsed === null || !versionAtLeast(parsed, MIN_CODEX_VERSION)) {
    const found = parsed !== null ? parsed.join(".") : "unknown";
    throw new Error(
      `codex CLI ${MIN_CODEX_VERSION.join(".")}+ required for gpt-5.5 support, found ${found}. Run: npm i -g @openai/codex`,
    );
  }

  const authResult = await spawnImpl(["codex", "auth", "status"], "").catch(() => null);
  if (authResult === null || authResult.exitCode !== 0) {
    if (authResult !== null && authStatusUnsupported(authResult)) {
      return;
    }
    throw new Error("Not signed into Codex. Run: codex login");
  }
}

async function probeWebSearchCapability(spawnImpl: SpawnImpl): Promise<WebSearchCapability> {
  const result = await spawnImpl(["codex", "--help"], "").catch(() => null);
  if (result === null || result.exitCode !== 0) {
    return { supported: false, reason: "probe-failed" };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  return output.includes("--search")
    ? { supported: true, reason: "supported" }
    : { supported: false, reason: "provider-unsupported" };
}

async function probeAppServerSupport(spawnImpl: SpawnImpl): Promise<boolean> {
  const result = await spawnImpl(["codex", "app-server", "--help"], "").catch(() => null);
  return result !== null && result.exitCode === 0;
}

function buildCodexPrompt(request: ModelRequest): string {
  const systemMessage =
    request.messages.find((message) => message.role === "system")?.content ?? "";
  const userMessages = request.messages.filter((message) => message.role !== "system");
  const userContent = userMessages.map((message) => message.content).join("\n\n");
  const jsonInstruction =
    request.responseFormat === "json"
      ? "\n\nIMPORTANT: Respond with a valid JSON object only. No prose, no markdown, no code fences."
      : "";
  return `${systemMessage}${jsonInstruction}${userContent ? `\n\n${userContent}` : ""}`;
}

export function createCodexProvider(
  config: AppConfig,
  spawnImpl: SpawnImpl = defaultSpawn,
  appServerSpawn: AppServerSpawnImpl = defaultAppServerSpawn,
): StreamingModelProvider {
  const modelMap = new Map<string, string>([
    [config.quickModel, config.codexQuickModel ?? config.quickModel],
    [config.synthesisModel, config.codexSynthesisModel ?? config.synthesisModel],
  ]);

  let preflightDone = false;
  let preflightPromise: Promise<void> | null = null;
  let webSearchCapabilityPromise: Promise<WebSearchCapability> | null = null;
  let appServerSupportPromise: Promise<boolean> | null = null;

  function ensurePreflight(): Promise<void> {
    if (preflightDone) {
      return Promise.resolve();
    }
    if (preflightPromise === null) {
      preflightPromise = preflight(spawnImpl).then(() => {
        preflightDone = true;
      });
    }
    return preflightPromise;
  }

  return {
    name: "codex",
    webSearchCapability: () => {
      webSearchCapabilityPromise ??= probeWebSearchCapability(spawnImpl);
      return webSearchCapabilityPromise;
    },
    generateStream: async (request: ModelRequest): Promise<ReadableStream<string>> => {
      if (request.responseFormat === "json") {
        throw new Error("Codex streaming does not support JSON response format");
      }
      await withAbort(ensurePreflight(), request.signal);
      appServerSupportPromise ??= probeAppServerSupport(spawnImpl);
      if (!(await withAbort(appServerSupportPromise, request.signal))) {
        throw new Error("Codex app-server streaming is unavailable; update the Codex CLI");
      }

      const cwd = await mkdtemp(join(tmpdir(), "market-bot-codex-chat-"));
      const resolvedModel = modelMap.get(request.model) ?? request.model;
      return createCodexAppServerStream({
        cwd,
        env: codexChildEnv(),
        model: resolvedModel,
        prompt: buildCodexPrompt(request),
        ...(request.params?.reasoningEffort !== undefined
          ? { reasoningEffort: request.params.reasoningEffort }
          : {}),
        webSearch: request.webSearch === true,
        timeoutMs: config.modelTimeoutMs,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
        spawn: appServerSpawn,
      });
    },
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      await ensurePreflight();

      const resolvedModel = modelMap.get(request.model) ?? request.model;

      const prompt = buildCodexPrompt(request);

      const args = [
        "codex",
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--sandbox",
        "read-only",
        "--cd",
        await mkdtemp(join(tmpdir(), "market-bot-codex-")),
        "--skip-git-repo-check",
        "-m",
        resolvedModel,
        ...(request.params?.reasoningEffort !== undefined
          ? ["-c", `model_reasoning_effort=${request.params.reasoningEffort}`]
          : []),
        // Enable live web search when explicitly requested (chat path only).
        // Sets live mode so fresh network fetches are used over the default cached snapshot.
        ...(request.webSearch === true
          ? ["-c", "tools.web_search=true", "-c", "web_search=live"]
          : []),
        "-",
      ];

      const timeoutMs = config.modelTimeoutMs;
      const cwdIndex = args.indexOf("--cd") + 1;
      const cwd = args[cwdIndex];
      if (cwd === undefined) {
        throw new Error("Codex exec cwd was not configured");
      }

      let result: SpawnResult = { stdout: "", stderr: "", exitCode: -1 };
      try {
        result = await withTimeout(
          spawnImpl(args, prompt, { cwd, env: codexChildEnv(), timeoutMs }),
          timeoutMs,
        );
      } finally {
        if (cwd !== undefined) {
          await rm(cwd, { recursive: true, force: true }).catch(() => {});
        }
      }

      if (result.exitCode !== 0) {
        const stderr = result.stderr.trim();
        if (stderr.toLowerCase().includes("auth") || stderr.toLowerCase().includes("login")) {
          throw new Error(`Codex session expired. Run: codex login\n${stderr}`);
        }
        throw new Error(`Codex exec failed (exit ${String(result.exitCode)}): ${stderr}`);
      }

      const { content: raw, tokenEstimate } = parseEventStream(result.stdout);

      if (raw === "") {
        throw new Error("Codex response did not include an agent_message");
      }

      const content = request.responseFormat === "json" ? stripFences(raw) : raw;

      const estimate =
        tokenEstimate > 0
          ? tokenEstimate
          : request.messages.reduce((total, m) => total + m.content.length / 4, 0);

      return {
        content,
        tokenEstimate: estimate,
      };
    },
  };
}
