import { describe, expect, test } from "bun:test";
import type { UIMessage } from "@ai-sdk/svelte";
import {
  formatChatTimestamp,
  messageCreatedAt,
  textFromParts,
} from "../app/client/components/run-chat-message-utils";

describe("run chat message utilities", () => {
  test("extracts copy text from text parts only", () => {
    expect(
      textFromParts([
        { type: "text", text: "first" },
        { type: "reasoning", text: "hidden" },
        { type: "text", text: "\nsecond" },
        "legacy",
      ]),
    ).toBe("first\nsecond");
  });

  test("reads numeric createdAt metadata", () => {
    const message = {
      id: "m1",
      role: "assistant",
      parts: [],
      metadata: { createdAt: 1_785_654_000_000 },
    } as unknown as UIMessage;

    expect(messageCreatedAt(message)).toBe(1_785_654_000_000);
  });

  test("ignores missing or non-numeric createdAt metadata", () => {
    const message = {
      id: "m1",
      role: "assistant",
      parts: [],
      metadata: { createdAt: "today" },
    } as unknown as UIMessage;

    expect(messageCreatedAt(message)).toBeUndefined();
  });

  test("formats today's timestamp as compact local time", () => {
    const now = new Date(2026, 5, 21, 10, 0);
    const timestamp = new Date(2026, 5, 21, 9, 5).getTime();

    expect(formatChatTimestamp(timestamp, now)).toBe("09:05");
  });

  test("formats older timestamps with date and compact local time", () => {
    const now = new Date(2026, 5, 21, 10, 0);
    const timestamp = new Date(2026, 5, 20, 9, 5).getTime();

    expect(formatChatTimestamp(timestamp, now)).toBe("Jun 20, 09:05");
  });

  test("returns an empty timestamp for invalid input", () => {
    expect(formatChatTimestamp()).toBe("");
    expect(formatChatTimestamp(Number.NaN)).toBe("");
  });
});
