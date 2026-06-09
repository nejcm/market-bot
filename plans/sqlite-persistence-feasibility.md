# Feasibility: Database-Backed Persistence (SQLite) for Run Artifacts

> Status: **Exploration / scoping only** — no decision taken, no code written.
> Date: 2026-06-09. Author: scoping session (human + agent).
> Source: [docs/IMPROVEMENTS.md](../docs/IMPROVEMENTS.md) item #2, companion to item #1
> (semantic search — see [semantic-search-feasibility.md](./semantic-search-feasibility.md)).
> Next concrete artifact if pursued: a new ADR (next number is **0018**, or after the
> semantic-search ADR if that lands first) extending [ADR 0016](../docs/adr/0016-run-artifact-reader.md).

## Question

> "Database-backed persistence once local JSON indexes become hard to query. SQLite is the
> likely first step; keep raw artifacts on disk if useful. If optimal use db only for
> metadata and references to files (artifacts of runs) on disk."

Is it feasible and worthwhile, and what is the right shape?

## TL;DR

- **Feasible:** yes, and unusually cheaply — `bun:sqlite` ships **inside the Bun runtime**, so
  there is **zero npm dependency** and it sails through [ADR 0003](../docs/adr/0003-oxc-toolchain.md)
  (Bun + oxc only). No native compile, no Node.
- **The proposed shape is correct:** metadata + references in the DB, raw artifacts on disk,
  **disk remains the source of truth**, DB is a **derived, rebuildable index** (mirrors the
  existing `data/history/` derive-don't-rewrite philosophy).
- **Worthwhile, but deferred:** the "once... hard to query" trigger is not met yet at current
  scale (hundreds of runs; scans are sub-second). But adoption cost is near-zero, and the
  codebase has **three independent full-scan readers** that a DB naturally consolidates.
- **Slots behind the existing seam:** [ADR 0016](../docs/adr/0016-run-artifact-reader.md) already
  funneled research/scoring reads through `src/run-artifacts.ts` and *explicitly rejected* an
  injectable store "for now." A SQLite index is the anticipated evolution of that seam.

## Where we are today (baseline)

There is no single JSON index — there are **three independent full-scan readers**, none
sharing a query layer. All are O(n) full-parse:

1. **`src/run-artifacts.ts`** — the [ADR 0016](../docs/adr/0016-run-artifact-reader.md) seam.
   `scanRunArtifacts` does `readdir` + parses *every* `report.json`/`score.json` on every
   research run; callers (`historical-context`, `market-update-delta`, `scoring/index`,
   `history/artifacts`) then filter in JS.
2. **`src/history/artifacts.ts`** — `rebuildHistoryArtifacts` re-derives the entire
   `index.json` from a full scan each time `history rebuild` runs.
3. **`app/artifacts.ts`** — the Research Console, a **separate** seam. `listRunSummaries`
   walks the whole `data/runs/` tree **and recursively lists every file in every run dir** on
   each dashboard load; `searchRunReports` full-scans + substring-matches on every search.

**Worst offender:** the console (#3). It re-walks and re-parses the entire tree per page view.
That is the "hard to query" symptom appearing first, and the clearest immediate win.

**Current data layout** (all under `MARKET_BOT_DATA_DIR`, gitignored):
`runs/<id>/{report.json,report.md,score.json,normalized/*.json,trace.json,analytics.json,...}`,
plus derived `history/`, `calibration/`, `alpha-search/`, and `cache/`.

## Why SQLite specifically

- **`bun:sqlite` is built in.** `import { Database } from "bun:sqlite"`. No dependency added,
  no toolchain violation. This is the single fact that makes the DB cheap here — and it is the
  same toolchain reason that made the local-embedding option *expensive* in the semantic-search
  doc, now working in our favour.
- **`:memory:` databases** for tests — keeps the existing seam-mocking testing style intact and
  lets the disk-scan path remain a parity oracle.
- **FTS5** full-text search replaces the substring `includes()` scans in `history search` and
  the console.
- **One file, embeddable, no server** — fits a single-process local CLI.

## Proposed shape (metadata in DB, blobs on disk)

This is the user's proposal and it is the correct, standard pattern.

- **Disk stays the source of truth.** `report.json`, `report.md`, `score.json`,
  `normalized/*.json`, sidecars (`sec-fundamentals.json`, `alpha-validation.json`,
  supplemental snapshots) — all unchanged on disk.
- **DB holds queryable metadata + references**, not blobs:
  - `runs` (runId, generatedAt, jobType, assetClass, symbol, confidence, depth, findingCount,
    predictionCount, sourceCount, dataGapCount, hasScore)
  - `predictions` (id, runId, kind, subject, claim, probability, horizonTradingDays)
  - `scores` (predictionId, runId, resolved, outcome, observedAt, scoringVersion)
  - `sources` (id, runId, kind, provider, symbol, title) — optional, add when a query needs it
  - `history_fts` (FTS5 over section text) — replaces the substring search index
  - `embeddings` (runId/entryId → vector BLOB) — **optional**, ties to the semantic-search doc
  - Rows carry the **runId** (the on-disk path is derivable) — references, not copies.
- **DB is a derived, rebuildable index.** Reconstructable from `data/runs/` at any time via a
  `db rebuild` verb that mirrors `history rebuild`. Schema change or corruption → drop +
  rebuild. The "migration" story is *re-derive*, not `ALTER TABLE` on irreplaceable data — far
  lower risk than migrating canonical data.
- **Location:** a single `data/index.sqlite` (gitignored), WAL mode.

## Where it slots — behind the seam that already exists

[ADR 0016](../docs/adr/0016-run-artifact-reader.md) already funneled research/scoring reads
through one seam and *explicitly rejected* "an injectable in-memory artifact store... for now."
A SQLite index is precisely the deferred evolution that decision anticipated.

- **Behind `src/run-artifacts.ts`** — `scanRunArtifacts`/`loadRunArtifact` query SQLite and
  **fall back to a disk scan** when the DB is absent/stale. The four consumers don't change.
- **Converge the console** (`app/artifacts.ts`, the third reader) onto the same DB. Biggest UX
  payoff; removes the per-load full tree walk.
- **`history search`** substring → **FTS5**.
- **Calibration** aggregation → **SQL `GROUP BY` cadence** instead of re-scanning every
  `score.json`.
- Unifies with the semantic-search companion: embeddings live as a BLOB column / `sqlite-vec`,
  so `semantic-neighbor` and metadata queries share one store.

## Honest costs

- **Two-sources-of-truth risk** — mitigated entirely by "disk canonical, DB derived +
  rebuildable + write-through on each run." The DB is never the only copy of anything.
- **SQLite single-writer concurrency** — the score pass runs as a non-blocking side effect
  after each run, and concurrent CLI invocations are possible. Use **WAL mode + `busy_timeout`**
  (both supported by `bun:sqlite`). A single-process CLI is mostly serial anyway.
- **Write path** — each run **upserts its own rows** (incremental), not a full rebuild; keep
  `db rebuild` for full reconstruction.
- **Schema versioning** — needed, but cheap: bump a `schema_version` pragma and rebuild from
  disk, because the DB is derived.
- **Testing** — `bun:sqlite` `:memory:` for unit tests; keep the disk-scan path as fallback and
  **parity oracle** (assert DB query results == disk-scan results).
- **Scope discipline** ([AGENTS.md](../AGENTS.md) #5) — no speculative tables. Start with `runs`
  + FTS that replace existing hot scans; add `predictions`/`scores`/`sources` tables only when a
  concrete query needs them.

## Trigger — when does "hard to query" actually arrive?

Not now. Define the threshold so the decision is evidence-based, not vibes:

- **Latency:** console dashboard load or `history rebuild` crosses ~hundreds of ms because the
  full parse of `data/runs/` dominates (empirically: low thousands of runs).
- **Query expressiveness:** a wanted query cannot be expressed as "scan + JS filter" without
  re-reading everything — e.g. "all unresolved predictions on subject `SPY` across cadences,"
  reliability-over-time slices, or cross-instrument joins.
- **Semantic search lands:** vectors want a store; that pulls the DB in regardless of run count.

Any one of these crossing is the green light. Until then, the JSON scans are adequate and the
DB is correctly deferred.

## Phased design (mirrors ADR 0016's own staged migration)

1. **Read-through index.** `db rebuild` builds `data/index.sqlite` from disk; sits behind the
   ADR 0016 seam with disk fallback. Zero behavior change — pure perf/query capability.
   Parity-tested against the disk scan.
2. **Write-through.** Each run upserts its rows alongside the disk write (the existing
   non-blocking side-effect slot is the natural home).
3. **Migrate hot queries.** Console list/search → DB; `history search` → FTS5; calibration →
   `GROUP BY`. Retire the redundant full-scan paths once parity holds.
4. **(Optional, ties to doc #1)** embeddings column / `sqlite-vec` for `semantic-neighbor`.

## Open questions / decisions still needed

- [ ] **Console convergence scope** — fold `app/artifacts.ts` into the shared seam in this
      effort, or leave it independent for a later pass? (Recommended: converge — it is the
      biggest immediate win.)
- [ ] DB file granularity — single `data/index.sqlite` vs per-concern files. (Recommended:
      single file.)
- [ ] Whether `predictions`/`scores`/`sources` tables ship in phase 1 or wait for a concrete
      query (scope discipline says: wait).
- [ ] FTS5 from phase 1 vs keep JS substring until the migrate-hot-queries phase.
- [ ] `db rebuild` incremental-vs-full semantics and how staleness is detected (mtime? a
      per-run content hash, mirroring the cache's sha256 discipline?).
- [ ] Concurrency policy concretely: WAL + `busy_timeout` value; behaviour when a write loses
      the lock during the post-run side effect (retry vs defer to next `db rebuild`).
- [ ] Env var to point at / disable the DB (e.g. `MARKET_BOT_INDEX_DB` / a disable flag),
      consistent with existing `MARKET_BOT_*` config and the cache's disable knob.

## Settled by the request itself

- **Source of truth = disk.** "keep raw artifacts on disk... use db only for metadata and
  references to files." The DB never becomes the only copy.
- **SQLite as the first step**, not a client/server DB.

## Recommended next step

Draft the **ADR** (decision record only, no implementation) extending
[ADR 0016](../docs/adr/0016-run-artifact-reader.md): SQLite as a derived, rebuildable index
behind the Run Artifact seam, disk-canonical, staged per above, with the console seam
convergence called out. Optionally follow with a phase-1-only spike (`db rebuild` + read-through
+ parity test) against real `data/runs/` to measure the actual latency delta before committing
further phases.
