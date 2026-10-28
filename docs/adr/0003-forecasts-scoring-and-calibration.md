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
  Center it on the band's stated base rate only for range Predictions whose subject, listed reference horizon (+1/+5/+10/+20),
  and bounds match the ±1σ band reconstructed from the run's saved closes at printed two-decimal precision:
  the two-decimal Gaussian outside probability for the sessions scoring spans after the reference close,
  or 0.32 when that count is unknown (non-US listing, unverified latest session); use 0.5 otherwise, including unavailable references. Kept Predictions retain evidence-supported probabilities.
  In-band Predictions remain valid telemetry; never pad the target with coin flips. Gaussian outside-±1σ
  probability is about 0.32; five-year AAPL/AMD/MSFT/SPY frequency was 0.285–0.334. This
  construction-specific Gaussian reference is not the Forecast Baseline.
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
- Run-analytics keeps the fixed always-0.5 reference. The fixed 0.25 Actionable Negative Calibration gate
  remains unchanged.
- Calibration's headline is Paired Skill: ΔBrier = Brier(Forecast Baseline) − Brier(model) over resolved,
  deduped Forecast Events that carry a baseline, overall and per kind; the fixed-0.5 skill stays a
  secondary column. Events without a baseline are excluded and counted (`excludedWithoutBaselineCount`).
  Range events stamped `ewma-0.94-w60-v1` are excluded and counted too (`excludedLegacyRangeBaselineCount`),
  because v1 scaled σ by the nominal horizon instead of the sessions scored; v1 direction and relative
  baselines are 0.5 for any horizon and stay in. Stamps are never rewritten;
  grid events count once through the Forecast Event dedupe. Pre-baseline predictions are excluded
  from Paired Skill because their as-of-issue closes cannot be proven from the cache. Pre-registered policy
  (`PAIRED_SKILL_POLICY`; any change needs an amendment here): 95% percentile block bootstrap, 2000
  resamples, seed 20261020, over events sorted by issuance and blocks sorted by subject so input order
  never moves the interval; blocks cluster by the subject's first leg and chain events issued before the
  block's latest close due date (the Scoring Policy horizon end, not the score-pass clock), so overlapping
  horizons never count as independent; floor 30 paired events and 5 blocks (the existing Actionable
  Negative Calibration count floor, plus enough blocks for a resample to vary); minimum useful effect
  ΔBrier ≥ 0.01. Status is `model-better` (interval above 0), `baseline-better` (below 0) or
  `not-yet-decidable` (interval spans 0 or below the floor). The floor is a minimum, not power: 80% power
  for ΔBrier 0.01 at SD 0.10 needs about 784 independent blocks (`poweredBlockCount`), so every surface
  says to expect `not-yet-decidable` until then and to treat earlier statuses as provisional. The 0.01 bar
  is deliberately one-sided: the model must clear it to keep its probabilities, while the free baseline
  wins on any interval below 0. The index
  stores the baseline stamp (schema 14; schema 15 also projects each prediction's primary subject as
  the search symbol of symbol-less runs); an older index falls back to disk until `index rebuild`.
- Paired Skill review cadence (pre-registered): quarterly on 2027-01-15, 2027-04-15, 2027-07-15 and
  2027-10-15, then every 15 Jan/Apr/Jul/Oct, per kind from the summary as written that day. `model-better`
  meeting the minimum useful effect: keep model probabilities and consider an out-of-sample model/baseline
  mixture. `not-yet-decidable`: keep recording, no change. `baseline-better`: publish the Forecast
  Baseline for that kind as the stated probability and say so in reports. A decision is never taken
  between review dates or on a slice that was not pre-registered here. Calibration Markdown, JSON
  (`nextReviewDate`, per-kind `decisionRule`; the overall aggregate carries none), stdout and the Research Console show the next review
  date and which rule each kind's current status would trigger; that is a preview, not a decision.
- Assembly stamps every Prediction with `origin` (`model` or `grid`) and, where an estimator exists, a
  Forecast Baseline: `baselineProbability`, `baselineVersion` and `infoCutoff` (last split-adjusted close
  used). Estimators are frozen, pure and versioned (`ewma-0.94-w60-v2`): EWMA (λ 0.94) volatility over the
  last 60 split-adjusted daily log returns, zero drift, √h aggregation where h is the sessions scoring spans
  after `infoCutoff`: the nominal horizon plus the US exchange sessions up to the first session on or after
  the run date (UTC calendar days for crypto), so a premarket, intraday or weekend run scores h + 1 or more.
  `ewma-0.94-w60-v1` stamps used the nominal horizon and are kept as written. Range is the lognormal
  outside-band probability; direction and plain outperform relative (A−B) are 0.5 by construction (any
  zero-drift symmetric distribution) but still require their close windows and are stamped with
  `baselineVersion`, so their Paired Skill is skill against a declared coin flip. Conditional, volatility, IV, macro and earnings claims carry no baseline and are not
  scored for skill. Fewer than 61 closes, a residual split, zero movement, a
  missing series, relative legs whose last closes are more than 4 days apart, or a range whose scored
  sessions are unknown (non-US listing, or the primary's unverified latest session) omit the baseline and
  declare a `forecast-baseline` data gap; it is never defaulted to 0.5. A non-positive range bound
  contributes zero tail probability. The primary symbol's window extends to the snapshot's newer
  unverified closes so the baseline and the grid bands share one spot. Changing the math requires a new `baselineVersion`. Forecast
  Baseline is unrelated to the prior-run baseline of Forecast Persistence Telemetry.
- Residual split check: every move above 8 robust σ is examined, so a larger genuine move
  cannot mask a smaller residual split. Any such move counts when it is within log(1.1) + 0.03 of the log of a forward or reverse split ratio (5:4, 4:3, 3:2, 2, 3, 4, 5, 10), so a split day that also
  moved ±10% is still caught. When the price source returned its split list (`yahoo-price-history`,
  `splitDates`), only a jump within 4 days of a reported split is flagged. A known list with no split
  nearby means a genuine move, which stays volatility. Without split metadata (the verified chart), a genuine 10–65% one-day move inside those windows is treated as a split. That is a
  documented shortcut; volume is not consulted.
- Equity instrument runs issue a fixed Event Grid: the ±1σ reference band outside-event at h ∈ {1, 5, 20}
  (the prompt lists only the other ±1σ bands as prediction anchors, each with the same session-true base
  rate, or 0.32 when the session count is unknown) and relative vs SPY at h = 5. The primary synthesis prices them in the same
  response as a top-level `eventGrid: [{ id, probability }]` — no extra model call — and is not shown the
  Forecast Baseline. Each range grid row is named as its ±1σ band around the dated reference close with
  the Gaussian outside probability for the sessions scoring actually spans (the resolver counts +h from
  the first session on or after the run date, so a premarket or weekend run adds one; about 0.48 at +1),
  stated as a base rate, not a default, assuming complete US exchange sessions, and omitted when the
  latest session is unverified, the listing is non-US or volatility is zero. A repair attempt
  that omits a grid probability keeps the last valid one. A missing or out-of-range probability, a missing range reference, uncollected close sources,
  crypto runs and SPY's own relative event each leave the event unissued and declare an `event-grid` data
  gap. A model Prediction identical to an issuable grid event (same id or `claimKey`) is folded into the
  grid: the event is issued as `origin: "grid"` under its grid id with the model's `eventGrid` probability
  when valid, else the duplicate's, and the grid's own sourceIds; the copy leaves the model list and no gap
  is declared. Grid Predictions are scored and calibrated like any other but do not count toward the
  prediction target, shortfall, kind mix or citation telemetry.
  For a `claimKey` match, Forecast Event identity and dedupe are unchanged because the key is
  origin-insensitive; an id-only match with a different expression is scored as the grid event's
  expression instead. Either way a folded event is scored at the `eventGrid` probability when valid, so
  Brier and Calibration inputs can differ from the duplicate's probability.
- The `forecast-grid` job issues the same Event Grid per watchlist equity, priced by one `quickModel` call
  from a compact fact sheet (no synthesis, not shown the baseline). It publishes a run-artifact dir under
  `data/runs/` so the existing score pass, Calibration, index and history read it unchanged; only parsed
  probabilities persist. Spending needs an explicit CLI `--yes`; the Research Console cannot queue it. An
  event it shares with an instrument run on the same session collapses through the Forecast Event dedupe.
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
