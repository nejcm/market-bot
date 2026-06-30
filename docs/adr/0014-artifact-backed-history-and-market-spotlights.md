# ADR 0014: Cross-run research context and correction

## Status

Accepted

## Date

2026-06-30

## Context

New research should use prior artifacts without refetching or treating prior model output as current
market evidence.

## Decision

- Build Historical Research Context only from canonical Run Artifacts under the configured data
  directory; never from source cache entries.
- Select recent and anchor runs using run type, subject/instrument, horizon, recency, and resolved
  miss relevance. Collapse redundant same-day entries while preserving eligible miss-correction
  runs.
- Prior reports are citeable internal `model` sources and remain narrative context, not current
  market observations.
- Keep correction blocks scoped to what the new run forecasts:
  - instrument runs receive same-instrument misses;
  - market overviews receive same-asset, same-horizon-bucket configured-subject misses;
  - thematic research receives same-subject/proxy misses.
- Market Spotlights exist only for market-overview runs. Candidates must originate in current
  collected market evidence; history and alpha state may enrich but never create candidates.
- History rebuild/search/thesis-delta operate on artifacts only. Narrative deltas are generated only
  on request and must pass the persisted research-only boundary.
- Missing or malformed history is a soft historical-context gap.

## Consequences

- Prior errors can inform new probabilities without becoming a second market-data source.
- History remains reproducible from disk artifacts.
- Spotlight selection cannot turn stale watchlist state into current evidence.

## Implementation validation

- `src/research/historical-context.ts` builds prompt context.
- `src/research/prior-forecast-errors.ts` scopes correction.
- `src/research/spotlights.ts` constrains spotlight candidates.
- `src/history/` owns derived search, timelines, and thesis deltas.

## Supersedes

- ADR 0015
