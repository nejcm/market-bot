# Plan 0009 — Unexplained absences in the report and silent drops in artifact reads

**Status: Phase 1 committed (e30166b), Phase 2 built, Phases 3-6 not started** — as of
2026-08-15.

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
expects, so the metric reads as merely missing for one issuer when it is in fact
undefined for the entire sector.

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
  A sweep of all 54 evidence bundles reports 167 nodes across these six readers
  and 0 drops. The earlier 212 figure also counted 45 `fundamentalHistory` nodes
  handled by a different reader. Nothing is lost today — but the first schema
  bump silently drops every older artifact, exactly as the three prior instances
  did.
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
| Bank debt concepts | Do not map them; declare EV multiples inapplicable for depository issuers | No defensible operating/financing split exists for a deposit-funded issuer, so any mapping produces a confident wrong number. Reasoning in Phase 2. |
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

### Phase 2 — Declare EV/revenue inapplicable for depository issuers

Files: `src/sources/extended-evidence/` (issuer industry classification)

`debt-unavailable` blocks EV/revenue on 10 of 10 BNS rows because banks do not
tag borrowings the way the debt input expects.

**Decision: do not compute EV/revenue, or any EV-based multiple, for banks and
other depository institutions. Render it as inapplicable-to-industry with a
stated rationale.** The mapping this plan originally proposed is not built.

Enterprise value assumes a clean operating/financing split, and a depository
issuer has none: deposits and borrowings are the raw material the business
transforms, not a capital structure layered on top of operations, and there is no
defensible line between the two. Including deposits yields an EV dominated by the
deposit base; excluding them yields something that is not enterprise value in any
conventional sense. Both render as a plausible multiple — the exact failure mode
the Risk section below names. "Revenue" for a bank is itself ambiguous (gross
interest income against net interest income plus fees), so the denominator
compounds the numerator's problem. This is a research bot whose absences carry
honest reasons; the correct output is a stated reason, not a confident wrong
number. Banks are valued on P/B, P/TBV and P/E, and those stay computed.

The decision binds every surface that can express an enterprise value, not only the
historical multiples table: the Valuation Evidence item withholds `enterpriseValue`
and `evToAnnualizedRevenue` (which is what the peer comps and the reverse DCF read
it from), the EV-based peer comparison and reference range are declared
inapplicable rather than fetched, and the reverse DCF — which solves against
enterprise value — is suppressed with the same stated reason. P/FCF joins them,
because a depository issuer files no capex line for the proxy to subtract; only
P/E, P/S and P/B remain computed.

One issuer-level classifier, reading SIC from the `sec-edgar` item only and
requiring a well-formed four-digit code, is the single definition of "depository
issuer". The same classification suppresses the
Financial Trends columns that are inapplicable at issuer level — operating margin
and capex-based free cash flow — which Phase 1 deliberately left to this phase.
That verdict is decided once per issuer, never per empty cell.

Verification: `bun run check`, then re-run `equity BNS --deep`. No EV multiple may
render a number, and every non-EV multiple must be unchanged.

**Deferred: the inapplicability does not cite the SEC item that established the
SIC.** The classifier returns the code without its provenance, so the stated reason
carries statement and history source ids rather than the submissions source the
classification came from. Correct in principle for a sourced-research tool, but
threading provenance touches all five call sites, so it is deliberately not done
here.

**Open gap: no run fixture covers a depository issuer.** No golden fixture
exercises a bank path, so the behaviour above is covered by unit tests and by
execution against real on-disk BNS run data, not end to end. Recording one is a
live-network and live-model operation
(`bun run scripts/record-fixture-run.ts equity-depository-deep equity BNS --deep`);
record it with `MARKET_BOT_WEB_GATHER_DISABLE=1`, with the Polygon/Massive keys
unset — they leak into the cassette and the recorder's secret scan rejects the
result — and with `MARKET_BOT_FORECAST_DISAGREEMENT_MODELS` unset, so `meta.json`
matches the nine existing fixtures rather than arming a challenger invariant the
replay cannot satisfy.

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

No `SubsequentFinancingBridgeArtifact` exists in the corpus: there are no matching
normalized files or occurrences, and all 54 evidence bundles contain zero nodes.
That reader therefore has no frozen fixture. Its version guard is exercised by a
production-derived round-trip test instead; unlike frozen bytes, that test will
self-heal on a schema bump and is not historical compatibility coverage.

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
- **A failed fetch is reported as `provider-data-missing`.** **Built.**
  `fetchYahooCloseWindow` now returns
  `{ ok: true, observations } | { ok: false, cause }`, the discriminated union
  `fetchYahooJsonWithResilience` already returns one file over, widened only by a
  cause drawn from the existing `SourceGapCause` vocabulary. HTTP success is no
  longer treated as payload success: only an explicitly recognized Yahoo no-series
  condition counts as a genuinely empty series, so the FX layer emits
  `provider-data-missing` solely when a provider truly answered with nothing,
  `fetch-failed` when the request failed, and `malformed-response` when a 200 carried
  an unusable payload. A stated reason has to be accurate, not merely present — the
  same standard Phase 1 set. `scoring/observations.ts` maps every `ok: false` to
  `[]`, exactly the behaviour it had before, so no scoring semantics moved.
  Separately, a Massive fallback that threw escaped as a rejection instead of a
  failed fallback; it is now caught in `fetchMassiveCloseWindow`, where every caller
  benefits.
- **No close cache or collector rate limiting on the FX path.** **Not built** —
  moved to the Watch list. Correcting this plan's earlier text: retry and backoff
  are present on the direct Yahoo helper, but collector-level circuit-breaking is
  *not*, because this path never goes through the collector request seam that
  provides it. What remains true is that one fetch serves a whole table, so the cost
  only matters once many foreign-issuer runs are in flight. That trigger has not
  fired. Building it now would be speculative by the same standard this plan applies
  everywhere else.
- **`reverse-dcf.ts` carries `input-currency-mismatch`**, the direct analogue of a
  reason already retired elsewhere. **No action**, by this plan's own reasoning: it
  needs no compatibility entry while it is still a live emitted reason. Recorded on
  the Watch list so the trigger — extending FX conversion into `reverse-dcf.ts` —
  is not lost with this plan.

Verification: `bun run check`.

### Phase 6 — Hygiene

- **knip reports nothing here**, so unused exports go uncaught. Either make it
  effective or stop counting it as a check; a check that cannot fail is worse than
  no check, because it reads as protection.
- `ValuationPriceSelectionRule` is exported with no external consumer.
- [scoring/index.ts:743](../src/scoring/index.ts) — miss autopsies are not hydrated
  into the index, so even a warm index re-reads every run directory from disk.
  Store the autopsy cause in the index row.
- Existing schema-v9 indexes require a manual `bun run src/cli.ts index rebuild` before that
  hydration improvement applies. Unsupported schemas continue to warn and fall back to disk; they
  are not auto-migrated or auto-rebuilt ([ADR 0002](../docs/adr/0002-typescript-bun-orchestration.md)).

Verification: `bun run check`.

## Watch list — deliberate ceilings, no action

Marked simplifications with stated triggers. Act when the trigger fires; acting
sooner is speculative. Every row is anchored by a `NOTE — ponytail:` comment at
that location, so the trigger survives this plan being deleted.

| Location | Ceiling | Trigger |
| --- | --- | --- |
| [yahoo-fx.ts:7](../src/sources/yahoo-fx.ts) | 7-day FX lookback | An observed gap longer than 7 days |
| [yahoo-fx.ts:106](../src/sources/yahoo-fx.ts) | One uncached fetch serves a whole table; retry and backoff are present, collector-level circuit-breaking and rate limiting are not, since this path bypasses the collector request seam | Many foreign-issuer runs in flight, or an observed Yahoo rate-limit response on the FX pair |
| [reverse-dcf.ts:29](../src/sources/extended-evidence/reverse-dcf.ts) | `input-currency-mismatch` has no version-compatibility entry while it is still a live emitted reason | FX conversion is extended into `reverse-dcf.ts` and the reason is retired |
| [financial-statement-selection.ts:45](../src/sources/extended-evidence/financial-statement-selection.ts) | Off-canonical ~350-day stub spans never bucket | A filer whose stub period matters to a published number |
| [financial-statements.ts:130](../src/sources/extended-evidence/financial-statements.ts) | Calendar-year fiscal labels | A Jan-31 filer (most retailers) — `2018-01-31` yields FY2018 where the filer says FY2017 |
| [offline-financial-corpus-compare.ts:94](../tests/support/offline-financial-corpus-compare.ts) | Parity comparison ignores `fy` | Golden locking stops covering the difference |

## Risk

**Phase 2 is the dangerous one.** A debt mapping produces a confident number
rather than a visible failure — an EV that omits or double-counts a bank's deposit
base is wrong by an order of magnitude while still rendering as a plausible
multiple. That risk is what the phase's decision avoids by refusing to compute the
metric at all; what remains is proving by execution that no EV multiple renders a
number for a depository issuer, not merely that a test passes.

**Phase 4 is the one that pays down principal.** Phase 3 and both shipped fixes are
instance patches on the same root cause. Deferring it again is defensible; doing so
silently is not.

Phases 1, 5, and 6 are low risk.

## Objective check

- No bare `—` remains in the Financial Trends table; every absence carries a
  reason, and inapplicable-to-industry reads differently from not-computable.
- A depository issuer renders its EV multiples as inapplicable with a stated
  rationale, and no EV multiple is computed for one.
- A run fixture exercises a depository issuer end to end. **Still open** — see the
  gap noted in Phase 2.
- All six extended-evidence readers accept their historical versions; a sweep of
  every evidence bundle reports 0 dropped nodes.
- Each version-compatibility entry has a frozen fixture that fails when the entry
  is removed.
- ADR 0007 records a decision on the reader failure mode, not a deferral.
- A run fixture exercises the FX-converted path end to end.
- knip either reports something real or is no longer counted as a check.
- `bun run check` passes.
