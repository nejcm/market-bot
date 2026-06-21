import { describe, expect, test } from "bun:test";
import type { UIMessage } from "@ai-sdk/svelte";
import {
  loadRunChatMessages,
  MAX_PERSISTED_RUNS,
  RUN_CHAT_INDEX_KEY,
  runChatStorageKey,
  saveRunChatMessages,
  stampRunChatMessages,
  type RunChatStore,
} from "../app/client/components/run-chat-storage";

interface MemoryStore extends RunChatStore {
  readonly entries: Map<string, string>;
}

function memoryStore(initial: Record<string, string> = {}): MemoryStore {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

// A store whose setItem throws QuotaExceededError once it holds `limit` keys.
// Mimics the browser's localStorage quota for eviction tests.
function quotaStore(limit: number): MemoryStore {
  const base = memoryStore();
  const dataKeyCount = (): number =>
    [...base.entries.keys()].filter((key) => key !== RUN_CHAT_INDEX_KEY).length;
  return {
    entries: base.entries,
    getItem: (key) => base.getItem(key),
    removeItem: (key) => base.removeItem(key),
    setItem: (key, value) => {
      const isNewDataKey = key !== RUN_CHAT_INDEX_KEY && !base.entries.has(key);
      if (isNewDataKey && dataKeyCount() >= limit) {
        throw new DOMException("quota", "QuotaExceededError");
      }
      base.setItem(key, value);
    },
  };
}

function textMessage(id: string, role: "user" | "assistant", text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] } as UIMessage;
}

function createdAtOf(message: UIMessage): unknown {
  const { metadata } = message;
  return typeof metadata === "object" && metadata !== null
    ? (metadata as Record<string, unknown>).createdAt
    : undefined;
}

describe("run chat storage", () => {
  test("namespaces the storage key by run id", () => {
    expect(runChatStorageKey("run-42")).toBe("market-bot:run-chat:run-42");
  });

  test("round-trips messages for a run", () => {
    const store = memoryStore();
    const messages = [
      textMessage("m1", "user", "What is the bull case?"),
      textMessage("m2", "assistant", "The bull case rests on margin expansion."),
    ];

    saveRunChatMessages("run-1", messages, store, { now: 1 });

    const loaded = loadRunChatMessages("run-1", store);
    expect(loaded.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(loaded.map((m) => m.parts)).toEqual(messages.map((m) => m.parts));
  });

  test("keeps transcripts isolated per run", () => {
    const store = memoryStore();
    saveRunChatMessages("run-a", [textMessage("a1", "user", "hi from a")], store);
    saveRunChatMessages("run-b", [textMessage("b1", "user", "hi from b")], store);

    expect(loadRunChatMessages("run-a", store).map((m) => m.id)).toEqual(["a1"]);
    expect(loadRunChatMessages("run-b", store).map((m) => m.id)).toEqual(["b1"]);
  });

  test("returns an empty array when no history exists", () => {
    expect(loadRunChatMessages("missing", memoryStore())).toEqual([]);
  });

  test("removes the data key and index entry when saving an empty transcript", () => {
    const store = memoryStore();
    saveRunChatMessages("run-1", [textMessage("m1", "user", "hello")], store);
    saveRunChatMessages("run-1", [], store);

    expect(store.entries.has(runChatStorageKey("run-1"))).toBe(false);
    expect(store.entries.has(RUN_CHAT_INDEX_KEY)).toBe(false);
    expect(loadRunChatMessages("run-1", store)).toEqual([]);
  });

  test("ignores corrupt JSON", () => {
    const store = memoryStore({ [runChatStorageKey("run-1")]: "{not json" });
    expect(loadRunChatMessages("run-1", store)).toEqual([]);
  });

  test("drops entries that are not message-shaped", () => {
    const valid = textMessage("m1", "user", "kept");
    const store = memoryStore({
      [runChatStorageKey("run-1")]: JSON.stringify({
        v: 1,
        updatedAt: 1,
        messages: [
          valid,
          { id: "m2", role: "user" },
          { id: "m3", role: "tool", parts: [] },
          { role: "assistant", parts: [] },
          "nope",
        ],
      }),
    });

    expect(loadRunChatMessages("run-1", store).map((m) => m.id)).toEqual(["m1"]);
  });

  test("returns an empty array when storage is unavailable", () => {
    expect(loadRunChatMessages("run-1", null)).toEqual([]);
  });

  test("saving is a no-op when storage is unavailable", () => {
    expect(() =>
      saveRunChatMessages("run-1", [textMessage("m1", "user", "x")], null),
    ).not.toThrow();
  });

  describe("schema envelope", () => {
    test("persists a versioned envelope", () => {
      const store = memoryStore();
      saveRunChatMessages("run-1", [textMessage("m1", "user", "hi")], store, { now: 7 });

      const raw = store.entries.get(runChatStorageKey("run-1")) ?? "";
      const parsed = JSON.parse(raw);
      expect(parsed.v).toBe(1);
      expect(parsed.updatedAt).toBe(7);
      expect(Array.isArray(parsed.messages)).toBe(true);
    });

    test("loads legacy v0 bare arrays for back-compat", () => {
      const legacy = [textMessage("m1", "user", "from before")];
      const store = memoryStore({
        [runChatStorageKey("run-1")]: JSON.stringify(legacy),
      });

      expect(loadRunChatMessages("run-1", store).map((m) => m.id)).toEqual(["m1"]);
    });
  });

  describe("createdAt metadata", () => {
    test("stamps createdAt on save and preserves it on reload", () => {
      const store = memoryStore();
      saveRunChatMessages("run-1", [textMessage("m1", "user", "hi")], store, { now: 123 });

      const [loaded] = loadRunChatMessages("run-1", store);
      expect(createdAtOf(loaded as UIMessage)).toBe(123);
    });

    test("does not overwrite an existing createdAt", () => {
      const store = memoryStore();
      const message = {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        metadata: { createdAt: 100 },
      } as unknown as UIMessage;

      saveRunChatMessages("run-1", [message], store, { now: 999 });

      const [loaded] = loadRunChatMessages("run-1", store);
      expect(createdAtOf(loaded as UIMessage)).toBe(100);
    });

    test("preserves user send time and stamps assistant completion time", () => {
      const store = memoryStore();
      const userMessage = {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        metadata: { createdAt: 10 },
      } as unknown as UIMessage;
      const assistantMessage = textMessage("m2", "assistant", "hello");

      const stamped = stampRunChatMessages([userMessage, assistantMessage], 20);
      saveRunChatMessages("run-1", stamped, store, { now: 30 });

      const loaded = loadRunChatMessages("run-1", store);
      expect(loaded.map((message) => createdAtOf(message))).toEqual([10, 20]);
    });

    test("returns the same array when all messages already have createdAt", () => {
      const messages = [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
          metadata: { createdAt: 10 },
        },
      ] as unknown as UIMessage[];

      expect(stampRunChatMessages(messages, 20)).toBe(messages);
    });
  });

  describe("recency cap and quota eviction", () => {
    test("evicts least-recently-used runs beyond the cap", () => {
      const store = memoryStore();
      saveRunChatMessages("run-a", [textMessage("a1", "user", "a")], store, {
        now: 1,
        maxRuns: 2,
      });
      saveRunChatMessages("run-b", [textMessage("b1", "user", "b")], store, {
        now: 2,
        maxRuns: 2,
      });
      saveRunChatMessages("run-c", [textMessage("c1", "user", "c")], store, {
        now: 3,
        maxRuns: 2,
      });

      // Run-a was oldest, so it is evicted; b and c remain.
      expect(store.entries.has(runChatStorageKey("run-a"))).toBe(false);
      expect(loadRunChatMessages("run-b", store).map((m) => m.id)).toEqual(["b1"]);
      expect(loadRunChatMessages("run-c", store).map((m) => m.id)).toEqual(["c1"]);

      const index = JSON.parse(store.entries.get(RUN_CHAT_INDEX_KEY) ?? "{}");
      expect(Object.keys(index).toSorted()).toEqual(["run-b", "run-c"]);
    });

    test("evicts and retries when the store is over quota", () => {
      const store = quotaStore(2);
      saveRunChatMessages("run-a", [textMessage("a1", "user", "a")], store, { now: 1 });
      saveRunChatMessages("run-b", [textMessage("b1", "user", "b")], store, { now: 2 });
      // Third save hits the 2-key quota, so the oldest (run-a) is evicted and retried.
      saveRunChatMessages("run-c", [textMessage("c1", "user", "c")], store, { now: 3 });

      expect(store.entries.has(runChatStorageKey("run-a"))).toBe(false);
      expect(loadRunChatMessages("run-b", store).map((m) => m.id)).toEqual(["b1"]);
      expect(loadRunChatMessages("run-c", store).map((m) => m.id)).toEqual(["c1"]);

      const index = JSON.parse(store.entries.get(RUN_CHAT_INDEX_KEY) ?? "{}");
      expect(index["run-a"]).toBeUndefined();
    });

    test("the default cap is the documented constant", () => {
      expect(MAX_PERSISTED_RUNS).toBe(25);
    });
  });
});
