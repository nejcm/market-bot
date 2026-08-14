# Plan 0009 — Unexplained absences in the report and silent drops in artifact reads

**Status: Decided, not started** — as of 2026-08-14.

## Problem

Two defects a reader of a `--deep` equity report sees today, and one class of
failure that hides until someone re-reads an old run.

**Absences without reasons.** In run `2026-08-14T10-00-23-542Z-b00455cf` (BNS),
the Financial Trends table renders a bare `—` for Operating margin and FCF on
every row:

```text
Period                                   | Revenue | Net income | Operating margin | FCF
FY ending 2024-10-31 (filed 2025-12-02)  | 33.7B   | 7.9B       | —                | —
FY ending 2025-10-31 (filed 2025-12-02)  | 37.7B   | 7.8B       | —                | —
```

6 of 6 rows, no reason given. A bare `—` is indistinguishable from zero, from
"not computable", and from "meaningless for this industry". The valuation table
directly beneath it annotates every one of its own absences, so the report is
internally inconsistent about how it explains missing numbers.

**EV/revenue never computes for a bank.** In the same run, all 10 valuation rows
carry `— (debt-unavailable)`. Banks do not tag borrowings the way the debt input
expects, so the metric is structurally impossible for the entire sector rather
than merely missing for one issuer.

**Artifact reads fail silently and completely.** The extended-evidence readers
validate all-or-nothing: one unrecognized value anywhere in an artifact makes the
reader return `undefined` for the whole thing, which the caller cannot tell apart
from an artifact that was never produced. This has already caused real data loss
three separate times — a retired suppression reason, a changed string literal,
and a parser guard — each time passing `bun run check` and each time found only
by executing readers against real on-disk runs. Two of the three are fixed; the
third exposure is still open, described below.

## Investigation

Verified against the working tree, not assumed.

- **Six readers hard-gate a single schema version.** `value.version !== 1` in
  [capital-ownership.ts:187](../src/sources/extended-evidence/capital-ownership.ts),
  [financial-statements-contract.ts:333](../src/sources/extended-evidence/financial-statements-contract.ts),
  [reverse-dcf.ts:404](../src/sources/extended-evidence/reverse-dcf.ts),
  [subsequent-financing.ts:65](../src/sources/extended-evidence/subsequent-financing.ts),
  [untagged-financial-table-validation.ts:188](../src/sources/extended-evidence/untagged-financial-table-validation.ts),
  and [valuation-workbench-contract.ts:338](../src/sources/extended-evidence/valuation-workbench-contract.ts).
  A sweep of all 54 evidence bundles currently reports 212 nodes and 0 drops, so
  nothing is lost today — but the first schema bump silently drops every older
  artifact, exactly as the three prior instances did.
- **The fix pattern already exists in two places in the repo.**
  [run-artifacts.ts:909](../src/run-artifacts.ts) accepts `version !== 1 && version !== 2`.
  [valuation-workbench-contract.ts](../src/sources/extended-evidence/valuation-workbench-contract.ts)
  holds two compatibility sets — one for a retired suppression reason, one for a
  retired price-selection rule — each keeping the historical value readable while
  the live typed union excludes it so new code cannot emit it. The other readers
  never adopted either shape.
- **`bun run check` cannot catch this class.** The golden corpus is regenerated
  to the current schema whenever the schema changes, so goldens self-heal; the
  committed goldens contain zero stale values. `tests/fixtures/artifacts/` exists
  as the frozen counterpart, deliberately outside golden regeneration, and holds
  two real artifacts today. This is recorded in
  [ADR 0007](../docs/adr/0007-golden-invariance-live-correctness-invariants.md).
- **knip reports nothing in this repo**, so unused exports go undetected —
  `ValuationPriceSelectionRule` is exported with no consumer outside its own file
  and nothing flagged it.
- **FX conversion is live and narrowly covered.** The valuation workbench converts
  a quote-currency close into the reporting currency using a dated Yahoo FX series
  (`<BASE><QUOTE>=X`) and records the rate, its date, the pair, and a source id on
  each observation. All nine run fixtures are USD/USD, so the converted path is
  exercised only by unit tests and by manual runs — never end to end in the suite.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| One plan or several | One plan, independent phases | The items share no code. Phases may ship in any order and in separate commits; grouping them only stops them being forgotten. |
| Annotate absent Trends columns | Yes, reuse the valuation table's existing absence vocabulary | The neighbouring table already solved this, and one report should explain absence one way. |
| Bank debt concepts | Map `Deposits` and `Borrowings` onto the debt input | Without it EV/revenue is impossible for every bank, not merely missing for one. |
| Version gates | Accept an explicit set of readable versions per reader | Same shape as the two compatibility sets already shipped, and the rule [ADR 0007](../docs/adr/0007-golden-invariance-live-correctness-invariants.md) prescribes. |
| Reader failure mode | **Open — decide in Phase 4 before building** | Per-observation degradation and a typed parse error are materially different contracts. This is the one genuinely undecided item here. |
| Marked ceilings in code | Watch list, no action | They are deliberate simplifications with stated triggers, not debt. Acting without the trigger is speculative. |

## Non-goals

- **Do not convert financial statements or the headline observed price.** The
  reporting currency stays as filed, and the price at the top of a report is the
  real market price in its real currency. Only valuation-multiple inputs are
  converted.
- **Do not widen any reader to accept arbitrary input.** Trading a silent drop for
  silent acceptance of malformed data is worse than the defect.
- **Do not regenerate `tests/fixtures/artifacts/`.** It is frozen by design; a
  routine "refresh fixtures" is precisely how that protection is lost.
- No new dependencies. Bun + oxc only ([ADR 0002](../docs/adr/0002-typescript-bun-orchestration.md)).

## Phases

### Phase 1 — Annotate absent Financial Trends columns

Files: `src/report/markdown.ts` (Financial Trends renderer)

Operating margin and FCF render as bare `—` on all 6 BNS rows. Give each absence
a reason, consistent with how the valuation table annotates its own. Where a
metric is inapplicable to the issuer's industry rather than merely uncomputable,
say so — those are different statements and a reader cannot currently tell them
apart.

Verification: `bun run check`, then re-run `equity BNS --deep` and confirm no
bare `—` remains in the Trends table.

### Phase 2 — Compute EV/revenue for banks

Files: `src/sources/extended-evidence/` (industry concept mapping)

`debt-unavailable` blocks EV/revenue on 10 of 10 BNS rows because banks do not
tag borrowings the way the debt input expects. Map the concepts a bank actually
files — `Deposits`, `Borrowings`, subordinated debentures — onto that input.

Deposits are a bank's operating liability, not leverage in the industrial sense.
Decide explicitly whether they belong in enterprise value and record the reasoning
here before implementing. Getting it wrong produces an EV wrong by an order of
magnitude that still renders as a plausible multiple.

Verification: `bun run check`, then re-run `equity BNS --deep`. A computed
EV/revenue must reconcile by hand against the filed balance sheet.

### Phase 3 — Version-gate compatibility across the six readers

Files: the six `version !== 1` readers listed in Investigation

Accept an explicit set of readable versions per reader, mirroring
[run-artifacts.ts:909](../src/run-artifacts.ts) and the compatibility sets in
[valuation-workbench-contract.ts](../src/sources/extended-evidence/valuation-workbench-contract.ts).
Keep the live union typed so new code can emit only the current version.

Add one frozen fixture per reader under `tests/fixtures/artifacts/`, copied
faithfully from real on-disk data and never hand-shaped, asserting it still
parses. Prove each guards by removing its compatibility entry in a scratch copy
outside the repo and watching the test fail.

Verification: `bun run check`, plus a sweep of all six readers over every
`data/runs/*/normalized/evidence-bundle.json` reporting node count and drops.
Expect 0 drops.

### Phase 4 — Decide the reader failure mode

Files: [ADR 0007](../docs/adr/0007-golden-invariance-live-correctness-invariants.md),
then whichever readers the decision touches

The root cause behind Phase 3 and behind all three shipped instances: readers
validate all-or-nothing, so one unrecognized value returns `undefined` for the
entire artifact, indistinguishable from an artifact never produced. Phase 3 and
both shipped fixes patch instances rather than the cause.

Decide between:

- **Per-observation degradation** — drop only the unreadable observation, keep the
  rest. Risk: a partially-read artifact silently under-reports.
- **A typed parse error instead of `undefined`** — the caller learns a parse failed
  and why. Risk: every call site must handle it.

Do not build until the choice is recorded. Amend ADR 0007 with the decision and
its reasoning, superseding the deferral note currently there.

Verification: `bun run check`.

### Phase 5 — FX follow-ups

Files: `src/sources/yahoo-fx.ts`, `tests/fixtures/runs/`

- **No fixture exercises the converted path end to end.** All nine run fixtures
  are USD/USD. Add one foreign-private-issuer run fixture whose quote currency
  differs from its reporting currency.
- **A failed fetch is reported as `provider-data-missing`.** `fetchYahooCloseWindow`
  returns `[]` for both an empty series and a failed request, so the FX layer
  cannot distinguish them and the `fetch-failed` cause is never emitted. Fixing it
  means changing that function's return contract — check its other callers first.
- **No close cache or collector rate limiting on the FX path.** Retry and
  circuit-breaking are present via `fetchYahooJsonWithResilience`; caching and
  collector-level rate limiting are not. One fetch serves a whole table, so this
  only matters once many foreign-issuer runs are in flight.
- **`reverse-dcf.ts` carries `input-currency-mismatch`**, the direct analogue of a
  reason already retired elsewhere. It needs no compatibility entry while it is
  still a live emitted reason — but it will the moment FX conversion is extended
  there.

Verification: `bun run check`.

### Phase 6 — Hygiene

- **knip reports nothing here**, so unused exports go uncaught. Either make it
  effective or stop counting it as a check; a check that cannot fail is worse than
  no check, because it reads as protection.
- `ValuationPriceSelectionRule` is exported with no external consumer.
- [scoring/index.ts:743](../src/scoring/index.ts) — miss autopsies are not hydrated
  into the index, so even a warm index re-reads every run directory from disk.
  Store the autopsy cause in the index row.

Verification: `bun run check`.

## Watch list — deliberate ceilings, no action

Marked simplifications with stated triggers. Act when the trigger fires; acting
sooner is speculative.

| Location | Ceiling | Trigger |
| --- | --- | --- |
| [yahoo-fx.ts:7](../src/sources/yahoo-fx.ts) | 7-day FX lookback | An observed gap longer than 7 days |
| [financial-statement-selection.ts:45](../src/sources/extended-evidence/financial-statement-selection.ts) | Off-canonical ~350-day stub spans never bucket | A filer whose stub period matters to a published number |
| [financial-statements.ts:130](../src/sources/extended-evidence/financial-statements.ts) | Calendar-year fiscal labels | A Jan-31 filer (most retailers) — `2018-01-31` yields FY2018 where the filer says FY2017 |
| [offline-financial-corpus-compare.ts:94](../tests/support/offline-financial-corpus-compare.ts) | Parity comparison ignores `fy` | Golden locking stops covering the difference |

## Risk

**Phase 2 is the dangerous one.** A wrong debt mapping produces a confident number
rather than a visible failure — an EV that omits or double-counts a bank's deposit
base is wrong by an order of magnitude while still rendering as a plausible
multiple. It needs a hand reconciliation against the filed balance sheet, not a
passing test.

**Phase 4 is the one that pays down principal.** Phase 3 and both shipped fixes are
instance patches on the same root cause. Deferring it again is defensible; doing so
silently is not.

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
