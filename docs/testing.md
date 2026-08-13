# Testing

This project uses Bun test, oxfmt, oxlint, and TypeScript.

## Common commands

```sh
bun test                 # run all tests
bun test tests/report.test.ts
bun run typecheck
bun run app:check
bun run app:build
bun run lint
bun run fmt:check
bun run check            # fmt + lint + fmt:check + typecheck + knip + app:build + test:coverage
```

## Unused-code gate

`bun run knip` is the unused-code gate. `knip --production` is deliberately not used: `knip.json`
has only `scripts/**/*.ts` and `tests/**/*.ts` as entries, and production mode drops the test
entries, leaving nothing to analyze. Those test entries already reach `src/` transitively, so adding
`src/cli.ts` or other real entry points would make production mode find only a strict subset of the
existing gate.

The scripts-and-tests-only `entry` configuration is intentional, not an oversight.

## Static equity fixture tests

The static equity fixture harness exercises the real equity pipeline while replacing only two
external boundaries:

- HTTP `fetch`, replayed from `data-cassette.json`.
- `ModelProvider.generate`, replayed from `llm-cassette.json` in regression mode.

The fixture test runs the real source adapters, cache, normalization, source planning,
orchestration, report assembly, and schema validation.

Run the focused fixture suite:

```sh
bun test tests/equity-fixture/run.test.ts
```

Current checked-in fixtures:

- `tests/fixtures/runs/equity-aapl-brief/`
- `tests/fixtures/runs/equity-aapl-deep/`
- `tests/fixtures/runs/equity-earnings-release-deep/`
- `tests/fixtures/runs/equity-nbis-deep/`
- `tests/fixtures/runs/equity-fpi-quarterly/`
- `tests/fixtures/runs/equity-fpi-ifrs-semiannual/`
- `tests/fixtures/runs/equity-analysis-comprehensive/`
- `tests/fixtures/runs/equity-analysis-estimated-suppressed/`
- `tests/fixtures/runs/equity-web-fallback-deep/`

Each fixture contains:

- `data-cassette.json` — scrubbed HTTP responses keyed by canonical request.
- `llm-cassette.json` — ordered model responses keyed by stage and model.
- `meta.json` — pinned run config, clock, command, and model settings.
- `golden-output/` — scrubbed deterministic run output used by the regression test:
  `report.json`, `analytics.json`, exact-text `report.md`, and `normalized/*.json` sidecars.

## Refreshing golden output

When an intentional deterministic output change affects the fixture artifacts, refresh the golden
output from the existing cassettes. Check the current output first; replay mode checks by default,
and `--check-golden` makes that intent explicit:

```sh
bun run scripts/replay-fixture-run.ts equity-aapl-brief --check-golden
bun run scripts/replay-fixture-run.ts equity-aapl-brief --keep # check and retain the isolated temporary replay directory
bun run scripts/replay-fixture-run.ts equity-aapl-brief --write-golden
bun run scripts/replay-fixture-run.ts equity-aapl-deep --write-golden
bun test tests/equity-fixture/run.test.ts
```

`--write-golden` uses replayed data and replayed model output. It should not require live provider
keys or live network access. Before overwriting, it prints an identity-matched, bucketed summary
against the existing golden. Sign flips, numeric deltas over 25%, sensitive financial fields,
type changes, and removed warnings or gaps are always printed in full. Prose changes are counted
and sampled under the normal top-N limit. Markdown uses line matching so inserted or removed lines
do not shift every successor. Positional array fallbacks are called out and must be reviewed for a
missing stable identity rule.

Write mode runs the strict golden reader before replacing any files. A layout-invalid entry at the
`golden-output/` root, such as a stray file or any unexpected root entry, therefore aborts
`--write-golden` and must be removed by hand. A layout-valid stale `.json` file under
`golden-output/normalized/` is readable, appears in the pre-write diff, and is removed when the
writer recreates the normalized file set.

## Reviewing a suspicious change

When a change looks locally correct but you doubt the tests would catch it being wrong, break it on
purpose and run the suite. If the suite stays green, the tests cover the shape of the code, not the
behaviour.

The three cheap breakages worth trying are:

- invert a comparison;
- delete a guard body;
- replace a boolean literal.

For example, in `src/web-evidence/web-subject-profile-reuse.ts`, remove `"10-K"` from
`REUSE_BASIS_FORMS` and run:

```sh
bun test tests/web-subject-profile-reuse.test.ts
```

It fails. Before that test was rewritten to drive the real producer, it did not: the test hand-built
its own evidence items, so it passed with the reader's filter broken. Revert afterwards and confirm:

```sh
git diff src/
```

Ask the same question the other way for code that filters on a value another module produces: can
the producer actually emit the value this code matches on? A filter on an unproducible value is dead
code that every check in this repo will pass. The `SecFilingForm` export in
`src/sources/evidence-request-tools.ts` is how this specific hazard is now caught by `tsc`.

An automated mutation runner was considered and rejected. Its output is noisy by construction:
equivalent mutants that change nothing observable read as failures, and a check that cries wolf gets
suppressed. No mutation framework is added as a dependency either; [ADR 0002](./adr/0002-typescript-bun-orchestration.md)
fixes this repo on Bun and oxc, which rules out the Node-based options. The manual version above is
what actually found the real defects, and it takes minutes.

## Refreshing prompt baseline hashes

`tests/prompt-baseline.test.ts` compares SHA-256 hashes of the prompts built from a deterministic
case matrix against `tests/support/prompt-baseline.golden.json`. When a prompt change is
intentional, refresh the goldens and inspect the diff:

```sh
UPDATE_PROMPT_BASELINE=1 bun test tests/prompt-baseline.test.ts
```

## Live fixture replay

Live replay uses one static data cassette with the configured live model provider:

```sh
bun run scripts/replay-fixture-run.ts equity-aapl-deep --live
```

This writes a run under `data/runs/` and costs live model usage. It requires the same provider setup
as normal CLI runs, for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or Codex login depending on
`MARKET_BOT_PROVIDER`. It does not refresh checked-in fixture cassettes.

The replay command accepts exactly one fixture name and one optional mode: `--live`,
`--keep`, `--check-golden`, or `--write-golden`. Replay mode without a mode flag checks the golden.
Checks and writes use temporary runs. `--keep` also checks the golden, then retains the replayed run
in its isolated temporary directory and prints its path for inspection.
Retained `--keep` directories are not removed automatically; delete them manually when finished.

## Deep-equity presentation assertions

Deep-equity report tests verify that the reader block precedes `## Appendix`, contains the compact
company, price/freshness, trend, valuation-context, catalyst/risk, earnings/consensus, and material
gap content, and excludes appendix-only detail. Console tests server-render the workspace at both
`reportDetail` settings and verify Simple omits appendix markers, Advanced contains them as a strict
superset with nothing duplicated, and non-equity output is byte-identical across the two. Both
surfaces derive the trend table through
`src/report/equity-reader.ts` and classify gaps through `src/report/gap-triage.ts`.

Run the focused suites:

```sh
bun test tests/report.test.ts tests/run-workspace-view.test.ts tests/research-console-view-model.test.ts tests/app.test.ts
bun test tests/equity-fixture/run.test.ts
```

## Recording fixtures

Recording creates or replaces fixture cassettes and golden output from a live run:

```sh
bun run scripts/record-fixture-run.ts equity-aapl-brief equity AAPL --brief
bun run scripts/record-fixture-run.ts equity-aapl-deep equity AAPL --deep
```

Recording requires live market data access and live model provider setup. Optional source-provider
keys such as `MARKET_BOT_FRED_API_KEY`, `MARKET_BOT_TRADIER_API_TOKEN`,
`MARKET_BOT_EXA_API_KEY`, and `MARKET_BOT_SEC_USER_AGENT` affect what is captured. Never commit a
fixture until the recorder's secret scan passes and `bun run check` is green.

### Generated fixture price series

`scripts/generate-fixture-price-series.ts` with `SEED = 17` owns the identical Yahoo chart bodies in
`equity-aapl-brief`, `equity-aapl-deep`, `equity-analysis-comprehensive`,
`equity-analysis-estimated-suppressed`, `equity-fpi-quarterly`, and
`equity-fpi-ifrs-semiannual`. Do not re-record these chart entries independently: preserve the
existing chart body when updating unrelated cassette data, and use the generator only for an
intentional shared price-path change before replaying all six goldens.

## Fixture maintenance rules

- Keep harness helpers in `tests/support/run-fixtures/`.
- Treat each fixture's `golden-output/` as its value coverage. Assertions cover only
  non-golden checks such as raw snapshots, separate-file hashes, prompt/model behavior, fields
  without normalized sidecars, and cross-cutting invariants.
- Keep fixture test cases in `tests/equity-fixture/run.test.ts` and shared assertions in
  `tests/support/run-fixtures/assertions.ts`; do not mix test-only behavior into production
  pipeline code.
- Do not hand-edit cassettes unless you are removing an obvious secret and will re-record afterward.
- If files under `golden-output/` change, inspect the golden-diff summary before committing. Investigate
  every escalated finding, especially sign flips, large numeric deltas, and removed validation
  notes, omission notes, or data gaps. Do not accept a positional fallback without checking whether
  the array now has a stable identity.
- CI should use regression mode only; live fixture replay and recording are manual developer
  workflows.
