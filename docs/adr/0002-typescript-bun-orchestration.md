# ADR 0002: Platform, configuration, persistence, and validation

## Status

Accepted

## Date

2026-06-30 (consolidated 2026-07-15)

## Context

The CLI, local console, model orchestration, persistence layer, and development workflow need one
coherent platform decision. Runtime, toolchain, model providers, configuration, Run Artifacts,
derived indexes, and pipeline fixtures were previously split across several records.

## Decision

### Runtime, toolchain, and model providers

- Use TypeScript on Bun for the CLI, server, scripts, tests, and package management.
- Use `oxlint` and `oxfmt`; do not add ESLint, Prettier, or Biome.
- Keep model access behind `ModelProvider` implementations for OpenAI, Anthropic,
  OpenAI-compatible endpoints, and Codex.
- The Codex provider invokes the external `codex exec` CLI in an ephemeral temporary directory with
  user config ignored and a read-only sandbox. Installing Codex may require Node, but Node is not an
  application runtime or repository toolchain dependency.
- Provider-specific unsupported sampling parameters may be omitted, but adapters validate every
  parameter they send.
- API-provider cost estimates use checked-in exact-model prices with source and as-of metadata.
  Unknown prices and subscription-backed Codex usage remain absent rather than appearing as zero;
  a run total is absent when any included stage has unknown cost.

### Configuration and prompts

- Load environment configuration through `src/config.ts` with typed validation and defaults.
- Keep per-run profiles under `src/config/runs/profiles/`; resolve code defaults, shared environment
  settings, profile settings, and depth overrides through the typed resolver.
- Load checked-in stage prompts from `prompts/<stage>/base.md`. Missing base prompts fail the run;
  optional overrides may be absent.
- Repeated `final-synthesis` records retain the stable stage label and carry an incrementing attempt
  number plus the reason for each reprompt.

### Canonical artifacts and derived indexes

- Run directories and their files are the durable source of truth. SQLite and history indexes are
  derived, disposable, and rebuildable query layers.
- Research and alpha-search initial writes use typed manifests from
  `src/run-artifact-writer.ts`. Manifest builders own required sidecars, null-when-absent files,
  empty defaults, and run-type conditionals; `src/run-artifact-layout.ts` owns file layout.
- `trace.json:stageRecords[]` and `analytics.json:runShape.stages[]` may contain monotonic-clock
  `durationMs` values. They measure individual attempts and may overlap when stages run
  concurrently.
- `src/run-artifacts.ts` is the shared reader for reports, scores, market snapshots, and verified
  snapshots. It parses leniently at full fidelity and distinguishes absent from malformed data.
  Single-consumer sidecars remain with their owner rather than expanding this seam.
- The SQLite Run Artifact Index accelerates list/search and selected calibration/history reads.
  Readers use it only when schema and freshness checks pass; otherwise they warn and fall back to
  disk.
- Research, alpha-search, and score mutations write through affected index rows when an index
  exists. Failure is non-fatal because disk remains authoritative.
- A present, schema-compatible stale index may rebuild automatically after write-through. Missing
  or unsupported-schema indexes are never auto-created or migrated; operators run `index rebuild`.
- Derived history indexes rebuild when the canonical run set or tracked mutable sidecars drift.
  Index-disable configuration forces disk-only behavior.

### Pipeline regression fixtures

- The primary static run harness mocks only HTTP `fetch` and `ModelProvider.generate` so collection,
  caching, normalization, source planning, orchestration, assembly, and validation remain real.
- Data cassettes replay HTTP below the source cache. LLM cassettes replay ordered responses keyed by
  `stage|model`; prompt hashes are intentionally excluded.
- Regression mode replays data and LLM responses for CI. Eval mode replays data but uses the live
  configured model provider and may incur cost.
- Direct `CollectedSources` injection remains appropriate for narrow unit tests, not the primary
  pipeline fixture tier.
- Recording is dev-only, stores canonicalized requests and scrubbed golden output, and fails when
  known token values appear in written fixtures.

## Consequences

- The project has one runtime, toolchain, configuration boundary, persistence authority, and
  full-pipeline fixture strategy.
- Provider differences remain isolated from research orchestration.
- Correctness never depends on SQLite availability, though freshness checks remain O(run-count)
  and stale healing may require a full rebuild.
- Index schema changes require a version bump and manual rebuild for existing databases.
- Golden fixture changes are explicit review points; adapter request or parser changes can require
  cassette refreshes. Eval mode remains an explicit local action.

## Implementation validation

- `package.json`, `src/model/`, `src/config.ts`, `src/config/runs/`, and
  `src/research/prompt-loader.ts` implement the runtime, provider, and configuration decisions.
- `src/run-artifact-layout.ts`, `run-artifact-writer.ts`, `run-artifacts.ts`,
  `run-artifact-index*.ts`, and `src/history/artifacts.ts` implement persistence and indexes.
- `tests/support/run-fixtures/`, `scripts/record-fixture-run.ts`,
  `scripts/replay-fixture-run.ts`, and `tests/equity-fixture-run.test.ts` implement fixture replay.
