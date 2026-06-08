# ADR 0017 — Yahoo resilience with optional Massive fallback

## Status

Accepted

## Context

Yahoo remains the primary equity market-data Source Provider for quotes, regime, benchmarks, alpha-search validation, and scoring closes. Yahoo movers (screeners) and Yahoo news stay unchanged. Live Yahoo routes were fragile in several places: quote auth retried only once, chart and screener routes skipped the credential wrapper, historical closes had no retries and failed silently, and there was no cross-provider fallback after exhausted Yahoo retries.

Massive is already integrated as a supplemental equity provider via `MARKET_BOT_MASSIVE_API_KEY`. Promoting Massive to the primary registry adapter was rejected in [ADR 0009](./0009-source-provider-modules.md); using it opportunistically after Yahoo failure is a narrower change.

## Decision

1. **Shared Yahoo resilience layer** (`src/sources/yahoo-resilience.ts`): extend cookie/crumb auth to all Yahoo finance hosts used by market-bot; invalidate cached credentials and retry up to three times on 401/403; prefetch credentials before batch quote requests; apply transient retries to direct chart fetches.
2. **Yahoo-specific stale cache window**: Yahoo market-data adapters use a shorter stale-cache fallback window (2 days) than the global default.
3. **Optional Massive fallback**: after Yahoo quote/chart/benchmark/alpha-search/scoring routes fail, try Massive snapshots, ticker details (market cap), and daily aggregates when `MARKET_BOT_MASSIVE_API_KEY` is set. If the key is unset, skip silently (preserve optional-key semantics). Movers stay Yahoo-only with no Massive fallback.
4. **Registry unchanged**: Yahoo remains the registered primary equity market-data adapter; Massive stays supplemental in `src/sources/providers.ts`.

## Consequences

- Equity market-data collection is more resilient without changing mover ranking inputs or Yahoo news behavior.
- Massive API usage may increase when Yahoo is degraded and a Massive key is configured.
- Alpha-search and scoring can succeed via Massive-normalized Yahoo-shaped payloads without renaming validation terminology.
- Tests must cover auth retries, chart/screener wrappers, Massive fallback, and Yahoo stale-cache tuning.

## Rejected alternatives

- **Replace Yahoo with defeat-beta-api or another remote primary provider** — defeat-beta is local Python/DuckDB, not a hosted HTTP API; remote alternatives were deferred in favor of hardening Yahoo.
- **Promote Massive to primary registry adapter** — rejected in ADR 0009; fallback-only keeps mover/regime semantics unchanged.
- **Require Massive key when fallback is enabled** — rejected; optional key preserves current supplemental semantics.

## References

- [Source provider modules (ADR 0009)](./0009-source-provider-modules.md)
- [Source Provider Contract](../source-provider-contract.md)
