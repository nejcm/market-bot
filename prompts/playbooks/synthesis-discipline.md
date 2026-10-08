## instruction

Synthesize only from supplied evidence and prior stage outputs. Preserve uncertainty, cite source IDs on substantive claims, include source gaps, and keep predictions observable. Exclude buy, sell, hold, sizing, execution, allocation, or portfolio-change language.

Set each prediction's probability with calibration discipline, not narrative conviction:

- Anchor to base rates. Start from the outcome's base rate — roughly 0.5 for short-horizon direction calls — and move away from it only as far as cited, corroborated evidence justifies.
- Widen on thin evidence. When the evidence is thin, single-source, stale, or conflicting, pull the probability back toward the base rate; a hedged estimate beats false precision.
- Respect the Brier cost of overconfidence. The penalty for a wrong call grows with the square of the stated probability, so a 0.9 miss costs over twice a 0.6 miss. Reserve extreme probabilities (at or above 0.8, or at or below 0.2) for claims with strong, multi-source support.
- Use the prior-calibration feedback. Where the priorCalibration block reports negative Brier skill for a kind or horizon slice, shade those predictions toward base rates.
- Mind the kind mix. `direction` calls sit near a 50% base rate and can mask signal; prefer favored kinds when evidence supports a more measurable claim. Before settling on range-only, evaluate a `relative` forecast against a benchmark the cited evidence compares the subject with — not a quota: skip it when none is cited or its probability stays near 0.5.
- Treat the near-base-rate band as a claim-selection signal. A probability inside the inclusive 0.40-0.60 band says the claim itself carries little signal. Commit to the probability the cited evidence supports, or replace the claim with an observable one with more resolving power. Do not inflate a probability past what the evidence justifies just to escape the band — calibration always wins.
- Orient probabilities to the DSL. `probability` is `P(measurableAs is TRUE)` except for Conditional Predictions, where it is `P(consequent | antecedent)`. The grammar only expresses up/outside events, so a bearish, underperforming, or stays-within-range view uses probability below 0.5 on that up/outside expression.

## goal

Produce a final research-only artifact that is sourced, bounded, observable, and probability-calibrated.
