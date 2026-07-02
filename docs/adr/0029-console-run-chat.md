# ADR 0029: Ephemeral Run Chat and optional live web search

## Status

Accepted

## Date

2026-06-30

## Context

The local Research Console provides follow-up Q&A over a run. Chat must reuse model providers,
remain separate from Run Artifacts, and optionally answer questions requiring current web context.

## Decision

- The Svelte client uses AI SDK chat state and text transport. The Bun server uses the existing
  `ModelProvider.generate` interface and returns plain text.
- The server builds bounded context from the selected run and recent browser-supplied chat turns.
- Chat is stateless server-side. Transcripts may be stored in browser `localStorage` but are never
  written under the run data directory.
- Same-origin POST validation protects the local paid-model endpoint. The server binds to localhost
  by default and provides no authentication or TLS.
- Chat follows the explicit boundary exception in ADR 0001.
- Live web search is enabled by default at the console configuration level, but active only when the
  selected provider is Codex and a once-per-process capability probe confirms the local Codex CLI
  advertises live-search support.
- Codex live search receives `tools.web_search=true` and `web_search=live`. Other providers run chat
  without live search until provider-specific support is explicitly implemented.
- The client discloses active live search in the Run Chat UI because questions and selected run
  context may be sent to Codex and external web requests may be made.
- Web findings are ephemeral conversational context. They are not persisted Sources, do not affect
  Evidence Quality or predictions, and must be cited inline by URL/title when used.

## Current operational limitations

- Configuration defaults web search to enabled, but unsupported providers run without it.
- Non-Codex model providers do not currently expose Run Chat live search.
- Same-origin localhost protection does not replace authentication if the console is exposed.
- Chat sends selected artifact and user content to the configured model provider and may incur paid
  model or web-search usage.

## Consequences

- Run Chat can use all repository model providers without introducing a second server model stack.
- Chat behavior is not reproducible as part of a Run Artifact.
- Operators must disable chat or web search when external disclosure or cost is unacceptable.

## Implementation validation

- `app/chat.ts` implements context, provider gating, and same-origin handling.
- `app/client/components/run-chat.svelte` and `run-chat-storage.ts` implement client state.
- `src/model/codex.ts` implements per-request live-search flags and CLI preflight.

## Supersedes

- ADR 0032
