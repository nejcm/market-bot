# ADR 0005 — codex subscription provider

## Status

Accepted

## Context

The bot previously required an OpenAI API key. Users with a ChatGPT Plus, Pro, or Business subscription already pay for model access but cannot use that subscription directly with the `OPENAI_API_KEY` path — the subscription-backed endpoint is not the same as the API, and OpenAI does not expose a public chat-completions endpoint for subscription accounts.

The `codex` CLI (≥ 0.125, `npm i -g @openai/codex`) authenticates against the user's ChatGPT session and exposes `codex exec`, which runs a prompt non-interactively and returns a JSONL event stream. This is the only OpenAI-sanctioned way to programmatically reach the subscription backend.

## Decision

Add a third `ProviderName` value (`"codex"`) backed by a subprocess call to `codex exec --json --ephemeral --skip-git-repo-check -m <model> -`. The prompt is piped via stdin; the response is parsed from the `item.completed` event with `item.type === "agent_message"`. Token usage is read from the `turn.completed` event's `usage` field.

Selected over the alternatives:

- **Reverse-engineering the ChatGPT session token** — against OpenAI ToS, breaks on every schema change.
- **Embedding the codex package as a library** — not distributed as an importable module; would couple to internal codex internals and require Node alongside Bun.
- **Limiting codex to non-JSON-mode calls only** — would prevent running the bot on a subscription without an API key fallback, defeating the goal.

## Consequences

- **No API key required** when `MARKET_BOT_PROVIDER=codex`. The user must have `codex` on PATH, be logged in (`codex login`), and have a Codex-enabled ChatGPT plan.
- **Higher latency** than direct API calls. Codex spins up an agentic session per call; expect 2–5× slower wall-clock time per research run.
- **Rate limits** are determined by the ChatGPT subscription tier, not by API quota. Plus: 15–80 messages per five-hour window.
- **Version coupling** — the JSONL event schema is an implementation detail of the `codex` CLI. If OpenAI changes `agent_message` → something else, the parser breaks. The minimum version check (≥ 0.125) reduces surprise; upgrading codex may still require updating the event parser.
- **Preflight on first call** verifies binary presence, version, and auth status before any source fetching starts.
- **costEstimateUsd is always 0** — subscription cost is flat-rate; per-call cost is not meaningful.
- **Model floor** — do not configure models below `gpt-5.4` for either provider.
