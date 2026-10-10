# ADR 0003: Forecasts, scoring, calibration, and cross-run intelligence

## Status

Accepted

## Date

2026-07-01 (amended 2026-07-03: scoring policy v3 registry, clocks, retry state,
split-adjusted equity closes, provider-window anchor validation, and calibration presentation;
amended 2026-07-06: primary Near-Base-Rate prompt steering;
amended 2026-07-12: Near-Base-Rate band widened to the inclusive 0.40-0.60 range after the first
resolved cohort scored below the always-0.5 baseline with every probability inside 0.42-0.58;
consolidated 2026-07-15; amended 2026-07-23: confirmed earnings-date forecast eligibility;
amended 2026-08-05: structured Prediction shortfall disclosure;
amended 2026-08-11: conditional-activation calibration guidance;
amended 2026-09-03: zero-resolution Calibration headline omission, enforced on read;
amended 2026-10-10: Forecast Completion Pass removed; Spotlights only from a market-overview
selection)

## Context

Research reports need measurable forecasts without becoming recommendations. Forecast generation,
display, conditional semantics, event anchoring, disagreement analysis, scoring, calibration, and
reuse of prior research must share one contract. Prior artifacts can improve new work, but must not
be mistaken for current market evidence.

## Decision

### Forecast contract and generation

- `ResearchReport.predictions` contains probabilistic forecasts about future public observations.
- `measurableAs` is the scored source of truth. Code parses and canonicalizes the DSL and renders
  the public `claim`; model-authored claim text is ignored.
- Supported expressions cover direction, relative performance, volatility, range, FRED macro,
  options IV, conditional events, and earnings-event returns.
- Probability always means the probability that `measurableAs` evaluates true. Conditional
  forecasts mean `P(B | A)`; a false antecedent produces a terminal `voided` result excluded from
  Brier and reliability metrics.
- Earnings forecasts anchor their origin and due date to the declared earnings event and timing.
- New earnings-return grammar is eligible only when the Earnings Setup event date is
  `issuer-confirmed` or `exchange-confirmed` under ADR 0004. A `provider-estimated` event remains
  visible contextual evidence but cannot produce `earnings-direction`, `earnings-move`, or
  `earningsReturn` output. New earnings Predictions persist the event-date status, and report,
  trace, and analytics telemetry record eligible and suppressed counts so the coverage change is
  explicit against the Phase 0 baseline.
- Prediction count is a soft `targetPredictions`, not a quota; deep equity uses a target of 3.
  The valid final-synthesis report's Predictions stand: no follow-up pass requests more, and any
  shortfall is deterministically disclosed. A predictions-only Forecast Completion Pass used to
  run below a completion floor; it was removed on 2026-10-10 because across 10 deep runs it cost
  ~10% of model tokens for ~0.6 accepted Predictions per run and returned none in half of them,
  pending confirmation by a frozen-input eval against the prior behavior. After earnings and research-subject
  gates, report assembly derives `ResearchReport.predictionShortfall` with non-negative integer
  emitted, target, and missing counts satisfying `missing = target - emitted > 0`. Presentation
  derives canonical Material Gap or compact text from that structure; new reports do not encode
  the protocol in `dataGaps`. Tolerant artifact reads adapt only the anchored historical
  `predictionShortfall: emitted N of T` form and retain unparseable or conflicting gaps verbatim.
- Primary synthesis is prompted to keep every emitted Prediction outside the inclusive 0.40-0.60
  Near-Base-Rate band — an in-band probability signals an uninformative claim that should be
  recommitted or replaced, never inflated past the evidence — while in-band Predictions remain
  valid telemetry rather than triggering a hard rejection. The soft count target must not be
  padded with coin flips.
- Optional deep-run Forecast Disagreement assigns challenger probabilities to canonical forecast
  IDs. The primary synthesis probability remains the only scored probability.

### Scoring and calibration

- Calibration reporting remains descriptive. Its unit is the Forecast Event: one per
  `assetClass | canonical claim | origin`, where the origin follows the clock the resolver uses
  for that observation strategy. Close-window claims take the report's UTC date, rolled forward
  to the next exchange trading day for equity; calendar-day point claims (macro, IV) take the UTC
  date unrolled; earnings claims take the declared event date regardless of issuance; conditional
  claims join their antecedent and consequent origins. Repeat issuances of one event are collapsed
  before any aggregate, keeping the earliest issuance by instant (ties by Run ID, then Prediction
  ID) so a rerun cannot overwrite the original commitment. Bounds are not fuzzy-matched: different
  bounds are different events. Each slice keeps event-weighted Brier scoring and adds the distinct
  Run count among the kept events plus a Run-clustered standard error when calculable. The summary
  publishes `duplicateForecastCount` (collapsed issuances, 0 when none), and voided conditional
  counts are deduplicated by the same key. A report whose `generatedAt` does not parse fails the
  strict report reader, so scoring and disk-backed Calibration skip it; the index-backed
  Calibration loader skips the same rows left in indexes built before that check. The run still
  appears in Research Console listings; its detail view flags the report as malformed and renders
  the raw record only when the file parses as JSON.
- The origin is recomputed from `generatedAt` and the claim, not read from the resolver's window,
  because legacy resolved scores never record it and are never rescored. Known ceiling: a report
  the resolver anchored through the unverified-session quarantine branch, or earnings issuances
  whose BMO/AMC timing changed between reports, can split or merge incorrectly. Persist the window
  identity in score evidence if either case appears.
- Current calibration summaries aggregate resolved policy-v3 forecasts only and present resolved
  count, hit rate, Brier score, reliability, and explicit small-sample warnings. They do not emit
  an always-0.5 baseline-skill headline. Historical summaries containing that legacy field remain
  readable.
- Hit rate and Brier score are conditional on measurement. A summary whose resolved count is 0
  omits both fields rather than publishing 0, because a Brier score of 0 asserts a perfect
  forecaster and is the opposite of what an empty corpus supports. They are omitted rather than
  serialized as `null`: `null` coerces to 0 in arithmetic and comparisons, so it would reproduce
  the same misreading one consumer downstream. The resolved count, the reliability bins, the
  slice maps, and the small-sample warning still render, so an empty corpus is disclosed as an
  empty corpus rather than as a missing artifact. Every rendering surface — the persisted
  Markdown summary, the `calibration` stdout dashboard, and the Research Console — names the
  absence instead of printing a number or a blank.
- The invariant binds readers as well as the producer. Summaries persisted before it existed still
  hold zeros, so each disk boundary — the prompt-path parser, the Research Console artifact read,
  and the Console view model — drops those fields when the stored resolved count is 0. It also
  drops the legacy always-0.5 `brierSkillScore`, which is derived from the Brier score and so is
  unfounded for the same reason. The Research Console read additionally rewrites the corresponding
  headline lines of the stored Markdown summary, including the legacy Brier-skill line and its
  "1 = perfect" legend, since that rendering is what a human actually reads. Reading normalizes;
  it never trusts the stored value.
- A missing or malformed resolved count is not evidence of an empty corpus. It never triggers
  normalization, and it is never collapsed into 0 by a reader: "no Prediction has resolved" and
  "this summary does not say" are distinct findings, and only the first may be presented as an
  empty corpus.
- Empirical baseline skill remains deferred until there are at least 100 resolved policy-v3
  forecasts overall and at least one event-kind × horizon stratum contains 30 resolved forecasts.
  Reaching both thresholds triggers a separate baseline-design review rather than an automatic
  metric change.
- Calibration affects primary synthesis through two independently gated
  inputs. Actionable Negative Calibration assesses asset class, job type, default
  Prediction-horizon bucket, and current Market Regime independently. A slice qualifies only with
  at least 30 resolved Forecast Events and 10 distinct Runs among those kept events, and when its
  Bonferroni-adjusted 98.75% one-sided lower bound (`Brier - 2.2414 × standard error`) is strictly
  above the 0.25 baseline. The prompt block also assesses Prediction-kind slices beyond these four
  dimensions; whether kind belongs in the gate is an open decision, recorded here rather than
  settled.
- Conditional-activation guidance enters deep-run primary synthesis when
  at least 10 conditional forecasts have resolved and the aggregate void rate is at least 0.5.
  It uses activated and voided history to steer antecedents toward plausible events or observed
  thresholds; it must never suppress or mandate conditional emission. `refreshCalibrationContext`
  is the runtime source for both calibration-derived steering inputs.
- Only qualifying Actionable Negative Calibration slices enter the synthesis prompt, where they
  guide probability discipline. Calibration cannot suppress Prediction count, reject forecast
  shapes, change evidence-support requirements, or reject emitted forecasts. Legacy summaries
  without uncertainty fields remain readable but cannot activate that guidance.
- Run-specific subject gates constrain scored subjects. Thematic research scores only its resolved
  listed proxy and emits no predictions when no proxy resolves.
- Scoring resolves observations through the repository and close cache, then aggregates Brier
  metrics and calibration slices.
- Equity close windows grade only completed sessions, under policy v3 (split-adjusted Yahoo) and
  legacy policy v2 (raw Yahoo, or Massive with no schedule) alike. A bar in Yahoo's
  `currentTradingPeriod.regular` session is unfinished while the scoring clock is before that
  session's supplied end (so half days, DST, and foreign exchanges come from the schedule); with no
  usable schedule only bars dated before the previous UTC day count. A later session's schedule
  certifies an earlier recent bar only if that later session had opened by the cutoff; until then
  the bar is withheld as awaiting-open when that session opens within 10 days (the longest routine
  exchange closure plus margin), otherwise as unverified. Unfinished bars are withheld after split
  adjustment and before caching and session selection. A withheld in-progress or awaiting-open
  session (or a scheduled session that has not opened) is a horizon wait only when filling exactly
  those sessions would resolve the one unresolved base expression — for a conditional, the
  antecedent alone until it resolves, so placeholder prices never decide activation; any other
  missing observation spends an attempt. Windows that withheld anything are never cached, cached
  windows acquired after a request's cutoff are refused, and the window cache is versioned (v3) so
  uncertified v2 entries are bypassed, never deleted.
- Scoring interpretation is keyed by the Prediction's persisted `scoringPolicyVersion` through an
  explicit policy registry (`src/scoring/policy.ts`), not a global constant. Report assembly
  deterministically stamps the current version (3) on every accepted Prediction; model-provided
  policy metadata never survives assembly. A missing version resolves permanently under policy v2,
  historical forecasts and already-resolved scores are never rewritten by scoring passes — only an
  explicitly audited `score repair --apply` may replace one, keeping the original and its repair
  provenance on the score — and each score result
  persists the policy version that produced it. `horizonTradingDays` keeps its legacy name; under
  policy v3 it is the horizon count whose clock the policy defines per forecast family.
- Confirmed-date eligibility changes which new earnings forecasts may be emitted, not how a
  persisted earnings forecast resolves. It therefore does not create a new scoring-policy version;
  historical provider-estimated forecasts remain readable and resolve under their persisted or
  legacy policy.
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

### Historical context and correction

- Build Historical Research Context only from canonical Run Artifacts under the configured data
  directory, never from source-cache entries.
- Select recent and anchor runs using run type, subject or instrument, horizon, recency, and
  resolved-miss relevance. Collapse redundant same-day entries while preserving eligible
  miss-correction runs.
- Prior reports are citeable internal `model` sources and narrative context, not current market
  observations.
- Model prompts list resolved prior forecasts only. Pending ones, scored or not, are counted as
  `pendingPredictionCount` but not shown as rows; prior summaries and findings may still echo them.
- Keep correction blocks aligned with the new run's forecast scope: instrument runs receive
  same-instrument misses; market overviews receive same-asset, same-horizon-bucket misses for
  configured subjects; thematic research receives same-subject or same-proxy misses.
- Market Spotlights exist only for market-overview runs. Candidates originate in current collected
  market evidence; history and alpha state may enrich candidates but never create them.
- A report carries Spotlights only when it is a market-overview run (including the `daily` and
  `weekly` aliases) with a non-empty deterministic `spotlight-selection`; final synthesis may refine
  rationale for selected symbols but never adds, drops, or re-sources one. Final synthesis used to
  pass model-authored `extras.spotlights` through for equity, crypto, research, and selection-less
  market overviews; those items originated in no collected market evidence. The final-synthesis
  shape now asks for them only when a selection exists, assembly drops them everywhere else, and
  non-market-overview renderers ignore them on older artifacts, which still read unchanged.
- History rebuild, search, and thesis-delta operate only on artifacts. Narrative deltas are
  generated only on request and must pass the persisted research-only boundary in ADR 0001.
- Missing or malformed history is a soft historical-context gap.

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
- Conditional activation coverage is a first-class calibration metric reported as aggregate
  activated and voided counts; the guidance gate does not slice it by antecedent type or horizon.

These limitations are implementation facts, not endorsed end-state methodology. Changing baseline,
price adjustment, or calendar semantics requires a new scoring policy version.

## Consequences

- Displayed claims and scored events cannot diverge when the DSL parses.
- Fewer supported forecasts are preferred to artificial calibration volume.
- A valid report below its target ships with a disclosed shortfall rather than a further model call.
- Legacy artifacts retain stored claims and legacy score semantics.
- Thin Calibration slices remain visible and are labeled unreliable; reporting thresholds do not
  grant synthesis authority.
- Calibration consumers must interpret current confidence bounds within the limitations above.
- Prior errors can inform new probability discipline without becoming a second market-data source.
- History is reproducible from disk, and Spotlight selection cannot promote stale watchlist state
  into current evidence.

## Implementation validation

- `src/forecast/observable.ts` is the public entry; `observable-expression.ts` owns parsing,
  canonicalization, and expression shape, `observable-shapes.ts` the per-shape rules,
  `observable-candidates.ts` candidate resolution, and `observable-redundancy.ts` redundancy rejection.
- `src/research/report-assembly.ts` applies subject trims and policy stamping;
  `report-assembly-data-gaps.ts` owns the research prediction gate and data-gap reconciliation.
- `src/report/prediction-shortfall.ts` owns shortfall derivation, validation, presentation text,
  and anchored legacy normalization for artifact and Console reads.
- `src/research/orchestrator.ts` re-derives the shortfall immediately after Report Integrity Audit
  pruning so persisted reports and downstream consumers reflect the retained predictions.
- `src/scoring/policy.ts` owns the scoring policy registry and per-version clocks.
- `src/scoring/resolver.ts`, `close-cache.ts`, and `calibration.ts` implement current scoring.
- `src/research/calibration-guidance.ts` owns Calibration actionability for both prompts and
  analytics.
- `src/research/forecast-disagreement.ts` keeps challenger output separate from canonical scores.
- `src/forecast/earnings-eligibility.ts` and the final-synthesis prompt builder enforce
  confirmed-date eligibility and persist suppression telemetry.
- `src/research/historical-context.ts`, `prior-forecast-errors.ts`, and `spotlights.ts` implement
  artifact-backed context, scoped correction, and current-evidence candidate constraints.
- `src/history/` owns derived search, timelines, and thesis deltas.
