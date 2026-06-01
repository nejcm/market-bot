# Model-Requested Domain Playbooks

## Summary

Add a Vibe-Trading-inspired **Domain Playbook** system: one quick-model selector call chooses checked-in research guidance snippets after source collection and the Evidence Request Loop. Selected playbooks are injected into downstream prompt JSON as structured `domainPlaybooks`, bounded by registry eligibility and caps.

## Key Changes

- Add `prompts/playbooks/registry.json` plus markdown playbooks, with initial IDs for:
  - market regime
  - mover themes
  - instrument evidence
  - market behavior
  - critique discipline
  - synthesis discipline
- Add `prompts/playbook-selection/base.md` and a new persisted stage label `playbook-selection`.
- Add `src/research/playbooks.ts` for:
  - registry validation from JSON
  - command/stage/depth/asset eligibility filtering
  - selector output parsing
  - invalid ID/cap rejection
  - markdown loading with `## instruction` and optional `## goal`
  - max 2,500 chars per playbook
- Selector behavior:
  - runs once per research run, after Evidence Request Loop
  - uses quick model
  - receives slim context only: command, depth profile, planned stages, candidate metadata, market regime label, evidence categories, and source-gap summaries
  - may select max 2 playbooks per stage and 6 per run
  - invalid JSON/IDs/over-cap choices are traced and ignored; run continues
- Downstream prompt shape:
  - add `domainPlaybooks` as a separate JSON field, not appended to `instruction`
  - eligible stages: specialist, coverage panel, critique, final synthesis
  - exclude `evidence-request`

## Public Interfaces / Docs

- Extend `RunTrace` with playbook selection audit metadata:
  - selected stage/playbook IDs
  - short selector rationale, length-capped
  - rejected choices and reasons
- Include selector token/cost in run totals and persist selector output in `stages.json`.
- Add `Domain Playbook` to `CONTEXT.md` as a glossary term.
- Add a new ADR documenting model-requested checked-in playbooks versus static RunConfig mapping and plugin-style skills.
- Update `docs/architecture.md` and `docs/how-it-works.md`.
- Remove the implemented backlog item from `docs/IMPROVEMENTS.md`.
- No new env vars; playbooks are always on.

## Test Plan

- Unit-test registry validation, eligibility filtering, file loading, malformed markdown, missing selected files, char cap, per-stage cap, and per-run cap.
- Unit-test selector output parsing for valid selections, unknown IDs, malformed JSON, duplicate IDs, invalid stages, and rationale length capping.
- Orchestrator tests:
  - selector runs after Evidence Request Loop
  - selector is persisted as `playbook-selection`
  - selected playbooks appear in downstream `domainPlaybooks`
  - invalid selector output continues with trace-only failures
  - token/cost totals include selector call
- Prompt-loader/playbook tests load all real prompt and playbook files.
- Run `bun run check`.

## Assumptions

- "Cost optimization" means future prompt-bloat control, not immediate net token reduction; current base prompts are already tiny.
- Domain Playbooks are research-only guidance, not tools, source fetchers, trading skills, portfolio logic, or dynamic generated files.
- Selector failures are trace-only and never become report `dataGaps` or `SourceGap`s.
