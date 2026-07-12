# ADR 0004: Observable forecasts, scoring, and calibration

## Status

Accepted

## Date

2026-07-01 (amended 2026-07-03: scoring policy v3 registry, clocks, retry state,
split-adjusted equity closes, provider-window anchor validation, and calibration presentation;
amended 2026-07-06: primary Near-Base-Rate prompt steering;
amended 2026-07-12: Near-Base-Rate band widened to the inclusive 0.40-0.60 range after the first
resolved cohort scored below the always-0.5 baseline with every probability inside 0.42-0.58)

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
  gates and must sit outside the inclusive 0.40-0.60 Near-Base-Rate band. Primary synthesis
  is prompted to keep every emitted Prediction outside the same band — an in-band probability
  signals an uninformative claim that should be recommitted or replaced, never inflated past the
  evidence — while in-band primary Predictions remain valid telemetry rather than triggering a
  hard rejection. Both paths retain the soft count target and must not pad it with coin flips.
- Calibration reporting remains descriptive. Each slice keeps prediction-weighted Brier scoring
  and adds its distinct Run count plus a Run-clustered standard error when calculable.
- Current calibration summaries aggregate resolved policy-v3 forecasts only and present resolved
  count, hit rate, Brier score, reliability, and explicit small-sample warnings. They do not emit
  an always-0.5 baseline-skill headline. Historical summaries containing that legacy field remain
  readable.
- Empirical baseline skill remains deferred until there are at least 100 resolved policy-v3
  forecasts overall and at least one event-kind × horizon stratum contains 30 resolved forecasts.
  Reaching both thresholds triggers a separate baseline-design review rather than an automatic
  metric change.
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
- Scoring interpretation is keyed by the Prediction's persisted `scoringPolicyVersion` through an
  explicit policy registry (`src/scoring/policy.ts`), not a global constant. Report assembly
  deterministically stamps the current version (3) on every accepted Prediction; model-provided
  policy metadata never survives assembly. A missing version resolves permanently under policy v2,
  historical forecasts and already-resolved scores are never rewritten, and each score result
  persists the policy version that produced it. `horizonTradingDays` keeps its legacy name; under
  policy v3 it is the horizon count whose clock the policy defines per forecast family.
- Policy v3 clocks: equity close forecasts resolve on the Nth provider-observed session after the
  applicable anchor; crypto close forecasts resolve on the target UTC calendar date, are attempted
  only after that date has fully elapsed (a partial-day price is never graded), and keep the full
  origin-through-target close window so within-horizon shapes see intermediate closes; macro and
  IV forecasts count calendar days, resolve on the first published observation on or after the
  target date within a bounded search-ahead window, and baseline against the last observation
  published on or before the report anchor within the same bound — an origin never reads
  post-forecast data; earnings forecasts select their event-relative origin and count forward from
  provider-observed equity sessions. Exchange calendars may schedule resolution retries but are
  not authoritative for outcome anchors or outcomes.
- Horizon-not-elapsed waits do not consume scoring attempts. An unavailable observation persists
  `nextAttemptAt` and retries after 1, 3, and 7 days; the fourth failed observation fetch abandons
  the forecast. `score --force` bypasses only `nextAttemptAt`, preserving the same resolution and
  abandonment rules.
- Policy v3 equity close windows come from one Yahoo request containing raw closes and split
  events. Scoring reconstructs a dividend-exclusive, split-adjusted series; dividends do not enter
  the adjustment. Request failure, malformed or inconsistent split metadata, an initial observation
  outside the bounded anchor tolerance, or another incomplete close window leaves the forecast
  unresolved. Massive and other providers cannot fill or replace any portion of a v3 equity
  resolution window. Legacy policy-v2 forecasts retain their historical raw-close provider behavior.

## Current scoring limitations

- Calibration guidance still compares slice Brier confidence bounds with the fixed 0.25 reference
  as an underperformance gate. Current calibration summaries do not present this as a skill
  headline, and empirical baseline skill remains deferred to the stated sample thresholds and a
  separate design review.
- Legacy policy-v2 equity close scoring uses raw closes and can be distorted by splits or other
  corporate actions.
- Policy v2 (all forecasts persisted before stamping) gates every due date on the US exchange
  calendar, including crypto and macro/IV forecasts; those forecasts resolve permanently under
  that legacy clock.
- Conditional forecasts can have low activation rates; calibration output does not yet report
  activation coverage as a first-class metric.

These limitations are implementation facts, not endorsed end-state methodology. Changing baseline,
price adjustment, or calendar semantics requires a new scoring policy version.

## Consequences

- Displayed claims and scored events cannot diverge when the DSL parses.
- Fewer supported forecasts are preferred to artificial calibration volume.
- Completion failures are non-fatal and retain the already-valid report.
- Legacy artifacts retain stored claims and legacy score semantics.
- Thin Calibration slices remain visible and are labeled unreliable; reporting thresholds do not
  grant synthesis authority.
- Calibration consumers must interpret current confidence bounds within the limitations above.

## Implementation validation

- `src/forecast/observable.ts` owns parsing, canonicalization, and expression shape.
- `src/research/report-assembly.ts` applies subject gates, trims, shortfalls, and policy stamping.
- `src/scoring/policy.ts` owns the scoring policy registry and per-version clocks.
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
