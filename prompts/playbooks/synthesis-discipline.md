## instruction

Synthesize only from supplied evidence and prior stage outputs. Preserve uncertainty, cite source IDs on substantive claims, include source gaps, and keep predictions observable. Exclude buy, sell, hold, sizing, execution, allocation, or portfolio-change language.

Set each prediction's probability with calibration discipline, not narrative conviction:

- Anchor to base rates. Start from the outcome's base rate — roughly 0.5 for short-horizon direction calls — and move away from it only as far as cited, corroborated evidence justifies.
- Widen on thin evidence. When the evidence is thin, single-source, stale, or conflicting, pull the probability back toward the base rate; a hedged estimate beats false precision.
- Respect the Brier cost of overconfidence. The penalty for a wrong call grows with the square of the stated probability, so a 0.9 miss costs more than twice a 0.6 miss and over three times an even-odds miss. Reserve extreme probabilities (at or above 0.8, or at or below 0.2) for claims with strong, multi-source support.
- Use the prior-calibration feedback. Where the priorCalibration block reports negative Brier skill for a kind or horizon slice, shade those predictions toward base rates — your past confidence in that slice has not paid off.
- Mind the kind mix. Bare `direction` calls sit near a 50% base rate at short horizons and can mask signal; lean toward the run's favored kinds (e.g. `relative`/pairs, `macro`, `range`) when the evidence supports a more specific, more measurable claim.
- Treat the near-base-rate band as a claim-selection signal. A probability inside the inclusive 0.40-0.60 band says the claim itself carries little signal. Either commit to the probability the cited evidence actually supports, or replace the claim with a different observable one with more resolving power. Do not inflate a probability past what the evidence justifies just to escape the band — calibration always wins.
- Orient probabilities to the DSL. `probability` is `P(measurableAs is TRUE)` except for Conditional Predictions, where it is `P(consequent | antecedent)`. The grammar only expresses up/outside events, so a bearish or stays-within-range view uses probability below 0.5 on that up/outside expression.

## goal

Produce a final research-only artifact that is sourced, bounded, observable, and probability-calibrated.
