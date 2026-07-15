import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodexAppServerStream,
  removeWorkingDirectory,
  type AppServerProcess,
  type AppServerSpawnImpl,
} from "../src/model/codex-app-server";

interface TestServer {
  readonly spawn: AppServerSpawnImpl;
  readonly killed: boolean;
  readonly cwdExistedWhenProcessExited: boolean;
}

function testServer(
  afterTurnStart: (emit: (message: unknown) => void, emitRaw: (text: string) => void) => void,
  exitDelayMs = 0,
  stallBeforeInitialize = false,
): TestServer {
  const encoder = new TextEncoder();
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined = undefined;
  let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined = undefined;
  let resolveExit: ((code: number) => void) | undefined = undefined;
  let killed = false;
  let cwd = "";
  let cwdExistedWhenProcessExited = false;

  const emitRaw = (text: string): void => stdoutController?.enqueue(encoder.encode(text));
  const emit = (message: unknown): void => emitRaw(`${JSON.stringify(message)}\n`);
  const finish = (): void => {
    cwdExistedWhenProcessExited = existsSync(cwd);
    stdoutController?.close();
    stderrController?.close();
    resolveExit?.(-1);
  };

  return {
    get killed() {
      return killed;
    },
    get cwdExistedWhenProcessExited() {
      return cwdExistedWhenProcessExited;
    },
    spawn(_args, options): AppServerProcess {
      ({ cwd } = options);
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
            const message = JSON.parse(data.trim()) as { method?: string };
            if (message.method === "initialize") {
              if (!stallBeforeInitialize) {
                emit({ id: 0, result: {} });
              }
            } else if (message.method === "thread/start") {
              emit({ id: 1, result: { thread: { id: "thread-1" } } });
            } else if (message.method === "turn/start") {
              emit({ id: 2, result: { turn: { id: "turn-1" } } });
              afterTurnStart(emit, emitRaw);
            }
          },
          end(): void {},
        },
        stdout,
        stderr,
        exited,
        kill(): void {
          if (killed) {
            return;
          }
          killed = true;
          setTimeout(finish, exitDelayMs);
        },
      };
    },
  };
}

function streamOptions(cwd: string, spawn: AppServerSpawnImpl, signal?: AbortSignal) {
  return {
    cwd,
    env: {},
    model: "gpt-5.4-mini",
    prompt: "test",
    webSearch: false,
    timeoutMs: 5000,
    spawn,
    ...(signal !== undefined ? { signal } : {}),
  };
}

async function collectText(stream: ReadableStream<string>): Promise<string> {
  let result = "";
  for await (const chunk of stream) {
    result += chunk;
  }
  return result;
}

describe("Codex app-server stream hardening", () => {
  test("retries transient Windows directory locks beyond the initial attempts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codex-busy-cleanup-"));
    let attempts = 0;

    await removeWorkingDirectory(cwd, async () => {
      attempts++;
      if (attempts <= 3) {
        throw Object.assign(new Error("directory is busy"), { code: "EBUSY" });
      }
      rmSync(cwd, { recursive: true, force: true });
    });

    expect(attempts).toBe(4);
    expect(existsSync(cwd)).toBe(false);
  });

  test("rejects oversized complete JSONL frames and cleans up", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codex-oversized-jsonl-"));
    const server = testServer((_emit, emitRaw) => {
      emitRaw(`${JSON.stringify({ padding: "x".repeat(1_048_577) })}\n`);
    });

    await expect(
      collectText(await createCodexAppServerStream(streamOptions(cwd, server.spawn))),
    ).rejects.toThrow("maximum buffer size");
    expect(server.killed).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  test("waits for process exit before removing the working directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codex-delayed-exit-"));
    const server = testServer((emit) => {
      emit({
        method: "item/started",
        params: { item: { type: "agentMessage", id: "final", phase: "final_answer" } },
      });
      emit({
        method: "item/agentMessage/delta",
        params: { itemId: "final", delta: "done" },
      });
      emit({
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
    }, 25);

    expect(
      await collectText(await createCodexAppServerStream(streamOptions(cwd, server.spawn))),
    ).toBe("done");
    expect(server.cwdExistedWhenProcessExited).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  test("aborts a pending handshake and removes the working directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codex-aborted-handshake-"));
    const controller = new AbortController();
    const server = testServer(() => {}, 0, true);
    const pending = createCodexAppServerStream(streamOptions(cwd, server.spawn, controller.signal));

    await Bun.sleep(0);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(server.killed).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });
});
