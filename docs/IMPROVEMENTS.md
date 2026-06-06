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

1. **#11 Prior-thesis error correction** — frame resolved prior outcomes on the current instrument as
   an explicit "we were wrong because…" block.
2. **#10 Prediction mix policy** — shift from measurement (done) to emission policy for thin kinds.


### Open follow-ups from completed work

- **Asset-class-aware calendar (from #5).** The NYSE calendar is applied to every asset class. This is
  correct-by-accident for crypto today (no crypto point forecasts; close-window value comes from the
  provider slice, so the calendar only gates timing). A proper crypto 7-day cadence — aligning the
  crypto gate with calendar-day value semantics — is a deliberate behavior change worth doing
  separately. **Effort:** S.
- **Post-synthesis critique pass (from #9).** Critique runs *before* `final-synthesis` emits formal
  `predictions[]` ([../src/research/orchestrator.ts:422](../src/research/orchestrator.ts)), so the
  directives prepare synthesis rather than auditing emitted predictions. A post-synthesis critique (or
  re-ordering) would let critique challenge the actual stated probabilities and feed a correction
  loop. **Effort:** M.

## #10 Economically thin prediction kinds (re-scoped: emission policy, not measurement)

- **Status:** Open (design). Per-kind skill measurement already exists (#3/#4); the remaining gap is
  the prediction **emission policy**, not measurement.
- **Evidence:** Five of six kinds reduce to "will close be higher / outside a band"
  ([../src/forecast/observable.ts:196-507](../src/forecast/observable.ts)); `direction` at 1-20d has a
  ~50% base rate, so it can mask signal in more informative kinds.
- **Fix:** Define a target forecast-kind mix per run type that favors `relative`/pairs (more research
  edge, more informative Brier) over bare `direction`.
- **Acceptance:**
  - Documented target forecast-kind mix per run type.
  - Test asserts that eligible reports emit more informative non-direction predictions where the
    evidence supports them.
- **Effort:** M.

## #11 History is retrieval, not error correction

- **Status:** Open (framing gap). Partially present. (Extends Cross-run intelligence below.)
- **Evidence:** Historical context **already includes** prediction score status/outcomes for selected
  runs ([../src/research/historical-context.ts](../src/research/historical-context.ts)); the gap is
  that it is not framed as *"this prior thesis on this instrument resolved `miss` — here is what was
  wrong."*
- **Fix:** Inject resolved-outcome deltas of prior theses on the **current instrument** as an explicit
  error-correction block, not just a citation pool.
- **Acceptance:**
  - Ticker prompts include capped prior-miss bullets, each with run ID, claim, stated probability,
    outcome, and source citation.
  - Empty/insufficient-history state renders cleanly (no placeholder noise).
- **Effort:** M.

## Data Pipeline — keep as-is (mature)

Cache canonicalization, stale-fallback-with-`SourceGap`, per-host retry/backoff/circuit-breaker at the
collector seam, seen-news index.

---

# Backlog

## Cross-run intelligence

First vertical slice implemented under Historical Research Context (see also audit finding #11, which
targets framing prior outcomes as instrument-level error correction):

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

- **Expand sources** — Include more sources than just Yahoo for daily and weekly runs. The near-term
  mover fan-in shipped as audit finding #6; broader regime inputs are tracked as #7.
- **Source provider health dashboard** — artifact-backed CLI validation exists via `provider-health`
  v2. A browsable dashboard is **not** a separate workstream: the calibration/reliability view (#12)
  is the first console dashboard surface, and provider health folds into it once run history is large
  enough to need browsing/filtering.
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
