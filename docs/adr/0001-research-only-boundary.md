# ADR 0001: Research output boundary

## Status

Accepted

## Date

2026-06-30 (consolidated 2026-07-15)

## Context

The project produces market research artifacts and observable forecasts. Persisted artifacts must
not become trading instructions. The Research Console also has an ephemeral Run Chat whose current
implementation deliberately permits positioning and trade-oriented questions.

## Decision

- Persisted reports, alpha-search output, history narratives, and generated artifacts are
  research-only. They must not contain buy/sell/hold conclusions, position sizing, execution
  instructions, allocation changes, or portfolio actions.
- Predictions are probabilistic statements about public observable quantities, not
  recommendations. Their scored event is defined by the forecast DSL in ADR 0003.
- Report validation and research prompts enforce the persisted-output boundary.
- Run Chat is the sole current exception. It is not report-validated, is not persisted server-side,
  and may discuss positioning or trade ideas over run artifacts. Browser-local chat storage does
  not make chat a Run Artifact.
- The exception means the product as a whole is not uniformly “no trade-action surface.”
  Documentation must distinguish persisted research artifacts from ephemeral chat behavior.
- Provider and source integrations must never use account, order, portfolio, or execution
  endpoints.

## Consequences

- Persisted research remains auditable and separated from execution.
- Run Chat requires a separate safety and threat model; ephemerality is not equivalent to the
  persisted research-only policy.
- Expanding trade-oriented behavior beyond Run Chat requires a new ADR.

## Implementation validation

- `src/report/schema.ts` and research prompts reject trade-action language in reports.
- `src/history/artifacts.ts` validates narrative thesis deltas before persistence.
- `prompts/console-run-chat.md` implements the explicit chat exception.
