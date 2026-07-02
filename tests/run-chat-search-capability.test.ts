import { describe, expect, test } from "bun:test";
import {
  isSearchDisclosureVisible,
  parseRunChatSearchCapability,
  RUN_CHAT_SEARCH_DISCLOSURE,
} from "../app/client/components/run-chat-search-capability";

describe("parseRunChatSearchCapability", () => {
  test("parses a full capability payload", () => {
    expect(
      parseRunChatSearchCapability({
        configured: true,
        supported: true,
        effective: true,
        reason: "active",
      }),
    ).toEqual({ configured: true, supported: true, effective: true, reason: "active" });
  });

  test("defaults missing or malformed fields to safe values", () => {
    expect(parseRunChatSearchCapability({ effective: "yes", reason: 42 })).toEqual({
      configured: false,
      supported: false,
      effective: false,
      reason: "provider-unsupported",
    });
  });

  test("rejects non-object payloads", () => {
    expect(parseRunChatSearchCapability(null)).toBeUndefined();
    expect(parseRunChatSearchCapability("active")).toBeUndefined();
  });
});

describe("isSearchDisclosureVisible", () => {
  test("visible only when capability is effective", () => {
    expect(
      isSearchDisclosureVisible({
        configured: true,
        supported: true,
        effective: true,
        reason: "active",
      }),
    ).toBe(true);
    expect(
      isSearchDisclosureVisible({
        configured: true,
        supported: false,
        effective: false,
        reason: "probe-failed",
      }),
    ).toBe(false);
    expect(isSearchDisclosureVisible()).toBe(false);
  });
});

describe("RUN_CHAT_SEARCH_DISCLOSURE", () => {
  test("discloses provider transmission, external requests, cost, and ephemerality", () => {
    expect(RUN_CHAT_SEARCH_DISCLOSURE).toContain("sent to Codex");
    expect(RUN_CHAT_SEARCH_DISCLOSURE).toContain("external web requests");
    expect(RUN_CHAT_SEARCH_DISCLOSURE).toContain("costs may be incurred");
    expect(RUN_CHAT_SEARCH_DISCLOSURE).toContain("ephemeral");
    expect(RUN_CHAT_SEARCH_DISCLOSURE).toContain("Evidence Quality");
  });
});
