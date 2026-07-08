---
name: improve-market-runs
description: Iteratively improve market-bot run quality by running a requested market, equity, crypto, research, or alpha-search job; delegating review, fix, and verification to subagents orchestrated in a bounded loop; comparing against prior comparable runs; and repeating until measured improvement, stagnation, or a hard iteration cap. Use for requests like improve latest AAPL run, improve deep equity MSFT, run a run-review loop, or fix and rerun market-bot artifacts.
---

# Improve Market Runs

Run a bounded improvement loop for `market-bot` artifacts.

**The main loop is an orchestrator only.** It resolves the target, runs the CLI, drives the loop, decides continue/stop, and writes checkpoints. It does **not** review artifacts, read source files, edit code, or run test suites itself. Each of those is delegated to a fresh subagent. The orchestrator passes each subagent's compact report forward as the input to the next subagent (review report → fix, fix report → verify), keeping its own context small.

## Orchestrator rules

- Delegate all heavy work. Per iteration spawn three subagents in sequence: **review → fix → verify**. Give each subagent everything it needs in the delegation packet; do not assume it shares your context.
- Keep the orchestrator context lean. Retain only: target, iteration counter, run-dir paths, and each subagent's compact structured report. Never pull full artifacts, run logs, review prose, or diffs into the orchestrator. If the subagent's report is large, tell it to trim to the return contract.
- Preserve the research-only boundary in every packet: no buy/sell/hold calls, sizing, execution language, or investment advice.
- Default cap: 10 iterations unless the user gives a smaller cap.
- Optimize only evidence-backed issues. Do not tune code to satisfy vague prose preferences.
- Prefer fixes with objective checks: tests, artifact fields, schema validation, source ID integrity, prediction telemetry, source gaps, and deterministic sidecars.
- Treat live run comparisons as noisy: provider freshness, market movement, and model sampling change outputs. Prefer structural artifact checks and static fixture tests over one-off prose quality judgments.
- Stop on a quality drop, two consecutive stagnant iterations, a verify failure the fix subagent cannot clear, or when the top remaining issues are external/provider/config limits.
- Commit after each iteration whose verify passed. The orchestrator does this itself (not a subagent) once verify returns pass: stage the fix's changed files and commit with a message naming the target, iteration, and findings addressed. Do not commit when verify failed, when the fix made no code change, or when only run artifacts changed. Never bypass hooks (`--no-verify`) and never add `Co-authored-by` trailers.
- After every iteration, emit the checkpoint (below) into the conversation, and append it to one deterministic file `reports/improve-market-runs-<target-slug>-<timestamp>.md` (create `reports/` if needed). Keep it compact — paths and deltas, not pasted artifacts. If the host supports conversation compaction, trigger it after the checkpoint.
- After the loop ends, summarize results and remaining issues to the user.

## Orchestrator loop

```text
resolve target -> capture baseline dir
  loop (iteration N of M):
    run CLI                -> run_N dir
    [review subagent]      -> ranked findings + delta vs prior/baseline
    checkpoint + decide    -> stop? break
    select top 1-2 findings
    [fix subagent]         -> changed files + per-finding summary
    [verify subagent]      -> pass/fail + evidence
    verify failed & unrecoverable? checkpoint blocker, break
    verify passed & code changed? commit fix (orchestrator)
    checkpoint
  end loop -> final summary
```

1. **Resolve the target.** Map the request to a CLI command. Examples: `deep equity MSFT` → `bun run src/cli.ts equity MSFT --deep`; `crypto BTC` → `bun run src/cli.ts crypto BTC`; `research AI biotech` → `bun run src/cli.ts research AI biotech`. If ambiguous and not inferable from repo commands, ask one concise question.

2. **Capture the baseline.** Glob `data/runs/` for the newest comparable prior run (same `jobType`, `assetClass`, subject/instrument, and horizon bucket where applicable). Record its dir path only; the review subagent extracts fields from it.

3. **Run a fresh artifact.** Execute the target CLI, redirecting output to a file; read only the tail. Treat stdout as the run-dir path; stderr may hold the quality digest. If the run fails, hand the failure to the fix subagent as the sole finding, then rerun and count it as this iteration.

4. **Review → decide → fix → verify** via the subagents defined below, passing each report to the next.

5. **Decide (orchestrator).**
   - Continue if ≥1 important, fixable, evidence-backed issue remains and the last change did not regress quality. On continue, the next iteration's `run CLI` produces the run that reflects the applied fix — review that run against the prior one.
   - Stop satisfied when no high-value fixable issues remain, remaining issues are external/config-limited, or measured deltas have plateaued.
   - Stop at the iteration cap even if work remains.

## Subagents

Spawn each as a fresh subagent with a self-contained delegation packet. Run **every subagent at `high` reasoning effort**, with models fixed by role:

| Subagent | Model      | Why                                                                |
| -------- | ---------- | ------------------------------------------------------------------ |
| Review   | `gpt-5.5`  | strong, cost-effective evidence gathering and ranking              |
| Fix      | `gpt-5.5`  | bulk implementation with a clear spec                              |
| Verify   | `opus-4-8` | independent judgment on the fix, different family than the builder |

`gpt-5.5` runs **only** through the Codex CLI (`codex exec` / `codex exec review` with `-m gpt-5.5`); host subagent `model` params accept Claude models only. So run the review and fix subagents via Codex — either directly or through a thin Claude wrapper (`sonnet`, `low`) that shells out to Codex and returns the report — and write their reports to an artifact file so they survive long runs. Run the verify subagent on `opus-4-8` directly. If a named model is unavailable, fall back to the next capable one and disclose the fallback. Fix and verify share one writable workspace and run sequentially — do not parallelize them.

### 1. Review subagent (read-only)

- **Objective:** Review `run_N` and rank fixable quality issues; compute delta vs the prior run and baseline.
- **Packet in:** `run_N` dir, prior-input run dir, baseline dir, research-only boundary, the objective-delta list below.
- **Task:** Invoke the `run-review` skill on `run_N` (read-only — it must not edit code). Compare artifacts across the three runs.
- **Objective deltas to report:** fewer/higher-impact `SourceGap`s; valid cited source IDs in sections and predictions; `analytics.json` prediction mix (`informativeCount`, `nearBaseRateCount`, `signalTargetMet`); fresh-vs-reused web evidence accounting; restored sidecars, trace stages, schema validity, deterministic coverage; fewer review findings of equal/higher severity.
- **Return contract (compact):**
  - `findings`: ranked list; each = severity, category, one-line issue, exact artifact evidence (file + field/path), and an objective-check hint for verifying a fix.
  - `skip`: findings caused only by missing optional provider keys, provider outages, market availability, or unresolved future prediction horizons — unless telemetry/reporting can be improved.
  - `delta`: improved / regressed / stagnant / inconclusive vs prior and baseline, with the artifact evidence. If regressed, state whether the cause is the last code change or live-data/model variance.

The orchestrator selects at most the top two fixable findings (excluding `skip`) to pass to the fix subagent.

### 2. Fix subagent (writable workspace)

- **Objective:** Apply scoped fixes for the selected findings, with tests. Focus only on 2 most impactful findings and worth fixing or improving.
- **Packet in:** the selected findings (with evidence + objective-check hints), research-only boundary, the docs list, and this constraint set.
- **Task / constraints:**
  - Read `AGENTS.md`, `CONTEXT.md` and `docs/adr/README.md` before editing. Follow existing patterns and canonical ADRs; do not silently violate an ADR.
  - Search before reading files; read only the relevant slices.
  - Make scoped changes only; add/update tests in the same change when behavior changes. Do not bundle unrelated refactors.
  - Bun + oxc only — no Node, Prettier, ESLint, Biome; no secrets in code/tests/fixtures.
  - If a finding needs a multi-step, cross-module, schema/data-flow, or prompt-pipeline change, write a short checklist and use `implement-plan`. For narrow one-file fixes, edit directly.
- **Return contract:** changed files (paths only), one line per finding on what changed and why, tests added/updated, and any residual risk or finding it could not address.

### 3. Verify subagent (same workspace)

- **Objective:** Prove the fix holds without live-data noise; report pass/fail with evidence.
- **Packet in:** changed files and which findings they target, plus the verification recipe below.
- **Task:**
  - Run focused tests for the touched code first.
  - For equity pipeline or prompt/model-stage changes, use the static equity fixture suite from `docs/testing.md` to reduce live-data variance: `bun test tests/equity-fixture-run.test.ts`; run `bun run scripts/replay-fixture-run.ts equity-aapl-deep --live` only when judging prompt/model behavior against fixed inputs and live model cost is acceptable.
  - Run `bun run check` (fmt + lint + fmt:check + typecheck + test:coverage) at stable completion. If too expensive mid-loop, defer to the final iteration and say so.
  - Stop after three failed attempts on the same failure and report the blocker; do not bypass hooks or CI.
- **Return contract:** commands run and pass/fail each, the blocker if any, and any deferred check.

## Iteration checkpoint

After each loop, emit this compact shape (also appended to the `reports/` file):

```text
Iteration N/M
Target: <command>
Baseline: <run-dir>
Input run: <run-dir>
Output run: <run-dir or pending>
Chosen findings: <1-2 artifact-backed issues>
Changes: <files changed>
Verification: <commands and pass/fail>
Commit: <sha + subject, or "none (<reason>)">
Delta: <improved/regressed/stagnant + evidence>
Next: <continue/stop + reason>
```

## Final output

Report only: final run dir, baseline run dir, iterations completed, per-iteration commit SHAs, changed files, verification result (especially `bun run check`), remaining external/config-limited or deferred issues, and a link to the full report in `reports/`.
