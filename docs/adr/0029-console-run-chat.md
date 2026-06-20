# ADR 0029: Console Run Chat

## Status

Accepted

## Context

The Research Console lets users browse run artifacts but offers no way to ask follow-up questions about a run. Users want an interactive Q&A surface grounded in run data, including the ability to ask positioning and buy/sell questions without refusal. Persisted reports remain bound by the research-only boundary (ADR 0001); this feature is a separate, ephemeral, interactive surface.

The server uses `src/model/ModelProvider` with Codex subprocess and openai-compatible provider support. A server-side AI SDK would bypass those providers and duplicate the model layer.

## Decision

### 1. Research-only exemption

Run Chat is an ephemeral, non-persisted, interactive Q&A surface in the Research Console exempt from the report research-only validation. It may answer any question including buy/sell/positioning, framed as analysis over the run's artifacts. Persisted reports remain bound by ADR 0001.

### 2. Client uses Vercel AI SDK; server stays on `src/model/`

The client uses `@ai-sdk/svelte` (`Chat` class with `TextStreamChatTransport`) for conversation state and rendering. The server stays on the existing `ModelProvider.generate` interface, returning plain text responses. This preserves Codex subprocess and openai-compatible provider support while gaining a streaming and tool-calling upgrade path on the client.

Alternatives considered:

- **TanStack AI:** requires implementing the AG-UI SSE protocol server-side for no current benefit; newer ecosystem with less Svelte maturity.
- **Hand-rolled:** no streaming or tool upgrade path; reinvents conversation state management.

## Consequences

- The repo gains `@ai-sdk/svelte` as its first client-side AI runtime dependency (dev only; Vite bundles it). The `ai` core package is a transitive dependency, not listed in `devDependencies`.
- Chat conversations are ephemeral and browser-only. Nothing is written to disk under `data/runs/`. Server remains stateless and read-only over run artifacts.
- The same-origin POST guard protects the chat endpoint from cross-site abuse since it triggers paid model calls.
- V2 can add real token streaming (`generateStream` on `ModelProvider`) and web-research tools without changing the client transport.
