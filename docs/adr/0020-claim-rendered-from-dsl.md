# ADR 0020 — Prediction Claim Rendered From DSL

**Status:** Accepted  
**Date:** 2026-06-13  
**Amends:** [ADR 0004 (Predictions as Observable Forecasts)](./0004-predictions-as-observable-forecasts.md)

---

## Context

ADR 0004 defines a deliberately small `measurableAs` grammar for observable Predictions. The grammar is asymmetric: `direction` expresses only an up event, and `range` expresses only an outside-band event.

The final synthesis model previously supplied both a free-form `claim` and a scored `measurableAs`. That allowed the prose to describe a bearish or stays-within-range view while the scored DSL described the opposite up/outside event. The validator could compare `kind`, `subject`, and horizon projection, but it could not reliably infer prose polarity.

---

## Decision

`measurableAs` is the single source of truth for the scored event.

The persisted public `Prediction.claim` field remains for compatibility, but it is rendered deterministically from the parsed `measurableAs` expression. The model no longer authors `claim`, and any supplied model claim text is ignored.

`probability` always means `P(measurableAs is TRUE)`. Because the grammar only expresses up/outside events, a bearish direction view is represented as a probability below 0.5 on `close(S,+N) > close(S,0)`, and a stays-within-range view is represented as a probability below 0.5 on the outside-band expression.

Legacy artifacts are not rewritten on disk. Readers and indexes render from `measurableAs` when it parses and fall back to the stored `claim` only when it does not.

---

## Consequences

- Calibration and scoring cannot drift from displayed Prediction text when `measurableAs` is parseable.
- Existing JSON consumers can continue reading `Prediction.claim`.
- Search and history indexes must rebuild derived prediction text from the DSL, so the Run Artifact Index schema version is bumped.
- The asymmetric ADR 0004 grammar is preserved; no down or inside operators are added.

---

## Related

- [ADR 0004 — Predictions as Observable Forecasts](./0004-predictions-as-observable-forecasts.md)
- [ADR 0016 — Run Artifact Reader](./0016-run-artifact-reader.md)
- [ADR 0018 — Run Artifact Index](./0018-run-artifact-index.md)
