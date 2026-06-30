# AAPL Run Review Handoff

## Purpose

Continue from the `/run-review latest AAPL run` analysis. The user asked for the handoff plus the complete findings in this repo under `plans/`.

## Suggested Skills

- `run-review`: Use for any follow-up analysis of market-bot run artifacts.
- `coding-principles`: Use if converting findings into focused fixes.
- `code-quality`: Use before completion if implementation changes are made.

## Context

- Repo: `C:\Work\Personal\market-bot`
- Latest AAPL run reviewed: `data/runs/2026-06-30T14-28-13-211Z-7ee762a6`
- Baseline run used: `data/runs/2026-06-28T10-42-57-445Z-a4e33cad`
- Comparable basis: both are `jobType: equity`, `assetClass: equity`, `symbol: AAPL`, `depth: deep`, with 5-trading-day predictions.
- No code changes were made during the review.
- `miss-autopsy.json` was absent for both latest and baseline. Scores were pending because horizons had not elapsed.
- Citation integrity checked cleanly: both latest and baseline had `missingRefs = 0` when recursively comparing referenced `sourceIds` against `report.json:sources`.

## Complete Findings

1. Prediction quality regressed
   - Symptom: Latest emits more forecasts, but most are near-base-rate; `signalTargetMet` flipped false.
   - Evidence:
     - Latest `analytics.json:predictions = { count: 4, nearBaseRateCount: 3, informativeCount: 1, signalTargetMet: false }`
     - Baseline `analytics.json:predictions = { count: 2, nearBaseRateCount: 1, informativeCount: 1, signalTargetMet: true }`
     - Latest `report.json:predictions` includes three near-base-rate relative forecasts:
       - `pred-2`: `AAPL outperforms QQQ over 5 trading days`, probability `0.47`
       - `pred-3`: `AAPL outperforms SPY over 5 trading days`, probability `0.52`
       - `pred-4`: `AAPL outperforms IWM over 5 trading days`, probability `0.52`
   - Suspected cause: Forecast generation is filling target count with correlated 5-day relative forecasts even when probabilities are effectively coin flips.
   - Severity: High
   - Effort: Medium

2. SEC source-gap duplication inflates gap telemetry
   - Symptom: Latest repeats the same SEC missing-fact gap.
   - Evidence:
     - Latest `normalized/source-gaps.json` contains `sec-edgar: Missing SEC company facts: grossProfit` twice.
     - Latest `normalized/evidence-lanes.json:regulatory-filings.gapText` repeats `sec-edgar: Missing SEC company facts: grossProfit`.
     - Latest `analytics.json:sourceFunnel.sourceGaps.total = 11`; baseline `analytics.json:sourceFunnel.sourceGaps.total = 7`.
   - Suspected cause: Multiple extended-evidence producers emit identical SEC gaps without dedupe before source-gap and lane aggregation.
   - Severity: Medium
   - Effort: Low

3. Web-profile reuse is counted like fresh web coverage
   - Symptom: Latest reports strong web usage despite reusing a prior profile and doing no web-gather stage.
   - Evidence:
     - Latest `normalized/web-subject-profile.json:generatedAt = 2026-06-28T10:42:57.445Z`
     - Latest `normalized/source-gaps.json:web-subject-profile.message = Reused web subject profile from 2026-06-28T10:42:57.445Z (2 days old); latest SEC filing basis 2026-05-01.`
     - Latest `analytics.json:runShape.traceStages = source-collection|playbook-selection|specialist-analysis|instrument-evidence-analysis|market-behavior-analysis|critique|final-synthesis`; no `web-gather` or `web-subject-profile` stage.
     - Latest `analytics.json:webSources = { accepted: 11, profileUsed: 11, reportCited: 10, unused: 0, usageRatio: 1 }`
   - Suspected cause: Reuse path carries profile source IDs into current-run web-source accounting without distinguishing reused vs freshly gathered evidence.
   - Severity: Medium
   - Effort: Medium

4. Negative calibration context is not changing forecast behavior
   - Symptom: Equity calibration worsened, but latest still emits a near-base-rate cluster.
   - Evidence:
     - Latest `analytics.json:calibrationAtGeneration.assetClass = { brierScore: 0.2591, brierSkillScore: -0.0364, count: 5 }`
     - Baseline `analytics.json:calibrationAtGeneration.assetClass = { brierScore: 0.1936, brierSkillScore: 0.2256, count: 1 }`
     - Latest `analytics.json:predictions.signalTargetMet = false`
   - Suspected cause: Calibration context is informational only; forecast selection does not tighten requirements when same-slice skill is negative.
   - Severity: Medium
   - Effort: Medium

5. Deep-run coverage remains constrained by credentials/provider limits
   - Symptom: Options, implied move, dividend/split events, and supplemental market data remain unavailable.
   - Evidence:
     - Latest `normalized/source-gaps.json` includes:
       - `tradier-options: MARKET_BOT_TRADIER_API_TOKEN is not set`
       - `earnings-setup-implied-move: MARKET_BOT_TRADIER_API_TOKEN is not set; implied move unavailable`
       - `finnhub-events-2: Finnhub dividend endpoint is unavailable for the configured token (status 403)`
       - `finnhub-events-3: Finnhub split endpoint is unavailable for the configured token (status 403)`
       - `massive-supplemental-market: massive supplemental-market snapshot unavailable on current plan`
     - Latest `report.json:dataGaps` repeats these constraints.
   - Suspected cause: Local config/provider plan limitations, not run synthesis.
   - Severity: Medium
   - Effort: Low if credentials/plan are available; medium if fallback providers are needed.

## Other Evidence Collected

- Latest evidence quality remained high:
  - Latest `report.json:evidenceQuality = high`
  - Latest `analytics.json:evidenceQuality.label = high`
  - Baseline `report.json:evidenceQuality = high`
- Evidence lane coverage improved, despite more gaps:
  - Latest `analytics.json:evidenceLanes.coverageRatio = 0.8181818181818182`, `gapLaneCount = 2`
  - Baseline `analytics.json:evidenceLanes.coverageRatio = 0.7272727272727273`, `gapLaneCount = 3`
- Peer valuation improved:
  - Latest `normalized/valuation-comps.json:peerCount = 5`
  - Baseline `normalized/valuation-comps.json:peerCount = 0`
- Latest token and duration were lower than baseline:
  - Latest `analytics.json:runShape.tokenEstimate = 283963`, `durationMs = 344898`
  - Baseline `analytics.json:runShape.tokenEstimate = 441259`, `durationMs = 397390`
- Latest prediction sources were valid and more varied:
  - Latest unique prediction source count: `8`
  - Baseline unique prediction source count: `3`

## Likely Next Steps

- If fixing: start with the duplicate source-gap issue because it is narrow and testable.
- For prediction quality: inspect forecast generation/report assembly around near-base-rate telemetry, target soft count, and relative forecast diversity.
- For web-profile accounting: inspect reuse path for `web-subject-profile` and `analytics.json:webSources` role aggregation.
- For calibration behavior: decide whether same-slice negative skill should be prompt-only guidance, a warning, or a stricter forecast-shape/near-base-rate policy.

