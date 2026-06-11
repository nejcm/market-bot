# ADR 0019 — Verified Market Snapshot + Ticker Canonical Identity

**Status:** Accepted  
**Date:** 2026-06-11  
**Extends:** [ADR 0008 (Provider-Normalized Instrument Identity)](./0008-provider-normalized-instrument-identity.md)

---

## Context

Research reports for equity ticker runs make exact numeric technical-indicator claims (RSI, EMA, MACD, Bollinger, ATR) that are frequently un-citable. LLMs invent plausible-sounding numbers; without a deterministic ground-truth source in the prompt, synthesis cannot be constrained to observable values, and Phase A.2 numeric verification has nothing to compare against.

Separately, ticker runs lack a canonical instrument identity block in the orchestrator context. The identity is normalized per MarketSnapshot but never surfaced as a single authoritative record for the run.

---

## Decision

### Verified Market Snapshot

Add a `VerifiedMarketSnapshot` type to the domain and a collector (`src/sources/verified-market-snapshot.ts`) that, for every `equity ticker` run at any depth:

1. Fetches ≥400 calendar days of daily OHLCV bars from the Yahoo chart API.
2. Computes a fixed set of deterministic technical indicators.
3. Injects the result (compact form: latest OHLCV row + indicator map + ~30 recent closes) into every stage prompt via `buildEvidencePayload`.
4. Registers a citeable `Source` (`verified-snapshot-{symbol}`) via `buildSourceList`.
5. Persists the structured snapshot to `normalized/verified-market-snapshot.json`.

Failure → `SourceGap` with `capability: "market-data"`, `evidenceQualityImpact: "core-cap"`. The run is not aborted.

### Canonical Instrument Identity

Add `deriveCanonicalInstrumentIdentity` in `src/sources/instrument-identity.ts`. It is a pure selection from the already-collected ticker `MarketSnapshot` — no second network fetch in the happy path. The resolved identity is injected into every stage prompt alongside an instruction to use it and not substitute another company. Persisted to `normalized/instrument-identity.json`.

---

## Indicator key schema (locked)

Phase A.2 numeric verification reads these keys by name. Do not change them without a new ADR.

| Key | Indicator | Parameters |
|---|---|---|
| `ema10` | EMA | 10-period |
| `sma50` | SMA | 50-period |
| `sma200` | SMA | 200-period |
| `rsi14` | RSI (Wilder) | 14-period |
| `macd` | MACD line | 12, 26 |
| `macdSignal` | MACD signal | 9-period EMA of MACD line |
| `macdHistogram` | MACD histogram | macd − signal |
| `bollUpper` | Bollinger upper band | 20-period, 2σ |
| `bollMiddle` | Bollinger middle band | 20-period SMA |
| `bollLower` | Bollinger lower band | 20-period, 2σ |
| `atr14` | ATR (Wilder) | 14-period |

---

## Lookback window and bar thresholds

- **Lookback:** ≥400 calendar days (~275 trading sessions) from `analysisDate`. 252 calendar days (~172 sessions) is insufficient for SMA200 (requires 200 sessions with warmup).
- **Emit threshold:** ≥60 bars required to emit a snapshot at all (core indicators).
- **SMA200 threshold:** ≥200 bars required; below this SMA200 is `null`. Per-indicator failure → `null` for that key only; the snapshot is never dropped when OHLCV is usable.

---

## Date semantics

- `analysisDate` = UTC calendar date of `ctx.fetchedAt` (the ISO date slice of the run's fetch timestamp).
- `latestSessionDate` = date of the last bar ≤ `analysisDate` after null-slot filtering.
- Chart timestamps are UTC-sliced via `new Date(ts * 1000).toISOString().slice(0, 10)`. For non-US tickers the session date can differ from the local exchange date by one calendar day — documented v1 limitation.

---

## Raw vs adjusted prices

v1 uses raw OHLCV from the Yahoo chart `indicators.quote` field consistently. ATR and Bollinger require raw high/low; `adjclose` divergence on split-heavy names is a documented v1 limitation.

---

## Null-bar handling

Bars where any OHLCV slot is null (Yahoo emits null slots on trading halts and sparse names) are skipped. All five arrays stay index-aligned. No forward-fill in v1.

---

## Citation rule for prompts

Injected into every stage prompt via `buildEvidencePayload`. The key enumeration derives from the runtime `INDICATOR_KEYS` constant in `src/research/verified-snapshot-contract.ts`, so the rule text cannot drift from the locked schema:

> Exact indicator values (ema10, sma50, sma200, rsi14, macd, macdSignal, macdHistogram, bollUpper, bollMiddle, bollLower, atr14) MUST cite source ID "verified-snapshot-\<symbol\>". Do not state indicator values that are not present in verifiedMarketSnapshot. Current-session price values cite the market-data source. Never mix bar-close indicators with live quote price in one claim — they legitimately disagree intraday.

This rule exists because `VerifiedMarketSnapshot.ohlcv` is the last bar close (session-end) while `MarketSnapshot.price` is the live quote. They can differ by the full intraday move.

---

## Evidence quality impact

A missing snapshot on an equity ticker run is `evidenceQualityImpact: "core-cap"`. A run without grounded technicals cannot report `high` evidence quality while numeric indicator claims are unconstrained. Phase A.2 numeric verification reinforces this at synthesis time.

---

## Fetch discipline

Chart fetches MUST go through `ctx.request.json` with adapter `yahoo-verified-chart` and `yahooResilientFetchWrapper`. This gives cache, rate limiting, circuit breaking, and stale fallback (ADR 0017).

`fetchYahooCloseWindow` and direct `fetchYahooJsonWithResilience` calls are forbidden for this path:

- `fetchYahooCloseWindow` bypasses the collector cache (calls `fetchYahooJsonWithResilience` directly) and silently falls back to `fetchMassiveCloseWindow` (closes-only). Massive cannot satisfy ATR/Bollinger (need full OHLCV).
- A silently degraded snapshot is worse than a disclosed gap.

On chart failure → `SourceGap`, never a degraded snapshot.

---

## Instrument Identity (ADR 0008 extension)

`deriveCanonicalInstrumentIdentity(marketSnapshots, symbol)` is a pure selection from the quote already fetched by `collectEquity`. A separate fetch would bypass the cache, lose the Massive quote-fallback resilience, and can drift from the MarketSnapshot when one call hits Yahoo and the other lands on the fallback.

When no identity is derivable (quote missing or carries no identity block), a `SourceGap` with `evidenceQualityImpact: "no-cap"` is emitted instead of a fallback quote fetch. The planned fallback fetch was deliberately narrowed away: a missing ticker quote already produces its own core-cap market-data gap, and a second fetch could return a payload that disagrees with the (failed) primary path. The no-cap gap discloses that the run's do-not-substitute identity guard is absent without double-capping evidence quality.

This is run-scoped orchestration-time canonicalization, not a global Instrument resolver catalog (ADR 0008 boundary preserved).

---

## Rejected alternatives

- **LLM-computed indicators** — non-deterministic; cited values would not be verifiable.
- **Promoting indicators to scoring Observations in v1** — requires `forecast/observable.ts` + resolver work; deferred.
- **Reusing `fetchYahooCloseWindow` / Massive closes-only path** — forbidden; see Fetch discipline above.
- **Folding into `MarketSnapshot`** — MarketSnapshot is a point-in-time live quote; adding a 400-day bar history to it would break its shape and consumers.
- **252 calendar day lookback** — only ~172 trading sessions; SMA200 would be permanently null.

---

## Consequences

- Every equity ticker run makes one additional chart API call. The call is cached and rate-limited via the collector seam.
- Every equity ticker prompt grows by a compact snapshot block (latest OHLCV + indicator map + ~30 recent closes). For deep runs this compounds across 6+ stages; the full bar series stays on disk only.
- Phase A.2 (post-synthesis numeric verification) can now match indicator names to `VerifiedMarketSnapshot.indicators` keys without parsing prose.
- `normalized/verified-market-snapshot.json` and `normalized/instrument-identity.json` are added to the run artifact tree.

---

## Related

- [ADR 0001 — Research-only boundary](./0001-research-only-boundary.md)
- [ADR 0008 — Provider-Normalized Instrument Identity](./0008-provider-normalized-instrument-identity.md)
- [ADR 0015 — Instrument error correction (ticker only)](./0015-instrument-error-correction-ticker-only.md)
- [ADR 0017 — Yahoo resilience + Massive fallback](./0017-yahoo-resilience-massive-fallback.md)
- [ADR 0018 — Run Artifact Index](./0018-run-artifact-index.md)
