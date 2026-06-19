# ADR 0012 — Model-requested Domain Playbooks

## Status

Accepted

## Context

The research pipeline needs run-specific guidance without making every stage prompt larger and without turning guidance into tools, plugins, source fetchers, or trading logic. Static RunConfig mapping would be simple but too coarse: it cannot react to source gaps, evidence categories, or the selected deep-stage topology. Plugin-style skills would be too broad for V1 because they imply executable or user-installed behavior outside the checked-in prompt surface.

## Decision

Add checked-in Domain Playbooks under `prompts/playbooks/`, with `prompts/playbooks/registry.json` defining ID, file, summary, and eligibility by command, asset class, depth, and stage.

Always-on discipline playbooks are injected deterministically for specific stages, independent of the selector:

- `synthesis-discipline` is injected into `final-synthesis` for market overview, legacy daily/weekly, ticker, and research runs.
- `source-discipline` is injected into `critique` for research runs.

These discipline playbooks still use the same registry eligibility, markdown shape, `## instruction` requirement, 2500-character cap, per-stage/per-run caps, and `domainPlaybooks` JSON field as selector-selected playbooks. If the selector also names an always-on discipline playbook for the same stage, it is deduped rather than double-injected.

After source collection and any Evidence Request Loop, run one `playbook-selection` quick-model stage. The selector receives only slim context: command, depth profile, planned stages, candidate metadata, market-regime label, evidence categories, and source-gap summaries. It may select at most two playbooks per stage and six per run.

Valid selections are loaded from markdown files with required `## instruction` and optional `## goal` sections, capped at 2500 characters per playbook, and injected into downstream prompt JSON as `domainPlaybooks`. Playbooks are not appended to the stage `instruction`.

Selector failures are trace-only. Malformed JSON, unknown IDs, invalid stages, duplicates, and cap overages are recorded in `trace.domainPlaybooks.rejected`; the research run continues with the valid subset plus deterministic discipline playbooks. The selector output is persisted in `stages.json`, and selector token/cost estimates count toward run totals.

After `final-synthesis`, a deterministic post-synthesis audit emits warning-only trace and analytics telemetry for unsupported numeric/technical claims and weak evidence posture omissions. It does not mutate the report, reject predictions, or fail the run.

## Consequences

- Guidance can vary per run while remaining checked in and reviewable.
- Prompt bloat is bounded by registry eligibility and per-stage/per-run caps.
- The system stays provider-neutral: no provider-native tool calling, plugin execution, or source fetching is added.
- Trace artifacts explain which playbooks were selected or rejected.
- The selector adds one quick-model call to every research run.
- Core discipline guidance is no longer optional when the selector returns no usable selections.
- Post-synthesis audit warnings give reviewers a deterministic quality signal without changing report contents.

## Rejected alternatives

- **Static RunConfig mapping** — rejected because fixed mapping cannot react to evidence categories, source gaps, or stage topology.
- **Plugin-style skills** — rejected because V1 needs checked-in guidance only, not executable or user-installed capabilities.
- **Appending playbooks to instruction text** — rejected because a separate JSON field is easier to audit and test.
- **Treating selector failures as data gaps** — rejected because playbook selection affects prompt guidance, not fetched evidence coverage.
