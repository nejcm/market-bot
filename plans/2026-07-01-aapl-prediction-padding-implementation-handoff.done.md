# AAPL Prediction Padding Implementation Handoff

## Purpose

Continue work on finding 1 from `plans/2026-07-01-aapl-run-review-handoff.md`: the latest AAPL run emitted four forecasts, three near base rate, and `analytics.json:predictions.signalTargetMet` flipped false.

The original prompt/schema-only plan was reviewed adversarially. The review found a real gap: prompt-string tests cannot prove the model will stop emitting near-0.5 relative forecasts, especially because anti-padding wording already exists in the final-synthesis prompt. This file now contains the improved plan.

## Suggested Skills

- `coding-principles`: Use while making scoped implementation changes.
- `run-review`: Use if re-checking the AAPL run artifacts or validating a follow-up run.
- `code-quality`: Use for final verification with `bun run check`.

## Current State

- Repo: `C:\Work\Personal\market-bot`
- Full original run-review findings: `plans/2026-07-01-aapl-run-review-handoff.md`
- No implementation changes have been made for this finding yet.
- Existing code already tells final synthesis not to pad with coin-flip forecasts.
- Existing `requiredShape.predictions` still mirrors `depthProfile.targetPredictions`, which is prompt-shape pressure but not proven root cause.
- Existing comments/docs still cite superseded ADR 0021/0020 in places; canonical prediction semantics live in ADR 0004.

## Revised Plan: Diagnose Before Claiming a Fix

### Summary

- Do not treat the original prompt/schema edit as sufficient to close finding 1.
- Keep `Near-Base-Rate Prediction` analytics-only: no rejection gate, no retry trigger, no scoring change, no deterministic near-base-rate trim.
- First clarify whether the AAPL near-0.5 relative forecasts are honest low-edge forecasts or correlated padding.
- Implement low-risk hygiene regardless: one-exemplar prediction shape and canonical ADR 0004 citation cleanup.
- If padding is confirmed, fix the mechanism around correlated relative forecast diversity, not by adding more anti-padding prose alone.

### Key Changes

- Diagnosis:
  - Inspect the latest AAPL `report.json`, `analytics.json`, and relevant final-synthesis prompt behavior.
  - Record whether the three 5-day relative forecasts should be classified as honest low-edge forecasts or correlated padding.
  - Do not mark finding 1 closed from prompt/string tests alone.
- Prompt/schema hygiene:
  - Change final-synthesis `requiredShape.predictions` from `targetPredictions` examples to one exemplar prediction.
  - Keep target count in `depthProfile.targetPredictions` and instruction text.
  - Keep existing "up to N" and no-padding language; add only minimal wording if needed to resolve the conflict between calibration-to-base-rate and omission.
- Diversity mechanism:
  - Review `buildKindMixGuidance` and `buildForecastDiversityGuidance` so "relative" is not treated as automatically informative when several same-horizon relative forecasts all sit near 0.5.
  - Prefer wording that distinguishes informative forecast kind from informative forecast probability.
  - Do not add a post-emission near-base-rate filter unless the domain boundary is explicitly changed in `CONTEXT.md` and ADR 0004.
- Docs:
  - Update `CONTEXT.md` `Prediction` references from superseded ADR 0020/0021 to canonical ADR 0004.
  - Clean stale ADR 0021 references in code/test comments where they describe current soft-target behavior.
  - Amend ADR 0004 only if the implementation changes prediction emission semantics; prompt-shape hygiene and citation cleanup do not require a new ADR.

### Tests And Verification

- Deterministic tests:
  - Assert final-synthesis `requiredShape.predictions` has one exemplar regardless of target count.
  - Assert prompt text still presents `targetPredictions` as "up to N" / soft target.
  - Assert no near-base-rate rejection, retry, trimming, or scoring behavior is introduced.
  - Keep existing shortfall tests proving clean below-target output ships once with `predictionShortfall`.
- Comment/doc verification:
  - `rg "ADR 0021|ADR 0020" src tests CONTEXT.md docs/adr` should return only historical/superseded ADR references where appropriate, not current-behavior comments.
- Optional observational verification:
  - A follow-up AAPL run may be used as evidence, but a single provider run should be treated as observational due to model nondeterminism.
  - If no rerun is done, report the work as "prompt/schema and documentation refinement," not "finding 1 fixed."
- Final check:
  - Run `bun run check` after code/doc changes.

### Acceptance Criteria

- The implementation does not add validation gates, retry branches, near-base-rate trimming, scoring-version changes, or research-output trade language.
- Prompt/schema changes are covered by deterministic tests.
- Soft-target behavior remains unchanged: below-target predictions disclose `predictionShortfall` and do not trigger repair unless existing redundancy-trim rules apply.
- The plan output explicitly states whether finding 1 is closed, partially addressed, or left open pending observational run evidence.

## Whole QA From Grill-With-Docs

1. Should near-base-rate forecasts remain analytics-only, or become an emission-quality gate?
   - Answer: Keep `Near-Base-Rate Prediction` analytics-only.
   - Rationale: Existing `CONTEXT.md` and ADR 0004 say near-base-rate is not a rejection gate and `targetPredictions` is soft. The fix should not reject valid `0.47-0.52` predictions after emission.

2. Should the prediction-quality fix apply to every final-synthesis run or only deep instrument runs like AAPL?
   - Answer: All runs for prompt/schema hygiene.
   - Revised note: any deterministic mechanism beyond hygiene must be justified separately because the evidence came from one AAPL run.

3. Should the implementation change the final-synthesis `requiredShape.predictions` example array so it no longer mirrors the target count?
   - Answer: One exemplar.
   - Rationale: Makes the schema show shape only, while the instruction carries the soft target count.

4. How should negative calibration interact with emission count?
   - Answer: Omit weak forecasts when evidence is thin.
   - Revised note: do not suppress honest low-confidence forecasts merely to improve `signalTargetMet`; first classify whether the forecast is honest uncertainty or padding.

5. What should count as acceptance for this fix plan?
   - Original answer: Tests plus `bun run check`.
   - Revised answer: deterministic tests plus `bun run check` validate prompt/schema/docs only. Closing finding 1 requires either observational run evidence or an explicit statement that the finding remains open.

## Adversarial Review Feedback Incorporated

- The old plan's biggest weakness was treating prompt text tests as evidence that LLM emission behavior changed.
- The anti-padding instruction already exists, so adding more prose alone is not a reliable behavioral fix.
- The schema exemplar length may contribute to count pressure, but it is not proven root cause.
- The relative forecast nudges may conflict with near-base-rate signal telemetry because "relative" can be a better-measured kind while still having near-0.5 probability.
- Deterministic near-base-rate trimming would be a real emission gate and should not be introduced under the current analytics-only domain rule.
- ADR citation cleanup should include code/test comments, not only `CONTEXT.md`.

## Useful Code Pointers

- `src/research/research-context.ts`
  - `finalReportShape(...)` currently builds `requiredShape.predictions` with `Array.from({ length: depthProfile.targetPredictions }, ...)`.
  - `buildStagePrompt(...)` builds the final-synthesis prediction instruction.
  - `buildKindMixGuidance(...)` and `buildForecastDiversityGuidance(...)` are the likely places to clarify kind diversity vs probability signal.
- `src/research/final-synthesis.ts`
  - Existing shortfall and redundancy replacement behavior should remain unchanged.
- `src/research/report-assembly.ts`
  - Emits `predictionShortfall: emitted X of N target predictions; evidence did not support more`.
- `src/research/run-analytics.ts`
  - Near-base-rate telemetry and `signalTargetMet` are analytics-only and should remain unchanged unless a separate analytics plan is approved.
- `CONTEXT.md`
  - Update current prediction references to ADR 0004.
- `docs/adr/0004-predictions-as-observable-forecasts.md`
  - Canonical source for observable forecasts, scoring, calibration, soft target count, and no-padding semantics.

## Relevant Existing Tests

- `tests/research-context.test.ts`
  - Prompt/shape tests around `targetPredictions`, `requiredShape`, calibration context, and forecast-shape diversity.
- `tests/orchestrator.test.ts`
  - Shortfall and no-reprompt behavior tests:
    - "ships with a shortfall gap without reprompting when predictions fall below target"
    - redundancy replacement tests
    - "does not retry replacement when below target without redundant trim"
- `tests/run-analytics.test.ts`
  - Near-base-rate telemetry tests proving count remains unchanged and telemetry is not a rejection gate.

## Implementation Outcome (2026-07-01)

- Diagnosis classification: **correlated padding**, not three independent honest low-edge forecasts.
  - Latest AAPL `report.json` predictions: `pred-2` (AAPL:QQQ, 0.47), `pred-3` (AAPL:SPY, 0.52), `pred-4` (AAPL:IWM, 0.52) — all `relative`, all 5-trading-day horizon.
  - QQQ, SPY, and IWM are correlated broad US equity benchmarks and AAPL is a dominant QQQ/SPY constituent, so the three forecasts restate one "AAPL tracks the broad market over 5 days" view against correlated benchmarks rather than expressing three independent edges, each near coin-flip.
- Work delivered: prompt/schema and documentation refinement only.
  - One-exemplar `requiredShape.predictions` (removes count pressure from the schema).
  - Forecast-diversity and kind-mix wording now separate informative forecast kind from informative forecast probability.
  - ADR 0020/0021 → canonical ADR 0004 citation cleanup in `CONTEXT.md`, prediction code comments, and test comments.
  - No near-base-rate rejection gate, retry branch, deterministic trim, validator, or scoring-version change was added.
- **Finding 1 status: open (partially addressed).** No follow-up AAPL run was performed, so this is prompt/schema/docs refinement, not a confirmed behavioral fix. Closing finding 1 requires an observational rerun (treated as evidence given model nondeterminism) showing the correlated near-0.5 relative cluster no longer recurs.

## Implementation Notes

- Keep the change surgical.
- Do not claim finding 1 is fixed unless the diagnosis and evidence support that claim.
- Do not add a prediction validator, near-base-rate rejection gate, retry branch, deterministic trim, or scoring-version change under this plan.
- If a future decision chooses deterministic trimming, update the glossary and ADR 0004 first because that changes the domain rule.
- After code/doc edits, run `bun run check`.
