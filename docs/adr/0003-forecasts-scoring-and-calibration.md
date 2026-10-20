# ADR 0003: Forecasts, scoring and calibration

## Status

Accepted

## Context

Observable Predictions need one contract for public claims, event clocks, scoring, Calibration, and
Cross-run Intelligence. Prior research supplies context, never current market observations.

## Decision

- `ResearchReport.predictions` describes future public observations. Parsed, canonical `measurableAs` is
  the scored truth and renders the public `claim`; ignore model-authored claims. Supported shapes cover
  direction, relative performance, volatility, range, FRED macro, options IV, conditional, and earnings events.
- Probability means the chance the expression is true. Conditional probability is `P(B | A)`; a false
  antecedent terminates as `voided`, excluded from Brier/reliability metrics.
- Earnings origin/due dates follow the declared event and timing. New `earnings-direction`, `earnings-move`,
  and `earningsReturn` require issuer/exchange confirmation under [ADR 0004](./0004-evidence-and-model-stage-pipeline.md).
  Provider estimates remain context only and may justify a labeled range-probability deviation.
  Persist event-date status and eligible/suppressed report, trace, and analytics counts. This emission gate
  does not alter historical resolution or create a scoring policy.
- Prediction count is a soft target (deep equity: 3), never a quota. A valid final-synthesis report stands;
  no Forecast Completion Pass requests more. After earnings/subject gates and integrity pruning, derive
  `predictionShortfall` with non-negative integer emitted/target/missing counts and `missing = target - emitted > 0`.
  Render canonical disclosure from counts, never a new `dataGaps` protocol. Tolerant readers adapt only
  anchored legacy `predictionShortfall: emitted N of T` text; conflicting/unparseable gaps stay verbatim.
- Treat the inclusive ±0.10 Near-Base-Rate band as claim-selection guidance: select claims the evidence
  can move off the base rate; do not shade a probability to clear the band.
  Center it at 0.32 only for range Predictions whose subject, listed reference horizon (+1/+5/+10/+20),
  and bounds match the ±1σ band reconstructed from the run's saved closes at printed two-decimal precision;
  use 0.5 otherwise, including unavailable references. Kept Predictions retain evidence-supported probabilities.
  In-band Predictions remain valid telemetry; never pad the target with coin flips.
  (Amended 2026-10-17: previously prompted
  probabilities outside the band, which flipped direction across frozen-input samples.)
  (Amended 2026-10-20: replaces the old
  all-kind 0.40–0.60 band with this exact-match rule. Gaussian outside-±1σ probability is about 0.32;
  five-year AAPL/AMD/MSFT/SPY frequency was 0.285–0.334. This construction-specific Gaussian reference
  is not the deferred empirical baseline.)
- Optional deep-run Forecast Disagreement assigns challenger probabilities to canonical IDs; only primary
  probabilities are scored. Run-specific subject gates bind all predictions; thematic research scores only
  its resolved listed proxy and emits none without one.
- Assembly stamps current `scoringPolicyVersion: 3`, discarding model policy metadata. Resolve through the
  persisted-version registry; missing versions permanently mean v2. Persist each score's policy. Never rewrite
  historical Predictions or resolved scores during scoring; only audited `score repair --apply` can replace a
  score, retaining original/provenance. `horizonTradingDays` names a count whose clock depends on the family.
- V3 equity closes count provider-observed sessions after the applicable anchor; earnings use event-relative
  anchors and observed equity sessions. Exchange calendars may schedule retries but never determine outcomes.
- V3 crypto resolves on the exact target UTC date only after that date fully elapses, retaining the entire
  origin-through-target window. Macro/IV use calendar days, the first publication on/after target within a
  bounded search window, and the last publication on/before origin within that bound; never read future data.
- V3 equity uses one Yahoo raw-close/split-event request and reconstructs dividend-exclusive split-adjusted
  closes. Failed requests, malformed/inconsistent splits, out-of-tolerance initial anchors, or incomplete
  windows remain unresolved. No other provider may fill any part. V2 retains raw-close/Massive behavior and
  its US-calendar due-date clock, including for crypto/macro/IV.
- Both v2/v3 equity grade completed sessions only. Withhold Yahoo's current regular-session bar until its
  supplied end. Without a usable schedule accept only bars before the previous UTC day. A later schedule
  certifies a recent earlier bar only after the later session opens; before that, withhold as awaiting-open
  if it opens within 10 days, otherwise unverified. Filter after split adjustment, before caching/selection.
- Withheld in-progress/awaiting-open or scheduled-unopened sessions cause a horizon wait only if filling exactly
  those sessions resolves the one unresolved base expression. For conditionals consider only the antecedent
  until resolved; placeholder prices never activate it. Other missing observations consume an attempt.
  Never cache a window that withheld anything or accept a cached window acquired after the requested cutoff;
  bypass uncertified older cache versions without deleting them.
- Horizon waits consume no attempts. Persist `nextAttemptAt` for unavailable observations; retry after 1/3/7
  days and abandon on the fourth failed fetch. `score --force` bypasses timing only, never resolution/abandonment.
- Calibration is descriptive and counts Forecast Events, keyed by `assetClass | canonical claim | origin`.
  Equity close origins roll the report UTC date forward to a trading day; crypto and calendar-day macro/IV
  keep UTC date; earnings use event date; conditional keys combine both origins. Distinct bounds stay distinct.
  Deduplicate before every aggregate, keeping earliest issuance by instant, then Run ID, then Prediction ID;
  voided events use the same key. Publish `duplicateForecastCount`, including zero, distinct Run counts, and
  Run-clustered standard errors when calculable; Brier remains event-weighted.
- Recompute origins from `generatedAt`/claim rather than unstored legacy windows. Known limits: unverified-session
  quarantine and changed BMO/AMC timing can split/merge events incorrectly; persist window identity if observed.
  Invalid `generatedAt` fails strict reading and is excluded by disk/index scoring and Calibration alike.
  Console listings retain the run, flag malformed detail, and show raw content only if JSON parses.
- Current summaries aggregate resolved policy-v3 forecasts: counts, hit rate, Brier, reliability, slices,
  small-sample warnings, and aggregate conditional activation/voiding. No always-0.5 skill headline is emitted;
  legacy summaries remain readable. Conditional guidance is not sliced by antecedent type or horizon.
- With resolved count exactly zero, omit hit rate/Brier (never zero or null); retain counts/bins/slices/warnings
  and explicitly name absence in persisted Markdown, stdout, and Console. Every read boundary normalizes old
  zero-count summaries by dropping those metrics and legacy `brierSkillScore`; Console also rewrites old
  Markdown headlines/skill legends. Missing/malformed counts are unknown, never normalized or collapsed to zero.
- Run-analytics and Console skill retain the fixed always-0.5 reference for all kinds. A construction-specific
  skill reference requires a per-Prediction stamp, index column and rebuild; these are not approved here.
  The fixed 0.25 Actionable Negative Calibration gate remains unchanged.
- Empirical baseline skill stays deferred until at least 100 resolved v3 forecasts overall and 30 in one
  event-kind × horizon stratum; both thresholds trigger a separate design review, not an automatic metric.
- Actionable Negative Calibration independently assesses asset class, job type, default-horizon bucket,
  Market Regime, and Prediction kind. Require 30 resolved Forecast Events, 10 distinct Runs, and a
  Bonferroni-adjusted 98.75% one-sided bound `Brier - 2.2414 × standard error > 0.25`. Qualifying slices
  guide probability discipline only. Below-floor kind slices are visible insufficient declarations without
  thin Brier/probability guidance. Legacy uncertainty-free summaries cannot activate guidance.
- Conditional-activation guidance enters deep primary synthesis only after 10 resolved conditionals with
  aggregate void rate at least 0.5. It steers plausible antecedents, never mandates/suppresses emission.
  Refresh both guidance inputs from runtime Calibration. Neither may change counts, accepted shapes,
  evidence requirements, or acceptance of emitted Predictions.
- Historical Research Context reads canonical Run Artifacts only, never source cache. Select by run type,
  subject/instrument, horizon, recency, anchors, and resolved-miss relevance; collapse redundant same-day runs
  while preserving eligible miss-correction runs. Missing/malformed history is a soft Source Gap.
- Prior reports are citeable internal `model` sources and narrative context. Prompt forecast rows include
  resolved forecasts only; pending forecasts are counted as `pendingPredictionCount`, never listed as rows
  (prior summaries/findings may still echo them).
- Correction scope is same instrument for instrument runs; same asset/horizon bucket and configured subjects
  for market overviews; same subject/proxy for thematic research. History rebuild/search/thesis-delta use
  artifacts only; narrative deltas run only on request and obey [ADR 0001](./0001-research-only-boundary.md).
- Market Spotlights require a market-overview run (including daily/weekly aliases) and a non-empty deterministic
  selection from current collected market evidence. History/alpha state may enrich, never originate candidates.
  Synthesis may refine rationale, never add/drop/re-source selected symbols. Assembly drops Spotlights elsewhere;
  non-overview renderers ignore them even on unchanged historical artifacts.

## Consequences

- Fewer supported Predictions beat artificial Calibration volume; shortfalls ship with explicit disclosure.
- Legacy claims/scores retain their semantics. V2 raw closes remain corporate-action-sensitive; changing
  baseline, adjustment, or calendar semantics requires a new scoring policy version.
- The fixed 0.25 Calibration guidance reference is an underperformance gate, not empirical baseline skill.
  Thin slices remain visible and unreliable; reporting does not grant synthesis authority.
- Prior misses may improve probability discipline without becoming another market-data source or stale Spotlight.
