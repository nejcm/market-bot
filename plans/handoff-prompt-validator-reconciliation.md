# Handoff: prompt/validator reconciliation + failed-run diagnostics

**Branch:** `prompt-validator-reconciliation` (pushed) · **PR:** [#47](https://github.com/nejcm/market-bot/pull/47), CI green, `MERGEABLE`/`CLEAN`
**HEAD:** `590cdad`+ · **Base:** `master`
**Superseded:** `wip/language-guard-scope` (`eb17089`) finished as `590cdad`; branch deleted, recoverable from reflog

> `AGENTS.md` bans unsolicited planning docs. This one and
> [prompt-validator-reconciliation.md](./prompt-validator-reconciliation.md) were both solicited.

## Read this first

Everything in PR #47 is reviewed, green, and mergeable. Phases A–E did not fix the thing that
actually blocked a deep equity run; **phase F does, and a live run confirms it.**
`equity AMD --deep` completed on 2026-08-26 — the first AMD deep run ever to do so. See
"Live confirmation" below.

## What is done

Six phases, each builder → independent review → fix pass → re-review, `bun run check` green at every
commit. Details are in the PR body. Summary:

| Commit | What |
|---|---|
| `9c53d11` | A — horizon bound stated on the prompt surface |
| `c193a57` | B — citation guidance scoped to the profile allowlist |
| `1efc5af` | B2 — verified snapshot dropped from the profile payload |
| `3b550a5` | C — `advisoryReasons` for failed supplemental lanes, `rubricVersion` 3 |
| `6c9c5a2` | D — trade-action ban matched to the validator regex |
| `063fda1` | E1 — Failed Run Artifact persisted when synthesis fails |
| `7d5ee5e` | E2 — console surfaces failed runs, provider health skips them |
| `176d774` | oxfmt the README depth table so `bun run check` stops dirtying a clean tree |
| `590cdad` | F — research-only validation scoped to model-authored prose; ADR 0001 amended |

## The live finding — read before picking up anything

Three live `equity AMD --deep` runs were executed. **None completed.** The first two persisted
nothing at all, which is what motivated E1. The third, run after E1/E2 landed, left a Failed Run
Artifact that answered the question:

    data/runs/2026-08-26T10-22-14-230Z-52aac308/

- `failure.json` → `languageViolations: []` — the designed signal that the violation came from
  assembly output, not the model draft.
- `grep -c "you should" rejected-report.json` → **0**. The model never wrote it.
- The phrase is in `normalized/extended-evidence.json` items[9], title "AMD SEC 10-Q":
  *"In addition, you should consider the interrelationship and compounding effects of two or more
  risks occurring simultaneously."* — AMD's own 10-Q risk-factor boilerplate.
- All four final-synthesis drafts were clean; all four **assembled** reports failed on that sentence.
  The three repair reprompts were structurally incapable of fixing it: they ask the model to rewrite
  text the model never wrote.

`assertSafeReportLanguage` ([src/report/schema.ts](../src/report/schema.ts)) scanned
collector-derived evidence, so **any issuer whose filings carried reader-directed risk language
could never produce a passing report.** That was the blocker, caused by nothing in phases A–E.
Fixed in `c3047fe`; see "Phase F" below.

Reading anything under `data/runs/` is always allowed and free. Do not modify or delete it.

## Phase F — done in `590cdad`, reviewed

`assertSafeReportLanguage` now scans model-authored prose only. `src/domain/research-language.ts`
is untouched; only what is fed to it changed. Every surface was classified against its producer:

| Surface | Verdict | Evidence |
|---|---|---|
| `summary`, `keyFindings`, `bullCase`, `bearCase`, `risks`, `catalysts`, `scenarios` | scanned | final-synthesis model payload |
| `extendedEvidence` | exempt | collector-derived filing/news text — the AMD case |
| `researchQualityDriver` | exempt | deterministic, `src/research/quality-driver.ts` |
| `extras.historicalContext` | exempt (whole) | `report-assembly.ts:historicalContextExtra` builds every field; `items[].text` quotes a prior run summary already gated on its own run. The wip kept this one; the audit dropped it. |
| `extras.catalystCalendar` | exempt (whole) | `report-assembly.ts:catalystCalendarExtra` — catalyst labels *are* `report.catalysts[].text`, scanned at their own key; macro labels are collector titles; the rest are code templates |
| `extras.earningsSetup` | bullets scanned, `gaps` exempt | model extras at `extended-evidence-projections.ts:116-121`; `gaps` code-owned at `:123-128` |
| `extras.businessFramework` | `sections[].text` scanned, rest exempt | model text at `:70`; artifact `gaps`/`summary` at `:57,62-69` |
| `extras.spotlights` | scanned, **widened** | both rationale fields are parsed model output (`spotlights.ts:371,377`); the selection-level `rationale` was previously unscanned |
| `extras.webSubjectProfile` | scanned | model-parsed prose, `web-subject-profile.ts:274` |
| any `*.gaps` | exempt | Source Gap strings emitted by code |

Both collisions were resolved, neither by deleting a test:

1. **`tests/evidence-request-tools.test.ts`** — the gate it asserted *was* the over-broad scan.
   It required the same filing bytes to be exempt in `Source.snippet` and gated in
   `extendedEvidence[].summary`. It now asserts both copies are exempt and that the same bytes
   restated as `report.summary` still throw.
2. **`tests/orchestrator-failure-persistence.test.ts`** — `languageViolations: []` has a new and
   more accurate route: prose from an *earlier model stage* merged during assembly, absent from the
   final-synthesis payload that per-field attribution scans. The Web Subject Profile is that case.
   The explanatory comment at `src/run-artifact-writer.ts:325` was updated to match.

Regression coverage runs both ways: a model-authored violation is rejected in each still-scanned
surface, each exempt surface is proven not to throw, and the real AMD sentence is pinned as a
fixture — clean in `extendedEvidence`, rejected in `summary` and `risks`, and passing end to end
through `persistResearchJob`.

ADR 0001 was amended in the same commit and `AGENTS.md` gained the matching clause. `bun run check`
is green and leaves a clean tree.

### Review outcome

F was independently reviewed (fresh context, same model family as the author — not cross-family, so
independence is reduced). Verdict: **no model-authored surface lost enforcement on any reachable
production path**; every classification traced to a producer held up. It confirmed the
`catalystCalendar` labels are literally the same array object as `report.catalysts`, and that the
`webSubjectProfile` route to `languageViolations: []` is real rather than accidental. Four findings
were acted on:

1. **The bulk of F was committed under a message saying "chore: apply oxfmt".** A `cherry-pick -n`
   left files staged and a later `git add README.md && git commit` swept the whole index in, so
   `git log -S modelAuthoredExtraText` answered "a formatting chore". The six commits were rebuilt
   as three honest ones (`176d774`, `590cdad`, this one) and force-pushed.
2. **Sentence-initial trade verbs were unenforceable at the start of every scanned field** — before
   F as well as after. `SENTENCE_INITIAL_TRADE_ACTION_PATTERN` needs `^` or `.!?;:\n` before the
   verb; a `JSON.stringify` blob puts a `"` there, and it escapes real newlines besides. So
   `summary = "Buy the dip ahead of the print."` passed. Verified against the real function, fixed
   by joining the scanned strings with newlines, fleet-checked (77 artifacts, 0 newly flagged), and
   pinned with tests. AGENTS.md had been advertising this as blocked.
3. **The ADR's justification for dropping `extras.historicalContext` was wrong.** "Already gated on
   its own run" does not hold — patterns widen over time (`6c9c5a2` did), so an older artifact was
   never screened by a newer one. The real justification is stronger and already in the codebase:
   prior-run prose is external ingress, sanitized as `provider: "historical-artifact"` in
   `historical-context-sanitization.ts:24-35`. ADR corrected. Note the final-synthesis prompt still
   asks the model to author a `historicalContext` object unconditionally; the exemption holds only
   because the orchestrator always supplies the real one.
4. **The closed-list governance clause had been dropped.** The pre-F ADR said adding an exempt
   projection requires an amendment; the replacement said only "classify per field", which is advice
   rather than a gate. Restored.

Not acted on, recorded as open items: the `dataGaps` laundering path (item 1) and an extras-key
drift guard (item 8).

## Live confirmation — `data/runs/2026-08-26T15-01-24-300Z-e6889971/`

`bun run src/cli.ts equity AMD --deep`, run after F landed. **It completed.** The dir holds
`report.json`, `report.md`, `score.json`, `analytics.json`, `stages.json`, `trace.json` — and no
`failure.json`. Four prior AMD deep runs never got here.

The sentence that killed the previous three is present in the artifact and passed validation:

    .sources[37].snippet
    .sources[38].snippet
    .extendedEvidence.items[9].summary      <- same slot as the failed run

Zero occurrences in `summary`, `keyFindings`, `bullCase`, `bearCase`, `risks`, `catalysts`, or
`scenarios`. So the fix is confirmed on the exact failure, not a proxy for it: the filing text still
arrives, still lands in `items[9]`, and is now exempt rather than fatal.

It also **does not appear in `report.md`** at all, which softens open item 9 for this run — the
reader-facing document never carries the sentence. Don't generalize that to every configuration; it
was checked on one run.

Run quality for the record: Evidence Quality medium, 22 data gaps, 16 source gaps, 2/5 prediction
target (3 short), 8 evidence lanes covered / 3 gaps. Those are quality signals, not correctness
ones, and are untouched by F. The run also printed `index database missing, skipping write-through`
— open item 5, still unexercised.

## Other open items

Ranked. None blocking the PR.

1. **`report.dataGaps` is model-authored and unscanned.** Found while reviewing F, pre-existing, not
   a regression from it. It merges model `payload.dataGaps` with deterministic gap text at
   [report-assembly.ts:761](../src/research/report-assembly.ts), and F's principle says the model
   half should be scanned.

   The fleet check that was blocking this is **done and clean**: 77 `report.json` artifacts under
   `data/evaluations/`, 2,125 `dataGaps` entries, **0 research-only matches**. Nothing known would
   newly fail. The scan script is disposable; it imported `violatesResearchOnly` and walked
   `data/**/report.json`.

   Review sharpened this: `dataGaps` is **not inert**. `partitionGapShapedFindings` and
   `relocateBusinessFrameworkClaims` ([report-assembly.ts:128-188](../src/research/report-assembly.ts))
   *move* uncited findings and business-framework text out of scanned fields into `dataGaps`. So a
   model sentence like *"No guidance coverage for FY27; investors should treat the $250 price target
   as unsupported."* is gap-shaped, gets relocated, and bypasses both the reader-directed and
   valuation patterns — rendering as a Source Gap in `report.md`. Pre-existing, not caused by F.

   Not implemented here deliberately: it can only *add* failures, and it deserves its own branch and
   review rather than being bolted onto a mergeable PR. The fleet evidence says it is safe to do.

   An earlier draft of this item also named `predictions[].claim` / `.measurableAs`. **That was
   wrong** — `claim` is rendered from the parsed observable expression
   ([observable-candidates.ts:172](../src/forecast/observable-candidates.ts)) and `measurableAs` is
   a parsed DSL expression, not prose. Predictions need no screen. Corrected in the ADR.
2. **`TICKER_TRADE_ACTION_PATTERN`** ([research-language.ts:24](../src/domain/research-language.ts))
   accepts a lowercase verb before any 1–5 uppercase letters, so `"OEMs buy AMD chips"` matches like
   `"Buy AMD"`. The second AMD run died on `"buy AMD"`, but that run persisted nothing, so **this is
   unconfirmed** — the phrase was never seen in context. If a future failed run reproduces it, check
   `rejected-report.json` before changing the pattern. ADR 0001 territory.
3. **`--horizon` hard-codes `1-20`** ([src/cli/args.ts:84](../src/cli/args.ts)) — a third copy of the
   bound phase A consolidated. Raising `MAX_PREDICTION_HORIZON_TRADING_DAYS` desyncs the CLI.
4. **No baseline hash covers `prompts/*.md`.** `prompt-baseline-matrix.ts` hashes only
   `buildStagePrompt` output, so a prompt file can be rewritten with zero test signal. Nine prompt
   bases are unpinned.
5. **`src/app.ts:86-88` and `:94-96`** write to stderr unguarded inside `updateRunArtifactIndex`'s
   `.catch` handlers, so a simultaneous index failure and broken stderr masks the original error.
   Shared with the success path.
6. **Index write-through is unexercised.** The third AMD run printed `index database missing,
   skipping write-through` because `data/index.sqlite` did not exist. The guard behaved correctly;
   the path where the index *does* exist has never run.
7. **Sidebar failed-badge markup has no render test** — only `isFailedRun` is unit-tested. The only
   Svelte render seam is `tests/support/render-run-workspace.ts`; covering the badge means extracting
   its loader, roughly 25 lines, not duplicating the harness.
8. **`extras` is an open record scanned by a closed key list, with no drift detector.**
   `modelAuthoredExtraText` names four keys; `payload.extras` is accepted wholesale. The next extra
   the model is taught to emit is unscanned by default and no test fails to say so. Suggested guard:
   enumerate the extras keys the final-synthesis prompt requests and assert each is either scanned
   or named in the exempt comment.
9. **Exempt Extended Evidence renders without visible attribution.** SEC items carry a
   `"Filing excerpt: …"` prefix; news items do not
   ([markdown-evidence-sections.ts:96](../src/report/markdown-evidence-sections.ts)), so a reader
   sees *"In addition, you should consider…"* as a plain bullet in market-bot's own report,
   attributed only by citation number. Follows from the F decision; a blockquote or "as filed"
   prefix would put the attribution where the ADR claims it lives.
10. **Consider screening the Web Subject Profile at its stage boundary.** A violation in profile
   prose still fails final synthesis unrecoverably — the same 13-minute burn, different origin,
   since that stage's model never wrote it either. Running `violatesResearchOnly` at `parseProfile`
   would cost one small regenerate instead, as `history/artifacts.ts:822` already does.
11. Deferred in the original plan and still open: peer-universe fallback unreachable, Finnhub 403 gap
   cardinality. See [prompt-validator-reconciliation.md](./prompt-validator-reconciliation.md).

## Working constraints

Beyond `AGENTS.md`, which governs:

- **Live runs cost real money.** ~12–13 min and ~440–550k tokens each. Three were spent here. Do not
  run the CLI to check something; read `data/runs/` or replay a fixture.
- **Never `--live`, never the fixture recorder, never `--no-verify`.** The pre-push hook runs the full
  suite and correctly blocked a red push during this work — do not bypass it.
- **`--write-golden` only for intentionally output-changing work**, and say so in the commit body.
  Phase C is the example.
- The market-bot CLI shells out to `codex exec` as a model provider, so running it inside a sandboxed
  Codex nests one in another and fails at init with `read-only file system`. Run it with full
  filesystem access.
