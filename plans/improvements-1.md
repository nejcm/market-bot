# Stale debt basis, and a ledger that can't tell "couldn't run" from "found nothing"

## Context

A fresh `equity AMD --deep` run (`data/runs/2026-08-28T18-44-35-518Z-932290cd/`) was reviewed
against the four prior runs on disk. Three of the six findings share two root causes worth
fixing; the rest are lower value or already covered by `plans/subsystem-outcomes-followups.md`.

**Workstream A — AMD's debt figure is five years stale, and it is reader-visible.**
AMD stopped tagging the `LongTermDebt` XBRL concept after FY2021. The canonical
financial-statement definition accepts that one concept and nothing else, so the debt series
terminates at `1,000,000` @ `2021-12-25` while cash is current at `2026-06-27`. Two
consequences:

- The mixed-period guard (92-day threshold) sees a 1,645-day divergence, voids enterprise
  value and net debt, makes the target valuation unusable, and caps Evidence Quality at
  `medium`. This is AMD's **only** failing material check — fixing debt moves the run to `high`.
- `financialPosition` publishes the 2021 figure as the current one on the equity ledger card.
  `$1,000,000` does not look wrong at a glance; it is the real FY2021 tagged value. The
  balance-sheet history table separately shows a blank Debt column with no explanation.

The fresher facts exist in the same evidence bundle — `LongTermDebtCurrent` 875M and
`LongTermDebtNoncurrent` 2,351M, both @ `2026-06-27`. Two other code paths already read them
correctly (`selectDebtMetric`, `capital-ownership.ts`). The canonical layer is the odd one out,
and it wins because it replaces the legacy metric map wholesale.

**Workstream B — the Subsystem Outcomes ledger conflates three different situations.**
`a41b00c` shipped the ledger to make runs diagnosable. It does not read `SourceGap.cause`, so a
missing Tradier credential, a fetch failure, and a lane that genuinely found nothing all record
`empty` / `coverage-gap`. Separately, a healthy 2.2-day-old profile cache hit inside a 30-day
window records as `blocked` and emits a gap labelled `stale-fallback` — a code borrowed from the
HTTP cache, where it means genuinely expired data was served. This is the same defect class the
ledger exists to eliminate.

Intended outcome: AMD reaches Evidence Quality `high` on evidence it already collected, no
report publishes a five-year-old number as current, and every ledger row distinguishes
*couldn't run* from *ran and found nothing*.

---

## Workstream A — composite debt basis

Chosen over the narrower "don't clobber the legacy metric" route for three reasons: the legacy
path is us-gaap-only (`summarizeSecFundamentals` returns early without `facts["us-gaap"]`), so it
cannot fix IFRS filers at all; it would leave the valuation module citing 3.2B while the
appendix card cites 1,000,000 from the same `sourceId`; and a declared Source Gap would be false
— the data is present in the same bundle under a sibling concept.

**The trap to avoid:** compositing only the periods where components exist would silently switch
measurement basis mid-column and make `priorComparable` YoY deltas compare different bases.
Select one basis for the whole series.

### A1 — composite fact contract

- `financial-statements-contract.ts` — widen `FinancialStatementExtractionMethod` to
  `"sec-companyfacts" | "derived-sec-companyfacts"`; add optional `composite?: { formula,
  components: readonly { concept, value, accessionNumber, filedAt }[] }` to
  `FinancialStatementFact`. **Update the per-fact reader guard at `:261`**, which hard-requires
  `extractionMethod === "sec-companyfacts"` and would otherwise make any artifact containing a
  composite unreadable by `readFinancialStatements` (used by the console, the index, and profile
  reuse). The artifact-level check at `:417` stays as-is.
- `financial-statement-definitions.ts` — add optional `components?` to
  `FinancialStatementSeriesDefinition`: an ordered list of component slots, each an ordered alias
  list (first alias with values wins per slot, matching `factValuesForMetric` at
  `sec-edgar.ts:422-433`, so `ShortTermDebt` and `LongTermDebtCurrent` never double-count). Give
  `debt` two slots — current: `{us-gaap: ["LongTermDebtCurrent","ShortTermBorrowings","ShortTermDebt"],
  ifrs-full: ["CurrentBorrowings"]}`; noncurrent: `{us-gaap: ["LongTermDebtNoncurrent"],
  ifrs-full: ["NoncurrentBorrowings"]}`. Reuse the concept vocabulary already proven in
  `capital-ownership.ts:92-98`.

Off-path: a definition with no `components` behaves exactly as today.

`tests/financial-statement-selection.test.ts:352-359` pins the single-alias shape and **must be
updated deliberately** — that assertion exists to force this conversation. Say so in the commit body.

Golden churn: none (types and definition data only).

### A2 — basis selection and materialization

In `selectSeries` (`financial-statements.ts:628-724`) build two candidate fact sets — the direct
alias basis (today's `factsForDefinition`) and the composite basis. The composite groups
component facts by `periodEnd`, requires the same fiscal period and form (the `sameFiscalPeriod`
rule at `sec-edgar.ts:486-488`), sums the slots present (at least one, matching
`sumMatchingFacts` at `:500-516`), and records every contributor. Compare each basis's
`latestFinancialStatementFact` with `compareFinancialStatementFacts`; keep the fresher.
**Ties go to direct** — that is what keeps every fixture byte-identical.

Composite fact fields: `filedAt` = max component `filedAt`; `accessionNumber` = shared accession
or `null`; `concept` = component concepts joined with `+`; `sourceIds` = union; `periodType` from
the underlying facts. `deriveTtm` is already `false` for debt, so no TTM interaction. `interim`
populates naturally from 10-Q instants — which is exactly what AMD's currently-empty `interim`
array is missing.

Off-path: neither basis present → empty series (unchanged), plus the A4 note. Only one slot
tagged → a one-legged composite with its single contributor recorded, so the omission is
auditable rather than invisible.

Tests, at the `deriveFinancialStatements` seam in `tests/financial-statements.test.ts`: AMD shape
(stale direct, fresh components → composite, 3.226B, both source ids); fresh direct + stale
components → direct, unchanged; equal `periodEnd` → direct wins; IFRS `Borrowings` vs
`CurrentBorrowings`/`NoncurrentBorrowings`; noncurrent-only → one-legged composite.

Golden churn: **zero**. Verified across all ten fixtures — every debt series' latest `periodEnd`
already equals its cash series' latest `periodEnd`, and each uses a single direct concept.

Objective check (no live run): on the AMD-shaped unit fixture, `debtPeriodEnd === cashPeriodEnd`,
so `balanceSheetPeriodDivergence` (`valuation-comps.ts:247-264`) returns `undefined` and
`guardMixedPeriodValuationItem` never fires.

### A3 — correctness invariant

Goldens prove invariance; invariants prove correctness. A composite is a derived number and must
be re-derivable. Add `assertCompositeFactIntegrity` to
`tests/support/run-fixtures/financial-invariants.ts`, called from
`assertFinancialStatementInvariants` (`:357`), with a negative control in
`tests/financial-invariants.test.ts`.

Assert: one basis per series (all composite or all direct); each composite's `value` equals the
sum of its components within the existing `identityTolerance`; every component shares the fact's
`periodEnd`; the fact's `sourceIds` are a superset of each component's.

### A4 — absence and staleness become findings (full reader chain)

Two `FinancialStatementNote` codes, deliberately scoped differently:

- `untagged-balance-sheet-series` — series entirely untagged. **Scoped to `debt` only.**
  `currentAssets`/`currentLiabilities`/`totalAssets`/`stockholdersEquity` are absent in four
  AAPL-derived fixtures, so a general rule would move five goldens for unrelated reasons. Scoped
  to debt, exactly one golden moves.
- `stale-instant-series` — series present but its latest `periodEnd` lags the artifact's newest
  balance-sheet `periodEnd` by more than one reporting period. This is the general fix for the
  class: the next issuer to stop tagging `Cash` gets caught. Fires in no fixture today. Genuinely
  new — `isStalePeriodEnd` (`sec-edgar.ts:371-378`) is applied only to `revenuePeriodEnd`.

Hit every surface — the blank Debt cell must say why:
`equity-reader-statements.ts` (both `financialPosition` and `balanceSheetHistory` gain a note
field) → `equity-reader.ts:439-466` → `markdown-equity-sections.ts:136-162`
(`renderBalanceSheetAndShareCount` prints the note instead of a bare `—`) → `report/schema.ts` if
projected → `app/client/run-workspace-financials.ts:264-300` → `run-workspace-view.ts:356-360` →
`components/equity-ledger.svelte`, `run-workspace.svelte:766-769`.
Keep `undefined` (no note) and `[]` (checked, none) distinct.

Golden churn: **one fixture** — `equity-depository-deep` (BNS, a bank with no tagged borrowings)
gains one `omissionNotes` entry and its markdown note. Intentional; `--write-golden` with the
reason in the commit body.

### A5 — close the divergence

Cross-seam test: on the AMD-shaped payload, `summarizeSecFundamentals(...).metrics.debt` and the
canonical metric from `withCanonicalFinancialLensInputs` agree on value and period end. Legacy
`selectDebtMetric` stays — `src/alpha-search/fundamentals.ts:114` still uses it — but drift
between the two now fails a unit test instead of a live AMD run.

> Noted, not in scope: `withCanonicalFinancialLensInputs` discards the entire legacy metric map
> (it keeps only `sic`/`sicDescription`), silently dropping `consolidatedNetIncome`,
> `dilutedShares`, and `shareRepurchases`, which have no canonical counterpart. Separate defect,
> separate task.

---

## Workstream B — a ledger row that says what actually happened

`gapCauses` and `supportable` **already exist** on the V2 lane artifact (`source-plan.ts:184`,
populated `:723-747`) and are already persisted. In the AMD run: `derivatives-volatility →
["missing-credential"]`, `peer-valuation → ["provider-data-missing"]`, `subject-profile →
["stale-fallback"]`. No gap-to-lane rematching is needed — the ledger simply ignores fields it is
already handed. The only obstacle is that `BuildSubsystemOutcomesInput.evidenceLanes` is typed as
the V1 artifact; both call sites already pass V2.

Order matters: diagnostics first, then the zero-churn fixes, then the one golden-moving phase
last and alone.

### B0 — outcome identity for the golden diff (do first)

`GOLDEN_ARRAY_IDENTITIES` has no `^outcomes$` rule, so the outcomes array diffs positionally —
B4 would cascade into spurious `changed-value` findings instead of naming the rows that moved.
In `tests/support/run-fixtures/golden-diff.ts`: add `"subsystem"` to
`GoldenArrayIdentityStrategy` (`:13-19`), a branch in `identityFor` (`:148-196`) returning
`stringField(value, "subsystem")`, and the rule. `identityGroups` (`:203-210`) already falls back
to positional matching when an element lacks the identity, so a malformed row degrades safely.

This affects the diff *report* only — pass/fail is deep equality at
`tests/equity-fixture/run.test.ts:164-171`. Zero churn.

### B1 — a cause meaning "served from a valid, in-window cache"

`web-subject-profile-reuse.ts:138` hard-codes `cause: "stale-fallback"` on every successful
reuse. There is no age branch to add: the gap is only constructed after `isReusableProfile`
passes, so an out-of-window profile never reaches that line. The single existing path is simply
mislabelled.

Add `"reused-in-window"` to `SourceGapCause`. Every surface:
`domain/types.ts:225-235` → `domain/source-gaps.ts:15-26` (the `satisfies Record<SourceGapCause,
true>` gate fails typecheck until you add it — that is the point) → **`isIntendedFallbackGap`
`:309-315` must accept it**, or `gap-triage.ts:90` reclassifies the reuse gap as material and
`equity-markdown.ts:121` stops filtering it, giving every reuse-path report a spurious Material
Data Gap → `docs/source-provider-contract.md:26` → `docs/run-variance-baseline.md:64`
(`sourceGapsByCause` baseline row).

No edit needed (verified): `isSourceGapCause` is set-derived; the evidence/report readers,
`provider-health.ts:203`, `run-analytics.ts:727` `countBy`, and the console all key off the union.
`health/validation.ts:240-245` classifies by `routeName`, not cause.

Tests: update `tests/web-subject-profile-reuse.test.ts:291,874`; add an over-age candidate case
asserting no reuse and no gap; add a `tests/gap-triage.test.ts` case asserting the new cause is
still an intended fallback (diagnostic, `no-cap`).

Golden churn: zero — no fixture contains `stale-fallback`.

### B2 — a healthy cache hit is not `blocked`

`webSubjectProfileOutcome` (`subsystem-outcomes.ts:308-317`) records `produced` / `reused-profile`
/ `count: 1`. The subsystem delivered a profile; `blocked` is reserved for genuine
unavailability. Carry `detail: { ageDays, sourceRunDirName }` so the ledger explains itself
without a second artifact.

Replace the `webSubjectProfileReused: boolean` input (`:146`) with the reuse record; update both
call sites (`orchestrator.ts:953-957`, `run-artifact-writer.ts:256-262`) to pass
`collectedSources.webSubjectProfileReuse`. `detail` is already a free-form record persisted as
`detail_json` (`run-artifact-index-rows.ts:243`) — **no SQLite migration**.

Off-path: no reuse → existing `profile-produced` / `profile-empty` branch unchanged; lane
not-applicable → `declined` / `not-applicable` unchanged.

Golden churn: zero — no fixture exercises the reuse branch.

### B3 — acquired but unusable is not a clean pass

`evidence-lane:target-valuation` records `produced`/`covered` in the AMD run while `supportable:
false` — evidence acquired but unusable reads as success. `evidence-quality.ts:75-81` already
knows this distinction; the ledger does not.

In `evidenceLaneOutcomes` (`:237-245`), a `covered` lane with `supportable === false` records
`produced` with code `not-supportable` and `detail: { supportable: false }`. Status stays
`produced` because sources genuinely were acquired — the third axis belongs on the code, not on
the status union.

Golden churn: zero — the two fixtures with `target-valuation` gaps have the lane uncovered.

### B4 — cause-driven lane outcomes (last, alone, the golden-moving one)

`evidenceLaneOutcomes` reads `evidence.gapCauses` through an exported table:

```
failed   ← fetch-failed, malformed-response, validation-failed
blocked  ← circuit-open, missing-credential
declined ← suppressed-by-design, unsupported-coverage
empty    ← provider-data-missing, stale-fallback, repeat-fallback, reused-in-window
```

Severity precedence `failed > blocked > declined > empty` for multi-cause lanes; within a tier,
the fixed declaration order. Code = the winning cause.

- `source-plan.ts` — export `EvidenceLanesArtifactV2` (unexported at `:208`) and use it as the
  input type, rather than back-porting `gapCauses` onto V1. Both call sites already pass V2.
- `subsystem-outcomes.ts` — `SubsystemOutcomeCode` gains `| SourceGapCause`; add all causes to
  `SUBSYSTEM_OUTCOME_CODE_TABLE` (the `satisfies` gate at `:109` enforces exhaustiveness); type
  the mapping `satisfies Record<SourceGapCause, SubsystemOutcomeStatus>` so a future cause fails
  typecheck rather than defaulting to `empty`. No name collisions with the existing 45 codes
  (`missing-exa-credential` ≠ `missing-credential`).

Off-path: the SEC-blocked branch (`:226-235`) stays ahead of the cause branch — a blocked
dependency outranks a lane-local cause. No causes → `empty`/`coverage-gap` unchanged. Lane absent
from the audit → `empty`/`audit-missing` unchanged. `equity-aapl-brief`-style lanes with
synthetic gap lines carry no `gapCauses` and keep today's mapping, which is correct: a synthetic
gap means no source and no matched gap, so there is nothing to attribute.

Tests at the `buildSubsystemOutcomes` seam: one case per tier, a multi-cause precedence case, a
no-cause regression case, and a runtime test asserting every member of `SOURCE_GAP_CAUSE_TABLE`
has a mapping.

`tests/subsystem-outcomes.test.ts:139-158` (Web Gather `no-accepted-requests`) stays untouched —
`plans/subsystem-outcomes-followups.md` item 1 is a different producer and out of scope. Say so
rather than half-fixing it.

**Golden churn — exact expected list.** `outcomes.json` and `analytics.json`
(`subsystemOutcomes.byOutcome`, `byCode`, `expectedEmptyCount`) move in nine fixtures:

| Fixture | Lanes that move |
| --- | --- |
| `equity-aapl-deep` | corporate-events, macro-indicators, derivatives-volatility → `blocked`/`missing-credential` |
| `equity-analysis-comprehensive` | macro-indicators → `blocked` |
| `equity-analysis-estimated-suppressed` | macro-indicators → `blocked` |
| `equity-depository-deep` | 3 → `blocked`; target-valuation → `empty`/`provider-data-missing` |
| `equity-earnings-release-deep` | news + 3 → `blocked`; market-data, target-valuation, peer-valuation → `empty`/`provider-data-missing` |
| `equity-fpi-ifrs-semiannual` | 3 → `blocked`; peer-valuation → `declined`/`unsupported-coverage` |
| `equity-fpi-quarterly` | as above |
| `equity-nbis-deep` | as above |
| `equity-web-fallback-deep` | macro-indicators → `blocked` |

`equity-aapl-brief` does not move (its gap lanes use synthetic gap lines, so `usesMatchedGapLines`
is false at `source-plan.ts:719-722` and no `gapCauses` are recorded).

Isolated `--write-golden` commit. Body states that missing-credential and provider-failure lanes
stop being reported as "ran and found nothing".

**Objective pass/fail:** after the refresh, the golden diff touches only `outcomes` and
`analytics.subsystemOutcomes` paths. Any movement under `report.json` / `report.md` means the
change leaked — Evidence Quality does not read outcomes (`evidence-quality.ts` has no reference;
only `run-analytics.ts:711` consumes the rollup).

---

## Sequencing

`A1 → A2 → A3 → A4 → A5`, then `B0 → B1 → B2 → B3 → B4`.

Land A before B4: if a stale-debt fixture is ever added, A removes the `provider-data-missing`
cause from its `target-valuation` lane, which under B4 changes that lane's recorded outcome.

Every phase except **A4** and **B4** must leave all ten fixture goldens byte-identical. Those two
are the only `--write-golden` commits, each isolated, each with its reason in the commit body.

## ADR impact

- **ADR 0004** (evidence identity, deterministic analysis) — amend with A1: a canonical statement
  fact may be a deterministic same-period composite carrying its components. This changes what
  "canonical fact" means; name the record rather than sliding it in.
- **ADR 0007** (golden invariance / correctness invariants) — amend with A3 to list the new
  invariant. 0007's premise is that derived numbers get a re-derivation invariant rather than
  golden approval by hash.
- **ADR 0001, 0002, 0003** — no impact. New note text is deterministic assembly, on the exempt
  side of the research-only gate.
- **CONTEXT.md** — no new domain term strictly required. If "Composite Statement Fact" is used in
  review prose, AGENTS.md requires it to land in `CONTEXT.md` in the same change.

## Verification

`bun run check` at the end of every phase — nothing narrower counts as verification.

End-to-end, without a live run:

1. Unit fixture with the AMD payload shape → canonical `debt` = 3.226B @ `2026-06-27`,
   `debtPeriodEnd === cashPeriodEnd`, mixed-period guard does not fire, `targetRow.usable ===
   true`, `supportabilityFor` no longer `not-supportable`.
2. `assertCompositeFactIntegrity` negative control fails on a mutated component value.
3. Fixture replay with `--check-golden` after each zero-churn phase; byte-identical.
4. `buildSubsystemOutcomes` unit cases: `missing-credential` → `blocked`, `fetch-failed` →
   `failed`, `provider-data-missing` → `empty`, in-window reuse → `produced`/`reused-profile`,
   covered-but-unsupportable → `produced`/`not-supportable`.
5. After B4's refresh, confirm the golden diff touches no `report.*` path.

The live confirmation — AMD reaching Evidence Quality `high` — waits for the next run performed
for independent reasons. Do not spend a deep run to settle it.
