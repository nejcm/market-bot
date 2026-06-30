# ADR 0016: Canonical Run Artifacts and derived indexes

## Status

Accepted

## Date

2026-06-30

## Context

Disk artifacts are the durable record of research, while console, history, calibration, and health
queries need faster projections and consistent malformed-data handling.

## Decision

- Run directories and their files remain canonical. SQLite and history indexes are derived,
  rebuildable query layers.
- `src/run-artifacts.ts` is the canonical shared reader for report, score, market snapshot, and
  verified snapshot data. It parses leniently at full fidelity and exposes absent/malformed status.
- Keep single-consumer sidecars with their owning consumer rather than expanding the shared reader.
- The SQLite Run Artifact Index accelerates list/search and selected calibration/history reads.
  Reads use it only when its schema and freshness checks pass; otherwise they warn and fall back to
  disk.
- Research, alpha-search, and score mutations write through affected rows when an index exists.
  Write failure is non-fatal because disk remains authoritative.
- A present, schema-compatible but stale index may be rebuilt automatically after write-through.
  Missing or unsupported-schema indexes are never auto-created or migrated; operators use
  `index rebuild`.
- Derived history indexes rebuild when their canonical run set or tracked mutable sidecars drift.
- Index disable configuration forces disk-only behavior.

## Consequences

- Correctness does not depend on SQLite availability.
- Query performance still pays an O(run-count) freshness probe, and stale healing may perform a full
  rebuild.
- Schema changes require an index version bump and manual rebuild for existing databases.

## Implementation validation

- `src/run-artifacts.ts` implements the shared disk reader.
- `src/run-artifact-index*.ts` implement schema, rows, freshness, and repair.
- `src/history/artifacts.ts` implements the derived history index.

## Supersedes

- ADR 0018
- ADR 0022
