# ADR 0004 — Predictions as observable forecasts, not advice

**Status:** Accepted  
**Amended by:** [ADR 0020 (Prediction Claim Rendered From DSL)](./0020-claim-rendered-from-dsl.md), [ADR 0021 (Prediction Count Is a Soft Target)](./0021-prediction-count-soft-target.md), [Prediction-subject enforcement](#amendment-prediction-subject-enforcement)

## Context

ADR 0001 establishes a strict research-only boundary: `market-bot` must not emit trade actions, position sizing, execution instructions, or portfolio changes. The `confidence` field on `ResearchReport` today is a qualitative `"high" | "medium" | "low"` label derived deterministically from source completeness — it is not a measurement of predictive accuracy.

Without any falsifiable claims in the output there is no way to measure whether the bot's research is useful, calibrate its confidence over time, or evaluate whether adding new data sources actually improves signal. Every upstream improvement (deeper sources, richer regime inference, new providers) would remain guess-work.

## Decision

Add a `predictions: Prediction[]` field to `ResearchReport`. A `Prediction` is a probabilistic statement about a **future observable market quantity**, not a trade recommendation.

Allowed `kind` values and their `measurableAs` shapes:

| Kind         | measurableAs form                                         | Example                                                           |
| ------------ | --------------------------------------------------------- | ----------------------------------------------------------------- |
| `direction`  | `close(SUBJECT, +N) > close(SUBJECT, 0)`                  | `close(SPY, +5) > close(SPY, 0)`                                  |
| `relative`   | `close(A, +N) / close(A, 0) > close(B, +N) / close(B, 0)` | `close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)` |
| `volatility` | `max(close(^VIX), 0..+N) > T`                             | `max(close(^VIX), 0..+5) > 20`                                    |
| `range`      | `close(SUBJECT, +N) outside [Lo, Hi]`                     | `close(BTC, +7) outside [90000, 110000]`                          |
| `macro`      | `fred(SERIES, +N) > fred(SERIES, 0)`                      | `fred(DGS10, +5) > fred(DGS10, 0)`                                |
| `iv`         | `iv(SUBJECT, +N) > T`                                     | `iv(AAPL, +5) > 0.35`                                             |

`measurableAs` is parsed by the scorer (`src/forecast/observable.ts`), never by the LLM. `horizonTradingDays` is 1–20.

Scoring resolves predictions from Observations: public market quantity values fetched from Source Providers. Close-based predictions use provider-returned sessions, with origin as the first available close at or after the report date and horizon as the Nth available close after origin. Volatility predictions use the full close window. Macro and IV predictions are point-based Observations.

### What this is NOT

A prediction with `probability: 0.68` that `close(SPY, +5) > close(SPY, 0)` does **not** tell the user to buy SPY. It describes the market. What the user does with that information is entirely the user's decision.

This is analogous to a weather forecast: "70% chance of rain" is a statement about the atmosphere, not an instruction to take an umbrella.

### Validator additions

The existing `TRADE_ACTION_PATTERN` regex already applies to all text fields. Predictions additionally reject `claim` strings containing reader-directed modal phrases: `consider`, `watch for`, `should`, `could be a`, `expect to`. Predictions describe the _market_, not the _reader_.

### Disclaimer text

`notFinancialAdvice` is expanded: "Research-only note: This report is for market research only and does not provide investment advice, trade recommendations, position sizing, execution instructions, or portfolio changes. Predictions are probabilistic statements about future observable market quantities, not trade recommendations. Acting on them is the reader's decision."

## Consequences

- The calibration loop becomes possible: a `market-bot score` command resolves predictions after their horizon elapses and computes Brier scores.
- The `confidence` label remains the existing evidence-quality cap. Calibration data is fed back as passive context in future runs.
- Any future feature that **does** recommend a trade action (sizing, execution) must still live in a completely separate system per ADR 0001.

## Amendment: prediction-subject enforcement

Predictions must be about the run's own subject. `ObservableForecastPolicy` carries an `allowedSubjects` set (the run's declared Prediction Subjects) and rejects any prediction whose subject is not a member — for `relative` forecasts, the primary instrument named before the comparison. Rejected predictions trigger the standard validation retry path via a `disallowed-subject` issue code; they are not silently dropped.

Ticker and Market Overview runs supply `allowedSubjects`. **Research runs deliberately do not**: they pass `allowedSubjects=undefined` so the existing research prediction gate remains the sole authority over subject membership. The asymmetry is intentional — thematic research can legitimately forecast a representative proxy that differs from the literal subject query, whereas a ticker or overview run forecasting an off-subject instrument is an error.

This tightens what counts as a valid Prediction under this ADR; it adds no new prediction kind, scoring behavior, or report field, and does not touch the research-only boundary.

## Alternatives considered

1. **Stay purely qualitative, skip predictions.** Simple but kills the calibration loop. Rejected.
2. **Store predictions in a sidecar `predictions.json`, outside `report.json`.** User expressed comfort having predictions in the main report. Rejected.
3. **Allow free-form probabilistic text instead of a structured DSL.** Unscoreable without LLM judgment. Rejected.
