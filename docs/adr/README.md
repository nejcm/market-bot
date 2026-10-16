# Architecture Decision Records

ADRs contain accepted decisions, binding constraints, and consequences maintainers must preserve.

## Canonical decisions

| ADR                                                 | Decision                           |
| --------------------------------------------------- | ---------------------------------- |
| [0001](./0001-research-only-boundary.md)            | Research-only boundary             |
| [0002](./0002-platform-and-persistence.md)          | Platform and persistence           |
| [0003](./0003-forecasts-scoring-and-calibration.md) | Forecasts, scoring and calibration |
| [0004](./0004-evidence-and-model-stage-pipeline.md) | Evidence and model-stage pipeline  |
| [0005](./0005-testing-and-replay.md)                | Testing and replay                 |

## Conventions

- Use contiguous four-digit numbers and `Accepted` or `Deprecated` status.
- Keep each record concise: Status, short Context, Decision bullets, Consequences bullets.
- Amend a canonical ADR when behavior remains within its decision boundary.
- Add a new ADR only for a new boundary, authority, durable contract, or irreversible tradeoff.
- Implementation maps and operational details belong in the linked code and other documentation.
