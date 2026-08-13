# Plan 0006 — 40-F annual facts, and the remaining contracts from 0004/0005

**Status: Decided, not started** — as of 2026-08-14.

Supersedes the 2026-08-13 draft of this file. Three of that draft's five findings
were wrong; the corrections are recorded inline below so they are not
re-proposed.

## Problem

Plans 0004 and 0005 are merged and each deliberately left named items open. This
plan collects them, corrects the draft's misreadings, and is explicit about what
stays undone.

One item turned out to be a real correctness defect in published research, not
housekeeping: **we derive zero annual financial facts for Canadian MJDS filers,
silently.**

## Validation

Verified in source at `c84330a` and against live SEC data on 2026-08-14.

### 1. `40-F` is dropped, and that is wrong

`canonicalizeSecForm` ([financial-statements.ts:95](../src/sources/extended-evidence/financial-statements.ts))
accepts only `10-K`, `10-Q`, `20-F`, `6-K`.

Live `data.sec.gov/api/xbrl/companyfacts`:

| Issuer | CIK | `40-F` entries | `10-K`/`20-F` entries |
| --- | --- | ---: | ---: |
| Bank of Nova Scotia | 947263 | 3187 (+ 7499 `6-K`) | **0** |
| Canadian Pacific | 16875 | 2610 (+ 636 `40-F/A`) | present |
| Shopify | 1594805 | 2677 | present |

For a pure MJDS filer every annual fact is discarded. `selectTaxonomy`
([:313](../src/sources/extended-evidence/financial-statements.ts)) still finds a
taxonomy from the surviving `6-K` facts, `periodType`
([:392](../src/sources/extended-evidence/financial-statements.ts)) classifies all
of them `interim`, and the artifact ships with empty annual series and **no gap
explaining why**. That is the silent-wrongness class this repo exists to avoid.

The IFRS path this needs already exists and is already exercised: `TAXONOMIES`
([:70](../src/sources/extended-evidence/financial-statements.ts)) is
`["us-gaap", "ifrs-full"]`, and IFRS `20-F` filers run through it today. FPIs
using IFRS — explicitly including MJDS filers on `40-F` — have been XBRL-tagged
since fiscal years ending 2017-12-15 and iXBRL-mandatory since 2021-06-15.

**Correction to the draft.** The draft called this an unresolved three-way
disagreement between `canonicalizeSecForm`, `SecFilingForm`, and
`REUSE_BASIS_FORMS`. It is not. The divergence is *documented* at
[web-subject-profile-reuse.ts:54](../src/web-evidence/web-subject-profile-reuse.ts):
"Financial Statements intentionally rejects 40-F; reuse needs only filing
metadata, not facts." The draft read the constant and not the comment block
introducing it. The comment is a wrong decision, not a missing one, and this plan
corrects it rather than discovering it.

### 2. Widening `canonicalizeSecForm` alone is inert — or harmful

Annual classification is gated separately, restating the same pair three times:

- [:278](../src/sources/extended-evidence/financial-statements.ts) — `taxonomyScore`
- [:340](../src/sources/extended-evidence/financial-statements.ts) — `selectReportingCurrency`
- [:392](../src/sources/extended-evidence/financial-statements.ts) — `periodType`

Each reads `fact.canonicalForm === "10-K" || fact.canonicalForm === "20-F"`. Admit
`40-F` without touching them and every `40-F` fact is labelled `interim` —
strictly worse than dropping it, because it now pollutes interim series and TTM
inputs.

A fourth restatement lives in `hasFinancialStatementFactShape`
([financial-statements-contract.ts:207-218](../src/sources/extended-evidence/financial-statements-contract.ts)),
which spells out all 8 `form` literals and all 4 `canonicalForm` literals.

**This is the actual "sets must agree" defect.** One domain concept — *annual
report form* — written out four times in three files.

### 3. Do not derive the accepted set from `SecFilingForm`

**Correction to the draft.** The draft proposed deriving the accepted set from
`SecFilingForm` so "the three sets agree by construction". That is incoherent:
`SecFilingForm` contains `8-K`, which is in neither other set, and
`CanonicalSecForm` contains `6-K`, which `REUSE_BASIS_FORMS` deliberately
excludes with a five-line rationale at
[:50-52](../src/web-evidence/web-subject-profile-reuse.ts). They are three
different sets modelling three different questions:

| Set | Question |
| --- | --- |
| `SecFilingForm` | what the evidence tool can request from EDGAR |
| `CanonicalSecForm` | what companyfacts canonicalisation supports |
| `REUSE_BASIS_FORMS` | what establishes a profile-reuse basis |

Collapsing them would be a modelling error. The only true relationship is
*subset*: every canonical form must be a producible form. That is expressible and
worth asserting; equality is not.

### 4. The `factLedger` floor is only half-missing

**Correction to the draft.** The draft said the reader does not enforce "at least
one cited fact". [run-artifacts.ts:1316-1317](../src/run-artifacts.ts) already
rejects `factLedger.length === 0`. What is missing is only the **cited** half:
`readWebSubjectProfileFacts`
([report-extras-contract.ts:340-352](../src/report/report-extras-contract.ts))
admits a fact whose `sourceIds` is `[]`. Reachable only via hand-edited or
corrupted disk data.

### 5. One producer/consumer pair remains unverified

Plan 0005's Phase 2c triaged 70 `metrics: {` sites in `tests/` and found exactly
one worth converting: FRED macro metrics. Producer `buildFredMacroMetrics`
([fred.ts:91](../src/sources/fred.ts)) via `collectFredMarketContext`; consumer
`addMarketContextToRegime` ([regime.ts:204](../src/research/regime.ts));
hand-built at `tests/regime.test.ts:179` and
`tests/support/orchestrator-helpers.ts:100`. A wrong base metric key silently
drops the FRED regime driver while the source still appears cited.

### 6. `knip` can now fail; production mode is still inert

`c84330a` dropped `--production`. `knip.json` still declares
`entry: ["scripts/**/*.ts", "tests/**/*.ts"]`, so `src/` is reachable only through
test entries. Plain `knip` is a real gate; `knip --production` reports nothing,
and nothing documents that.

### 7. Plan documents have no durable home

`git diff .gitignore` shows an uncommitted change from `plans/` to `.plans/` and
from `/research/` to `research/`. The working directory is still `plans/`, now
untracked rather than ignored. Plans 0001–0004 are gone and unrecoverable. This
produced a contradictory read of project state between two sessions.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Ship the `40-F` change? | **Yes** | BNS-class filers lose every annual fact, silently. IFRS path already exists. |
| Derive from `SecFilingForm`? | **No** | Three different domain sets. Assert subset only. |
| How to stop the four-way restatement? | Name `ANNUAL_REPORT_FORMS` and `CANONICAL_SEC_FORMS` once | 3 → 1 call sites for a single concept; a real DRY win, unlike union-derivation. |
| Interim/TTM for MJDS filers? | **Out of scope** | BNS files tagged `6-K` interims, which collides with the `untagged-6-k` gap path. Separate question, separate plan. |
| Tighten `factLedger` on read? | Yes, narrowly | Drop uncited facts; let the existing `length === 0` gate reject the profile. One predicate, no new gate. |
| Convert `orchestrator-helpers.ts` too? | **No** | Shared by unrelated tests; coupling them all to the FRED producer buys nothing. Pin the contract once. |
| Add real `knip` entries? | **No** | Plain `knip` already reaches `src/` transitively. Production mode would find a strict subset. Document it. |
| Plan documents | **Tracked** | The cost of ignoring has already been paid once, irreversibly. |

## Non-goals

- **Do not re-open plan 0005's cuts.** Phase 4's fixture was cut because a deep
  equity run with gather attempted satisfies both the bad and the correct
  predicate, so reintroducing the bug moves none of its bytes. Phase 5's temp-copy
  mutation mechanic was cut because tests import production files by relative
  path, so a mutant copy is never loaded. Both cuts are correct. The manual
  procedure in `docs/testing.md` stands.
- **Do not mass-convert hand-built fixtures.** Phase 2c triaged all 70 and found
  one. Alpha attribution and Tradier bucketed IV were assessed and rejected.
- **Do not add prose rules.** Plan 0005's closing note is that its Phases 1b and
  2a are prose in the same medium as the rule that already failed. Nothing here
  may be satisfied by adding a sentence to `AGENTS.md`.
- **No interim or TTM work for MJDS filers.** See Decisions.
- **No general detector for semantically-wrong-but-green changes.** Plan 0005
  concluded no mechanical check reads intent; its case-4 fixture was cut for
  exactly that reason. Both sides of that gate are pinned
  (`tests/run-analytics.test.ts:1174` and `:1201`). The general class stays
  uncaught — an honest ceiling, not a gap to keep attacking.
- **No mutation testing in CI**, and no new dev dependency for it.
- **Do not remove the annotated `20-F` literal** at
  `tests/web-subject-profile-reuse.test.ts:330`. Incidental and annotated; plan
  0005's objective check overclaimed, which is a wording defect in that document.
- No new dependencies. Bun + oxc only (ADR 0002).

## Phases

Ordered so each lands independently and the one behaviour change is a two-line
diff by the time it arrives.

### Phase 1 — Track the plan documents

Files: `.gitignore`

Delete the plan-directory ignore line entirely and commit `plans/`. Note that
*reverting* the working-tree hunk would restore `plans/` to the ignore list — the
opposite of tracking it. The line goes away; it does not go back.

Separately, revert the `/research/` → `research/` hunk. That widening is
collateral from the same edit and is a footgun: it changes a root-anchored
pattern into one matching `research/` at any depth, and `src/research/` already
exists. Keep it root-anchored.

Verification: `git status` clean; `git check-ignore -v plans/0006-*.md` exits
non-zero (not ignored).

### Phase 2 — Pin the current 40-F failure, before changing it

Files: `tests/financial-statements.test.ts` (or nearest existing suite)

Add a fixture derived from a real MJDS-only companyfacts shape — `40-F` and
`40-F/A` annual entries plus `6-K` interims, `ifrs-full` taxonomy, no `10-K` or
`20-F`. Assert what happens **today**: annual series empty.

This is the evidence step. It must be a failing-in-spirit test that passes now
and flips in Phase 4, so the change has a witness that predates it.

Verification: `bun run check`.

### Phase 3 — Name the annual-report form set once (behaviour-identical)

Files: `src/sources/extended-evidence/financial-statements-contract.ts`,
`src/sources/extended-evidence/financial-statements.ts`

Pure refactor. No form is added.

1. In the contract, add `CANONICAL_SEC_FORMS` and `SUPPORTED_SEC_FORMS` as
   `as const` arrays and derive `CanonicalSecForm` / `SupportedSecForm` from them,
   rather than the reverse.
2. Add `ANNUAL_REPORT_FORMS` — currently `["10-K", "20-F"]` — with a one-line
   comment stating it means *annual report*, and a predicate
   `isAnnualReportForm(form: CanonicalSecForm): boolean`.
3. Replace the three restatements at `financial-statements.ts:278`, `:340`, `:392`
   with the predicate.
4. Replace the 12 literals in `hasFinancialStatementFactShape`
   (`financial-statements-contract.ts:207-218`) with membership checks against the
   two arrays.

Verification: `bun run check`. **Goldens must not move.** If any golden moves,
this phase is wrong — stop and diff before continuing.

### Phase 4 — Admit `40-F` as an annual report

Files: `src/sources/extended-evidence/financial-statements-contract.ts`

The only behaviour change in this plan, and after Phase 3 it is two array
entries: `"40-F"` into `CANONICAL_SEC_FORMS` and into `ANNUAL_REPORT_FORMS`.
`SupportedSecForm` picks up `40-F/A` automatically via the existing
`` `${CanonicalSecForm}/A` `` template.

Confirm `untagged-financial-tables-contract.ts:19`
(`Extract<SupportedSecForm, "6-K" | "6-K/A">`) is unaffected — `Extract` narrows,
so widening the source union cannot change it. State this in the commit rather
than assuming it.

Tests: the Phase 2 fixture flips — `40-F` and `40-F/A` canonicalise to `40-F`,
classify `annual`, and populate the annual series; existing
`10-K`/`10-Q`/`20-F`/`6-K` behaviour is byte-identical.

Verification: `bun run check`. Goldens may legitimately move if a fixture carries
a `40-F` — inspect, do not refresh blind.

### Phase 5 — Correct the reuse comment and assert the subset

Files: `src/web-evidence/web-subject-profile-reuse.ts`

1. The rationale at `:54` is now false. Replace it — `40-F` establishes a reuse
   basis *and* yields financial facts, same as `20-F`.
2. Add `satisfies readonly SecFilingForm[]` to `CANONICAL_SEC_FORMS` — the
   subset relationship that is actually true. Do **not** attempt equality; the
   `8-K` and `6-K` asymmetries are deliberate and documented.

Tests: adding an unproducible form to `CANONICAL_SEC_FORMS` fails `tsc`.

Verification: `bun run check`.

### Phase 6 — Make the `factLedger` citation floor literal

Files: `src/report/report-extras-contract.ts`

In `readWebSubjectProfileFacts:340-352`, drop facts whose `sourceIds` is empty
rather than admitting them. The existing `factLedger.length === 0` gate at
`run-artifacts.ts:1317` then rejects a profile whose ledger was entirely uncited —
no new gate.

Reject the *fact*, not the *profile*. Rejecting the profile would re-break
`686fc08` ("keep a web subject profile when only its summary is uncited").

Skip the one-off `data/runs/` scan the draft proposed: the writer at
`web-subject-profile.ts:313` cannot emit an uncited fact, so the scan finds
nothing by construction.

Tests: a fact with empty `sourceIds` is dropped; a profile with one cited fact and
an empty `subjectSummary` still round-trips, preserving plan 0004's behaviour.

Verification: `bun run check`.

### Phase 7 — Pin the FRED → regime contract

Files: `tests/regime.test.ts`

Drive the metric shape from `buildFredMacroMetrics` rather than hand-building it,
so a base metric key change cannot silently pass while `addMarketContextToRegime`
stops finding its driver. Follow the pattern at
`tests/web-subject-profile-reuse.test.ts`.

Leave `tests/support/orchestrator-helpers.ts:100` hand-built — it is scaffolding
for unrelated suites, and the contract only needs pinning once.

Tests: the regime driver test fails if the producer's metric keys change.

Verification: `bun test tests/regime.test.ts`, then `bun run check`.

### Phase 8 — Document `knip`'s mode

Files: `docs/testing.md`

Record that plain `knip` is the gate, that `knip --production` is unused here,
and why: `knip.json` declares only `scripts/**` and `tests/**` as entries, and
production mode drops the test entries, leaving nothing. Adding `src/cli.ts` as an
entry would make production mode *run* but would find a strict subset of what
plain `knip` already finds transitively.

Verification: `bun run knip` passes; confirm it can fail by temporarily adding an
unreferenced `src/` file.

### Phase 9 — Full check

```bash
bun run check
```

## Risk

Concentrated in Phase 4, and Phases 2 and 3 exist to shrink it.

Admitting `40-F` routes MJDS filings into canonical financial-fact derivation. If
a Canadian MJDS statement shape differs from what period selection assumes, the
failure mode is wrong or missing financial facts for that issuer — a correctness
problem in published research, not a crash, so CI will not surface it. Mitigation:
the IFRS path is already live for `20-F`, and Phase 2 pins the before-state on a
real MJDS payload shape so the after-state is a visible diff rather than an
assertion.

Residual, accepted: MJDS interims arrive on `6-K`, which currently routes to the
`untagged-6-k` gap even when tagged. After Phase 4 an MJDS filer gets annual facts
and possibly no TTM. That is strictly better than today's silent empty artifact
and is explicitly deferred.

Phase 3 is the sharpest hidden risk despite being a pure refactor: it touches
`hasFinancialStatementFactShape`, the artifact read guard. The golden-stability
check is the gate — treat any golden movement in Phase 3 as a defect.

Phases 1, 6, 7, 8 are low risk.

## Objective check

- `git status` is clean and `plans/` is tracked.
- A companyfacts payload containing only `40-F`, `40-F/A`, and `6-K` yields a
  populated annual series with `periodType: "annual"` on the `40-F` facts.
- The literal pair `"10-K"`/`"20-F"` appears in exactly one place in
  `src/sources/extended-evidence/`.
- Adding an unproducible form to `CANONICAL_SEC_FORMS` fails `tsc`.
- A `factLedger` fact with empty `sourceIds` does not survive a read.
- Changing a base metric key in `buildFredMacroMetrics` fails a test.
- `bun run knip` is a gate that can demonstrably fail, and its mode is documented.
