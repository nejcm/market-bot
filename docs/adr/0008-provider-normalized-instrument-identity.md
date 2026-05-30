# ADR 0008 — Provider-normalized Instrument identity

## Status

Accepted

## Context

V1 treated an Instrument as `symbol + assetClass`. That was enough for simple US equity and crypto runs, but provider expansion introduces listings, quote currencies, and provider-specific identifiers such as SEC CIKs and CoinGecko coin IDs. A full resolver or security master would add more complexity than the current workflows need.

## Decision

Instrument means a tradable listed or quoted research target. Keep `symbol + assetClass` as the compatibility key for CLI input, matching, forecast syntax, and scoring. Add optional Instrument Identity metadata to normalized artifacts where a Source Provider already exposes useful fields.

The first slice is metadata-only: no central resolver, no provider-qualified CLI syntax, no identity-based matching, and no cross-provider reconciliation.

## Consequences

- Existing commands and artifacts remain compatible at the top level.
- Source adapters can preserve exchange, quote currency, provider IDs, and aliases without forcing every caller to understand them.
- Future regional data and scoring work can build on stored identity metadata.
- Conflicts between providers are not resolved yet; identity stays attached to the source or snapshot that produced it.

## Rejected alternatives

- **Economic-asset identity** — rejected for now because scoring and market data need exact quoted listings.
- **Full Instrument resolver/catalog** — rejected as premature without multiple adapters requiring reconciled identity.
- **Provider-qualified CLI input** — rejected to keep the user workflow simple until identity changes behavior.
