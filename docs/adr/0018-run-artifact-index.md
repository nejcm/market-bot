# ADR 0018 — Run Artifact Index as a derived SQLite query layer

## Status

Accepted

## Context

Research runs persist canonical artifacts under `MARKET_BOT_DATA_DIR/<run-id>/`. ADR 0016
introduced `src/run-artifacts.ts` as the disk read seam. Console list/search, history search, and
calibration still re-scanned and re-parsed JSON on every query at O(run count) cost.

The feasibility plan in `plans/sqlite-persistence-feasibility.md` proposed a derived, rebuildable
SQLite index using Bun's built-in `bun:sqlite` driver — no new npm dependencies.

## Decision

Add `src/run-artifact-index.ts` as a **derived query index** over on-disk run artifacts:

- **Disk remains canonical.** Raw run files are the source of truth. The SQLite file is rebuildable
  via `index rebuild` and must never be required for correctness.
- **Permanent disk fallback.** When the DB is absent, stale, unsupported (`PRAGMA user_version`
  mismatch), or unreadable, callers fall back to existing disk scans. Fallback paths emit a
  one-line `stderr` warning so operators can see which path ran.
- **Freshness gate.** An index read is fresh when the indexed run-directory set matches disk and
  mutable sidecars (`score.json`, `alpha-validation.json`,
  `normalized/candidate-profiles.json`) match recorded size and mtime. Other file changes within an
  existing run directory do not invalidate freshness until rebuild or write-through.
- **Write-through on mutation.** After research jobs, alpha-search runs, and score passes that touch
  mutable sidecars, the index incrementally re-indexes affected runs. Write failures are non-fatal
  (logged, run continues).
- **Search parity.** Indexed console and history search use the same substring semantics as disk
  fallback (`instr` on normalized text; history also matches label).
- **Phased seam migration.** Console list/search/detail metadata, history search, and calibration
  resolved-pair loading use the index when fresh. `scanRunArtifacts()` stays disk-only until the
  index can hydrate full `RunArtifact` payloads without per-run disk I/O.

Configuration:

- `MARKET_BOT_INDEX_DB_PATH` — optional override; default `<dataDir>/index.sqlite`
- `MARKET_BOT_INDEX_DISABLE=1` — disables all index reads and writes

## Consequences

- Hot queries can skip full-tree JSON parsing when the index is fresh.
- Operators must run `index rebuild` once to bootstrap the DB; write-through updates runs
  incrementally afterward.
- Schema changes bump `PRAGMA user_version`; mismatched DBs warn and fall back until rebuild.
- FTS5 (`search_fts`) is maintained on rebuild for future ranking work; substring search is the
  parity path today.

## Rejected alternatives

- **SQLite as source of truth** — rejected; artifacts on disk stay canonical and immutable.
- **Index-only reads with no fallback** — rejected; disk scan is the permanent oracle.
- **FTS tokenized-AND as the search oracle** — rejected; diverges from disk `includes` semantics.
- **Auto-create index on first write-through** — rejected for now; blurs the derived/rebuild model.

## References

- [ADR 0016 — Run Artifact reader as the canonical artifact read seam](./0016-run-artifact-reader.md)
- [plans/sqlite-persistence-feasibility.md](../../plans/sqlite-persistence-feasibility.md)
