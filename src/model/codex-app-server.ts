import { rm } from "node:fs/promises";

const MAX_JSONL_BUFFER_CHARS = 1_048_576;
const WORKING_DIRECTORY_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1000] as const;

export interface AppServerProcess {
  readonly stdin: {
    write(data: string): unknown;
    end(): unknown;
  };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface AppServerSpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

export type AppServerSpawnImpl = (
  args: readonly string[],
  options: AppServerSpawnOptions,
) => AppServerProcess;

export interface CodexAppServerStreamOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly model: string;
  readonly prompt: string;
  readonly reasoningEffort?: "low" | "medium" | "high";
  readonly webSearch: boolean;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly spawn: AppServerSpawnImpl;
}

interface JsonRpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly params?: unknown;
}

class JsonLineReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async read(): Promise<JsonRpcMessage | undefined> {
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline !== -1) {
        if (newline > MAX_JSONL_BUFFER_CHARS) {
          throw new Error("Codex app-server frame exceeded the maximum buffer size");
        }
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line === "") {
          continue;
        }
        return parseMessage(line);
      }

      // oxlint-disable-next-line no-await-in-loop -- JSONL messages are ordered protocol input.
      const next = await this.#reader.read();
      if (next.done) {
        this.#buffer += this.#decoder.decode();
        if (this.#buffer.length > MAX_JSONL_BUFFER_CHARS) {
          throw new Error("Codex app-server frame exceeded the maximum buffer size");
        }
        const line = this.#buffer.trim();
        this.#buffer = "";
        return line === "" ? undefined : parseMessage(line);
      }
      this.#buffer += this.#decoder.decode(next.value, { stream: true });
      if (this.#buffer.length > MAX_JSONL_BUFFER_CHARS && !this.#buffer.includes("\n")) {
        throw new Error("Codex app-server frame exceeded the maximum buffer size");
      }
    }
  }

  async cancel(reason?: unknown): Promise<void> {
    await this.#reader.cancel(reason).catch(() => {});
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessage(line: string): JsonRpcMessage {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value)) {
      throw new Error("JSONL message must be an object");
    }
    return value;
  } catch {
    throw new Error("Codex app-server emitted malformed JSON");
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function errorDetail(value: unknown): string {
  if (!isRecord(value)) {
    return String(value);
  }
  return readString(value, "message") ?? JSON.stringify(value);
}

function appServerArgs(webSearch: boolean): readonly string[] {
  const disabledFeatures = [
    "apps",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "code_mode_host",
    "computer_use",
    "goals",
    "hooks",
    "image_generation",
    "in_app_browser",
    "multi_agent",
    "plugins",
    "remote_plugin",
    "shell_snapshot",
    "shell_tool",
    "skill_mcp_dependency_install",
    "tool_suggest",
    "unified_exec",
    "workspace_dependencies",
  ];
  return [
    "codex",
    "app-server",
    "--stdio",
    ...disabledFeatures.flatMap((feature) => ["-c", `features.${feature}=false`]),
    "-c",
    "mcp_servers={}",
    "-c",
    `tools.web_search=${String(webSearch)}`,
    "-c",
    `web_search=${webSearch ? "live" : "disabled"}`,
  ];
}

function abortError(): Error {
  const error = new Error("Codex request was aborted");
  error.name = "AbortError";
  return error;
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function waitForProcessExit(process: AppServerProcess): Promise<void> {
  let timer: Timer | undefined = undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 1000);
  });
  await Promise.race([process.exited.then(() => {}), timeout]).catch(() => {});
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

function isTransientRemovalError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return ["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"].includes(
    readString(error, "code") ?? "",
  );
}

export async function removeWorkingDirectory(
  cwd: string,
  removeImpl: typeof rm = rm,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Retries handle transient Windows file locks.
      await removeImpl(cwd, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      const delayMs = WORKING_DIRECTORY_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isTransientRemovalError(error)) {
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop -- Backoff is intentionally sequential.
      await Bun.sleep(delayMs);
    }
  }
}

export function defaultAppServerSpawn(
  args: readonly string[],
  options: AppServerSpawnOptions,
): AppServerProcess {
  return Bun.spawn([...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function spawnAppServer(options: CodexAppServerStreamOptions): Promise<AppServerProcess> {
  try {
    return options.spawn(appServerArgs(options.webSearch), {
      cwd: options.cwd,
      env: options.env,
    });
  } catch (error: unknown) {
    await rm(options.cwd, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function createCodexAppServerStream(
  options: CodexAppServerStreamOptions,
): Promise<ReadableStream<string>> {
  if (signalIsAborted(options.signal)) {
    await removeWorkingDirectory(options.cwd);
    throw abortError();
  }
  const process = await spawnAppServer(options);
  const stdout = new JsonLineReader(process.stdout);
  const stderrPromise = new Response(process.stderr).text();
  const pending: JsonRpcMessage[] = [];
  let timedOut = false;
  let cleanupPromise: Promise<void> | null = null;
  let turnId = "";
  let resolveAbort: (() => void) | undefined = undefined;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  let abortListener: (() => void) | undefined = undefined;

  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      process.kill("SIGKILL");
    } catch {}
  }, options.timeoutMs);

  const cleanup = async (kill: boolean): Promise<void> => {
    if (cleanupPromise !== null) {
      return cleanupPromise;
    }
    cleanupPromise = (async () => {
      clearTimeout(timeout);
      if (abortListener !== undefined) {
        options.signal?.removeEventListener("abort", abortListener);
      }
      if (kill) {
        try {
          process.kill("SIGKILL");
        } catch {}
      }
      try {
        process.stdin.end();
      } catch {}
      if (kill) {
        await waitForProcessExit(process);
      }
      await stdout.cancel().catch(() => {});
      await removeWorkingDirectory(options.cwd);
    })();
    return cleanupPromise;
  };

  abortListener = (): void => {
    resolveAbort?.();
    void cleanup(true).catch(() => {});
  };
  options.signal?.addEventListener("abort", abortListener, { once: true });
  if (signalIsAborted(options.signal)) {
    abortListener();
  }

  const readNext = async (): Promise<JsonRpcMessage> => {
    const result = await Promise.race([
      stdout.read().then((message) => ({ type: "message" as const, message })),
      aborted.then(() => ({ type: "aborted" as const })),
    ]);
    if (result.type === "aborted") {
      throw abortError();
    }
    const { message } = result;
    if (message !== undefined) {
      return message;
    }
    const exitCode = await process.exited;
    const stderrText = await stderrPromise;
    const stderr = stderrText.trim();
    if (timedOut) {
      throw new Error(`Codex request timed out after ${String(options.timeoutMs)}ms`);
    }
    throw new Error(
      `Codex app-server exited before turn completion (exit ${String(exitCode)}): ${stderr}`,
    );
  };

  const send = (message: unknown): void => {
    process.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const waitForResponse = async (id: number): Promise<unknown> => {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Handshake responses are ordered protocol input.
      const message = await readNext();
      if (message.id !== id) {
        pending.push(message);
        continue;
      }
      if (message.error !== undefined) {
        throw new Error(`Codex app-server request failed: ${errorDetail(message.error)}`);
      }
      return message.result;
    }
  };

  try {
    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: { name: "market_bot", title: "Market Bot", version: "0.1.1" },
      },
    });
    await waitForResponse(0);
    send({ method: "initialized", params: {} });
    send({
      method: "thread/start",
      id: 1,
      params: {
        model: options.model,
        cwd: options.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        config: {
          web_search: options.webSearch ? "live" : "disabled",
          mcp_servers: {},
          tools: { web_search: options.webSearch },
          features: {
            apps: false,
            hooks: false,
            multi_agent: false,
            plugins: false,
            remote_plugin: false,
            shell_tool: false,
            unified_exec: false,
          },
        },
      },
    });
    const threadResult = await waitForResponse(1);
    if (!isRecord(threadResult) || !isRecord(threadResult.thread)) {
      throw new Error("Codex app-server thread/start response did not include a thread");
    }
    const threadId = readString(threadResult.thread, "id");
    if (threadId === undefined || threadId === "") {
      throw new Error("Codex app-server thread/start response did not include a thread id");
    }

    send({
      method: "turn/start",
      id: 2,
      params: {
        threadId,
        input: [{ type: "text", text: options.prompt, text_elements: [] }],
        cwd: options.cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        model: options.model,
        ...(options.reasoningEffort !== undefined ? { effort: options.reasoningEffort } : {}),
      },
    });
    const turnResult = await waitForResponse(2);
    if (isRecord(turnResult) && isRecord(turnResult.turn)) {
      turnId = readString(turnResult.turn, "id") ?? "";
    }

    const finalItemIds = new Set<string>();
    const commentaryItemIds = new Set<string>();
    let fallback = "";
    let emitted = false;
    let finished = false;

    const handleMessage = async (
      message: JsonRpcMessage,
      controller: ReadableStreamDefaultController<string>,
    ): Promise<boolean> => {
      if (message.error !== undefined) {
        throw new Error(`Codex app-server protocol error: ${errorDetail(message.error)}`);
      }
      const { params } = message;
      if (!isRecord(params)) {
        return false;
      }
      const messageTurnId = readString(params, "turnId");
      if (turnId !== "" && messageTurnId !== undefined && messageTurnId !== turnId) {
        return false;
      }

      if (message.method === "item/started" || message.method === "item/completed") {
        const { item } = params;
        if (!isRecord(item) || item.type !== "agentMessage") {
          return false;
        }
        const itemId = readString(item, "id");
        const phase = readString(item, "phase");
        if (itemId === undefined) {
          return false;
        }
        if (phase === "commentary") {
          commentaryItemIds.add(itemId);
          finalItemIds.delete(itemId);
          return false;
        }
        finalItemIds.add(itemId);
        if (message.method === "item/completed") {
          const text = readString(item, "text");
          if (text !== undefined && text !== "") {
            fallback = text;
          }
        }
        return false;
      }

      if (message.method === "item/agentMessage/delta") {
        const itemId = readString(params, "itemId");
        const delta = readString(params, "delta");
        if (
          itemId !== undefined &&
          delta !== undefined &&
          delta !== "" &&
          finalItemIds.has(itemId) &&
          !commentaryItemIds.has(itemId)
        ) {
          emitted = true;
          controller.enqueue(delta);
          return true;
        }
        return false;
      }

      if (message.method !== "turn/completed") {
        if (message.method === "error") {
          throw new Error(`Codex app-server error: ${errorDetail(params)}`);
        }
        return false;
      }
      if (!isRecord(params.turn)) {
        throw new Error("Codex app-server turn/completed did not include a turn");
      }
      const status = readString(params.turn, "status");
      if (status !== "completed") {
        const detail = isRecord(params.turn.error)
          ? readString(params.turn.error, "message")
          : undefined;
        throw new Error(
          `Codex app-server turn ${status ?? "failed"}: ${detail ?? "unknown error"}`,
        );
      }
      finished = true;
      if (!emitted && fallback !== "") {
        emitted = true;
        controller.enqueue(fallback);
      }
      if (!emitted) {
        throw new Error("Codex stream did not include a final agent message");
      }
      await cleanup(true);
      controller.close();
      return true;
    };

    return new ReadableStream<string>({
      async pull(controller): Promise<void> {
        if (finished) {
          return;
        }
        try {
          // oxlint-disable-next-line no-unmodified-loop-condition -- Protocol handlers set finished.
          while (!finished) {
            // oxlint-disable-next-line no-await-in-loop -- Notifications are ordered protocol input.
            const message = pending.shift() ?? (await readNext());
            // oxlint-disable-next-line no-await-in-loop -- Each notification is handled before the next.
            if (await handleMessage(message, controller)) {
              return;
            }
          }
        } catch (error: unknown) {
          finished = true;
          await cleanup(true).catch(() => {});
          controller.error(error);
        }
      },
      async cancel(): Promise<void> {
        finished = true;
        await cleanup(true);
      },
    });
  } catch (error: unknown) {
    await cleanup(true).catch(() => {});
    throw error;
  }
}
