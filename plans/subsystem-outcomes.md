# Subsystem Outcomes: making run machinery diagnosable

Reviewed by Grok 4.6 (`cursor-grok-4.6-xhigh`, read-only) against the code;
every finding below marked **[R]** was verified independently before folding in.

## Context

Runs are densely instrumented *within* a run and nearly blind *across* runs. The
Forecast Completion Pass sat at 0% acceptance across three live runs and nine
fixtures with no signal. That is a class of defect, not one bug: a subsystem can
run, produce nothing, and leave nothing that distinguishes "produced nothing"
from "was never expected to produce anything".

Three structural causes, verified:

1. **The read seam has an analytics-shaped hole.** `loadRunArtifact`
   (`src/run-artifacts.ts:246`) never opens `analytics.json` and `RunArtifact`
   has no analytics field. The genuine duplicate scan is
   `scanWebSubjectProfileRunArtifacts` (`src/run-artifacts.ts:524-565`);
   `provider-health.ts:347` reads analytics untyped after its own walk.
2. **Nothing records that an expected subsystem produced nothing.**
3. **Failed runs carry almost no telemetry.** No `analytics.json` or
   `trace.json` (failure manifest is `src/run-artifact-writer.ts:240-301`); they
   count in neither `sourceRunCount` nor `malformedRunCount`
   (`src/run-artifact-index.ts:302-303`); `provider-health` skips them in
   `loadRunHealth` (`src/health/provider-health.ts:336-344`). They *are* indexed
   with `report_status: "absent"` and their files listed — **not invisible,
   but unusable** [R].

Intended outcome: one coded record per subsystem per run, including failed runs,
so "which subsystem has produced nothing for N runs" and "what changed after
commit X" are one query instead of a manual artifact sweep.

**Supersedes phase 4 of `plans/forecast-completion-diagnosability.md`** (five
typed columns on `runs`). Its rationale at `:555` generalizes, and each schema
change costs an operator-run `index rebuild` under the no-migration policy
(ADR 0002:77) — paying that once for a general mechanism beats paying per
subsystem. Phases 1–3 of that plan stand unchanged.

Scope honesty [R]: the completion 0% fact is *already* in successful runs'
`analytics.json`. The new value is (a) cross-run aggregation, (b) failed-run
telemetry, (c) coded skip reasons. This plan is not justified as a re-derivation
of Source Plan lanes or Source Gaps, which already encode expectation vs outcome
for the evidence half.

## Domain vocabulary

**Subsystem Outcome** — a coded record of what one run subsystem decided,
produced, or declined to produce. Deliberately *not* "Diagnostic":
`CONTEXT.md:335` binds that to an appendix-only, non-material Source Gap.

- `expectation`: `expected | optional | not-applicable`
- `outcome`: `produced | empty | declined | failed | blocked`

`blocked` is load-bearing [R]: on the only persisted failure path, prediction
completion, the integrity audit, and forecast disagreement **never execute** —
they sit after a valid report (`src/research/orchestrator.ts:838-862`;
`runPredictionCompletion` gates on one at `final-synthesis.ts:604`). Without
`blocked` they would be recorded as `expected × empty` and light up the
silent-subsystem query on every aborted run — the exact mislabelling this work
exists to prevent. `blocked` also covers deep-equity dependents suppressed by a
missing SEC base packet (`src/sources/collector.ts:396-413`, ADR 0004) and
reused Web Subject Profiles.

Silence stays derived: `expected` × `empty`.

## Commit 1 — analytics reader (narrowed)

- Add `src/run-artifact-analytics-reader.ts` beside the report / score /
  snapshot / evidence readers; filename already at
  `src/run-artifact-layout.ts:21`.
- **No `RunArtifact.analytics` field** [R]. ADR 0002:65-67 keeps single-consumer
  sidecars with their owner, and an eager field would tax every
  `scanRunArtifacts` caller (history, historical-context, market-update-delta).
  Consumers call the reader directly.
- Collapse only the two real duplicates: `scanWebSubjectProfileRunArtifacts`
  (`run-artifacts.ts:564-565`) and the untyped read in `provider-health.ts:347`.
  Leave `app/artifacts.ts` alone — `readRunDetail` is a single-run console
  loader, not a scan.

## Commit 2 — the outcome model and its sidecar

- New module: `SubsystemOutcome`, the two unions, exhaustive
  `satisfies Record<Union, true>` table plus runtime guard, following
  `src/domain/source-gaps.ts:14-73`.
- **Expectation comes from persisted decisions and gate codes, not from
  re-calling predicates** [R]. `completionEligible`
  (`src/research/final-synthesis.ts:495`) and `LANE_DEFINITIONS`
  (`src/research/source-plan.ts:298`) are **not exported**, and
  `isWebGatherLoopEnabled` (exported, `web-gather-loop.ts:427`) returns a bare
  boolean that loses *which* of four gates fired. Therefore:
  - Record a closed **skip code** at each gate for the subsystems that matter —
    completion and web gather first. Derivation copies the code; it never
    reverse-engineers it.
  - Read what is already persisted: `sourcePlan.lanes[].appliesToRun` (on both
    manifests), presence/absence of `trace.predictionCompletion`, the
    web-gather audit.
  - Do **not** export `completionEligible`; re-running it post-integrity answers
    a different question than it did inside synthesis (pruned vs unpruned
    predictions).
- **Pure derivation**, `buildSubsystemOutcomes(...)`, mirroring `run-analytics`.
- **Widen `FailedRunManifestInput`** (`src/run-artifact-writer.ts:67-89`) with
  the pre-synthesis audits the catch already holds but drops: web-gather audit,
  spotlight selection, playbook audit, and the recorded gate codes
  (`src/research/orchestrator.ts:770-812`). Post-synthesis subsystems emit
  `blocked`, never `empty`.
- Write `outcomes.json` on **both** manifests.
- Project a text-free rollup (codes and counts, ADR 0004) into `analytics.json`
  — **success path only**, since failed runs have no analytics and changing that
  would contradict the documented failure layout.

Minor wins in the same blast radius:

- Persist `SpotlightSelectionRejectionReason` (`src/research/spotlights.ts:68`),
  a closed union that today dies in memory.
- Stop `ReportIntegrityAdvisoryCode` widening to `string` at the trace boundary
  (`src/domain/types.ts:936`).

Deferred deliberately: per-stage attempt/reason (**already exists** —
`StageOutput` carries `attempt` and `repromptReason`,
`src/research/final-synthesis.ts:50`); alpha-search rejection unions; the
provider-call sidecar; persisted `run.log`; cost on the Codex path.

**Alpha-search is out of scope** [R]: it has a separate manifest
(`run-artifact-writer.ts:482-520`) and no failure sidecar. It writes no
`outcomes.json` in this slice; say so in the code rather than leaving it implied.

## Commit 3 — index

- `subsystem_outcomes(run_id, subsystem, expectation, outcome, code, stage, count, detail_json)`.
  Four edits, not one [R]:
  1. `schemaSql()` in `run-artifact-index-schema.ts`.
  2. **`resetRunArtifactIndexSchema`'s explicit drop list** (`:110-118`) — a
     table with `REFERENCES runs(run_id)` must be dropped *before* `runs` or
     rebuild throws.
  3. `RunIndexRows` (`run-artifact-index-types.ts:76-81`) gains an `outcomes`
     field; `insertDomainRows` and the write-through delete/reinsert
     (`run-artifact-index.ts:342-346`) must handle it.
  4. A read in `run-artifact-projection.ts` for the disk-scan path.
- **The existing parity test is not a forcing function** [R]
  (`tests/run-artifact-index-parity.test.ts:152-176` compares console
  list/search only). Add an explicit test asserting indexed outcomes equal
  sidecar outcomes, or the table can ship unreadable.
- Failed runs: derive their status in the row builder from the artifact file
  list, which already records `failure.json`. **Do not change
  `loadRunArtifact`'s report-ok contract** [R] — `LoadedRunArtifact` and
  `ArtifactFileStatus` are consumed by history, scoring, and index rows.
- Bump `INDEX_SCHEMA_VERSION` (currently 10) **once**. Do **not** run
  `index rebuild` — stop and ask. Write-through skips on version mismatch and
  reads degrade to a disk scan with a warning meanwhile.

## Commit 4 — surfaces

- New section in `ProviderHealthSummary` (`src/health/provider-health.ts:84-116`)
  plus rows in the flat `lines` array of `renderProviderHealthMarkdown` (`:677`).
  Bump `version` 2→3. It must read `outcomes.json` / `failure.json` — **not**
  analytics, which failed runs do not have [R].
- Stop `loadRunHealth` returning `undefined` for failed runs (`:336-344`); give
  them their own count and outcome rows. Inverts
  `tests/provider-health.test.ts:208`.
- Console digest: the success line goes beside the existing `Completion:` line
  in `run-analytics-console.ts`. **A failed run never reaches that renderer** [R]
  (`src/app.ts:332-347` writes one stderr line and rethrows), so add a minimal
  failed-run line read from `outcomes.json` in that catch. No new dashboard
  section, no new CLI verb.

## Docs

- Amend **ADR 0002** (canonical artifacts, index no-migration rule).
- Add **Subsystem Outcome** to `CONTEXT.md` in the same change.
- Update `docs/architecture.md`; note the supersession in
  `plans/forecast-completion-diagnosability.md`.

## Verification

Blast radius, verified — the plan previously named two of these:

- `tests/run-artifact-writer.test.ts:240` (`baseResearchFiles`) and
  `tests/orchestrator-failure-persistence.test.ts:104-114`, whose
  `not.toContain("analytics.json")` assertions are load-bearing, not incidental.
- `tests/run-artifact-layout.test.ts:12-88` pins every `RUN_ARTIFACT_FILES` key.
- **`GOLDEN_ROOT_FILES` is an exact-match list** (`analytics.json`,
  `report.json`, `report.md`) that *throws* on an unexpected root entry
  (`tests/support/run-fixtures/artifacts.ts:52-63`) [R]. A root `outcomes.json`
  aborts golden reading entirely. Add it to that list and to
  `scrubbedRunArtifacts` deliberately, so the ledger is golden-pinned.
- `tests/run-analytics-console.test.ts:74-82` pins the digest string exactly.
- `tests/provider-health.test.ts:208` inverts.
- **10 fixtures, not 14** [R].
- knip: an exported type used only in its own file fails the build; tests count
  as knip entries.

Steps:

- Unit tests per commit at the adapter seam: the analytics reader, the index
  row/projection round-trip, and the derivation function over a fixture audit
  bundle.
- **Required fixture** [R]: a rejected-synthesis case asserting that completion,
  integrity, and forecast disagreement come back `blocked` and are **absent**
  from the `expected × empty` set. This is the gate on the whole design — if it
  fails, the ledger is lying about exactly the runs it exists to explain.
- `bun run check` green per commit — the only thing reportable as passing.
- `--check-golden` on one fixture first to read the diff; then an **authorized**
  `--write-golden` across all 10, diff inspected, intent stated in the commit
  body per AGENTS.md:54.
- No live run. Read existing artifacts under `data/runs/`; replay fixtures.
- End state, once rebuild is authorized: a SQL query over `subsystem_outcomes`
  returning subsystems that were `expected` and `empty` across recent runs,
  sliced by `codeVersion.commit`.
