# ADR 0013 — ApeWisdom Alpha Search

## Status

Accepted

## Context

Alpha search should surface early equity Research Leads from public evidence without turning the bot into a trading or portfolio tool. Social discussion can be useful for discovery, but it is noisy and must stay separate from deterministic market validation and observable forecasts.

## Decision

Add `alpha-search --asset equity [--deep]` as an ApeWisdom discovery workflow. V1 is equity-only. It ranks candidate tickers from ApeWisdom social-momentum pages first, then cross-checks the top ranked candidates with Yahoo only for symbol validity and basic market metadata.

The social momentum score is deterministic and based on ApeWisdom aggregate features such as mention growth, rank improvement, current mentions, and upvotes per mention. Yahoo metadata does not contribute to the social ranking in V1.

ApeWisdom provides aggregate social-momentum rows rather than raw discussion text, so alpha-search does not retain raw social text.

Alpha Search Reports must remain research-only. They must not emit buy/sell/hold calls, sizing, execution language, portfolio-change language, expected-return language, or predictions.

## Consequences

- ApeWisdom collection, social momentum ranking, Yahoo validation, and report persistence are model-free in V1.
- Non-equity assets are rejected until a separate design is accepted.
- Score and calibration side effects do not run for alpha-search V1 because it emits no predictions.
- Rejected candidates are disclosed separately from valid Research Leads with rejection reasons.
