# ADR 0009: Source-provider composition and resilience

## Status

Accepted

## Date

2026-06-30 (amended 2026-07-09: optional thematic news search and web fallback)

## Context

Market data, news, supplemental evidence, and scoring observations have different coverage and
failure behavior. Providers must remain replaceable without duplicating request, cache, or gap
logic.

## Decision

- Represent each provider as a typed module exposing any subset of market data, supplemental market
  data, news, Extended Evidence, or Market Context capabilities.
- Compose provider capabilities by asset class through the source registry. Use one primary market
  adapter and fan out optional news, supplemental, and Extended Evidence adapters.
- Route source HTTP through the shared request executor for timeout, retry, rate limiting, circuit
  breaking, freshness-budgeted cache, stale audit fallback, and raw snapshot capture.
- Missing required primary coverage emits a `SourceGap`. Optional supplemental providers may be
  silent when unconfigured; configured failures emit typed gaps.
- Yahoo remains primary equity market data. CoinGecko remains primary crypto market data.
- Massive is an optional equity supplement for snapshots and news and an opportunistic fallback for
  selected Yahoo quote, benchmark, alpha-validation, and scoring-close paths. It does not supply
  movers or regime labels.
- News adapters may optionally expose thematic search without changing providers that only support
  generic feeds. Resolved research subjects derive search terms from their checked-in display name
  and aliases. When the combined provider pool has no relevant thematic item before persistent
  seen filtering, the existing Exa-to-Firecrawl web-search path supplies a bounded news fallback;
  accepted results enter the normal news normalization, relevance, dedupe, seen-filter, and
  selection pipeline.
- Provider promotion into scoring requires explicit observation semantics and tests. Massive close
  fallback is part of the existing Yahoo observation path rather than a registry-owned observation
  capability.

## Consequences

- Provider failures degrade by capability instead of collapsing the run.
- Provider-specific behavior stays behind normalized contracts.
- Supplemental fallback can improve availability but must remain visible in provenance and cache
  semantics.

## Implementation validation

- `src/sources/providers.ts` declares modules and capabilities.
- `src/sources/registry.ts` composes them.
- `src/sources/collector.ts` owns collection orchestration.
- `src/sources/yahoo-resilience.ts` and `massive-fallback.ts` implement equity fallback behavior.

## Supersedes

- ADR 0017
