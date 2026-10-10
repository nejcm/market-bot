# ADR 0008: Replay and invariants, no byte-exact output snapshots

## Status

Accepted. Supersedes the golden-invariance layer of
[ADR 0007](./0007-golden-invariance-live-correctness-invariants.md).

## Date

2026-10-10

## Context

ADR 0007 paired byte-exact run goldens (scrubbed `report.json`, `report.md`, `analytics.json`,
`outcomes.json`, and `normalized/`) with live-run correctness invariants. In practice the goldens
were rewritten in 43 of 211 commits since 2026-08-01. A rewrite can approve thousands of changed lines
at once, which is approval by hash: the failure ADR 0007 itself names as the reason goldens
cannot establish correctness.

## Decision

Fixture replays assert invariants only. No byte-exact snapshot of run output is kept.

- Cassettes, `runFixture`, the recorder, and `scripts/replay-fixture-run.ts` (replay, or `--live` for
  replayed data with a live model) stay.
- Every replayed fixture must complete with a readable `report.json` and no `failure.json`, persist
  exactly what the run generated (report, Markdown, analytics, outcomes, evidence bundle), validate
  the persisted report against the report schema, pass the research-language gate, resolve every evidence-bundle source
  id, and keep `reportIntegrity` at `high`.
- ADR 0007's live correctness invariants, its one-directional checks, its no-exception rule, and its
  reader-degradation amendment remain in force.
- A fixture that exists to pin one behavior carries one targeted assertion for that behavior,
  derived from its purpose, not a snapshot.
- Prompt text stays pinned by `tests/support/prompt-baseline.golden.json`; that is input, not output.

## Consequences

- Unrelated output changes no longer churn the repository or require a regeneration step.
- Output drift that breaks no invariant goes unnoticed in CI. A behavior worth keeping needs its own
  assertion; a `scripts/replay-fixture-run.ts <name>` run directory can be read by hand.
