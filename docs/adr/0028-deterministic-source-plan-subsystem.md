# ADR 0028: Deterministic Source Plan Subsystem

## Status

Accepted

## Context

Run artifacts already persist fetched Sources, Source Gaps, normalized snapshots, analytics, and
trace. That shows what evidence arrived, but it does not record the deterministic evidence lanes
the run intended to cover before synthesis.

The original lane proposal included aspirational lanes. V1 must not persist empty abstractions or
pretend a lane was covered without backing Sources. The source-plan lane set therefore has to come
from provider paths that exist today in `src/sources/providers.ts` and the collector.

## Decision

Add a deterministic, no-model source-planning layer after source collection and before artifact
persistence. It records:

- `normalized/source-plan.json`: applicable lanes, required/optional status, and the real provider
  path for each lane.
- `normalized/evidence-lanes.json`: lane coverage, covered source IDs, gap IDs/text, freshness
  notes, and summary counts.
- `normalized/source-ledger.json`: per-source lane assignment, provider, fetched/observed time, and
  related lane gap IDs.

V1 lanes are limited to current provider paths:

- `market-data`: Yahoo equity market data or CoinGecko crypto market data.
- `supplemental-market`: Massive equity supplemental snapshots.
- `news`: MarketAux, Finnhub, Yahoo Finance, or Massive news.
- `macro-context`: Market Context backed by FRED on market-overview runs.
- `verified-snapshot`: Yahoo verified chart on equity ticker runs.
- `sec-edgar`: SEC EDGAR extended evidence on equity ticker runs.
- `equity-events`: Finnhub events extended evidence on equity ticker runs.
- `extended-fred-macro`: FRED macro extended evidence on ticker runs.
- `options-iv`: Tradier IV extended evidence on equity ticker runs.
- `on-chain`: Glassnode extended evidence on crypto ticker runs.
- `valuation`: deterministic valuation evidence derived from Yahoo market cap and SEC
  fundamentals on equity ticker runs.

Only `market-data` and equity ticker `verified-snapshot` are required in V1. Optional lanes can be
not covered without making the run invalid. A lane is marked covered only when it has at least one
backing source ID. Missing required coverage is represented as a lane gap, never as covered.

The subsystem adds no provider calls, no model calls, no report schema fields, and no scored
Prediction behavior. Analytics and trace carry compact additive summaries while full detail stays in
normalized sidecars. `RunAnalytics.version` remains `1` because the fields are optional additions.

## Consequences

Source coverage becomes auditable without changing the research-only boundary. Provider gaps can be
distinguished from unplanned lanes, and downstream readers can compare intended coverage to actual
evidence.

The sidecars are a new artifact contract surface. Readers remain lenient for legacy runs where the
files are absent.

## Rejected alternatives

- A fixed ten-lane enum with lanes lacking V1 provider paths. Rejected as speculative.
- Filling uncovered lanes by adding providers in the same change. Rejected because provider work is
  separate contract and configuration surface.
- Adding report fields. Rejected because the need is artifact and analytics auditability, not public
  report schema expansion.
