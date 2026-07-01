---
name: improve-market-runs
description: Iteratively improve market-bot run quality by running a requested market, equity, crypto, research, or alpha-search job; invoking run-review on the new artifact; comparing against prior comparable runs; fixing the top evidence-backed code or prompt issues; rerunning; and repeating until measured improvement, stagnation, or a hard iteration cap. Use for requests like improve latest AAPL run, improve deep equity MSFT, run a run-review loop, or fix and rerun market-bot artifacts.
---

# Improve Market Runs

Run a bounded improvement loop for `market-bot` artifacts. This skill manages the loop; `run-review` remains the read-only reviewer.

## Rules

- Read `AGENTS.md`, `CONTEXT.md`, `docs/architecture.md`, `docs/conventions.md`, and `docs/adr/README.md` before editing.
- Preserve the research-only boundary: no buy/sell/hold calls, sizing, execution language, or investment advice.
- Use `run-review` for artifact review. Do not ask `run-review` to edit code.
- Default cap: 10 iterations unless the user gives a smaller cap.
- Optimize only evidence-backed issues. Do not tune code to satisfy vague prose preferences.
- Prefer fixes with objective checks: tests, artifact fields, schema validation, source ID integrity, prediction telemetry, source gaps, and deterministic sidecars.
- Stop on a quality drop, two consecutive stagnant iterations, failing quality checks you cannot fix quickly, or when the top remaining issues are external/provider/config limits.
- Treat live run comparisons as noisy: provider freshness, market movement, and model sampling can change outputs. Prefer structural artifact checks and static fixture tests over one-off prose quality judgments.
- After every iteration, create a compact checkpoint in the conversation with target, run dirs, review findings chosen, changes made, verification, measured delta, and next decision. If the active Codex surface supports conversation compaction, trigger it after the checkpoint; otherwise keep future context to the checkpoint plus file paths.
- Also create `reports/` if needed and append the checkpoint to one deterministic markdown file named `reports/improve-market-runs-<target-slug>-<timestamp>.md`. Keep it compact: do not paste full artifacts, run logs, or large review text.
- After the run is complete, summarize the results and any remaining issues to the user.

## Workflow

Use this state machine:

```text
baseline -> run A -> review A -> fix -> verify -> run B -> compare A/B/baseline -> checkpoint -> review B or stop
```

1. Resolve the target.
   - Examples: `deep equity MSFT` -> `bun run src/cli.ts equity MSFT --deep`; `crypto BTC` -> `bun run src/cli.ts crypto BTC`; `research AI biotech --deep` -> `bun run src/cli.ts research AI biotech --deep`.
   - If the target is ambiguous and cannot be inferred from repo commands, ask one concise question.

2. Capture the baseline.
   - Find the newest comparable prior run using `data/runs/` and compact `report.json` fields.
   - Comparable means same `jobType`, `assetClass`, subject/instrument, and horizon bucket where applicable.
   - Record the baseline run dir and key quality fields before creating a new run.

3. Run a fresh artifact.
   - Execute the target CLI command.
   - Treat stdout as the run directory path; stderr may contain the quality digest.
   - If the run fails, fix the blocking failure first, then rerun and count that as the current iteration.

4. Review the fresh artifact.
   - Invoke `run-review` on the new run.
   - Require a ranked list with exact artifact evidence.
   - Select at most the top two fixable findings for the next code/prompt change.
   - Skip findings caused only by missing optional provider keys, live provider outages, market availability, or unresolved future prediction horizons unless telemetry/reporting can be improved.

5. Explore and fix.
   - Search before reading files. Read only the relevant slices.
   - Make scoped changes following existing patterns and ADRs.
   - Add or update tests in the same change when behavior changes.
   - Do not bundle unrelated refactors.
   - If selected findings require a multi-step change, cross-module edits, schema/data-flow changes, prompt pipeline changes, or more than one verification phase, write a short implementation checklist and use `implement-plan` for the fix phase.
   - For narrow one-file fixes, implement directly.

6. Verify locally.
   - Run focused tests first.
   - For equity pipeline or prompt/model-stage changes, use the static equity fixture suite from `docs/testing.md` to reduce live-data variance:
     - `bun test tests/equity-fixture-run.test.ts`
     - `bun run scripts/replay-fixture-run.ts equity-aapl-deep --live` only when judging prompt/model behavior against fixed market inputs and live model cost is acceptable.
   - At stable completion, run `bun run check`.
   - If `bun run check` is too expensive mid-loop, run it before final completion and state any deferred check in the checkpoint.
   - Stop after three failed attempts on the same verification failure and report the blocker.

7. Rerun and compare.
   - Run the same CLI target again.
   - Compare the new run to both the iteration input run and the baseline.
   - Use objective deltas when available:
     - fewer duplicate or higher-impact `SourceGap`s
     - valid cited source IDs in report sections and predictions
     - improved `analytics.json` prediction mix (`informativeCount`, `nearBaseRateCount`, `signalTargetMet`)
     - better fresh-vs-reused web evidence accounting
     - restored sidecars, trace stages, schema validity, or deterministic coverage
     - fewer review findings of equal or higher severity
   - Count improvement only when artifact evidence supports it.
   - If the latest run regressed, decide whether the cause is this iteration's code change or live-data/model variance. Fix or revert only your own regressing change when causality is clear; otherwise mark the iteration inconclusive and do not count it as improvement.

8. Decide.
   - Continue if at least one important, fixable, evidence-backed issue remains and the latest change did not regress quality. On continue, reuse the latest run as the input for the next iteration and start with `run-review`; do not rerun before reviewing it.
   - Stop satisfied when the latest run has no high-value fixable issues, remaining issues are external/config-limited, or the measured deltas have plateaued.
   - Stop at the iteration cap even if work remains.

## Iteration Checkpoint

After each loop, emit this compact shape:

```text
Iteration N/M
Target: <command>
Baseline: <run-dir>
Input run: <run-dir>
Output run: <run-dir or pending>
Chosen findings: <1-2 artifact-backed issues>
Changes: <files changed>
Verification: <commands and pass/fail>
Delta: <improved/regressed/stagnant + evidence>
Next: <continue/stop + reason>
```

## Final Output

Report only:

- final run dir
- baseline run dir
- iterations completed
- changed files
- verification result, especially `bun run check`
- remaining external/config-limited or deferred issues
- link to the full run report in `reports/`
