# ADR 0023 — Forecast Disagreement as post-synthesis evidence

## Status

Accepted

## Context

Deep research can spend extra model calls for broader coverage, as with the fixed
Coverage Panel in ADR 0011. The project also scores observable Predictions over time,
but the current calibration loop attributes outcomes to the canonical Prediction
probability stored in `report.predictions[]`; it does not yet preserve per-model
historical skill.

Running the same observable Prediction set through more than one model can expose
uncertainty that a single synthesis model hides. The risk is turning that ensemble into a
second forecast authority, blurring which probability is scored and how calibration should
be interpreted.

## Decision

Add **Forecast Disagreement** as an optional `--deep`-only, same-provider evidence signal.

- The primary `synthesisModel` remains the baseline and remains the canonical scored
  probability in `report.predictions[]`.
- `MARKET_BOT_FORECAST_DISAGREEMENT_MODELS` configures comma-separated challenger model
  IDs for the active provider. No configured challengers means the feature is disabled
  without report disclosure.
- Challengers only assign probabilities to the already-valid canonical Prediction IDs and
  `measurableAs` strings. They do not propose alternate Predictions.
- The ensemble math is unweighted for v1: per-Prediction mean probability, population
  variance, and probability spread. Calibration-weighted ensembles require future
  model-attributed calibration data.
- The public report carries a compact numeric `report.extras.forecastDisagreement` block.
  The full participant audit is persisted to `normalized/forecast-disagreement.json`.
- Challenger failures are non-fatal. A valid Research View can ship with partial
  Forecast Disagreement results, with configured failures disclosed as neutral research
  gaps and in run analytics/trace.

## Consequences

- Calibration semantics stay stable: Brier score continues to evaluate the canonical
  Prediction probability.
- Deep runs with configured challengers pay extra model-call latency/cost, which must be
  visible in run shape analytics.
- Same-provider v1 avoids multi-provider config, credentials, base URLs, and trace
  attribution until there is evidence the added complexity is worth it.
- The signal is uncertainty/disagreement only; it is not investment conviction, model
  endorsement, or a trade/action surface.

## Rejected alternatives

- **Replace canonical probabilities with ensemble probabilities.** Rejected because it
  changes scoring semantics before the project can attribute calibration by model.
- **Cross-provider panels in v1.** Rejected because one run currently constructs one
  provider instance; cross-provider panels require a larger config and secret-management
  surface.
- **Allow challenger alternate Predictions.** Rejected because it creates a second
  prediction-generation policy and conflicts with ADR 0021's soft-target discipline.
