# Improvements Backlog

## Alpha search

Implemented alpha-search discovery, validation, and deterministic candidate state are documented in
`docs/how-it-works.md`, `docs/architecture.md`, and `docs/configuration.md`. This
section tracks remaining promotion and expansion work.

### Next

- **Source promotion criteria** - report-only labels in the Alpha validation summary that
  interpret source-group outcomes. Defaults: 30 resolved leads per source group/horizon,
  `promising` at hit rate >= 55% with positive average excess return, `weak` at hit rate
  <= 45% with negative average excess return, otherwise `mixed` or `insufficient-sample`.
  Provider-health validation failures block labels without hiding metrics. Do not promote
  individual Research Leads.
- **Feature attribution** - bucket deterministic candidate features against Alpha
  validation outcomes before changing ranking weights.

### Add after validation

- **Fundamentals enrichment** - attach existing SEC Fundamental Evidence metrics to Alpha
  candidate profiles/watchlist for attribution first. Do not use fundamentals in ranking
  until validation supports it.
- **Expanded signal ranking** based on explainable features beyond the current
  discovery/ranking inputs. Keep signal strength separate from Evidence Quality.

### Defer or skip

- **Narrative candidate report type** with thesis, why-now catalyst, evidence, bear case,
  risks, invalidation criteria, and source IDs. Defer until source criteria and attribution
  show Alpha leads are worth model-written reports.
- **New social/news providers** for alpha-search discovery. Defer until fundamentals
  attribution is available.
- **Automatic source changes** such as changing source weights, candidate budgets, or
  inclusion from criteria labels. Keep V1 criteria report-only.

## Cross-run intelligence

- **Narrative thesis-delta tracking** — "what changed in the AAPL thesis since last Tuesday". Long-term notes the bot consults across runs.
- **Incremental memory** — open questions and unresolved hypotheses carried forward.
- **Session/run search** over prior reports, sources, predictions, and theses.
- Finding alpha stocks with checking the growth, PE ratio, profits, etc... and comparing over time
- Store all artifacts per stock and track stats over runs and over time by comparing against historical data

## Operational

- **Source provider health dashboard** - artifact-backed CLI validation exists via
  `provider-health` v2. Future work: turn this into a dashboard once the run history is large
  enough to need browsing/filtering.
- **Database-backed persistence** once local files become hard to query. SQLite is the likely first step;
  keep raw artifacts on disk if useful. If optimal use db only for metadata and references to files (artifacts of runs) on disk.

## Product polish

- Web frontend for browsing the run history.
- Branding, themed report rendering.
- Reliability SLAs, monitoring, alerting.
- https://github.com/defeat-beta/defeatbeta-api

## Other (deferred)

- based on real runs implement improvements
- improvements based on other projects
  - https://github.com/TauricResearch/TradingAgents
  - https://github.com/HKUDS/Vibe-Trading
