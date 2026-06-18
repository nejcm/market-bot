# Run Analysis - 2026-06-18

Scope:

- `market-overview --asset equity`: `data/runs/2026-06-18T10-04-01-275Z-2cd6e16d`
- `ticker AAPL --asset equity`: `data/runs/2026-06-18T10-06-24-859Z-2914f121`
- `alpha-search --asset equity`: `data/runs/2026-06-18T10-08-32-672Z-ae5c4f48`
- `research`: `data/runs/2026-06-18T10-19-30-563Z-62a1d416`

Reviewed artifacts: `report.md`, `report.json`, `trace.json`, `analytics.json`, `stages.json` where present, `score.json` where present, and relevant normalized sidecars.

Validation update: a second review was checked against artifacts and source. Its major factual claims were confirmed. The main correction is that the research run failures are one proxy-propagation root cause, not independent defects, and the VIX forecast on an AI-biotech research run is a critical ADR 0027 correctness issue because the resolved proxy was `XBI`.

## Phase 1 - Market Overview Equity

Run: `data/runs/2026-06-18T10-04-01-275Z-2cd6e16d`

### Snapshot

- Job type: `market-overview`
- Asset class: `equity`
- Horizon: 15 trading days
- Evidence quality: `low`
- Runtime: about 134 seconds
- Token estimate: 331,495
- Sources: 174 total
  - 151 Yahoo market-data sources
  - 15 selected news sources
  - 1 FRED market-context source
  - 7 model/history sources
- Forecasts: 1 pending forecast, target was 2
- Score status: 1 pending

### What Worked

- The report preserved the research-only boundary.
- The mixed-regime framing is well supported by the supplied proxy data: all major equity proxies were down intraday but above 50-day averages, while spot VIX was below VIX3M.
- The report disclosed the major weaknesses instead of overstating the tape: unexplained QURE/SLBT moves, lagged macro series, missing Massive supplemental snapshot, single-day mover universe, and prediction shortfall.
- Market update delta, historical context, market regime, spotlights, catalyst calendar, and scoring sidecars all persisted.
- Forecast assembly avoided padding to the target count.

### Issues and Improvement Opportunities

1. Evidence quality is constrained by unexplained spotlight movers.
   - QURE and SLBT are the central spotlights, but the run had no company-specific catalyst evidence for either.
   - This makes the strongest user-facing section dependent on price/volume only.
   - Improvement: after deterministic spotlight selection, run a narrow symbol-specific news pass for selected spotlights. Persist whether spotlight-level news was fetched, missing, or suppressed by the seen-news index.

2. The 15-day overview still uses a single-day mover universe.
   - The report discloses this correctly, but it limits the usefulness of the 15-day horizon.
   - Improvement: compute trailing 5/15/20 trading-day returns from Yahoo chart bars for a stable liquid universe, then rank movers by horizon-aligned change. Keep the current Yahoo screeners as same-day context, not as the only mover seed.

3. Forecast variety is thin.
   - Only one VIX volatility forecast shipped.
   - Stage output considered a QQQ/SPY relative forecast, but final synthesis dropped it due weak support.
   - Improvement: add a prediction audit sidecar listing candidate forecasts, rejected forecasts, and rejection reasons. This would explain whether shortfalls come from weak evidence, DSL invalidity, duplicate horizons, or source coverage.

4. Brief run token usage is high.
   - A brief market overview used a 331k token estimate.
   - The source set contained 151 market snapshots and 40 spotlight candidates.
   - Improvement: compact prompt payloads before model stages. For brief runs, pass ranked top-N movers plus aggregate breadth/sector summaries instead of broad raw source arrays.

5. Same-day market update delta is low-value when baseline is minutes old.
   - The delta says the mover set was unchanged versus a prior comparable run from about three minutes earlier.
   - Improvement: include baseline timestamp/age in the rendered delta and consider suppressing "unchanged" deltas when the prior baseline is too fresh to be meaningful.

6. Macro freshness needs clearer rendering.
   - The run correctly notes monthly macro series are lagged, but the catalyst calendar still makes FRED context look same-day.
   - Improvement: render observation dates for each macro series in the market-context block and calendar.

### Likely Code Owners

- Horizon-aligned mover inputs: `src/movers/`, `src/sources/`, `src/research/research-context.ts`
- Prediction shortfall/audit telemetry: `src/research/report-assembly.ts`, `src/research/run-analytics.ts`, `src/research/final-synthesis.ts`
- Market update delta rendering: `src/report/markdown.ts`, `src/research/market-update-delta.ts`

### Priority Fixes

- Add symbol-specific spotlight news fetch for selected movers.
- Add horizon-aligned trailing mover calculation for medium-horizon overviews.
- Add prediction rejection/audit sidecar.
- Compact brief-run prompt payloads.

## Phase 2 - Ticker AAPL Equity

Run: `data/runs/2026-06-18T10-06-24-859Z-2914f121`

### Snapshot

- Job type: `ticker`
- Symbol: `AAPL`
- Asset class: `equity`
- Evidence quality: `low`
- Runtime: about 123 seconds
- Token estimate: 166,375
- Sources: 39 total
  - 8 Yahoo market-data sources
  - 15 selected news sources
  - 4 extended-evidence sources
  - 12 model/history sources
- Extended evidence: SEC fundamentals, Finnhub events, FRED macro, valuation evidence
- Verified market snapshot: present, latest session `2026-06-17`, age 1 day
- Forecasts: 2 pending forecasts, target was 3
- Score status: 2 pending

### What Worked

- The verified market snapshot path worked and supplied OHLCV plus indicators.
- SEC fundamentals and valuation evidence were successfully incorporated.
- Historical context included prior AAPL misses and used them to pull probabilities toward base rates.
- The final forecasts are valid DSL forecasts:
  - `close(AAPL, +5) outside [285, 310]`
  - `close(AAPL, +5) > close(AAPL, 0)`
- The run disclosed missing Tradier options, Finnhub dividend/split 403s, Massive supplemental-market limitations, and thin near-term operating evidence.

### Issues and Improvement Opportunities

1. Evidence quality is low partly because optional provider failures are noisy.
   - Finnhub dividend and split endpoints returned 403.
   - Tradier options token was unset.
   - Massive supplemental-market snapshot was unavailable on the current plan.
   - Improvement: distinguish "core to thesis" gaps from "nice-to-have" gaps in evidence-quality scoring. Dividend/split failures should not weigh the same as missing options context for a 5-day range forecast.

2. Range forecast lacks implied-volatility support.
   - The report explicitly says options-implied expected move, skew, and event-risk context are unavailable.
   - Yet the run still emits a range/outside forecast.
   - Improvement: when Tradier is missing, fallback to deterministic realized-vol/ATR expected-move bands and disclose "realized-vol fallback" instead of relying mostly on narrative calibration.

3. Valuation evidence may be misleading because annualized revenue uses a partial period.
   - The report states EV/annualized revenue near 16.22x using 9-month revenue annualized to $270.3B.
   - The 9-month annualized basis is disclosed later in Extended Evidence, but the Key Findings headline drops the caveat.
   - For a seasonal mega-cap, straight annualization from an incomplete fiscal period can distort the multiple.
   - Improvement: prefer TTM revenue from SEC company facts when available. If not available, carry the period basis into the headline metric, e.g. "9-month annualized revenue, not TTM."

4. News relevance is still thin despite 15 selected news items.
   - Analytics showed 5 ticker-relevant selected news sources and 10 generic selected ticker news sources.
   - The report itself notes missing near-term operating evidence such as segment demand, regional sales, and order trends.
   - Improvement: add a second-pass ticker news query for issuer-specific operating/catalyst evidence when the first pass is dominated by valuation, rumor, or broad-market articles.

5. Intermediate stage forecast suggestions include shapes outside the final DSL.
   - Specialist output proposed ideas such as "AAPL closes above its 50-day SMA", which is not an allowed persisted forecast shape.
   - Final synthesis corrected this into valid `range` and `direction` forecasts.
   - Improvement: either stop requesting forecast ideas from non-final stages or require all stage-level forecast suggestions to use `measurableAs`, so critique can evaluate the exact scored event.

6. Prediction target shortfall needs better explanation.
   - The report says 2 of 3 target forecasts shipped, but it does not explain why the third forecast was omitted.
   - Improvement: same prediction audit sidecar as Phase 1.

### Likely Code Owners

- Evidence quality weighting: `src/research/run-analytics.ts`, evidence quality assembly around source gaps
- Options fallback or range calibration: `src/sources/`, `src/research/final-synthesis.ts`, `src/forecast/observable.ts`
- Valuation evidence: source/extended evidence valuation builder
- Forecast prompt discipline: `src/research/research-context.ts`, `src/research/final-synthesis.ts`

### Priority Fixes

- Add realized-vol/ATR fallback for range forecasts when IV is missing.
- Rework valuation evidence to prefer TTM over annualized partial periods.
- Add issuer-specific second-pass news retrieval for ticker runs with low relevant-news coverage.
- Add prediction candidate/rejection audit.

## Phase 3 - Alpha Search Equity

Run: `data/runs/2026-06-18T10-08-32-672Z-ae5c4f48`

### Snapshot

- Job type: `alpha-search`
- Asset class: `equity`
- Evidence quality: `medium`
- Runtime: about 22 seconds
- Token estimate: 0
- Sources: 52 total
  - 25 ApeWisdom discussion/social sources
  - 25 SEC filing discovery sources
  - 1 listed-universe source
  - 1 Yahoo validation source
- Candidates:
  - 25 social candidates
  - 25 SEC candidates
  - 11 valid research leads
  - 39 rejected candidates
- Profile coverage:
  - 11 displayed leads
  - 10 candidate profiles with fundamentals
  - 17 fundamental gaps
  - 10 unmapped SEC filings
- Forecasts: none, as expected
- Score side effects: no `score.json`, as expected
- Alpha validation: present, all horizons unresolved because 5/20 trading-day horizons had not elapsed

### What Worked

- The workflow stayed model-free and emitted no forecasts, matching the alpha-search contract.
- Official listing filtering rejected ETFs, unsupported listing types, unresolved symbols, over-cap names, under-cap names, low-price names, and low-volume names.
- Rejected candidates were disclosed separately from research leads.
- SEC discovery and ApeWisdom discovery were both represented.
- Alpha validation sidecar was created and correctly marked all lead horizons as unresolved.

### Issues and Improvement Opportunities

1. Lead names can be truncated or low quality.
   - Example: `AIB` renders as "BlockchAIn Digital Infrastructu".
   - Improvement: prefer official listed-universe names or SEC entity names over Yahoo quote display names when Yahoo truncates or has odd capitalization.

2. Social momentum can be noisy for tiny samples.
   - Some valid ApeWisdom leads have 2-10 mentions.
   - `FA` has 2 mentions and 267 upvotes, producing an extreme upvotes-per-mention value.
   - Improvement: add sample-size confidence labels, winsorize upvotes-per-mention, or require minimum mention/upvote thresholds before high social rank influence.

3. Per-lead Yahoo validation source is too coarse.
   - Every lead cites the same `market-yahoo-alpha-search` source.
   - Improvement: emit per-symbol validation source IDs, e.g. `market-yahoo-alpha-search-QNT`, so individual lead rows are traceable without opening the aggregate sidecar.

4. Fundamental enrichment is under-rendered.
   - Candidate profiles include fundamentals for 10 of 11 leads, but the lead rows do not show a compact fundamental summary.
   - Improvement: add one short optional profile line per lead when fundamentals are present: revenue period, profitability, cash/debt, and missing-metric count.

5. SEC mapping gaps are aggregated but not easy to inspect from markdown.
   - The markdown reports grouped unmapped filing counts by form/date.
   - Improvement: add a compact "unmapped SEC filings" table or link each grouped gap to source IDs/accessions in the markdown.

6. Alpha report disclaimer mentions predictions even though alpha-search intentionally emits none.
   - This is safe but confusing.
   - Improvement: render an alpha-specific research-only note that omits the prediction sentence while preserving the no-advice boundary.

7. Fundamental gaps are not first-class data gaps in the rendered report.
   - `sec-fundamentals-source-gaps.json` contains 17 gaps, but the report only summarizes them as "Fundamental gaps: 17".
   - Improvement: render grouped fundamental gap reasons, not just the count.

### Likely Code Owners

- Alpha workflow/report extras: `src/alpha-search/workflow.ts`, `src/alpha-search/report-extras.ts`
- Alpha markdown rendering: `src/report/markdown.ts`
- Social score policy: alpha-search ranking code
- SEC fundamentals gap rendering: alpha-search profile/fundamental enrichment code

### Priority Fixes

- Improve lead display-name source selection.
- Add per-symbol Yahoo validation source IDs.
- Add sample-size-aware social momentum scoring or labels.
- Render compact fundamentals and grouped fundamental gaps.
- Add alpha-specific disclaimer text.

## Phase 4 - Research Run

Run: `data/runs/2026-06-18T10-19-30-563Z-62a1d416`

### Snapshot

- Job type: `research`
- Asset class: `equity`
- Research subject input: `Analyze the AI biotech landscape and equities`
- Resolved subject key: `biotech`
- Prediction proxy symbol: `XBI`
- Evidence quality: `low`
- Runtime: about 135 seconds
- Token estimate: 129,236
- Sources: 28 total
  - 6 Yahoo broad-market sources
  - 15 selected news sources
  - 7 model/history sources
- Forecasts: 1 pending forecast, target was 2
- Score status: 1 pending

### What Worked

- The report did not overclaim the AI-biotech evidence. It explicitly says direct AI-biotech evidence was not supplied.
- It disclosed the critical gaps:
  - no direct AI-biotech fundamentals or company-specific catalysts
  - no XBI market snapshot despite XBI being the proxy
  - no prior exact-subject research runs
  - weak attribution for prior biotech movers
  - missing Massive supplemental-market snapshot
- Historical context and source discipline helped the final output stay cautious.

### Major Issues

1. The markdown title is wrong.
   - The report renders as `# equity Market Overview`.
   - The persisted job type is `research`.
   - Likely cause: `src/report/markdown.ts` titles every non-ticker, non-alpha report as a market overview.
   - Fix: add a `research` title branch, e.g. `# <subject> equity Research View` or `# equity Thematic Research View`.

2. Research inherits market-overview run configuration.
   - `extras.depthProfile.predictionSubjects` contains `SPY`, `QQQ`, `^VIX`, and FRED macro series.
   - It does not contain `XBI`, even though `extras.proxyResolution.predictionProxySymbol` is `XBI`.
   - Likely cause: `src/config/runs.ts` only defines `RunKey = "market-overview-equity" | "market-overview-crypto" | "ticker"`, and `toRunKey()` falls through to `market-overview-equity` for non-ticker equity commands.
   - Fix: add an explicit research run key/config and inject the resolved proxy into `predictionSubjects` when one exists. This is the root cause behind the wrong forecast subject, missing XBI snapshot, off-subject spotlights, and zero-direct-evidence forecast gate.

3. The run emitted a broad-market VIX forecast instead of a thematic proxy forecast.
   - Forecast shipped: `max(close(^VIX), 0..+15) > 20`.
   - ADR 0027 says thematic predictions need a single listed ETF proxy before they can be scoreable in V1.
   - Since the resolved proxy was `XBI`, a broad VIX forecast does not score the AI-biotech subject.
   - Severity: critical. ADR 0027 requires proxy-scored predictions for a resolved proxy and zero predictions when no proxy is available; this run scored VIX instead of the subject proxy.
   - Fix: for `jobType: "research"`, restrict persisted forecasts to the resolved proxy symbol unless a future ADR explicitly permits context forecasts. If no proxy evidence exists, emit zero forecasts and disclose the proxy evidence gap.

4. Source collection did not fetch the proxy.
   - Data gap says no XBI snapshot is present despite XBI being the command's prediction proxy.
   - Normalized market snapshots contain broad proxies only.
   - Fix: research source collection should fetch the subject proxy, representative instruments from the subject registry, and subject-specific news. Broad market proxies should be context, not the primary evidence package.

5. Market spotlights are off-subject.
   - Spotlights are `^VIX`, `QQQ`, and `SPY`.
   - These are useful market context, but they are not AI-biotech spotlights.
   - Fix: suppress market spotlights for research runs unless they are subject/proxy/representative instruments, or introduce a separate thematic spotlight section.

6. Historical context overweights market-overview runs because no same-subject research exists.
   - The report cites market overviews to discuss biotech/healthcare dispersion.
   - That is acceptable as context, but it should not substitute for direct subject evidence.
   - Fix: make the prompt separate "broad market context" from "subject evidence" for research runs, and require the final synthesis to label broad-market-only sections explicitly.

7. Playbook duplicate telemetry looks inconsistent.
   - Trace selected `source-discipline` for both critique and final-synthesis, then also recorded duplicate rejections for the same stage/playbook pairs.
   - Validated source detail: `src/research/playbooks.ts` already dedupes by `(stage, playbookId)` through the `${stage}:${playbookId}` key.
   - Likely cause: mandatory `source-discipline` selections are added first, then the model re-proposes the same mandatory playbook and the duplicate is logged as a rejection.
   - Fix: either suppress duplicate-rejection telemetry when the duplicate is already selected, or exclude mandatory playbooks from selector candidates. This is cosmetic telemetry, not a selection behavior bug.

8. Evidence quality correctly ended low, but the run still produced a forecast.
   - Given no XBI evidence, a zero-prediction research report would be more faithful than a broad-market VIX forecast.
   - Fix: add a research-specific forecast gate: proxy snapshot required for proxy forecasts; no proxy snapshot means no scored predictions.

### Likely Code Owners

- Research run config: `src/config/runs.ts`
- Research context and proxy handling: `src/research/research-context.ts`, `src/research/research-subject-identity.ts`, `src/research/subject-registry.ts`
- Source collection for research subjects: `src/research/orchestrator.ts`, `src/sources/`
- Markdown title/rendering: `src/report/markdown.ts`
- Prediction validation/assembly: `src/research/report-assembly.ts`, `src/forecast/observable.ts`
- Historical-context selection: `src/research/historical-context.ts`

### Priority Fixes

- Add explicit research run config and tests.
- Put resolved proxy symbols into `depthProfile.predictionSubjects`.
- Fetch proxy market snapshot and subject-specific sources for research runs.
- Gate research forecasts to the resolved proxy, or emit zero forecasts when proxy evidence is absent.
- Fix research markdown title.
- Replace market spotlights with subject-aware thematic spotlights or suppress them for research.

## Cross-Run Themes

### Source Coverage

- Massive supplemental-market gaps appear in three non-alpha runs. If the current plan cannot support this path, either downgrade its evidence-quality weight or make the gap less prominent unless the run depends on it.
- Ticker options coverage is a high-value missing input for short-horizon range forecasts. Tradier or a deterministic realized-vol fallback should be prioritized.
- Company-specific news is the weakest repeated area:
  - QURE and SLBT had no company-specific explanation in market overview.
  - AAPL had limited near-term operating evidence.
  - Research had no direct AI-biotech evidence.

### Prediction Quality

- Three forecast-producing runs missed their target count:
  - Market overview: 1 of 2
  - AAPL ticker: 2 of 3
  - Research: 1 of 2
- Shortfall disclosure works, but the reason is opaque.
- Add a persisted prediction audit with candidate forecast, validation status, dropped reason, and final reason. This will make shortfalls actionable.
- Calibration context matters: equity calibration at generation had Brier skill about -0.125 versus the always-0.5 baseline, so low-confidence probabilities and refusal to pad forecast counts are appropriate restraint, not automatically a defect.

### Research-Only Boundary

- All runs stayed within the no-advice boundary.
- Alpha-search should get a more precise disclaimer because it intentionally has no predictions.

### Rendering and Product Polish

- Research run title is incorrect.
- Alpha lead names can be truncated.
- Per-symbol source traceability is weak in alpha-search.
- Market update delta should include baseline age.
- Macro series should render observation dates.

## Recommended Fix Order

1. Fix research run semantics (critical ADR 0027 issue):
   - explicit research config
   - proxy in prediction subjects
   - proxy source collection
   - proxy-only or zero forecast gate
   - research markdown title

2. Add prediction audit telemetry:
   - candidate forecasts
   - dropped/invalid reasons
   - shortfall rationale

3. Improve source coverage:
   - selected-mover company news pass
   - ticker second-pass operating/catalyst news
   - realized-vol fallback when Tradier IV is absent

4. Improve alpha-search report traceability:
   - per-symbol Yahoo source IDs
   - better lead names
   - social sample-size labels
   - compact fundamentals and grouped fundamental gaps

5. Reduce brief-run prompt bloat:
   - compact broad source arrays
   - cap or summarize market snapshots and spotlight candidates
