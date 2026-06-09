# Feasibility: SQLite Run Artifact Index

> Status: **Scoping decisions captured** — no ADR or implementation yet.
> Date: 2026-06-09. Author: scoping session (human + agent).
> Source: [docs/IMPROVEMENTS.md](../docs/IMPROVEMENTS.md) item #2, companion to item #1
> (semantic search — see [semantic-search-feasibility.md](./semantic-search-feasibility.md)).
> Next concrete artifact if pursued: a new ADR (next number is **0018**, or after the
> semantic-search ADR if that lands first) extending [ADR 0016](../docs/adr/0016-run-artifact-reader.md).

## Question

> "SQLite-backed Run Artifact Index once local JSON indexes become hard to query. SQLite is the
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
  codebase has **two independent full-scan readers plus a full-tree score rescan that runs on
  every research invocation** — all of which a DB naturally consolidates.
- **Slots behind the existing seam:** [ADR 0016](../docs/adr/0016-run-artifact-reader.md) already
  funneled research/scoring reads through `src/run-artifacts.ts` and *explicitly rejected* an
  injectable store "for now." A SQLite index is the anticipated evolution of that seam.

## Where we are today (baseline)

There is no single JSON index — there are **two independent full-scan readers** plus a heavy
**per-run full rescan**, none sharing a query layer. All are O(n) full-parse:

1. **`src/run-artifacts.ts`** — the [ADR 0016](../docs/adr/0016-run-artifact-reader.md) seam.
   `scanRunArtifacts` does `readdir` + parses *every* `report.json`/`score.json`; callers
   (`historical-context`, `market-update-delta`, `scoring/index`, `history/artifacts`) then
   filter in JS.
2. **`src/history/artifacts.ts`** — `rebuildHistoryArtifacts` re-derives the entire
   `index.json` from a full scan each time `history rebuild` runs.
3. **`app/artifacts.ts`** — the Research Console, a **separate** seam (does *not* use the ADR
   0016 reader). `listRunSummaries` walks the whole `data/runs/` tree **and recursively lists
   every file in every run dir** (`listArtifactFiles`) on each dashboard load; `searchRunReports`
   full-scans + substring-matches on every search.

**The real hot loop — the score pass.** Every research invocation `await`s `runScore(...)`
(`src/app.ts:166`), and `scoreAllRuns` (`src/scoring/index.ts`) does `listRunDirs` +
`loadRunArtifact` **across all historical run dirs** to re-resolve unresolved predictions. So a
full-tree O(n) parse runs on *every single run*, not just on console page loads or `history
rebuild`. It is non-*fatal* (wrapped in `.catch`) but it is **blocking** — the run does not
return until it completes. This is the heaviest recurring cost in the system and the single
strongest motivation for an index; the console is the most *visible* offender, the score pass is
the most *frequent* one.

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

## Proposed shape (metadata in DB, artifacts on disk)

This is the user's proposal and it is the correct, standard pattern.

- **Disk stays the source of truth.** `report.json`, `report.md`, `score.json`,
  `normalized/*.json`, sidecars (`sec-fundamentals.json`, `alpha-validation.json`,
  supplemental snapshots) — all unchanged on disk.
- **DB holds queryable metadata + references**, not blobs:
  - `runs` (runId, generatedAt, jobType, assetClass, symbol, confidence, depth, findingCount,
    predictionCount, sourceCount, dataGapCount, hasScore, indexFingerprint)
  - `artifact_files` (runId, path, size, modifiedAt, contentHash) — relative file inventory for
    console detail views, stale-row detection, and safe file serving
  - `predictions` (id, runId, kind, subject, claim, probability, horizonTradingDays)
  - `scores` (predictionId, runId, resolved, outcome, observedAt, scoringVersion)
  - `sources` (id, runId, kind, provider, symbol, title) — optional, add when a query needs it
  - `history_fts` (FTS5 over section text) — replaces the substring search index. Note an
    inverted index **necessarily stores a copy of the searched text**, so "references, not
    blobs" applies to *artifacts*, not to the FTS shadow. Use a **contentless or external-content
    FTS5 table** (`content=''` / `content=<table>`) so the section text is not duplicated a third
    time (disk JSON + metadata row + FTS).
  - `embeddings` (runId/entryId → vector BLOB) — **optional**, ties to the semantic-search doc
  - Rows carry the **runId** (the on-disk path is derivable) — references, not copies.
- **DB is a derived, rebuildable index.** Reconstructable from `data/runs/` at any time via an
  `index rebuild` verb that mirrors `history rebuild`. `index rebuild` means full drop-and-rederive;
  incremental sync/write-through is a separate path. Schema change or corruption → drop + rebuild.
  The "migration" story is *re-derive*, not `ALTER TABLE` on irreplaceable data — far lower risk
  than migrating canonical data.
  - **Rebuild atomically.** A long-lived reader (the Research Console) may hold the DB file open,
    so an in-place drop-and-rederive would serve a half-built index mid-rebuild. Prefer doing the
    full rebuild inside one transaction on the live DB so readers see either the old index or the
    committed new index. A temp `index.sqlite.tmp` + atomic replace is also viable, but must be
    tested on Windows with open readers and WAL sidecars before relying on it. A crashed rebuild
    must leave either the prior index or no usable index, never a half-built one.
- **Location:** a single `data/index.sqlite` by default (derived from `MARKET_BOT_DATA_DIR`),
  gitignored, WAL mode. `MARKET_BOT_INDEX_DB_PATH` relocates it; `MARKET_BOT_INDEX_DISABLE`
  forces disk-scan fallback.

### The fact that makes this cheap: most run artifacts are append-once

Run directories are mostly **immutable after creation**. `report.json`, `report.md`, and
`trace.json` are written exactly once by `writeRunOutputs` (`src/artifacts.ts`) and never mutated;
the orchestrator and alpha-search workflow also write their normalized/raw artifacts once during
run persistence. The mutable surfaces are the score-pass sidecars: `score.json`,
`alpha-validation.json`, and occasionally `normalized/candidate-profiles.json` for legacy or
backfilled alpha-search runs. This append-mostly shape is load-bearing for the whole design:

- **Staleness detection is nearly free** — no need to content-hash every file on every read. A
  cheap `readdir` of run-id directory *names* catches added/removed runs; lightweight
  mtime-or-hash checks for mutable sidecars catch the files that can change after initial
  persistence. Hashing the full tree on the read path would reintroduce exactly the O(n) cost the
  index exists to remove.
- **Write-through has a precise trigger** — score-pass sidecar writes are both the staleness
  signal and the re-index trigger (see Honest costs).

## Where it slots — behind the seam that already exists

[ADR 0016](../docs/adr/0016-run-artifact-reader.md) already funneled research/scoring reads
through one seam and *explicitly rejected* "an injectable in-memory artifact store... for now."
A SQLite index is precisely the deferred evolution that decision anticipated.

- **Behind `src/run-artifacts.ts`** — `scanRunArtifacts`/`loadRunArtifact` query SQLite and
  **fall back to a disk scan** when the DB is absent/stale/unsupported. In phase 1, stale or
  missing indexed rows trigger a global fallback for that query surface rather than mixing DB and
  disk rows. The four consumers don't change.
- **Converge the console** (`app/artifacts.ts`, the third reader) onto the same DB in phase 1.
  List, search, detail metadata, and file inventory read through the shared index; raw artifact
  file contents still come from disk by reference. Biggest UX payoff; removes the per-load full
  tree walk.
- **`history search`** substring → **FTS5**.
- **Calibration** aggregation → **SQL `GROUP BY` cadence** instead of re-scanning every
  `score.json`.
- Unifies with the semantic-search companion: embeddings can live as a plain **BLOB column** in
  this same file, so `semantic-neighbor` and metadata queries share one store. **Caveat:**
  `sqlite-vec` is a **native loadable extension** (`sqlite3_load_extension`), not an npm package —
  it is a native dependency that the spirit of [ADR 0003](../docs/adr/0003-oxc-toolchain.md) would
  scrutinize. At hundreds of runs, brute-force cosine over plain BLOBs (exactly what the
  semantic-search doc endorses) needs **zero extension**; defer `sqlite-vec` until ANN scale is
  real. **Cross-doc note:** the semantic-search doc currently says embeddings live under
  `data/history/`, "never a DB." If SQLite lands, that storage guidance goes stale — one of the
  two ADRs must explicitly own the reversal rather than leaving the docs contradictory.

## Honest costs

- **Two-sources-of-truth risk** — mitigated entirely by "disk canonical, DB derived +
  rebuildable + write-through on each run." The DB is never the only copy of anything.
- **SQLite reader/writer concurrency** — the real concurrent pair is **not** "concurrent CLI
  invocations" (rare for a personal CLI). It is the **long-lived Research Console (reader) + an
  intermittent CLI run (writer)** on the same file. That is exactly what **WAL mode** is for:
  readers never block the writer. Add a hard-coded **1000 ms `busy_timeout`** for writer-vs-writer
  contention (both supported by `bun:sqlite`). Note WAL creates `-wal`/`-shm` sidecar files next
  to the DB — covered by the wholesale `data/` gitignore. If write-through loses the lock or
  otherwise fails, log a warning, leave the index stale, and let `index rebuild` repair it later;
  never abort the research run.
- **Write path — the trigger set is wider than "the current run."** The score pass
  (`runScorePass`) resolves predictions on **old** runs and rewrites their `score.json`; it can
  also write alpha sidecars (`alpha-validation.json` and backfilled
  `normalized/candidate-profiles.json`). So after a run, the rows that go stale are **the current
  run + every historical run whose mutable sidecars the score pass rewrote** — not "its own rows."
  Write-through must upsert whatever the score pass touched. Today `scoreRunDir` only returns a
  boolean and `ScorePassResult` exposes counts, not touched run IDs/dirs, so implementation must
  extend that API before write-through can be correct. "Upsert its own rows only" would let old
  runs' `hasScore`/outcome/alpha columns silently drift until a manual rebuild. Keep
  `index rebuild` as the full reconstruction/recovery command.
- **Schema versioning** — needed, but cheap: stamp **`PRAGMA user_version`** (SQLite's own
  user-controlled integer — *not* `schema_version`, which is the internal schema cookie) and
  rebuild from disk on mismatch, because the DB is derived. Normal reads that see an unsupported
  version warn and fall back to disk; only explicit `index rebuild` drops and re-derives.
- **Testing vs. fallback are two different lifespans** — do not conflate them:
  - **Runtime fallback** (permanent): DB absent/disabled/unsupported → disk scan. This path stays
    forever; it is the guarantee that the index is optional.
  - **Test-time parity oracle** (in the test suite, not a runtime dual-path): assert DB query
    results == disk-scan results over fixtures, using `bun:sqlite` `:memory:`. Maintaining two
    *runtime* query implementations indefinitely would guarantee drift — phase 3's "retire the
    redundant full-scan paths" is about the runtime hot paths, while parity lives in tests.
- **Scope discipline** ([AGENTS.md](../AGENTS.md) #5) — no speculative tables. Start with `runs`,
  `artifact_files`, and FTS that replace existing hot scans; add `predictions`/`scores`/`sources`
  tables only when a concrete query needs them.

## Trigger — when does "hard to query" actually arrive?

Not now. Define the threshold so the decision is evidence-based, not vibes:

- **Latency:** the **per-run score pass** (`scoreAllRuns`, runs on every invocation), console
  dashboard load, or `history rebuild` crosses ~hundreds of ms because the full parse of
  `data/runs/` dominates (empirically: low thousands of runs). The score pass is the metric to
  watch first — it runs every research invocation, not just on demand.
- **Query expressiveness:** a wanted query cannot be expressed as "scan + JS filter" without
  re-reading everything — e.g. "all unresolved predictions on subject `SPY` across cadences,"
  reliability-over-time slices, or cross-instrument joins.
- **Semantic search lands:** vectors want a store; that pulls the DB in regardless of run count.

Any one of these crossing is the green light. Until then, the JSON scans are adequate and the
DB is correctly deferred.

## Phased design (mirrors ADR 0016's own staged migration)

1. **Read-through index.** `index rebuild` builds `data/index.sqlite` from disk, including FTS5 text
   entries for console and history search; sits behind the ADR 0016 seam and the Research Console
   artifact reader with disk fallback. Zero behavior change — pure perf/query capability.
   Parity-tested against the disk scan.
2. **Write-through.** After the disk write (`writeRunOutputs`) and the score pass, upsert the
   affected rows: the new run **and every run whose mutable score-pass sidecars were rewritten**.
   This requires extending the score-pass result/plumbing to expose touched run IDs or dirs.
   Failures are logged and non-fatal; they never abort the run.
3. **Migrate hot queries.** Console list/search/detail metadata/file inventory → DB;
   `history search` → FTS5. Retire the redundant full-scan paths once parity holds.
4. **Normalize domain query tables.** Add `predictions`, `scores`, and `sources` when calibration,
   reliability slices, unresolved-prediction views, or source-provider history queries move to SQL.
5. **(Optional, ties to doc #1)** embeddings **BLOB column** with brute-force cosine for
   `semantic-neighbor`; reach for the native `sqlite-vec` extension only if ANN scale demands it.

## Open questions / decisions still needed

- [x] **Console convergence scope** — fold all Research Console artifact reads into the shared
      phase-1 scope, while keeping raw artifact file content on disk and reading it by reference.
- [x] DB file granularity — use a single `data/index.sqlite`, not per-concern files.
- [x] `predictions`/`scores`/`sources` belong in the long-term plan, but wait for later phases
      backed by concrete calibration, reliability, unresolved-prediction, or source-history
      queries.
- [x] FTS5 belongs in phase 1 for console and history text search; caller migration waits for
      parity checks.
- [x] Staleness leans on the **append-mostly run layout**: a cheap `readdir` of run-id names
      catches added/removed runs, and lightweight mtime-or-hash checks for score-pass sidecars
      (`score.json`, `alpha-validation.json`, and backfilled `normalized/candidate-profiles.json`)
      catch post-persistence mutations. Avoid content-hashing the whole tree on the read path —
      that reintroduces the O(n) cost the index removes. Per-file hashes in `artifact_files` are
      for detail/integrity views, not the read-path freshness gate.
- [x] Write-through re-indexes **the current run plus every run whose mutable score-pass sidecars
      were rewritten** — not the current run alone. This requires extending `ScorePassResult` (or
      equivalent score-pass plumbing) to expose touched run IDs/dirs. Failures warn and leave the
      index stale for a later rebuild; they never abort the research run.
- [x] Concurrency policy: WAL + hard-coded 1000 ms `busy_timeout`.
- [x] Env config: default DB path derived from `MARKET_BOT_DATA_DIR`; `MARKET_BOT_INDEX_DB_PATH`
      relocates it; `MARKET_BOT_INDEX_DISABLE` forces disk-scan fallback. The disable flag is a
      **permanent escape hatch** — the system must remain fully functional with it set (it is the
      recovery path when the DB is corrupt and cannot be rebuilt), so the disk-scan readers can
      never be deleted outright.

## Settled by the request itself

- **Source of truth = disk.** "keep raw artifacts on disk... use db only for metadata and
  references to files." The DB never becomes the only copy.
- **SQLite as the first step**, not a client/server DB.

## Recommended next step

Keep this as the scoped feasibility plan until the trigger threshold is met. When it is pursued,
draft an ADR extending [ADR 0016](../docs/adr/0016-run-artifact-reader.md): SQLite as a derived,
rebuildable Run Artifact Index behind the Run Artifact seam, disk-canonical, staged per above, with
Research Console convergence called out. Optionally follow with a phase-1-only spike
(`index rebuild` + read-through + parity test) against real `data/runs/` to measure the actual
latency delta before committing further phases.
