# Plan 0007 — Duplicate annual periods, and what `fiscalYear` actually means

**Status: Decided, not started** — as of 2026-08-14.

## Problem

Both defects were found by running a real SEC companyfacts payload (Bank of Nova
Scotia, CIK 947263) through `deriveFinancialStatements` offline, after plan 0006
made `40-F` filers reachable. Neither is caused by plan 0006 — both are
pre-existing and taxonomy-agnostic. MJDS filers merely surfaced them, because
their histories are long and re-filed.

Measured on BNS: 97 annual rows across 17 series.

### 1. Near-duplicate annual periods survive dedup — reaches published research

`periodKey` ([financial-statements.ts:407-409](../src/sources/extended-evidence/financial-statements.ts))
is:

```ts
return `${fact.periodStart ?? "instant"}|${fact.periodEnd}`;
```

Exact `periodStart` match. `selectRestatements` (`:601`) groups on that key, so
two filings of the same fiscal year whose start dates differ by a single day land
in different groups and **both survive**. The `duplicate-superseded` note is not
emitted, because as far as the grouping is concerned they are different periods.

Observed on BNS — identical values, identical period end, starts one day apart:

```text
revenue          2018-10-31: 2017-11-01=38892M (fy2019) | 2017-11-02=38892M (fy2020)
netIncome        2018-10-31: 2017-11-01=11334M (fy2019) | 2017-11-02=11334M (fy2020)
operatingCashFlow 2018-10-31: 2017-11-01=5693M (fy2019) | 2017-11-02=5693M (fy2020)
dividendsPaid    2018-10-31: 2017-11-01=4634M (fy2019) | 2017-11-02=4634M (fy2020)
dilutedShares    2018-10-31: 2017-11-01=1840M (fy2019) | 2017-11-02=1840M (fy2020)
dilutedEps       2018-10-31: (same shape)
```

6 of 17 series affected, 6 extra rows out of 97.

**Why this matters, and it is not cosmetic.**
[valuation-workbench.ts:713](../src/sources/extended-evidence/valuation-workbench.ts)
maps every annual revenue fact into a valuation observation:

```ts
...artifact.statements.incomeStatement.revenue.annual.map((fact) => annualInputs(artifact, fact))
```

So the duplicate becomes a duplicate valuation observation — two identical points
at the same period, double-weighting that year in anything computed across
observations. Any consumer counting annual periods or computing year-over-year
change also sees a phantom zero-growth year.

### 2. `fiscalYear` is the filing's frame, not the fact's period — UI labels only

SEC companyfacts `fy`/`fp` describe the **filing** a fact was reported in, not the
period the fact covers. `readFiscalYear` (`financial-statements.ts:101`) copies it
through, so a period ending 2017-10-31 is labelled `fy2019`.

32 of 97 BNS annual rows carry a `fiscalYear` more than a year away from their own
`periodEnd`.

**Blast radius is small — verified, not assumed.** `fiscalYear` propagates to
`FundamentalHistoryPoint.fy` via
[fundamental-history-canonical.ts:81](../src/sources/extended-evidence/fundamental-history-canonical.ts)
and `:99`. Outside `src/sources/extended-evidence/`, the only consumers are:

- `src/run-artifacts.ts:1144` — the read guard, which only checks it is a number.
- `app/client/run-workspace-view.ts:856,858` — renders `FY 2019` and
  `FY 2019–FY 2025 · <periodEnd> to <periodEnd>`.

It does **not** reach `report.md`, scoring, or the history index. Confirmed by
grep across `src/report/`, `src/history/`, `src/research/`, and `app/`.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Fix the dedup? | **Yes, first** | Duplicate valuation observations are wrong output, not a wrong label. |
| Dedup key? | `periodEnd` + duration bucket | Two facts ending the same day with the same duration are the same period regardless of a one-day start wobble. |
| Tolerance? | Same `periodEnd`, durations within a few days | Not "any overlap" — that would merge genuinely different periods. |
| Fix `fiscalYear`? | **Yes, but as its own commit** | Real (32/97 mislabelled) but UI-only. Keep it separable so it can be dropped without losing the dedup fix. |
| Derive it how? | Calendar year of `periodEnd` | Self-consistent and traceable to the fact. See ceiling below. |
| Rename the field? | **No** | It is persisted and guarded; renaming churns artifacts for no gain. |
| Drop the FY label from the app instead? | **No** | `fy` is persisted and read-guarded, so the wrong value would still ship in artifacts. Fix the source. |

**Stated ceiling on the `fiscalYear` fix.** "Calendar year of `periodEnd`" is
correct for BNS (Oct-31 year end) and for calendar-year filers, but a retailer
with a Jan-31 year end conventionally calls the period ending 2018-01-31 *FY2017*,
where this rule yields 2018. That is still strictly better than today's filing
frame, which is arbitrary rather than merely off-by-convention. Mark it with a
`ponytail:` comment naming the ceiling.

## Non-goals

- Do not change `fiscalPeriod` (`fp`). Same provenance, but nothing in this
  investigation showed it consumed in a way that misleads.
- Do not touch interim series dedup. The duplication measured here is annual;
  interim carries deliberate YTD-and-discrete pairs that must not be merged.
- Do not add a gap or validation note for the *old* duplicates. Once the key is
  fixed they become ordinary `duplicate-superseded` cases and are already noted.
- No new dependencies. Bun + oxc only (ADR 0002).

## Phases

### Phase 1 — Pin the duplicate on real-shaped data

Files: `tests/financial-statements.test.ts`

Add a fixture with two annual facts for the same period end whose starts differ
by one day, with identical values — the exact BNS shape. Assert what happens
today: both survive, and no `duplicate-superseded` note is emitted.

Same discipline as plan 0006 Phase 2: this must pass now and fail once the key is
fixed, so the change has a witness that predates it.

Verification: `bun run check`.

### Phase 2 — Key dedup on period end and duration

Files: `src/sources/extended-evidence/financial-statements.ts`

Change `periodKey` so facts covering the same period collapse into one group.
Keep instants keyed as they are today.

Constraints that must hold:

- An annual and an interim fact ending the same day must NOT merge.
- A YTD and a discrete quarter ending the same day must NOT merge.
- Existing `duplicate-superseded` winner selection (`compareFinancialStatementFacts`)
  is unchanged — this phase only changes *what counts as the same period*.

`periodKey` is also written onto every `FinancialStatementFact` as a persisted
field (`toSelectedFact:419`). Changing its format changes artifact contents.
Check whether any reader parses it or only treats it as opaque, and report which.

Tests: the Phase 1 fixture flips — one row survives, one `duplicate-superseded`
note is emitted. The two must-not-merge cases above each get a test.

Verification: `bun run check`. **Goldens may legitimately move here** — inspect
each, do not refresh blind. Re-run the BNS probe and confirm 97 annual rows drop
to 91 with 6 new notes.

### Phase 3 — Derive `fiscalYear` from the period

Files: `src/sources/extended-evidence/financial-statements.ts`

Replace `readFiscalYear`'s use of the companyfacts `fy` frame with the calendar
year of `periodEnd`. Add the `ponytail:` ceiling comment for Jan/Feb year-ends.

Tests: a fact whose filing frame disagrees with its period end gets the period's
year.

Verification: `bun run check`; goldens may move. Re-run the BNS probe and confirm
the 32 mislabelled rows drop to 0.

### Phase 4 — Full check

```bash
bun run check
```

## Risk

Phase 2 is the only real risk. Merging two periods that are genuinely different
would silently drop a data point — the opposite defect, and harder to notice than
the duplicate it fixes. The two must-not-merge tests are the guard, and the BNS
row-count check (97 → 91, not lower) is the quantitative gate.

Phase 3 changes a persisted field's meaning. Nothing outside the app's two label
lines consumes it, so the change is contained, but goldens carrying `fy` will
move.

## Objective check

- Two annual facts for the same period with starts one day apart collapse to one
  row and emit `duplicate-superseded`.
- An annual and an interim fact ending the same day still produce two rows.
- A YTD and a discrete quarter ending the same day still produce two rows.
- The BNS payload yields 91 annual rows, not 97.
- No BNS annual row has a `fiscalYear` more than one year from its `periodEnd`.
- `bun run check` passes.
