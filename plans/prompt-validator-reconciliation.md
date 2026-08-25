# Plan: Prompt/Validator Reconciliation + Quality-Label Honesty

**Status:** draft (pre-validation)
**Target commit:** `5687068` (code identical to `83618f5`; the 3-commit delta is docs only)
**Source:** triage of the run-review for `2026-08-17T03-53-00-393Z-d3d9e27a` (VRT, `equity --deep`)

> `AGENTS.md` bans unsolicited planning docs. This one is solicited.

## Scope

Three findings, chosen because each is verified against code at HEAD, each is S–M effort, and
the first two are the **same defect class**: a prompt surface nudges the model toward output a
deterministic validator then rejects, and the rejection is silent from the prompt's point of view.

| # | Finding | Verified cause | Effort |
|---|---------|----------------|--------|
| A | Prediction completion dead-ends on an unstated horizon bound | `1–20` exists only in the validator | S |
| B | Web Subject Profile items rejected for out-of-allowlist sourceIds | `deterministicCitationGuidance` ships unconditionally into a stage with a narrower allowlist | S |
| C | Material-triage gaps coexist with `evidenceQuality: "high"` | failed `supplemental` lanes reach neither the label nor `limitingReasons` | M |

### Explicitly out of scope

- **Peer-universe fallback unreachable** (review finding 2). Real and verified —
  [peer-universe.ts:182](../src/research/peer-universe.ts) short-circuits on `status === "resolved"`,
  and the registry branch returns `resolved` for any non-empty peer set with no count floor and no
  comparability screen. Deferred because the fix requires deciding *what makes a registry peer set
  usable* (min count? market-cap band? SIC pre-screen?), and that policy choice deserves its own
  pass rather than being smuggled into a prompt-hygiene change.
- **No failure-path persistence** (review finding 5). Verified: `synthesizeReportUntilValid`
  ([orchestrator.ts:740](../src/research/orchestrator.ts)) is unguarded and
  `persistRunArtifactWrites` sits 167 lines downstream. Deferred because it changes orchestrator
  control flow and introduces a new artifact shape (a partial/failed run dir) that the Run Artifact
  Index, history rebuild, and console all have to tolerate — a much wider blast radius.
- **Finnhub 403 gap cardinality** (review finding 6). Presentation-layer only; emission must stay
  per-adapter because lane `gapMatches` and `ESTIMATE_ADAPTERS` both key on `gap.source`.
- Review findings 7 (config) and 8 (subsumed by A).

---

## A. State the horizon bound on the prompt surface

### Problem

[observable-candidates.ts:106-111](../src/forecast/observable-candidates.ts) rejects any
`horizonTradingDays` outside `1–20`. That bound appears in **no prompt**: not in
`src/research/prompts/`, not in `prompts/`. Meanwhile two surfaces actively push toward horizon
variety without naming the ceiling:

- [prediction-coverage.ts:88](../src/research/prompts/prediction-coverage.ts) — "Use a different
  exact horizon only when evidence supports that horizon."
- [final-synthesis.ts:287](../src/research/prompts/final-synthesis.ts) — "vary the subject, kind,
  or horizon."

The DSL grammar the model actually reads for field shape,
`predictionDslInstruction` ([final-synthesis.ts:192-213](../src/research/prompts/final-synthesis.ts)),
introduces `+N` in every clause and never says what `N` may be.

This is the same class already fixed on the *kind* axis — see the `^VIX` gating comment at
[prediction-coverage.ts:19-21](../src/research/prompts/prediction-coverage.ts) and
[final-synthesis.ts:65](../src/research/prompts/final-synthesis.ts), both citing "the burned ^VIX
candidate in the 2026-07-05 review". The horizon axis never got the same treatment.

### Change

1. In [observable-candidates.ts](../src/forecast/observable-candidates.ts), replace the magic
   numbers with exported constants:
   ```ts
   export const MIN_PREDICTION_HORIZON_TRADING_DAYS = 1;
   export const MAX_PREDICTION_HORIZON_TRADING_DAYS = 20;
   ```
   Interpolate them into the existing rejection message so validator and prompt cannot drift.
2. Re-export both from the [observable.ts](../src/forecast/observable.ts) barrel, alongside the
   existing `MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS` / `RELATIVE_FORECAST_EQUAL_PROBABILITY_EPSILON`
   precedent — that is exactly how prompt modules already consume forecast constants.
3. Append one clause to `predictionDslInstruction`'s return string naming the legal range for `N`.

**Why this single insertion point:** `predictionDslInstruction` is called by **both**
`buildPrimaryPredictionInstruction` and `buildPredictionCompletionInstruction`
([final-synthesis.ts:547](../src/research/prompts/final-synthesis.ts)), so one edit covers the
initial emit and the completion pass — the path that actually burned the VRT candidate. It is also
the string that introduces `N`, so the bound lands where the reader needs it.

### Decisions on open questions

- **Do not also edit the repair prompt at :287.** The repair path already receives the accumulated
  validator error text, which now interpolates the same constants — restating the bound there is
  redundant prompt bloat.
- **Do not add a retry to the completion pass.** `runPredictionCompletion`
  ([final-synthesis.ts:556](../src/research/final-synthesis.ts)) is deliberately single-shot: one
  model call, merge, return. Adding a retry spends a live model call per run to recover a case the
  prompt fix should make rare, and it cannot be verified without a live run (forbidden by
  `AGENTS.md` Blast radius). Revisit only if a post-fix run still shows
  `outcome: "all-candidates-rejected"` with unfilled slots.

### Verification

- Unit test asserting `predictionDslInstruction` output contains the bound, and that the validator
  message and the prompt clause derive from the same constants.
- Unit test at the validator seam: `horizonTradingDays: 21` still yields `invalid-horizon`.
- `UPDATE_PROMPT_BASELINE=1 bun test tests/prompt-baseline.test.ts` — prompt strings are hashed in
  [tests/support/prompt-baseline.golden.json](../tests/support/prompt-baseline.golden.json) and
  **any** prompt edit fails that test until the goldens are refreshed.
- Fixture goldens should **not** move: the LLM cassette is keyed stage|model, not prompt text.

---

## B. Stop shipping snapshot-citation guidance into the profile stage

### Problem

The review guessed the profile allowlist excludes gathered web source IDs. **That is false** — I
checked. The validator allowlist
([web-subject-profile.ts:132](../src/web-evidence/web-subject-profile.ts), fed by `allowedSources`
at [web-evidence-phase.ts:76](../src/web-evidence/web-evidence-phase.ts)) is `web` +
`isCompanyProfileSecSource`, and the prompt's `evidence.webSources` array uses the **identical
filter** ([evidence-payload.ts:141-146](../src/research/prompts/evidence-payload.ts)). Symmetric.

The actual conflict: `deterministicCitationGuidance`
([evidence-payload.ts:221](../src/research/prompts/evidence-payload.ts), spread unconditionally at
[:294](../src/research/prompts/evidence-payload.ts)) ships into **every** stage payload, including
`web-subject-profile`, and reads:

> For exact numeric market claims, cite deterministic snapshot sourceIds from marketSnapshots,
> supplementalMarketSnapshots, marketContext, extendedEvidence, verifiedMarketSnapshot, or
> verifiedRepresentativeSnapshots when available.

None of those ids are in the profile allowlist. Meanwhile
[prompts/web-subject-profile/base.md:15](../prompts/web-subject-profile/base.md) says to cite only
from `evidence.webSources`. The two instructions contradict each other, and `companyKpis` — a
numeric-claim field, and one of the three the review reports rejected — sits exactly on the fault
line. `readAnswer` rejects the **whole item** on any disallowed id
([web-subject-profile.ts:393-400](../src/web-evidence/web-subject-profile.ts)); the "no partial"
comment at [:430](../src/web-evidence/web-subject-profile.ts) confirms all-or-nothing, which is how
one stray snapshot id nulls an entire `subjectSummary`.

### Change

Make the guidance stage-aware inside `buildEvidencePayload`, keyed off the existing
`EvidencePayloadOptions.webSourceText === "profile"` discriminator — the field the module's own
comment already describes as the stage-specific projection knob. For the profile stage, emit a
profile-scoped string that names the actual allowlist instead of the snapshot sources, e.g.
citations must come from `evidence.webSources` and numeric KPI claims must be attributed to the
filing or web source that states them.

**Why not a new option field:** a per-call-site boolean invites drift the moment a new stage is
added. Deriving from the existing discriminator keeps one knob and matches the "no stage
conditionals in the builder body" comment at
[evidence-payload.ts:48-56](../src/research/prompts/evidence-payload.ts).

### Open question — decided

Should the profile validator instead *tolerate* snapshot ids? **No.** The narrow allowlist is the
point: the profile is a web/filing-derived artifact, and admitting snapshot ids would let it launder
market numbers through a stage that never saw them. Fix the instruction, not the guard.

### Verification

- Unit test: profile-stage payload does **not** contain the snapshot-citation sentence; a
  final-synthesis payload still does.
- Unit test at `readAnswer`: an answer citing a snapshot id is still rejected (guard unchanged).
- Refresh `prompt-baseline.golden.json`.
- Fixture goldens unchanged (cassette keying, as above).

---

## C. Make supplemental-lane failures visible in the quality assessment

### Problem — with a correction to the review

The review blamed the `supportabilityFailed` guard being scoped to `lane === "target-valuation"`
([evidence-quality.ts:76-77](../src/research/evidence-quality.ts)). **That is not what let the VRT
run through.** `peer-valuation`'s `sourceIds` resolves to `[]` whenever
`valuationSupportability !== "supported"`
([source-plan.ts:395-397](../src/research/source-plan.ts)), so the lane is already uncovered and its
check already fails on `coverage`. Generalizing `supportabilityFailed` would change nothing.

The real cause is one level up. [source-plan.ts:391-392](../src/research/source-plan.ts) declares
`peer-valuation` as `evidenceClass: () => "supplemental"`, and
[evidence-quality.ts:102-117](../src/research/evidence-quality.ts) only ever consults `core` and
`material`:

```ts
const failedCore = checks.filter((c) => c.evidenceClass === "core" && !c.passed);
const failedMaterial = checks.filter((c) => c.evidenceClass === "material" && !c.passed);
...
limitingReasons: [...failedCore, ...failedMaterial].flatMap((c) => c.reasons),
```

A failed `supplemental` lane is therefore invisible in **both** the label and `limitingReasons` —
the run reports `high` with an empty reason list while peer valuation is entirely unusable. Two axes
(gap triage: `material`/`diagnostic`; lane class: `core`/`material`/`supplemental`) disagree, and
only the lane axis reaches the headline.

### Change

Add `advisoryReasons: readonly string[]` to `EvidenceQualityAssessment`
([types.ts:510-520](../src/domain/types.ts)), populated from failed `supplemental` checks. Bump
`rubricVersion` to `3` and extend the existing versioning comment — prior rubric versions must stay
assignable so persisted assessments keep parsing.

**Label stays unchanged.** Promoting supplemental failures into the label would reclassify a large
share of the fleet from `high` to `medium` in one commit and shift every fixture golden, for a
policy call nobody has made. Surfacing the reason is the honest minimum; reclassification is a
separate, deliberate decision.

### Surface chain (per `AGENTS.md` "Hit every surface")

The assessment is carried whole, not field-by-field, which keeps this short:

1. `src/domain/types.ts` — add the field, bump `rubricVersion`.
2. `src/research/evidence-quality.ts` — populate it.
3. `src/research/run-trace.ts` → `trace.json` — spread, no change expected.
4. `src/research/run-analytics.ts:739-740` → `analytics.json` — spread, no change expected.
5. `src/report/schema.ts` — confirm the assessment is schema-validated and admit the new field.
6. `src/research/quality-driver.ts:144-165` — `evidenceDriverParts` filters `core`/`material`;
   confirm it still behaves and decide whether advisory reasons belong in the driver string
   (default: **no**, drivers explain the label and advisory reasons do not set it).
7. Console view model + component — display only; confirm nothing breaks on the new field.

### Decisions on open questions

- **Not chosen: reclassify `peer-valuation` to `material`.** Wider blast radius, changes the label
  fleet-wide, and it is a research-policy call rather than a telemetry bug.
- **Not chosen: fold advisory reasons into `limitingReasons`.** Cheapest, but "limiting" would then
  name something that limits nothing — the exact kind of telemetry dishonesty this finding is about.
- **Absence handling:** a run with no failed supplemental lanes emits `advisoryReasons: []`, not
  `undefined`. Per `AGENTS.md`, `undefined` and `[]` are different, and the empty array is the
  correct "checked, nothing to report" signal.

### Verification

- Unit test in [tests/evidence-quality.test.ts](../tests/evidence-quality.test.ts): a failed
  supplemental lane produces a non-empty `advisoryReasons` and leaves `label` at `high`.
- Off-path test: no failed supplemental lanes ⇒ `advisoryReasons: []`.
- [tests/orchestrator-evidence-quality.test.ts](../tests/orchestrator-evidence-quality.test.ts) —
  confirm the field reaches the trace.
- Fixture goldens **will** move here (`analytics.json`, possibly `report.json`). This is an
  intentionally output-changing change, so `--write-golden` is warranted and the commit body must
  say so.

---

## Sequencing

A and B are independent and touch disjoint files — safe in either order, or in parallel.
C touches `src/domain/types.ts` and the goldens, so it lands **last** to keep the golden refresh in
one commit with a clear "intentionally output-changing" note.

## Definition of done

- `bun run check` passes (the only thing reportable as passing).
- `prompt-baseline.golden.json` refreshed in the same commit as the prompt edits.
- Golden refresh for C isolated to C's commit, with the reason in the commit body.
- Tests ship with the code. No `--no-verify`, no `Co-authored-by`.
- No live run, no `--live`, no recorder, nothing deleted under `data/`.

## Residual risk

The VRT artifacts are **not present in this checkout** (`data/runs/` does not exist), so every
artifact-level claim in the source review is unverified. All three changes above are justified by
code read at HEAD and stand independently of whether the reported run values are accurate — but the
*prevalence* claims (the 11/14 shortfall, the 9-of-22 rejection count) remain unconfirmed.
