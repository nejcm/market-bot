# ADR 0007: Golden invariance and live correctness invariants

## Status

Accepted

## Date

2026-08-02

## Context

Fixture goldens detect output changes across the real replay pipeline, but they cannot establish that
changed output is correct. Regenerating a golden after an intended behavior change can permanently
record a financial regression, especially when a large nested history or derived-metric record is
approved by hash rather than by re-derived properties.

The normalized evidence bundle remains authoritative under
[ADR 0002](./0002-typescript-bun-orchestration.md) and
[ADR 0004](./0004-evidence-identity-providers-deterministic-analysis.md). Its fixture tests therefore
need both change detection and correctness checks derived from the replayed evidence itself.

## Decision

Adopt a two-layer fixture testing contract:

- Goldens prove invariance: they detect and explain differences from an accepted prior replay.
- Live-run invariants prove correctness properties: they derive statement, history, lens,
  provenance, completeness, gap-triage, and numeric-hygiene relations from the freshly replayed run.

Correctness invariants use structural relations, compatibility rules, and conservative minimum
depths. They do not pin exact financial values and do not read expected values from goldens.

Two checks are intentionally one-directional. The currency invariant permits a reporting-currency
mismatch only when the series surfaces a `mixed-currencies` omission note, so it proves declaration
rather than absolute absence of mismatches. The incomplete-statement-note invariant requires every
computed note to be surfaced but does not reject additional surfaced notes.

Balance-sheet identity checks use uncapped canonical asset, liability, and equity facts. When an
equity-including-noncontrolling-interest fact is available, it replaces stockholders' equity;
temporary equity is then added as a fourth term. Otherwise, separately tagged minority interest is
added to stockholders' equity. Component selection prefers the accession shared by total assets and
total liabilities so independently restated comparative facts are not mixed across filings. No
period is skipped merely because a noncontrolling or temporary-equity component is present.

The apparent $82.0 million NBIS residual at 2021-12-31 was cross-accession mixing, not an untagged
face-of-statement component. Assets, liabilities, and temporary equity came from the 2022 accession,
while the component selector had chosen a 2025 comparative equity fact. The compatible 2022
equity-including-noncontrolling-interest fact is $3.662 billion rather than $3.580 billion; the
$82.0 million difference explains the residual, and the compatible four-term identity reconciles
exactly.

Current A6 corpus coverage is narrow. Of eight fixtures, the brief AAPL fixture has no financial
statement artifact, and four AAPL-derived fixtures contain taxonomy facts but no complete
asset/liability/equity triples. Three fixtures exercise A6: NBIS is the sole real-data fixture; the
quarterly US-GAAP and semiannual IFRS fixtures are synthetic templates. This is useful regression
coverage, not broad empirical validation across issuers.

A6 shares the production identity tolerance: the larger of one unit scale and 0.1% of the largest
fact magnitude. The previously observed $1.5 million NBIS 2022 residual was another cross-accession
comparison and reconciles exactly after compatible component selection. The tolerance still
accommodates disclosed-unit and conversion precision, which means a future residual below that
relative threshold would not be detected.

The annual-revenue depth floor is the production three-point minimum needed to derive CAGR. It does
not independently catch a 15-to-7-period regression. Cap-shape independence and history-span/sign
consistency are the incident-specific controls; the depth floor only prevents histories too shallow
for the production derivation. A per-fixture exact floor would turn live relations into a second
golden and is not adopted.

An invariant failure must be investigated. Repair the underlying defect or narrow the invariant by
a domain structure that applies uniformly. Do not add per-fixture exceptions, skip lists, or
allowance ledgers for live-run invariants.

Golden regeneration is not a repair for an invariant failure. If an intended change affects a
golden, the golden diff and the independently computed invariants must both be reviewed.

Amendment (decision date: 2026-08-14): artifact readers currently validate nested collections
all-or-nothing. One retired enum value or validated string literal can therefore make an entire
artifact return `undefined`, indistinguishable from an artifact that was never produced. Goldens
self-heal to the current schema when regenerated and cannot detect this failure class; frozen
historical artifacts kept outside golden regeneration are the counterpart protection.

When an enum member or validated string literal is retired, readers keep the historical value in a
read-only compatibility set while the live typed union excludes it so new code cannot emit it.
Per-observation degradation and typed parse errors in place of `undefined` were considered and are
deliberately deferred. `input-currency-mismatch` in
`src/sources/extended-evidence/reverse-dcf.ts` is the direct analogue; it needs no compatibility
escape hatch while it remains a live emitted reason.

## Consequences

- Unrelated output changes may update reviewed goldens without changing correctness invariants.
- Financial regressions such as duration-history loss, sign-inconsistent history summaries,
  balance-sheet identity failures, and dangling normalized citations fail mechanically.
- Fixture replay performs one additional traversal of already-produced artifacts and normalized
  sidecars; no provider or model work is added.
- Canonical financial statements expose the uncapped facts needed to determine whether the equity
  stack is structurally provable without changing the capped public statement histories.
- New derived financial behavior should add a live relation where exact-value goldens would be a
  weak oracle.

## Implementation validation

- All equity fixture replays run the live invariant layer before golden comparison.
- Fault injection demonstrates alarms for cap-shape independence, history sign consistency,
  balance-sheet identity, and normalized citation closure.
- The fixture suite records no invariant exceptions; any intentional golden regeneration remains a
  separately reviewed invariance change.
- The offline corpus ledger is not a live-run invariant and does not violate the live-invariant
  allowance-ledger prohibition; all 64 financial-lens entries are now property-backed rather than
  hash-only, moving the ledger closer to the same standard.
