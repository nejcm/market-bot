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

1. **#10 Prediction mix policy** — shift from measurement (done) to emission policy for thin kinds.
2. **#13 Run cost/latency** — surface trace cost estimates in the console/CLI.


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

## #7 Regime signal is thin for the weight it carries — SHIPPED

- **Status:** Done. Equity regime classification now aggregates three deterministic drivers across
  `SPY`/`QQQ`/`IWM`/`DIA`: same-day **breadth**, **trend** (price vs 50-day average), and **VIX term
  structure** (`^VIX` vs `^VIX3M`; backwardation is risk-off). Majority vote sets the label; elevated
  `^VIX` still forces `risk-off`. Regime proxy symbols are partitioned out of mover ranking so a name
  can supply regime inputs without polluting the mover set
  ([../src/research/regime.ts](../src/research/regime.ts),
  [../src/domain/regime-symbols.ts](../src/domain/regime-symbols.ts)). Tests in
  [../tests/regime.test.ts](../tests/regime.test.ts) and
  [../tests/collector.test.ts](../tests/collector.test.ts).

## #11 History is retrieval, not error correction — SHIPPED

- **Status:** Done. Prior theses on the current instrument that resolved `miss` are injected as an
  explicit error-correction block (`buildPriorThesisErrorBlock`,
  [../src/research/research-context.ts](../src/research/research-context.ts)), wired into the evidence
  payload as `priorThesisErrors`. Capped prior-miss bullets carry run ID, claim, stated probability,
  outcome, and source citation; empty/insufficient history omits the block. Tests in
  [../tests/research-context.test.ts](../tests/research-context.test.ts).
- **Enrichment (shipped):** Each bullet now also surfaces the **observed resolution values** (e.g.
  `close0`/`closeN`) compacted from `score.json` via `HistoricalPredictionSummary.scoreEvidence`, so
  "diagnose why the prior thesis was wrong" has the actual outcome data, not just the verdict.
- **Scope boundary (deliberate):** Fires for **ticker runs only**. Market-update predictions are
  index/macro by design ([../src/config/runs.ts](../src/config/runs.ts)), so a spotlighted instrument
  has no same-instrument scored prediction to correct. See
  [../docs/adr/0015-instrument-error-correction-ticker-only.md](./adr/0015-instrument-error-correction-ticker-only.md).

## #12 Calibration track record is buried — SHIPPED

- **Status:** Done. The `calibration` CLI command rebuilds `data/calibration/summary.json` and
  `summary.md`, then renders a reliability dashboard to stdout via `renderCalibrationConsole`
  ([../src/scoring/calibration-console.ts](../src/scoring/calibration-console.ts)): resolved count,
  overall Brier and Brier skill, reliability bins (stated probability vs hit rate), and per-kind /
  per-horizon skill slices. Samples below `MIN_CALIBRATION_SAMPLE` (5) show a small-sample warning
  instead of slice tables. Tests in [../tests/scoring.test.ts](../tests/scoring.test.ts).

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
