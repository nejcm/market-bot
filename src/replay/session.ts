import { AsyncLocalStorage } from "node:async_hooks";

export interface ReplayState {
  readonly values: Record<
    string,
    { readonly value?: unknown; readonly error?: string; readonly count?: number }[]
  >;
}

export interface ReplaySession {
  readonly mode: "record" | "replay" | "offline";
  readonly state: ReplayState;
  readonly failures: string[];
  readonly indexes: Map<string, number>;
  readonly offline: boolean;
  readonly checkpoint?: (input: unknown) => void;
  readonly redact?: (text: string) => string;
}

const sessions = new AsyncLocalStorage<ReplaySession>();

export function withReplaySession<T>(session: ReplaySession, run: () => T): T {
  return sessions.run(session, run);
}

export function isOfflineReplay(): boolean {
  return sessions.getStore()?.offline === true;
}

export function isReplayingState(): boolean {
  return sessions.getStore()?.mode === "replay";
}

export function usesReplayState(): boolean {
  const mode = sessions.getStore()?.mode;
  return mode === "record" || mode === "replay";
}

export function assertReplayStateComplete(): void {
  const session = sessions.getStore();
  if (session?.mode === "replay" && session.failures.length > 0) {
    throw new Error(`Replay state incomplete: ${session.failures.join("; ")}`);
  }
}

export function captureSynthesisInput(input: unknown): void {
  const session = sessions.getStore();
  if (session?.mode !== "record") {
    return;
  }
  try {
    session.checkpoint?.(input);
  } catch {
    session.failures.push("Final-synthesis input capture failed");
  }
}

function recordedValue<T>(session: ReplaySession, key: string): T {
  const index = session.indexes.get(key) ?? 0;
  let remaining = index;
  const entry = session.state.values[key]?.find((row) => {
    const count = row.count ?? 1;
    if (!Number.isSafeInteger(count) || count < 1) {
      session.failures.push(`Invalid replay state count: ${key}`);
      throw new Error(session.failures.at(-1));
    }
    if (remaining < count) {
      return true;
    }
    remaining -= count;
    return false;
  });
  if (entry === undefined) {
    session.failures.push(`Replay state miss: ${key} invocation ${String(index + 1)}`);
    throw new Error(session.failures.at(-1));
  }
  session.indexes.set(key, index + 1);
  if (entry.error !== undefined) {
    throw new Error(entry.error);
  }
  return structuredClone(entry.value) as T;
}

export function replayValueSync<T>(key: string, read: () => T): T {
  const session = sessions.getStore();
  if (session === undefined || session.mode === "offline") {
    return read();
  }
  if (session.mode === "replay") {
    return recordedValue<T>(session, key);
  }
  const value = read();
  try {
    const recorded = JSON.parse(
      session.redact?.(JSON.stringify({ value })) ?? JSON.stringify({ value }),
    );
    const entries = (session.state.values[key] ??= []);
    const previous = entries.at(-1);
    if (
      previous !== undefined &&
      previous.error === undefined &&
      JSON.stringify(previous.value) === JSON.stringify(recorded.value)
    ) {
      entries[entries.length - 1] = { ...previous, count: (previous.count ?? 1) + 1 };
    } else {
      entries.push(recorded);
    }
  } catch {
    session.failures.push(`State capture failed: ${key}`);
  }
  return value;
}

export async function replayValue<T>(key: string, read: () => Promise<T>): Promise<T> {
  const session = sessions.getStore();
  if (session === undefined || session.mode === "offline") {
    return read();
  }
  if (session.mode === "replay") {
    return recordedValue<T>(session, key);
  }
  const entries = (session.state.values[key] ??= []);
  const index = entries.length;
  entries.push({});
  const value = await read().catch((error: unknown) => {
    entries[index] = {
      error:
        session.redact?.(error instanceof Error ? error.message : String(error)) ??
        "State read failed",
    };
    throw error;
  });
  try {
    entries[index] = JSON.parse(
      session.redact?.(JSON.stringify({ value })) ?? JSON.stringify({ value }),
    );
  } catch {
    session.failures.push(`State capture failed: ${key}`);
  }
  return value;
}
