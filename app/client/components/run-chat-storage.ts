import type { UIMessage } from "@ai-sdk/svelte";

// Per-run chat transcripts live in localStorage, namespaced by run id.
// Persisting them lets a conversation survive reloads and tab switches.
const STORAGE_PREFIX = "market-bot:run-chat:";
const PERSISTABLE_ROLES = new Set(["system", "user", "assistant"]);

export function runChatStorageKey(runId: string): string {
  return `${STORAGE_PREFIX}${runId}`;
}

// Minimal injectable subset of the Web Storage API we depend on.
// Keeps the persistence helpers unit-testable without a DOM.
export interface RunChatStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): RunChatStore | null {
  // Accessing localStorage can throw (private mode, disabled storage).
  // It is also absent outside the browser; fail soft to a null store.
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPart(value: unknown): boolean {
  return isObject(value) && typeof value.type === "string";
}

// Validate at the boundary: only accept entries shaped like the text-only
// UIMessages this chat emits, so a corrupt entry can never crash the Chat.
function isStoredMessage(value: unknown): value is UIMessage {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.role === "string" &&
    PERSISTABLE_ROLES.has(value.role) &&
    Array.isArray(value.parts) &&
    value.parts.every((part) => isPart(part))
  );
}

export function loadRunChatMessages(
  runId: string,
  store: RunChatStore | null = defaultStore(),
): UIMessage[] {
  if (store === null) {
    return [];
  }
  const raw = store.getItem(runChatStorageKey(runId));
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is UIMessage => isStoredMessage(entry));
  } catch {
    return [];
  }
}

export function saveRunChatMessages(
  runId: string,
  messages: readonly UIMessage[],
  store: RunChatStore | null = defaultStore(),
): void {
  if (store === null) {
    return;
  }
  const key = runChatStorageKey(runId);
  try {
    // An empty transcript means "no history", so drop the key entirely.
    // Leaving empty arrays would clutter storage for every run opened.
    if (messages.length === 0) {
      store.removeItem(key);
      return;
    }
    store.setItem(key, JSON.stringify(messages));
  } catch {
    // Quota or serialization failures must not break the chat UI.
  }
}
