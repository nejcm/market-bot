# ADR 0006: Deep-equity legacy reasoning retained

## Status

Accepted

## Date

2026-07-30

## Context

Deep equity introduced a simplified three-stage reasoning experiment behind a 16-condition paired
cutover gate. Its intended benefit was an estimated 36–42% reduction in model tokens while
preserving or improving research quality relative to the legacy specialist and Coverage Panel path.

The simplified path lost paired judging by 2 wins to 8 losses against the legacy path, including on
evidence grounding. Both proposed fixes were falsified by measurement. A derived-emphasis fix
measured 0 wins and 3 losses on the comprehensive profile. An AAPL-targeted prompt fix repaired its
three target dimensions but regressed
financial-valuation-reasoning in all three replicates. At three replicates, the rubric confidence
interval was too wide to distinguish those results from noise.

## Decision

Abandon the simplified three-stage deep-equity reasoning experiment and take its documented
fallback. The legacy specialist and Coverage Panel path remains the only production deep-equity
reasoning path.

End further cutover evaluation. The projected 36–42% token savings are forfeited as an accepted
cost of retaining the measured stronger reasoning path.

Collection remains audit-grade and unchanged. The normalized evidence bundle established under
[ADR 0002](./0002-typescript-bun-orchestration.md) and
[ADR 0004](./0004-evidence-identity-providers-deterministic-analysis.md) remains the evidence
authority.

## Consequences

- Deep equity has one production reasoning path.
- The 16-condition paired cutover gate, paired-evaluation harness, measurement scripts, model
  packet, and bundle migrator are removed.
- Audit-grade collection, derivation, and persistence remain unchanged.
- The evidence bundle is retained.
- The expected token reduction from the simplified path will not be realized.

## Implementation validation

- The codebase contains no reasoning-variant selector after the simplified path and its evaluation
  machinery are removed.
- `tests/equity-fixture/run.test.ts` keeps the legacy specialist and Coverage Panel replay green.
