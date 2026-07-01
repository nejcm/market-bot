# Web Profile Reuse Analytics Handoff

## Purpose

Continue implementation of the revised plan to fix AAPL run-review finding 3 from
`plans/2026-07-01-aapl-run-review-handoff.md`: reused Web Subject Profile sources must not
look like current-run web coverage in `analytics.json:webSources`.

This handoff supersedes the earlier nested-origin plan after validating adversarial feedback
against the current code paths.

No implementation changes were completed before this handoff.

## Suggested Skills

- `coding-principles`: Use for the focused implementation.
- `code-quality`: Use before completion; repo requires `bun run check`.
- `run-review`: Use if re-checking the original AAPL run artifacts or updating reviewer-facing
  wording about web coverage telemetry.

## Revised Plan

# Plan: Fix Web Profile Reuse Analytics

## Summary

Fix finding 3 from `plans/2026-07-01-aapl-run-review-handoff.md`: reused Web Subject Profile sources must not look like current-run web coverage. Use the canonical term `current-run` for sources gathered during the run; avoid `fresh` because it conflicts with cache/profile freshness language.

The implementation should be leaner than the original plan:

- Keep `analytics.json:webSources` as the existing flat block, but define it as current-run web coverage only.
- Add an optional `analytics.json:reusedProfileWebSources` sibling only when a Web Subject Profile was actually reused.
- Track reuse with one non-persisted marker on `CollectedSources`, set only by the reuse path.

## Key Changes

- Keep `analytics.json:webSources` shape unchanged:
  - `accepted`
  - `profileUsed`
  - `reportCited`
  - `unused`
  - `usageRatio`
  - `usageWarning?`
- Redefine `analytics.json:webSources` as current-run web coverage. In reuse-only runs it should be omitted or have `accepted = 0`; prefer omitting when no current-run web sources are accepted, matching current no-web behavior.
- Add `analytics.json:reusedProfileWebSources?` only for reused profiles. Keep it lean:
  - `accepted`: reused profile web Sources present in the current report's `sources`.
  - `reportCited`: reused profile web Sources cited directly by report sections or predictions.
  - `generatedAt`: reused Web Subject Profile timestamp.
  - `ageDays`: age at report generation time.
  - `runDirName`: prior run that supplied the reusable profile.
- Count `usageWarning` only on `webSources` current-run coverage. Reuse-only runs should not warn; profile reuse is already disclosed through the existing `web-subject-profile` Source Gap.
- Add one non-persisted reuse marker to `CollectedSources`, for example:
  - `webSubjectProfileReuse?: { runDirName: string; generatedAt: string }`
- Set that marker only in `attachReusableWebSubjectProfile`, alongside attaching the reused profile and reused Sources.
- Do not modify `web-gather-loop.ts` for origin tracking. Current-run source IDs are derived as `accepted web source IDs - reused profile source IDs`.
- In `run-analytics`, classify reused source IDs only when the reuse marker is present:
  - `reusedProfileIds = marker present ? webSubjectProfile.sourceIds ∩ acceptedWebIds : empty`
  - `currentRunIds = acceptedWebIds - reusedProfileIds`
  - Absence of marker means all accepted web Sources are current-run, even if `webSubjectProfile` exists.
- Keep reused web Sources in the current report's `sources` list so citation validation and report assembly stay unchanged.

## Docs

- Update `CONTEXT.md` `Web Source Roles` to define `current-run` coverage and `reused-profile` coverage.
- Update `docs/architecture.md`, `docs/how-it-works.md`, and ADR 0028 wording to describe current-run web-source role telemetry plus the optional reused-profile web-source telemetry block.
- Check `.agents/skills/run-review` and `.codex/skills/run-review` for wording that assumes `webSources.accepted` means all usable web coverage. Current search found no direct `webSources` references, but verify during implementation.
- Do not create a new ADR; this is a telemetry refinement inside ADR 0028’s existing evidence-governance boundary.
- ADR convention check: `docs/adr/README.md` says to amend a canonical ADR when behavior remains within its decision boundary, so editing ADR 0028 is acceptable here.

## Test Plan

- Update `tests/run-analytics.test.ts` for the refined contract.
- Add a reuse-only analytics test:
  - `analytics.webSources` is absent or has `accepted = 0`.
  - `analytics.reusedProfileWebSources.accepted > 0`.
  - `analytics.reusedProfileWebSources.reportCited` counts direct report citations.
  - No current-run `usageWarning`.
- Add an explicit current-run profile test where `webSubjectProfile` is present but `webSubjectProfileReuse` is absent:
  - `analytics.webSources.accepted > 0`.
  - `analytics.reusedProfileWebSources` is absent.
  - This prevents misclassifying current-run Web Subject Profiles as reused profiles.
- Add or update web-subject-profile reuse tests to assert `CollectedSources.webSubjectProfileReuse` is set only by `attachReusableWebSubjectProfile` and carries `runDirName`/`generatedAt`.
- Keep current-run gather analytics coverage: existing flat `webSources` counts should remain correct when no profile reuse occurs.
- Run `bun run check`.

## Assumptions

- `analytics.json` is an internal artifact contract; adding `reusedProfileWebSources` is acceptable with tests/docs updated.
- Report citations and profile reuse behavior stay unchanged; only analytics attribution changes.
- Reused web Sources remain in the current report’s `sources` list so existing citation validation continues to pass.
- Current control flow treats Web Subject Profile reuse as exclusive with current-run web gather. If future behavior mixes reuse and gather in one run, per-source origin metadata can be added then.
- Existing persisted `analytics.json` artifacts keep the old flat meaning. No programmatic reader was found in `src/`; reviewer-facing tools should tolerate historical artifacts by date/shape.

## Validated Feedback

- Accepted: `webSubjectProfile` presence is not enough to identify reuse. Current-run extraction also sets `webSubjectProfile`, so reuse must be keyed off a marker set only in `attachReusableWebSubjectProfile`.
- Accepted: two ID sets are unnecessary today. Reuse is chosen in `runWebEvidencePhase` before web gather, and the reuse path skips `web-gather`, so a single reuse marker plus `webSubjectProfile.sourceIds` is enough.
- Accepted: the nested `currentRun`/`reusedProfile`/`allUsable` shape is over-shaped for current consumers. Keeping `webSources` flat for current-run coverage and adding a lean optional sibling is clearer.
- Accepted: add an explicit fresh/current-run profile assertion so the inverse bug cannot pass tests.
- Partially accepted: run-review is a real human/LLM consumer. Searches found no direct `webSources` references in the checked skill files, but the implementation pass should still verify and update if wording appears elsewhere.
- Rejected for now: per-ID origin metadata for mixed current-run and reused-profile runs. That mixed mode does not exist in current control flow and would add unnecessary surface area.

## Whole QA From Grilling Session

Historical note: Q3 and Q4 record the original grilling answers. The active revised plan above
supersedes their nested-shape and two-ID-set implementation details after adversarial validation.

### Q1: Accounting Contract

Question: For item 3, what should `analytics.json:webSources` mean when a Web Subject Profile is reused and no current `web-gather` stage runs?

Options:

- Split fresh/reused (Recommended): Keep web role telemetry, but distinguish current-run gathered web sources from reused-profile sources so coverage is not overstated.
- Fresh only: Emit `webSources` only for sources gathered in the current run; reuse-only runs omit or zero the block.
- All usable web: Keep counting reused profile sources as accepted web coverage, adding only a reuse/staleness marker.

Answer: Split fresh/reused (Recommended).

### Q2: Canonical Term

Question: What canonical term should the plan use for web sources gathered during the current run, as distinct from reused profile sources?

Options:

- current-run (Recommended): Avoids conflict with existing cache/profile freshness language and clearly ties the source to this run.
- fresh: Shorter, but overloaded with freshness-budgeted cache and profile TTL semantics.
- live-gathered: Emphasizes the web-gather stage, but may be inaccurate when same-day cache replay serves a request.

Answer: current-run (Recommended).

### Q3: Analytics Shape

Question: What `analytics.json:webSources` shape should the fix target?

Options:

- Nested origins (Recommended): Use `currentRun`, `reusedProfile`, and `allUsable` groups; clearest contract, with tests/docs updated.
- Top-level current: Keep existing top-level fields but redefine them as current-run only, adding reused counters beside them.
- Minimal marker: Keep existing fields as totals and add reuse counters/flags, reducing churn but leaving `accepted` ambiguous.

Answer: Nested origins (Recommended).

### Q4: Origin Tracking

Question: How should the implementation track current-run vs reused web source origin internally?

Options:

- CollectedSources metadata (Recommended): Add non-persisted source-id origin metadata carried by web gather/reuse paths into analytics.
- Derive from stages: Infer origin from whether `web-gather` ran; lower churn but brittle if mixed origins appear later.
- Mark Source objects: Add origin fields to `Source`; easy to inspect but leaks analytics provenance into report/source schema.

Answer: CollectedSources metadata (Recommended).

### Q5: Warning Semantics

Question: When `currentRun.accepted` is zero but `reusedProfile.accepted` is nonzero, should analytics emit the existing low-usage warning?

Options:

- No warning (Recommended): Warn only on current-run gathered sources; reuse freshness is already disclosed as a Source Gap.
- Reuse warning: Emit a distinct warning that profile evidence was reused rather than gathered this run.
- Keep warning: Apply the existing low-usage threshold to all usable web sources, even on reuse-only runs.

Answer: No warning (Recommended).

## Code Context Already Inspected

- `src/research/run-analytics.ts`: `webSourceRoles` currently counts all `report.sources` where `kind === "web"` as accepted, then computes `profileUsed`, `reportCited`, `unused`, and `usageRatio`.
- `src/research/web-subject-profile-reuse.ts`: `attachReusableWebSubjectProfile` merges reused profile Sources into `collectedSources.extendedSources` and attaches the reused profile plus Source Gap.
- `src/research/web-evidence-phase.ts`: reuse path skips `web-gather` and `web-subject-profile` stages, then reconciles Business Framework evidence.
- `src/research/web-gather-loop.ts`: accepted current-run web Sources are appended to `collectedSources.extendedSources`; no origin-tracking edit should be needed.
- `src/sources/types.ts`: `CollectedSources` is the least invasive place for the non-persisted reuse marker.
- `src/domain/types.ts`: avoid adding origin fields to `Source`; that would leak analytics provenance into report/source schema.

## Original Evidence

From `plans/2026-07-01-aapl-run-review-handoff.md` finding 3:

- Latest `normalized/web-subject-profile.json:generatedAt = 2026-06-28T10:42:57.445Z`.
- Latest `normalized/source-gaps.json:web-subject-profile.message = Reused web subject profile from 2026-06-28T10:42:57.445Z (2 days old); latest SEC filing basis 2026-05-01.`
- Latest `analytics.json:runShape.traceStages = source-collection|playbook-selection|specialist-analysis|instrument-evidence-analysis|market-behavior-analysis|critique|final-synthesis`; no `web-gather` or `web-subject-profile` stage.
- Latest `analytics.json:webSources = { accepted: 11, profileUsed: 11, reportCited: 10, unused: 0, usageRatio: 1 }`.

Suspected cause: reuse path carries profile source IDs into current-run web-source accounting without distinguishing reused vs current-run gathered evidence.

## Completion Criteria

- Code keeps `analytics.json:webSources` as current-run web coverage and adds optional `analytics.json:reusedProfileWebSources` for reused profile coverage.
- Reuse-only runs do not imply current-run web coverage.
- Current-run web gather analytics still work.
- Docs explain current-run and reused-profile Web Source Role telemetry.
- `bun run check` passes.
