# Improvements Backlog

Two layers:

- **Audit findings** — concrete, validated defects and near-term fixes from an
  architecture/quant/UX audit (second-reviewed against the current repo). Ordered by leverage.
- **Expansion backlog** — longer-horizon thematic work (alpha search, cross-run intelligence,
  operational, monitoring).

All items are research-only ([ADR 0001](./adr/0001-research-only-boundary.md)): no trade actions,
sizing, or execution language.

---

# Audit findings (prioritized)

## Recommended order

1. ✅ Fix calibration context shape (#1) + validate `summary.json` at the boundary (#2).
2. ✅ Surface `byKind` and `byHorizonBucket` slices (#3); report Brier **and** Brier skill vs the 0.25 baseline (#4).
3. Add probability-setting discipline to `synthesis-discipline.md`.
4. Strengthen `critique-discipline.md` around disconfirmation of the final predictions.
5. Scoring calendar correctness (holiday handling).
6. Mover fan-in (`day_losers` / `most_actives`) — see also Operational → *Expand sources*.
7. Richer regime signal.
8. Calibration/reliability dashboard in the console — see also Operational → *health dashboard*.
9. Wire prior-thesis resolved outcomes into the history prompt as error correction.

## 🔴 Critical — the self-calibration loop feeds the model malformed data

The headline differentiator ("the bot grades itself and learns") is broken at the
producer/consumer seam. Confirmed by review.

### 1. Calibration bin shape mismatch

- **Status:** ✅ Fixed. `CalibrationContext` now reuses `Partial<CalibrationSummary>`; the
  `priorCalibration` block renders `label` / `hitRate` / `totalCount` from real summary bins behind
  the shared `parseCalibrationBin` validator (also used by the disk boundary in #2). Regression
  test in `tests/research-context.test.ts` asserts no `undefined`/`NaN` and that the real bin
  label, hit rate, and sample count render.
- **Evidence:**
  - Producer writes bins as `{ pLow, pHigh, label, hitCount, totalCount, hitRate }`
    ([../src/scoring/calibration.ts:42-67](../src/scoring/calibration.ts)).
  - Consumer renders `bin.kind`, `bin.pBin`, `bin.sampleCount`
    ([../src/research/research-context.ts:31-36,134](../src/research/research-context.ts)).
  - Only `hitRate` overlaps, so the prompt block emits
    `undefined pundefined: stated=undefined actual=0.45 (n=undefined)` for every bin.
- **Impact:** The per-bin calibration signal the model sees is noise. The "self-calibrating"
  claim is not currently real in the prompt path.
- **Fix:** Align `CalibrationBinSummary` with the real `CalibrationBin` shape (or add a
  deterministic transform), so `label`/counts/hit rate render from actual `CalibrationSummary`
  JSON.
- **Test (required):** A regression test around `buildStagePrompt()` / the `priorCalibration`
  block that asserts (a) the rendered string contains no `undefined`, and (b) labels and counts
  render from real `CalibrationSummary` JSON. Test the renderer, not just the type.
- **Effort:** XS.

### 2. Calibration boundary is unvalidated

- **Status:** ✅ Fixed. `loadCalibrationContext()` now delegates to a new exported
  `parseCalibrationContext(value: unknown)` that validates every field of the `CalibrationSummary`
  shape against the repo's existing guards (`readNumber`/`readString`/`isRecord`) and drops
  malformed pieces instead of casting through with `as`
  ([../src/research/research-context.ts](../src/research/research-context.ts)). Bins and
  per-slice metric maps are validated element-by-element via shared `parseCalibrationBin` /
  `parseCalibrationMetric` helpers (the bin validator is also reused by the prompt renderer, so
  #1's render guard and this boundary share one definition). Validation enforces the producer's
  **domain invariants** — probabilities in [0,1], non-negative/positive integer counts,
  `pLow < pHigh`, `hitCount <= totalCount` — so a finite-but-impossible value (e.g. `hitRate 1.5`)
  is dropped rather than rendered into the prompt. No Zod / new dependency
  ([ADR 0003](./adr/0003-oxc-toolchain.md)).
- **Evidence (original):** `loadCalibrationContext()` parsed JSON and cast `as CalibrationContext`
  with no runtime checks. This is exactly why #1 failed silently.
- **Tests:** `tests/calibration-context.test.ts` covers non-record inputs, wrong-primitive and
  non-finite fields, malformed bins / metric-map entries, missing file, invalid JSON on disk, and a
  disk round-trip that asserts poisoned fields (`brierScore: "..."`, partial bins) are stripped while
  valid fields survive.
- **Effort:** XS.

### 3. Actionable calibration slices are never surfaced to the model

- **Status:** ✅ Fixed. `buildCalibrationBlock()` now renders `byKind` and `byHorizonBucket` slices
  into the `priorCalibration` prompt block, each showing its Brier skill vs the always-0.5 baseline,
  followed by a directive: *"In any slice with negative skill, shade probabilities toward base
  rates."* ([../src/research/research-context.ts](../src/research/research-context.ts)). Slice skill
  is derived from the validated per-slice `brierScore` via the shared `brierSkillScore()` helper
  (#4), so the prompt's slice math and the producer's overall math share one definition.
- **Evidence (original):** `byKind`, `byHorizonBucket`, `byAssetClass`, `byMarketUpdateCadence` were
  computed and written to `summary.json` / `summary.md`
  ([../src/scoring/calibration.ts](../src/scoring/calibration.ts)), but `priorCalibration` in the
  prompt only included overall Brier, count, and bins.
- **Test:** `tests/research-context.test.ts` asserts the rendered block surfaces overall skill, the
  per-kind (`direction`) and per-horizon (`1-5d`) slices, the base-rate directive, and no
  `undefined`/`NaN`.
- **Effort:** S.

### 4. No Brier skill vs baseline

- **Status:** ✅ Fixed. `buildCalibrationSummary()` now writes `brierSkillScore` (=
  `1 - brier / 0.25`) into `summary.json` alongside raw Brier, and `renderCalibrationMarkdown()`
  surfaces it in `summary.md`; the prompt block reports overall skill plus per-slice skill (#3)
  ([../src/scoring/calibration.ts](../src/scoring/calibration.ts),
  [../src/scoring/calibration-markdown.ts](../src/scoring/calibration-markdown.ts)). The disk
  boundary validates `brierSkillScore` against its achievable `[-3, 1]` range.
- **Evidence (original):** `brierScore()` returned raw Brier only; no baseline comparison.
- **Impact:** Raw Brier alone can't tell the model — or the operator — whether the bot has any
  edge. A model that learns nothing scores ~0.25 on coin-flip `direction` calls and looks "fine";
  skill 0 now makes that explicit.
- **Test:** `tests/scoring.test.ts` asserts skill 1 / 0 / -3 for Brier 0 / 0.25 / 1 and the markdown
  line; `tests/calibration-context.test.ts` asserts out-of-range skill is dropped at the boundary.
- **Effort:** S.

## Data Pipeline

Keep as-is (mature): cache canonicalization, stale-fallback-with-`SourceGap`, per-host
retry/backoff/circuit-breaker at the collector seam, seen-news index.

### 5. Scoring calendar correctness (holiday handling) — *re-scoped per review*

- **Status:** Valid but narrower than first stated.
- **Evidence:** `resolutionDate()` walks calendar weekdays and treats every weekday as a trading
  day ([../src/scoring/resolver.ts:38-48](../src/scoring/resolver.ts)).
- **Precise impact (corrected):**
  - **Close-window forecasts** (`direction`, `range`, `volatility`) resolve against
    provider-returned sessions *after* the due-date check, so a holiday does **not** corrupt the
    resolved price. The risk is a **premature `unresolved` attempt** when the weekday-derived due
    date arrives before the Nth real session.
  - **Point forecasts** (`fred`, `iv`) use the weekday-derived date directly and **can target the
    wrong date** across a holiday.
- **Fix:** Use an exchange calendar for the due-date check and for point-forecast target dates, or
  derive both from provider-returned sessions end-to-end (as close-window resolution already does).
- **Effort:** S.

### 6. Mover selection bias

- **Status:** Confirmed. (Expands Operational → *Expand sources* with a specific, low-effort step.)
- **Evidence:** Equity movers come only from Yahoo `day_gainers`
  ([../src/sources/yahoo.ts:132](../src/sources/yahoo.ts)). Disclosed as a `SourceGap`, but the bot
  structurally never sees losers, gap-downs, or unusual-volume-without-price-move names.
- **Fix:** Fan in `day_losers` + `most_actives` (existing fetch plumbing) before mover ranking.
- **Effort:** S.

### 7. Regime signal is thin for the weight it carries

- **Status:** Confirmed.
- **Evidence:** `summarizeMarketRegime()` counts green/red across 4 ETFs (SPY/QQQ/IWM/DIA) plus a
  single binary `^VIX >= 25` override
  ([../src/research/regime.ts:65-90](../src/research/regime.ts)). The proxies are genuinely fetched
  ([../src/sources/yahoo.ts:134,391,431](../src/sources/yahoo.ts)), so the classifier has real
  input — it's just a one-day, 4-name signal feeding every downstream stage.
- **Fix (incremental):** add (a) VIX term structure (VIX vs VIX3M; backwardation > level threshold
  as a risk-off signal), (b) a trend component (proxy vs its own 20/50-day MA), and (c) broader
  breadth (% above MA / advance-decline) where feasible.
- **Effort:** M.

## Reasoning

### 8. Prompts don't teach calibrated-probability discipline

- **Status:** Confirmed, with nuance.
- **Evidence:** Base stage prompts are minimal
  ([../prompts/specialist-analysis/base.md](../prompts/specialist-analysis/base.md),
  [../prompts/final-synthesis/base.md](../prompts/final-synthesis/base.md)); the output **schema**
  is injected structurally via `finalReportShape()`
  ([../src/research/research-context.ts:243-277](../src/research/research-context.ts)), which is
  fine. Playbooks exist and are injected, but `synthesis-discipline.md` does not teach probability
  setting / base rates / Brier discipline.
- **Correction:** It is **not** true that there is "no instruction anywhere" — playbooks are
  present. The specific gap is calibrated-probability guidance.
- **Fix:** Add base-rate anchoring, widen-on-thin-evidence, and the Brier cost of overconfidence to
  `prompts/playbooks/synthesis-discipline.md`. Pairs with #3.
- **Effort:** S.

### 9. Critique lacks prediction-specific disconfirmation

- **Status:** Confirmed.
- **Evidence:** The critique playbook challenges weak claims generally but does not mandate the
  strongest bear case **against the final predictions**, nor flag probability/evidence-strength
  mismatch
  ([../prompts/playbooks/critique-discipline.md](../prompts/playbooks/critique-discipline.md)).
- **Fix:** Add a directive to (a) construct the strongest disconfirming case for each emitted
  prediction and (b) flag predictions where stated probability diverges from cited evidence
  strength. Free — the stage already runs.
- **Effort:** S.

### 10. Economically thin prediction kinds

- **Status:** Open (design consideration).
- **Evidence:** Five of six kinds reduce to "will close be higher / outside a band"
  ([../src/forecast/observable.ts:196-507](../src/forecast/observable.ts)); `direction` at 1-20d
  has a ~50% base rate.
- **Fix:** Favor `relative`/pairs defaults (more research edge, more informative Brier) and report
  per-kind skill separately so `direction` noise doesn't mask signal elsewhere. Depends on #4.
- **Effort:** M.

### 11. History is retrieval, not error correction — *re-scoped per review*

- **Status:** Partially present; framing gap is real. (Extends Cross-run intelligence below.)
- **Evidence:** Historical context **already includes** prediction score status/outcomes for
  selected runs ([../src/research/historical-context.ts](../src/research/historical-context.ts));
  the gap is that it is not framed as *"this prior thesis on this instrument resolved `miss` — here
  is what was wrong."*
- **Fix:** Inject resolved-outcome deltas of prior theses on the **current instrument** as an
  explicit error-correction block, not just a citation pool.
- **Effort:** M.

## User Experience

### 12. Calibration track record is buried

- **Status:** Confirmed. (Concrete first target for the deferred dashboards below.)
- **Evidence:** Calibration is exposed via CLI/markdown/provider-health presence, not as a console
  centerpiece. The numbers for a reliability diagram (stated prob vs actual hit rate per bin),
  Brier-vs-baseline trend, and per-kind/per-horizon skill are all already computed
  ([../src/scoring/calibration.ts](../src/scoring/calibration.ts)).
- **Fix:** Promote a reliability dashboard to the console as the product's proof of
  trustworthiness.
- **Effort:** M.

### 13. Run cost/latency captured but not decision-surfaced

- **Status:** Confirmed.
- **Evidence:** `trace` carries `tokenEstimate` and `costEstimateUsd`
  ([../src/research/orchestrator.ts:480-481](../src/research/orchestrator.ts)) but is only exposed
  as raw trace JSON in the console.
- **Fix:** Surface running cost-per-run and cost-per-resolved-prediction so the `--deep` vs
  standard tradeoff is visible.
- **Effort:** S.

### 14. No "what changed since yesterday" in the daily flow

- **Status:** Open.
- **Evidence:** `history thesis-delta` exists but is a separate manual verb.
- **Fix:** Promote a compact auto-delta into the daily report — regime change, new/dropped movers,
  predictions resolved since the last run.
- **Effort:** M.

---

# Expansion backlog

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

First vertical slice implemented under Historical Research Context (see also audit finding #11,
which targets framing prior outcomes as instrument-level error correction):

- **Artifact-backed history indexes** from canonical `data/runs/<run-id>/` artifacts via `history rebuild`.
- **Session/run search** over prior reports, Sources, Predictions, Research Thesis components, open questions, fundamentals, and validation artifacts via `history search`.
- **Research Thesis delta tracking** — "what changed in the AAPL thesis since last Tuesday" — via deterministic `history thesis-delta`, with optional persisted `--narrative` summaries. (Audit finding #14 proposes auto-surfacing a compact delta in the daily flow.)
- **Per-Instrument timelines** keyed by `assetClass:symbol`, preserving Instrument Identity metadata when available.
- **Historical Research Lead state** remains framed through alpha-search validation, candidate profiles, watchlists, and Fundamental Evidence trends, not a recommendation or confirmed alpha label.

Still deferred:

- Console UI over history indexes and thesis deltas.
- Semantic/vector search across historical artifacts.
- Database-backed persistence once local JSON indexes become hard to query.
- User-authored open questions and notes; V1 open questions are extracted from existing artifacts.

## Operational

- **Expand sources** - Include more sources than just Yahoo for daily and weekly runs. Concrete
  near-term step tracked as audit finding #6 (`day_losers` / `most_actives` fan-in); broader
  regime inputs tracked as #7.
- **Source provider health dashboard** - artifact-backed CLI validation exists via
  `provider-health` v2. Future work: turn this into a dashboard once the run history is large
  enough to need browsing/filtering. Audit finding #12 proposes the calibration/reliability view
  as the first dashboard surface.

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
