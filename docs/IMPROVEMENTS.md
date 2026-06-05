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

1. **#12 Calibration dashboard** — the single console surface for trust (also absorbs the deferred
   "provider health dashboard" idea as the first dashboard).
2. **#13 Run economics** — surface cost/latency as a decision-grade "is `--deep` worth it?" view.
3. **#11 Prior-thesis error correction** — frame resolved prior outcomes on the current instrument as
   an explicit "we were wrong because…" block.
4. **#14 Daily auto-delta** — promote a compact automatic delta into the daily report.
5. **#10 Prediction mix policy** — shift from measurement (done) to emission policy for thin kinds.

## Completed (changelog)

Detailed evidence/test notes removed; these shipped and are validated by their tests.

1. ✅ **#1 Calibration bin shape mismatch** — `CalibrationContext` reuses `Partial<CalibrationSummary>`;
   `priorCalibration` renders real bin label/hitRate/count via shared `parseCalibrationBin`.
2. ✅ **#2 Calibration boundary validation** — `parseCalibrationContext()` validates every field +
   domain invariants and drops malformed pieces (no Zod / new dependency).
3. ✅ **#3 Actionable calibration slices surfaced** — `byKind` / `byHorizonBucket` skill + base-rate
   directive now render into the prompt.
4. ✅ **#4 Brier skill vs baseline** — `brierSkillScore` (`1 - brier/0.25`) written to summary and
   surfaced in markdown + prompt; boundary validates the `[-3, 1]` range.
5. ✅ **#5 Scoring calendar correctness** — `src/scoring/exchange-calendar.ts` derives NYSE closures
   deterministically; `resolutionDate()` advances over trading days in UTC, shared with alpha
   validation. *(Open follow-up below.)*
6. ✅ **#6 Mover fan-in** — `collectEquity` fans in `day_losers` + `most_actives` alongside
   `day_gainers`, deduped by symbol (`src/sources/yahoo.ts`).
7. ✅ **#8 Calibrated-probability discipline in prompts** — `synthesis-discipline.md` teaches
   base-rate anchoring, widen-on-thin-evidence, Brier cost, and per-slice skill shading.
8. ✅ **#9 Prediction-specific disconfirmation in critique** — `critique-discipline.md` mandates the
   strongest observable disconfirming case + probability/evidence mismatch flagging. *(Open follow-up
   below.)*
9. ✅ **#7 Regime v2** — `summarizeMarketRegime` aggregates three deterministic equity drivers —
   breadth, trend (`fiftyDayAverage` from the Yahoo regime quote), and VIX term structure
   (`^VIX` vs `^VIX3M`) — by majority vote, keeps the elevated-VIX risk-off override, and falls back
   to `insufficient-data` rather than silently defaulting to risk-on. Each driver is tied to its proxy
   source IDs (`src/research/regime.ts`).
10. ✅ **#15 Doc drift on mover sources** — README, CONTEXT, architecture, how-it-works, and the weekly
    gap string now describe the three-screener fan-in (`day_gainers` + `day_losers` + `most_actives`);
    the weekly gap string still discloses the single-day-vs-trailing-window limitation.

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

## #12 Calibration track record is buried (the dashboard)

- **Status:** Open. Confirmed. This is the **single** dashboard surface — it absorbs the deferred
  "provider health dashboard" idea (see Operational) as the first console dashboard.
- **Evidence:** Calibration is exposed via CLI/markdown/provider-health presence, not as a console
  centerpiece. The numbers for a reliability diagram (stated prob vs actual hit rate per bin),
  Brier-vs-baseline trend, and per-kind/per-horizon skill are all already computed
  ([../src/scoring/calibration.ts](../src/scoring/calibration.ts)).
- **Fix:** Promote a reliability dashboard to the console as the product's proof of trustworthiness.
- **Acceptance:**
  - Console shows overall Brier, Brier skill, resolved count, reliability bins, per-kind skill, and
    per-horizon skill.
  - Small-sample empty state when resolved count is below threshold.
- **Effort:** M.

## #13 Run cost/latency captured but not decision-surfaced

- **Status:** Open. Confirmed.
- **Evidence:** Token and cost estimates are captured in
  [../src/research/run-analytics.ts](../src/research/run-analytics.ts) (and carried on the trace), but
  only exposed as raw trace JSON in the console — not as decision-grade "is `--deep` worth it?"
  analytics.
- **Fix:** Surface running cost-per-run and cost-per-resolved-prediction so the `--deep` vs standard
  tradeoff is visible.
- **Acceptance:**
  - Console shows last-run cost, rolling median cost, token estimate, cost per prediction, and a
    deep-vs-standard comparison by job type.
- **Effort:** S.

## #14 No "what changed since yesterday" in the daily flow

- **Status:** Open.
- **Evidence:** `history thesis-delta` exists but is a separate manual verb, and it is
  instrument-oriented rather than an automatic daily market-flow delta.
- **Fix:** Promote a compact auto-delta into the daily report.
- **Acceptance:**
  - Daily report includes regime change, mover-set diff, and predictions resolved since the last
    same-cadence run.
  - Deterministic output, no manual CLI step.
- **Effort:** M.

## Data Pipeline — keep as-is (mature)

Cache canonicalization, stale-fallback-with-`SourceGap`, per-host retry/backoff/circuit-breaker at the
collector seam, seen-news index.

---

# Expansion backlog

## Alpha search

Implemented alpha-search discovery, validation, deterministic candidate state, Source Promotion
Criteria, feature attribution, and SEC fundamentals enrichment are documented in
`docs/how-it-works.md`, `docs/architecture.md`, and `docs/configuration.md`. This section tracks
remaining expansion work.

### Next

- **Validation-data review loop** *(data-gated)* — once source groups and feature buckets have enough
  resolved Alpha validation outcomes, review which inputs actually explain excess return. Keep this
  artifact-led: propose ranking changes only from observed source criteria and attribution, not from
  intuition.
  - **Gate:** define a minimum resolved-outcome threshold per source group / feature bucket before any
    ranking change is allowed. No ranking changes below threshold.
- **Expanded signal ranking experiments** based on validated deterministic features beyond the current
  discovery/ranking inputs. Keep signal strength separate from Evidence Quality, keep V1 rankings
  stable until an experiment is explicitly accepted, and document any ranking-policy change before
  implementation.

## Cross-run intelligence

First vertical slice implemented under Historical Research Context (see also audit finding #11, which
targets framing prior outcomes as instrument-level error correction):

- **Artifact-backed history indexes** from canonical `data/runs/<run-id>/` artifacts via `history rebuild`.
- **Session/run search** over prior reports, Sources, Predictions, Research Thesis components, open
  questions, fundamentals, and validation artifacts via `history search`.
- **Research Thesis delta tracking** — "what changed in the AAPL thesis since last Tuesday" — via
  deterministic `history thesis-delta`, with optional persisted `--narrative` summaries. (Audit
  finding #14 proposes auto-surfacing a compact delta in the daily flow.)
- **Per-Instrument timelines** keyed by `assetClass:symbol`, preserving Instrument Identity metadata
  when available.
- **Historical Research Lead state** remains framed through alpha-search validation, candidate
  profiles, watchlists, and Fundamental Evidence trends, not a recommendation or confirmed alpha label.

Still deferred:

- Console UI over history indexes and thesis deltas.
- Semantic/vector search across historical artifacts.
- Database-backed persistence once local JSON indexes become hard to query.
- User-authored open questions and notes; V1 open questions are extracted from existing artifacts.

## Operational

- **Expand sources** — Include more sources than just Yahoo for daily and weekly runs. The near-term
  mover fan-in shipped as audit finding #6; broader regime inputs are tracked as #7.
- **Source provider health dashboard** — artifact-backed CLI validation exists via `provider-health`
  v2. A browsable dashboard is **not** a separate workstream: the calibration/reliability view (#12)
  is the first console dashboard surface, and provider health folds into it once run history is large
  enough to need browsing/filtering.

## Monitoring

- **Reliability SLAs, monitoring, alerting** — *not backlog-ready.* Before this can be picked up it
  needs: concrete metrics, thresholds per metric, alert channels, an owner, and runbook expectations.
  Park here until those are specified.

## Other (deferred)

- based on real runs implement improvements
- <https://github.com/defeat-beta/defeatbeta-api>
- **Database-backed persistence** once local files become hard to query. SQLite is the likely first
  step; keep raw artifacts on disk if useful. If optimal use db only for metadata and references to
  files (artifacts of runs) on disk.
- improvements based on other projects
  - <https://github.com/TauricResearch/TradingAgents>
  - <https://github.com/HKUDS/Vibe-Trading>
