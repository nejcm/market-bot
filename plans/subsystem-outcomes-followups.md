# Subsystem Outcomes: follow-ups

Everything `plans/subsystem-outcomes.md` shipped is on `master` as of
`7c51140`, `65e2b9b`, `a19e5fa`, `5713aee`. This file holds what that plan
deliberately left out, plus findings raised during independent review of those
four commits and consciously not acted on.

Nothing here is required for the ledger to work. The first item is the only one
that changes what the ledger *means*.

## 1. A garbled model response reads as silence

`runWebGatherLoop`'s malformed-model-output path (`src/web-evidence/web-gather-loop.ts:322-330`)
returns an audit with `acceptedRequests: []` and no skip code. Since Commit 2,
"no persisted skip code" means the loop genuinely attempted, so the run records
`expected × empty` with code `no-accepted-requests` — indistinguishable from a
loop that ran correctly and found nothing.

That is the one place the ledger currently conflates a stage failure with
genuine silence, which is the distinction it exists to draw. `failed` is already
in the outcome union and unused on this path.

Shape of the fix, as scoped during the Commit 2 review: `failed` should apply
only once parse retries are exhausted, not on the first unparseable response.
Cost is a closed terminal failure code persisted on the Web Gather audit in both
loop implementations, a mapping in `buildSubsystemOutcomes`, and focused tests.
No report schema change, no index migration. Goldens move only if a fixture
exercises malformed output — none does today, which is also why no test covers
it.

## 2. Two enumerations feed one health page

`runCount` and `failedRunCount` come from `listRunDirs` (disk,
`src/health/provider-health.ts:180`); `ledgerStatus` comes from the index when
it is fresh (`:651`). A run written but not yet indexed makes "Failed runs: 3"
sit beside ledger counts summing to 2 on the same page.

Cosmetic, but it is the kind of inconsistency that costs an hour to diagnose,
because both numbers are individually correct.

## 3. `ON DELETE CASCADE` is documentation, not a guarantee

`openRunArtifactIndexDatabase` (`src/run-artifact-index-schema.ts:6-15`) never
sets `PRAGMA foreign_keys = ON`, and SQLite defaults it off. The
`REFERENCES runs(run_id)` clause and the cascade on `subsystem_outcomes` are
inert.

Nothing relies on enforcement today, and the three orderings that matter are
already correct by construction and would stay correct if the pragma were
enabled: rebuild inserts every `runs` row before `insertDomainRows`;
write-through deletes children before the parent and re-inserts in the reverse
order; reset drops `subsystem_outcomes` above `runs`.

The standing caveat is the one that bites: **any future delete path must remove
children itself.** Enabling the pragma is its own change, with its own audit of
every existing delete.

## 4. Machine-safe outcome codes, if wanted, belong at write time

A read-path guard on `code` was built during Commit 4 and reverted. It was
justified by a markdown-injection risk that `markdownTableCell`
(`src/health/provider-health.ts:700-702`) already handles, and it turned a
rendering concern into a data-validity verdict one layer too deep: a future
non-kebab code would type-check, lint, pass knip, write to `outcomes.json`, and
then be discarded on read — taking the run's entire ledger with it under the
all-or-nothing projection, surfacing only as an incremented "Ledger malformed"
row.

If machine-safe codes are genuinely wanted, the layer is compile-time: narrow
`SubsystemOutcome["code"]` to a union, or assert in `buildSubsystemOutcomes`
at write. Do not reintroduce a runtime tripwire with no compile-time
counterpart.

## 5. Deferred by the original plan

Listed here so they stay visible rather than being rediscovered:

- **Per-stage attempt and reason** — already exists. `StageOutput` carries
  `attempt` and `repromptReason` (`src/research/final-synthesis.ts:50`).
- **Alpha-search rejection unions.** Alpha-search has a separate manifest
  (`src/run-artifact-writer.ts:482-520`) and no failure sidecar; it writes no
  `outcomes.json`, and the code says so rather than leaving it implied.
- **The provider-call sidecar.**
- **Persisted `run.log`.**
- **Cost on the Codex path.**

## Where the ledger stands

The index was rebuilt at schema v11 after `5713aee`: 4 runs, 0 malformed. All
four predate the feature, so every `outcomes_status` is `absent` and
`subsystem_outcomes` is empty. The silent-subsystem query runs clean and returns
nothing — correctly. The ledger fills from the next run onward, and only then
does the cross-run question the original plan set out to answer become
answerable.
