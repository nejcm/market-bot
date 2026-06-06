# Market Bot Context

## Glossary

## Research View

A sourced research artifact that summarizes evidence, uncertainty, scenarios, risks, and gaps without recommending trades or portfolio actions.

## Research Console App

A local research-only user interface for browsing run history, Research Views, Sources, Source Gaps, Evidence Quality, analytics, and provider health without changing the research-only boundary.

## Instrument

A tradable listed or quoted research target. In the current CLI it is still identified by `symbol + assetClass`, with optional exchange, quote currency, provider IDs, and aliases when known.

## Instrument Identity

Provider-normalized metadata that helps relate Source Provider records to an Instrument without changing the research-only boundary.

## Observation

A public market quantity value used to resolve a Prediction. An Observation can be point-in-time or part of a window. It is not advice, conviction, or a trade signal.

## Market Update

A daily or weekly research run for an asset class that summarizes market regime, liquid movers, themes, risks, and source gaps.

Weekly market updates are a cadence and horizon change in V1, not a separate trailing-window data product. Equity mover inputs still come from Yahoo `day_gainers`, `day_losers`, and `most_actives` (a single-day multi-screener set), and crypto mover inputs still use CoinGecko 24h change fields; reports must disclose this as a source gap.

## Historical Research Context

Artifact-backed context loaded or derived from prior `MARKET_BOT_DATA_DIR` run artifacts. In prompt use, it is a compact subset of prior findings, risks, catalysts, data gaps, scored predictions, extras, and selected normalized numeric snapshots; prior reports can appear as citeable `model` Sources. In user-facing history use, it can expose searchable and comparable historical views over prior reports, Sources, Predictions, Research Theses, open questions, and per-Instrument timelines. It is context for research wording, probability calibration, and historical comparison, not a new prediction-count or horizon policy.

## Research Thesis

The research-only narrative state of a Research View, assembled from sourced summary, key findings, bull and bear cases, risks, catalysts, data gaps, and observable Predictions. A Research Thesis is not an investment thesis, recommendation, trade signal, or portfolio action.

## Prior-Thesis Error Correction

A ticker-run prompt block that surfaces prior Predictions on the current Instrument that resolved as misses — each with run ID, claim, stated probability, observed resolution values, and a source citation — framed as explicit error-correction signal rather than a passive citation pool. It steers research wording and probability calibration; it is not a recommendation, trade signal, or portfolio action. It fires for ticker runs only.

## Market Update Delta

A compact, deterministic "what changed since the last same-cadence run" summary auto-promoted into a daily or weekly Market Update report, directly after the summary. It carries the regime label change (prior → current, naming flipped breadth/trend/VIX-term-structure drivers), the ranked Mover membership diff (symbols entered vs exited), and Predictions from prior same-asset-class Market Update runs that resolved since the baseline was generated. The baseline is the single most-recent prior run with the same asset class and cadence. It is computed with no model call and is descriptive only — distinct from the instrument-scoped, manual Research Thesis Delta (`history thesis-delta`), and never a trade signal or portfolio action.

## Historical Context Gap

A soft absence, parse failure, or mismatch in prior run artifacts. It is disclosed in historical context, but it is not a provider `SourceGap` and does not mean live source collection failed.

## Market Spotlight

An optional daily or weekly Market Update focus selected from the current collected market snapshot universe. Current market evidence is required; historical context and alpha-search artifacts can enrich selection, but cannot create a spotlight by themselves. Spotlights do not run nested ticker jobs, fetch extra sources, or auto-upgrade a run to `--deep`.

## Market Regime

The current market backdrop inferred from fetched evidence, such as broad direction, volatility, liquidity, and dominant themes.

## Market Context

Market-level evidence that enriches Market Updates without targeting one Instrument.

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

## Source

A fetched data or news item saved with an ID so report claims can link back to evidence.

## Source Provider

An external service that supplies market data, news, or reference data before it is normalized into Sources.

## Supplemental Source Provider

An optional Source Provider that contributes citeable evidence without driving deterministic mover selection, market regime labels, or scoring Observations unless explicitly promoted.

## Source Gap

A disclosed absence, weakness, failure, or staleness in Source Provider evidence that affects report reliability.

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
