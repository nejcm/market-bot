# Forecast Completion Pass: making declines diagnosable

Verified read-only at branch `prompt-validator-reconciliation`, HEAD `ca86ca8`. No market-bot CLI,
tests, builds, live runs, fixture recorder, or writes were performed in producing this document.

> `AGENTS.md` bans unsolicited planning docs. This one was solicited.

## Provenance

Four passes, each by a different model, each disagreeing with the one before:

1. A `/run-review` of `data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/` (live `equity AMD --deep`),
   focused on why the run returned `predictions.completion.outcome: "declined-empty"` while two
   Predictions short of a soft target of five.
2. A verification of that review, which **refuted two of its claims** — a 7:4 clause census and a
   "squeeze" argument — and produced the four-phase plan in Part 2.
3. An adversarial validation of that plan, which returned nine findings and the recommendation
   "land with the listed corrections". All nine are folded in below and marked
   `(validation)` where they changed the text.
4. An assumption audit, asked to find what the first three passes never questioned rather than
   whether their stated claims were true. It confirmed the completion pass is mechanically capable
   of accepting, refuted the premise of the shortfall-wording phase, found two tests that break
   under phases 1 and 2, and cut the plan's headline evidence base by roughly two thirds. Marked
   `(assumption audit)` below.

Each pass corrected the one before it. Treat a fifth as likely to find something too, and treat any
claim here that carries no file:line as unverified.

The headline finding is not the single decline. It is that **the Forecast Completion Pass has never
accepted a Prediction in any artifact on disk** — `acceptedCount: 0`, twelve for twelve. Nothing
aggregated that outcome across runs, so it produced no signal.

**How much that number is worth (fourth pass, assumption audit).** The raw count is real; its
evidential weight is roughly a third of what the first three passes assumed, because provenance was
never checked:

| Evidence | Count | What it is |
|---|---|---|
| Real-model explicit declines | **2** | the live AMD run, and `equity-depository-deep` (`meta.json:synthesisModel: "gpt-5.6-sol"`) |
| Ambiguous legacy-labelled live runs | 2 | `e6889971` and `11a115d4` record `no-candidates-returned`, a label predating the `a0ac583` split that conflated an explicit `[]` with a missing key |
| Synthetic non-observations | 8 | `synthesisModel: "fixture-synthesis"`, a placeholder rather than a model |

Worse, in five of those eight the recorded "completion response" is **byte-identical to the first
synthesis response** — the same canned report replayed a second time, whose `predictions` is `[]`
because `initialCount` is `0`. Verified directly: `equity-aapl-brief`, `equity-aapl-deep`,
`equity-fpi-ifrs-semiannual`, `equity-fpi-quarterly` and `equity-nbis-deep` all satisfy
`entries["final-synthesis|…"][1] === [0]`. They carry no information about whether a model declines.

**Real evidence base: n≈2.** The `improved` path is exercised only against stubs
([orchestrator-completion.test.ts:371](../tests/orchestrator-completion.test.ts:371)), which proves
mechanism, not behavior. This makes phases 2 and 3 *more* necessary, not less — at n≈2 nothing can be
diagnosed and telemetry is the only way out — but nobody should read this plan as evidence that a
subsystem is measurably broken. It is evidence that we cannot currently tell.

The chain's own correction table claimed it had avoided "inferring fixture behavior instead of
reading a cassette." It read cassette *content* and never checked cassette *provenance* — the same
error one level down. Recorded here rather than quietly fixed.

What is deliberately *not* claimed: that the AMD decline was wrong. It cannot be shown wrong, and it
cannot be shown right, because a decline is structurally unable to carry a reason. That
indistinguishability is the defect this plan addresses.

## Corrections applied during validation

| # | Severity | Correction |
|---|---|---|
| 1 | should-fix | The Part 1 claim that an extra model field is "ignored" was wrong at runtime — `parseModelPayload` returns the parsed record and extra keys survive. Reworded to "unreadable without extending the interface." |
| 2 | nit | `prediction-coverage.ts:55` → `:65`. |
| 3 | nit | `observable-candidates.ts:139` → `:148`; `:139` is the policy destructuring. |
| 4 | should-fix | Phase 1 missed a third macro surface: the Domain Playbook at `prompts/playbooks/synthesis-discipline.md:11`. Added. |
| 5 | should-fix | Phase 4 missed the `analytics.json` carrier — `loadRunArtifact` never reads it and `RunArtifact` has no field for it. Added, with an existing precedent to copy. |
| 6 | should-fix | No phase touched `CONTEXT.md`, which AGENTS.md requires for a new domain term. Added to phase 2. |
| 7 | should-fix | Phases 2 and 3 both rewrite the same sentence at `final-synthesis.ts:550`; the collision is now stated and phase 3 rebases onto phase 2. |
| 8 | nit | Phase 2 left `all-candidates-rejected` and `no-parsable-candidates` code handling unspecified. Both now specified with tests. |
| 9 | nit | The 6:6 clause recount was presented as a corrected figure. It is as unprincipled as the 7:4 it replaces; reframed as "no numeric census is reproducible." |

Validation found **no blocking defects**, and confirmed the earlier failure mode of this review chain
— inferring fixture behavior instead of reading a cassette — is not present here: the golden-churn
claims survive direct inspection of the cassette keying (`tests/support/run-fixtures/llm-cassette.ts:31`)
and the golden differ (`golden-diff.ts:496`).

## Part 1: verification

### Verification table

| Claim | Verdict | Evidence and assessment |
|---|---|---|
| The AMD completion pass received an accurate two-Prediction count and returned an explicit empty array. | **CONFIRMED** | [stages.json:48](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/stages.json:48) contains `"content": "{\"predictions\":[]}"`. [trace.json:933](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/trace.json:933) records `"initialCount": 3`, `"targetCount": 5`, empty accepted IDs, and `"outcome": "declined-empty"`. |
| Q1 quotes the real completion instruction, and `requestedCount` appears in that builder only as an `up to` ceiling. | **CONFIRMED, with one scope correction** | [final-synthesis.ts:550](../src/research/prompts/final-synthesis.ts:550) says: `"Return a JSON object containing only a predictions array with up to ${...} additional forecasts. An empty array is valid..."`. That is the only `completion.requestedCount` interpolation inside `buildPredictionCompletionInstruction`. The full prompt also carries the numeric field separately as `predictionCompletion.requestedCount` at [final-synthesis.ts:757](../src/research/prompts/final-synthesis.ts:757) and [stage-envelope.ts:96](../src/research/prompts/stage-envelope.ts:96). Thus the instruction framing is a ceiling, but the model sees the count twice. |
| The steering contains 7 anti-emission clauses versus 4 pro-emission clauses. | **REFUTED as an objective census** | The quoted fragments exist, but the counting rule is inconsistent. It counts `"up to 2"` as pro-emission after correctly identifying it as a permission ceiling. It splits some mixed clauses while merging others. Using semantic concepts, I count 6 restrictive concepts and 6 candidate-seeking concepts. Relevant text is spread across [final-synthesis.ts:51](../src/research/prompts/final-synthesis.ts:51), [final-synthesis.ts:243](../src/research/prompts/final-synthesis.ts:243), [prediction-coverage.ts:88](../src/research/prompts/prediction-coverage.ts:88), and [final-synthesis.ts:162](../src/research/prompts/final-synthesis.ts:162). The useful conclusion is qualitative: the instruction strongly preserves anti-padding policy. The 7:4 ratio has no stable basis. |
| Q3(a): the completion required shape is `{predictions}` only, and an empty decline cannot carry a reason into the audit. | **CONFIRMED** | [final-synthesis.ts:704](../src/research/prompts/final-synthesis.ts:704) selects `{ predictions: reportShape.predictions }`. [types.ts:678](../src/domain/types.ts:678) has `rejectionReasons` but no decline field. [final-synthesis.ts:531](../src/research/final-synthesis.ts:531) initializes no candidates for a non-array or empty array; [final-synthesis.ts:537](../src/research/final-synthesis.ts:537) populates reasons only while iterating returned candidates. The AMD audit consequently has `"rejectionReasons": []` at [trace.json:939](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/trace.json:939). An extra model field is not *dropped* at runtime — `parseModelPayload` does `JSON.parse(content) as unknown` and returns the record, so extra keys survive ([report-assembly.ts:69](../src/research/report-assembly.ts:69)). It is unreadable rather than discarded: `ModelReportPayload` declares only the existing fields ([report-assembly.ts:54](../src/research/report-assembly.ts:54)), so consuming a new field still requires extending that interface. Corrected during validation; the plan's direction is unaffected. |
| Q3(b): `macro` is advertised on an AMD equity run although any valid macro candidate is rejected by the subject allowlist. | **CONFIRMED bug, with a correction to the reported chain** | `supportedPredictionKinds` adds `"macro"` unconditionally at [prediction-coverage.ts:65](../src/research/prompts/prediction-coverage.ts:65). The macro shape maps `fred(DGS10, ...)` to subject `DGS10` at [observable-shapes.ts:309](../src/forecast/observable-shapes.ts:309) and [observable-shapes.ts:328](../src/forecast/observable-shapes.ts:328). `validateProjection` requires that subject at [observable-candidates.ts:22](../src/forecast/observable-candidates.ts:22), then the allowlist emits `disallowed-subject` at [observable-candidates.ts:148](../src/forecast/observable-candidates.ts:148) (`:139` is the policy destructuring). Instrument run parameters contain only the ticker at [resolver.ts:55](../src/config/runs/resolver.ts:55), and the orchestrator constructs the allowlist from those parameters at [orchestrator.ts:740](../src/research/orchestrator.ts:740). The report incorrectly attributes FRED normalization to `normalizePredictionSubject`; that function only normalizes relative forecasts at [observable-candidates.ts:212](../src/forecast/observable-candidates.ts:212). `subjectForExpression` performs the macro mapping. The final rejection result remains exactly as claimed. |
| Forecast Completion accepted 0 Predictions in all 12 on-disk completion audits. | **CONFIRMED** | The three live analytics files record zero: [target:764](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/analytics.json:764), [baseline:764](../data/runs/2026-08-26T16-31-26-683Z-11a115d4/analytics.json:764), [earlier:742](../data/runs/2026-08-26T15-01-24-300Z-e6889971/analytics.json:742). All nine fixture analytics do likewise: [AAPL brief:411](../tests/fixtures/runs/equity-aapl-brief/golden-output/analytics.json:411), [AAPL deep:441](../tests/fixtures/runs/equity-aapl-deep/golden-output/analytics.json:441), [comprehensive:470](../tests/fixtures/runs/equity-analysis-comprehensive/golden-output/analytics.json:470), [estimated:480](../tests/fixtures/runs/equity-analysis-estimated-suppressed/golden-output/analytics.json:480), [depository:483](../tests/fixtures/runs/equity-depository-deep/golden-output/analytics.json:483), [IFRS:466](../tests/fixtures/runs/equity-fpi-ifrs-semiannual/golden-output/analytics.json:466), [quarterly FPI:466](../tests/fixtures/runs/equity-fpi-quarterly/golden-output/analytics.json:466), [NBIS:484](../tests/fixtures/runs/equity-nbis-deep/golden-output/analytics.json:484), [web fallback:560](../tests/fixtures/runs/equity-web-fallback-deep/golden-output/analytics.json:560). |
| Fixture completion behavior came from explicit empty arrays, not missing `predictions` keys. | **CONFIRMED** | Direct cassette reads show `{"predictions":[]}`, including [equity-depository-deep:39](../tests/fixtures/runs/equity-depository-deep/llm-cassette.json:39), [equity-analysis-comprehensive:37](../tests/fixtures/runs/equity-analysis-comprehensive/llm-cassette.json:37), and [equity-web-fallback-deep:51](../tests/fixtures/runs/equity-web-fallback-deep/llm-cassette.json:51). The final completion response was an explicit empty array in all nine completion fixtures. There are nine fixture completion responses across eight distinct subjects, not eight fixture responses. |
| The `improved` path is exercised only by stubs. | **CONFIRMED for this repository and artifact set** | No live or fixture analytics has `outcome: "improved"`. The positive paths are inline `ModelProvider` stubs in [orchestrator-completion.test.ts:371](../tests/orchestrator-completion.test.ts:371), [orchestrator-completion.test.ts:492](../tests/orchestrator-completion.test.ts:492), and [orchestrator-completion.test.ts:669](../tests/orchestrator-completion.test.ts:669). One hard-coded response and assertion appear at [orchestrator-completion.test.ts:431](../tests/orchestrator-completion.test.ts:431) and [orchestrator-completion.test.ts:482](../tests/orchestrator-completion.test.ts:482). |
| Q2: the completion evidence field replaces the full evidence payload with compact source entries and deterministic anchors. | **CONFIRMED, with nuance** | Each source becomes `{id,title,fetchedAt,publisher?,url?,snippet?}` at [final-synthesis.ts:332](../src/research/prompts/final-synthesis.ts:332). [final-synthesis.ts:459](../src/research/prompts/final-synthesis.ts:459) emits `sources`, optional `webSources`, `latestClose`, and the three optional blocks. [final-synthesis.ts:704](../src/research/prompts/final-synthesis.ts:704) replaces the normal evidence and prior-stage transcript. It still supplies report narrative and critique at [final-synthesis.ts:718](../src/research/prompts/final-synthesis.ts:718), so "titles/snippets only" is too broad if applied to the whole prompt rather than its `evidence` field. |
| `earningsSetup`, `optionsIv`, and `priorCalibration` were absent from this completion evidence payload. | **CONFIRMED through deterministic inputs; the wire prompt itself was not persisted** | Earnings is `"not-present"` at [analytics.json:792](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/analytics.json:792), so `completionEarningsSetup` returns `undefined` under [final-synthesis.ts:398](../src/research/prompts/final-synthesis.ts:398). Tradier is `"missing-credential"` at [analytics.json:529](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/analytics.json:529) and the normalized Source Gap states the missing key at [evidence-bundle.json:1905](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/normalized/evidence-bundle.json:1905); no citeable options-IV item exists. Calibration had zero resolved Predictions at [analytics.json:821](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/analytics.json:821), while `buildCalibrationBlock` returns `undefined` when no slice is actionable at [calibration-context.ts:258](../src/research/calibration-context.ts:258). |
| The inclusive 0.40 to 0.60 Near-Base-Rate band is a hard completion rejection. | **CONFIRMED** | [final-synthesis.ts:511](../src/research/final-synthesis.ts:511) calculates `abs(probability - 0.5) <= 0.1`, and [final-synthesis.ts:555](../src/research/final-synthesis.ts:555) increments the rejected count and skips the candidate. ADR 0003 explicitly requires the same hard completion gate at [ADR 0003:53](../docs/adr/0003-forecasts-scoring-calibration-cross-run-intelligence.md:53). |
| Occupied slots forced all honest remaining candidates into the forbidden band. | **REFUTED as a structural claim; probability sufficiency remains unsettled** | The occupied Predictions are one 5-day AMD:QQQ relative forecast and 5-day/20-day range forecasts at [report.json:313](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/report.json:313). Citeable NVDA, AVGO, and INTC sources remain at [report.json:902](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/report.json:902), [report.json:977](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/report.json:977), and [report.json:1052](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/report.json:1052). Those peer-relative slots are not structurally occupied by AMD:QQQ. The artifact cannot establish an evidence-supported probability outside the band because the model returned no candidates or rationale. The claimed "squeeze" is possible, not demonstrated. |
| Empty completion is sanctioned policy, and the remaining shortfall is disclosed. | **CONFIRMED** | ADR 0003 makes Prediction count a soft target and leaves shortfall deterministically disclosed at [ADR 0003:44](../docs/adr/0003-forecasts-scoring-calibration-cross-run-intelligence.md:44). The AMD report contains `{emittedCount:3,targetCount:5,missingCount:2}` at [report.json:2686](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/report.json:2686). Removing the empty-array path would contradict the accepted ADR. |
| Completion rationale, exact payload-block presence, reachable kinds, and cross-run outcome aggregation are absent. | **CONFIRMED** | `PredictionCompletionAudit` has no rationale, payload, or reachable-kind fields at [types.ts:678](../src/domain/types.ts:678). Analytics projects only attempted/counts/outcome at [run-analytics.ts:759](../src/research/run-analytics.ts:759). The Run Artifact Index `runs` row has no completion columns at [run-artifact-index-types.ts:14](../src/run-artifact-index-types.ts:14) and [run-artifact-index-schema.ts:19](../src/run-artifact-index-schema.ts:19). |
| `stages.json:steering` is reconstructed rather than the literal sent prompt. | **CONFIRMED** | The model receives `prompt` at [orchestrator.ts:225](../src/research/orchestrator.ts:225), then the orchestrator separately calls `buildRecordedStageSteering` at [orchestrator.ts:252](../src/research/orchestrator.ts:252). The builder says it records only the steering block, not the full prompt, at [final-synthesis.ts:609](../src/research/prompts/final-synthesis.ts:609). It reuses the same text functions, so it should match that segment, but it is not the wire payload. |
| The target run was stagnant against the immediate baseline except for outcome labeling and one Source Gap. | **CONFIRMED** | Both runs have 3/5 Predictions, the same kind mix and horizons: [target analytics:756](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/analytics.json:756) and [baseline analytics:756](../data/runs/2026-08-26T16-31-26-683Z-11a115d4/analytics.json:756). Source Gaps changed from 18 at [baseline:410](../data/runs/2026-08-26T16-31-26-683Z-11a115d4/analytics.json:410) to 17 at [target:412](../data/runs/2026-08-27T03-44-11-077Z-ff74ecfc/analytics.json:412). |

### Clause recount

No numeric census of this text is reproducible. The recount below is offered to show why, not as a corrected figure — it is as dependent on where clause boundaries are drawn as the 7:4 it replaces.

One such reading gives:

- Restrictive concepts, 6: empty is valid; Near-Base-Rate eligibility plus no inflation; broad-index equivalence and occupied-slot rejection; horizon changes require evidence; better-measured kinds still need off-base-rate probability; no padding.
- Candidate-seeking concepts, 6: vary horizon/benchmark/kind to add another; prefer listed subjects and favored kinds; seek an uncovered kind; consider a different evidence-supported horizon; check distinct shapes before stopping; explore shape and resolution-window variety.
- Excluded from the pro count: `"up to 2"`. It permits output but does not request that two be produced.

The instruction is cautious by design. That conclusion is qualitative and holds; no numeric ratio should be quoted as evidence for it, including 6:6.

### Gate asymmetry, and a playbook that argues against the gate (assumption audit)

The completion pass applies **strictly stricter** gates than the initial synthesis pass. This is not
a defect — the main one is deliberate and documented — but no phase should present the two gates as
equivalent, and one of the three was never documented anywhere.

| Gate | Initial pass | Completion candidate |
|---|---|---|
| grammar, horizon 1–20, probability 0–1, citations | `readPredictions` | same call ([final-synthesis.ts:551](../src/research/final-synthesis.ts:551)) |
| Near-Base-Rate 0.40–0.60 | **not applied** — analytics only *counts* in-band Predictions ([run-analytics.ts:648](../src/research/run-analytics.ts:648)) | **hard reject** ([final-synthesis.ts:511](../src/research/final-synthesis.ts:511), [:555](../src/research/final-synthesis.ts:555)) |
| redundancy replacement | a candidate may **replace** a longer direction forecast | **rejected** — `preservesExisting && addsCandidate` ([final-synthesis.ts:568](../src/research/final-synthesis.ts:568)) forbids any merge that drops an existing Prediction |
| empty subject allowlist | runs unrestricted | **pass skipped entirely** ([final-synthesis.ts:477](../src/research/final-synthesis.ts:477)) |

The band asymmetry is required by [ADR 0003:53](../docs/adr/0003-forecasts-scoring-calibration-cross-run-intelligence.md:53).
The replacement and empty-allowlist asymmetries are undocumented; neither is causal for the AMD run,
but both mean a candidate can fail at completion that the initial pass would have accepted.

**The attached Domain Playbook argues for probabilities the completion gate then rejects.**
[synthesis-discipline.md:7](../prompts/playbooks/synthesis-discipline.md:7) instructs: "Anchor to base
rates. Start from the outcome's base rate — roughly 0.5 for short-horizon direction calls." Line 8
adds: "When the evidence is thin, single-source, stale, or conflicting, pull the probability back
toward the base rate." The completion gate then hard-rejects anything in 0.40–0.60. For a marginal
fourth or fifth forecast on a single-subject run, "shade toward 0.5", "0.40–0.60 is invalid" and "do
not pad" compose into an empty array as the only coherent output.

That playbook reaches the completion prompt via `stagePlaybooks("final-synthesis", …)`
([final-synthesis.ts:743](../src/research/prompts/final-synthesis.ts:743)) but is **absent from the
recorded steering**, which is why every clause census in this chain missed it. It does not refute the
"cautious by design" reading — it strengthens it. Any future prompt-rebalancing experiment must treat
the playbook as in scope, and phase 2's `payloadBlocks` must record attached playbook ids so the next
reader can see it.

### Bottom line

Confirmed defects:

1. `macro` is advertised where the equity subject gate guarantees `disallowed-subject`.
2. An empty or partial completion cannot explain its residual shortfall.
3. Completion outcomes are not aggregated, which hid a 0/12 acceptance history.
4. Prompt-artifact fidelity is incomplete.

Confirmed prompt weakness, but not a proven cause:

- The completion instruction frames `requestedCount` as a ceiling and never states the current count, soft target, and disclosed shortfall together.

Not established:

- That the AMD decline was correct.
- That it was wrong.
- That the Near-Base-Rate band caused it.
- That anti-padding wording caused it.
- That naming peer benchmarks would have produced an acceptable Prediction.

## Part 2: implementation plan

## Scope and sequencing

Implement four phases:

1. Remove the unreachable `macro` option.
2. Add a structured decline contract and exact completion-prompt diagnostics.
3. Add cross-run completion telemetry to the Run Artifact Index and Research Console.
4. *(demoted by the assumption audit)* State the current shortfall explicitly — a prompt-emphasis
   experiment, not a fix, and unmeasurable until the telemetry above exists.

**This ordering is authoritative.** The per-phase sections below are still numbered and written in
the original order, in which the shortfall wording was phase 3 and telemetry phase 4. Execute
telemetry first.

**Why the shortfall wording moved to last.** Its original premise — that the model is never told it
is short — is false. Current, target and missing are all already in the wire prompt as structured
fields: `depthProfile.targetPredictions: 5`
([research-context-types.ts:24](../src/research/research-context-types.ts:24), serialized at
[stage-envelope.ts:84](../src/research/prompts/stage-envelope.ts:84)) and
`predictionCompletion.requestedCount: 2` beside `existingPredictions` of length 3
([final-synthesis.ts:750](../src/research/prompts/final-synthesis.ts:750),
[stage-envelope.ts:96](../src/research/prompts/stage-envelope.ts:96)). Restating them as prose may
still change behavior — models do not weight prose and JSON fields alike — but it is a low-confidence
experiment on data already present, and its effect cannot be read without the telemetry.

A related suspicion was checked and dismissed: `signalTargetMet: true` in the AMD analytics is not a
contradictory signal. It measures the fraction of emitted Predictions outside the Near-Base-Rate band
against a 0.5 floor ([run-analytics.ts:652](../src/research/run-analytics.ts:652)), is computed after
the run from the finished report, and never reaches any prompt.

The report’s item 1 before item 6 ordering is not a code dependency. Anti-padding wording can be unit-tested without decline reasons. It is a measurement dependency: another live `declined-empty` cannot distinguish insufficient evidence from prompt pressure without a rationale. Therefore phase 2 must precede any behavioral prompt experiment. This plan does not include that experiment because the causal claim did not survive verification.

### Phase 1: gate macro on reachable, citeable subjects

#### Required behavior

- In [prediction-coverage.ts:49](../src/research/prompts/prediction-coverage.ts:49), include `macro` only when:

  - at least one configured `predictionSubject` is a known FRED series from [fred.ts:3](../src/sources/fred.ts:3), and
  - collected evidence contains a citeable `fred-macro` item.

- Apply the identical gate to the macro DSL fragment currently unconditional at [final-synthesis.ts:194](../src/research/prompts/final-synthesis.ts:194). Gating only `supportedPredictionKinds` would leave `fred(SERIES, ...)` advertised elsewhere.
- AMD equity runs must omit `macro` from the required-shape kind union, coverage guidance, and completion DSL.
- Equity market-overview runs with an allowed FRED subject and citeable macro evidence must retain `macro`.
- Missing FRED evidence remains a declared Source Gap from the existing collector. The prompt must omit the unusable kind rather than silently suggesting it.
- `predictionSubjects: []` and missing macro evidence both produce omission. Do not substitute `[]` with an unrestricted default.
- **Third surface, found in validation:** the Domain Playbook at [synthesis-discipline.md:11](../prompts/playbooks/synthesis-discipline.md:11) names `macro` in its favored-kinds example ("lean toward the run's favored kinds (e.g. `relative`/pairs, `macro`, `range`)"). That playbook is registry-eligible for `equity` at `final-synthesis`, was attached on the AMD run (`trace.json:domainPlaybooks.selected[0]`), and `buildFinalSynthesisStagePrompt` attaches `stagePlaybooks("final-synthesis", …)` to the completion prompt as well. Gating only the two code paths leaves macro advertised here. Drop `macro` from that example list — the run-specific kind mix already carries the favored kinds, so the sentence keeps its meaning.

#### Files

- [prompts/playbooks/synthesis-discipline.md:11](../prompts/playbooks/synthesis-discipline.md:11)
- [tests/support/run-fixtures/assertions.ts:384](../tests/support/run-fixtures/assertions.ts:384) — **breaks under this phase (assumption audit).** It hard-codes the kind union: `expect(finalSynthesisPrompt).toContain('"kind": "direction|relative|iv|range|macro|conditional"')`, and runs against `equity-analysis-estimated-suppressed`, an AAPL instrument run whose `predictionSubjects` is `["AAPL"]`. Removing `macro` from `supportedPredictionKinds` feeds the required-shape union at [final-synthesis.ts:68](../src/research/prompts/final-synthesis.ts:68) and fails this assertion. It is a source edit, not a golden regeneration.
- [src/research/prompts/prediction-coverage.ts:11](../src/research/prompts/prediction-coverage.ts:11)
- [src/research/prompts/final-synthesis.ts:194](../src/research/prompts/final-synthesis.ts:194)
- [src/sources/fred.ts:3](../src/sources/fred.ts:3), reuse only
- [tests/prompt-final-synthesis-shape.test.ts:282](../tests/prompt-final-synthesis-shape.test.ts:282)
- [tests/prompt-final-synthesis-shape.test.ts:560](../tests/prompt-final-synthesis-shape.test.ts:560)
- `tests/support/prompt-baseline.golden.json`

> **Coverage gap (assumption audit):** the playbook edit is **not** covered by the prompt baseline.
> `tests/support/prompt-baseline-matrix.ts:356-369` supplies the playbook as an inline literal
> (`instruction: "Cite every claim."`) and never reads `prompts/playbooks/synthesis-discipline.md`, so
> editing that markdown changes no hash. Without its own direct assertion the edit lands unverified —
> exactly the "only the path you tested" defect AGENTS.md warns about. Add an assertion that the
> assembled completion prompt's playbook text does not offer `macro` as a favored kind.

#### Golden churn

- Prompt baseline hashes: expected and intentional.
- Fixture `report.json`, `report.md`, and `analytics.json`: none. Recorded outputs do not change.
- No `--write-golden` fixture replay.

#### Tests

- AMD/AAPL instrument profile with citeable FRED evidence but subjects `["AMD"]`: no `macro`, no `fred(SERIES...)`.
- Market overview with `DGS10` allowed and citeable macro evidence: `macro` remains.
- FRED subject allowed but evidence absent: `macro` omitted.
- Empty subject list: `macro` omitted.
- Refresh the prompt baseline, then run the focused prompt tests.
- Final verification remains `bun run check`.

#### Objective check

A generated completion prompt for an equity instrument with `predictionSubjects: ["AMD"]` contains neither `"macro"` in supported kinds nor `fred(SERIES, ...)`. This is fully testable without a live run.

For the next equity run performed for independent reasons, `stages.json` should not list `macro` in completion steering. Do not run a live job solely for this check.

#### Hit-every-surface classification

| Chain entry | Classification |
|---|---|
| Collector | N/A. Existing FRED collector and Source Gap behavior stay unchanged. |
| Projection | Touched only in prompt projection files above. No Report Extras producer changes. |
| Reader types | N/A. No persisted shape changes. |
| Artifact schema | N/A. |
| Markdown renderers | N/A. |
| Source-ID traversal | N/A. Citation rules stay unchanged. |
| Console view model | N/A. |
| Console component | N/A. |
| Run Artifact Index | N/A. |
| Tests and goldens | Touched as listed. |

#### ADR impact

No amendment. This enforces ADR 0003’s existing run-specific subject gate rather than changing it.

### Phase 2: make completion declines diagnosable

#### Required behavior

Use controlled reason codes, not free-form model prose.

Add a closed union such as:

- `insufficient-distinct-evidence`
- `only-near-base-rate-candidates`
- `only-redundant-candidates`
- `no-reachable-supported-kind`
- `no-citeable-source`

The completion response shape becomes:

```ts
{
  predictions: [...],
  declineReasonCodes: [...]
}
```

Rules:

- If returned Predictions fill `requestedCount`, `declineReasonCodes` must be `[]`.
- If a residual shortfall remains, at least one valid code is required.
- Persist `declineReasonCodes` and `declineReasonContractSatisfied`.
- Missing, empty, or entirely invalid codes with residual shortfall become `declineReasonCodes: []` and `declineReasonContractSatisfied: false`. This is the explicit finding for a producer that produced nothing.
- Keep `rejectionReasons` separate. Those remain deterministic validator results for returned candidates.
- A failed completion records empty codes, `declineReasonContractSatisfied: false`, and the existing `failureReason`.
- Do not require one reason per missing Prediction. Missing slots have no independent identity, and forcing duplicate reasons would manufacture cardinality without information.
- **The remaining two outcomes, unspecified in the first draft (validation finding):** for `all-candidates-rejected`, codes returned alongside rejected candidates ARE persisted — the model may have declined a further slot for one reason while its returned candidates failed for another, and `rejectionReasons` already carries the latter. For `no-parsable-candidates` the payload is by definition untrustworthy, so codes are discarded and `declineReasonContractSatisfied` is `false`. Both branches need their own test; see [src/research/final-synthesis.ts:643](../src/research/final-synthesis.ts:643).

Also record exact prompt diagnostics:

- `PredictionCompletionAudit.payloadBlocks`: keys from the serialized completion prompt’s `evidence` object, such as `sources`, `webSources`, `latestClose`, `earningsSetup`, `optionsIv`, and `priorCalibration`.
- Derive these keys from the actual serialized prompt in [orchestrator.ts:225](../src/research/orchestrator.ts:225), not by rebuilding the payload again.
- Add `steeringRepresentation: "reconstructed-segment"` beside recorded steering. Do not describe it as the literal sent prompt. Note that the reconstruction is a strict **subset** of the wire prompt: it omits `domainPlaybooks`, `depthProfile`, `evidence`, `reportDraft`, `predictionCompletion` and `requiredShape`. Every earlier pass in this chain quoted it as "what the model saw", and it under-represents the prompt by precisely the fields that matter.
- Extend `payloadBlocks` to record **attached playbook ids**, not only the `evidence` keys. The Domain Playbook reaches the completion prompt via `stagePlaybooks("final-synthesis", …)` ([final-synthesis.ts:743](../src/research/prompts/final-synthesis.ts:743)) but is absent from recorded steering, so it was invisible to every clause census performed on this problem.
- Record a Near-Base-Rate rejection as a **completion-only** outcome with no initial-pass analogue. The asymmetry is deliberate and documented — [ADR 0003:53](../docs/adr/0003-forecasts-scoring-calibration-cross-run-intelligence.md:53) requires completion candidates to sit outside the inclusive 0.40–0.60 band while in-band primary Predictions remain valid telemetry — but it means a candidate can be rejected at completion that would have been accepted had the initial pass emitted it. Telemetry must not present the two gates as equivalent.
- On a completion attempt, `payloadBlocks` is always present. `[]` means the captured evidence object had no keys and should fail a unit invariant because `sources` is mandatory. `undefined` remains reserved for stages without a completion pass.

Project the codes, contract status, and payload blocks into `analytics.json`. Extend the terminal analytics line to print codes or `reason-contract-missing`.

#### Files

- [src/domain/types.ts:678](../src/domain/types.ts:678)
- [src/research/report-assembly.ts:54](../src/research/report-assembly.ts:54)
- [src/research/prompts/final-synthesis.ts:519](../src/research/prompts/final-synthesis.ts:519)
- [src/research/prompts/final-synthesis.ts:704](../src/research/prompts/final-synthesis.ts:704)
- [src/research/final-synthesis.ts:50](../src/research/final-synthesis.ts:50)
- [src/research/final-synthesis.ts:599](../src/research/final-synthesis.ts:599)
- [src/research/orchestrator.ts:225](../src/research/orchestrator.ts:225)
- [src/research/run-analytics.ts:133](../src/research/run-analytics.ts:133)
- [src/research/run-analytics.ts:759](../src/research/run-analytics.ts:759)
- [src/research/run-analytics-console.ts:99](../src/research/run-analytics-console.ts:99)
- [docs/adr/0003-forecasts-scoring-calibration-cross-run-intelligence.md:44](../docs/adr/0003-forecasts-scoring-calibration-cross-run-intelligence.md:44)
- [tests/orchestrator-completion.test.ts:765](../tests/orchestrator-completion.test.ts:765) — **breaks under this phase (assumption audit).** It asserts `Object.keys(completionPrompt.requiredShape)` equals `["predictions"]`; adding `declineReasonCodes` fails it. Update the assertion rather than loosening it to a partial match.
- [CONTEXT.md:125](../CONTEXT.md:125) — **added in validation.** This phase introduces domain terms (decline reason code, completion telemetry status) and AGENTS.md requires a new domain term to land in `CONTEXT.md` in the same change. Extend the existing `## Forecast Completion Pass` entry with the decline-reason contract; do not paraphrase the terms into generic finance words.

#### Golden churn

- Prompt baseline hashes: expected.
- Nine fixture `analytics.json` goldens: expected. Existing cassettes omit the new codes, so they must record an empty code list and `declineReasonContractSatisfied: false`.
- Fixture `report.json` and `report.md`: none.
- The fixture refresh is intentionally output-changing. `--write-golden` is permitted only for those nine analytics changes, and the commit body must state the reason.
- Existing files under `data/runs/` remain untouched.

#### Tests

- [tests/prompt-final-synthesis.test.ts:830](../tests/prompt-final-synthesis.test.ts:830): required shape contains exactly `predictions` and `declineReasonCodes`.
- [tests/orchestrator-completion.test.ts:16](../tests/orchestrator-completion.test.ts:16): empty response with valid codes produces `declined-empty`, codes, and satisfied contract.
- [tests/orchestrator-completion.test.ts:77](../tests/orchestrator-completion.test.ts:77): missing `predictions` remains `no-parsable-candidates`; do not mislabel it as a model decline.
- Add an explicit empty-array response without codes. Assert contract failure rather than silent `[]`.
- [tests/orchestrator-completion.test.ts:492](../tests/orchestrator-completion.test.ts:492): partial improvement requires a reason code for residual shortfall.
- [tests/orchestrator-completion.test.ts:604](../tests/orchestrator-completion.test.ts:604): deterministic rejection reasons remain separate.
- `tests/run-analytics.test.ts`: trace fields reach analytics unchanged.
- `tests/run-analytics-console.test.ts`: missing contract and valid codes render distinctly.
- `tests/orchestrator-artifacts.test.ts`: `stages.json` labels steering as reconstructed and records exact payload blocks.
- Replay all nine completion fixtures with `--check-golden` after the intentional refresh.
- Final verification remains `bun run check`.

#### Objective checks

Testable without live model use:

```text
empty predictions + valid code:
  trace.predictionCompletion.declineReasonContractSatisfied == true
  analytics.predictions.completion.declineReasonCodes.length >= 1

empty predictions + omitted code:
  declineReasonContractSatisfied == false

AMD-like prompt fixture:
  payloadBlocks contains sources, webSources, latestClose
  payloadBlocks omits earningsSetup, optionsIv, priorCalibration
```

Live-only check, deferred until the next run performed for independent reasons:

```text
if outcome == "declined-empty":
  declineReasonContractSatisfied == true
  declineReasonCodes.length >= 1
```

Do not spend a deep run solely to settle this check.

#### Hit-every-surface classification

| Chain entry | Classification |
|---|---|
| Collector | N/A. No evidence producer changes. |
| Projection | Touched in run analytics projection. Report Extras projection remains N/A. |
| Reader types | Touched in `PredictionCompletionAudit` and `RunAnalytics`. |
| Artifact schema | `report/schema.ts` is N/A because the audit is not part of `ResearchReport`. `trace.json`, `analytics.json`, and `stages.json` shapes change. |
| Markdown renderers | N/A. Decline codes remain operational telemetry, not report prose. |
| Source-ID traversal | N/A. No cited report field is added. |
| Console view model | Research Console app is N/A in this phase. Terminal analytics renderer is touched. |
| Console component | N/A. |
| Run Artifact Index | Deferred to phase 4 after the telemetry contract is stable. |
| Tests and goldens | Touched as listed. |

#### ADR impact

Amend ADR 0003 in the same phase. Document the reason-code contract, its diagnostic-only status, and that it cannot mandate Prediction emission or alter scoring.

ADR 0001 needs no amendment because persisted values come from a closed code union, not model-authored prose. Free-form reasons would require an ADR 0001 classification before implementation.

### Phase 3: state the disclosed shortfall explicitly

> **Sequencing note (validation):** phases 2 and 3 both rewrite the same return-shape sentence at
> [final-synthesis.ts:550](../src/research/prompts/final-synthesis.ts:550) —
> phase 2 must change "containing only a predictions array" to admit `declineReasonCodes`, and phase 3
> prepends the shortfall sentence. Phase 3 rebases onto phase 2's wording rather than the current text,
> and the prompt baseline refreshes twice, once per phase.

#### Required behavior

Change the opening instruction at [final-synthesis.ts:550](../src/research/prompts/final-synthesis.ts:550) to state all three values:

```text
The accepted report currently contains 3 Observable Predictions against a soft target of 5; 2 remain unfilled and any residual shortfall will be disclosed.
```

Then retain:

- `up to 2 additional forecasts`
- the empty-array allowance
- the Near-Base-Rate rule
- all subject, citation, and redundancy gates
- the closing no-padding clause

Derive current, target, and missing counts from `existingPredictions.length` and `requestedCount`. Do not introduce another configuration value.

Absence behavior:

- `requestedCount` is already positive whenever the completion pass runs.
- If that invariant is violated in a direct unit call, state zero remaining rather than producing a negative count, or reject it at the typed caller boundary. Do not silently emit contradictory counts.
- No report section is added. `predictionShortfall` remains the canonical reader-facing disclosure.

#### Files

- [src/research/prompts/final-synthesis.ts:519](../src/research/prompts/final-synthesis.ts:519)
- [tests/prompt-final-synthesis.test.ts:531](../tests/prompt-final-synthesis.test.ts:531)
- [tests/prompt-final-synthesis-shape.test.ts:560](../tests/prompt-final-synthesis-shape.test.ts:560)
- `tests/support/prompt-baseline.golden.json`

#### Golden churn

- Prompt baseline hashes: expected.
- Fixture report and analytics goldens: none.
- No fixture `--write-golden`.

#### Tests

- Existing 3, target 5, requested 2 produces the exact current/target/missing sentence.
- Empty existing list with requested 5 produces 0/5/5.
- The instruction still contains the empty-array and no-padding clauses.
- The required response shape from phase 2 remains unchanged.
- Final verification remains `bun run check`.

#### Objective checks

No live run is needed to prove prompt construction. A stage built from the AMD fixture must include `3`, `5`, and `2` in the explicit shortfall sentence.

Only a future organic live cohort can answer whether the change raises acceptance. One run is insufficient to establish that. Track at least the next comparable completion attempts through phase 4 telemetry.

#### Hit-every-surface classification

| Chain entry | Classification |
|---|---|
| Collector | N/A. |
| Projection | Prompt projection touched. Report Extras projection N/A. |
| Reader types | N/A. |
| Artifact schema | N/A. |
| Markdown renderers | N/A. Existing `predictionShortfall` rendering remains canonical. |
| Source-ID traversal | N/A. |
| Console view model | N/A. |
| Console component | N/A. |
| Run Artifact Index | N/A. |
| Tests and goldens | Touched as listed. |

#### ADR impact

No amendment. The change states ADR 0003’s existing soft-target and disclosure policy more clearly without changing it.

### Phase 4: aggregate completion outcomes across runs

#### Required behavior

Extend the `runs` index row with:

- `completion_telemetry_status`: `recorded`, `not-attempted`, or `unavailable`
- `completion_outcome`
- `completion_accepted_count`
- `completion_rejected_count`
- `completion_decline_contract_satisfied`

Semantics:

- Valid analytics with `predictions.completion` gives `recorded`.
- Valid analytics without completion gives `not-attempted`. This covers target met, low evidence quality, or zero target.
- Missing or malformed analytics gives `unavailable`.
- Counts remain nullable unless status is `recorded`. Never convert missing telemetry to zero.
- A recorded attempt with zero accepted remains numeric zero, distinct from unavailable.
- Bump the SQLite schema version. Keep the existing no-auto-migration policy.
- Make disk fallback summaries read the same analytics projection as indexed summaries.
- Extend `RunSummary` and its API guard with the completion summary.
- Add dashboard metrics: recorded attempts, improved attempts, total accepted by completion, and unavailable telemetry count.
- Show a compact completion line on the existing Forecasts dashboard card. Do not add a new dashboard section.

#### Files

- [src/run-artifact-index-schema.ts:3](../src/run-artifact-index-schema.ts:3)
- [src/run-artifact-index-schema.ts:19](../src/run-artifact-index-schema.ts:19)
- [src/run-artifact-index-types.ts:14](../src/run-artifact-index-types.ts:14)
- [src/run-artifact-index-rows.ts:98](../src/run-artifact-index-rows.ts:98)
- [src/run-artifact-index.ts:222](../src/run-artifact-index.ts:222)
- [src/run-artifact-index.ts:347](../src/run-artifact-index.ts:347)
- [src/run-artifact-projection.ts:35](../src/run-artifact-projection.ts:35) — signature change: `runSummaryFromReport` currently takes `report` only
- [src/run-artifacts.ts:101](../src/run-artifacts.ts:101) — **missing step, added in validation.** The status trichotomy needs `analytics.json`, but `loadRunArtifact` never reads it and `RunArtifact` has no analytics field. Add the load and a carrier field. There is a precedent to copy rather than invent: `WebSubjectProfileRunArtifact` already declares `readonly analytics?: unknown` ([run-artifacts.ts:146](../src/run-artifacts.ts:146)) and `scanWebSubjectProfileRunArtifacts` already loads it ([run-artifacts.ts:564](../src/run-artifacts.ts:564)). Index freshness is unaffected — `run-artifact-index-freshness.ts` stats only `MUTABLE_SIDECARS`, and `analytics.json` is write-once.
- [app/types.ts:18](../app/types.ts:18)
- [app/artifacts.ts:322](../app/artifacts.ts:322)
- [app/client/api.ts:24](../app/client/api.ts:24)
- [app/client/view-model.ts:283](../app/client/view-model.ts:283)
- [app/client/components/dashboard-overview.svelte:33](../app/client/components/dashboard-overview.svelte:33)
- `tests/run-artifact-index.test.ts`
- `tests/run-artifact-projection.test.ts`
- `tests/research-console-artifacts.test.ts`
- `tests/research-console-view-model.test.ts`

#### Golden churn

- Fixture report, markdown, and analytics goldens: none.
- SQLite schema version changes only.
- No `--write-golden`.

#### Tests

- Index a run with recorded `declined-empty`, zero accepted, and satisfied reason contract. Assert exact SQL columns and `RunSummary`.
- Index an `improved` stub artifact and assert accepted count.
- Valid analytics without completion produces `not-attempted` and null outcome/counts.
- Missing and malformed analytics produce `unavailable`, never zero accepted.
- Rebuild and write-through paths both populate identical columns.
- Disk fallback and indexed summaries are equal.
- API guard accepts valid completion telemetry and rejects malformed values.
- Dashboard metrics exclude `not-attempted` and `unavailable` from the completion success denominator.
- Final verification remains `bun run check`.

#### Objective checks

No live model call is required.

Against a temporary test index:

```sql
SELECT completion_outcome, COUNT(*), SUM(completion_accepted_count)
FROM runs
WHERE completion_telemetry_status = 'recorded'
GROUP BY completion_outcome;
```

Against the real repository index, the same check requires a user-authorized `index rebuild` because the schema version changes. AGENTS.md forbids performing that rebuild without asking. The implementation and `bun run check` can finish using temporary test indexes; the real data check waits for explicit approval.

#### Hit-every-surface classification

| Chain entry | Classification |
|---|---|
| Collector | N/A. |
| Projection | Touched in artifact-to-index and artifact-to-RunSummary projections. |
| Reader types | Touched in `RunRow`, `RunSummary`, and API validation. |
| Artifact schema | `report/schema.ts` remains N/A. SQLite schema is touched. |
| Markdown renderers | N/A. |
| Source-ID traversal | N/A. |
| Console view model | Touched for aggregate metrics. |
| Console component | Touched only in the existing Forecasts card. |
| Run Artifact Index | Touched across schema, rebuild, write-through, row projection, and reads. |
| Tests and goldens | Tests touched; artifact goldens unchanged. |

#### ADR impact

Update ADR 0003’s implementation section to name completion-outcome indexing as derived cross-run telemetry. No forecast or scoring policy changes.

## Live-run requirements

| Check | Requires a live run? |
|---|---|
| Macro omitted for AMD prompt | No |
| Macro retained for reachable FRED subject | No |
| Decline code parsing and persistence | No |
| Exact payload-block capture | No |
| Steering marked reconstructed | No |
| Explicit 3/5, 2-missing instruction | No |
| Index aggregation and dashboard counts | No model run; real index rebuild requires explicit approval |
| Whether acceptance improves | **Yes, only on future runs performed for independent reasons** |
| Whether anti-padding language causes declines | **Yes, and only after phase 2 provides diagnostic codes** |

## Deliberately not doing

- Do not forbid empty completion or force the soft target. ADR 0003 explicitly prefers fewer supported Predictions over padding.
- Do not loosen or remove the inclusive 0.40 to 0.60 completion rejection. The run-specific squeeze was not demonstrated. Changing it requires an ADR 0003 amendment and calibration evidence.
- Do not rebalance anti-padding wording now. Its causal role is unknown; phase 2 must collect reasons first.
- Do not enumerate NVDA, AVGO, or INTC in the prompt yet. Their source entries are already present, and no evidence shows naming them would create an off-band, nonredundant forecast.
- Do not restore the full evidence payload. The compact prompt still carries report narrative, critique, source catalog, and deterministic anchors. Payload insufficiency is not yet established.
- Do not add free-form decline prose. Controlled codes avoid confabulated explanations and an ADR 0001 classification problem.
- Do not add decline reasons to `ResearchReport`, markdown, or the reader-facing Prediction shortfall. Operational diagnosis belongs in trace, analytics, and the index unless a separate reader-facing policy is approved.
- Do not modify existing Run Artifacts under `data/`.
- Do not run `--live`, the fixture recorder, or `index rebuild`.
- Do not use `--write-golden` except for the intentional phase 2 analytics changes, with the reason recorded in the commit body.

## Definition of done

- Each phase lands with its tests.
- Prompt baselines update only with prompt changes.
- Phase 2 fixture analytics churn is isolated and explained.
- Fixture replay uses recorded cassettes only.
- Existing `data/` remains untouched.
- ADR 0003 updates land with the contract changes they document.
- `bun run check` passes. No narrower command may be reported as final verification.