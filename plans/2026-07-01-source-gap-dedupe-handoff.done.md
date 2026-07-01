# Source Gap Dedupe Handoff

## Purpose

Fresh-agent handoff for implementing the approved Source Gap telemetry dedupe plan.

## Suggested Skills

- `implement-plan`: Use to carry out the approved implementation plan below.
- `coding-principles`: Use to keep the change narrow and testable.
- `code-quality`: Use before completion; this repo expects `bun run check`.

## Current State

- Repo: `C:\Work\Personal\market-bot`
- Original review handoff: `plans/2026-07-01-aapl-run-review-handoff.md`
- Relevant finding: item 2, "SEC source-gap duplication inflates gap telemetry".
- No implementation changes were made in the interrupted implementation turn.
- The plan below was approved by the user, then refined after adversarial review.
- Refinement outcome: keep the boundary-dedupe approach, but make research-path scope, intentional count changes, historical comparability, first-wins metadata, and test coverage explicit.

## Approved Plan

# Deduplicate Canonical Source Gap Telemetry

## Summary

- Fix item 2 for research jobs by making canonical run Source Gap telemetry unique by normalized disclosed text: `source: message`.
- Apply exact dedupe only; keep overlapping but non-identical gaps like `grossProfit` and `grossProfit, capex`.
- Affect future runs only. Do not rewrite or reinterpret historical run artifacts.
- Scope is the research job path (`src/research/orchestrator.ts`). Alpha-search is out of scope and keeps its existing `compactUnmappedSecFilingGaps()` convention.

## Key Changes

- Add a small normalization helper that uses existing `dedupeSourceGaps()` on:
  - top-level `collectedSources.sourceGaps`
  - nested `extendedEvidence.gaps`
  - nested `marketContext.gaps`, if present
- Call the helper at the final collected-source boundary in orchestration after evidence/web phases and before source planning, analytics, report assembly, and artifact writing.
- Keep field names stable: no raw emission count, no new analytics fields, no migration. Counts and persisted arrays intentionally change for future research runs.
- Use existing first-wins metadata behavior from `dedupeSourceGaps()`: if duplicate `source: message` entries differ in metadata, the first occurrence survives. Do not add worst-case metadata merging in this fix.
- Add a short code comment at the final normalization point so later phases do not append gaps after canonicalization without noticing the boundary.
- Update `CONTEXT.md` under `Source Gap` to state canonical persisted research-run telemetry deduplicates identical normalized disclosed gap text prospectively, and that pre-change run comparisons may include duplicate-counting artifacts.

## Tests

- Unit test exact dedupe keeps first occurrence and removes identical normalized duplicates.
- Unit test the normalization helper dedupes top-level `sourceGaps`, nested `extendedEvidence.gaps`, and nested `marketContext.gaps`.
- Regression test a research collected-source bundle with duplicate `sec-edgar: Missing SEC company facts: grossProfit` produces:
  - one top-level source gap
  - one regulatory-filings lane gap text
  - analytics source-gap totals/bySource based on deduped gaps
  - deduped `extendedEvidence.gaps`
- Confirm analytics value changes intentionally include source-gap totals, evidence-lane `gapCount`, trace `evidenceLanes.gapCount`, and extended-evidence gap counts.
- Confirm overlapping SEC messages are preserved as distinct.

## Assumptions

- "Canonical telemetry" means future normalized artifacts, evidence lanes, and analytics, not old run files.
- Exact text identity is the only dedupe key; no provider-specific merging or subset logic.
- Alpha-search remains out of scope because the reviewed AAPL finding is in the research path and alpha-search already has SEC-specific source-gap compaction.
- Historical cross-run comparisons spanning this change date/code version need a breakpoint note; do not treat count drops alone as evidence of improved provider coverage.
- No ADR is needed because this is a small reversible telemetry convention; glossary update is enough.

## Adversarial Review Disposition

- Accepted: alpha-search scope must be explicit.
- Accepted: `dedupeSourceGaps()` is first-wins by normalized report text; document this instead of silently relying on it.
- Accepted: schemas stay stable but gap counts and persisted gap arrays intentionally change.
- Accepted: add a prospective-counting note to `CONTEXT.md` to avoid misleading cross-run trend analysis.
- Partially accepted: add tests around current downstream surfaces and the normalization helper. Do not invent a fake post-normalization phase just to test a nonexistent path.
- Rejected for this fix: worst-case metadata merge and origin-level SEC fact dedupe. Both are larger semantic changes than the approved low-effort telemetry correction.

## Whole Q&A

1. Question: For item 2, what should count as one Source Gap in canonical persisted telemetry?
   Answer: Unique disclosure. Deduplicate identical normalized `source: message` gaps before normalized artifacts, evidence lanes, and analytics.

2. Question: Where should the dedupe happen?
   Answer: Collection boundary. Normalize `collectedSources.sourceGaps` once before downstream source plan, analytics, report, and artifact writing consume it.

3. Question: Should overlapping missing-fact messages be merged, or only exact duplicate disclosure text removed?
   Answer: Exact only. Remove only identical normalized `source: message` duplicates; keep `grossProfit` and `grossProfit, capex` as distinct disclosures.

4. Question: How should we capture this docs-wise?
   Answer: `CONTEXT.md` only. Update `Source Gap` glossary to state canonical telemetry dedupes identical disclosed gap text.

5. Question: Should existing run artifacts be normalized by readers, or should this fix affect only newly generated runs?
   Answer: Future runs only. Do not rewrite or reinterpret historical artifacts; the fix applies when new `CollectedSources` are built.

6. Question: Should the implementation add a separate raw duplicate/emission count anywhere?
   Answer: No raw count. Keep schemas stable and simply ensure canonical source-gap telemetry is deduped.

7. Question: Should nested `extendedEvidence.gaps` also be deduped by unique disclosure text?
   Answer: Yes, same rule. Keep all source-gap-bearing run artifacts and analytics aligned on unique disclosed gaps.

## Exploration Notes

- `src/domain/source-gaps.ts` already has `dedupeSourceGaps()` keyed by normalized `sourceGapReportText()`.
- `src/research/research-context.ts` already dedupes prompt/report data gaps.
- `src/research/orchestrator.ts` currently writes `result.collectedSources.sourceGaps` directly to `normalized/source-gaps.json`.
- `src/research/source-plan.ts` currently builds lane `gapText` from raw `collectedSources.sourceGaps`.
- `src/research/run-analytics.ts` currently counts raw `collectedSources.sourceGaps` and raw `extendedEvidence.gaps`.
- Later phases can append gaps after initial source collection:
  - `src/research/evidence-request-loop.ts`
  - `src/research/web-gather-loop.ts`
  - `src/research/web-evidence-phase.ts`
  - `src/research/web-subject-profile-reuse.ts`
- The final normalization point should be after evidence/web phases and before `buildSourcePlan()`.

## Verification Expected

- Run targeted tests after edits.
- Run full quality check at natural completion:

```sh
bun run check
```
