# ADR 0002: Platform and persistence

## Status

Accepted

## Context

The CLI, Research Console, orchestration, and durable Run Artifacts share one platform and persistence authority.

## Decision

- Use TypeScript on Bun for runtime, server, scripts, tests, and package management; use `oxlint`/`oxfmt`.
  Node, ESLint, Prettier, and Biome are not repository toolchain dependencies. An external Codex installation
  may require Node; that does not make Node an application runtime.
- Isolate OpenAI, Anthropic, OpenAI-compatible, and Codex access behind `ModelProvider`. Codex uses external
  `codex exec` in an ephemeral directory with user configuration ignored and a read-only sandbox. Adapters
  validate sent parameters and may omit unsupported sampling parameters.
- API cost estimates use checked-in exact-model prices with sources and as-of metadata. Unknown prices and
  subscription-backed Codex cost stay absent, never zero; any unknown included stage makes the run total absent.
- Validate environment configuration centrally in `src/config.ts`; typed resolution combines code defaults,
  shared environment settings, per-run profiles, and depth overrides. Keep profiles under `src/config/runs/profiles/`.
- Stage base prompts are checked in under `prompts/<stage>/base.md`; missing bases fail, optional overrides may
  be absent. Repeated final-synthesis attempts retain the stage label, incrementing attempt, and reprompt reason.
- Files under `data/runs/<run-id>/` are canonical. `data/calibration/`, `data/history/`, `data/index.sqlite`,
  `data/cache/`, and shared news/peer state have separate ownership; indexes are rebuildable query layers.
  Rebuildability does not authorize deleting or pruning data.
- Publish complete run directories by staging then atomic rename. Parallel runs serialize scoring,
  Calibration, index, and history mutations through `data/shared-state.lock`; news-seen and learned-peer
  merges use their own locks. Never expose a partially written run as a published Run Artifact.
- Typed initial-write manifests own required sidecars, explicit null/empty defaults, and run-type conditionals;
  the shared artifact layout owns paths. Successful runs contain report JSON/Markdown, scores, analytics,
  outcomes, stages, trace, normalized evidence, and raw snapshots as applicable to their run type.
- Completed deep equity persists normalized current evidence and deterministic views only in
  `normalized/evidence-bundle.json`; subsumed component sidecars are not written. Raw payloads live only in
  `raw/snapshots.json`. Other run types keep their component layouts.
- Failed final synthesis retains `failure.json`, `outcomes.json`, `rejected-report.json`, `stages.json`,
  normalized components, and raw evidence; no validated report, report Markdown, trace, or analytics is emitted.
  Failed deep equity retains component evidence rather than constructing a completed bundle.
- Root `outcomes.json` is the canonical successful/failed final-synthesis Subsystem Outcome ledger. Successful
  analytics contain its text-free rollup; alpha-search emits no ledger. Optional stage `durationMs` measures
  monotonic attempt time, can overlap, and is not additive run wall time.
- `src/run-artifacts.ts` is the shared full-fidelity, tolerant reader for reports, scores, market snapshots,
  and Verified Market Snapshots. Distinguish absent from malformed data; keep single-consumer sidecars with
  their owner. Deep-equity readers project the bundle only, with no production legacy-sidecar fallback.
  The completed migration tool is retired; legacy sidecars may remain for audit but have no production authority.
- Use the Run Artifact Index only after schema/freshness checks; otherwise warn and read disk. Research,
  alpha-search, and score mutations write through existing index rows; index failures are non-fatal.
- Preserve outcome-ledger state as `ok`, `absent`, or `malformed`, plus valid child rows. Enable SQLite foreign
  keys; insert parents before children on rebuild and ensure delete paths remove children or enforce cascades.
- A present compatible stale index may rebuild after write-through. Never auto-create missing indexes or
  migrate unsupported schemas: schema changes need a version bump and explicit operator `index rebuild`.
  Derived history rebuilds when the canonical run set or tracked mutable sidecars drift; index-disable forces disk.
- Replay Capture is an optional engineering sidecar, not canonical research evidence or a Console/index surface.
  Its safety and replay contracts live in [ADR 0005](./0005-testing-and-replay.md).

## Consequences

- Provider differences stay outside orchestration, and correctness never depends on SQLite availability.
- Freshness checks remain proportional to run count; stale healing can require a full rebuild.
- Deep equity has one normalized evidence authority and one production read path; failed runs remain diagnosable.
- Persistence or index changes must preserve whole-run publication, lock ownership, and absent/malformed distinctions.
