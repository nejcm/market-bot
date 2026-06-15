# ADR 0016 — Run Artifact reader as the canonical artifact read seam

## Status

Accepted

## Context

Four modules independently read and parsed the same per-run artifacts under
`MARKET_BOT_DATA_DIR/<run-id>/` (`report.json`, `score.json`, `normalized/*.json`):

- `src/research/historical-context.ts` — guard-based lenient parse; dropped `report.sources`
  and collapsed prediction `kind` to `direction`/`relative`.
- `src/history/artifacts.ts` — guard-based lenient parse; kept `sources` and the real `kind`.
- `src/scoring/index.ts` — raw `JSON.parse(raw) as ResearchReport` casts, no guards.
- `src/research/market-update-delta.ts` — built a minimal ad-hoc shape, no `ResearchReport`.

Each redefined `readJson`, `isJobType`/`isAssetClass`, a `report.json → ResearchReport` parse, and
its own directory scan. The malformed-counting definitions actively contradicted each other: a
directory with no `report.json` was "not scanned" in historical-context but counted as "malformed"
in history. There was no canonical reader — `src/report/schema.ts` only validates on *write*, and
reading back is intentionally lenient because older artifacts predate the current schema.

This mirrors the situation ADR 0009 resolved on the write/fetch side: provider integrations were
consolidated into composable Source Provider modules. The read side of `data/runs/` had no
equivalent seam.

## Decision

Introduce one read module, `src/run-artifacts.ts`, as the canonical seam for persisted runs. It
exposes `scanRunArtifacts(dataDir)` and `loadRunArtifact(runDir)` returning a typed `RunArtifact`
(`runDirName`, `report`, `scores`, `marketSnapshots`, optional `verifiedMarketSnapshot`,
`status`).

- **Full-fidelity shared parse.** `report.json` is parsed once, leniently, to the domain
  `ResearchReport` — keeping `sources` and the real prediction `kind`. Callers project down to what
  they need; a reader can carry more than a caller needs, never less.
- **Shared bundle.** The reader bundles only the artifacts read by more than one caller: report,
  scores, primary market snapshots, and verified market snapshots. History/alpha-only files
  (supplemental snapshots, SEC fundamentals, alpha validation) and `movers.json` are read by their
  single caller, not here.
- **Discriminated malformed contract.** Per run, the reader reports
  `report: "ok" | "malformed" | "absent"` and `score: "ok" | "malformed" | "absent"`
  (`absent` = ENOENT; `malformed` = unreadable or wrong shape). Callers fold these into their own
  audit counts. This unifies the previously contradictory definitions.

The existing write-side dir-paths type `RunArtifacts` was renamed `RunArtifactPaths` to free the
`RunArtifact` name. `src/artifacts.ts` remains the write side.

## Consequences

- Parsing lives in one place, tested once; caller suites shed their parsing-edge coverage.
- historical-context audit counts are unchanged. `history`'s `malformedRunCount` converges to the
  stricter definition — report-absent directories are no longer counted as malformed. In practice
  this only differs on anomalous directories, since every real run writes `report.json`.
- `scoring/index.ts` gains guarded parsing in place of raw casts.
- `market-update-delta` now reads `score.json` and snapshots during its scan (the core bundle)
  rather than report-only; acceptance is "one scan pass per caller," not identical read counts.
- Migration is staged: this change builds the reader and migrates `market-update-delta` and
  `historical-context`; `history/artifacts` and `scoring/index` follow in separate changes.

### Migration complete

The staged migration is finished. All four consumers now read through the seam — `market-update-delta`
and `historical-context` (this change), then `scoring/index` and `history/artifacts` (follow-ups). No
raw `JSON.parse(...) as T` report/score casts remain. Two notes on the completed state:

- `readScores` carries `scoringVersion` through at full fidelity (optional, `undefined` for legacy
  files) so score-writing consumers preserve the version stamped on already-resolved scores — the
  seam principle "a reader can carry more than a caller needs, never less."
- `history/artifacts` takes report + scores from the seam but keeps its single-caller sidecars
  (supplemental snapshots, `sec-fundamentals.json`, `alpha-validation.json`) local, and adopts the
  stricter `malformedRunCount` definition above.
- `normalized/verified-market-snapshot.json` is now parsed by the seam because both the run
  workspace and per-Instrument timeline surfaces consume it. This does not make it scoring
  evidence; ADR 0019's research-only and supplemental-evidence boundaries still apply.

## Rejected alternatives

- **Per-caller lenient parsers (status quo)** — rejected; four parsing strategies for one on-disk
  shape drift apart and disagree on malformed semantics.
- **A `scanRunArtifacts(dataDir, { include })` options bag** — rejected; per-caller selection
  branching back inside the reader re-shallows the seam.
- **Folding every run file into the bundle** — rejected; supplemental snapshots, SEC fundamentals,
  and alpha validation have a single caller each, so they stay with that caller (scope discipline).
- **An injectable in-memory artifact store** — rejected for now; the locality win is one tested
  parsing surface, and threading a filesystem dependency through callers is unneeded plumbing.
- **Reusing `report/schema.ts` (zod) to read** — rejected; that validator enforces write-time
  invariants (known source IDs, research-only language) that older persisted artifacts need not
  satisfy on read.

## References

- [ADR 0009 — Source provider modules](./0009-source-provider-modules.md)
- [ADR 0014 — Artifact-backed Historical Context and Market Spotlights](./0014-artifact-backed-history-and-market-spotlights.md)
- [ADR 0018 — Run Artifact Index as a derived SQLite query layer](./0018-run-artifact-index.md)
