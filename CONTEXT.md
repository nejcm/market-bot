# Market Bot Context

## Glossary

## Research View

A sourced research artifact that summarizes evidence, uncertainty, scenarios, risks, and gaps without recommending trades or portfolio actions.

## Research Console App

A local research-only user interface for browsing run history, Research Views, Sources, Source Gaps, Evidence Quality, analytics, and provider health without changing the research-only boundary.

## Run Chat

An ephemeral, per-Run Artifact interactive question-and-answer surface in the Research Console, grounded in that run's artifacts. It is not a persisted artifact and is not bound by the research-only boundary that governs Research Views. When the codex provider is active, it may consult the web for additional _ephemeral context_; such web findings are not Sources and do not enter the Evidence subsystem.

## Web Gather

A bounded deep-run evidence loop that lets the model request on-subject `web_search` and allowlisted `web_fetch` calls through the cached Source Provider seam. Exa is the primary provider; when a configured Exa call hard-fails or returns empty/thin results, a Firecrawl fallback may serve the same request (fallback-only — it never runs in place of a missing `MARKET_BOT_EXA_API_KEY`, and web gather stays gated on Exa). It persists gathered web Sources, gaps, and audit sidecars for later citation and replay. It is not investment conviction, a recommendation, or a trade signal.
Web-gather failures carry the `web-gather` Source Gap capability; this is taxonomy for gap attribution, not a separate Evidence Lane.
For company subjects, Web Gather derives which durable business-profile sections a gathered SEC 10-K/10-Q packet already covers (see [[web-subject-profile]]) and passes that coverage into the model context so Exa budget targets recency, corroboration, or genuine gaps instead of re-gathering filed facts; a background `web_search` that duplicates covered filing sections without such a rationale is rejected as `sec-covered-durable-profile`, visible in the web-gather audit.

## Web Evidence

Low-trust Source evidence gathered from the open web and tagged with `kind: "web"` and provider metadata (`exa` or the `firecrawl` fallback). Web Evidence can support cited qualitative business-model claims but cannot widen run scope, prediction subjects, or Evidence Quality above the extended-evidence cap. It is not investment conviction, a recommendation, or a trade signal.

## Raw Web Snapshot

The exact provider payload retained for Web Evidence audit and replay. Raw Web Snapshots are not model-visible evidence.

## Freshness-Budgeted Source Cache

A raw Source Provider cache that can replay same-day provider payloads only inside adapter-specific freshness budgets. Once a cached entry is over budget, the run must refetch live data; if that refetch fails, the cached payload is retained only in raw audit snapshots with a stale-cache SourceGap and does not enter normalized current evidence.

## Model-Visible Web Text

Sanitized normalized web text allowed into model prompts for Web Subject Profile extraction only. It strips high-confidence prompt-risk and page-chrome spans while preserving factual business prose. Later synthesis receives web Source metadata and the cited structured Web Subject Profile, not web snippets.

## Model Input Sanitization

A deterministic, profile-aware boundary for untrusted provider prose, provider-controlled short
metadata, SEC filing sections, and prompt-bound legacy history. It removes high-confidence
model-directed instructions while retaining adjacent factual text, leaves raw snapshots and stored
historical artifacts unchanged, and persists only aggregate counts in `trace.json` and
`analytics.json`. It is defense in depth alongside the shared model-stage trust rule, not evidence
validation or a factual-correctness guarantee.

## Web Source Roles

The accounting roles a current-run gathered web [[source]] can hold on a run that builds a [[web-subject-profile]], tracked as separate counts so raw web volume is not mistaken for evidence coverage. **Current-run** coverage is gathered during this run and appears in `analytics.json:webSources`. **Accepted**: current-run web Sources that survived into the run (`kind: "web"`). **Profile-used**: accepted current-run web Sources the Web Subject Profile cited. **Report-cited**: accepted current-run web Sources referenced in the final Research View's claim or Prediction citations. **Unused**: accepted current-run web Sources that are neither profile-used nor report-cited — the honest noise count. **Reused-profile** coverage is prior-run Web Subject Profile evidence reused in this run and appears separately in `analytics.json:reusedProfileWebSources` with reuse timestamp, age, and source run. These roles are descriptive accounting only, not investment conviction, evidence-lane coverage, or a trade signal.

## Web Subject Profile

A deterministic, citation-checked sidecar answering a fixed set of questions about a run's Subject from gathered Web Evidence. For `company` subjects it may also cite the issuer's own SEC 10-K/10-Q filing text (10-K-first sourcing) and renders a filing Basis line. It replaces Web Company Profile; it is not investment conviction, a recommendation, or a trade signal.
Each Subject Kind has an independent reuse TTL; company reuse also requires a current SEC filing basis.
The company question set (7 questions) and the SEC-first sourcing protocol are derived from the analytical substance of `research/research-skill.md`, a non-loaded design reference (not a wired playbook).
_Avoid_: web dossier, company profile.

## Subject Kind

The fixed question set and reuse rule a Web Subject Profile uses: `company`, `crypto-asset`, or `theme`. It is derived from run type: `equity` is `company`, `crypto` is `crypto-asset`, and `research` is always `theme` because no instrument identity is resolved for web evidence.

## Subject

The thing a run researches: a resolved instrument for equity or crypto runs, or a free-text research subject for thematic research. It is the boundary for gathered web evidence and does not widen Prediction Subjects.
_Avoid_: topic, entity.

## Instrument

A tradable listed or quoted research target. In the current CLI it is still identified by `symbol + assetClass`, with optional exchange, quote currency, provider IDs, and aliases when known.

## Instrument Identity

Provider-normalized metadata that helps relate Source Provider records to an Instrument without changing the research-only boundary.

## Quote Currency

The currency a market price is quoted in, carried on `InstrumentIdentity.quoteCurrency`. It denominates the `latestClose` Financial Lens metric and other price-level values. For LSE listings Yahoo returns `GBp` (pence), a Yahoo pseudo-code distinct from ISO 4217 `GBP` (pounds); the Financial Lens formatter renders GBp with a pence suffix and no K/M/B scaling. It is a labeling convention, not investment conviction.

## Reporting Currency

The currency an issuer reports fundamentals in (revenue, cash, debt, FCF), which differs from the Quote Currency for many international listings (for example LSE shares quote in GBp pence but report in GBP pounds, a 100× difference). Financial Lens metrics sourced from fundamentals use the reporting currency; threading it into the cash/debt/FCF metrics is deferred to P2. It is a labeling convention, not investment conviction.

## Observation

A public market quantity value used to resolve a Prediction. An Observation can be point-in-time or part of a window. It is not advice, conviction, or a trade signal.

## Prediction

- `probability` always means the probability that `measurableAs` evaluates true; with the asymmetric up/outside grammar, bearish or stays-within-range views are expressed as probabilities below 0.5 on that up/outside event. The public `claim` is rendered from `measurableAs`, not model-authored ([ADR 0004](./docs/adr/0004-predictions-as-observable-forecasts.md)). Depth profiles set a soft `targetPredictions` count; below-target runs disclose `predictionShortfall` rather than padding ([ADR 0004](./docs/adr/0004-predictions-as-observable-forecasts.md)).

## Scoring Policy

The versioned contract that maps a Prediction's horizon count onto a clock at resolution time, selected by the Prediction's persisted `scoringPolicyVersion` through an explicit registry — never by a global constant. Report assembly deterministically stamps the current version (3) on every accepted Prediction; model-provided policy metadata never survives. Forecasts without a version resolve permanently under policy v2 (exchange-trading-day clocks for everything), and already-resolved scores are never rewritten. Policy v3 clocks: equity closes count provider-observed sessions, crypto closes resolve on the target UTC calendar date, macro/IV forecasts count calendar days, and earnings forecasts count provider-observed sessions anchored to the declared event; exchange calendars may schedule retries but are not authoritative for outcomes. See [ADR 0004](./docs/adr/0004-predictions-as-observable-forecasts.md).

## Prediction Trim

An otherwise valid Prediction dropped from the emitted Research View because redundancy rules removed it. It is telemetry, not a validation failure or a retry reason.

## Conditional Prediction

A Prediction whose scored event is conditional on an earlier observable event. Its probability means the consequent probability after the condition occurs; if the condition does not occur, the Prediction is voided and excluded from Calibration.

## Near-Base-Rate Prediction

An emitted Prediction whose stated probability sits within a small fixed band of 0.5 (a coin flip), labeled as forecast-quality telemetry. It remains valid in primary synthesis, but an optional Forecast Completion Pass does not merge Near-Base-Rate candidates because they add count without informative coverage. It is not investment conviction, model endorsement, or a trade signal.

## Forecast-Shape Diversity Guidance

Soft prompt-time guidance that enumerates distinct forecast shapes (direction, relative, range, volatility, earnings, conditional) available from deterministic context on deep instrument runs. It encourages exploring shape and horizon variety before stopping but does not change the soft-target semantics of `targetPredictions`. It is not a validation gate or rejection reason.

## Forecast Completion Pass

One best-effort, predictions-only model pass after a high- or medium-evidence report is valid but remains below its soft Prediction target. It preserves the report and accepted Predictions, merging only additional valid, cited, on-subject, non-redundant, non-Near-Base-Rate candidates; failure leaves a deterministic Prediction Shortfall.

## Prediction Subject

The instrument or instruments a run's scored Predictions are allowed to be about, declared per run. For `direction`, `range`, `volatility`, and `iv` forecasts it is the forecast subject; for `relative` forecasts it is the primary instrument named before the comparison. Instrument and Market Overview runs enforce that every emitted Prediction's subject belongs to this set, rejecting and retrying off-subject Predictions. Research runs do not apply this gate; their separate research prediction gate is the sole authority. See [ADR 0004](./docs/adr/0004-predictions-as-observable-forecasts.md).

## Forecast Disagreement

A research-only evidence signal that measures how much configured same-provider challenger models disagree with the canonical Prediction probabilities on an already-valid deep run. It summarizes unweighted probability spread, variance, and mean for the existing `measurableAs` set. It is an uncertainty signal, not the canonical scored probability, model endorsement, investment conviction, or a trade signal.

## Calibration

An aggregate, descriptive measurement of how well stated Prediction probabilities match observed resolution rates across Run Artifacts. The current dashboard uses resolved policy-v3 forecasts only and reports resolved count, hit rate, Brier score, reliability bins, slices, and explicit small-sample warnings. New summaries do not present baseline skill; historical summaries containing the legacy always-0.5 skill field remain readable. Calibration reporting does not determine whether current evidence supports a Prediction, control Prediction count, reject a forecast shape, or reject an emitted Prediction. It is not investment conviction, model endorsement, or a trade signal.

## Actionable Negative Calibration

A Calibration slice whose underperformance is supported by at least 30 resolved Predictions, 10 distinct Runs, and a Bonferroni-adjusted 98.75% one-sided Brier lower bound strictly above the 0.25 baseline. Asset class, job type, default Prediction-horizon bucket, and current Market Regime qualify independently. Only qualifying slices guide probability discipline in primary synthesis and the Forecast Completion Pass; they cannot suppress count, reject forecast shapes, or change evidence requirements. Legacy Calibration without uncertainty fields is descriptive but non-actionable.

## Regime-Sliced Calibration

A Calibration view that groups resolved Predictions by the Market Regime label in effect at forecast time (the persisted `risk-on` / `risk-off` / `mixed` / `insufficient-data` value), reported alongside the existing cadence, asset-class, and horizon slices. `insufficient-data` is a reported regime bin in its own right; runs with no persisted or unparseable regime are excluded but counted as a coverage gap, not folded into a real regime. A regime slice reports a Brier score only once it meets the minimum resolved-sample floor. It describes forecast accuracy by market backdrop; it is not investment conviction, model endorsement, or a trade signal.

## Market Overview

A horizon-parameterized research run for an asset class that summarizes market regime, liquid movers, themes, catalysts, risks, and source gaps. It persists as `jobType: "market-overview"` with `horizonTradingDays`.

`daily` and `weekly` are deprecated CLI aliases for market overview horizons of 5 and 15 trading days. Legacy artifacts remain readable and map into horizon buckets for calibration and cross-run intelligence. For longer horizons, equity mover inputs still come from Yahoo `day_gainers`, `day_losers`, and `most_actives` (a single-day multi-screener set), and crypto mover inputs still use CoinGecko 24h change fields; reports disclose this as a source gap.

## Research Subject Registry

A checked-in equity subject registry for the `research` run type. It resolves aliases such as `semis` or `chip stocks` to a canonical `subjectKey`, representative instruments, source provenance, and optionally one listed ETF prediction proxy. The public CLI and Research Console can queue `research <subject>` runs, while run artifacts, history/search filters, calibration/index rows, and prompt context carry `jobType: "research"` with subject identity. No registry hit, or no single proxy, means thematic research can proceed with zero scored predictions and a disclosed proxy gap.

## Cross-run Intelligence

The umbrella term for every way a run reads curated prior state back in: the Historical Research Context assembled into prompts, the `history` CLI family (rebuild/search/thesis-delta), per-Instrument timelines, calibration, Miss Autopsies, the prior-miss error-correction blocks (instrument and market-scoped, [ADR 0015](./docs/adr/0015-instrument-error-correction-ticker-only.md)), and the canonical Run Artifact read seam ([ADR 0016](./docs/adr/0016-run-artifact-reader.md)). It draws only from curated prior state — run artifacts, scores, calibration, Miss Autopsies, derived history, the alpha-search watchlist, and derived rebuildable indexes over those artifacts — never raw `data/cache`. Derived indexes are access paths, not sources of truth. Historical Research Context is its prompt-time surface (below).

## Historical Research Context

Artifact-backed context loaded or derived from prior `MARKET_BOT_DATA_DIR` run artifacts; the prompt-time surface of Cross-run Intelligence (above). In prompt use, it is a compact subset of prior findings, risks, catalysts, data gaps, scored predictions, extras, and selected normalized numeric snapshots; prior reports can appear as citeable `model` Sources. In user-facing history use, it can expose searchable and comparable historical views over prior reports, Sources, Predictions, Research Theses, open questions, and per-Instrument timelines. Selection reasons include recency (`recent`, `anchor-Nm`), topical relevance (`same-symbol`, `spotlight-symbol`, `same-horizon`, `cross-horizon`), and `miss-correction` for recent resolved-miss runs preserved against same-day rerun eviction. It is context for research wording, probability calibration, and historical comparison, not a new prediction-count or horizon policy.

## Run Artifact

The persisted output of a single research run under `MARKET_BOT_DATA_DIR/<run-id>/`: its Research View report, scored predictions, and normalized snapshots. Read back by later runs and history tooling to assemble Historical Research Context; never refetched from a Source Provider.

## Fixture Run

A deterministic test or eval run that executes the real research pipeline while replacing external HTTP and model boundaries with cassettes or a live eval model. It is for engineering validation only, not a Source or research artifact type.

## Data Cassette

A secret-scrubbed map of canonical HTTP requests to recorded responses, replayed below the source cache so collector, cache, normalization, and Source Gap behavior still execute.

## LLM Cassette

An ordered set of recorded `ModelProvider.generate` responses keyed by stage and model. Regression mode replays it; eval mode bypasses it with a live provider.

## Regression Mode

Fixture mode that replays both the Data Cassette and LLM Cassette for deterministic, zero-network, zero-model-cost CI coverage.

## Eval Mode

Fixture mode that replays the Data Cassette but uses the live configured ModelProvider. It exercises prompt, playbook, and model-stage changes while keeping market data static.

## Run Artifact Index

A derived, rebuildable SQLite query index over Run Artifacts (`data/index.sqlite` by default). It speeds up console list/search, `history search`, and calibration resolved-pair loading when fresh. Run `index rebuild` to bootstrap or repair it; research jobs, `alpha-search`, and `score` write through affected runs incrementally. A **stale** index (present and schema-matched but drifted) is automatically rebuilt on the next research, `score`, or `alpha-search` run as a non-fatal side effect. **Missing or unsupported-schema** indexes warn and fall back to disk scans pending `index rebuild`. `MARKET_BOT_INDEX_DISABLE` forces disk-only. Run Artifacts on disk remain the source of truth.

## Research Thesis

The research-only narrative state of a Research View, assembled from sourced summary, key findings, bull and bear cases, risks, catalysts, data gaps, and observable Predictions. A Research Thesis is not an investment thesis, recommendation, trade signal, or portfolio action.

## Prior-Thesis Error Correction

An instrument-run prompt block that surfaces prior Predictions on the current Instrument that resolved as misses — each with run ID, claim, stated probability, observed resolution values, and a source citation — framed as explicit error-correction signal rather than a passive citation pool. It steers research wording and probability calibration; it is not a recommendation, trade signal, or portfolio action. It fires for instrument runs only.

## Miss Autopsy

An artifact-backed classification of a material Prediction forecast error, persisted after scoring as a `miss-autopsy.json` sidecar. It compares the stated probability to the resolved observable event and records a conservative taxonomy cause from persisted artifacts only, with `insufficient_evidence` when those artifacts do not support a specific cause. It is not a live news fetch, model-generated narrative, investment conviction, recommendation, trade signal, or portfolio action.

## Market Update Delta

A compact, deterministic "what changed since the last comparable overview" summary auto-promoted into a Market Overview report, directly after the summary. It carries the regime label change (prior → current, naming flipped breadth/trend/VIX-term-structure drivers), the ranked Mover membership diff (symbols entered vs exited), and Predictions from prior same-asset-class, same-horizon-bucket Market Overview runs that resolved since the baseline was generated. It is computed with no model call and is descriptive only — distinct from the instrument-scoped, manual Research Thesis Delta (`history thesis-delta`), and never a trade signal or portfolio action.

## Verified Market Snapshot

A deterministic, analysis-date-anchored OHLCV and technical-indicator ground-truth block for a single Instrument. It is citeable supplemental evidence for exact numeric claims in a Research View. It is not investment conviction, a trade signal, or a scoring Observation unless explicitly promoted later. Equity instrument runs only; v1 uses Yahoo daily bars with a ≥400 calendar day lookback. See [ADR 0019](./docs/adr/0019-verified-market-snapshot.md).

## Instrument Accountability Timeline

A Research Console presentation of the existing per-Instrument timelines in Cross-run Intelligence. It assembles artifact-backed Research Theses, observable Predictions, score outcomes, Miss Autopsy causes, and available Verified Market Snapshot closes for one `assetClass + symbol`. "Accountability" means traceability from stated observable events to persisted outcomes; it is not investment correctness, model endorsement, recommendation, trade signal, or portfolio action.

## Historical Context Gap

A soft absence, parse failure, or mismatch in prior run artifacts. It is disclosed in historical context, but it is not a provider `SourceGap` and does not mean live source collection failed.

## Market Spotlight

An optional Market Overview focus selected from the current collected market snapshot universe. The selected set is the validated `spotlight-selection` result for a Market Overview. Current market evidence is required; historical context and alpha-search artifacts can enrich selection, but cannot create a spotlight by themselves. Spotlights do not run nested instrument jobs, fetch extra sources, or auto-upgrade a run to `--deep`.

## Market Regime

The current market backdrop inferred from fetched evidence, such as broad direction, volatility, liquidity, and dominant themes.

## Ticker Regime Context

Live equity breadth and volatility proxy evidence collected alongside the covered Instrument on equity runs, using the same proxy set as Market Overviews. It enables current-run Market Regime labeling in instrument Research Views without treating prior Market Overview artifacts as a substitute for missing live proxies.

## Market Context

Market-level evidence that enriches Market Overviews without targeting one Instrument.

## Domain Playbook

A checked-in research guidance snippet selected once per run after source collection and the Evidence Request Loop. It steers eligible downstream model stages without fetching sources, changing report schema, or adding trading behavior.

## Mover

A liquid instrument ranked deterministically by price movement magnitude, liquidity, and available Mover Features.

## Mover Feature

A deterministic, explainable input to Mover ranking. It can change rank when present, but missing coverage is neutral and is not investment conviction, expected return, or a trade signal.

## Benchmark-Relative Mover Context

Benchmark evidence that compares a Mover against a sector ETF or broad index without changing rank, implying advice, or expressing investment conviction.

## Evidence Quality

A deterministic label for how complete, recent, corroborated, and traceable the fetched evidence is. Model judgment cannot set or lower it; narrative uncertainty and Prediction probability are separate concepts. It is not investment conviction, predictive confidence, or expected return.

## Temporal Integrity

The guarantee that current evidence contains only facts observable on or before a run's explicit analysis cutoff. Later filings and future reporting periods are excluded; stale cache fallbacks remain in raw audit snapshots with disclosure but do not enter normalized current evidence.

## Post-Synthesis Audit

A deterministic, no-model inspection of a finished Research View that flags weak-evidence hygiene in report claims — for example a numeric or technical claim cited only to prior reports, or a weak claim missing an evidence-posture label. It is warn-only telemetry: warnings are recorded in analytics and trace but do not block, rewrite, or trigger re-synthesis. It surfaces where synthesis discipline can improve; it is not a research-only boundary check, a correctness guarantee, model endorsement, or a trade signal. The hard research-only boundary remains enforced separately by report validation, and enforced pruning of unsupported claims belongs to the distinct [[report-integrity-audit]].

## Report Integrity Audit

A deterministic, no-model pruning pass that runs after schema-valid synthesis and before forecast disagreement, distinct from the warn-only [[post-synthesis-audit]]. It removes blocking violations — numeric or technical findings, scenarios, and Predictions without an eligible supporting source (structural eligibility only; bare years, forecast-horizon wording, and cited historical forecast outcomes are exempt) — then validates and persists the pruned report. Uncited numeric summary sentences and missing evidence-posture labels stay advisory telemetry and are never pruned. Predictions removed here never enter scoring. See [ADR 0011](./docs/adr/0011-fixed-coverage-panel-for-deep-research.md).

## Report Integrity

A per-report grade stamped by the Report Integrity Audit: `high` when the report needed no pruning, `medium` when pruning occurred but required analytical sections (key findings, risks, scenarios) remain populated, `low` when pruning emptied a previously populated required section. Optional on historical reports at tolerant read boundaries; stamped on every new report write.

## Research Quality

The worse of Evidence Quality and Report Integrity, stamped alongside Report Integrity on every new report write. It summarizes how much of the run's output is both evidence-backed and structurally supported; it is not investment conviction or a trade signal.

## Source

A fetched data or news item saved with an ID so report claims can link back to evidence.

## Relevant News Source

A news Source an instrument or research run classifies as on-subject for its News Relevance Target(s) — matching the instrument symbol, ticker tokens, or issuer company-name terms. Instrument lanes carry a min-relevant-keep guarantee: when the persistent seen-dedupe strips every relevant Source but leaves generic survivors, the most recent relevant repeat Source(s) are re-added (one per instrument lane) and disclosed with a `repeat-fallback` Source Gap so the issuer signal is not lost to repeat-dedupe. It is a relevance classification, not investment conviction or a trade signal.

## News Relevance Target

The instrument or subject a run scores news relevance against: the ticker symbol (and optional issuer name) for instrument runs, or the research subject's representative instruments and aliases for research runs. A news Source is a Relevant News Source when it matches at least one target. It is a deterministic matching surface, not investment conviction or a trade signal.

## Source Provider

An external service that supplies market data, news, or reference data before it is normalized into Sources.

## Supplemental Source Provider

An optional Source Provider that contributes citeable evidence without driving deterministic mover selection, market regime labels, or scoring Observations unless explicitly promoted.

## Source Gap

A disclosed absence, weakness, failure, or staleness in Source Provider evidence that affects report reliability.
Canonical persisted research-run telemetry deduplicates identical normalized disclosed gap text (`source: message`) prospectively. Comparisons to pre-change runs may include duplicate-counting artifacts rather than true provider coverage changes.
When duplicates carry different metadata, the first normalized occurrence is retained.
`web-gather` Source Gaps are separate from `evidence-request` Source Gaps because the loops have different tools, budgets, and validation rules; both still flow through existing Source Plan lanes such as `subject-profile` or extended-evidence lanes.

## Source Plan

The deterministic, no-model set of Evidence Lanes a run intends to cover, classified core, material, or supplemental by checked-in policy. It is built from the resolved command and checked-in research subject before source collection begins — collection outcomes, credentials, and provider availability cannot change it — so actual evidence is graded against frozen pre-collection intent. It adds no provider calls, model calls, report fields, or scored Prediction behavior. See [ADR 0028](./docs/adr/0028-deterministic-source-plan-subsystem.md).

## Evidence Lane

An intended evidence channel within a Source Plan (for example market-data, news, verified-snapshot, sec-edgar). A lane is covered only when at least one backing Source exists; otherwise it is a lane gap. A lane gap is a coverage concept and is distinct from a Source Gap: a lane can be uncovered without any fetch having failed, and a Source Gap can occur in a lane that is still covered by other Sources. Missing coverage of a required lane is always a lane gap, never covered.

## Research Lead

An equity candidate surfaced for further research by alpha-search. It is not a recommendation, trade signal, expected return, or portfolio action.

## Source Promotion Criteria

Historical validation thresholds used to decide whether an alpha-search discovery source or source group should receive more workflow budget, weighting, or continued inclusion. They do not promote individual Research Leads.

## Social Momentum Score

A deterministic alpha-search ranking score derived only from ApeWisdom aggregate social-momentum features before market-data validation.

## Discussion Stance

A heuristic label for whether cited discussion appears constructive, skeptical, mixed, or unclear. It is noisy social evidence, not conviction.

## Alpha Search Report

A research-only discovery artifact that lists valid Research Leads and separately discloses rejected candidates with source IDs and reasons.

## Validation Baseline

A declared minimum set of exercised research routes and source capabilities required before provider readiness can be treated as passing.

## Provider Coverage Gap

A disclosed Source Gap caused by provider, account, region, or instrument limits rather than a failure of the research workflow. In provider-health validation it is usually expected or informational, not blocking. Non-US listings emit an `unsupported-coverage` gap without a network call when a US-only source (SEC EDGAR, Tradier IV, Finnhub company/event news) is gated off by the instrument-capability predicate; analytics classify these under the `unsupportedCoverage` source-gap class so they are isolated from `other` and `fetchFailed` gaps.

## Extended Evidence

Optional, higher-specificity Source Provider evidence that enriches instrument Research Views without changing the research-only boundary.

## Fundamental Evidence

Sourced issuer operating and financial facts used as Extended Evidence. It supports instrument Research Views but is not investment conviction, expected return, or a trade signal.

## Valuation Evidence

Deterministic Extended Evidence that combines market capitalization, sourced issuer fundamentals, and, for `equity --deep`, deterministic peer comps to calculate supplemental valuation context such as enterprise value, revenue multiples, peer median/IQR read-through, and a supportability label. Peer median/IQR aggregates admit only candidates that pass tier-scoped deterministic comparability gates: the size gates (market cap and annualized revenue each inclusively within 0.2x–5x of the target's) apply to every candidate, while the two-digit SEC SIC-group match is skipped for the human-audited `ticker-mapping` tier (`curated-no-sic` gate profile) and enforced for all other tiers (`full` profile). The applied `gateProfile` is recorded on the comps summary. At least three qualifying peers are required, and rejected candidates and their reasons remain visible as screening context. It helps test narrative claims against observable scale and valuation, but it is not investment conviction, expected return, peer ranking, or a trade signal. See [ADR 0006](./docs/adr/0006-ticker-extended-evidence.md).

## Financial Lens Evidence

Deterministic Extended Evidence for `equity` runs that groups compact SEC/Yahoo-derived metrics into neutral Quality, Growth, Financial Strength, Value, and Momentum lenses. Each lens carries metric values and an evidence posture (`criteria-supported`, `criteria-mixed`, `criteria-not-supported`, or `insufficient-data`) without a composite score, rank, recommendation, expected-return claim, or trade-action implication. Deep equity runs can include deterministic peer valuation supportability when available; brief equity runs remain target-only. Industry-relative ratios (PE, PBV, ROE, ROA, D/E, PCF) are display-only and do not contribute to lens posture; only ratios with article-sourced sustainability thresholds (Dividend Payout ≤ 0.8) contribute. See [ADR 0033](./docs/adr/0033-two-tier-fundamental-provenance.md).

## Business Framework Evidence

Deterministic Extended Evidence for `equity` runs that organizes already-collected SEC/Yahoo facts into research-only Business, Phase, Moat, Growth, Management, Risk, and Valuation sections. It persists a `normalized/business-framework.json` sidecar, emits a compact `business-framework` Extended Evidence item, and carries neutral section postures (`criteria-supported`, `criteria-mixed`, `criteria-not-supported`, or `insufficient-data`) plus lifecycle phase labels (`startup`, `hyper-growth`, `operating-leverage`, `capital-return`, or `decline`) without a composite score, rank, recommendation, expected-return claim, or trade-action implication. On `equity --deep` runs that gather web evidence, its qualitative gaps may be cleared by [[evidence-reconciliation]] after [[web-subject-profile]] extraction; its numeric postures and phase never change.

## Evidence Reconciliation

A deterministic, no-model pass that runs after [[web-subject-profile]] extraction on `equity --deep` runs and clears a [[business-framework-evidence]] qualitative gap only when the profile's corresponding _structured_ answers are present and carry cited web `sourceId`s. It removes resolved gap strings from the framework artifact and from the matching Source Gap disclosure so the report no longer discloses a gap its own profile resolved. It only ever removes gaps and records which profile facts resolved them; it never injects profile prose into framework summaries or metrics, never moves a section posture or lifecycle phase (those stay on normalized provider data), and never clears a gap with no structured profile question behind it. It is not investment conviction, a recommendation, or a trade signal.

## Yahoo Fundamentals Evidence

Pre-computed issuer fundamental fields captured once from the Yahoo quote endpoint payload (already fetched for market data) onto a typed optional `MarketSnapshot.fundamentals` sub-object in `normalizeYahooQuote`, then derived into an ExtendedEvidenceItem with `category: "yahoo-fundamentals"` from the normalized snapshot — not from the raw payload. It carries `trailingPE`, `forwardPE`, `priceToBook`, `dividendYield` (whole-percent, verified against captured fixtures), `epsTrailingTwelveMonths`, `epsForward`, `sharesOutstanding`, `trailingAnnualDividendRate`, and `bookValue`. It is the fallback source for ratios unavailable from SEC EDGAR (non-US listings) and the preferred source for price-relative ratios (PE, PBV) where Yahoo's TTM-based definition is more accurate than a partial-year SEC computation. It is Yahoo-sourced, not deterministic from raw facts, and carries the Yahoo snapshot source ID for provenance. See [ADR 0033](./docs/adr/0033-two-tier-fundamental-provenance.md).

## Earnings Setup

Deterministic, event-anchored context assembled automatically inside `equity --deep` when a Finnhub earnings-calendar record exists within 30 calendar days. It persists as `extras.earningsSetup` on the Research View: event metadata (symbol, date, timing, source IDs), an optional implied-move bar (ATM straddle midpoint / spot from the nearest post-event Tradier expiration within 7 calendar days), model-authored sourced analytical bullets (expectation bar, quality landmines, guidance credibility), and gaps for unsupported or missing setup data. Earnings-specific Predictions use event-anchored horizons (`horizonTradingDays` = post-event trading days, not days from `generatedAt`) with `earnings-direction` and `earnings-move` prediction kinds, resolved against the `earningsReturn` DSL. IV crush is deferred in v1; IV remains setup context or a gap only.

## Scored Catalyst

A deterministic, dated event derived from structured Source Provider feeds (earnings, dividend, and split records, plus macro releases), scored on two research-only axes only: materiality (a fixed 1–5 weight assigned by event category, not by semantic judgment) and date confidence (primary source / credible secondary / historical cadence). It is distinct from the model-authored narrative catalysts in a Research Thesis and from the descriptive Catalyst Calendar. A Scored Catalyst carries a real resolution date only when its date is confirmed-exact; windowed or cadence-inferred catalysts are context only and cannot anchor a Prediction. It deliberately omits the position-change axes (actionability, priority/urgency) of its source rubric. It is not investment conviction, expected return, a recommendation, or a trade signal.

## Catalyst Calendar

A deterministic, descriptive listing of dated items auto-promoted into a Market Overview report — model-authored narrative catalysts, observed macro context, and prior Prediction resolution dates. It is a passive calendar surface, not a scored or prediction-anchoring layer; that role belongs to the Scored Catalyst.

## Peer Universe

A deterministic, auditable set of comparable Instruments used for peer valuation context. Each peer carries provenance, role, and rationale. It resolves from one of three tiers: a checked-in ticker mapping (`ticker-mapping`), a Research Subject Registry fallback (`subject-registry`), or — when neither resolves for an `equity --deep` ticker — a `model-proposed-validated` set in which the model _proposes_ candidates and code _validates_ each one deterministically (SEC directory existence + US-listing + ETF exclusion + the fetchable-facts pipeline), with the validated set cached for reproducible reuse. The model never authors the peer set directly. Every candidate must additionally pass the deterministic comparability gates before it counts toward peer aggregates. These gates are tier-scoped: the 0.2x–5x market-cap and annualized-revenue bands apply to every tier, but the two-digit SIC-group match is skipped for the human-audited `ticker-mapping` tier (whose curation is itself the comparability judgment) and enforced for the `subject-registry` and `model-proposed-validated` tiers. Business-model rationale explains a candidate but never overrides a gate that applies to its tier. Tickers that cannot produce enough valid candidates emit a visible valuation SourceGap. See [ADR 0006](./docs/adr/0006-ticker-extended-evidence.md).
