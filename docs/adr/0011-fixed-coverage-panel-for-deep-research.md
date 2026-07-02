# ADR 0011: Model-stage pipeline and domain playbooks

## Status

Accepted

## Date

2026-06-30 (amended 2026-07-03: deterministic Report Integrity Audit and grading)

## Context

Research quality depends on a predictable stage graph, bounded context, and reviewable domain
guidance rather than provider-native agents.

## Decision

- Brief runs execute specialist analysis, critique, and final synthesis.
- Deep runs add a fixed two-role Coverage Panel after specialist analysis and before critique.
  Market overviews use regime and mover-theme roles; instrument runs use instrument-evidence and
  market-behavior roles. The two roles run concurrently and are persisted in deterministic order.
- A quick-model playbook-selection stage chooses checked-in Domain Playbooks from an allowlisted
  registry with stage/run caps. Invalid selections are trace-only rejections.
- Always-on discipline playbooks are injected deterministically for synthesis and research
  critique where configured.
- Model stages receive normalized evidence and prior stage output, never authority to widen tools,
  source scope, prediction subjects, or persistence behavior.
- Final synthesis produces the candidate report. Deterministic assembly and validation remain the
  authority over report shape, prediction acceptance, Evidence Quality, and research-only language.
- The post-synthesis audit records unsupported numeric/technical claims and evidence-posture
  omissions as warning telemetry. It does not remove claims, lower Evidence Quality, or fail a
  run.
- After schema-valid synthesis and before forecast disagreement, the deterministic Report
  Integrity Audit prunes blocking violations: numeric or technical findings, scenarios, and
  predictions without an eligible supporting source (structural eligibility only — no
  semantic-entailment claims; bare years and forecast-horizon wording do not count as numeric
  claims, and cited historical forecast outcomes are exempt). Uncited numeric summary sentences
  (the summary has no citation field) and missing evidence-posture labels remain advisory
  telemetry and are never pruned.
- Every new report is stamped with `reportIntegrity` (`high` with no pruning; `medium` when
  pruning occurred but required analytical sections remain; `low` when pruning empties a
  previously populated required section) and `researchQuality` (the worse of Evidence Quality and
  Report Integrity). Both fields are optional at tolerant read boundaries for historical reports.
  Pruned-item and advisory-warning counts persist in trace and analytics, and pruned predictions
  never reach forecast disagreement, persistence, or scoring. Deterministically assembled
  alpha-search reports stamp `reportIntegrity: high` without a pruning pass.
- A model repair call and summary-sentence pruning are explicitly deferred (plans/03) until real
  runs show deterministic pruning fires often enough to justify a repair pass.

## Consequences

- Deep runs pay additional latency and token cost for broader analysis.
- Prompt behavior is reviewable independently of provider APIs.
- Warning-only post-synthesis findings must not be represented as enforced factual correctness.
- Deterministic pruning can leave sections empty; grading discloses that rather than padding
  reports with unsupported claims.

## Implementation validation

- `src/research/orchestrator.ts` defines the stage graph.
- `src/research/playbooks.ts` validates and loads playbooks.
- `src/research/final-synthesis.ts` and `report-assembly.ts` separate generation from authority.
- `src/research/post-synthesis-audit.ts` implements current warning-only behavior.
- `src/research/report-integrity-audit.ts` implements deterministic pruning and grading.

## Supersedes

- ADR 0012
