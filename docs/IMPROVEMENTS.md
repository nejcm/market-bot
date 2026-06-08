# Improvements

## Cross-run intelligence

First vertical slice implemented under Historical Research Context:

- **Artifact-backed history indexes** from canonical `data/runs/<run-id>/` artifacts via `history rebuild`.
- **Session/run search** over prior reports, Sources, Predictions, Research Thesis components, open
  questions, fundamentals, and validation artifacts via `history search`.
- **Research Thesis delta tracking** — "what changed in the AAPL thesis since last Tuesday" — via
  deterministic `history thesis-delta`, with optional persisted `--narrative` summaries. (Audit
  finding #14 shipped the distinct, automatic, market-update-scoped Market Update Delta in the
  daily/weekly flow — see CONTEXT.md and `src/research/market-update-delta.ts`.)
- **Per-Instrument timelines** keyed by `assetClass:symbol`, preserving Instrument Identity metadata
  when available.
- **Historical Research Lead state** remains framed through alpha-search validation, candidate
  profiles, watchlists, and Fundamental Evidence trends, not a recommendation or confirmed alpha label.

## Operational & Monitoring 

- **Expand sources** — Include more sources than just Yahoo for daily and weekly runs. Near-term mover
  fan-in (#6) and richer regime drivers (#7) are shipped; further source expansion remains open.
- **Source provider health dashboard** — artifact-backed CLI validation exists via `provider-health`
  v2. The calibration CLI dashboard (#12) is the first stdout reliability surface. The Research
  Console App (`app/`) browses run history and aggregate metrics; folding provider-health browsing
  into it remains deferred until run history is large enough to need filtering.
- **Reliability SLAs, monitoring, alerting** — *not backlog-ready.* Before this can be picked up it
  needs: concrete metrics, thresholds per metric, alert channels, an owner, and runbook expectations.
  Park here until those are specified.

## Other (deferred)

- based on real runs implement improvements
- <https://github.com/defeat-beta/defeatbeta-api>
- Semantic/vector search across historical artifacts.
- Database-backed persistence once local JSON indexes become hard to query. SQLite is the likely first
  step; keep raw artifacts on disk if useful. If optimal use db only for metadata and references to
  files (artifacts of runs) on disk.
- improvements based on other projects
  - <https://github.com/TauricResearch/TradingAgents>
  - <https://github.com/HKUDS/Vibe-Trading>
