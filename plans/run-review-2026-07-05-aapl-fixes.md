# Run-review fixes — 2026-07-05 AAPL deep run

**Reviewed run:** `data/runs/2026-07-05T09-37-04-124Z-1fe08db4` (AAPL equity, deep; the Phase B–E
verification run, dirty worktree at commit `69f17c9`).
**Baseline:** `data/runs/2026-07-05T09-25-57-961Z-057aced8` (same jobType/assetClass/symbol/horizon,
11 min earlier). Secondary reference: `data/runs/2026-07-04T11-33-32-265Z-507152f9`.

This file records the validated findings from the run-review, an external LLM's validation of them,
and the phased implementation plan. It is the authority for implementing these fixes.

---

## Validated findings

Confirmed against artifacts; the external reviewer independently validated all and corrected two.

| # | Finding | Severity | Evidence |
|---|---------|----------|----------|
| 1 | Fresh web evidence gathered but 0% cited | HIGH | `analytics.json:webSources` = `{accepted:17, profileUsed:0, reportCited:0, unused:17, usageRatio:0}` + `usageWarning`; `reusedProfileWebSources` = `{accepted:11, reportCited:10}`. `runShape.stages[web-gather].tokenEstimate`=42,844 spent. Baseline identical (17/0/0). |
| 3 | Duplicate source IDs in `report.sources` | MED | `report.json:sources` = 77 entries, 75 unique; `web-aapl-0fdf7c34` and `web-aapl-cbbca0e2` each appear twice (same URL/title). Pre-Phase-D `2026-07-04` run clean (57/57). `reportIntegrity` audit did not flag it. |
| 2 | Completion pass wastes candidates on redundant/disallowed shapes | MED-HIGH | `trace.json:predictionCompletion.rejectionReasons` = QQQ relative @5d ("accepted benchmark SPY is equivalent in class broad-us-index") and `subject "^VIX" is not in the allowed set`. `analytics.json:predictions` = `{count:3, targetCount:5, targetMet:false, shortfall.missingCount:2}`. |
| 4 | Horizon diversity collapsed to a single 5d bucket | MED | `analytics.json:predictions.horizonTradingDays` = `{min:5,max:5,average:5}` vs baseline `{min:3,max:5,avg:4.33}` and 07-04 `{min:3,max:5,avg:4.5}`. All 4 trim/reject messages reference 5-trading-day forecasts. |
| 5 | Steering text sent to the model is not recorded | LOW-MED | `stages.json` records only `{stage,content,tokenEstimate,attempt?,repromptReason?}` (`StageOutput`, `src/research/final-synthesis.ts:30-38`); prompt built inline in `runStage` (`src/research/orchestrator.ts:194-206`) and discarded. Grep for steering phrases in `stages.json` returns nothing. |
| 7 | Config/provider-plan gaps (context, not code) | LOW | `normalized/source-gaps.json`: `tradier-options`/`earnings-setup-implied-move` (token unset), `finnhub-events-2/-3` (403), `massive-supplemental-market` (plan). These recur, but do not cap this run's Evidence Quality: derivatives-volatility is supplemental, the Finnhub event gaps leave corporate-events covered elsewhere, and Massive is a non-capping `market-data` capability gap (`evidenceQualityImpact: no-cap`), not a supplemental lane. **Not fixed here.** |

**Clean (no finding):** cited-source integrity — every prediction/finding `sourceIds` entry resolves
in `report.sources`; no duplicate `(source,message)` gaps; all scores correctly `pending`
(`horizon not yet elapsed`; late-June 5-trading-day forecasts resolve 2026-07-06 given the
2026-07-03 holiday); `calibrationAtGeneration` slices `slice-unavailable` because
`data/calibration/summary.json:resolvedCount=0`.

**Improvements vs baseline (context):** `nearBaseRateCount` 2→0, `informativeCount` 1→3,
`signalTargetMet` false→true; synthesis attempts 3→2; run tokens 438,187→390,893. Phase B verified
(`calibrationAtGeneration.generatedAt` = run start). Phase E verified (attempt/`repromptReason`
metadata present; no `costEstimateUsd` in `trace.json` — absent, not zero). SPY/QQQ equivalence
class fires (`trace.json:predictionTrimWarnings[0]` names `broad-us-index`).

## External validation — corrections adopted

- **#2 overstated → corrected.** The completion prompt *does* send covered kinds/horizons +
  preferred subjects (`buildPredictionCompletionInstruction`, `src/research/research-context.ts:796-809`).
  What's missing is **allowed-subject semantics** and **benchmark-equivalence vocabulary**
  (`broad-us-index` constants are module-private in `src/forecast/observable.ts:1005-1006`). Bonus
  root cause: `predictionDslInstruction` (research-context.ts:714-720) advertises `^VIX` volatility
  to every equity run even when `^VIX` is not an allowed subject — the prompt nudges candidates the
  validator (`resolveCandidate`, observable.ts:932-946) must reject.
- **#6 ("ages indefinitely") overstated → deferred.** Company profile reuse is bounded by a 30-day
  TTL (`MARKET_BOT_WEB_PROFILE_COMPANY_REUSE_DAYS`, `src/config.ts:166`) plus an SEC-filing
  freshness gate (`isReusableProfile`, `src/research/web-subject-profile-reuse.ts:126-157`). Not
  indefinite; **no fix planned.** Revisit if the web-usage warning persists after Phase 3, or if
  live runs show material non-filing changes contradicting or bypassing the reused profile.

---

## Plan

Constraints (AGENTS.md): research-only boundary (ADR 0001), observable predictions (ADR 0004),
Bun + oxc only, tests ship in the same commit, no speculative abstraction, `bun run check` at each
phase boundary. Pre-work below must be cleared before Phase 1; after that, phases are independently
landable in the order below.

Out of scope: profile folding/aging (bounded, see above), config/provider gaps (finding #7 —
environment), Research Console UI.

### Pre-work — reconcile the current working tree

At validation time the tree is not a clean base:

- `plans/run-review-2026-07-05-aapl-fixes.md` is untracked.
- `AGENTS.md`, `src/forecast/observable.ts`, `src/research/research-context.ts`,
  `tests/research-context.test.ts`, and `tests/schema-predictions.test.ts` have uncommitted changes.
- The existing `research-context.ts` diff already changes the benchmark-equivalence wording in
  `buildForecastDiversityGuidance`.
- The existing `tests/schema-predictions.test.ts` diff adds validator coverage even though the
  original Phase 3 said not to touch that file.

**Required before Phase 1:** explicitly commit, revert, or fold these changes into the relevant
phase. Do not start "one commit per phase" work until this is resolved; otherwise the phase boundary
and test-in-same-commit claims are false from the first commit.

### Behavioral verification rule

Unit tests can prove only deterministic prompt/projection/recording behavior. They cannot prove the
model will cite fresh web sources or avoid bad completion candidates.

For Phases 3 and 4, live verification must report distributions across **three** comparable AAPL
deep profile-reuse runs, not a single boolean. Record at least: `reportCited`, `usageRatio`,
presence/absence of `usageWarning`, completion rejection reasons, prediction count, and horizon
spread. If run budget is not approved, mark the phase as deterministic-only and do not claim the
behavioral finding is fixed.

**Current status:** deterministic checks pass, but no post-change AAPL run exists. Phases 3 and 4
remain behaviorally unverified until the three-run distribution check below is completed.

### Phase 1 — Dedupe web source IDs on gather merge (finding #3)

**Goal:** a URL present in both the reused profile and the fresh gather appears once in
`collectedSources.extendedSources` and therefore once in `report.json:sources`.

**Root cause:** `attachReusableWebSubjectProfile` merges reused-profile sources into
`extendedSources` (deduped, `src/research/web-subject-profile-reuse.ts:168-174`); then
`mergeToolOutput` (`src/research/web-gather-loop.ts:790-802`) appends fresh gather sources via
plain spread with no ID check. IDs are `web-<subject>-<sha256(url)[0:8]>`
(`src/sources/web-gather-emit.ts:368-371`), so the same URL collides deterministically.

**Changes:**
- `src/research/web-gather-loop.ts` — in `mergeToolOutput` (line ~800), filter `output.sources`
  to IDs not already present in `collectedSources.extendedSources` (first occurrence wins; the
  reused-profile copy is already cited by the profile digest). Keep the merge otherwise untouched.

**Tests:** extend the source-merge test in `tests/web-gather-loop.test.ts:206` — gather output
containing a source whose ID already exists in `extendedSources` merges to a single entry; distinct
IDs still append.

**Verification:** unit tests; on the next AAPL deep run,
`jq '(.sources|length) == ([.sources[].id]|unique|length)'` on `report.json` is `true`.

**Risk:** minimal. Do not dedupe by URL (IDs are already URL-derived); do not touch `buildSourceList`
(`src/research/report-assembly.ts:236-246`) — fixing the root seam keeps one owner for the invariant.

### Phase 2 — Record steering text on synthesis stage records (finding #5)

**Goal:** artifacts can prove what steering the model was actually sent, so "prompt missing guidance"
vs "model ignored guidance" is decidable from a run directory before behavioral prompt changes are
evaluated.

**Changes:**
- `src/research/research-context.ts` — keep `buildStagePrompt` returning a string. Add a small helper
  such as `buildStageSteeringSegment(...)` that returns only the steering block sent for
  final-synthesis:
  - primary prediction instruction when `predictionCompletion` is absent,
  - completion instruction when `predictionCompletion` is present,
  - repair instruction when prediction-reprompt errors are present.
  Have `buildStagePrompt` call the same helper so prompt construction and recorded steering share
  the same text-building path.
- `src/research/final-synthesis.ts` — add optional `steering?: string` to `StageOutput` (lines
  30-38), populated where `attempt`/`repromptReason` are already stamped.
- `src/research/orchestrator.ts` — `runStage` computes the steering segment with the same arguments
  used for `buildStagePrompt` and attaches it to the returned `StageOutput`; `stages.json` write at
  line 807 needs no change.
- Record **only** the steering block, never the full prompt (~50-65k tokens/stage).

**Tests:** follow the Phase-E pattern (force a `StageReprompt` in a unit test): assert final-synthesis
records carry `steering` containing the primary prediction instruction on attempt 1 and repair or
completion steering on later attempts. Do not assert Phase 4's new `broad-us-index` vocabulary in
this phase; Phase 4 can extend the assertion after the vocabulary exists.

**Verification:** deterministic tests; on the next reprompting run, `stages.json` final-synthesis
records include `steering`.

**Risk:** small `StageOutput` optional-field ripple. Avoid changing `buildStagePrompt`'s return type:
there are about 30 string-returning call sites in `tests/research-context.test.ts` and
`tests/verified-market-snapshot.test.ts`.

### Phase 3 — Make fresh web evidence citeable at final-synthesis (finding #1)

**Goal:** fresh gather results carry usable content into synthesis so the model can cite enough of
them to clear the current-run web-source usage warning on reuse-path runs. `reportCited > 0` is only
a smoke signal; the actual success bar is `usageWarning` absent.

**Root cause:** at `final-synthesis`, `projectWebSources` (`src/research/research-context.ts:217-247`)
sets `includeModelVisibleText = stage === "web-subject-profile"` → fresh web sources are projected
as bare `{id,title,publisher,fetchedAt}` with `summary`/`snippet` stripped, while the reused profile
arrives as a rich pre-cited digest (`projectWebSubjectProfile`, lines 249-266) that the synthesis
instruction explicitly points at (lines 854-856). The model cites the only web content it can see.

**Changes:**
- `src/research/research-context.ts`, `projectWebSources`:
  - Include model-visible text at `final-synthesis` as well, but **only for web sources not already
    covered by the attached profile** (filter `source.id` against
    `collectedSources.webSubjectProfile?.sourceIds`) — profile-covered sources stay bare since their
    facts already arrive via the digest. Include `summary`; include `snippet` only when `summary`
    is absent (token control).
  - Keep the existing `web-subject-profile` stage behavior (summary + snippet + SEC sources) unchanged.
- `src/research/research-context.ts`, `webSubjectProfileInstruction` (lines 854-856): append one
  sentence telling the model that web sources carrying a `summary` in `webSources` were gathered this
  run and may be cited for recency/corroboration beyond the profile; keep the existing low-trust
  framing verbatim (web text is untrusted content — sanitized at ingest, see
  `analytics.modelInputSanitization`, but the trust instruction must stay).

**Token budget:** ~17 fresh sources × one sanitized summary ≈ 2–4k tokens on a ~65k final-synthesis
stage. Acceptable; the profile-covered-ID filter keeps it bounded. Do not add truncation logic — the
sanitizer already caps field sizes.

**Tests:** `tests/research-context.test.ts` (projector coverage lives here):
- `final-synthesis` with an attached profile: a web source outside `profile.sourceIds` projects with
  `summary`; a profile-covered web source projects without it.
- `final-synthesis` with no profile: fresh web sources project with `summary`.
- Instruction test: synthesis prompt mentions citeable fresh web sources when a profile is attached.

**Verification:** deterministic tests, then live AAPL deep runs on the reuse path:
`usageWarning` absent. The warning fires when there are at least four current-run web sources and
`usageRatio < 0.25` (`src/research/run-analytics.ts:525-530`), so a 17-source run needs at least
five current-run sources in the used union. See the behavioral verification rule: report three-run
distributions, not a single pass/fail.

**Risk:** enlarges the low-trust text surface in the synthesis prompt. Mitigated by the existing
ingest sanitizer and unchanged low-trust instruction. Watch
`runShape.stages[final-synthesis].tokenEstimate` on the verification run; if growth exceeds ~10k,
revisit the summary-only choice.

### Phase 4 — Completion steering: allowed subjects, benchmark equivalence, DSL consistency (findings #2 + #4)

**Goal:** the Forecast Completion Pass stops proposing candidates the validator must reject
(benchmark-class redundancy, disallowed subjects, unciteable IV shapes), and candidates spread
across horizons instead of stacking at one bucket.

**Changes:**
1. `src/forecast/observable.ts` — export the existing vocabulary (no new abstraction):
   `export const BROAD_US_INDEX_BENCHMARKS` and `export const BROAD_US_INDEX_CLASS` (expose a
   readonly array alongside if prompt code needs ordering). Redundancy logic unchanged.
2. `src/research/research-context.ts`:
   - `buildPredictionCompletionInstruction` (796-809):
     - Replace the bare "use an allowed subject" phrase with explicit semantics: name the allowed
       subject list and state that for `relative` forecasts the **primary (pre-colon) symbol** must
       be in that list (mirrors enforcement at `observable.ts:932-946`). The prompt already has the
       list as `context.depthProfile.predictionSubjects`; validation confirmed this is populated
       from the same resolved `runParams.predictionSubjects` array used by the orchestrator's
       `allowedSubjects = new Set(runParams.predictionSubjects)` gate.
     - Add one benchmark-equivalence sentence using the exported constants: relative forecasts
       against any of SPY/QQQ/DIA/IVV/VOO share the `broad-us-index` class; only one per primary
       subject and exact horizon is accepted — vary the horizon, use a non-equivalent benchmark
       (e.g. a sector ETF), or use another kind. When an existing prediction already occupies a
       class+horizon slot, say so concretely (kind + horizon + class), derived from
       `completion.existingPredictions`.
     - Append `buildForecastDiversityGuidance(command, collectedSources)` (lines 685-712) — prose
       that already explains broad-index equivalence and horizon variety but today reaches only
       primary synthesis. This is the finding-#4 nudge; per the prior handoff, do **not** enumerate
       unused 1–20d horizons, invent horizon buckets, or add validation gates.
   - `predictionDslInstruction` (714-720) and `supportedPredictionKinds` (751-766):
     - Gate the `^VIX` volatility mention (and the `volatility` kind) on `^VIX` actually being an
       allowed subject for the run. Today the prompt advertises a kind the subject gate rejects —
       exactly how the `^VIX` candidate got burned. Runs whose subject set includes `^VIX` keep the
       mention.
     - Gate `iv(SUBJECT, …)` and the `iv` kind on citeable IV evidence, not just asset class. Use a
       shared predicate with `buildForecastDiversityGuidance`; prefer `options-iv` extended evidence
       with sourceIds as the true candidate-advertising signal. Source gaps such as missing
       `tradier-options` remain data gaps and are non-citeable, so they must not cause the completion
       prompt to advertise IV candidates.
   - `buildPredictionRepairInstruction` (785-789): add the same allowed-subject semantics and
     benchmark-equivalence sentence — repair handles the identical rejection classes.

**Tests:** extend `tests/research-context.test.ts:736` ("steers completion toward uncovered kinds…"):
- Completion instruction names the allowed subjects, the pre-colon rule, and `broad-us-index`
  members when an existing relative prediction occupies the class.
- Equity run without `^VIX` in subjects: instruction omits `^VIX`/`volatility`; with `^VIX` allowed:
  both present (mirror the crypto-omission test at line 473).
- Equity run without `options-iv` evidence omits `iv`; with citeable `options-iv` evidence includes
  it.
- Repair-instruction test (line 236/309 block) gains the equivalence-class assertion.
After pre-work reconciliation, do not add new validator assertions in `tests/schema-predictions.test.ts`
for this phase — enforcement is complete; only prompt-side gaps are being filled. Update exact-string
assertions the wording change breaks.

**Verification:** deterministic tests prove the vocabulary reaches the instruction. On live AAPL
deep runs, `trace.json:predictionCompletion.rejectionReasons` contains no `broad-us-index` or
`disallowed-subject` entries and no IV candidates rejected for missing/unknown sources due to missing
options evidence; prediction count moves toward `targetCount:5`; horizons are not a single bucket
(soft check — evidence may legitimately support one horizon). See the behavioral verification rule:
use three-run distributions and treat "rejections dropped but count stayed below target" as a
possible valid ADR 0004 shortfall, not an automatic failure.

**Risk:** accepted count may still fall short — allowed by ADR 0004 with `predictionShortfall`
disclosure; never pad with near-base-rate forecasts. Model may still ignore steering; Phase 2 makes
that distinguishable from a prompt-delivery bug.

---

## Docs / ADR

- No new env vars; `docs/configuration.md` untouched.
- Phase 3 changes model-visible evidence flow on the reuse path: amend the web-evidence paragraph in
  `docs/architecture.md` (and `CONTEXT.md` if it states reused-profile runs synthesize from the
  profile digest only) in the same commit.
- ADR reconciliation:
  - ADR 0004 shortfall disclosure preserved (Phase 4); never pad forecasts to satisfy a target.
  - ADR 0001 research-only boundary untouched.
  - ADR 0028 is the on-point web-evidence governance record for Phase 3. The change is likely inside
    its boundary because web stays low-trust, sanitized, bounded, and unable to raise core evidence
    authority. Confirm this before implementation; amend ADR 0028 only if the final design changes
    that boundary.

## Final verification

1. `bun run check` (fmt + lint + fmt:check + typecheck + test) green at each phase boundary.
2. After all phases: three comparable live `bun run src/cli.ts equity AAPL --deep` runs on the
   profile-reuse path, then compare distributions against
   `data/runs/2026-07-05T09-37-04-124Z-1fe08db4`:
   - `report.json:sources` length equals unique-ID count (Phase 1)
   - `stages.json` records carry `steering` on final-synthesis attempts (Phase 2)
   - `analytics.json:webSources.usageWarning` absent; report `reportCited` and `usageRatio`
     distribution (Phase 3)
   - `trace.json:predictionCompletion.rejectionReasons` free of `broad-us-index`/`disallowed-subject`;
     no IV missing/unknown-source rejections caused by absent options evidence; prediction count and
     horizon spread reported as distributions (Phase 4)
3. Commits: one per phase, tests included, no `--no-verify`, no co-author trailers.
