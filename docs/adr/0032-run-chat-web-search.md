# ADR 0032: Live web search in Run Chat (codex provider only)

## Status

Accepted

## Context

Run Chat (ADR 0029) answers questions over a run's persisted artifacts. When users
ask about information that post-dates or isn't covered by the run — a breaking
headline, a fresh analyst note, a current price move — the model can only say it
lacks the data.

The Codex CLI (`codex exec`) ships a native web-search tool gated behind a config
flag. Enabling it requires passing `-c tools.web_search=true -c web_search=live`
to the subprocess; no custom tool loop is needed. The openai and anthropic providers
have no equivalent without a purpose-built tool loop, so web search is restricted to
the codex provider for now.

A key constraint: `ModelProvider.generate` is shared by every deterministic
research stage (specialist analysis, evidence-request loop, playbook selection,
synthesis — see ADRs 0010, 0011). Those stages are artifact-backed and must never
trigger live fetches. Web search must therefore be **opt-in per request**, activated
only on the Run Chat path.

## Decision

### 1. Opt-in request field

Add `webSearch?: boolean` to `ModelRequest` (alongside `responseFormat`, not inside
`params`). It is `undefined` everywhere except the chat path. All non-codex providers
ignore it.

### 2. Codex provider: live mode

When `request.webSearch === true`, the codex subprocess receives:

```
-c tools.web_search=true -c web_search=live
```

`live` forces fresh network fetches rather than codex's default cached snapshot —
recency matters in a market-research context.

### 3. Gate: codex provider name + config toggle

The chat endpoint computes:

```ts
const webSearchActive = deps.chatConfig.webSearch && deps.provider.name === "codex";
```

This means web search is silently inactive on openai/anthropic (no error, no
disclosure), matching the "codex-only for now" intent without breaking other
providers.

`MARKET_BOT_CONSOLE_CHAT_WEB_SEARCH` (default: enabled) is the kill-switch,
consistent with ADR 0007 env-var configuration. Setting it to `0` or `false` disables
web search entirely.

### 4. System prompt guidance

When web search is active, a guidance block is appended to the system prompt
instructing the model to:

- Prefer run artifacts; consult the web only when artifacts are insufficient.
- Cite URLs and titles inline for any web-sourced claim.
- Explicitly label claims that came from a live web lookup.

The guidance block is omitted when web search is inactive, so non-codex and
disabled-config chats never claim a capability they lack.

### 5. Web findings are ephemeral context, not Sources

Run Chat is non-persisted server-side (ADR 0029). Web results found during a
conversation are **ephemeral conversational context**. They:

- Are never assigned an ID.
- Never become domain _Sources_.
- Never touch Evidence Lanes, Evidence Quality, or prediction scoring.
- Are never written to disk under `data/runs/` and never re-enter a research run.

(The chat transcript itself may remain in the browser's `localStorage` so a
conversation survives reloads — see `app/client/components/run-chat-storage.ts` — but
that is browser-local UI state, not a server-side artifact or a Source.)

The terms _Source_, _Evidence_, _Evidence Lane_, and _Source Provider_ retain their
glossary meanings (CONTEXT.md) and are unaffected by this feature.

## Consequences

- Run Chat on the codex provider gains the ability to look up current information
  that post-dates or is absent from run artifacts, at the cost of added latency per
  search.
- openai and anthropic providers are unaffected; their deterministic research paths
  are also unaffected.
- The `ModelRequest` type gains one new optional field; all existing call sites
  continue to work unchanged.
- Live web fetches introduce a network dependency inside an otherwise local-only chat
  path. The kill-switch (`MARKET_BOT_CONSOLE_CHAT_WEB_SEARCH=false`) disables this
  if unwanted.
- Both `-c` keys we pass (`tools.web_search=true` and `web_search=live`) are
  recognized config fields in codex 0.141.0, verified via `codex exec --strict-config`
  (which rejects unknown fields). `tools.web_search=true` activates the tool and
  `web_search=live` selects live mode over the cached default; passing both yields
  "enabled + live" regardless of which key drives which. The interactive `--search`
  flag is TUI-only and cannot be used in `codex exec`. These config keys have changed
  across codex releases, so re-verify with `--strict-config` if a future codex upgrade
  changes web-search behaviour.
