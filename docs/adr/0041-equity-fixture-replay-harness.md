# ADR 0041: Fixture replay harness for equity runs

## Status

Accepted

## Date

2026-07-01

## Context

Equity pipeline changes need fast regression coverage that exercises collection, normalization,
source planning, orchestration, report assembly, and validation without live provider cost or
network nondeterminism. Existing orchestration tests can inject `CollectedSources`, but that skips
collector and cache behavior.

## Decision

- The primary static run harness mocks only two external boundaries: HTTP `fetch` and
  `ModelProvider.generate`.
- Data cassettes replay HTTP responses below the source cache, so cache keying, cache writes,
  normalization, source gaps, and source-plan assembly still run.
- LLM cassettes replay ordered model responses keyed by `stage|model`. The key intentionally omits
  prompt hashes so source-plan or prompt-context churn does not force paid re-recording for every
  internal change.
- Regression mode uses both data and LLM replay and is suitable for CI.
- Eval mode replays data but uses the live configured `ModelProvider`, so prompt, playbook, and
  model-stage changes can be reviewed without refetching market data.
- `CollectedSources` injection remains useful for narrow unit tests, but it is not the primary
  pipeline fixture tier because it bypasses collection internals.
- Fixture recording is a dev-only command that captures both seams, stores canonicalized requests,
  drops sensitive request headers, and fails if known token values appear in written fixture files.

## Consequences

- Static fixtures cover more of the equity pipeline than orchestration-only tests.
- Golden output changes are intentional review points; legitimate behavioral changes require
  refreshing the fixture output.
- LLM replay is lenient. If a loop asks for one extra response, the cassette can replay a terminal
  fallback rather than turning a small loop drift into a hard failure.
- Cassettes must be refreshed when adapter request shapes or parser-required payload fields change.
- Eval mode can incur model cost and should remain an explicit local command.

## Implementation validation

- `tests/support/run-fixtures/` implements data and LLM cassettes plus isolated fixture runs.
- `scripts/record-fixture-run.ts` records live fixture cassettes.
- `scripts/replay-fixture-run.ts` replays a fixture with replayed or live LLM output.
- `tests/equity-fixture-run.test.ts` runs brief and deep AAPL fixtures through the real pipeline.
