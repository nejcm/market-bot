import type { UIMessage } from "@ai-sdk/svelte";

// Per-run chat transcripts live in localStorage, namespaced by run id.
// Persisting them lets a conversation survive reloads and tab switches.
const STORAGE_PREFIX = "market-bot:run-chat:";
// Companion recency index, stored separately from the transcripts.
// RunChatStore cannot enumerate keys, so `{ runId: updatedAt }` lives here.
export const RUN_CHAT_INDEX_KEY = "market-bot:run-chat-index";
// Current persisted schema version; bumped only on a breaking shape change.
const SCHEMA_VERSION = 1;
// Cap on how many run transcripts we keep; oldest beyond this are evicted.
export const MAX_PERSISTED_RUNS = 25;
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

export interface SaveOptions {
  // Injectable clock keeps stamping and eviction deterministic in tests.
  readonly now?: number;
  // Injectable cap keeps eviction tests small.
  readonly maxRuns?: number;
}

// Versioned envelope wrapping the transcript.
// Versioning leaves room to migrate a future UIMessage shape change.
interface StoredEnvelope {
  readonly v: number;
  readonly updatedAt: number;
  readonly messages: readonly UIMessage[];
}

// Recency map of run id to last-write timestamp, used to evict the LRU run.
type RunChatIndex = Record<string, number>;

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
// Extra fields (e.g. metadata.createdAt) are tolerated and preserved.
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

// Accept both the legacy bare array (v0) and the versioned envelope (v1+).
function extractStoredMessages(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (isObject(parsed) && Array.isArray(parsed.messages)) {
    return parsed.messages;
  }
  return [];
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
    return extractStoredMessages(parsed).filter((entry): entry is UIMessage =>
      isStoredMessage(entry),
    );
  } catch {
    return [];
  }
}

// Stamp a creation time on messages that lack one, immutably.
// Persisted as metadata.createdAt so it round-trips for recency display.
function stampCreatedAt(messages: readonly UIMessage[], now: number): UIMessage[] {
  return messages.map((message) => {
    const metadata = isObject(message.metadata) ? message.metadata : undefined;
    if (metadata !== undefined && typeof metadata.createdAt === "number") {
      return message;
    }
    return { ...message, metadata: { ...metadata, createdAt: now } };
  });
}

function loadIndex(store: RunChatStore): RunChatIndex {
  const raw = store.getItem(RUN_CHAT_INDEX_KEY);
  if (raw === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) {
      return {};
    }
    const index: RunChatIndex = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number") {
        index[key] = value;
      }
    }
    return index;
  } catch {
    return {};
  }
}

function saveIndex(store: RunChatStore, index: RunChatIndex): void {
  try {
    if (Object.keys(index).length === 0) {
      store.removeItem(RUN_CHAT_INDEX_KEY);
      return;
    }
    store.setItem(RUN_CHAT_INDEX_KEY, JSON.stringify(index));
  } catch {
    // Index is best-effort; a failure here must not break the chat.
  }
}

function withoutRun(index: RunChatIndex, runId: string): RunChatIndex {
  const { [runId]: _removed, ...rest } = index;
  return rest;
}

function oldestOtherRun(index: RunChatIndex, runId: string): string | undefined {
  let oldestId: string | undefined = undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [id, updatedAt] of Object.entries(index)) {
    if (id !== runId && updatedAt < oldestAt) {
      oldestAt = updatedAt;
      oldestId = id;
    }
  }
  return oldestId;
}

// Prune least-recently-used runs beyond the cap (never the current run).
function capRuns(
  store: RunChatStore,
  index: RunChatIndex,
  runId: string,
  maxRuns: number,
): RunChatIndex {
  let working = index;
  while (Object.keys(working).length > maxRuns) {
    const victim = oldestOtherRun(working, runId);
    if (victim === undefined) {
      break;
    }
    try {
      store.removeItem(runChatStorageKey(victim));
    } catch {
      // Ignore; still drop it from the index so the cap converges.
    }
    working = withoutRun(working, victim);
  }
  return working;
}

function trySet(store: RunChatStore, key: string, value: string): boolean {
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function saveRunChatMessages(
  runId: string,
  messages: readonly UIMessage[],
  store: RunChatStore | null = defaultStore(),
  options: SaveOptions = {},
): void {
  if (store === null) {
    return;
  }
  const now = options.now ?? Date.now();
  const maxRuns = options.maxRuns ?? MAX_PERSISTED_RUNS;
  const key = runChatStorageKey(runId);
  const index = loadIndex(store);

  // An empty transcript means "no history".
  // Drop both the data key and its index entry so empty runs free their slot.
  if (messages.length === 0) {
    try {
      store.removeItem(key);
    } catch {
      // Quota/serialization failures must not break the chat UI.
    }
    saveIndex(store, withoutRun(index, runId));
    return;
  }

  const envelope: StoredEnvelope = {
    v: SCHEMA_VERSION,
    updatedAt: now,
    messages: stampCreatedAt(messages, now),
  };
  const serialized = JSON.stringify(envelope);

  let working = capRuns(store, { ...index, [runId]: now }, runId, maxRuns);
  if (trySet(store, key, serialized)) {
    saveIndex(store, working);
    return;
  }

  // Quota exceeded: evict the oldest other run and retry until it fits.
  let victim = oldestOtherRun(working, runId);
  while (victim !== undefined) {
    try {
      store.removeItem(runChatStorageKey(victim));
    } catch {
      // Ignore; drop from the index regardless.
    }
    working = withoutRun(working, victim);
    if (trySet(store, key, serialized)) {
      saveIndex(store, working);
      return;
    }
    victim = oldestOtherRun(working, runId);
  }
  // Could not persist even on its own; keep the index consistent and give up.
  saveIndex(store, working);
}
