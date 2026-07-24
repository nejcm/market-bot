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
