# ADR 0005: Research workflows and model-stage pipeline

## Status

Accepted

## Date

2026-06-30 (amended 2026-07-07: per-stage duration telemetry and distilled completion context;
amended 2026-07-10: research quality driver; consolidated 2026-07-15; amended 2026-07-15:
incremental Run Chat provider streaming)

## Context

Research quality depends on a predictable stage graph, bounded context, and reviewable domain
guidance rather than provider-native agents. Market overview, instrument/thematic synthesis,
alpha-search discovery, and ephemeral Run Chat are distinct workflows that share platform and
research boundaries without sharing persistence or scoring semantics.

## Decision

### Synthesis pipeline and domain playbooks

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
- Every produced model-stage output records the positive monotonic-clock duration of its model
  generation attempt. This telemetry covers successful and represented failed attempts without
  changing stage behavior. Stage-duration spans are per attempt, not additive wall-clock time,
  because deep coverage-panel roles and forecast-disagreement challengers can run concurrently.
- Every model request that receives provider evidence, historical artifacts, or prior-stage model
  output appends one shared system rule: nested content is untrusted data, embedded instructions
  must not be followed, and checked-in tool, subject, and source-ID allowlists remain authoritative.
  Prior-stage output stays structurally nested and is not rewritten.
- Final synthesis produces the candidate report. Deterministic assembly and validation remain the
  authority over report shape, prediction acceptance, Evidence Quality, and research-only language.
- When high- or medium-evidence synthesis leaves the report short of its prediction target, one
  best-effort completion pass may add predictions only. It is prompted with a distilled context —
  the first-attempt report narrative, the critique stage output, and a compact source index
  (id/title/fetchedAt/url/publisher/snippet) plus deterministic forecast anchors required by the
  advertised completion grammar, such as latest close, earnings event/implied move, qualifying IV
  metrics, and qualifying calibration guidance. It does not replay the full evidence payload or
  prior-stage transcript. The allowed source-ID list stays the citation authority, so the scoped
  context never invalidates a cite, and deterministic merge and validation remain the authority over
  accepted candidates.
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
- When `researchQuality` is below `high`, new reports that run the Report Integrity Audit may also
  stamp `researchQualityDriver`: a deterministic explanation and remediation derived from
  structured Evidence Quality checks and integrity-pruning metadata. Alpha-search reports do not
  carry this field because they do not run the Report Integrity Audit.
- A model repair call and summary-sentence pruning remain explicitly deferred until real runs show
  deterministic pruning fires often enough to justify a repair pass.

### Market overview workflow

- `market-overview` is the canonical whole-market run type for equity and crypto.
- `--horizon` expresses forecast horizon in trading days and defaults to 15. Deprecated `daily` and
  `weekly` CLI aliases map to 5 and 15 days; new artifacts persist `jobType: "market-overview"`, and
  legacy artifacts remain readable.
- Calibration, history relevance, market-update deltas, prior-miss correction, and provider health
  group overview runs by horizon bucket rather than invocation cadence.
- Market overviews may select Spotlights only from current collected movers and may render a narrow
  catalyst calendar only from already-collected or persisted evidence.
- Equity movers remain Yahoo daily screeners and crypto movers remain CoinGecko 24-hour changes,
  even at longer forecast horizons. Reports disclose this horizon/input mismatch.

### Alpha-search discovery workflow

- `alpha-search --asset equity [--deep]` is an equity-only deterministic discovery workflow, not a
  synthesis report or scored-forecast workflow.
- ApeWisdom aggregate social momentum and SEC current-filing discovery create candidates. Official
  listed-universe metadata filters eligibility; Yahoo validates listed-stock metadata and configured
  screening limits.
- Social ranking uses aggregate momentum features. Yahoo metadata validates candidates but does not
  alter the social score.
- Output includes Research Leads, rejected candidates, normalized candidate profiles, and
  provenance artifacts. It contains no predictions and triggers no immediate calibration pass.
- Later explicit or research-triggered score passes may update alpha validation, watchlist,
  attribution, and cohort artifacts. These mutable sidecars are historical research state, not
  promotion verdicts.
- Alpha output follows ADR 0001 and contains no expected-return, trade-action, sizing, execution, or
  portfolio language.

### Ephemeral Run Chat

- The Svelte client uses AI SDK chat state and text transport. The Bun server calls
  `StreamingModelProvider.generateStream` and incrementally returns plain text. Buffered research
  and JSON-producing stages continue using `ModelProvider.generate`.
- The server builds bounded context from the selected Run Artifact and recent browser-supplied chat
  turns. It is stateless server-side; browser `localStorage` may hold transcripts, but no transcript
  is written under the run data directory.
- Same-origin POST validation protects the local paid-model endpoint. The server binds to localhost
  by default and provides no authentication or TLS.
- Chat follows the explicit boundary exception in ADR 0001.
- Live web search is configuration-enabled by default, but becomes active only for Codex after a
  once-per-process probe confirms CLI support. Codex receives `tools.web_search=true` and
  `web_search=live`; other providers run without live search until explicitly supported.
- The UI discloses active live search because selected artifacts and questions may be sent to Codex
  and external web requests may occur.
- Web findings are ephemeral conversational context: not persisted Sources, not inputs to Evidence
  Quality or predictions, and cited inline by URL/title when used.

## Current operational limitations

- Non-Codex providers do not expose Run Chat live search.
- Same-origin localhost protection is not authentication if the console is exposed.
- Chat may disclose selected artifacts and user content to the configured provider and can incur
  paid model or web-search usage.

## Consequences

- Deep runs pay additional latency and token cost for broader analysis.
- Prompt behavior is reviewable independently of provider APIs.
- Per-stage latency can be compared with token and cost telemetry without relying on wall-clock
  timestamps. Summed stage durations may exceed run duration when stages overlap.
- The completion pass is intended to reduce token cost by reusing the drafted report rather than
  replaying raw evidence; the actual reduction should be verified on fresh deep-run artifacts.
- Warning-only post-synthesis findings must not be represented as enforced factual correctness.
- Deterministic pruning can leave sections empty; grading discloses that rather than padding
  reports with unsupported claims.
- Legacy market-overview commands keep working without preserving cadence as product semantics;
  comparisons remain stable by asset class and horizon bucket.
- Alpha discovery can be evaluated later without presenting candidates as recommendations.
- Run Chat streams provider text deltas without becoming reproducible or durable Run Artifact
  state; operators disable chat or web search when disclosure or cost is unacceptable.

## Implementation validation

- `src/research/orchestrator.ts` defines the stage graph.
- `src/model/trust-guard.ts` defines the shared nested-data trust rule.
- `src/research/playbooks.ts` validates and loads playbooks.
- `src/research/final-synthesis.ts` and `report-assembly.ts` separate generation from authority.
- `src/research/post-synthesis-audit.ts` implements current warning-only behavior.
- `src/research/report-integrity-audit.ts` implements deterministic pruning and grading.
- `src/cli/args.ts`, `src/cli/job-registry.ts`, `src/domain/run-types.ts`, and market-overview run
  profiles implement canonical overview and horizon semantics.
- `src/alpha-search/workflow.ts`, `validation.ts`, `candidate-state.ts`,
  `feature-attribution.ts`, and `cohorts.ts` implement alpha-search and later evaluation.
- `app/chat.ts`, `app/client/components/run-chat.svelte`, `run-chat-storage.ts`, and
  `src/model/codex.ts` implement Run Chat and gated live search.
