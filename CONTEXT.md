# Market Bot Context

Domain glossary. Definitions state what a term means and the invariants that matter; mechanics live in [docs/architecture.md](./docs/architecture.md), the ADRs, and the code. Everything here is research-only: nothing implies a recommendation, trade signal, or portfolio action.

## Research artifacts and views

**Research View** — Sourced artifact summarizing evidence, uncertainty, scenarios, risks, and gaps.

**Research Thesis** — Research View narrative state: summary, findings, cases, risks, catalysts, gaps, and Predictions. Not an investment thesis.

**Default View** — Reader-facing surface of a deep-equity report or Console run: business, price with market date and freshness, a three-to-five-year plus TTM trend table, valuation context relative to the quote (never a target), catalysts and risks, upcoming earnings and consensus, and Material Gaps.

**Appendix** — Trailing detail surface: reverse DCF, full valuation and peer tables, excluded-peer diagnostics, institutional/insider detail, analyst distributions, options IV, financing bridge, capital ownership, and the five Financial Lenses. Collection drops nothing; only placement changes.

**Run Artifact** — Persisted output of one run at `MARKET_BOT_DATA_DIR/<run-id>/`. Later runs and history read it; Source Providers are never refetched for it. Layout in AGENTS.md.

**Failed Run Artifact** — Diagnostics of a run whose final synthesis never produced a valid Research View, or whose post-synthesis finalize step threw. `failure.json` marks it complete; `report.json` is deliberately absent.

**Run Artifact Index** — Rebuildable SQLite index over Run Artifacts for console/search/calibration queries. Disk artifacts stay authoritative; a missing or stale index falls back to disk or rebuilds.

**Subsystem Outcome** — Coded record of what one run subsystem was expected to do and whether it acquired output (`produced`), stayed `empty`, `declined`, `failed`, or was `blocked`. The statuses are not a clean taxonomy: each records how that subsystem's own producer classified its situation, so the same condition can map differently across subsystems (a missing Exa credential `declined`s Web Gather; a lane-local missing credential is `blocked`). The code beside the status is the specific part. `empty` means no output was accepted; accepted output with a usability posture stays `produced`. Run telemetry, not a Diagnostic Gap.

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

**Reporting Currency** — Currency of issuer fundamentals, distinct from Quote Currency. Elected from filed facts; an ambiguous election is declared, not guessed.

**Research Subject Registry** — Checked-in registry for `research` runs: aliases → `subjectKey`, representative instruments, provenance, optional ETF prediction proxy. Never restricts user subjects; a missing proxy permits zero scored Predictions with a disclosed gap.

**Identity Gate** — Pre-model check on every equity instrument run: the listing resolves from its Yahoo quote or a single exact Yahoo search match (the run then continues under that code), or the run stops with candidates before any model stage. Also stops a non-SEC listing without an Exa key or with Web Gather disabled. See [ADR 0006](./docs/adr/0006-non-sec-issuer-coverage.md).

**Exchange Profile** — Checked-in row per non-US exchange (Yahoo suffix, local benchmark, currency) that market regime, the Event Grid relative event, the final-synthesis relative benchmark, and Price Performance read instead of US proxies; its listings also get Event Grid range events. An exchange without a row keeps the US proxies with a declared gap. See ADR 0006.

**Issuer Report Figure** — Interim or annual figure for a non-SEC listing, read by code from a report table cell on an Exchange Profile report host. A model names only the concept and cell; code checks value, period, unit, currency, announcement date, and Accounting Scope from the table, and withholds what fails into an `issuer-report` Source Gap. Published in the `issuer-report` Metric Section; feeds the Business Framework on runs without SEC facts. See ADR 0006.

**Peer Universe** — Auditable comparable-Instrument set for peer valuation, resolved from checked-in ticker mapping, Subject Registry, or model-proposed candidates that code validates and caches. The model never authors the set. Candidates face tier-scoped comparability gates; too few valid peers yield a valuation Source Gap. A learned set's evaluation feedback (usable-peer count, each excluded peer's cause) is recorded per cache generation and shown to the next re-proposal; a transient fetch failure or stale fallback withholds it. See [ADR 0004](./docs/adr/0004-evidence-and-model-stage-pipeline.md).

## Predictions, forecasting, scoring

**Observation** — Public market value, point-in-time or windowed, used to resolve a Prediction.

**Prediction** — Observable Prediction: `probability` is the chance `measurableAs` is true; bearish or in-range views use probabilities below 0.5. The public claim renders from `measurableAs`, not model text. Depth targets are soft: shortfalls are disclosed, never padded. See [ADR 0003](./docs/adr/0003-forecasts-scoring-and-calibration.md).

**Prediction Subject** — Declared set a Prediction may concern. Direction/range/volatility/IV use the forecast subject; relative uses its primary instrument; research runs use their dedicated gate.

**Prediction Shortfall** — Structured `ResearchReport.predictionShortfall` disclosure (emitted, target, missing counts) that a report emitted fewer Predictions than its soft target after earnings and research-subject gates. Event Grid Predictions are excluded from both counts. No follow-up pass requests more.

**Conditional Prediction** — Prediction depending on an earlier observable condition. Its probability is conditional; unmet conditions void it and exclude it from Calibration.

**Near-Base-Rate Prediction** — Valid Prediction within an inclusive ±0.10 band of its reference: the band's base rate (Gaussian over the scoring sessions, or 0.32 when unknown) for a range Prediction matching its subject's reconstructed ±1σ band at a listed horizon and printed two-decimal precision; 0.5 otherwise. Analytics counts it apart from informative Predictions.

**Event Grid** — Fixed set of events code issues on every equity instrument run (±1σ range outside-events at +1/+5/+20 on US and Exchange Profile listings, relative vs SPY, or the Exchange Profile benchmark, at +5), priced by the primary synthesis or a Forecast Grid Job and stamped `origin: "grid"`. A model Prediction restating a grid event (same id or `claimKey`) is folded into it. An unpriced event is a declared gap, never dropped or defaulted. See ADR 0003.

**Forecast Grid Job** — `forecast-grid --watchlist <name>`: issues the Event Grid with Baselines for every equity on a watchlist, one quick-model call per symbol from a compact fact sheet. No synthesis or Web Gather. Dry run unless `--yes`. Publishes one symbol-less run (`jobType: "forecast-grid"`) scored and calibrated like any other.

**Forecast Baseline** — Frozen, versioned no-skill probability on a Prediction (`baselineProbability`, `baselineVersion`, `infoCutoff`): EWMA volatility, zero drift, √h over the sessions scoring spans. Range, direction, relative only; missing inputs omit it with a declared gap, keeping `infoCutoff` when closes were collected. Distinct from the prior-run baseline in Forecast Persistence Telemetry.

**Forecast Event** — The unit Calibration counts: one canonical claim per asset class and origin, where origin follows the claim's resolution clock (next trading day for equity close windows, UTC date for crypto and calendar-day macro/IV, declared date and its origin session for earnings). A score that persisted the resolver's actual origin (`forecastOrigin`) is keyed by that instead. Same-session repeats collapse to the earliest (`duplicateForecastCount`). Per-run views still count issuances.

**Paired Skill** — Brier(Baseline) − Brier(model) over the same resolved Forecast Events, overall and per kind, with a subject-clustered block-bootstrap interval. Status: `model-better`, `baseline-better`, `not-yet-decidable` (interval spans 0 or below the 30-event / 5-block floor). Events without a baseline are excluded and counted. See ADR 0003.

**Reference Skill** — Descriptive Brier skill vs the fixed always-0.5 reference; secondary column beside Paired Skill. Does not change Actionable Negative Calibration's 0.25 gate.

**Calibration** — Stated probabilities vs resolved outcomes, counted in Forecast Events: resolved count, hit rate, Brier, reliability bins, slices, small-sample warnings. New dashboards use policy-v3 forecasts.

**Actionable Negative Calibration** — Slice with ≥30 resolved Forecast Events, ≥10 distinct Runs, and a Bonferroni-adjusted 98.75% one-sided Brier lower bound above 0.25. Qualifying slices (asset-class, job-type, horizon, regime, kind) can guide probability discipline, never count, shape, or evidence rules. A kind slice below the floor is declared insufficient and supports no guidance.

**Scoring Policy** — Versioned Prediction clock contract. New Predictions are v3; unversioned legacy forecasts are v2 and scoring passes never change a resolved score. V3 grades provider-observed completed sessions for equity/earnings (a session still trading is withheld), target UTC date for crypto, calendar days for macro/IV. See ADR 0003.

**Score Repair** — Explicit, audited replacement of one resolved score that consumed an unfinished session. Proven premature = a recorded exchange schedule shows the bar was still trading at acquisition; suspect = no schedule proves it closed. Dry run by default; keeps the original score and never touches the report.

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

**Gap-Shaped Claim** — Narrative absence-of-evidence claim. An uncited one is relocated from findings into `dataGaps`; a cited one is warned on by the audit. The two predicates differ; see [docs/architecture.md](./docs/architecture.md).

**Source Plan** — Deterministic, pre-collection policy of intended Evidence Lanes (core, material, supplemental), frozen from the command and checked-in subject; credentials and outcomes cannot change it. See ADR 0004.

**Evidence Lane** — Intended Source Plan channel (market data, news, verified snapshot, SEC EDGAR). Covered only by a backing Source; an uncovered lane is distinct from a Source Gap.

**News Relevance Target** — Ticker/issuer terms (instrument runs) or subject representatives and aliases (research runs) for deterministic relevance matching.

**Temporal Integrity** — Evidence contains only facts observable by its analysis cutoff. Later facts are excluded; stale fallbacks stay raw-audit-only with disclosure.

**Freshness-Budgeted Source Cache** — Replays same-day provider payloads within adapter freshness budgets; accession-addressed SEC filing documents are reused 30 days from original fetch. A failed refetch leaves the stale payload raw-audit-only and records a stale-cache Source Gap.

**Web Gather** — Bounded deep-run loop of on-subject `web_search` and allowlisted `web_fetch` through the cached Source Provider seam. Exa is primary; Firecrawl is fallback-only for failed or thin Exa responses, never a substitute for a missing `MARKET_BOT_EXA_API_KEY`. A fallback closes the Exa Source Gap but never erases the incident. `web-gather` is Source-Gap taxonomy, not an Evidence Lane.

**Web Evidence** — Low-trust open-web Sources (`kind: "web"`) with `exa` or `firecrawl` provenance. Support cited qualitative claims only; cannot widen run or Prediction scope or raise Evidence Quality beyond the extended-evidence cap.

**Model Input Sanitization** — Deterministic removal of high-confidence model-directed instructions from untrusted prose, metadata, SEC text, and prompt-bound history. Raw snapshots stay unchanged; only aggregate counts persist.

**Verified Web Figure** — A figure a model states in a claim that cites a web Source, published only when its `figureQuotes` entry quotes a cited Source verbatim and every figure the quote touches matches in signed value, scale, currency, and unit. A web Source quotes its stored page text; an `extended-evidence` or `market-context` Source quotes its collector-written snippet or item summaries; a `market-data` Source has no text, so its values enter only as metric references. A co-cited deterministic Source exempts nothing. A failed check prunes the claim and records a gap; a reused profile whose figures fail is regenerated. Applies to every run. See [ADR 0006](./docs/adr/0006-non-sec-issuer-coverage.md).

**Web Subject Profile** — Citation-checked sidecar answering a fixed Subject-Kind question set from Web Evidence. Company profiles may use issuer 10-K/10-Q text first and need a current SEC basis for reuse; a non-SEC profile is reused provisionally against its newest issuer report. Reuse skips extraction, not fresh Web Gather. Its model-authored prose reaches the report as a code-assembled digest, screened against the research-only patterns where written; tripped text is withheld with a Source Gap. Mechanics in [docs/architecture.md](./docs/architecture.md).

## Evidence quality and report audit

**Evidence Quality** — Deterministic grade of completeness, recency, corroboration, traceability. Model judgment and probabilities cannot set it.

**Equity Analysis Completeness** — Deterministic grade of what an issuer's reporting surface makes achievable (due interim coverage, filing cadence, per-share and payout evidence). Distinct from Evidence Quality: complete sourcing can expose an incomplete surface, such as an unfiled due quarter. See ADR 0004.

**Post-Synthesis Audit** — Warn-only, no-model check for weak-evidence hygiene; records telemetry, never blocks or rewrites.

**Report Integrity Audit** — No-model pass after schema-valid synthesis, before Forecast Disagreement, that prunes unsupported numeric/technical findings, scenarios, Predictions, and summary sentences (an emptied summary gets a fixed neutral fallback). Missing posture labels stay warn-only (one claim walk, per-rule `warn | prune` severity); pruned Predictions never score. See ADR 0004.

**Report Integrity** — Audit grade: `high` (no pruning), `medium` (pruned, required sections remain), `low` (pruning emptied a populated required section). Always stamped on new reports; tolerant reads may omit it.

**Research Quality** — The worse of Evidence Quality and Report Integrity.

**Domain Playbook** — Checked-in guidance (`prompts/playbooks/`) selected deterministically after collection: every planned stage gets all eligible playbooks plus mandatory discipline and subject selections, with no selector model call. Fetches no data and changes no schema; `trace.domainPlaybooks` records what was injected.

## Equity evidence

**Tagged Zero Debt** — Debt 0 at a balance-sheet instant proven from the filing's own XBRL instance: a borrowing concept tagged 0 and no other nonzero credit fact outside listed non-debt concepts. It trusts the issuer's tagging; prose with no tag behind it never proves a zero, and a failed read withholds as a Source Gap. `MARKET_BOT_TAGGED_ZERO_DEBT_DISABLE` withholds every such zero. See ADR 0004.

**Extension Short-Term Investments** — Short-term investments read from an issuer-extension face line, proven from the filing's XBRL instance and calculation linkbase to foot into `AssetsCurrent`. Enters the EV Bridge only where no standard short-term investments tag exists at that instant; a failed proof is a Source Gap. `MARKET_BOT_EXTENSION_SHORT_TERM_INVESTMENTS_DISABLE` skips it. See ADR 0004.

**Extended Evidence** — Optional higher-specificity provider evidence for instrument Research Views. **Fundamental Evidence** — sourced issuer operating and financial facts used as Extended Evidence.

**Verified Market Snapshot** — Analysis-date-anchored, citeable OHLCV and technical-indicator block (Yahoo daily bars, ≥400-day lookback). A latest session provider metadata cannot prove closed is retained but marked `latestSessionStatus: "unverified"` and no longer called verified. Supplemental evidence, not a scoring Observation. `latestSessionStatus` is a closed set: a new value must update both the strict deep-equity bundle validator and the tolerant sidecar reader. See ADR 0004.

**Origin Anchor Quarantine** — Score evidence preventing an unverified snapshot session from becoming a Prediction's origin Observation: walks back to the latest verified session at or before the report origin, or leaves the Observation unavailable. Recorded at `score.json:evidence.originAnchorQuarantine`, summarized in `miss-autopsy.json`.

**Accounting Scope** — Basis of an earnings or cash-flow figure on three independent axes: continuing vs total operations, parent vs including noncontrolling interests (NCI), SEC filing vs provider basis. Figures are compared or divided only within one scope; equal values never imply equal scope. What cannot be proven single-scope is withheld with a Source Gap or published with a scope note. See ADR 0004.

**Earnings Basis Disclosure** — Deterministic line beside Yahoo trailing EPS/P/E keeping both observations: the provider value with its undisclosed basis, and the SEC diluted EPS TTM approximation (plus continuing-operations EPS TTM when tagged), stating agreement, mismatch, or currency mismatch without inventing an explanation. Absent when the Yahoo EPS is withheld by the provider EPS cross-check (ADR 0006).

**Current Report Evidence** — Bounded text from up to two SEC current reports (8-K domestic, 6-K foreign private issuers) filed within 120 days. Routine 8-Ks must postdate the newest periodic filing; the newest Item 2.02 earnings release gets a slot despite that floor. A substantive EX-99 exhibit is preferred over the primary document; a gap says when neither reports results. A domestic filer without a 10-K/10-Q gets no packet.

**Yahoo Fundamentals Evidence** — Typed fundamentals from normalized Yahoo quotes (`yahoo-fundamentals`): P/E, P/B, yield, EPS, shares, dividend, book value. Supports non-US and price-relative ratios. See ADR 0004.

**Valuation Evidence** — Deterministic Extended Evidence: market cap, fundamentals, and (for `equity --deep`) peer comps → EV, revenue multiples, peer median/IQR, supportability, and the peer-implied price reference range, so synthesis reads the range the report renders. Target and peers share one reconciled SEC TTM revenue basis; a partial period is never annualized. Peer rejections stay visible. See ADR 0004.

**EV Bridge** — EV = market cap + debt + preferred + NCI + temporary equity − cash − short-term investments; net debt = debt − cash − short-term investments; long-term investments stay out. Each component resolves from us-gaap company facts at the cash instant from never-summed alternatives; an incomplete component withholds EV (and net debt, for short-term investments) behind a Source Gap. Non-us-gaap issuers have no bridge. See ADR 0004.

**Valuation Workbench** — Versioned equity sidecar joining canonical annual or reconciled-TTM fundamentals to the first verified close within seven calendar days on or after the inputs became public. Reports P/E, P/S, EV/revenue, and P/FCF proxy as Metric Sections (`valuation-workbench-<basis>-<periodEnd>-<publicAt>`) with input lineage, plus the peer table and reference range. An annual row is public at its first annual report; inputs restated after it, or on an earlier share basis, are withheld, never rescaled or swapped for as-filed values. Unreconciled TTM is suppressed, never built from quarters.

**Reverse DCF Input Sensitivity** — Isolated equity sidecar solving the five-year FCF growth input across 8%–16% discount and 0%–4% terminal-growth rates, from reconciled-TTM FCF and observed EV. Missing, non-positive, or currency-incompatible inputs suppress it. Boundary: [ADR 0001](./docs/adr/0001-research-only-boundary.md).

**Financial Lens Evidence** — Neutral SEC/Yahoo metric groups (Quality, Growth, Financial Strength, Value, Momentum) with a posture, never a composite score or rank. Industry-relative ratios are display-only except Dividend Payout ≤0.8. Numbers are Metric Sections (`financial-lens-<lens>`); stale balance-sheet inputs are `missing` with a Source Gap, never shown as dated figures. See ADR 0004.

**Business Framework Evidence** — Deterministic framework (Business, Phase, Moat, Growth, Management, Risk, Valuation) in `normalized/business-framework.json`. Numbers are Metric Sections (`business-framework-<section>`); the framework keeps phase, neutral postures, model text, and qualitative gaps.

**Evidence Reconciliation** — No-model post-profile pass for `equity --deep` that removes a Business Framework qualitative gap only when the matching structured, cited web profile answer exists. Records the resolution; never adds prose, changes postures/phase, or clears unrelated gaps. May never clear numeric postures or phase.

**Metric Section** — Ordered list of metrics evaluated once at collection from raw statement, capital-ownership, and quote inputs. Tenants include the Business Framework sections, Financial Lenses, Capital Return, Operating Ratios, Valuation Workbench observations, and Price Performance. Each metric has a status (`value`, `missing`, `not-meaningful`, `not-applicable`), input lineage, and source IDs; non-value metrics share one section Source Gap, material unless every `missing` metric has a structural cause. An omitted `metricSections` is `undefined`, distinct from `[]`. Projected to `report.extras.metricSections` and shown to model stages as the Metric Reference catalog.

**Metric Reference** — `<<metric:<section>.<id>>>` token in cited model prose; `<<metric:<section>.<id>|period>>` appends the period label. Assembly merges the metric's source IDs into the claim, validates citations and research-only wording, then substitutes the formatted value. Unknown/unavailable metrics, unknown formats, and `|period` on a metric without a period end reject the draft for repair. Catalog = collected Metric Sections plus a reference-only `market-session` section from the Verified Market Snapshot (never in `report.extras.metricSections`). Free-typed numbers stay allowed for figures no metric holds. Summary stays qualitative; data gaps and Prediction expressions cannot contain references.

**Price Performance** — `price-performance` Metric Section: cumulative 1/3/5-year issuer and benchmark price returns on split-adjusted closes, excluding dividends. The benchmark is SPY, or the Exchange Profile benchmark on a profiled listing, never a SPY fallback. Each row discloses its own quote currency, with no FX. Missing inputs give unavailable rows plus one section gap.

**Earnings Setup** — For `equity --deep`, event context when Finnhub reports earnings within 30 days: metadata, date certainty (`provider-estimated`, `issuer-confirmed`, `exchange-confirmed`), optional implied move, sourced bullets, gaps. Earnings Predictions use `earningsReturn` only for confirmed dates.

## Alpha search

**Research Lead** — Equity candidate surfaced for further research. **Alpha Search Report** — research-only artifact listing valid Leads and rejected candidates with source IDs and reasons.

**Social Momentum Score** — Alpha-search rank from ApeWisdom aggregate social features before market validation.

**Source Promotion Criteria** — Historical validation thresholds for raising a discovery source/group's budget, weighting, or retention; never for promoting individual Leads.

## Fixtures, replay, evals

**Fixture Run** — Engineering-only deterministic run using real orchestration with HTTP/model boundaries replaced by cassettes or a live eval model.

**Data Cassette** — Secret-scrubbed canonical HTTP request→response map replayed beneath the cache; collector, normalization, and Source-Gap behavior stay active.

**LLM Cassette** — Ordered recorded `ModelProvider.generate` responses by stage/model. Replay matches the exact model first, then a unique recorded model for the stage; missing, ambiguous, exhausted, and unidentified requests fail; unused responses alone do not. Eval mode bypasses it except `--live-stages <stage>`.

**Regression Mode** — Fixture mode replaying both cassettes: zero network, zero model cost. **Eval Mode** — replays Data Cassettes, calls the configured live model.

**Replay Capture** — Opt-in sidecar `<run>/replay/`: sanitized settings, both cassettes, recorded clock and consumed cross-run/cache state, and a Final-Synthesis Input. Published after validation and secret scanning; failure does not invalidate the Run Artifact. Excluded from report fields, Calibration, history, and the index.

**Final-Synthesis Input** — Versioned input saved before prompt rendering for direct execution of final synthesis and its deterministic audits (evidence, allowed source/subject identities, prior outputs, consumed context, recorded responses; current Playbooks reload on replay). Direct outputs are partial evaluation artifacts, not Run Artifacts.

**Report Rerun** — Zero-network, zero-model re-projection and rendering of a past report from saved normalized inputs into a separate evaluation candidate. Tests projections, validation, and renderers only.

**Frozen-Input Eval** — `scripts/eval-deep.ts`: each fixture N times against the same Data Cassette, comparing artifact-derived metrics between two labels. `--live-stages <stage>` keeps one stage live, the rest recorded; `--input <file>` evaluates a Final-Synthesis Input directly. Estimates are not cost caps. Writes only under `data/evals/<label>/`; replay misses make a sample incomplete. See [docs/testing.md](./docs/testing.md).

**Labeled Eval Case** — Frozen claim from a replay capture (`tests/fixtures/eval-cases/cases.json`), labeled `stale-support`, `omission`, `unsupported-inference`, `contradiction`, `extraction-error`, or `clean`, with justifying evidence. Scored by deterministic checks plus a model judge; used for stage-ablation decisions under the rule in [docs/testing.md](./docs/testing.md).
