# ADR 0002: Runtime, toolchain, configuration, and model providers

## Status

Accepted

## Date

2026-06-30

## Context

The CLI, local console, model orchestration, and development workflow need one coherent platform
decision. Earlier records separately described Bun, Oxc, Codex, and run configuration, and several
of their paths and run-type examples became obsolete.

## Decision

- Use TypeScript on Bun for the CLI, server, scripts, tests, and package management.
- Use `oxlint` and `oxfmt`; do not add ESLint, Prettier, or Biome.
- Keep model access behind `ModelProvider` implementations for OpenAI, Anthropic,
  OpenAI-compatible endpoints, and Codex.
- The Codex provider invokes the external `codex exec` CLI in an ephemeral temporary directory with
  user config ignored and a read-only sandbox. Installing Codex may require Node, but Node is not an
  application runtime or repository toolchain dependency.
- Load environment configuration through `src/config.ts` with typed validation and defaults.
- Keep per-run profiles under `src/config/runs/profiles/`; resolve code defaults, shared environment
  settings, profile settings, and depth overrides through the typed resolver.
- Load checked-in stage prompts from `prompts/<stage>/base.md`. Missing base prompts fail the run;
  optional overrides may be absent.
- Provider-specific unsupported sampling parameters may be omitted, but provider adapters must
  validate parameters they do send.
- API-provider cost estimates use checked-in, exact-model input/output prices with source and
  as-of metadata. Unknown model prices and subscription-backed Codex usage remain absent rather
  than being reported as zero; a run total is absent when any included stage has unknown cost.
- Repeated `final-synthesis` stage records retain the stable stage label and carry an incrementing
  attempt number plus the triggering reprompt reason on subsequent attempts.

## Consequences

- The application has one runtime and one lint/format pipeline.
- Model-provider differences stay isolated from research orchestration.
- Optional Codex usage adds an external CLI prerequisite without making Node part of the project
  runtime.
- Configuration and prompts remain reviewable, typed, and external to orchestration logic.

## Implementation validation

- `package.json` uses Bun scripts, TypeScript, `oxlint`, and `oxfmt`.
- `src/model/` contains the provider implementations and shared interface.
- `src/config/runs/` contains the current profile and resolution structure.
- `src/research/prompt-loader.ts` enforces prompt loading.

## Supersedes

- ADR 0003
- ADR 0005
- ADR 0007
