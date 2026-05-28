import type { AppConfig } from "../config";
import type { ModelProvider, ModelRequest, ModelResponse } from "./types";

const MIN_CODEX_VERSION = [0, 125, 0] as const;

export interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type SpawnImpl = (args: string[], stdin: string) => Promise<SpawnResult>;

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

async function defaultSpawn(args: string[], stdin: string): Promise<SpawnResult> {
  const proc = Bun.spawn(args, {
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
    throw new Error("Not signed into Codex. Run: codex login");
  }
}

export function createCodexProvider(
  config: AppConfig,
  spawnImpl: SpawnImpl = defaultSpawn,
): ModelProvider {
  const modelMap = new Map<string, string>([
    [config.quickModel, config.codexQuickModel ?? config.quickModel],
    [config.synthesisModel, config.codexSynthesisModel ?? config.synthesisModel],
  ]);

  let preflightDone = false;
  let preflightPromise: Promise<void> | null = null;

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
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      await ensurePreflight();

      const resolvedModel = modelMap.get(request.model) ?? request.model;

      const systemMessage = request.messages.find((m) => m.role === "system")?.content ?? "";
      const userMessages = request.messages.filter((m) => m.role !== "system");
      const userContent = userMessages.map((m) => m.content).join("\n\n");

      const jsonInstruction =
        request.responseFormat === "json"
          ? "\n\nIMPORTANT: Respond with a valid JSON object only. No prose, no markdown, no code fences."
          : "";

      const prompt = `${systemMessage}${jsonInstruction}${userContent ? `\n\n${userContent}` : ""}`;

      const args = [
        "codex",
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "-m",
        resolvedModel,
        "-",
      ];

      const timeoutMs = config.modelTimeoutMs;
      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
      }, timeoutMs);

      let result: SpawnResult = { stdout: "", stderr: "", exitCode: -1 };
      try {
        result = await spawnImpl(args, prompt);
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (timedOut) {
        throw new Error(`Codex request timed out after ${String(timeoutMs)}ms`);
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
        costEstimateUsd: 0,
      };
    },
  };
}
