# Subsystem Outcomes: follow-ups

Everything `plans/subsystem-outcomes.md` shipped is on `master` as of
`a41b00c` (`#49`). That squash is the four commits this file used to cite
(`7c51140`, `65e2b9b`, `a19e5fa`, `5713aee`); those SHAs are not on this
branch. This file holds what that plan deliberately left out, plus findings
raised during independent review and not acted on.

Re-checked against `master` @ `a41b00c`. Nothing here is required for the
ledger to work. Item 1 is the only one that changes what the ledger *means*.

## 1. A garbled model response reads as silence

Both Web Gather implementations can finish a parse failure with
`acceptedRequests: []` and no skip code.

The deep-equity batch path does it after its optional one-shot reprompt
(`src/web-evidence/web-gather-loop.ts:322-338`). `runJsonToolLoop` does it
without a parse retry: first unparseable round records a malformed gap, then
`break`s (`src/research/json-tool-loop.ts:111-116`, `165-176`).

Since Commit 2, "no persisted skip code" means the loop genuinely attempted, so
`webGatherOutcome` records `expected × empty` with code `no-accepted-requests`
(`src/research/subsystem-outcomes.ts:170-193`). That is indistinguishable from a
loop that ran correctly and found nothing. The gap exists on collected sources.
It never reaches the ledger.

That is the one place the ledger currently conflates a stage failure with
genuine silence, which is the distinction it exists to draw. `failed` is
already in the outcome union. Spotlights, prediction-completion, and
forecast-disagreement use it. Web Gather does not. The unit test locks the
wrong mapping in (`tests/subsystem-outcomes.test.ts:106-124`).

Shape of the fix: persist a closed terminal failure code on the Web Gather
audit in both loop implementations, map it in `buildSubsystemOutcomes`, add
focused tests. `failed` should apply only once parse retries are exhausted, not
on the first unparseable response. The json-tool loop currently has no parse
retry, so that rule is incomplete there until a retry exists or the first
unparseable round is defined as exhausted.

No report schema change, no index migration. Goldens move only if a fixture
exercises malformed output. None does today.

## 2. Two enumerations feed one health page

`runCount` and `failedRunCount` come from `listRunDirs` plus `loadRunHealth`
(disk, `src/health/provider-health.ts:180-186`, `645-682`). `ledgerStatus`
comes from the index when it is fresh (`:651-652`).

The earlier write-up claimed a run written but not yet indexed would show
"Failed runs: 3" beside ledger counts summing to 2. `indexIsFresh` compares
the disk directory set to indexed `run_dir_name`s and falls back to a disk
scan when they differ (`src/run-artifact-index-freshness.ts:43-52`), so that
exact case is what the stale check is for.

A TOCTOU remains. `listRunDirs` runs before the ledger load. A directory that
appears in between can still desync the two numbers.

The table also invites a false comparison even when both enumerations agree.
"Failed runs" is `failure.json` count. Ledger ok/absent/malformed is
outcome-file status for every run. Those are not supposed to match. Cosmetic,
but it is the kind of inconsistency that costs an hour because each number is
individually correct for a different question.

**Done** on `feature/subsystem-outcomes-followups`: one run-directory snapshot
feeds Failed Run Artifacts and outcome-ledger status; markdown copy names the
two denominators.

## 3. `ON DELETE CASCADE` is documentation, not a guarantee

`openRunArtifactIndexDatabase` (`src/run-artifact-index-schema.ts:6-14`) never
sets `PRAGMA foreign_keys = ON`. Bun SQLite reports `foreign_keys: 0` on a
fresh in-memory database. The `REFERENCES runs(run_id)` clause and the cascade
on `subsystem_outcomes` (`:109-119`) are inert.

Nothing relies on enforcement today, and the three orderings that matter are
already correct by construction and would stay correct if the pragma were
enabled: rebuild inserts every `runs` row before `insertDomainRows`;
write-through deletes children before the parent and re-inserts in the reverse
order; reset drops `subsystem_outcomes` above `runs`. The only `DELETE FROM`
paths in `src/` are those write-through statements.

The standing caveat is the one that bites: any future delete path must remove
children itself. Enabling the pragma is its own change, with its own audit of
every existing delete.

**Done** on `feature/subsystem-outcomes-followups`: `PRAGMA foreign_keys = ON`
in `openRunArtifactIndexDatabase`; rebuild / write-through / reset orderings
unchanged; cascade and orphan-insert covered by tests.

## 4. Machine-safe outcome codes, if wanted, belong at write time

A read-path guard on `code` was described as built during Commit 4 and
reverted. That revert is not reconstructable on this branch (`#49` landed as
squash `a41b00c`). Current code matches the intended end state.

`isSubsystemOutcome` only requires `code` to be a string
(`src/research/subsystem-outcomes.ts:87-100`). `markdownTableCell` already
flattens newlines and escapes `|` (`src/health/provider-health.ts:699-701`).
A kebab check on read would turn a rendering concern into a data-validity
verdict one layer too deep: a future non-kebab code would type-check, lint,
pass knip, write to `outcomes.json`, and then be discarded on read, taking
the run's entire ledger with it under the all-or-nothing projection
(`src/run-artifact-projection.ts:54-70`) and surfacing only as an incremented
"Ledger malformed" row.

If machine-safe codes are genuinely wanted, the layer is compile-time: narrow
`SubsystemOutcome["code"]` to a union, or assert in `buildSubsystemOutcomes`
at write. Do not reintroduce a runtime tripwire with no compile-time
counterpart.

**Done** on `feature/subsystem-outcomes-followups`: `WrittenSubsystemOutcome.code`
is the write-time union of codes builders emit; `buildSubsystemOutcomes` asserts
membership before persist. `SubsystemOutcome.code` stays `string`, so
`isSubsystemOutcome` is a sound untrusted-read guard for historical artifacts.

## 5. Deferred by the original plan

Listed here so they stay visible rather than being rediscovered:

- **Per-stage attempt and reason.** Already exists on synthesis
  `StageOutput` (`attempt`, `repromptReason`,
  `src/research/final-synthesis.ts:50-58`). `WebGatherStageOutput` does not
  carry those fields.
- **Alpha-search rejection unions.** Alpha-search has a separate manifest
  (`src/run-artifact-writer.ts:526-566`; the original plan cited `482-520`,
  now market-update sidecars) and no failure sidecar. It writes no
  `outcomes.json`, and the code says so rather than leaving it implied.
- **The provider-call sidecar.** Still unimplemented. Product call, not a
  ledger defect.
- **Persisted `run.log`.** Same.
- **Cost on the Codex path.** Same.

## Where the ledger stands

The index was rebuilt at schema v11 after `#49`: 4 runs, 0 malformed. All four
predate the feature, so every `outcomes_status` is `absent` and
`subsystem_outcomes` is empty. The silent-subsystem query runs clean and returns
nothing, correctly. The ledger fills from the next run onward, and only then
does the cross-run question the original plan set out to answer become
answerable.
