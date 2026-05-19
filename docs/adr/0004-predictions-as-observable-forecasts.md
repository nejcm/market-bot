# ADR 0004 — Predictions as observable forecasts, not advice

**Status:** Accepted

## Context

ADR 0001 establishes a strict research-only boundary: `market-bot` must not emit trade actions, position sizing, execution instructions, or portfolio changes. The `confidence` field on `ResearchReport` today is a qualitative `"high" | "medium" | "low"` label derived deterministically from source completeness — it is not a measurement of predictive accuracy.

Without any falsifiable claims in the output there is no way to measure whether the bot's research is useful, calibrate its confidence over time, or evaluate whether adding new data sources actually improves signal. Every upstream improvement (deeper sources, richer regime inference, new providers) would remain guess-work.

## Decision

Add a `predictions: Prediction[]` field to `ResearchReport`. A `Prediction` is a probabilistic statement about a **future observable market quantity**, not a trade recommendation.

Allowed `kind` values and their `measurableAs` shapes:

| Kind | measurableAs form | Example |
|------|-------------------|---------|
| `direction` | `close(SUBJECT, +N) > close(SUBJECT, 0)` | `close(SPY, +5) > close(SPY, 0)` |
| `relative` | `close(A, +N) / close(A, 0) > close(B, +N) / close(B, 0)` | `close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)` |
| `volatility` | `max(close(^VIX), 0..+N) > T` | `max(close(^VIX), 0..+5) > 20` |
| `range` | `close(SUBJECT, +N) outside [Lo, Hi]` | `close(BTC, +7) outside [90000, 110000]` |

`measurableAs` is parsed by the scorer (`src/scoring/dsl.ts`), never by the LLM. `horizonTradingDays` is 1–20.

### What this is NOT

A prediction with `probability: 0.68` that `close(SPY, +5) > close(SPY, 0)` does **not** tell the user to buy SPY. It describes the market. What the user does with that information is entirely the user's decision.

This is analogous to a weather forecast: "70% chance of rain" is a statement about the atmosphere, not an instruction to take an umbrella.

### Validator additions

The existing `TRADE_ACTION_PATTERN` regex already applies to all text fields. Predictions additionally reject `claim` strings containing reader-directed modal phrases: `consider`, `watch for`, `should`, `could be a`, `expect to`. Predictions describe the *market*, not the *reader*.

### Disclaimer text

`notFinancialAdvice` is expanded: "Research-only note: This report is for market research only and does not provide investment advice, trade recommendations, position sizing, execution instructions, or portfolio changes. Predictions are probabilistic statements about future observable market quantities, not trade recommendations. Acting on them is the reader's decision."

## Consequences

- The calibration loop becomes possible: a `market-bot score` command resolves predictions after their horizon elapses and computes Brier scores.
- The `confidence` label remains the existing evidence-quality cap. Calibration data is fed back as passive context in future runs.
- Any future feature that **does** recommend a trade action (sizing, execution) must still live in a completely separate system per ADR 0001.

## Alternatives considered

1. **Stay purely qualitative, skip predictions.** Simple but kills the calibration loop. Rejected.
2. **Store predictions in a sidecar `predictions.json`, outside `report.json`.** User expressed comfort having predictions in the main report. Rejected.
3. **Allow free-form probabilistic text instead of a structured DSL.** Unscoreable without LLM judgment. Rejected.
