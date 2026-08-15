# Plan 0010 — Follow-ups left by plan 0009

**Status: Decided, not started** — as of 2026-08-15.

Plan 0009 is fully implemented: six phases, seven commits, on branch
`feat/0009-absences-and-artifact-drops`. `bun run check` passes at 2872 tests,
98.00% line coverage. This plan carries what 0009 deliberately did not do.

Detail on any item below lives in
[plan 0009](./0009-unexplained-absences-and-silent-artifact-drops.md) and in the
commit messages; this plan does not restate it. Plan 0009 is ready to delete
once its remaining objective-check gaps (Phase 1 and 2 here) are closed — its
ceilings already live in `NOTE — ponytail:` source comments that survive the
file.

## What shipped in 0009

| Commit | Phase |
| --- | --- |
| `e30166b` | Every absent Financial Trends cell carries a reason |
| `dc38e32` | Enterprise value inapplicable for depository issuers |
| `e67c7ae` | Explicit readable-version sets in six evidence readers |
| `bd4652a` | Per-observation degradation with recorded drops; ADR 0007 |
| `6338d3d` | Failed currency fetch distinguished from an empty series |
| `d716310` | Hygiene: secret-scanner drift guard, index autopsy cause, knip |

The branch is **unmerged and unpushed**. Remote is `origin`
(`github.com/nejcm/market-bot`). No PR was opened — neither was asked for.

## Problem

Plan 0009 closed its defects but left five things it could not or should not do
inside those phases, plus one operational step. Three are recorded gaps against
0009's own objective check; the rest are deliberate deferrals with stated
reasons. None blocks anything shipped.

## Phases

Phases are independent and may ship in any order, in separate commits.

### Phase 1 — Record the depository run fixture

No golden fixture exercises a bank path. Coverage today is unit-level: a
collector test driving real `collectSources` with SIC 6022, mutation-tested so
that deleting the three-line `extendedEvidence` pass-through fails it. That is a
genuine stopgap, not a substitute for a recorded run.

Recording needs live network, a live model key, and a live SEC user agent — all
present in the developer `.env`. It is **not** blocked on anything only the user
can supply. Three prior attempts each produced correct content and failed for a
different environmental reason:

1. The recorder's own secret scan rejected the cassette — a provider key had
   leaked into request URLs. Fixed since: `d716310` validates content before
   writing.
2. A local `.env` value for `MARKET_BOT_FORECAST_DISAGREEMENT_MODELS` was baked
   into `meta.json`, arming a replay invariant the run could not satisfy. All
   nine shipped fixtures record `challengerModels: []`.
3. The model provider timed out at 300 s.

Command, with the three environment settings the prior attempts established:

```sh
MARKET_BOT_WEB_GATHER_DISABLE=1 \
MARKET_BOT_POLYGON_API_KEY= MARKET_BOT_MASSIVE_API_KEY= \
MARKET_BOT_FORECAST_DISAGREEMENT_MODELS= \
bun run scripts/record-fixture-run.ts equity-depository-deep equity BNS --deep
```

Then re-add the fixture registration and its "no EV number on any row"
invariant, which were reverted when the recording failed.

**Do not hand-author or trim a fixture.** A fabricated one is worse than none
because it reads as coverage. If recording fails again, say why and stop.

Verification: `bun run check`, plus `--check-golden` on all fixtures.

### Phase 2 — Record the currency-converted run fixture

All existing run fixtures are USD/USD, so the converted valuation path is
exercised only by unit tests and manual runs, never end to end. Record one
foreign-private-issuer run whose quote currency differs from its reporting
currency.

Same constraints and cautions as Phase 1.

Verification: `bun run check`.

### Phase 3 — Verify or drop SIC 6712

`depositoryIssuerSic` treats SIC major group 60, plus `6120` and `6712`, as
depository. Group 60 is "Depository Institutions" in full, and `6120` is savings
and loan associations — both well grounded. `6712` (offices of bank holding
companies) was included on economic reasoning: consolidated operations are
deposit-funded. No run or fixture in the corpus carries `6712`, and it could not
be confirmed against a live filer.

Either confirm it against a real filer's submission, or drop it. It is one entry
in one `Set` in
[industry-classification.ts](../src/sources/extended-evidence/industry-classification.ts).

Note `6199` is deliberately **excluded** and should stay excluded: MARA files
under it and is a capital-markets-funded miner whose EV/revenue is meaningful.
Independently confirmed at 8.81x against on-disk run data.

Verification: `bun run check`.

### Phase 4 — Split the two oversized files

[equity-reader.ts](../src/report/equity-reader.ts) is 934 lines and
[valuation-workbench.ts](../src/sources/extended-evidence/valuation-workbench.ts)
is 880, against the architecture's hard 800-line limit. Both were already over
before plan 0009 and both grew slightly during it. Splitting was excluded from
every 0009 phase because AGENTS.md forbids bundled refactors.

This is that refactor, done deliberately and alone. Behaviour must not change:
prove it by replaying every run fixture `--check-golden` and expecting all
identical.

Verification: `bun run check`, plus all fixture goldens byte-identical.

### Phase 5 — Clear knip's same-file-only export backlog

knip is **not** broken, contrary to what plan 0009 assumed. It fails correctly on
an export with no consumer anywhere — verified by mutation, twice, independently.
Its blind spot is `ignoreExportsUsedInFile: true`, which hides exports whose only
consumer is their declaring file.

Disabling that surfaces **354 findings**: 110 values and 244 types; 275 in
`src/`, 79 in `app/`, across 104 files. Spot-checks show they are redundant
`export` modifiers on live code, not dead implementations — so this is a
mechanical modifier cleanup, not a deletion pass.

Reproduce the census with `ignoreExportsUsedInFile: false` in a temp config copy
and knip's JSON reporter; the method is recorded in
[docs/testing.md](../docs/testing.md).

Decide as part of this phase whether to keep the flag off permanently. Do not
add blanket ignores to force a green check — a suppression without a stated
reason is the false protection plan 0009 spent six phases removing.

Verification: `bun run check` with `ignoreExportsUsedInFile` disabled.

### Phase 6 — Operational: rebuild the run artifact index

Not code. `d716310` bumped `INDEX_SCHEMA_VERSION` 9 → 10 to store the miss
autopsy cause. An index built before that is correctly detected and read from
disk — no silent misread — but calibration keeps re-reading every run directory
until it is rebuilt. Warm calibration is 2–3.5x faster afterwards (measured:
200 runs 100 ms → 42 ms; 1000 runs 541 ms → 148 ms).

```sh
bun run src/cli.ts index rebuild
```

## Non-goals

- **Do not hand-shape any fixture.** Phases 1 and 2 either record real data or
  report failure.
- **Do not regenerate `tests/fixtures/artifacts/`.** Frozen by design
  ([ADR 0007](../docs/adr/0007-golden-invariance-live-correctness-invariants.md)).
  Adding a new frozen artifact is fine; regenerating an existing one is not.
- **Do not bundle Phase 4's split into another phase.** That is why it is its
  own phase.
- **Do not silence knip findings to pass Phase 5.**
- No new dependencies. Bun + oxc only
  ([ADR 0002](../docs/adr/0002-typescript-bun-orchestration.md)).

## Watch list — inherited, no action

Plan 0009's ceilings are all anchored by `NOTE — ponytail:` comments at their
locations and survive that plan's deletion. One is worth repeating here because
it is security-adjacent and newly recorded:

| Location | Ceiling | Trigger |
| --- | --- | --- |
| [record-fixture-run.ts:70](../scripts/record-fixture-run.ts) | The recorder's OS-temp tree holds an unscrubbed, unscanned run until a `finally` that SIGKILL defeats. Low risk: user-scoped tmpdir, no commit path reaches it, cache keys are SHA-256 digests of URLs already stripped of credential query params, and no golden or cassette derives from it without passing the secret scan | The window ever matters — then scrub or scan the tree mid-run |

## Risk

**Phases 1 and 2 spend live provider and model calls.** They are the only items
here with a real cost, and both have failed before for environmental reasons
rather than logic. Confirm with the user before recording.

**Phase 4 is the one that can break things silently.** A pure refactor that
changes behaviour will not announce itself; the fixture goldens are the guard.

Phases 3, 5 and 6 are low risk.

## Objective check

- A recorded depository run fixture exists, and a bank renders no numeric
  enterprise value anywhere in it.
- A recorded run fixture exercises the currency-converted valuation path.
- SIC 6712 is either verified against a real filer or removed.
- Both oversized files are under 800 lines with every fixture golden identical.
- knip's same-file-only axis is either clean or deliberately and explicitly
  left off, with the decision recorded.
- `bun run check` passes.

## Suggested skills for the next agent

- **`model-orchestration`** — invoke before starting any phase. The standing
  arrangement for this repo is **Opus 5 as Builder, GPT-5.6-sol via Codex as
  Reviewer** (the user set this explicitly and re-confirmed it). Never let the
  model that wrote a diff review it; if Claude session limits force a Codex
  build, review that round with Opus and disclose the swap.
- **`implement-plan`** — for executing a phase once its scope is settled.
- **`git-workflow`** — for the unmerged, unpushed branch and any PR.
- **`code-review`** — if a review is wanted outside the orchestration loop.

## Notes for whoever picks this up

Six phases of plan 0009 each needed at least two review rounds, and in every case
review caught something `bun run check` did not. The recurring failure was not a
missing capability but a confident claim nothing had executed: a cap that capped
nothing, an allowlist branch that could not be reached, and eight passing tests
written against provider responses the provider never sends.

Require executed evidence for every claim, and prefer a mutation test — break the
thing, watch the test fail, restore — over a passing suite. That is what caught
each of the above.
