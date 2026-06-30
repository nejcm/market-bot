# Architecture Decision Records

ADRs record accepted architecture and material implementation constraints. Canonical records
describe the current system; superseded records remain as link-preserving historical redirects.

## Canonical decisions

| ADR                                                             | Decision                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------- |
| [0001](./0001-research-only-boundary.md)                        | Research output boundary                                  |
| [0002](./0002-typescript-bun-orchestration.md)                  | Runtime, toolchain, configuration, and model providers    |
| [0004](./0004-predictions-as-observable-forecasts.md)           | Observable forecasts, scoring, and calibration            |
| [0006](./0006-ticker-extended-evidence.md)                      | Instrument evidence and deterministic analysis            |
| [0008](./0008-provider-normalized-instrument-identity.md)       | Instrument and research-subject identity                  |
| [0009](./0009-source-provider-modules.md)                       | Source-provider composition and resilience                |
| [0011](./0011-fixed-coverage-panel-for-deep-research.md)        | Model-stage pipeline and Domain Playbooks                 |
| [0013](./0013-apewisdom-alpha-search.md)                        | Equity alpha-search Research Leads                        |
| [0014](./0014-artifact-backed-history-and-market-spotlights.md) | Cross-run research context and correction                 |
| [0016](./0016-run-artifact-reader.md)                           | Canonical Run Artifacts and derived indexes               |
| [0025](./0025-market-overview-fold.md)                          | Market overview and horizon semantics                     |
| [0028](./0028-deterministic-source-plan-subsystem.md)           | Evidence governance, temporal integrity, and web evidence |
| [0029](./0029-console-run-chat.md)                              | Ephemeral Run Chat and optional live web search           |

## Conventions

- Use four-digit sequence numbers. Number 0026 is unused; do not renumber later records.
- Use `Accepted`, `Superseded`, or `Deprecated` status.
- Add a decision date.
- Amend a canonical ADR when behavior remains within its decision boundary.
- Add a new ADR only for a new boundary, authority, durable contract, or irreversible tradeoff.
- Never rewrite a superseded redirect into a second source of truth.
