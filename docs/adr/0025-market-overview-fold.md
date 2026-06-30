# ADR 0025: Market overview and horizon semantics

## Status

Accepted

## Date

2026-06-30

## Context

Daily and weekly updates shared one source and research flow. Forecast horizon, not scheduling
cadence, is the meaningful research distinction.

## Decision

- `market-overview` is the canonical whole-market run type for equity and crypto.
- `--horizon` expresses forecast horizon in trading days and defaults to 15.
- `daily` and `weekly` remain deprecated CLI aliases mapping to 5 and 15 days. New artifacts persist
  `jobType: "market-overview"`; legacy artifacts remain readable.
- Calibration, history relevance, market-update deltas, prior-miss correction, and provider-health
  group overview runs by horizon bucket rather than invocation cadence.
- Market Overview may select Spotlights from current collected movers and may render a narrow
  catalyst calendar derived only from already-collected or persisted evidence.
- Equity mover inputs remain Yahoo daily screeners and crypto movers remain CoinGecko 24-hour
  changes even for longer forecast horizons. Reports disclose this horizon/input mismatch.

## Consequences

- Scheduled legacy commands continue to work without preserving cadence as product semantics.
- Overview comparisons are stable by asset class and horizon bucket.
- Longer-horizon reports must not describe current mover inputs as matching the forecast horizon.

## Implementation validation

- `src/cli/args.ts` parses canonical and legacy commands.
- `src/cli/job-registry.ts` serializes canonical console jobs.
- `src/domain/run-types.ts` maps legacy artifacts and horizon buckets.
- Market overview profiles live under `src/config/runs/profiles/`.
