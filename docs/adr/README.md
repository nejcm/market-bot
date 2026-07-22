# Architecture Decision Records

ADRs record accepted architecture and material implementation constraints.

## Canonical decisions

| ADR                                                                    | Decision                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| [0001](./0001-research-only-boundary.md)                               | Research output boundary                                  |
| [0002](./0002-typescript-bun-orchestration.md)                         | Platform, configuration, persistence, and validation      |
| [0003](./0003-forecasts-scoring-calibration-cross-run-intelligence.md) | Forecasts, scoring, calibration, and cross-run context    |
| [0004](./0004-evidence-identity-providers-deterministic-analysis.md)   | Evidence, identity, providers, and deterministic analysis |
| [0005](./0005-research-workflows-model-stage-pipeline.md)              | Research workflows, model stages, and table mapping       |

## Conventions

- Use four-digit sequential numbers.
- Use `Accepted` or `Deprecated` status.
- Add a decision date.
- Amend a canonical ADR when behavior remains within its decision boundary.
- Add a new ADR only for a new boundary, authority, durable contract, or irreversible tradeoff.
