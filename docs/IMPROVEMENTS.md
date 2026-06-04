# Improvements Backlog

## Alpha search

Implemented alpha-search discovery, validation, deterministic candidate state, Source
Promotion Criteria, feature attribution, and SEC fundamentals enrichment are documented in
`docs/how-it-works.md`, `docs/architecture.md`, and `docs/configuration.md`. This
section tracks remaining expansion work.

### Next

- **Validation-data review loop** - once source groups and feature buckets have enough
  resolved Alpha validation outcomes, review which inputs actually explain excess return.
  Keep this artifact-led: propose ranking changes only from observed source criteria and
  attribution, not from intuition.
- **Expanded signal ranking experiments** based on validated deterministic features beyond
  the current discovery/ranking inputs. Keep signal strength separate from Evidence Quality,
  keep V1 rankings stable until an experiment is explicitly accepted, and document any
  ranking-policy change before implementation.

## Cross-run intelligence

First vertical slice implemented under Historical Research Context:

- **Artifact-backed history indexes** from canonical `data/runs/<run-id>/` artifacts via `history rebuild`.
- **Session/run search** over prior reports, Sources, Predictions, Research Thesis components, open questions, fundamentals, and validation artifacts via `history search`.
- **Research Thesis delta tracking** — "what changed in the AAPL thesis since last Tuesday" — via deterministic `history thesis-delta`, with optional persisted `--narrative` summaries.
- **Per-Instrument timelines** keyed by `assetClass:symbol`, preserving Instrument Identity metadata when available.
- **Historical Research Lead state** remains framed through alpha-search validation, candidate profiles, watchlists, and Fundamental Evidence trends, not a recommendation or confirmed alpha label.

Still deferred:

- Console UI over history indexes and thesis deltas.
- Semantic/vector search across historical artifacts.
- Database-backed persistence once local JSON indexes become hard to query.
- User-authored open questions and notes; V1 open questions are extracted from existing artifacts.

## Operational

- **Expand sources** - Include more sources than just Yahoo for daily and weekly runs
- **Source provider health dashboard** - artifact-backed CLI validation exists via
  `provider-health` v2. Future work: turn this into a dashboard once the run history is large
  enough to need browsing/filtering.

## Monitoring

- Reliability SLAs, monitoring, alerting.

## Other (deferred)

- based on real runs implement improvements
- <https://github.com/defeat-beta/defeatbeta-api>
- **Database-backed persistence** once local files become hard to query. SQLite is the likely first step;
  keep raw artifacts on disk if useful. If optimal use db only for metadata and references to files (artifacts of runs) on disk.
- improvements based on other projects
  - <https://github.com/TauricResearch/TradingAgents>
  - <https://github.com/HKUDS/Vibe-Trading>
