# AAPL Deep-Run Review: Validated Findings

## Comparison scope

- Reviewed run: `2026-07-06T05-06-12-146Z-ea213775`
  - Branch: `fix/dedupe-web-source-ids`
  - Commit: `9afc8bf890ea`
  - Worktree: clean
- Baseline run: `2026-07-05T09-37-04-124Z-1fe08db4`
  - Branch: `master`
  - Commit: `69f17c976fca`
  - Worktree: dirty
- Both runs have the same `effectiveConfigHash`.

This is a useful directional before/after comparison for the branch, but not a controlled
branch-only comparison. The baseline was dirty and predates additional `master` changes included
by the reviewed branch, so run deltas cannot be attributed to one branch commit with certainty.

## Branch outcome

Mixed, with concrete plumbing and count improvements, partial fresh-web adoption, and a
prediction-signal regression:

- Web source IDs improved from 30 entries / 28 unique IDs in the baseline to 25 entries / 25
  unique IDs in the reviewed run. The duplicate IDs `web-aapl-0fdf7c34` and
  `web-aapl-cbbca0e2` are gone.
- Prediction count improved from 3 to 4, target shortfall improved from 2 to 1, and trim warnings
  improved from 2 to 0.
- Fresh-web projection had a limited measurable effect: `web-aapl-80830e38`, which is outside the
  reused profile, was cited in `extras.earningsSetup`. However, no current-run web source was cited
  in the primary report sections or Predictions, so `analytics.json:webSources.reportCited`
  remained `0`.
- Prediction signal regressed from 3 informative / 0 near-base-rate forecasts to 2 informative /
  2 near-base-rate forecasts.
- Synthesis steering is now persisted in `stages.json`, which makes the primary/completion behavior
  directly auditable.

## Prioritized code findings

### 1. Fresh web evidence does not reach primary report claims or Predictions

- **Symptom:** Fourteen accepted current-run web sources produced zero citations in key findings,
  bull/bear cases, risks, catalysts, scenarios, or Predictions.
- **Evidence:**
  - `analytics.json:webSources` is `{accepted:14, reportCited:0, unused:14}`.
  - `trace.json:webGatherLoop` records 4 accepted requests using 7 source units.
  - `analytics.json:reusedProfileWebSources.reportCited` is `9`.
  - `normalized/extended-sources.json` contains summaries for all 14 current-run sources.
  - `src/research/research-context.ts` projects non-profile web summaries at final synthesis and
    tells the model it “may cite” them.
  - One fresh source, `web-aapl-80830e38`, was cited under `extras.earningsSetup`; therefore the
    feature is not completely inert. The remaining failure is adoption in primary report sections
    and Predictions.
- **Suspected cause:** Fresh sources are available, but the optional citation instruction gives the
  model little reason to prefer them over the pre-cited reused-profile digest.
- **Action:**
  - Verify the final-synthesis evidence block contains the expected fresh summaries in an
    integration-level prompt test, not only projector unit tests.
  - Add bounded steering that prefers relevant current-run sources for genuinely recent claims
    while preserving the low-trust boundary and allowing zero fresh citations when none add value.
  - Keep citation requirements relevance-based; do not create a source-count quota.
  - Consider extending web-usage telemetry to distinguish citations in authored extras from
    genuinely unused sources. Current `reportCited` intentionally counts only primary report claims
    and Predictions, so it labels the cited earnings-setup source unused.
- **Files:** `src/research/research-context.ts`, `src/research/final-synthesis.ts`,
  `src/research/run-analytics.ts`
- **Severity:** High
- **Effort:** Medium

### 2. Primary synthesis emitted two near-base-rate forecasts

- **Symptom:** Signal quality regressed despite the higher prediction count.
- **Evidence:**
  - Reviewed `analytics.json:predictions` is
    `{count:4, informativeCount:2, nearBaseRateCount:2}`.
  - Baseline values are `{count:3, informativeCount:3, nearBaseRateCount:0}`.
  - `stages.json` attempt 1 emitted `pred-1` at `0.55` and `pred-3` at `0.46`.
  - Attempt 1 uses qualitative “never emit a coin-flip (probability near 0.5)” steering.
  - Attempt 2 explicitly requires probabilities outside the inclusive `0.45-0.55` band and added
    informative `add-2` at `0.57`.
- **Corrected cause:** The near-base-rate forecasts came from primary synthesis, not completion.
  Completion correctly enforced its numeric band.
- **Action:** Give primary synthesis the same explicit inclusive `0.45-0.55` exclusion used by
  completion, while retaining the soft prediction-count target.
- **File:** `src/research/research-context.ts`
- **Severity:** Medium
- **Effort:** Low

### 3. Completion still allows `kind` and `measurableAs` to diverge

- **Symptom:** Completion improved the run from 3 to 4 Predictions but failed to reach 5 because
  one candidate was invalid.
- **Evidence:**
  - `analytics.json:predictions.shortfall.missingCount` improved from `2` to `1`.
  - `stages.json` attempt 2 emitted `add-1` with `kind:"earnings-direction"` and
    `measurableAs:"close(AAPL, +20) > close(AAPL, 0)"`.
  - `trace.json:predictionCompletion.rejectionReasons` records
    `Prediction add-1: kind does not match measurableAs`.
  - `src/forecast/observable.ts:validateProjection` correctly rejects this mismatch.
  - Commit `d9fc08f` gates advertised kinds, but the required shape still does not encode the
    mapping between each kind and its DSL grammar strongly enough.
- **Action:** Tighten completion steering or required-shape examples so every advertised kind is
  paired with its valid `measurableAs` grammar. Keep deterministic validation unchanged.
- **Files:** `src/research/research-context.ts`, `src/forecast/observable.ts`
- **Severity:** Low-Medium
- **Effort:** Low

### 4. SEC source gaps are semantically duplicated

- **Symptom:** Gap output separately contains `Missing SEC company facts: grossProfit` and
  `Missing SEC company facts: grossProfit, capex`.
- **Evidence:** Both reviewed and baseline `normalized/source-gaps.json` files contain the same
  three SEC gap messages; there are no exact duplicate `(source, message)` pairs.
- **Correction:** The total `dataGaps` increase from 18 to 20 is not evidence that this branch
  worsened SEC coverage. Both runs contain 12 normalized source gaps. The count increase came from
  model-authored gap wording/count differences (7 authored gaps versus 5), not new SEC or
  stale-profile source-gap categories.
- **Action:** Consolidate overlapping SEC fact names before rendering/counting gaps. Do not use the
  18-to-20 report delta as the regression test.
- **Files:** SEC evidence normalization and report gap assembly
- **Severity:** Low
- **Effort:** Low

## Operational observations — no code action

### Derivatives evidence

`MARKET_BOT_TRADIER_API_TOKEN` is unset, so derivatives-volatility coverage and the deterministic
earnings implied move are unavailable. This is an environment/provider configuration gap.

### Calibration

`calibrationAtGeneration.resolvedCount` and `data/calibration/summary.json:resolvedCount` are `0`.
The reviewed forecasts and comparable prior forecasts are still pending because their horizons
have not elapsed. This is expected cold-start timing, not a defect.

## Verification

After implementing findings 1–3:

1. Run `bun run check`.
2. Run a new deep AAPL job.
3. Confirm:
   - no duplicate web source IDs;
   - at least one relevant current-run web source is cited in a primary report section when fresh
     evidence is materially additive;
   - `predictions.nearBaseRateCount == 0`;
   - completion emits no `kind does not match measurableAs` rejection;
   - prediction shortfall does not improve by padding with near-base-rate forecasts.
4. Compare against both this reviewed run and a clean `master` run with the same effective
   configuration. Use the clean `master` run for causal branch assessment.
