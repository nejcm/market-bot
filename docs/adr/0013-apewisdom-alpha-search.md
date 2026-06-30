# ADR 0013: Equity alpha-search research leads

## Status

Accepted

## Date

2026-06-30

## Context

The project needs a discovery workflow distinct from synthesis reports and scored forecasts.

## Decision

- `alpha-search --asset equity [--deep]` is an equity-only deterministic discovery workflow.
- ApeWisdom aggregate social momentum and SEC current-filing discovery create candidates.
- Official listed-universe metadata filters eligibility; Yahoo validates listed-stock metadata and
  configured screening limits.
- Social ranking uses aggregate momentum features. Yahoo metadata validates candidates but does not
  alter the social score.
- Output contains Research Leads, rejected candidates, normalized candidate profiles, and
  provenance artifacts. It contains no predictions and triggers no immediate calibration pass.
- Later explicit or research-triggered score passes may update alpha validation, watchlist,
  attribution, and cohort artifacts.
- Alpha output follows ADR 0001 and must not contain expected-return, trade-action, sizing,
  execution, or portfolio language.

## Consequences

- Discovery state can be evaluated later without presenting candidates as recommendations.
- Mutable validation sidecars are historical research state, not promotion verdicts.

## Implementation validation

- `src/alpha-search/workflow.ts` owns discovery and validation orchestration.
- `src/alpha-search/validation.ts`, `candidate-state.ts`, `feature-attribution.ts`, and `cohorts.ts`
  own later evaluation artifacts.
