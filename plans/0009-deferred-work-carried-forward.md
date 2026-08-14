# Plan 0009 — Work carried forward from plans 0006–0008

**Status: Decided, not started** — as of 2026-08-14.

## Problem

Plans 0006, 0007, and 0008 each closed their own scope and each deliberately
left something behind. Those leftovers now live in four different places — code
comments, an ADR deferral, review notes that exist only in session transcripts,
and two visible holes in a published report. Nothing tracks them together, so
they are invisible until someone re-reads a `--deep` run and notices.

Two of them are what a reader of the BNS report actually sees today
(run `2026-08-14T10-00-23-542Z-b00455cf`):

```text
Period                                   | Revenue | Net income | Operating margin | FCF
FY ending 2024-10-31 (filed 2025-12-02)  | 33.7B   | 7.9B       | —                | —
FY ending 2025-10-31 (filed 2025-12-02)  | 37.7B   | 7.8B       | —                | —
```

All **6 of 6** Financial Trends rows render a bare `—` with no reason, while the
valuation table beside them annotates every absence. And **10 of 10** valuation
rows carry `— (debt-unavailable)`, so EV/revenue never computes for a bank at
all.

The rest are structural: a class of silent artifact-read failure that has now
shipped three separate times, each caught only by executing against real data
rather than by `bun run check`.

## Investigation

Verified against the working tree, not assumed.

- **All prior plans are closed.** 0006 `a6b696a..3d0e6d4`, 0007
  `91227a8..dbc2bb2`, 0008 as of 2026-08-14. No unchecked items remain in
  `plans/`.
- **The version-gate hazard is real but not yet live.** Six extended-evidence
  readers hard-gate `value.version !== 1`
  ([capital-ownership.ts:187](../src/sources/extended-evidence/capital-ownership.ts),
  [financial-statements-contract.ts:333](../src/sources/extended-evidence/financial-statements-contract.ts),
  [reverse-dcf.ts:404](../src/sources/extended-evidence/reverse-dcf.ts),
  [subsequent-financing.ts:65](../src/sources/extended-evidence/subsequent-financing.ts),
  [untagged-financial-table-validation.ts:188](../src/sources/extended-evidence/untagged-financial-table-validation.ts),
  [valuation-workbench-contract.ts:338](../src/sources/extended-evidence/valuation-workbench-contract.ts)).
  A sweep of all 54 evidence bundles currently shows 212 nodes and 0 drops, so
  nothing is being lost today — but the first schema bump silently drops every
  older artifact, exactly as a retired enum value and a retired string literal
  each already did.
- **The precedent for the fix already exists in the repo.**
  [run-artifacts.ts:909](../src/run-artifacts.ts) accepts `version !== 1 && version !== 2`,
  i.e. two versions. The other six readers simply never adopted it.
- **`bun run check` cannot catch this class.** Goldens regenerate to the current
  schema and self-heal; the committed corpus contains zero stale values. This is
  recorded in the ADR 0007 amendment. `tests/fixtures/artifacts/` exists as the
  frozen counterpart and currently holds two artifacts.
- **knip is inert here**, so unused exports are not reported —
  `ValuationPriceSelectionRule` is exported with no consumer outside its own
  file, and nothing flagged it.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| One plan or several | One plan, independent phases | The items share no code. Phases may ship in any order and in separate commits; grouping them only stops them being forgotten. |
| Annotate absent Trends columns | Yes, reuse the valuation table's existing absence vocabulary | A bare `—` is indistinguishable from "zero" and from "not applicable to this issuer". The neighbouring table already solved this. |
| Bank debt concepts | Map `Deposits` and `Borrowings` to the debt input | Without it EV/revenue is structurally impossible for every bank, not merely missing for BNS. |
| Version gates | Accept an explicit set of readable versions, mirroring `run-artifacts.ts` | Same shape as the two compatibility fixes already shipped, and the ADR 0007 rule already prescribes it. |
| Reader failure mode | **Open — decide in Phase 4 before building** | Per-observation degradation and a typed parse error are materially different contracts. This is the one item here that is genuinely undecided. |
| Marked ceilings in code | Watch list, no action | They are deliberate simplifications with stated triggers, not debt. Acting on them without the trigger is speculative work. |

## Non-goals

- **Do not convert statements or the headline observed price.** Still binding
  from plan 0008.
- **Do not widen any reader to accept arbitrary input.** Trading a silent drop
  for silent acceptance of malformed data is worse than the defect.
- **Do not regenerate `tests/fixtures/artifacts/`.** It is frozen by design; a
  routine "refresh fixtures" is precisely how that protection is lost.
- No new dependencies. Bun + oxc only (ADR 0002).

## Phases

### Phase 1 — Annotate absent Financial Trends columns

Files: `src/report/markdown.ts` (Financial Trends renderer)

Operating margin and FCF render as bare `—` on all 6 BNS rows. Give each absence
a reason, consistent with how the valuation table annotates its own. Where a
metric is not merely missing but inapplicable to the issuer's industry, say so —
that is a different statement from "we could not compute it".

Verification: `bun run check`, then re-run `equity BNS --deep` and confirm no
bare `—` remains in the Trends table.

### Phase 2 — Compute EV/revenue for banks

Files: `src/sources/extended-evidence/` (industry concept mapping)

Banks do not tag `Borrowings` the way the debt input expects, so `debt-unavailable`
blocks EV/revenue on 10 of 10 BNS rows. Map the concepts a bank actually files —
`Deposits`, `Borrowings`, subordinated debentures — onto the debt input.

Deposits are a bank's operating liability, not leverage in the industrial sense;
decide explicitly whether they belong in enterprise value and record the reasoning
in the plan before implementing. Getting this wrong produces a plausible EV that
is wrong by an order of magnitude — the same failure shape as an inverted FX rate.

Verification: `bun run check`, then re-run `equity BNS --deep`. A computed
EV/revenue must reconcile by hand against the filed balance sheet.

### Phase 3 — Version-gate compatibility across the six readers

Files: the six `version !== 1` readers listed in Investigation

Accept an explicit set of readable versions per reader, mirroring
[run-artifacts.ts:909](../src/run-artifacts.ts) and the retired-value pattern
already in `valuation-workbench-contract.ts`. Keep the live union typed so new
code can emit only the current version.

Add one frozen fixture per reader under `tests/fixtures/artifacts/`, taken from
real on-disk data, asserting it still parses. Prove each guards by removing its
compatibility entry in a scratch copy and watching the test fail.

Verification: `bun run check`, plus a sweep of all six readers over every
`data/runs/*/normalized/evidence-bundle.json` reporting node count and drops.
Expect 0 drops.

### Phase 4 — Decide the reader failure mode

Files: ADR 0007, then whichever readers the decision touches

The root cause behind Phase 3 and behind both defects shipped during plan 0008:
readers validate all-or-nothing, so one unrecognized value anywhere returns
`undefined` for the entire artifact — indistinguishable from an artifact that was
never produced. Phases 3 and the two shipped fixes all patch instances.

Decide between:

- **Per-observation degradation** — drop only the unreadable observation, keep the
  rest. Risk: a partially-read artifact silently under-reports.
- **A typed parse error instead of `undefined`** — the caller learns that a parse
  failed and why. Risk: every call site must handle it.

Do not build until the choice is recorded. Amend ADR 0007 with the decision and
its reasoning, superseding the current deferral note.

Verification: `bun run check`.

### Phase 5 — FX follow-ups

Files: `src/sources/yahoo-fx.ts`, `tests/fixtures/runs/`

Carried from plan 0008's review:

- **No fixture exercises the converted path end to end.** All nine run fixtures
  are USD/USD, so conversion is covered only by unit tests and a manual BNS run.
  Add one FPI run fixture with a currency mismatch.
- **`fetch-failed` is reported as `provider-data-missing`.** `fetchYahooCloseWindow`
  returns `[]` for both an empty series and a failed request, so the FX layer
  cannot distinguish them. Fixing it means changing that function's return
  contract — check the blast radius on its other callers first.
- **No close cache or collector rate limiting on the FX path.** Resilience and
  circuit-breaking are present; caching is not. One fetch serves a whole table,
  so this only matters once many FPI runs are in flight.
- **`reverse-dcf.ts` carries `input-currency-mismatch`**, the direct analogue of
  the reason retired in plan 0008. It needs no compatibility entry while it is
  still a live emitted reason — but it will the moment FX conversion is extended
  there.

Verification: `bun run check`.

### Phase 6 — Hygiene

- **knip reports nothing here**, so unused exports go uncaught. Either make it
  effective or stop treating it as coverage; a check that cannot fail is worse
  than no check because it reads as protection.
- `ValuationPriceSelectionRule` is exported with no external consumer.
- [scoring/index.ts:743](../src/scoring/index.ts) — miss autopsies are not
  hydrated into the index, so even a warm index re-reads every run directory
  from disk. Store the autopsy cause in the index row.

Verification: `bun run check`.

## Watch list — deliberate ceilings, no action

These are marked simplifications with stated triggers. Act only when the trigger
fires; acting sooner is speculative.

| Location | Ceiling | Trigger |
| --- | --- | --- |
| [yahoo-fx.ts:7](../src/sources/yahoo-fx.ts) | 7-day FX lookback | An observed gap longer than 7 days |
| [financial-statement-selection.ts:45](../src/sources/extended-evidence/financial-statement-selection.ts) | Off-canonical ~350-day stub spans never bucket | A filer whose stub period matters to a published number |
| [financial-statements.ts:130](../src/sources/extended-evidence/financial-statements.ts) | Calendar-year fiscal labels | A Jan-31 filer (most retailers) — `2018-01-31` yields FY2018 where the filer says FY2017 |
| [offline-financial-corpus-compare.ts:94](../tests/support/offline-financial-corpus-compare.ts) | Parity comparison ignores `fy` | Golden locking stops covering the difference |

## Risk

**Phase 2 is the dangerous one.** Like plan 0008's FX direction, a wrong debt
mapping produces a confident number rather than a visible failure — and an EV
that silently omits or double-counts a bank's deposit base is wrong by an order
of magnitude while still rendering as a plausible multiple. It needs a hand
reconciliation against the filed balance sheet, not a passing test.

**Phase 4 is the one that pays down principal.** Phases 3, and both fixes already
shipped, are instance patches on the same root cause. Deferring it again is
defensible; doing so silently is not.

Phases 1, 5, and 6 are low risk.

## Objective check

- No bare `—` remains in the Financial Trends table; every absence carries a
  reason, and inapplicable-to-industry reads differently from not-computable.
- A bank produces a computed EV/revenue that reconciles by hand against its filed
  balance sheet.
- All six extended-evidence readers accept their historical versions; a sweep of
  every evidence bundle reports 0 dropped nodes.
- Each version-compatibility entry has a frozen fixture that fails when the entry
  is removed.
- ADR 0007 records a decision on the reader failure mode, not a deferral.
- A run fixture exercises the FX-converted path end to end.
- knip either reports something real or is no longer counted as a check.
- `bun run check` passes.
