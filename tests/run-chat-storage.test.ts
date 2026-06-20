import { describe, expect, test } from "bun:test";
import type { UIMessage } from "@ai-sdk/svelte";
import {
  loadRunChatMessages,
  runChatStorageKey,
  saveRunChatMessages,
  type RunChatStore,
} from "../app/client/components/run-chat-storage";

function memoryStore(initial: Record<string, string> = {}): RunChatStore & {
  readonly entries: Map<string, string>;
} {
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

function textMessage(id: string, role: "user" | "assistant", text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] } as UIMessage;
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

    saveRunChatMessages("run-1", messages, store);

    expect(loadRunChatMessages("run-1", store)).toEqual(messages);
  });

  test("keeps transcripts isolated per run", () => {
    const store = memoryStore();
    saveRunChatMessages("run-a", [textMessage("a1", "user", "hi from a")], store);
    saveRunChatMessages("run-b", [textMessage("b1", "user", "hi from b")], store);

    expect(loadRunChatMessages("run-a", store)).toEqual([textMessage("a1", "user", "hi from a")]);
    expect(loadRunChatMessages("run-b", store)).toEqual([textMessage("b1", "user", "hi from b")]);
  });

  test("returns an empty array when no history exists", () => {
    expect(loadRunChatMessages("missing", memoryStore())).toEqual([]);
  });

  test("removes the key when saving an empty transcript", () => {
    const store = memoryStore();
    saveRunChatMessages("run-1", [textMessage("m1", "user", "hello")], store);
    saveRunChatMessages("run-1", [], store);

    expect(store.entries.has(runChatStorageKey("run-1"))).toBe(false);
    expect(loadRunChatMessages("run-1", store)).toEqual([]);
  });

  test("ignores corrupt JSON", () => {
    const store = memoryStore({ [runChatStorageKey("run-1")]: "{not json" });
    expect(loadRunChatMessages("run-1", store)).toEqual([]);
  });

  test("drops entries that are not message-shaped", () => {
    const valid = textMessage("m1", "user", "kept");
    const store = memoryStore({
      [runChatStorageKey("run-1")]: JSON.stringify([
        valid,
        { id: "m2", role: "user" },
        { id: "m3", role: "tool", parts: [] },
        { role: "assistant", parts: [] },
        "nope",
      ]),
    });

    expect(loadRunChatMessages("run-1", store)).toEqual([valid]);
  });

  test("returns an empty array when storage is unavailable", () => {
    expect(loadRunChatMessages("run-1", null)).toEqual([]);
  });

  test("saving is a no-op when storage is unavailable", () => {
    expect(() =>
      saveRunChatMessages("run-1", [textMessage("m1", "user", "x")], null),
    ).not.toThrow();
  });
});
