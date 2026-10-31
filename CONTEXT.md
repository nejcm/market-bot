# Market Bot Context

Domain glossary. Definitions state what a term means and the invariants that matter; mechanics live in [docs/architecture.md](./docs/architecture.md), the ADRs, and the code. Everything here is research-only: nothing implies a recommendation, trade signal, or portfolio action.

## Research artifacts and views

**Research View** — Sourced artifact summarizing evidence, uncertainty, scenarios, risks, and gaps.

**Research Thesis** — Research View narrative state: summary, findings, cases, risks, catalysts, gaps, and Predictions. Not an investment thesis.

**Default View** — Reader-facing surface of a deep-equity report or Console run: business, price with market date and freshness, a three-to-five-year plus TTM trend table, valuation context relative to the quote (never a target), catalysts and risks, upcoming earnings and consensus, and Material Gaps.

**Appendix** — Trailing detail surface: reverse DCF, full valuation and peer tables, excluded-peer diagnostics, institutional/insider detail, analyst distributions, options IV, financing bridge, capital ownership, and the five Financial Lenses. Collection drops nothing; only placement changes.

**Run Artifact** — Persisted output of one run at `MARKET_BOT_DATA_DIR/<run-id>/`. Later runs and history read it; Source Providers are never refetched for it. Layout in AGENTS.md.

**Failed Run Artifact** — Diagnostics of a run whose final synthesis never produced a valid Research View. `failure.json` marks it complete; `report.json` is deliberately absent.

**Run Artifact Index** — Rebuildable SQLite index over Run Artifacts for console/search/calibration queries. Disk artifacts stay authoritative; a missing or stale index falls back to disk or rebuilds.

**Subsystem Outcome** — Coded record of what one run subsystem was expected to do and whether it acquired output (`produced`), stayed `empty`, `declined`, `failed`, or was `blocked`. The statuses are not a clean taxonomy: each records how that subsystem's own producer classified its situation, so the same condition can map differently across subsystems (a missing Exa credential `declined`s Web Gather; a lane-local missing credential is `blocked`). The code beside the status is the specific part. `empty` means no output was accepted; accepted output with a usability posture stays `produced`. Run telemetry, not a Diagnostic Gap.

**Stage Duration** — Positive monotonic ms awaiting a model-stage attempt (`durationMs`). Not additive wall-clock time across concurrent stages.

## Research Console

**Research Console App** — Local UI for run history, Research Views, Sources, gaps, evidence quality, analytics, and provider health.

Console-only user state lives in the Console DB (`data/console/console.sqlite`) and never enters research artifacts, prompts, exports, or the history search index:

- **Watchlist** — Named, orderable equity list (`watchlists` / `watchlist_items`). Rows show only data derived from the Run Artifact Index: latest run date/age, depth, open Observable Predictions, latest Calibration hit/miss. An instrument's runs are those whose `symbol` matches, plus symbol-less multi-subject runs (Forecast Grid, market overview) with a Prediction whose primary subject (before any `:`) is that instrument. A Prediction is open when its `measurableAs` resolves to the instrument and it has no score row or an unresolved pending-family score (`pending`, `pending-condition`, `active-pending`); voided and abandoned scores are terminal. No runs renders "never run"; an unavailable index is declared per row.
- **Run Note** — Plain text on an Instrument or Run Artifact (`notes` row), max 10,000 chars, whitespace preserved, empty body deletes. Never enters Run Chat context.
- **Pin** — Sorts a Run Artifact to the top of every run list (`pins` row). A pinned run whose directory is gone stays listed as missing and can be unpinned.
- **Run Chat** — Ephemeral per-Run Artifact Q&A. Not persisted; with the Codex provider it may use web context, which never becomes a Source or Evidence.
- **Instrument Accountability Timeline** — Console view for one `assetClass + symbol` joining Theses, Predictions, scores, Miss Autopsies, and verified closes.
- **Instrument Run History** — Every Run Artifact for one Instrument, newest first. Runs without an Instrument stand alone.

## Subjects and instruments

**Subject** — Research target: a resolved Instrument (equity/crypto) or free-text theme. Bounds web evidence, not Prediction Subjects.

**Subject Kind** — `company` (equity), `crypto-asset`, `theme` (research runs). Selects the Web Subject Profile question set and reuse rule.

**Instrument** — Listed or quoted target identified by `symbol + assetClass`, with optional exchange, currency, provider IDs, aliases.

**Instrument Identity** — Provider-normalized metadata relating Source Provider records to an Instrument.

**Quote Currency** — Currency of quoted prices (`InstrumentIdentity.quoteCurrency`). Yahoo `GBp` is pence, not `GBP`; it renders as pence without K/M/B scaling.

**Reporting Currency** — Currency of issuer fundamentals, distinct from Quote Currency. Cash/debt/FCF threading is deferred to P2.

**Research Subject Registry** — Checked-in registry for `research` runs: aliases → `subjectKey`, representative instruments, provenance, optional ETF prediction proxy. Never restricts user subjects; a missing proxy permits zero scored Predictions with a disclosed gap.

**Peer Universe** — Auditable comparable-Instrument set for peer valuation, resolved from checked-in ticker mapping, Subject Registry, or model-proposed candidates that code validates and caches. The model never authors the set. Candidates face tier-scoped comparability gates; too few valid peers yield a valuation Source Gap. A learned set's evaluation feedback (usable-peer count, each excluded peer's cause) is recorded per cache generation and shown to the next re-proposal; a transient fetch failure or stale fallback withholds it. See [ADR 0004](./docs/adr/0004-evidence-and-model-stage-pipeline.md).

## Predictions, forecasting, scoring

**Observation** — Public market value, point-in-time or windowed, used to resolve a Prediction.

**Prediction** — Observable Prediction: `probability` is the chance `measurableAs` is true; bearish or in-range views use probabilities below 0.5. The public claim renders from `measurableAs`, not model text. Depth targets are soft: shortfalls are disclosed, never padded. See [ADR 0003](./docs/adr/0003-forecasts-scoring-and-calibration.md).

**Prediction Subject** — Declared set a Prediction may concern. Direction/range/volatility/IV use the forecast subject; relative uses its primary instrument; research runs use their dedicated gate.

**Prediction Shortfall** — Structured `ResearchReport.predictionShortfall` disclosure (emitted, target, missing counts) that a report emitted fewer Predictions than its soft target after earnings and research-subject gates. Event Grid Predictions are excluded from both counts. No follow-up pass requests more.

**Prediction Trim** — Valid Prediction omitted after redundancy removal. Telemetry, not a failure.

**Conditional Prediction** — Prediction depending on an earlier observable condition. Its probability is conditional; unmet conditions void it and exclude it from Calibration.

**Near-Base-Rate Prediction** — Valid Prediction within an inclusive ±0.10 band of its reference: the band's base rate (Gaussian over the scoring sessions, or 0.32 when unknown) for a range Prediction matching its subject's reconstructed ±1σ band at a listed horizon and printed two-decimal precision; 0.5 otherwise. Analytics counts it apart from informative Predictions.

**Forecast-Shape Diversity Guidance** — Soft prompt guidance for varied Prediction shapes on deep instrument runs. Never a gate.

**Event Grid** — Fixed set of events code issues on every equity instrument run (±1σ range outside-events at +1/+5/+20, relative vs SPY at +5), priced by the primary synthesis or a Forecast Grid Job and stamped `origin: "grid"`. A model Prediction restating a grid event (same id or `claimKey`) is folded into it. An unpriced event is a declared gap, never dropped or defaulted. See ADR 0003.

**Forecast Grid Job** — `forecast-grid --watchlist <name>`: issues the Event Grid with Baselines for every equity on a watchlist, one quick-model call per symbol from a compact fact sheet. No synthesis or Web Gather. Dry run unless `--yes`. Publishes one symbol-less run (`jobType: "forecast-grid"`) scored and calibrated like any other.

**Forecast Baseline** — Frozen, versioned no-skill probability on a Prediction (`baselineProbability`, `baselineVersion`, `infoCutoff`): EWMA volatility, zero drift, √h over the sessions scoring spans. Range, direction, relative only; missing inputs omit it with a declared gap. Distinct from the prior-run baseline in Forecast Persistence Telemetry.

**Forecast Event** — The unit Calibration counts: one canonical claim per asset class and origin, where origin follows the claim's resolution clock (next trading day for equity close windows, UTC date for crypto and calendar-day macro/IV, declared date for earnings). Same-session repeats collapse to the earliest (`duplicateForecastCount`). Per-run views still count issuances.

**Paired Skill** — Brier(Baseline) − Brier(model) over the same resolved Forecast Events, overall and per kind, with a subject-clustered block-bootstrap interval. Status: `model-better`, `baseline-better`, `not-yet-decidable` (interval spans 0 or below the 30-event / 5-block floor). Events without a baseline are excluded and counted. See ADR 0003.

**Reference Skill** — Descriptive Brier skill vs the fixed always-0.5 reference; secondary column beside Paired Skill. Does not change Actionable Negative Calibration's 0.25 gate.

**Calibration** — Stated probabilities vs resolved outcomes, counted in Forecast Events: resolved count, hit rate, Brier, reliability bins, slices, small-sample warnings. New dashboards use policy-v3 forecasts.

**Regime-Sliced Calibration** — Calibration grouped by persisted Market Regime (`risk-on`, `risk-off`, `mixed`, `insufficient-data`). Missing regimes are a coverage gap; Brier appears only above the sample floor.

**Actionable Negative Calibration** — Slice with ≥30 resolved Forecast Events, ≥10 distinct Runs, and a Bonferroni-adjusted 98.75% one-sided Brier lower bound above 0.25. Qualifying slices (asset-class, job-type, horizon, regime, kind) can guide probability discipline, never count, shape, or evidence rules. A kind slice below the floor is declared insufficient and supports no guidance.

**Scoring Policy** — Versioned Prediction clock contract. New Predictions are v3; unversioned legacy forecasts are v2 and scoring passes never change a resolved score. V3 grades provider-observed completed sessions for equity/earnings (a session still trading is withheld), target UTC date for crypto, calendar days for macro/IV. See ADR 0003.

**Score Repair** — Explicit, audited replacement of one resolved score that consumed an unfinished session. Proven premature = a recorded exchange schedule shows the bar was still trading at acquisition; suspect = no schedule proves it closed. Dry run by default; keeps the original score and never touches the report.

**Prediction Citation Classes** — Counts of Prediction `sourceIds` by Source `kind` (missing metadata → `unknown`). Measures citation use, not evidence influence.

**Forecast Disagreement** — Deep-run signal of challenger-model probability spread, variance, and mean over existing `measurableAs` events. Never replaces canonical probabilities. Per Prediction, band `low`/`medium`/`high`; with fewer than two probabilities the band is `unavailable` and spread/variance are omitted, never 0. Challengers do not see the primary probability (prose is not filtered); older-run bands were measured with it exposed.

**Forecast Persistence Telemetry** — Per-run comparison with the newest comparable prior run of the same known depth: repeated claims, unchanged probabilities, `changedProbabilityCount`, `maxAbsProbabilityDelta`. Omitted without a matching baseline or known depth. Descriptive only.

**Miss Autopsy** — Post-score `miss-autopsy.json` classification of a material Prediction error from persisted artifacts only; `insufficient_evidence` when no cause is supported.

**Prior-Thesis Error Correction** — Instrument-run prompt block of prior missed Predictions with probabilities, observations, and citations. Informs wording and calibration, not recommendations.

## Cross-run history

**Cross-run Intelligence** — Curated prior-state readback: Historical Research Context, history CLI, Instrument timelines, Calibration, Miss Autopsies, Forecast Persistence, error-correction blocks, and the Run Artifact read seam. Never uses raw `data/cache`; derived indexes are access paths, not truth.

**Historical Research Context** — Artifact-backed prompt and user-facing context from prior reports, Sources, Predictions, theses, gaps, extras, and numeric snapshots. Selection records recency, topical, and miss-correction reasons. Informs wording and comparison, not Prediction count or horizons. Prompts list only resolved prior Predictions; pending ones are counted.

**Historical Context Gap** — Disclosed absence, parse failure, or mismatch in prior artifacts. Not a live-provider Source Gap.

**Market Update Delta** — Deterministic Market Overview summary vs the previous overview: regime drivers, mover entries/exits, newly resolved Predictions. Distinct from `history thesis-delta`.

## Market overview runs

**Market Overview** — Horizon-parameterized asset-class run (`jobType: "market-overview"`): regime, movers, themes, catalysts, risks, gaps. Deprecated `daily`/`weekly` = 5/15 trading days; longer horizons still use one-day mover inputs and disclose it.

**Market Spotlight** — Optional validated Overview focus chosen from collected snapshots. History and alpha-search can enrich but not create it; no nested jobs, fetches, or depth upgrades. Absent from equity, crypto, and research reports.

**Market Regime** — Fetched-evidence backdrop: direction, volatility, liquidity, dominant themes.

**Ticker Regime Context** — Live equity breadth/volatility proxy that labels an Instrument's Market Regime without historical overviews.

**Market Context** — Market-level evidence enriching an Overview without targeting an Instrument.

**Mover** — Liquid Instrument ranked deterministically by move magnitude, liquidity, and Mover Features. **Mover Feature** — explainable ranking input; absence is neutral. **Benchmark-Relative Mover Context** — citeable sector-ETF/index comparison that never changes rank.

**Catalyst Calendar** — Passive Overview list of narrative catalysts, macro context, and prior Prediction resolution dates. Never scores or anchors Predictions.

## Sources, web, and gaps

**Source** — Fetched market, news, or reference item with an ID for claim citations.

**Source Provider** — External service normalized into Sources. **Supplemental Source Provider** — optional citeable provider that does not drive ranking, regime, or Observations unless promoted.

**Source Gap** — Disclosed missing, weak, failed, or stale provider evidence. Persisted telemetry dedupes normalized `source: message` text; `web-gather` and compatibility `evidence-request` gaps stay separate. Every gap stays declared in the report, analytics, sidecar, and Console; only the Web Gather stage prompt sees a narrower view omitting gaps no web search can close.

**Material Gap** — Affects what a reader can conclude (missing statements, failed verified snapshot, core-lane provider data missing); appears in the Default View. Prediction shortfalls rank last among them.

**Diagnostic Gap** — Instrumentation or entitlement artifact (absent optional provider, entitlement 403, unconfigured KPI registry, forecast-book notes such as `event-grid`, `forecast-baseline`, `earnings-forecasts` suppression, `forecast-grid` skip/fact-sheet notes); appears only in the Appendix, or labeled Diagnostic in the Data Gaps list of runs without one. Non-equity Console views keep the shortfall in a dedicated block.

**Provider Coverage Gap** — Source Gap from provider, account, region, or instrument limits; usually informational. Gated US-only sources emit `unsupported-coverage` without network calls.

**Not-Assessed** — Completeness status for a dimension whose inputs were never configured or available (unconfigured KPI registry, missing optional credential). Never counts as complete or raises a grade versus `partial`; unlike `partial`, it does not mean incomplete data.

**Gap-Shaped Claim** — Narrative absence-of-evidence claim, recognized by two non-interchangeable predicates. The broad relocation predicate moves an uncited claim from a findings section (or an eligible Business Framework section with no fallback source IDs) into `dataGaps` and records `trace.json:relocatedGapClaims`. The stricter audit predicate warns `gap-shaped-claim-cited` when such a claim carries source IDs.

**Source Plan** — Deterministic, pre-collection policy of intended Evidence Lanes (core, material, supplemental), frozen from the command and checked-in subject; credentials and outcomes cannot change it. See ADR 0004.

**Evidence Lane** — Intended Source Plan channel (market data, news, verified snapshot, SEC EDGAR). Covered only by a backing Source; an uncovered lane is distinct from a Source Gap.

**Relevant News Source** — News Source matching a News Relevance Target. It counts toward a lane's min-relevant-keep floor only when the subject is in its title or `source.symbol`. If seen-dedupe leaves the floor unmet, the newest qualifying repeats are restored and disclosed as `repeat-fallback`.

**Grace Window** — 24 h exemption from seen-news suppression measured from `firstSeenAt`; re-records keep the original `firstSeenAt`, so cross-day suppression still applies.

**News Relevance Target** — Ticker/issuer terms (instrument runs) or subject representatives and aliases (research runs) for deterministic relevance matching.

**Temporal Integrity** — Evidence contains only facts observable by its analysis cutoff. Later facts are excluded; stale fallbacks stay raw-audit-only with disclosure.

**Freshness-Budgeted Source Cache** — Replays same-day provider payloads within adapter freshness budgets; accession-addressed SEC filing documents are reused 30 days from original fetch. A failed refetch leaves the stale payload raw-audit-only and records a stale-cache Source Gap.

**Web Gather** — Bounded deep-run loop of on-subject `web_search` and allowlisted `web_fetch` through the cached Source Provider seam. Exa is primary; Firecrawl is fallback-only for failed or thin Exa responses, never a substitute for a missing `MARKET_BOT_EXA_API_KEY`. A fallback closes the Exa Source Gap but never erases the incident: Provider Health still shows a non-available web-search row and a `web-search-provider` Subsystem Outcome. `web_fetch` fallbacks are recorded in that outcome's detail counts. For company subjects, SEC 10-K/10-Q profile coverage rejects redundant `background`/`current-subject` searches lacking a recency, corroboration, or explicit-gap rationale; reused-profile coverage rejects same-terms `background` searches; `news`/`market` are exempt. Reused profiles cut implicit per-query ingestion from 5 to 3. `web-gather` is Source-Gap taxonomy, not an Evidence Lane.

**Web Evidence** — Low-trust open-web Sources (`kind: "web"`) with `exa` or `firecrawl` provenance. Support cited qualitative claims only; cannot widen run or Prediction scope or raise Evidence Quality beyond the extended-evidence cap.

**Raw Web Snapshot** — Exact provider payload kept for audit and replay; never model-visible.

**Model-Visible Web Text** — Sanitized low-trust web prose for profile extraction and synthesis. Profile-covered sources stay metadata-only; their facts enter through the cited profile digest.

**Model Input Sanitization** — Deterministic removal of high-confidence model-directed instructions from untrusted prose, metadata, SEC text, and prompt-bound history. Raw snapshots stay unchanged; only aggregate counts persist.

**Web Source Roles** — Separate accounting (accepted, profile-used, report-cited, unused; reused-profile coverage with source run and age) in `analytics.json:webSources`, so volume isn't mistaken for coverage.

**Web Subject Profile** — Citation-checked sidecar answering a fixed Subject-Kind question set from Web Evidence. Company profiles may use issuer 10-K/10-Q text first and need a current SEC basis for reuse; reuse skips extraction, not fresh Web Gather. Its model-authored prose (`subjectSummary`, `questions`, `recentMaterialEvents`, `factLedger`, `openGaps`) reaches report prose as a code-assembled digest, so it is screened against the research-only patterns where written: tripped required answers become a code-generated withheld notice, tripped array entries are dropped and replaced by a withheld-count entry, each with a matching Source Gap; original wording stays in raw stage output. Code-generated entries are asserted, not dropped (a trip is a generator defect). Reuse of a notice-bearing profile re-emits those gaps, keeping the evidence-quality cap. A profile whose required answers are all withheld notices is not a reuse basis.

## Evidence quality and report audit

**Evidence Quality** — Deterministic grade of completeness, recency, corroboration, traceability. Model judgment and probabilities cannot set it.

**Equity Analysis Completeness** — Deterministic grade of what an issuer's reporting surface makes achievable (due interim coverage, filing cadence, per-share and payout evidence). Distinct from Evidence Quality: complete sourcing can expose an incomplete surface, such as an unfiled due quarter. See ADR 0004.

**Post-Synthesis Audit** — Warn-only, no-model check for weak-evidence hygiene; records telemetry, never blocks or rewrites.

**Report Integrity Audit** — No-model pass after schema-valid synthesis, before Forecast Disagreement, that prunes unsupported numeric/technical findings, scenarios, Predictions, and summary sentences (an emptied summary gets a fixed neutral fallback). Missing posture labels stay advisory; pruned Predictions never score. See ADR 0004.

**Report Integrity** — Audit grade: `high` (no pruning), `medium` (pruned, required sections remain), `low` (pruning emptied a populated required section). Always stamped on new reports; tolerant reads may omit it.

**Research Quality** — The worse of Evidence Quality and Report Integrity.

**Domain Playbook** — Checked-in guidance (`prompts/playbooks/`) selected deterministically after collection: every planned stage gets all eligible playbooks plus mandatory discipline and subject selections, with no selector model call. Fetches no data and changes no schema; `trace.domainPlaybooks` records what was injected.

## Equity evidence

**Extended Evidence** — Optional higher-specificity provider evidence for instrument Research Views. **Fundamental Evidence** — sourced issuer operating and financial facts used as Extended Evidence.

**Verified Market Snapshot** — Analysis-date-anchored, citeable OHLCV and technical-indicator block (Yahoo daily bars, ≥400-day lookback). A latest session provider metadata cannot prove closed is retained but marked `latestSessionStatus: "unverified"` and no longer called verified. Supplemental evidence, not a scoring Observation. `latestSessionStatus` is a closed set: a new value must update both the strict deep-equity bundle validator and the tolerant sidecar reader. See ADR 0004.

**Origin Anchor Quarantine** — Score evidence preventing an unverified snapshot session from becoming a Prediction's origin Observation: walks back to the latest verified session at or before the report origin, or leaves the Observation unavailable. Recorded at `score.json:evidence.originAnchorQuarantine`, summarized in `miss-autopsy.json`.

**Accounting Scope** — Basis of an earnings or cash-flow figure on three independent axes: continuing vs total operations, parent vs including noncontrolling interests (NCI), SEC filing vs provider basis. Figures are compared or divided only within one scope; equal values never imply equal scope. Revenue is continuing once discontinued operations are split out (ASC 205-20), so operating cash flow and net margin use continuing amounts where tagged, and a total-operations period with discontinued operations is withheld with a Source Gap. Net margin divides income including NCI; parent income stands in only without NCI income, else withheld with a gap. Capex carries no scope tag and is used as reported. See ADR 0004.

**Earnings Basis Disclosure** — Deterministic line beside Yahoo trailing EPS/P/E keeping both observations: the provider value with its undisclosed basis, and the SEC diluted EPS TTM approximation (plus continuing-operations EPS TTM when tagged), stating agreement, mismatch, or currency mismatch without inventing an explanation.

**Current Report Evidence** — Bounded text from up to two SEC current reports (8-K domestic, 6-K foreign private issuers) filed within 120 days. Routine 8-Ks must postdate the newest periodic filing; the newest Item 2.02 earnings release gets a slot despite that floor. A substantive EX-99 exhibit is preferred over the primary document; a gap says when neither reports results. A domestic filer without a 10-K/10-Q gets no packet.

**Yahoo Fundamentals Evidence** — Typed fundamentals from normalized Yahoo quotes (`yahoo-fundamentals`): P/E, P/B, yield, EPS, shares, dividend, book value. Supports non-US and price-relative ratios. See ADR 0004.

**Valuation Evidence** — Deterministic Extended Evidence: market cap, fundamentals, and (for `equity --deep`) peer comps → EV, revenue multiples, peer median/IQR, supportability, and the peer-implied price reference range (low/mid/high, spot position, or suppression reason), so synthesis reads the range the report renders. Target and peers share one revenue basis, SEC TTM (FY + latest YTD − prior YTD, or the latest 12-month fact); a partial period is never annualized, so a peer without reconciled TTM is rejected and a target without it withholds revenue multiples behind a Source Gap. Peers need ≥3 qualifying candidates and 0.2x–5x market-cap/revenue gates; SIC matching applies except curated `ticker-mapping` (`curated-no-sic` vs `full` gate profiles). Rejections stay visible. See ADR 0004.

**EV Bridge** — EV = market cap + debt + preferred (carrying) + NCI + temporary equity (redeemable NCI and preferred) − cash − short-term investments; net debt = debt − cash − short-term investments; long-term investments stay out. Each component resolves from us-gaap company facts at the cash instant from a priority list of never-summed alternatives: a tagged fact (zero counts), else `CashCashEquivalentsAndShortTermInvestments` − cash, else a nonzero fact within 400 days makes it incomplete, else untagged = zero. Short-term investments are also incomplete when the combined line differs from cash plus the picked line. Untagged NCI is derived as equity incl. NCI − parent equity only when positive and the balance-sheet identity reconciles; temporary equity counts only where assets − liabilities − equity reconciles to it. Incomplete short-term investments withhold net debt and EV; incomplete NCI, preferred, or temporary equity withhold EV only, each behind a Source Gap. Non-us-gaap issuers have no bridge, so EV and net debt are withheld. See ADR 0004.

**Valuation Workbench** — Versioned equity sidecar joining canonical annual or reconciled-TTM fundamentals to the first verified close within seven calendar days on or after the inputs became public. Reports P/E, P/S, EV/revenue, P/FCF proxy as MetricResults with input lineage and a declared filing-date close/FX basis, plus the peer table/reference range. When no period of any concept ends after the latest 12-month fiscal year, canonical TTM is that fiscal year (`formula: "FY"`, public at its 10-K filing date, labelled "TTM = FY<year>, <form> accession <n>") and replaces the duplicate annual observation; once a later interim is filed only the reconciled FY + YTD − prior YTD counts. Missing canonical TTM is suppressed; quarter-only periods are never combined into an unreconciled trailing value. Each observation is a Metric Section (`valuation-workbench-<basis>-<periodEnd>-<publicAt>`) with one Source Gap for unresolved metrics. A close before the requested history start carries cause `outside-price-history-window` only when usable history was returned; observations whose only unresolved metrics carry it share one diagnostic gap (`valuation-workbench-outside-price-history-window`) naming every period. Missing bars inside the window, provider failures, and independent unresolved inputs stay material.

**Reverse DCF Input Sensitivity** — Isolated equity sidecar solving the five-year FCF growth input across 8%–16% discount and 0%–4% terminal-growth rates, from reconciled-TTM FCF and observed EV. Missing, non-positive, or currency-incompatible inputs suppress it. Boundary: [ADR 0001](./docs/adr/0001-research-only-boundary.md).

**Financial Lens Evidence** — Neutral SEC/Yahoo metric groups (Quality, Growth, Financial Strength, Value, Momentum) with a posture, never a composite score or rank. Deep equity can add peer supportability; industry-relative ratios are display-only except Dividend Payout ≤0.8. Numbers are Metric Sections (`financial-lens-<lens>`); the `financial-lens` Extended Evidence item is rebuilt from them. Financial Strength counts only balance-sheet inputs within 180 days of the cutoff and 92 days of the newest balance-sheet period; older is `missing` with a `stale <input> as of <end>` reason and a section Source Gap, never shown as a dated figure. See ADR 0004.

**Business Framework Evidence** — Deterministic framework (Business, Phase, Moat, Growth, Management, Risk, Valuation) in `normalized/business-framework.json`. Numbers are Metric Sections (`business-framework-<section>`, none for Management) referenced by `metricSectionIds`; the framework keeps phase, posture, model text, and qualitative gaps, with neutral postures and lifecycle labels. Brief runs keep the eleven profile-mapped qualitative gaps as `suppressed-by-design` (not assessed at brief depth; filing prose and Web Subject Profile excluded); analyst consensus stays an independent `provider-data-missing` gap.

**Evidence Reconciliation** — No-model post-profile pass for `equity --deep` that removes a Business Framework qualitative gap only when the matching structured, cited web profile answer exists. Records the resolution; never adds prose, changes postures/phase, or clears unrelated gaps. May never clear numeric postures or phase.

**Metric Section** — Ordered list of metrics evaluated once at collection from raw statement, capital-ownership, and quote inputs (or pass-through Extended Evidence values with lineage). Tenants: six Business Framework sections, five Financial Lenses, Capital Return, Operating Ratios (FCF margin, interest coverage, EBITDA proxy, effective tax rate, ROIC), Valuation Workbench observations, Price Performance. Each metric has a status (`value`, `missing`, `not-meaningful`, `not-applicable`), input lineage, and source IDs; every non-value metric is listed in one section Source Gap, material when any `missing` metric lacks a structural cause, else diagnostic. Causes: `outside-price-history-window`; `insufficient-history` (returned history starts 8–14 days after the anniversary; SPY rows also need benchmark coverage); `not-filed` (no raw fact under any alias, or for debt under any concept the debt selection reads). Capital Return and Operating Ratios always emit on equity runs (unavailable statements → missing rows plus material gaps). A lens with nothing off SEC facts keeps its Extended Evidence item but no section. An omitted `metricSections` is `undefined`, distinct from `[]`. A lifecycle phase without cited inputs is missing. Projected to `report.extras.metricSections` (report.md appendix, Console Advanced view), persisted in the deep bundle's `derived.metricSections`, and shown to evidence-request, analysis, critique, and final-synthesis prompts as a reference catalog.

**Metric Reference** — `<<metric:<section>.<id>>>` token in cited model prose; `<<metric:<section>.<id>|period>>` appends the period label. Assembly merges the metric's source IDs into the claim, validates citations and research-only wording, then substitutes the formatted value. Unknown/unavailable metrics, unknown formats, and `|period` on a metric without a period end reject the draft for repair. Catalog = collected Metric Sections plus a reference-only `market-session` section from the Verified Market Snapshot (never in `report.extras.metricSections`). Free-typed numbers stay allowed for figures no metric holds. Summary stays qualitative; data gaps and Prediction expressions cannot contain references.

**Price Performance** — `price-performance` Metric Section: cumulative 1/3/5-year issuer and "SPY (S&P 500 proxy)" price returns on split-adjusted closes, excluding dividends. Issuer returns use issuer completed sessions independently of SPY; SPY comparison rows use common sessions. Starts are within ±7 calendar days of the anniversary, the end at most seven days old. History is collected once for this section, the Valuation Workbench, and the Verified Market Snapshot. Each row discloses its own quote currency, no FX. Unavailable or ambiguous split metadata, or missing inputs, give unavailable rows plus one section gap; missing SPY history withholds only SPY rows, and a SPY fetch failure also declares a Yahoo gap. `insufficient-history` applies only when the earliest completed bar is 8–14 days after the anniversary (and, for SPY rows, the benchmark covers it); later starts are material. Section triage is diagnostic only when every missing row has that cause. Web Gather receives no catalog or these gaps.

**Earnings Setup** — For `equity --deep`, event context when Finnhub reports earnings within 30 days: metadata, date certainty, optional Tradier implied move, sourced bullets, gaps. Finnhub dates stay `provider-estimated`; issuer IR/press release or explicit-future SEC 8-K/6-K can establish `issuer-confirmed`, only a direct official exchange source `exchange-confirmed`, recorded in `confirmedBy`. A fetched source stating a different future date sets `event.dateConflict` and a Source Gap without changing the status. Earnings Predictions use post-event trading-day horizons and `earningsReturn` only for confirmed dates. IV crush is deferred.

**Scored Catalyst** — Dated provider event (earnings, dividend, split, macro release) scored only by fixed materiality and date confidence. Only confirmed-exact dates anchor Predictions. Distinct from narrative catalysts and the Catalyst Calendar.

## Alpha search

**Research Lead** — Equity candidate surfaced for further research. **Alpha Search Report** — research-only artifact listing valid Leads and rejected candidates with source IDs and reasons.

**Social Momentum Score** — Alpha-search rank from ApeWisdom aggregate social features before market validation. **Discussion Stance** — noisy classification of cited discussion as constructive, skeptical, mixed, or unclear.

**Source Promotion Criteria** — Historical validation thresholds for raising a discovery source/group's budget, weighting, or retention; never for promoting individual Leads.

**Validation Baseline** — Minimum exercised routes and source capabilities for provider readiness to pass.

## Fixtures, replay, evals

**Fixture Run** — Engineering-only deterministic run using real orchestration with HTTP/model boundaries replaced by cassettes or a live eval model.

**Data Cassette** — Secret-scrubbed canonical HTTP request→response map replayed beneath the cache; collector, normalization, and Source-Gap behavior stay active.

**LLM Cassette** — Ordered recorded `ModelProvider.generate` responses by stage/model. Replay matches the exact model first, then a unique recorded model for the stage; missing, ambiguous, exhausted, and unidentified requests fail; unused responses alone do not. Eval mode bypasses it except `--live-stages <stage>`.

**Regression Mode** — Fixture mode replaying both cassettes: zero network, zero model cost. **Eval Mode** — replays Data Cassettes, calls the configured live model.

**Replay Capture** — Opt-in sidecar `<run>/replay/`: sanitized settings, both cassettes, recorded clock and consumed cross-run/cache state, and a Final-Synthesis Input. Published after validation and secret scanning; failure does not invalidate the Run Artifact. Excluded from report fields, Calibration, history, and the index.

**Final-Synthesis Input** — Versioned input saved before prompt rendering for direct execution of final synthesis and its deterministic audits (evidence, allowed source/subject identities, prior outputs, consumed context, recorded responses; current Playbooks reload on replay). Direct outputs are partial evaluation artifacts, not Run Artifacts.

**Report Rerun** — Zero-network, zero-model re-projection and rendering of a past report from saved normalized inputs into a separate evaluation candidate. Tests projections, validation, and renderers only.

**Frozen-Input Eval** — `scripts/eval-deep.ts`: each fixture N times against the same Data Cassette, comparing artifact-derived metrics between two labels. `--live-stages <stage>` keeps one validated stage live (with its bounded loops/repairs), the rest recorded; `--input <file>` evaluates a Final-Synthesis Input directly with no upstream execution. Planning measures prompt sizes offline and adds attempt headroom; estimates are not cost caps. Writes only under `data/evals/<label>/` (never Calibration, index, or history). Every Data Cassette miss is counted per sample and goes through `fetch-failed` handling, which a fallback may close, so the count — not the Source Gaps — is authoritative. HTTP/model replay misses make the sample incomplete and block later model spend; recorded provider failures are valid inputs. A selected stage with zero invocations is not exercised. Adaptive requests stay cassette-only.

**Labeled Eval Case** — Frozen claim from a replay capture (`tests/fixtures/eval-cases/cases.json`), pinned by file hash and JSON pointer, labeled `stale-support`, `omission`, `unsupported-inference`, `contradiction`, `extraction-error`, or `clean`, with justifying evidence. Deterministic checks score stale support and citation coverage; `contradiction` and `unsupported-inference` need a k=3 model judge. `eval-deep.ts --input --ablate <arm>` scores with the same checks plus a judged pass; an isolated arm skips one analysis stage and regenerates its consumers live, compared in pre-paired samples against a matched control (identical judge requests cancel across a pair, so scores are relative). Results inform a human stage-deletion decision under the rule pre-registered in docs/testing.md.
