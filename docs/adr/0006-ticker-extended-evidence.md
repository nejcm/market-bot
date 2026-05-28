# ADR 0006 — Ticker extended evidence

## Status

Accepted

## Context

Ticker briefs benefit from deeper instrument-specific evidence, but market updates should stay lightweight and the research-only boundary must not move.

## Decision

Add Extended Evidence only to ticker runs. V1 uses compact normalized signals from best-fit providers: SEC EDGAR for filings and company facts, Finnhub for equity events, FRED for macro series, Tradier for options IV, and Glassnode for on-chain metrics. Extended Evidence is stored under report extras and rendered in ticker markdown, while forecasts may add observable FRED and IV threshold shapes that remain scoreable.

## Consequences

Missing optional providers become Source Gaps. Region-specific equities remain out of V1; provider lookup determines coverage and unsupported coverage is disclosed.
