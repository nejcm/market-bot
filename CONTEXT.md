# Market Bot Context

## Glossary

All artifacts and terms below are research-only: they do not imply investment conviction, recommendations, trade signals, or portfolio actions unless a definition explicitly says otherwise.

## Research View

A sourced artifact summarizing evidence, uncertainty, scenarios, risks, and gaps.

## Default View

The reader-facing surface of a deep-equity report or Console run: what the company does; price with
market date and freshness; a three-to-five-year plus TTM trend table; valuation context positioned
relative to the observed quote and never as a target price; catalysts and risks; upcoming earnings
and consensus; and material data gaps.

## Appendix

The trailing detail surface containing reverse DCF, full valuation tables, full peer rows and
excluded-peer diagnostics, institutional and insider detail, analyst estimate distributions,
options IV, the subsequent-financing bridge, capital ownership, and the five Financial Lenses with
their posture labels. Collection drops nothing; only placement changes.

## Research Console App

Local UI for browsing run history, Research Views, Sources, Source Gaps, evidence quality, analytics, and provider health.

## Run Chat

Ephemeral, per-Run Artifact Q&A in the Console. It is not persisted; when the Codex provider is active it may use web context, which never becomes a Source or Evidence.

## Web Gather

Bounded deep-run loop for on-subject `web_search` and allowlisted `web_fetch` through the cached Source Provider seam. Exa is primary; configured Firecrawl is fallback-only for failed or thin Exa responses, never a substitute for a missing `MARKET_BOT_EXA_API_KEY`. It persists Sources, gaps, and audit sidecars. A fallback that covers a failed, empty, or thin Exa `web_search` response closes the Exa Source Gap but never erases the incident: the run still reports a non-available web-search row in Provider Health and a `web-search-provider` Subsystem Outcome. `web_fetch` fallbacks have no endpoint row of their own and are recorded in that outcome's detail counts.

For company subjects, SEC 10-K/10-Q profile coverage rejects redundant `background` and `current-subject` searches that give no recency, corroboration, or explicit-gap rationale; reused-profile coverage rejects `background` searches on the same terms only, and `news` and `market` searches are exempt from both. Reused profiles narrow implicit per-query ingestion from 5 to 3 results. `web-gather` is Source-Gap taxonomy, not an Evidence Lane.

## Web Evidence

Low-trust, open-web Sources (`kind: "web"`) tagged with `exa` or fallback `firecrawl` provenance. They can support cited qualitative claims but cannot widen run or Prediction scope, or raise Evidence Quality beyond the extended-evidence cap.

## Raw Web Snapshot

Exact provider payload retained for audit and replay; never model-visible evidence.

## Freshness-Budgeted Source Cache

Replays same-day provider payloads only within adapter freshness budgets. Expired entries require a live refetch; a failed refetch leaves any stale payload raw-audit-only and records a stale-cache Source Gap.

## Model-Visible Web Text

Sanitized, low-trust web prose used for profile extraction and final synthesis. Profile-covered sources stay metadata-only because their facts enter through the cited profile digest.

## Model Input Sanitization

Deterministic, profile-aware removal of high-confidence model-directed instructions from untrusted provider prose, metadata, SEC text, and prompt-bound history. Raw snapshots and history remain unchanged; only aggregate counts are persisted in trace and analytics.

## Web Source Roles

Separate web accounting prevents volume being mistaken for coverage: current-run accepted, profile-used, report-cited, and unused Sources appear in `analytics.json:webSources`; reused-profile coverage appears separately with source run, age, and timestamp.

## Web Subject Profile

Deterministic, citation-checked sidecar answering a fixed Subject-Kind question set from Web Evidence. Company profiles may use issuer 10-K/10-Q text first and require a current SEC basis for reuse; reuse skips extraction, not fresh Web Gather.

## Subject Kind

Web Subject Profile question set and reuse rule: `company` for equity, `crypto-asset` for crypto, and `theme` for research runs.

## Subject

Research target: resolved Instrument for equity/crypto, or free-text thematic subject. It bounds web evidence but not Prediction Subjects.

## Instrument

Tradable listed or quoted target, currently identified by `symbol + assetClass`, with optional exchange, currency, provider IDs, and aliases.

## Instrument Identity

Provider-normalized metadata that relates Source Provider records to an Instrument.

## Quote Currency

Currency of quoted market prices (`InstrumentIdentity.quoteCurrency`). Yahoo `GBp` means pence, not ISO `GBP`; it renders as pence without K/M/B scaling.

## Reporting Currency

Currency used in issuer fundamentals, distinct from Quote Currency (for example, GBP reports versus GBp quotes). Fundamental Financial Lens metrics use it; cash/debt/FCF threading is deferred to P2.

## Observation

Public market value, point-in-time or windowed, used to resolve a Prediction.

## Prediction

Observable forecast whose `probability` is the chance `measurableAs` is true; bearish or in-range views use probabilities below 0.5 under the asymmetric grammar. The public claim renders from `measurableAs`, not model text. Depth targets are soft: shortfalls are disclosed through the structured `ResearchReport.predictionShortfall` contract, never padded. See [ADR 0003](./docs/adr/0003-forecasts-scoring-calibration-cross-run-intelligence.md).

## Prediction Shortfall

Structured disclosure that a report emitted fewer observable Predictions than its soft target after
earnings and research-subject gates. It records emitted, target, and missing counts; presentation
derives canonical reader text from those counts instead of storing a machine protocol in Data Gaps.

## Scoring Policy

Versioned, persisted Prediction clock contract selected through a registry. New Predictions are stamped v3; unversioned legacy forecasts remain v2 and resolved scores never change. V3 uses provider-observed sessions for equity and earnings, target UTC date for crypto, and calendar days for macro/IV. See [ADR 0003](./docs/adr/0003-forecasts-scoring-calibration-cross-run-intelligence.md).

## Prediction Trim

Valid Prediction omitted after redundancy removal; telemetry, not a validation failure or retry reason.

## Conditional Prediction

Prediction whose event depends on an earlier observable condition. Its probability is conditional; unmet conditions void it and exclude it from Calibration.

## Near-Base-Rate Prediction

Emitted Prediction within a fixed band of 0.5. It remains valid but the Forecast Completion Pass does not add such candidates merely to raise count.

## Forecast-Shape Diversity Guidance

Soft prompt guidance for direction, relative, range, volatility, earnings, and conditional shapes on deep instrument runs; never a validation gate.

## Forecast Completion Pass

Best-effort predictions-only pass after a valid high/medium-evidence report falls below its soft target. It retains the report and merges only additional valid, cited, on-subject, non-redundant, non-near-base-rate candidates from distilled narrative, critique, source index, and deterministic anchors; failure yields a deterministic shortfall.

## Stage Duration

Positive monotonic milliseconds awaiting a model-stage attempt, recorded as optional `durationMs` in trace and analytics. It excludes orchestration time and is not additive wall-clock time across concurrent stages.

## Prediction Subject

Declared set an instrument or Market Overview Prediction may concern. Direction/range/volatility/IV use the forecast subject; relative uses its primary instrument. Research runs instead use their dedicated prediction gate. See [ADR 0003](./docs/adr/0003-forecasts-scoring-calibration-cross-run-intelligence.md).

## Forecast Disagreement

Deep-run uncertainty signal summarizing configured challenger-model probability spread, variance, and mean over existing `measurableAs` events. It never replaces canonical probabilities.

## Forecast Persistence Telemetry

Per-run comparison with the newest comparable prior run, counting repeated canonical claims and unchanged probabilities, plus `changedProbabilityCount` and `maxAbsProbabilityDelta`. It is descriptive Cross-run Intelligence only.

## Calibration

Aggregate measurement of stated probabilities against resolved outcomes: resolved count, hit rate, Brier score, reliability bins, slices, and small-sample warnings. New dashboards use policy-v3 forecasts; legacy summaries remain readable.

## Actionable Negative Calibration

Underperforming Calibration slice with at least 30 resolved Predictions, 10 Runs, and a Bonferroni-adjusted 98.75% one-sided Brier lower bound above 0.25. Qualifying asset-class, job-type, default-horizon, and Market-Regime slices can guide probability discipline, never count, shape, or evidence rules.

## Regime-Sliced Calibration

Calibration grouped by persisted `risk-on`, `risk-off`, `mixed`, or `insufficient-data` Market Regime. Missing/unparseable regimes are reported as a coverage gap; Brier score appears only after the minimum sample floor.

## Market Overview

Horizon-parameterized asset-class research run (`jobType: "market-overview"`) covering regime, liquid movers, themes, catalysts, risks, and gaps. Deprecated `daily`/`weekly` aliases mean 5/15 trading days; longer horizons still use one-day Yahoo/CoinGecko mover inputs and disclose that limitation.

## Research Subject Registry

Checked-in registry for thematic `research` runs. It resolves aliases to a `subjectKey`, representative instruments, provenance, and optional listed ETF prediction proxy, but never restricts user subjects. Missing registry/proxy permits zero scored Predictions with a disclosed proxy gap.

## Cross-run Intelligence

Curated prior-state readback: Historical Research Context, history CLI, Instrument timelines, Calibration, Miss Autopsies, Forecast Persistence, error-correction blocks, and the canonical Run Artifact read seam. It never uses raw `data/cache`; derived indexes are access paths, not truth.

## Historical Research Context

Artifact-backed prompt and user-facing context from prior reports, Sources, Predictions, theses, gaps, extras, and selected numeric snapshots. Selection records recency, topical, and miss-correction reasons; it informs wording, calibration, and comparison, not Prediction count or horizons.

## Run Artifact

Persisted output of one run at `MARKET_BOT_DATA_DIR/<run-id>/`: Research View, scores, and normalized snapshots. Later runs and history read it; Source Providers are never refetched for it.

## Subsystem Outcome

Coded record of what one run subsystem was expected to do and whether it acquired output, stayed
empty, declined, failed, or was blocked. `empty` means no output was accepted as the subsystem's
result: nothing came back, or what came back was not accepted, as when every prediction completion
candidate is rejected. Output that is accepted but carries a usability posture stays `produced`
under a code saying so, so an unsupportable Evidence Lane is not `empty`. `declined` means the
subsystem yielded no result and its producer did not treat that as a failure or a blockage: out of
scope for the run, never enabled by scope, configuration, budget, or credentials, suppressed by
design, unsupported for the subject, or run and cleanly refused — as a prediction completion pass
does when it parses and returns no candidates.

The five statuses are not a clean taxonomy and will mislead if read as one. Each records how that
subsystem's own producer classified its situation, so the same condition can map differently across
subsystems: a Domain Playbook selector returning malformed JSON is `declined` under
`selection-rejected` rather than `failed`, and a missing Exa credential skips Web Gather as
`declined` while a lane-local missing credential is `blocked`. The code beside the status is the
specific part — it distinguishes acquired-but-unusable output and lane-local causes. Reading
`empty` as nothing accepted is what keeps `expectedEmptyCount` an accurate name for every row it
counts. It is run telemetry, not a Diagnostic Gap.

## Failed Run Artifact

Persisted diagnostics from a run whose final synthesis never produced a valid Research View. `failure.json` marks a complete Failed Run Artifact; `outcomes.json`, `rejected-report.json`, `stages.json`, normalized evidence, and raw snapshots preserve the rejection context, while `report.json` is deliberately absent.

## Fixture Run

Engineering-only deterministic test/eval run using real orchestration with HTTP/model boundaries replaced by cassettes or a live eval model.

## Data Cassette

Secret-scrubbed canonical HTTP request-to-response map replayed beneath the cache, leaving collector, normalization, and Source-Gap behavior active.

## LLM Cassette

Ordered recorded `ModelProvider.generate` responses by stage/model. Regression mode uses it; eval mode bypasses it.

## Regression Mode

Fixture mode replaying Data and LLM Cassettes for deterministic, zero-network, zero-model-cost coverage.

## Eval Mode

Fixture mode replaying Data Cassettes while calling the configured live model, keeping market data static.

## Run Artifact Index

Rebuildable SQLite index over Run Artifacts (`data/index.sqlite` by default) for console/search/calibration queries. Jobs update it incrementally; stale indexes rebuild automatically, missing/unsupported indexes fall back to disk, and disk artifacts remain authoritative.

## Research Thesis

Research View narrative state: sourced summary, findings, cases, risks, catalysts, gaps, and observable Predictions; not an investment thesis.

## Prior-Thesis Error Correction

Instrument-run prompt block of prior missed Predictions, their probabilities, observations, and citations. It explicitly informs wording and calibration, not recommendations.

## Miss Autopsy

Post-score `miss-autopsy.json` classification of a material Prediction error from persisted artifacts only. It uses `insufficient_evidence` when no specific cause is supported.

## Market Update Delta

Deterministic Market Overview summary of changes from the comparable previous overview: regime drivers, mover entries/exits, and newly resolved Predictions. It is distinct from manual instrument `history thesis-delta`.

## Verified Market Snapshot

Analysis-date-anchored, citeable OHLCV and technical-indicator block for an equity Instrument. V1 uses Yahoo daily bars with a ≥400-day lookback; it is supplemental evidence, not a scoring Observation. See [ADR 0004](./docs/adr/0004-evidence-identity-providers-deterministic-analysis.md).

## Instrument Accountability Timeline

Console view for one `assetClass + symbol`, joining Research Theses, Predictions, scores, Miss Autopsies, and available verified closes for traceability.

## Historical Context Gap

Disclosed absence, parse failure, or mismatch in prior artifacts; not a live-provider Source Gap.

## Market Spotlight

Optional validated Market Overview focus chosen from current collected market snapshots. History and alpha-search can enrich it but cannot create it; it does not launch nested jobs, fetch sources, or upgrade depth.

## Market Regime

Current fetched-evidence backdrop: broad direction, volatility, liquidity, and dominant themes.

## Ticker Regime Context

Live equity breadth/volatility proxy evidence collected with an Instrument to label its current Market Regime without relying on historical overviews.

## Market Context

Market-level evidence that enriches a Market Overview without targeting an Instrument.

## Domain Playbook

Checked-in guidance selected after collection and any deterministic deep-equity packet merge. It steers downstream stages without fetching data, changing schema, or trading behavior; research deterministically includes thematic and subject-matched playbooks.

## Mover

Liquid Instrument ranked deterministically by movement magnitude, liquidity, and available Mover Features.

## Mover Feature

Deterministic, explainable ranking input; absence is neutral.

## Benchmark-Relative Mover Context

Citeable sector-ETF or index comparison for a Mover that never changes rank.

## Evidence Quality

Deterministic grade of evidence completeness, recency, corroboration, and traceability. Model judgment, narrative uncertainty, and Prediction probability cannot set it.

## Equity Analysis Completeness

Deterministic grade of what an equity issuer's reporting surface makes achievable, including due interim coverage, filing cadence, and per-share and payout evidence. It is distinct from Evidence Quality, which grades what sourcing achieved: complete sourcing can expose an incomplete reporting surface, such as a due quarter the issuer has not filed. See [ADR 0004](./docs/adr/0004-evidence-identity-providers-deterministic-analysis.md).

## Temporal Integrity

Current evidence contains only facts observable by its analysis cutoff. Later facts are excluded; stale fallbacks stay raw-audit-only with disclosure.

## Post-Synthesis Audit

Warn-only, no-model inspection for weak-evidence hygiene (for example unsupported numeric/technical claims or missing evidence posture). It records telemetry without blocking, rewriting, or re-synthesis; Report Integrity Audit handles pruning.

## Gap-Shaped Claim

Narrative absence-of-evidence claim recognized by two consumer-specific predicates. The broad relocation predicate moves an uncited claim from a findings section, or an eligible known Business Framework section with no projected fallback source IDs, into `dataGaps` and records its original path and text in `trace.json:relocatedGapClaims`. The stricter audit predicate emits the observational `gap-shaped-claim-cited` warning when such a claim carries source IDs. The predicates are not interchangeable.

## Report Integrity Audit

No-model pass after schema-valid synthesis and before forecast disagreement that prunes unsupported numeric/technical findings, scenarios, and Predictions, then validates/persists the result. Uncited numeric summary prose and missing posture labels remain advisory; pruned Predictions never score. See [ADR 0005](./docs/adr/0005-research-workflows-model-stage-pipeline.md).

## Report Integrity

Audit grade: `high` (no pruning), `medium` (pruned but required sections remain), or `low` (pruning emptied a previously populated required section). New reports always stamp it; tolerant historical reads may omit it.

## Research Quality

The worse of Evidence Quality and Report Integrity, stamped on new reports.

## Source

Fetched market, news, or reference item with an ID for claim citations.

## Relevant News Source

News Source matching a News Relevance Target. If seen-dedupe removes all relevant instrument news while generic items remain, the newest relevant repeat is restored per instrument lane and disclosed as `repeat-fallback`.

## News Relevance Target

Ticker/issuer terms for instrument runs, or subject representatives and aliases for research runs, used for deterministic relevance matching.

## Source Provider

External market, news, or reference service normalized into Sources.

## Supplemental Source Provider

Optional citeable provider that does not drive mover ranking, regime labels, or scoring Observations unless explicitly promoted.

## Source Gap

Disclosed missing, weak, failed, or stale provider evidence. Persisted research telemetry deduplicates normalized `source: message` text; `web-gather` and compatibility `evidence-request` gaps remain separate because their acquisition paths differ, while both flow through Source Plan lanes.

Every Source Gap stays declared in the report, analytics, sidecar, and Console. Only the Web Gather stage prompt sees a narrower view that omits gaps no web search can close.

## Not-Assessed

Completeness status for a dimension that could not be evaluated because its inputs were never
configured or available to the deployment, such as an unconfigured operating-KPI registry or a
missing optional provider credential or entitlement. It never counts as complete, and never
upgrades a tier or raises the headline grade relative to counting the same dimension as `partial`.
Unlike `partial`, it does not mean the dimension was assessed with incomplete data.

## Material Gap

A Material Gap affects what a reader can conclude about the company, such as missing financial
statements, a failed verified price snapshot, or provider data missing from a core lane, and appears
in the Default View.

## Diagnostic Gap

A Diagnostic Gap is an instrumentation or entitlement artifact, such as an absent optional
provider, an entitlement 403, or an unconfigured operating-KPI registry, and appears only in the
Appendix.
Prediction shortfalls affect the delivered research scope and appear last among Material Gaps in
the Default View. Non-equity Console views keep the structured disclosure in a dedicated Shortfall
block.

## Source Plan

Deterministic, pre-collection policy for intended Evidence Lanes classified core, material, or supplemental. It is frozen from the command and checked-in subject, so credentials, availability, and outcomes cannot change it. See [ADR 0004](./docs/adr/0004-evidence-identity-providers-deterministic-analysis.md).

## Evidence Lane

Intended Source Plan channel, such as market data, news, verified snapshot, or SEC EDGAR. It is covered only by a backing Source; an uncovered lane is distinct from a Source Gap.

## Research Lead

Equity candidate surfaced for further alpha-search research.

## Source Promotion Criteria

Historical validation thresholds for increasing a discovery source/group's workflow budget, weighting, or retention; never for promoting individual Research Leads.

## Social Momentum Score

Deterministic alpha-search rank from ApeWisdom aggregate social-momentum features before market-data validation.

## Discussion Stance

Noisy heuristic classification of cited discussion as constructive, skeptical, mixed, or unclear.

## Alpha Search Report

Research-only discovery artifact listing valid Research Leads and rejected candidates with source IDs and reasons.

## Validation Baseline

Minimum exercised research routes and source capabilities required for provider readiness to pass.

## Provider Coverage Gap

Source Gap caused by provider, account, region, or instrument limits, usually expected/informational in provider-health validation. Gated US-only sources emit `unsupported-coverage` without network calls and analytics classify it separately.

## Extended Evidence

Optional higher-specificity provider evidence for instrument Research Views.

## Fundamental Evidence

Sourced issuer operating and financial facts used as Extended Evidence.

## Current Report Evidence

Bounded text from up to two recent SEC current reports — 8-K for domestic filers, 6-K for foreign private issuers — filed within 120 days of collection. Routine 8-Ks must postdate the newest periodic filing, while the newest Item 2.02 earnings release within the window gets one of the two slots despite that floor because it normally precedes the periodic filing and carries nonduplicative results context. The no-periodic-basis path is foreign-private-issuer/6-K only; a domestic filer without a 10-K or 10-Q receives no current-report packet. A substantive EX-99 earnings-release exhibit is preferred over the primary document; a gap discloses when neither reports substantive results.

## Valuation Evidence

Deterministic Extended Evidence combining market cap, fundamentals, and, for `equity --deep`, peer comps into enterprise value, revenue multiples, peer median/IQR, and supportability. Peers need at least three qualifying candidates and 0.2x–5x market-cap/revenue gates; SIC matching applies except to curated `ticker-mapping` (`curated-no-sic` versus `full` gate profiles). Rejections remain visible. See [ADR 0004](./docs/adr/0004-evidence-identity-providers-deterministic-analysis.md).

## Valuation Workbench

Versioned equity sidecar joining canonical annual or reconciled-TTM fundamentals to the first verified close within seven calendar days on or after the inputs became public. It reports P/E, P/S, EV/revenue, and P/FCF with N/M and suppression reasons, and carries the existing peer table/reference range with dates, currencies, supportability, and sources. Missing canonical TTM is suppressed; retained quarter-only periods are never combined into an unreconciled trailing value.

## Reverse DCF Input Sensitivity

An isolated versioned equity sidecar that solves the five-year FCF growth input across 8%–16% discount rates and 0%–4% terminal-growth assumptions. It discloses reconciled-TTM starting FCF, observed enterprise value, input dates, currencies, sources, and the five-year horizon. Missing, non-positive, or currency-incompatible inputs suppress the artifact. Its research-only boundary is defined by [ADR 0001](./docs/adr/0001-research-only-boundary.md).

## Financial Lens Evidence

Neutral SEC/Yahoo metric groups for Quality, Growth, Financial Strength, Value, and Momentum with a posture, never a composite score or rank. Deep equity can add peer supportability; industry-relative ratios are display-only except Dividend Payout ≤0.8. See [ADR 0004](./docs/adr/0004-evidence-identity-providers-deterministic-analysis.md).

## Business Framework Evidence

Deterministic SEC/Yahoo framework for Business, Phase, Moat, Growth, Management, Risk, and Valuation, persisted in `normalized/business-framework.json`. It has neutral section postures and lifecycle labels; on deep web-enabled equity runs, Evidence Reconciliation may clear qualitative gaps but never numeric postures or phase.

## Evidence Reconciliation

No-model post-profile pass for `equity --deep` that removes a Business Framework qualitative gap only when the corresponding structured, cited web profile answer exists. It records the resolution and never adds prose, changes postures/phase, or clears unrelated gaps.

## Yahoo Fundamentals Evidence

Typed fundamentals captured once from normalized Yahoo quotes and emitted as `yahoo-fundamentals`: P/E, P/B, yield, EPS, shares, dividend, and book value. It supports non-US ratios and price-relative ratios with source provenance. See [ADR 0004](./docs/adr/0004-evidence-identity-providers-deterministic-analysis.md).

## Earnings Setup

For `equity --deep`, deterministic event context when Finnhub reports earnings within 30 days: metadata, event-date certainty, optional Tradier implied move, sourced analytical bullets, and gaps. Finnhub dates remain `provider-estimated`; direct issuer IR/press-release or explicit-future SEC 8-K/6-K evidence can establish `issuer-confirmed`, and only a direct official exchange source can establish `exchange-confirmed`. Earnings Predictions use post-event trading-day horizons and `earningsReturn` only for confirmed dates; estimated setups remain contextual. IV crush is deferred.

## Scored Catalyst

Deterministic dated provider event (earnings, dividend, split, macro release) scored only by fixed materiality and date confidence. Only confirmed-exact dates can anchor Predictions; it is distinct from narrative catalysts and the Catalyst Calendar.

## Catalyst Calendar

Passive Market Overview list of narrative catalysts, observed macro context, and prior Prediction resolution dates; it never scores or anchors Predictions.

## Peer Universe

Deterministic, auditable comparable-Instrument set for peer valuation. It resolves in order from checked-in ticker mapping, Subject Registry, or model-proposed candidates that code validates and caches; the model never authors the set. All candidates face tier-scoped comparability gates, and insufficient valid peers yield a valuation Source Gap. See [ADR 0004](./docs/adr/0004-evidence-identity-providers-deterministic-analysis.md).
