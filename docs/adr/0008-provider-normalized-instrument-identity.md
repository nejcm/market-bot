# ADR 0008: Instrument and research-subject identity

## Status

Accepted

## Date

2026-06-30

## Context

Provider symbols, listed instruments, thematic subjects, representative companies, and scored
proxies need deterministic identities without pretending the project has a global security master.

## Decision

- Keep `symbol + assetClass` as the compatibility identity for CLI input, matching, forecast DSL,
  history, and scoring.
- Preserve optional provider-normalized metadata such as exchange, quote currency, display name,
  provider IDs, and aliases in normalized artifacts.
- For an instrument run, derive one run-scoped canonical identity from the collected market
  snapshot. Do not perform a second identity fetch or cross-provider reconciliation.
- Use a checked-in equity Research Subject Registry for thematic research. Entries contain a
  canonical key, aliases, representative instruments, provenance, and an optional single listed ETF
  prediction proxy.
- Subject resolution is local and deterministic. Registry misses or subjects without an eligible
  proxy may produce research but produce no scored predictions.
- Representatives provide context only. They do not become forecast proxies or peer-comparison
  members unless another accepted rule explicitly selects them.

## Consequences

- Existing symbol-based artifacts and forecast syntax remain compatible.
- Thematic predictions remain observable against one declared listed instrument.
- Identity conflicts are disclosed rather than silently reconciled.

## Implementation validation

- `src/domain/instrument.ts` defines symbol normalization and validation.
- `src/sources/instrument-identity.ts` derives run-scoped identity.
- `src/research/subject-registry.ts` and `research-subject-identity.ts` implement thematic identity.

## Supersedes

- ADR 0027
