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

The **instrument** error-correction block (`buildPriorThesisErrorBlock`,
`priorThesisErrors`) fires for **ticker runs only**. Market-update runs do not emit
it, even for spotlighted instruments.

This is now one of **two distinct corrections**, scoped to the prediction subject the
run actually forecasts:

- **Ticker instrument correction** — prior misses on the command's own instrument,
  sharpening the next same-instrument forthcoming probability (`priorThesisErrors`).
- **Market-scoped forecast correction** — for daily/weekly runs, prior misses on the
  run's _configured market subjects_ (the fixed index/macro/crypto subjects from
  `src/config/runs.ts`), sharpening the next same-subject market forecast
  (`buildMarketForecastErrorBlock`, `priorMarketForecastErrors`). It draws only from
  prior same-cadence (`jobType === command.jobType`), same-asset market-update runs,
  filtered to predictions whose subject is a configured market subject. A relative
  pair (e.g. `QQQ:SPY`) qualifies only when **every** leg is a configured market
  subject, so a ticker-relative pair like `SPY:AAPL` is excluded.

The two never overlap: the market block's `jobType === command.jobType` filter excludes
spotlight ticker misses (those runs are `jobType: "ticker"`) by construction, and the
ticker block never fires for daily/weekly commands.

## Considered Options

- **Extend the instrument block to market-update spotlights — rejected.**
  Market-update prediction subjects are fixed index/macro symbols (`SPY, QQQ, ^VIX`,
  FRED series; crypto `BTC, ETH`) by design (`src/config/runs.ts`). A daily run that
  spotlights AAPL never emits a scored Prediction _about_ AAPL, so there is no
  same-instrument forthcoming probability for the prior miss to sharpen. The block
  could only tint the spotlight's prose rationale — a materially weaker fit than the
  ticker case, where it directly informs the next instrument Prediction.
- **Add a separate market-scoped forecast correction — accepted.** The same
  same-subject-forthcoming-prediction logic that justifies the ticker block _does_
  hold for a market-update run's own configured subjects: a daily run that missed a
  prior `SPY`/`DGS10` forecast emits a new forthcoming `SPY`/`DGS10` forecast for the
  error correction to sharpen. This is the market block above — distinct from, and
  not an extension of, the rejected spotlight option.

## Consequences

- Spotlight ticker history remains loaded into context (for selection and narrative
  enrichment) but is intentionally **not** rendered as an error-correction block. A
  future reader who sees the history loaded but unused here should not "fix" it: the
  omission is deliberate, contingent on market-update predictions staying index/macro.
- Market-update runs now carry their own error-correction channel
  (`priorMarketForecastErrors`) for their configured index/macro subjects, so the
  "loaded but unused" caveat applies only to _spotlight ticker_ history, not to the
  market forecast subjects themselves.
- If market updates ever emit per-spotlight scored Predictions (e.g. via a future
  #10 prediction-mix change), the spotlight boundary should be revisited — the
  spotlight instrument would then qualify for the instrument block, not the market one.
