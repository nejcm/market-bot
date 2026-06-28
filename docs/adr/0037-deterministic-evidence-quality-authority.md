# Deterministic Evidence Quality authority

## Status

Accepted

Evidence Quality is determined entirely from observable evidence properties such as coverage, freshness, corroboration, traceability, and Source Gap severity. Model output must not set or lower the label; model-authored uncertainty remains narrative, while Prediction probabilities remain independently calibrated observable forecasts. This makes Evidence Quality comparable across runs and restores the deterministic source-completeness contract stated in ADR 0004.

## Rubric

- `low`: required or core evidence is missing, stale, or unusable.
- `medium`: core evidence is complete, but material optional coverage or corroboration is missing.
- `high`: core evidence is complete, sufficiently broad material optional evidence is present, and freshness and corroboration requirements are met.

Missing material optional evidence therefore prevents `high` even when every required Evidence Lane is covered. Purely supplemental gaps do not lower Evidence Quality.

Source Plan v2 classifies applicable capability lanes as `core`, `material`, or `supplemental` from run type, depth, asset class, and dated-event context. The capability lanes are:

- `market-data`
- `supplemental-market`
- `news`
- `market-context`
- `verified-price-history`
- `regulatory-filings`
- `corporate-events`
- `macro-indicators`
- `derivatives-volatility`
- `on-chain`
- `target-valuation`
- `peer-valuation`
- `subject-profile`

Lane policy is provider-neutral. A covered capability may be supplied by any eligible provider; absence of a named paid provider is not itself a failed check. Derivatives are material only for a relevant dated event. Peer valuation is supplemental when target valuation is complete. Supplemental gaps never lower the label.

Each run persists rubric version, label, per-capability coverage/freshness/corroboration checks, and limiting reasons in trace and analytics.

## Compatibility

New reports write `evidenceQuality`; synthesis cannot author it. Readers continue to accept legacy `confidence` labels and mark historical uses as legacy. Source Plan v1 and Evidence Lanes v1 remain readable. The derived SQLite index uses an `evidence_quality` column and is rebuilt under schema version 9.

## Consequences

- The report retains the existing `high` / `medium` / `low` label values under the `evidenceQuality` field, with authority in deterministic report assembly.
- Evidence Quality must not be inferred from Prediction probability, narrative tone, or investment conviction.
- The mapping from individual Evidence Lanes and Source Gaps into core, material optional, and supplemental classes remains a separate policy decision.
