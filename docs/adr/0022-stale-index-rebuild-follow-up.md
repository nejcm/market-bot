# ADR 0022 — Stale Run Artifact Index: automatic rebuild follow-up

## Status

Accepted

## Context

ADR 0018 introduced the Run Artifact Index as a derived SQLite query layer with a
write-through mechanism: after every research, `score`, or `alpha-search` run, the
index is incrementally updated for the affected runs. Write-through failures are
non-fatal; the run continues and a `stderr` warning is emitted.

When a write-through fails, the affected run directory exists on disk but is absent
from the index. Subsequent index-backed reads — including calibration pairing inside
each run — call `indexIsFresh` and detect the mismatch, which warns
`"falling back to disk scan"` and returns `undefined`. This fall-through is permanent:
every subsequent run and every console query falls back to a full-tree disk scan until
an operator manually runs `index rebuild`.

## Decision

After each successful write-through call in `updateRunArtifactIndex` (`src/app.ts`),
also call `rebuildRunArtifactIndexIfStale` (`src/run-artifact-index-repair.ts`). This
performs a one-shot full rebuild if and only if the index is **present and
schema-matched but stale**. The rebuild is a non-fatal, best-effort-awaited side
effect (errors go to `stderr`, run never aborts).

Guard logic in `rebuildRunArtifactIndexIfStale`:

1. Resolve the DB path once — status check, freshness probe, and rebuild all target
   the same file.
2. Check `readRunArtifactIndexStatus(...).state`. Return `{ rebuilt: false }` for
   anything other than `"available"` (disabled / missing / unsupported-schema / unreadable).
3. Call `indexIsFresh` with a **suppressing warn callback** (no "falling back to disk
   scan" line in the repair lane).
4. If fresh, return `{ rebuilt: false }`.
5. Otherwise, call `rebuildRunArtifactIndex` (the existing full-rebuild oracle) at
   the same path, emit terse `stderr` lines, return `{ rebuilt: true }`.

`readRunArtifactIndexStatus` is widened with an optional third `dbPath` parameter
(default: derived from env/config) so the status check and rebuild always target the
same file even when the caller supplies an explicit path.

## Explicit no-s (distinction from ADR 0018 rejected alternative)

ADR 0018 rejected "Auto-create index on first write-through." This decision is not
that. The guard requires `state === "available"`, which requires the DB file to exist
and the schema version to match. A **missing** index is never created automatically;
an **unsupported-schema** index is never auto-migrated. Both keep the existing
warn-and-fallback + manual `index rebuild` path.

This is stale-healing of an existing, schema-matched index — not auto-creation.

## Consequences

- **Converging staleness.** The first run to detect drift rebuilds the index;
  subsequent runs and the console return to index-backed reads without operator
  intervention. The repair is self-limiting: rebuild → fresh → write-through keeps it
  fresh → quiet until the next genuine drift.
- **Detecting run still disk-scans.** With the trigger placed after write-through,
  and the run side-effect order being score → calibration → index update, the run
  that first detects drift has already completed its own calibration pairing via disk
  scan. The rebuild benefits subsequent runs. This is the accepted trade-off — the
  goal is to stop *repeated* fallbacks, not to make the detecting run itself
  index-backed.
- **Additional freshness probe per write-through.** Every write-through now also
  pays an O(run count) freshness probe (run-dir listing + mutable-sidecar `stat`s).
  This is far cheaper than the full-tree JSON disk scan it prevents, and the same
  read set is already queried by the freshness checks on the read path.
- **No new env var or configuration knob.** `MARKET_BOT_INDEX_DISABLE=1` already
  short-circuits all index writes and reads, including this repair path.

## References

- [ADR 0018 — Run Artifact Index as a derived SQLite query layer](./0018-run-artifact-index.md)
  (see "Rejected alternatives: Auto-create index on first write-through" for the
  distinction between stale-healing and auto-creation)
- `src/run-artifact-index-repair.ts` — orchestrator implementation
- `src/app.ts` `updateRunArtifactIndex` — trigger point
