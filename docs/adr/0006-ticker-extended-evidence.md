# ADR 0006 — Ticker extended evidence

## Status

Accepted

## Context

Ticker briefs benefit from deeper instrument-specific evidence, but market updates should stay lightweight and the research-only boundary must not move. Market updates still need some market-level macro context, but that context is not tied to one Instrument.

## Decision

Add Extended Evidence only to ticker runs. V1 uses compact normalized signals from best-fit providers: SEC EDGAR for filings and company facts, Finnhub for equity events, FRED for macro series, Tradier for options IV, and Glassnode for on-chain metrics. Extended Evidence is stored under report extras and rendered in ticker markdown, while forecasts may add observable FRED and IV threshold shapes that remain scoreable.

Market updates use a separate lightweight Market Context concept for market-level FRED macro evidence. Market Context can enrich regime drivers and report citations, but it is not rendered as ticker Extended Evidence and does not change the deterministic regime label.

## Consequences

Missing optional providers become Source Gaps. Missing Market Context is disclosed but does not cap Evidence Quality. Region-specific equities remain out of V1; provider lookup determines coverage and unsupported coverage is disclosed.
