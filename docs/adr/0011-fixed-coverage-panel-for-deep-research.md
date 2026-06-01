# ADR 0011 — Fixed Coverage Panel for deep research

## Status

Accepted

## Context

Deep research needs broader coverage than the fixed `specialist-analysis` -> `critique` -> `final-synthesis` chain provides. The project still needs provider-neutral model calls, research-only outputs, supplied-source citations, and stable report artifacts.

## Decision

Deep runs use a fixed Coverage Panel after `specialist-analysis` and before `critique`. Market updates run `regime-context-analysis` and `mover-theme-analysis`; ticker runs run `instrument-evidence-analysis` and `market-behavior-analysis`.

The panel uses normal prompt stages with JSON-only non-final outputs, the quick model, and existing model params. Each role sees only the specialist output as prior stage context. `critique` receives the specialist plus both role outputs, and `final-synthesis` receives all analyses plus critique.

The panel does not use provider-native agent or tool APIs, does not fetch additional sources, and does not add report schema fields. Its public artifact surface is the existing `trace.stages` list and persisted `stages.json`.

## Consequences

- Brief runs keep the lower-cost three-stage flow.
- Deep runs spend two additional model calls for broader coverage.
- Stage output order is deterministic even though the two role calls can run concurrently.
- Failed role stages abort the run like other model-stage failures.

## Rejected alternatives

- **Configurable roles** — rejected for V1 because custom role topology would add config and testing surface before the fixed panel is validated.
- **Replacing `specialist-analysis`** — rejected because the existing specialist remains the stable anchor for current prompts and tests.
- **Sequential debate rounds** — rejected because the goal is broader coverage, not multi-round rebuttal, and sequential rounds would add latency while reducing role independence.
