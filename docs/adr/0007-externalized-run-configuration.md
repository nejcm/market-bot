# ADR 0007 — Externalized run configuration

## Status

Accepted

## Context

Prompts and model/sampling parameters were hardcoded across `research-context.ts` and `orchestrator.ts`. Tuning a daily equity run required editing TypeScript conditionals. Adding a per-cadence or per-asset variation meant branching in code. Temperature and other sampling knobs were not plumbed at all — the model providers ignored them.

## Decision

### Prompts — checked-in markdown, loaded at runtime

Stage prompts live under `prompts/<stage>/base.md`. Each file has three sections: `## system`, `## instruction`, and `## goal`. Optional combo override files (`daily-equity.md`, `ticker.md`, etc.) are appended to the base when present. Depth is not a prompt-file axis; its effect flows through injected config numbers, not separate files.

`src/research/prompt-loader.ts` reads files at runtime. A missing base is a hard fail; a missing override is silently ignored.

### Config — typed `src/config/runs.ts`

Per-run-type config is keyed by `daily-equity`, `daily-crypto`, `weekly-equity`, `weekly-crypto`, and `ticker`. Each block carries model identities, typed `ModelParams` sampling knobs, and depth-profile knobs (minimums, horizon, subjects, focus, analystStyle). Depth overrides are nested as a `deep:` sub-block. The resolver applies the fallback chain: code defaults ← env (`AppConfig`) ← combo block ← `deep` sub-block when `depth === "deep"`.

### Provider divergence — silent no-op

Sampling knobs reach only providers that honor them. OpenAI spreads the full knob set into the request body. Codex maps `reasoningEffort` to `-c model_reasoning_effort=<v>` and silently ignores other knobs. Behavioral steering for the Codex path is expressed as prose in prompt override files.

## Consequences

- All editable instruction text lives in `prompts/`; none is stranded in TypeScript.
- Per-run-type tuning (temperature, minimums, focus) happens in `src/config/runs.ts` without touching research or orchestrator code.
- Unsupported Codex knobs are silently dropped. Behavioral intent for Codex goes in prompt overrides.
- A missing `prompts/<stage>/base.md` causes a hard startup error, not silent degradation.

## Rejected alternatives

- **Per-combo standalone prompt files** — rejected; ~90% of text is identical across combos. Base + append-only overrides keeps it DRY.
- **Open passthrough config bag** (`Record<string, unknown>`) — rejected; typos silently no-op, violates validate-at-boundaries. Chose typed enumerated knobs.
- **Per-provider warning on unsupported knobs** — rejected for simpler silent no-op; codex behavioral intent goes in prompt overrides so nothing is lost silently.
- **Injecting numeric sampling values into prompts** — rejected; a raw float is noise and risks muddying JSON output. Behavioral intent goes in prose overrides.
- **Depth as a key component** (`daily-equity-deep`) — rejected; produces ~10 near-identical keys. Depth is a nested `deep:` sub-block.
