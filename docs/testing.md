# Testing

This project uses Bun test, oxfmt, oxlint, and TypeScript.

## Common commands

```sh
bun test                 # run all tests
bun test tests/foo.test.ts
bun run typecheck
bun run lint
bun run fmt:check
bun run check            # fmt + lint + fmt:check + typecheck + test
```

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
- `tests/fixtures/runs/equity-nbis-deep/`
- `tests/fixtures/runs/equity-fpi-quarterly/`
- `tests/fixtures/runs/equity-fpi-ifrs-semiannual/`
- `tests/fixtures/runs/equity-analysis-comprehensive/`
- `tests/fixtures/runs/equity-analysis-estimated-suppressed/`

Each fixture contains:

- `data-cassette.json` — scrubbed HTTP responses keyed by canonical request.
- `llm-cassette.json` — ordered model responses keyed by stage and model.
- `meta.json` — pinned run config, clock, command, and model settings.
- `golden-output.json` — scrubbed deterministic run output used by the regression test.

## Refreshing golden output

When an intentional deterministic output change affects the fixture artifacts, refresh the golden
output from the existing cassettes:

```sh
bun run scripts/replay-fixture-run.ts equity-aapl-brief --write-golden
bun run scripts/replay-fixture-run.ts equity-aapl-deep --write-golden
bun test tests/equity-fixture/run.test.ts
```

`--write-golden` uses replayed data and replayed model output. It should not require live provider
keys or live network access.

## Refreshing prompt baseline hashes

`tests/prompt-baseline.test.ts` compares SHA-256 hashes of the prompts built from a deterministic
case matrix against `tests/support/prompt-baseline.golden.json`. When a prompt change is
intentional, refresh the goldens and inspect the diff:

```sh
UPDATE_PROMPT_BASELINE=1 bun test tests/prompt-baseline.test.ts
```

## Eval mode

Eval mode replays the static data cassette but uses the live configured model provider. Use it when
you want to judge prompt, playbook, or model-stage changes against fixed market inputs:

```sh
bun run scripts/replay-fixture-run.ts equity-aapl-deep --live
```

This writes a run under `data/runs/` and costs live model usage. It requires the same provider setup
as normal CLI runs, for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or Codex login depending on
`MARKET_BOT_PROVIDER`. It does not refresh checked-in fixture cassettes.

Deep-equity paired eval collects the fixed evidence once, then executes the named `legacy` and
`simplified` variants:

```sh
bun run scripts/replay-fixture-run.ts equity-aapl-deep --live --paired
bun run scripts/replay-fixture-run.ts equity-aapl-deep --live --paired --judge-model <model>
bun run scripts/replay-fixture-run.ts equity-aapl-deep equity-nbis-deep --paired --repetitions 3
```

`--repetitions` applies to every named fixture; `--seed <integer>` makes variant order and
aggregation bootstrap sampling reproducible. Supplying `--judge-model` enables blind pairwise
judging, and that model must differ from every synthesis model. The command writes one
`evaluation.json` comparison artifact under `data/evaluations/` containing per-run records, the
aggregate, and a typed verdict for every hard, non-inferiority, human-review, and live-smoke gate.
It writes the seed before executing a pair and refreshes the artifact after each pair. Malformed
judge output receives one corrective retry; a second failure leaves the pair visibly unjudged and
the judge-dependent gates fail closed.
Replay mode runs both variants from independent cassette cursors, leaves judging disabled by
default, and labels its stub-cassette numbers as having no gate-evidence weight.

Resume judging from already-persisted variant runs without rerunning either pipeline:

```sh
bun run scripts/replay-fixture-run.ts --resume-evaluation data/evaluations/<run> --live --judge-model <model>
```

Resume uses the seed and usable verdicts in the existing `evaluation.json`; `--force-rejudge`
explicitly replaces usable verdicts. The recorded fixture/repetition plan is mandatory and is
validated rather than inferred from surviving run directories. Existing legacy artifacts without
an explicit `plan` block are not trusted; recovering one requires the complete operator-supplied
`--fixtures`/`--repetitions` plan. A root without `evaluation.json` additionally requires an
explicit recovery seed:

```sh
bun run scripts/replay-fixture-run.ts --resume-evaluation data/evaluations/<run> --live --judge-model <model> --seed <integer> --fixtures <fixture-a,fixture-b> --repetitions <count>
```

`--fixtures` is comma-separated. Run only one resume process against an evaluation root at a time;
the artifact writer is atomic but does not coordinate concurrent writers. Omitting `--live` keeps
model access off and uses fixture replay.

The artifact plan records two different facts. `plan.provenance` is the immutable plan origin:
`run-input` or `operator-recovery-input`. Resuming preserves that origin. `plan.loadSource` records
how the current artifact was produced (`fresh-run`, `operator-recovery`, or `existing-artifact`)
without replacing the origin. The legacy circular value `provenance: "existing-artifact"` is not a
trusted origin and requires an explicit operator recovery plan.

This is a fail-closed workflow boundary, not authentication. Agreement between top-level fields and
the explicit plan inside one mutable JSON file does not prove that either field is genuine.
Resistance to hand-fabricated artifacts would require an authenticated or independently anchored
origin record; this evaluation artifact format does not provide one.

The Phase 4 replay measurement covers six deep-equity fixtures. Its **reasoning-prompt token
estimate reduction** sums `ceil(stable prompt characters / 4)` across captured model-stage prompts,
then takes the six-fixture median. The current cassette result is 38.0023%. Every fixture uses three
core stages (`equity-analysis`, `critique`, `final-synthesis`) and four total calls. After restoring
prior-calibration, prior-forecast-error, and `resolvedInstrumentIdentity` evidence,
`equity-nbis-deep` is the per-fixture outlier at 26.5596%, not a gate failure; the evaluation test
retains it as Phase 5 regression input with a 25% floor.

That Phase 4 prompt-size metric is not the Phase 5 gate artifact's **whole-run trace-token
improvement**. `aggregate.medianModelTokenImprovement` computes
`(legacy.trace.tokenEstimate - simplified.trace.tokenEstimate) / legacy.trace.tokenEstimate` per
pair and then takes the median. The one-fixture stub replay currently reports 26.3158% from 190
versus 140 trace tokens. It is neither a six-fixture median nor comparable to the 38.0023%
reasoning-prompt estimate.

These figures estimate cassette replay, not live-model behavior. Both legacy and `equity-analysis`
entries are short hand-authored stubs, so the measured reduction is driven almost entirely by
evidence-payload size and the prior-stage-transcript axis is not representative. Do not interpret
the NBIS percentage as a precise live-model prediction in either direction.

## Deep-equity legacy pipeline baseline

The checked-in `tests/baselines/deep-equity-legacy-pipeline.json` snapshot records model-stage order,
prompt and provider token estimates, provider URL-shape request counts, normalized files, integrity
pruning, and valid prediction/citation counts from the unchanged deep-equity fixture cassettes.

```sh
bun run scripts/deep-equity-pipeline-baseline.ts --check
bun run scripts/deep-equity-pipeline-baseline.ts --write
```

Use `--write` only after inspecting an intentional pipeline change. It replays existing cassettes
and never records provider data.

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

## Fixture maintenance rules

- Keep harness helpers in `tests/support/run-fixtures/`.
- Treat each fixture's `golden-output.json` as its value coverage. Assertions cover only
  non-golden checks such as raw snapshots, separate-file hashes, prompt/model behavior, fields
  without normalized sidecars, and cross-cutting invariants.
- Keep fixture test cases in `tests/equity-fixture/run.test.ts` and shared assertions in
  `tests/support/run-fixtures/assertions.ts`; do not mix test-only behavior into production
  pipeline code.
- Do not hand-edit cassettes unless you are removing an obvious secret and will re-record afterward.
- If `golden-output.json` changes, inspect the diff for real behavior changes before committing.
- CI should use regression mode only; live eval and recording are manual developer workflows.
