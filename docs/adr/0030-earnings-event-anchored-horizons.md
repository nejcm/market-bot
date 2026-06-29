# ADR 0030 — Earnings event-anchored prediction horizons

**Status:** Accepted

## Context

Existing prediction kinds (`direction`, `range`, `volatility`, etc.) anchor their horizon to the report's `generatedAt` date: `horizonTradingDays` means "N trading days after the report was generated." This works when the scored event is the passage of calendar time from the report date.

Earnings predictions are different. The scored event is the post-earnings price reaction, which is anchored to the earnings event date—not the report date. A report generated five days before earnings should still measure the one-day post-print return from the event date, not from `generatedAt + 1`.

Additionally, the origin close (the "before" price) depends on earnings timing:

- **BMO (before market open):** the market has not reacted yet when the session opens on the event date. The pre-reaction close is the prior session's close; the first post-reaction close is the event-date close.
- **AMC (after market close):** the market closed normally on the event date before the announcement. The pre-reaction close is the event-date close; the first post-reaction close is the next session's close.
- **Unknown:** timing is unavailable. Use the conservative envelope: prior session's close as origin, next session's close as the first post-reaction close.

## Decision

Add two new prediction kinds and a DSL grammar for event-anchored earnings forecasts:

| Kind                 | `measurableAs` form                               | Example                                             |
| -------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `earnings-direction` | `earningsReturn(SYMBOL, YYYY-MM-DD, +N) > 0`      | `earningsReturn(AAPL, 2026-07-24, +1) > 0`          |
| `earnings-move`      | `abs(earningsReturn(SYMBOL, YYYY-MM-DD, +N)) > T` | `abs(earningsReturn(AAPL, 2026-07-24, +1)) > 0.045` |

For these kinds, `horizonTradingDays` means **post-event trading days**, not days from `generatedAt`.

### Scoring semantics

The origin and horizon closes are determined by event timing:

| Timing  | Origin close        | Horizon close (+N)              |
| ------- | ------------------- | ------------------------------- |
| BMO     | Prior session close | Event-date + (N−1) trading days |
| AMC     | Event-date close    | Event-date + N trading days     |
| Unknown | Prior session close | Event-date + N trading days     |

The due-date check uses the horizon close date (not `resolutionDate(generatedAt, ...)`). If the horizon close date has not yet elapsed, the prediction remains pending.

`earnings-direction` resolves as a hit when `closeN > close0`; miss otherwise.
`earnings-move` resolves as a hit when `|closeN / close0 − 1| > threshold`; miss otherwise.

### Observation strategy

A new `earnings-close-window` observation strategy mode carries `subject`, `eventDate`, and `horizonTradingDays`. The scorer reads event timing from `report.extras.earningsSetup.event.timing` (defaulting to `"unknown"` when absent) and fetches the appropriate origin and horizon closes.

## Consequences

- Adds two prediction kinds to the `PredictionKind` union and two shapes to the observable forecast parser.
- The scorer must handle event-anchored due-date checks and timing-aware close fetching for earnings kinds.
- Calibration slices earnings predictions into their own kind buckets.
- IV-crush scoring is intentionally deferred (v1); implied volatility remains context or a gap in the earnings setup, not a scored prediction.
