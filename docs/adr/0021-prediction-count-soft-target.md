# ADR 0021 — Prediction Count Is a Soft Target, Not a Hard Floor

**Status:** Accepted  
**Date:** 2026-06-14  
**Amends:** [ADR 0004 (Predictions as Observable Forecasts)](./0004-predictions-as-observable-forecasts.md)

---

## Context

ADR 0004 introduced observable Predictions to enable a calibration loop, scored by Brier
score and Brier skill score versus a 0.5 baseline. Each depth profile declared a
`minimumPredictions` count, and final synthesis re-prompted the model until it emitted at
least that many.

That hard floor backfired. When recent calibration was poor, the model honestly retreated
to base-rate probabilities — but the reprompt loop still forced it to reach the count, so it
padded the report with predictions at probability ≈ 0.5. A 0.5 forecast cannot beat the
Brier-skill-vs-0.5 baseline by construction: forcing the count manufactures uninformative
predictions that drag the calibration signal toward noise instead of measuring research
quality. A weekly equity run on 2026-06-14 shipped two such coin-flip predictions.

---

## Decision

The prediction count is a **soft target**, not a hard floor.

- `DepthProfile.minimumPredictions` is renamed to `targetPredictions` to remove the misnomer.
- Final synthesis no longer re-prompts merely to raise the count. Reprompts fire only for
  hard prediction validation errors and report validation errors. Redundant predictions are
  prediction trims: dropped from the emitted report and recorded as telemetry.
- **Replacement-only retry carve-out:** when a redundant trim drops the emitted prediction
  count **below** `targetPredictions`, exactly **one** replacement-only retry fires. The
  retry carries the trim reasons as `predictionErrors`, triggering the existing
  `predictionRepair` guidance (replace the dropped near-duplicate with a distinct forecast —
  different subject, kind, benchmark, or sufficiently separated horizon). This retry never
  raises the count above target. If the replacement re-introduces redundancy or doesn't
  improve the count, the result is accepted as-is — no oscillation. A clean below-target
  result with no redundant trim still ships unrepaired.
- Prompt guidance instructs the model to emit a prediction only where evidence supports a
  directional lean, to prefer fewer high-conviction forecasts over padding, and to never emit
  a coin-flip just to reach a count.
- A below-target run is disclosed as a `predictionShortfall` data gap rather than padded.
- The analytics surface renames `predictions.minimumRequired` / `minimumMet` to
  `targetCount` / `targetMet`.

This refines ADR 0004's calibration loop; it does not reverse it. Predictions remain
observable forecasts scored the same way.

---

## Considered Alternatives

- **Keep the hard floor.** Rejected: it is what produced the uninformative 0.5 padding.
- **Add a deterministic guard rejecting probabilities within ±epsilon of 0.5.** Rejected as
  unnecessary mechanism; prompt guidance plus a soft count is simpler, and an honest lone 0.5
  on a genuinely balanced event is acceptable when not produced just to hit a quota.

---

## Consequences

- Some runs emit fewer predictions (occasionally zero), reducing calibration data volume in
  exchange for higher average forecast signal. This is the deliberate trade-off.
- The `targetPredictions` config key is a backward-incompatible rename of `minimumPredictions`
  for any external run configuration; no checked-in config used the old key.
- The analytics field rename changes the `analytics.json` schema for downstream readers.

---

## Related

- [ADR 0004 — Predictions as Observable Forecasts](./0004-predictions-as-observable-forecasts.md)
- [ADR 0020 — Prediction Claim Rendered From DSL](./0020-claim-rendered-from-dsl.md)
