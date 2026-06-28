# Analysis cutoff and stale-cache audit

## Status

Accepted

## Decision

Every model-stage evidence payload carries the run's `analysisAsOf` timestamp. SEC facts filed or ending after that cutoff are excluded. SEC flow metrics use one reporting period, revisions are selected within that period, and each emitted metric records its period end.

Cache hits are marked `current` or `stale-fallback`. A stale fallback remains in the raw snapshot for audit and emits an explicit Source Gap, but its payload is excluded from normalized current evidence.

Run traces persist SHA-256 fingerprints of effective non-secret configuration and dirty source state. Secret configuration values and ignored files do not affect those fingerprints.

## Consequences

- Historical artifacts remain immutable.
- Current synthesis cannot silently consume future SEC facts or stale cached values.
- A run can be reproduced against its cutoff, code revision, and privacy-safe fingerprints without persisting credentials.
