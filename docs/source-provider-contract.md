# Source Provider Contract

Use this checklist before adding or promoting a Source Provider. Provider-level decisions come first; per-capability adapter details come after.

## Provider intake

- Name the Source Provider and the capability adapters it will expose: primary market data, supplemental market data, news, Extended Evidence, Market Context, or scoring Observations.
- Define every required environment variable in `src/config.ts` and `docs/configuration.md`. Do not store secrets in code, tests, fixtures, or artifacts.
- Declare the provider role:
  - primary Source Providers emit `SourceGap`s when expected credentials are missing;
  - Supplemental Source Providers may silently disable when unconfigured;
  - configured provider failures emit `SourceGap`s.
- State whether the provider contributes report evidence only or scoring Observations too. New providers default to report evidence only.
- Keep all provider behavior inside the research-only boundary ([ADR 0001](./adr/0001-research-only-boundary.md)): no trade actions, order/account endpoints, sizing, execution, allocation, or portfolio-change language.

## Capability adapter checklist

- Map provider payloads into existing normalized shapes only: `Source`, `MarketSnapshot`, `ExtendedEvidence`, `MarketContext`, or `Observation`.
- If a new normalized artifact shape is needed, make that a separate design decision before implementing the provider.
- Preserve Instrument Identity fields when the provider exposes useful metadata, such as exchange, quote currency, display name, provider IDs, or aliases. Do not reconcile conflicting provider identities unless a separate design accepts that behavior.
- Every new provider-controlled prose or short-label path that can reach model context must select
  an existing profile in `src/sources/model-input-sanitizer.ts` at the provider-neutral normalized
  emit boundary. Preserve the raw snapshot, validate structured IDs/dates/URLs separately, and carry
  text-free aggregate telemetry through `modelInputSanitization`.
- Use the `CollectContext` `ctx.request.json({ url, adapter, init })` seam for JSON source HTTP calls and `ctx.request.text({ url, adapter, init })` for text/HTML source HTTP calls. Adapters describe provider URLs, request headers/init, adapter identity, and any provider-specific fetch wrapper; the collector owns timeout, retry/backoff, cache, rate limiting, circuit breaking, stale cache fallback, and Source Provider capability composition ([ADR 0004](./adr/0004-evidence-identity-providers-deterministic-analysis.md)).
- Make `SourceGap`s carry typed provider/capability/cause meaning plus a stable human-readable message. Causes should distinguish missing credential, fetch failure, circuit open, stale cache fallback, unsupported coverage, repeat fallback, malformed response, validation failure, and provider data missing.
- Set `SourceGap.evidenceQualityImpact` from source semantics instead of relying on message text. Market Context gaps and supplemental-provider gaps that cannot lower core evidence quality are `no-cap`; missing optional news credentials (MarketAux, Finnhub) also use `no-cap` because Yahoo news still runs; Extended Evidence gaps participate in the Extended Evidence cap check; core market/news/source-collection gaps are core caps.
- Keep scoring Observations behind explicit promotion. Promotion requires an observable forecast use ([ADR 0003](./adr/0003-forecasts-scoring-calibration-cross-run-intelligence.md)), coverage behavior, resolver wiring, and tests.

## Test floor

Add source-adapter seam tests for:

- normalized output and Instrument Identity mapping;
- sanitizer-profile behavior for every model-visible prose or short-label field, including safe
  factual retention, unsafe-span removal/rejection, field bounds, and unchanged raw snapshots;
- successful collection for each capability;
- missing credential and provider failure behavior;
- registry wiring and asset-class routing;
- scoring resolver behavior only when the provider is promoted to Observations.

Mock at the source adapter seam rather than global `fetch`.

## Worked example: Massive audit

Massive satisfies this contract as a supplemental-only equity Source Provider:

- `MARKET_BOT_MASSIVE_API_KEY` is documented in `docs/configuration.md`.
- Missing credentials silently disable Massive because it is supplemental-only.
- Configured Massive failures emit `SourceGap`s for `massive-news` and `massive-supplemental-market` with `evidenceQualityImpact: "no-cap"`.
- Massive maps equity news into `Source` and stock snapshots into `MarketSnapshot`.
- Massive snapshot identity preserves the provider ticker as an Instrument Identity alias.
- Massive uses the shared `ctx.request.json` path for source timeout, retry, cache, rate-limit, circuit-breaker, and stale fallback behavior.
- Massive does not replace Yahoo, run for crypto, affect mover ranking or market regime, or contribute scoring Observations.
- Existing seam tests cover Massive normalization, registry wiring, missing-key silence, equity-only routing, supplemental snapshot collection, news round-robin inclusion, and configured failure gaps.

## Deterministic deep-equity packet tools

Deep-equity packet tools are Source Provider consumers, not model-provider native tools. They must:

- be enumerated by name and validated before execution;
- use only public-data providers and never account, order, portfolio, private, or trading endpoints;
- run through `ctx.request.json` or `ctx.request.text`;
- emit normal `Source`, `ExtendedEvidence`, raw snapshots, and `SourceGap`s.

The compatibility tool identifiers are `sec_latest_filing` and
`tradier_iv_term_structure`, scoped to deep equity ticker research. The target
SEC packet and Tradier packet execute deterministically; no model selects either
tool. The SEC packet retrieves the latest 10-K, a newer 10-Q, and eligible
recent 8-K/6-K filings. The Tradier packet unions event and
7/30/60/90-day expirations before fetching each unique chain once.

## Verified Market Snapshot

The Verified Market Snapshot ([ADR 0004](./adr/0004-evidence-identity-providers-deterministic-analysis.md)) is a supplemental normalized shape for equity ticker runs, not a provider capability. It is collected by `src/sources/verified-market-snapshot.ts` through the shared `ctx.request.json` path (adapter `yahoo-verified-chart`) and must never use `fetchYahooCloseWindow` or the Massive closes-only fallback — on failure it emits a core-cap `SourceGap` instead of a degraded snapshot. Its citeable report Source ID comes from `verifiedSnapshotSourceId(symbol)`.
