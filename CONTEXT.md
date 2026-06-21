# Market Bot Context

## Glossary

## Research View

A sourced research artifact that summarizes evidence, uncertainty, scenarios, risks, and gaps without recommending trades or portfolio actions.

## Research Console App

A local research-only user interface for browsing run history, Research Views, Sources, Source Gaps, Evidence Quality, analytics, and provider health without changing the research-only boundary.

## Run Chat

An ephemeral, per-Run Artifact interactive question-and-answer surface in the Research Console, grounded in that run's artifacts. It is not a persisted artifact and is not bound by the research-only boundary that governs Research Views.

## Instrument

A tradable listed or quoted research target. In the current CLI it is still identified by `symbol + assetClass`, with optional exchange, quote currency, provider IDs, and aliases when known.

## Instrument Identity

Provider-normalized metadata that helps relate Source Provider records to an Instrument without changing the research-only boundary.

## Observation

A public market quantity value used to resolve a Prediction. An Observation can be point-in-time or part of a window. It is not advice, conviction, or a trade signal.

## Prediction

- `probability` always means the probability that `measurableAs` evaluates true; with the asymmetric up/outside grammar, bearish or stays-within-range views are expressed as probabilities below 0.5 on that up/outside event. The public `claim` is rendered from `measurableAs`, not model-authored ([ADR 0020](./docs/adr/0020-claim-rendered-from-dsl.md)). Depth profiles set a soft `targetPredictions` count; below-target runs disclose `predictionShortfall` rather than padding ([ADR 0021](./docs/adr/0021-prediction-count-soft-target.md)).

## Conditional Prediction

A Prediction whose scored event is conditional on an earlier observable event. Its probability means the consequent probability after the condition occurs; if the condition does not occur, the Prediction is voided and excluded from Calibration.

## Near-Base-Rate Prediction

An emitted Prediction whose stated probability sits within a small fixed band of 0.5 (a coin flip), labeled as analytics-only forecast-quality telemetry. It measures stated confidence after generation and is distinct from forecast-kind priority, which shapes generation by favoring better-measured kinds over bare `direction`. It is never a rejection gate and does not change prediction-count or horizon policy; it is not investment conviction, model endorsement, or a trade signal.

## Prediction Subject

The instrument or instruments a run's scored Predictions are allowed to be about, declared per run. For `direction`, `range`, `volatility`, and `iv` forecasts it is the forecast subject; for `relative` forecasts it is the primary instrument named before the comparison. Ticker and Market Overview runs enforce that every emitted Prediction's subject belongs to this set, rejecting and retrying off-subject Predictions. Research runs do not apply this gate; their separate research prediction gate is the sole authority. See [ADR 0004](./docs/adr/0004-predictions-as-observable-forecasts.md).

## Forecast Disagreement

A research-only evidence signal that measures how much configured same-provider challenger models disagree with the canonical Prediction probabilities on an already-valid deep run. It summarizes unweighted probability spread, variance, and mean for the existing `measurableAs` set. It is an uncertainty signal, not the canonical scored probability, model endorsement, investment conviction, or a trade signal.

## Calibration

An aggregate measurement of how well stated Prediction probabilities match observed resolution rates across Run Artifacts: Brier score, Brier skill score versus a 0.5 baseline, and reliability bins. It describes forecast accuracy; it is not investment conviction, model endorsement, or a trade signal.

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

## Run Artifact Index

A derived, rebuildable SQLite query index over Run Artifacts (`data/index.sqlite` by default). It speeds up console list/search, `history search`, and calibration resolved-pair loading when fresh. Run `index rebuild` to bootstrap or repair it; research jobs, `alpha-search`, and `score` write through affected runs incrementally. A **stale** index (present and schema-matched but drifted) is automatically rebuilt on the next research, `score`, or `alpha-search` run as a non-fatal side effect. **Missing or unsupported-schema** indexes warn and fall back to disk scans pending `index rebuild`. `MARKET_BOT_INDEX_DISABLE` forces disk-only. Run Artifacts on disk remain the source of truth.

## Research Thesis

The research-only narrative state of a Research View, assembled from sourced summary, key findings, bull and bear cases, risks, catalysts, data gaps, and observable Predictions. A Research Thesis is not an investment thesis, recommendation, trade signal, or portfolio action.

## Prior-Thesis Error Correction

A ticker-run prompt block that surfaces prior Predictions on the current Instrument that resolved as misses — each with run ID, claim, stated probability, observed resolution values, and a source citation — framed as explicit error-correction signal rather than a passive citation pool. It steers research wording and probability calibration; it is not a recommendation, trade signal, or portfolio action. It fires for ticker runs only.

## Miss Autopsy

An artifact-backed classification of a material Prediction forecast error, persisted after scoring as a `miss-autopsy.json` sidecar. It compares the stated probability to the resolved observable event and records a conservative taxonomy cause from persisted artifacts only, with `insufficient_evidence` when those artifacts do not support a specific cause. It is not a live news fetch, model-generated narrative, investment conviction, recommendation, trade signal, or portfolio action.

## Market Update Delta

A compact, deterministic "what changed since the last comparable overview" summary auto-promoted into a Market Overview report, directly after the summary. It carries the regime label change (prior → current, naming flipped breadth/trend/VIX-term-structure drivers), the ranked Mover membership diff (symbols entered vs exited), and Predictions from prior same-asset-class, same-horizon-bucket Market Overview runs that resolved since the baseline was generated. It is computed with no model call and is descriptive only — distinct from the instrument-scoped, manual Research Thesis Delta (`history thesis-delta`), and never a trade signal or portfolio action.

## Verified Market Snapshot

A deterministic, analysis-date-anchored OHLCV and technical-indicator ground-truth block for a single Instrument. It is citeable supplemental evidence for exact numeric claims in a Research View. It is not investment conviction, a trade signal, or a scoring Observation unless explicitly promoted later. Equity ticker runs only; v1 uses Yahoo daily bars with a ≥400 calendar day lookback. See [ADR 0019](./docs/adr/0019-verified-market-snapshot.md).

## Instrument Accountability Timeline

A Research Console presentation of the existing per-Instrument timelines in Cross-run Intelligence. It assembles artifact-backed Research Theses, observable Predictions, score outcomes, Miss Autopsy causes, and available Verified Market Snapshot closes for one `assetClass + symbol`. "Accountability" means traceability from stated observable events to persisted outcomes; it is not investment correctness, model endorsement, recommendation, trade signal, or portfolio action.

## Historical Context Gap

A soft absence, parse failure, or mismatch in prior run artifacts. It is disclosed in historical context, but it is not a provider `SourceGap` and does not mean live source collection failed.

## Market Spotlight

An optional Market Overview focus selected from the current collected market snapshot universe. The selected set is the validated `spotlight-selection` result for a Market Overview. Current market evidence is required; historical context and alpha-search artifacts can enrich selection, but cannot create a spotlight by themselves. Spotlights do not run nested ticker jobs, fetch extra sources, or auto-upgrade a run to `--deep`.

## Market Regime

The current market backdrop inferred from fetched evidence, such as broad direction, volatility, liquidity, and dominant themes.

## Ticker Regime Context

Live equity breadth and volatility proxy evidence collected alongside the covered Instrument on equity ticker runs, using the same proxy set as Market Overviews. It enables current-run Market Regime labeling in ticker Research Views without treating prior Market Overview artifacts as a substitute for missing live proxies.

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

A label for how complete, recent, corroborated, and traceable the fetched evidence is. It is not investment conviction or expected return.

## Post-Synthesis Audit

A deterministic, no-model inspection of a finished Research View that flags weak-evidence hygiene in report claims — for example a numeric or technical claim cited only to prior reports, or a weak claim missing an evidence-posture label. It is warn-only telemetry: warnings are recorded in analytics and trace but do not block, rewrite, or trigger re-synthesis. It surfaces where synthesis discipline can improve; it is not a research-only boundary check, a correctness guarantee, model endorsement, or a trade signal. The hard research-only boundary remains enforced separately by report validation.

## Source

A fetched data or news item saved with an ID so report claims can link back to evidence.

## Source Provider

An external service that supplies market data, news, or reference data before it is normalized into Sources.

## Supplemental Source Provider

An optional Source Provider that contributes citeable evidence without driving deterministic mover selection, market regime labels, or scoring Observations unless explicitly promoted.

## Source Gap

A disclosed absence, weakness, failure, or staleness in Source Provider evidence that affects report reliability.

## Source Plan

The deterministic, no-model set of Evidence Lanes a run intends to cover, each marked required or optional with the real provider path that would supply it. It records intended coverage before synthesis so actual evidence can be compared against it. It adds no provider calls, model calls, report fields, or scored Prediction behavior. See [ADR 0028](./docs/adr/0028-deterministic-source-plan-subsystem.md).

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

A disclosed Source Gap caused by provider, account, region, or instrument limits rather than a failure of the research workflow. In provider-health validation it is usually expected or informational, not blocking.

## Extended Evidence

Optional, higher-specificity Source Provider evidence that enriches ticker Research Views without changing the research-only boundary.

## Fundamental Evidence

Sourced issuer operating and financial facts used as Extended Evidence. It supports ticker Research Views but is not investment conviction, expected return, or a trade signal.

## Valuation Evidence

Deterministic Extended Evidence that combines market capitalization, sourced issuer fundamentals, and, for `ticker --deep --asset equity`, deterministic peer comps to calculate supplemental valuation context such as enterprise value, revenue multiples, peer median/IQR read-through, and a supportability label. It helps test narrative claims against observable scale and valuation, but it is not investment conviction, expected return, peer ranking, or a trade signal. See [[ADR 0031]].

## Earnings Setup

Deterministic, event-anchored context assembled automatically inside `ticker --deep --asset equity` when a Finnhub earnings-calendar record exists within 30 calendar days. It persists as `extras.earningsSetup` on the Research View: event metadata (symbol, date, timing, source IDs), an optional implied-move bar (ATM straddle midpoint / spot from the nearest post-event Tradier expiration within 7 calendar days), model-authored sourced analytical bullets (expectation bar, quality landmines, guidance credibility), and gaps for unsupported or missing setup data. Earnings-specific Predictions use event-anchored horizons (`horizonTradingDays` = post-event trading days, not days from `generatedAt`) with `earnings-direction` and `earnings-move` prediction kinds, resolved against the `earningsReturn` DSL. IV crush is deferred in v1; IV remains setup context or a gap only.

## Peer Universe

A deterministic, auditable set of comparable Instruments used for peer valuation context. It must come from a sourced provider, checked-in ticker mapping, or Research Subject Registry fallback with provenance, role, and rationale, not model selection. V1 runs only for `ticker --deep --asset equity`; unsupported tickers emit a visible valuation SourceGap. See [[ADR 0031]].
