# ADR 0004: Observable forecasts, scoring, and calibration

## Status

Accepted

## Date

2026-07-01

## Context

Research reports need measurable forecasts without becoming recommendations. Forecast generation,
display, conditional semantics, event anchoring, disagreement analysis, scoring, and calibration
must share one contract.

## Decision

- `ResearchReport.predictions` contains probabilistic forecasts about future public observations.
- `measurableAs` is the scored source of truth. Code parses and canonicalizes the DSL and renders
  the public `claim`; model-authored claim text is ignored.
- Supported expressions cover direction, relative performance, volatility, range, FRED macro,
  options IV, conditional events, and earnings-event returns.
- Probability always means the probability that `measurableAs` evaluates true. Conditional
  forecasts mean `P(B | A)`; a false antecedent produces a terminal `voided` result excluded from
  Brier and reliability metrics.
- Earnings forecasts anchor their origin and due date to the declared earnings event and timing.
- Prediction count is a soft `targetPredictions`, not a quota. After a high- or medium-evidence
  report is valid but below target, one best-effort, predictions-only Forecast Completion Pass may
  add candidates. It preserves the accepted report and Predictions, never retries itself, and
  leaves any remaining shortfall deterministically disclosed.
- Completion candidates must pass the existing observable, citation, subject, and redundancy
  gates and must sit outside the inclusive 0.45-0.55 Near-Base-Rate band. Primary-synthesis
  Predictions inside that band remain valid; models must not pad either path with coin flips.
- Calibration reporting remains descriptive. Each slice keeps prediction-weighted Brier scoring
  and adds its distinct Run count plus a Run-clustered standard error when calculable.
- Calibration affects primary synthesis and Forecast Completion only through Actionable Negative
  Calibration. Asset class, job type, default Prediction-horizon bucket, and current Market Regime
  are assessed independently. A slice qualifies only with at least 30 resolved Predictions and 10
  distinct Runs and when its Bonferroni-adjusted 98.75% one-sided lower bound
  (`Brier - 2.2414 × standard error`) is strictly above the 0.25 baseline.
- Only qualifying slices enter the synthesis prompt, where they guide probability discipline.
  Calibration cannot suppress Prediction count, reject forecast shapes, change evidence-support
  requirements, or reject emitted forecasts. Legacy summaries without uncertainty fields remain
  readable but cannot activate guidance.
- Run-specific subject gates constrain scored subjects. Thematic research scores only its resolved
  listed proxy and emits no predictions when no proxy resolves.
- Optional deep-run Forecast Disagreement assigns challenger probabilities to canonical forecast
  IDs. The primary synthesis probability remains the only scored probability.
- Scoring resolves observations through the repository and close cache, then aggregates Brier
  metrics and calibration slices.

## Current scoring limitations

- Brier skill uses an always-0.5 reference (`1 - brier / 0.25`), not an empirical event baseline.
  It must not be described as market-relative forecasting skill.
- Equity close scoring uses raw closes and can be distorted by splits or other corporate actions.
- Generic due-date calculation uses the US exchange calendar, including crypto and non-US equity
  reports. Provider-returned observations determine the actual close sequence, but the due gate is
  not asset/exchange-specific.
- Conditional forecasts can have low activation rates; calibration output does not yet report
  activation coverage as a first-class metric.

These limitations are implementation facts, not endorsed end-state methodology. Changing baseline,
price adjustment, or calendar semantics requires a scoring-version migration.

## Consequences

- Displayed claims and scored events cannot diverge when the DSL parses.
- Fewer supported forecasts are preferred to artificial calibration volume.
- Completion failures are non-fatal and retain the already-valid report.
- Legacy artifacts retain stored claims and legacy score semantics.
- Thin Calibration slices remain visible and are labeled unreliable; reporting thresholds do not
  grant synthesis authority.
- Calibration consumers must interpret current Brier skill and confidence bounds within the
  limitations above.

## Implementation validation

- `src/forecast/observable.ts` owns parsing, canonicalization, and expression shape.
- `src/research/report-assembly.ts` applies subject gates, trims, and shortfalls.
- `src/scoring/resolver.ts`, `close-cache.ts`, and `calibration.ts` implement current scoring.
- `src/research/calibration-guidance.ts` owns Calibration actionability for both prompts and
  analytics.
- `src/research/forecast-disagreement.ts` keeps challenger output separate from canonical scores.

## Supersedes

- ADR 0020
- ADR 0021
- ADR 0023
- ADR 0024
- ADR 0030
