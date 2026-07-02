export interface RunChatSearchCapability {
  readonly configured: boolean;
  readonly supported: boolean;
  readonly effective: boolean;
  readonly reason: string;
}

export const RUN_CHAT_SEARCH_DISCLOSURE =
  "Live web search is enabled for this chat. Questions and selected run context may be sent to " +
  "Codex, external web requests may be made, and model or search costs may be incurred; web " +
  "findings remain ephemeral and do not update run artifacts, Evidence Quality, or predictions.";

export function parseRunChatSearchCapability(value: unknown): RunChatSearchCapability | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as {
    readonly configured?: unknown;
    readonly supported?: unknown;
    readonly effective?: unknown;
    readonly reason?: unknown;
  };
  return {
    configured: candidate.configured === true,
    supported: candidate.supported === true,
    effective: candidate.effective === true,
    reason: typeof candidate.reason === "string" ? candidate.reason : "provider-unsupported",
  };
}

export function isSearchDisclosureVisible(capability?: RunChatSearchCapability): boolean {
  return capability?.effective === true;
}
