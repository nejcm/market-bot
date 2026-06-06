# ADR 0015 — Instrument-level error correction fires for ticker runs only

## Status

Accepted

## Context

Prior-Thesis Error Correction (audit finding #11) injects prior Predictions on the
current Instrument that resolved as misses into the research prompt, framed as
explicit error-correction signal so the model diagnoses why a prior thesis failed
before restating a similar view (`buildPriorThesisErrorBlock`,
`src/research/research-context.ts`).

A natural extension is to fire the same block for Market Spotlights in daily/weekly
runs — those runs already reload same-symbol ticker history for each selected
spotlight symbol (`src/research/orchestrator.ts`, ADR 0014). The question is whether
to surface prior-miss error correction for spotlighted instruments too.

## Decision

The error-correction block fires for **ticker runs only**. Market-update runs do not
emit it, even for spotlighted instruments.

## Considered Options

- **Extend to market-update spotlights — rejected.** Market-update prediction
  subjects are fixed index/macro symbols (`SPY, QQQ, ^VIX`, FRED series; crypto
  `BTC, ETH`) by design (`src/config/runs.ts`). A daily run that spotlights AAPL
  never emits a scored Prediction *about* AAPL, so there is no same-instrument
  forthcoming probability for the prior miss to sharpen. The block could only tint
  the spotlight's prose rationale — a materially weaker fit than the ticker case,
  where it directly informs the next instrument Prediction.

## Consequences

- Spotlight ticker history remains loaded into context (for selection and narrative
  enrichment) but is intentionally **not** rendered as an error-correction block. A
  future reader who sees the history loaded but unused here should not "fix" it: the
  omission is deliberate, contingent on market-update predictions staying index/macro.
- If market updates ever emit per-spotlight scored Predictions (e.g. via a future
  #10 prediction-mix change), this boundary should be revisited.
