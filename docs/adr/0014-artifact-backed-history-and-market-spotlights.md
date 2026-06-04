# ADR 0014 — Artifact-backed Historical Context and Market Spotlights

## Status

Accepted

## Context

Daily and weekly Market Updates should stay broad market overviews while still flagging unusual current movers when that is useful. Ticker runs should remain the detailed single-instrument path, with enough prior-run context to explain what changed since earlier research.

The pipeline already has provider-neutral adaptive stages: ADR 0010 adds a bounded Evidence Request Loop without provider-native tools, and ADR 0011 adds a fixed deep Coverage Panel without fetching more sources or changing the report schema. History-aware research needs the same constraints: public research artifacts, auditable source IDs, bounded model calls, and no trading behavior.

The source cache is not suitable as research memory. It stores raw provider payloads for request reuse, may contain stale fallback data, and does not encode the synthesized findings, gaps, forecasts, or scored outcomes that prior reports expose.

## Decision

Add Historical Research Context by scanning only `MARKET_BOT_DATA_DIR` run artifacts. The reader loads matching `report.json` files, optional `score.json`, and selected normalized snapshots. It selects recent runs within the configured lookback and older anchor runs at configured month offsets, deduped by run ID.

Ticker jobs include same-symbol ticker history plus same-asset daily/weekly market-update history. This context is loaded before the Evidence Request Loop so eligible deep ticker runs can react to prior-run changes when requesting extra public evidence.

Daily and weekly jobs include same-asset market-update history, with same-cadence runs prioritized. Weekly jobs may show artifact-derived run-to-run deltas, but must not present them as true trailing 5-session or 7-day mover data.

Add Market Spotlights for daily and weekly jobs. Spotlight candidates must come from the current collected market snapshot universe. Mover features, benchmark context, history availability, and alpha-search watchlist annotations may enrich candidates, but they cannot create a candidate without current market evidence.

Add a `spotlight-selection` quick-model stage before Domain Playbook selection for eligible market updates. The selector returns JSON, may choose zero candidates up to the configured cap, and rejects malformed JSON, unknown symbols, duplicates, cap overflow, and unknown source IDs into trace audit data. The run continues with valid selections or no spotlights.

Prior reports are appended as citeable internal Sources with `kind: "model"` and stable IDs such as `history-report-<runId>`. Compact artifacts are persisted under `normalized/historical-context.json`, plus market-update `normalized/spotlight-candidates.json` and `normalized/spotlight-selection.json`. Rendered report additions use `report.extras.historicalContext` and `report.extras.spotlights` rather than a top-level report schema migration.

History can inform forecast wording and probability calibration only. Prediction counts, subjects, and horizons remain governed by the existing run configuration.

Historical context gaps are soft gaps. First-run or no-history cases do not fail provider-health and do not become provider `SourceGap`s.

## Consequences

- Ticker reports can compare against prior same-symbol research without changing the public ticker command.
- Market updates remain overview-first and only go deeper on selected current spotlights.
- The selector adds at most one quick-model call to daily and weekly research when spotlight caps and candidates allow it.
- History is auditable through run artifacts and internal source IDs, not opaque provider state.
- Weekly history can support run-to-run artifact comparison, but true trailing-window mover claims still require explicit provider support.

## Rejected alternatives

- **Nested ticker jobs for market spotlights** — rejected because it would blur job boundaries, add uncontrolled latency/cost, and make daily/weekly updates behave like batches of ticker runs.
- **Provider-native tools or agents** — rejected for the same provider-neutrality and auditability reasons as ADR 0010 and ADR 0011.
- **Mining `data/cache` for history** — rejected because the cache is raw source reuse state, not synthesized research memory, and stale cache fallback semantics differ from report history.
- **Auto-upgrading to `--deep`** — rejected because public depth controls should remain predictable.
- **Top-level report schema migration** — rejected because historical and spotlight rendering can live in `report.extras` while preserving existing report consumers.

## References

- [ADR 0001 — Research-only boundary](./0001-research-only-boundary.md)
- [ADR 0010 — Bounded provider-neutral Evidence Request Loop](./0010-evidence-request-loop.md)
- [ADR 0011 — Fixed Coverage Panel for deep research](./0011-fixed-coverage-panel-for-deep-research.md)
- [ADR 0012 — Model-requested Domain Playbooks](./0012-model-requested-domain-playbooks.md)
