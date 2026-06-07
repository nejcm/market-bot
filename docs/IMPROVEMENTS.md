# Improvements Backlog

Two layers:

- **Audit findings** — concrete, validated defects and near-term fixes from an
  architecture/quant/UX audit (second-reviewed against the current repo). Ordered by leverage.
- **Expansion backlog** — longer-horizon thematic work (alpha search, cross-run intelligence,
  operational, monitoring).

All items are research-only ([ADR 0001](./adr/0001-research-only-boundary.md)): no trade actions,
sizing, or execution language.

Each open item carries explicit **Acceptance** gates so it can be picked up and QA'd without
re-deriving scope.

---

# Audit findings (prioritized)

## Recommended order (open items)

1. **#13 Run cost/latency** — surface trace cost estimates in the console/CLI.

### Open follow-ups from completed work

- **Asset-class-aware calendar (from #5).** The NYSE calendar is applied to every asset class. This is
  correct-by-accident for crypto today (no crypto point forecasts; close-window value comes from the
  provider slice, so the calendar only gates timing). A proper crypto 7-day cadence — aligning the
  crypto gate with calendar-day value semantics — is a deliberate behavior change worth doing
  separately. **Effort:** S.
- **Post-synthesis critique pass (from #9).** Critique runs *before* `final-synthesis` emits formal
  `predictions[]` ([../src/research/orchestrator.ts](../src/research/orchestrator.ts)), so the
  directives prepare synthesis rather than auditing emitted predictions. A post-synthesis critique (or
  re-ordering) would let critique challenge the actual stated probabilities and feed a correction
  loop. **Effort:** M.

## #13 Run cost/latency captured but not decision-surfaced

- **Status:** Open.
- **Evidence:** `trace.json` carries `tokenEstimate` and `costEstimateUsd` per run but the Research
  Console App and CLI only expose raw trace JSON.
- **Fix:** Surface running cost-per-run and cost-per-resolved-prediction so the `--deep` vs standard
  tradeoff is visible.
- **Acceptance:**
  - Operator can see per-run and aggregate cost from existing artifacts without opening raw trace JSON.
  - Research-only wording; no execution or sizing language.
- **Effort:** S.

## Data Pipeline — keep as-is (mature)

Cache canonicalization, stale-fallback-with-`SourceGap`, per-host retry/backoff/circuit-breaker at the
collector seam, seen-news index.

---

# Backlog

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
