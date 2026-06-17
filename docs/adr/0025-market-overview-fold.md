# ADR 0025: Market Overview Fold and Horizon Decoupling

## Status

Accepted

## Context

Daily and weekly market updates used the same deterministic source flow but were modeled as separate run identities. That made cadence look like product semantics even though the meaningful research difference was forecast horizon.

## Decision

`daily` and `weekly` market updates are folded into one canonical `market-overview` run. Cadence is an invocation/scheduling concern. Forecast horizon is explicit as `horizonTradingDays`; the CLI exposes `market-overview --horizon <trading-days>` with a default of 15.

`daily` and `weekly` remain deprecated CLI aliases for zero-break migration:

- `daily` dispatches to `market-overview` with a 5 trading-day horizon.
- `weekly` dispatches to `market-overview` with a 15 trading-day horizon.

New overview artifacts persist `jobType: "market-overview"` and top-level `horizonTradingDays`. Legacy `daily` and `weekly` artifacts remain readable and are mapped into horizon buckets on read:

- `daily` -> `1-5d`
- `weekly` -> `11-15d`

Calibration, Market Update Delta, market-scoped prior-miss correction, historical-context relevance, and provider-health coverage use horizon buckets instead of cadence labels. Provider-health requires short and medium market-overview coverage per asset class and accepts legacy daily/weekly artifacts while the migration fills in canonical overview runs.

## Consequences

Market overview reports are comparable by asset class and horizon bucket rather than by cadence label. Scheduled legacy commands continue to work, but new code paths and artifacts use the canonical run type.

Rejected alternatives:

- Dropping `daily` and `weekly` immediately, which would break scheduled jobs.
- Keeping a `--cadence` flag, which would preserve the distinction this fold removes.
