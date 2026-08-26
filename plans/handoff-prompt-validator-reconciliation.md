# Handoff: prompt/validator reconciliation + failed-run diagnostics

**Branch:** `prompt-validator-reconciliation` (pushed) · **PR:** [#47](https://github.com/nejcm/market-bot/pull/47), CI green, `MERGEABLE`/`CLEAN`
**HEAD:** `7d5ee5e` · **Base:** `master`
**Unfinished work:** local branch `wip/language-guard-scope` at `eb17089` — **local only, never pushed**

> `AGENTS.md` bans unsolicited planning docs. This one and
> [prompt-validator-reconciliation.md](./prompt-validator-reconciliation.md) were both solicited.

## Read this first

Everything in PR #47 is reviewed, green, and mergeable. **The headline finding is that none of it
fixes the thing that actually blocks a deep equity run.** Read "The live finding" below before
deciding what to do next; it changes what is worth working on.

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

`assertSafeReportLanguage` ([src/report/schema.ts:127](../src/report/schema.ts)) scans
collector-derived evidence, so **any issuer whose filings carry reader-directed risk language can
never produce a passing report.** That is the blocker. It is not caused by anything in PR #47 and is
not fixed by it.

Reading anything under `data/runs/` is always allowed and free. Do not modify or delete it.

## Next task: finish phase F

**Decision already made by the user — do not revisit it:** scope the language scan to
**model-authored** fields. Rationale: the research-only boundary exists to stop *the system* from
giving advice. Quoting a filing that says "you should consider these risks" is not market-bot
advising anyone. Keep scanning everything the model writes.

Starting point: `git show eb17089` (branch `wip/language-guard-scope`). It typechecks, `report.test.ts`
passes, the ADR 0001 amendment is drafted — and **2 tests fail**. It has had no review.

    git checkout wip/language-guard-scope     # or cherry-pick eb17089

### The scan surface

`assertSafeReportLanguage` stringifies ten surfaces into one blob:

    summary, keyFindings, bullCase, bearCase, risks, catalysts, scenarios   <- model-authored
    researchQualityDriver          <- deterministic (src/research/quality-driver.ts)
    extendedEvidence               <- collector-derived (proven above)
    renderedExtras                 <- MIXED, needs a real audit

`renderedExtras` is the one requiring judgment: audit what `researchOnlyExtraText`
([schema.ts:146](../src/report/schema.ts)) pulls out of `report.extras` and classify it **per field**,
with file:line evidence. If a surface is deterministic scaffolding around model-authored prose, scan
the model-authored part — do not drop a whole surface because one field inside it is quoted.

Do **not** touch `src/domain/research-language.ts`. The patterns are correct; only what is fed to
them changes.

### The two unresolved collisions

Both are design questions, not defects. Neither may be resolved by deleting the test.

1. **`tests/report.test.ts` — "gates the filing excerpt built from exempt SEC source text."**
   Asserts SEC-derived excerpt text *is* gated. Someone wanted that gate. Decide whether it encodes a
   real requirement F violates, or whether it is the same over-broad scan the AMD run disproved, and
   say which.
2. **`tests/orchestrator-failure-persistence.test.ts` — "records an empty draft violation list when
   deterministic assembly is rejected."** This is E1's own off-path test; it drives a violation
   through assembly output to prove `languageViolations: []` renders. Once assembly output is no
   longer scanned, that rejection cannot happen. The `[]` case still needs coverage — it is the
   signal that cracked this open — so it needs a *new route* to that state.

### Guard against the obvious regression

Removing scan coverage is how a research-only violation ships unnoticed.

- Prove a model-authored violation in **each** still-scanned surface is still rejected.
- Prove the AMD case passes: `extendedEvidence` item summary containing "you should consider ..."
  validates cleanly, while the same phrase in `summary` or `risks` still throws.
- Use the real sentence above as the fixture so the regression is pinned to reality.

### ADR

ADR 0001 ([docs/adr/0001-research-only-boundary.md](../docs/adr/0001-research-only-boundary.md)) is the
record and must be amended in the same commit: the boundary is about what the system asserts, not
what its sources say. A draft amendment is in `eb17089` — review it, do not assume it is right.
Check whether `AGENTS.md`'s research-only section needs a clause about quoted source text.

## Other open items

Ranked. None blocking the PR.

1. **`TICKER_TRADE_ACTION_PATTERN`** ([research-language.ts:24](../src/domain/research-language.ts))
   accepts a lowercase verb before any 1–5 uppercase letters, so `"OEMs buy AMD chips"` matches like
   `"Buy AMD"`. The second AMD run died on `"buy AMD"`, but that run persisted nothing, so **this is
   unconfirmed** — the phrase was never seen in context. If a future failed run reproduces it, check
   `rejected-report.json` before changing the pattern. ADR 0001 territory.
2. **`--horizon` hard-codes `1-20`** ([src/cli/args.ts:84](../src/cli/args.ts)) — a third copy of the
   bound phase A consolidated. Raising `MAX_PREDICTION_HORIZON_TRADING_DAYS` desyncs the CLI.
3. **No baseline hash covers `prompts/*.md`.** `prompt-baseline-matrix.ts` hashes only
   `buildStagePrompt` output, so a prompt file can be rewritten with zero test signal. Nine prompt
   bases are unpinned.
4. **`bun run check` dirties `AGENTS.md` and `README.md` on a clean tree.** Its `fmt` step writes, and
   HEAD is not fmt-clean (`*recorder*` → `_recorder_` at AGENTS.md:49, README table padding). This has
   cost several agents a bogus "unrelated file" detour. Cheap to fix at the source.
5. **`src/app.ts:86-88` and `:94-96`** write to stderr unguarded inside `updateRunArtifactIndex`'s
   `.catch` handlers, so a simultaneous index failure and broken stderr masks the original error.
   Shared with the success path.
6. **Index write-through is unexercised.** The third AMD run printed `index database missing,
   skipping write-through` because `data/index.sqlite` did not exist. The guard behaved correctly;
   the path where the index *does* exist has never run.
7. **Sidebar failed-badge markup has no render test** — only `isFailedRun` is unit-tested. The only
   Svelte render seam is `tests/support/render-run-workspace.ts`; covering the badge means extracting
   its loader, roughly 25 lines, not duplicating the harness.
8. Deferred in the original plan and still open: peer-universe fallback unreachable, Finnhub 403 gap
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
