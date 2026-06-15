# ADR 0024 — Conditional Predictions

**Status:** Accepted

Conditional Predictions extend the observable `measurableAs` grammar with `if (A) then (B)`, where `A` and `B` are existing observable expressions and `A` must resolve earlier than `B`. The stored probability means `P(B | A)`, not `P(A and B)`: if `A` resolves false, the score is terminal `voided` and excluded from Brier and reliability bins; if `A` resolves true, `B` is scored as the activated event.

This keeps conditional reasoning inside the existing research-only Prediction contract while avoiding nested tree or lattice schema. Rejected alternatives were treating condition-unmet as a miss, which would contradict conditional probability semantics, and storing nested trees in one Prediction, which would make scoring and rendering harder to audit.
