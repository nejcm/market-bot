# ADR 0013 — Reddit-first Alpha Search

## Status

Accepted

## Context

Alpha search should surface early equity Research Leads from public evidence without turning the bot into a trading or portfolio tool. Social discussion can be useful for discovery, but it is noisy and must stay separate from deterministic market validation and observable forecasts.

## Decision

Add `alpha-search --asset equity [--deep]` as a Reddit-first discovery workflow implemented in phases. V1 is equity-only. It ranks candidate tickers from Reddit posts and comments first, then cross-checks the top Reddit-ranked candidates with Yahoo only for symbol validity and basic market metadata.

The Reddit Discovery Score is deterministic and based on discussion features such as mention frequency, engagement, unique participants, stance heuristic, and recency. Yahoo metadata does not contribute to the Reddit ranking in V1.

Raw Reddit text is short-lived. Future persistence must prune or redact raw Reddit text within 48 hours and retain only the minimum derived evidence needed for citations, rejected-candidate reasons, and repeat-run de-duplication.

Alpha Search Reports must remain research-only. They must not emit buy/sell/hold calls, sizing, execution language, portfolio-change language, expected-return language, or predictions.

## Consequences

- Reddit configuration and command parsing can land before the fetching/ranking adapter.
- Non-equity assets are rejected until a separate design is accepted.
- Score and calibration side effects do not run for alpha-search V1 because it emits no predictions.
- Rejected candidates are disclosed separately from valid Research Leads with rejection reasons.
