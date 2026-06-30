# ADR 0011: Model-stage pipeline and domain playbooks

## Status

Accepted

## Date

2026-06-30

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
  omissions as warning telemetry. It currently does not remove claims, lower Evidence Quality, or
  fail a run.

## Consequences

- Deep runs pay additional latency and token cost for broader analysis.
- Prompt behavior is reviewable independently of provider APIs.
- Warning-only post-synthesis findings must not be represented as enforced factual correctness.

## Implementation validation

- `src/research/orchestrator.ts` defines the stage graph.
- `src/research/playbooks.ts` validates and loads playbooks.
- `src/research/final-synthesis.ts` and `report-assembly.ts` separate generation from authority.
- `src/research/post-synthesis-audit.ts` implements current warning-only behavior.

## Supersedes

- ADR 0012
