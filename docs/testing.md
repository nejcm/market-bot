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

`bun run knip` is the unused-code gate. It reports nothing today because the repo is clean on the
axis it measures, not because it cannot fail: appending an export with no consumer anywhere (a
`const` or a `type`) to a `src/` file makes `bun run knip` report it and exit 1.

`knip --production` adds nothing here, but not for the reason previously recorded. Production mode
does **not** drop user-configured `entry` patterns: with `-p`, knip still resolves
`tests/**/*.ts` as entry files, so every test still counts as a consumer and the run reports
nothing. Dropping the test entries entirely also reports nothing, which confirms no `src/` export is
kept alive by tests alone.

`ignoreExportsUsedInFile` is **off**, so the same-file-only axis is measured too: an `export`
whose only consumer is its own declaring file is reported. That flag used to be on and hid 354
such exports (110 values, 244 types; 275 in `src/`, 79 in `app/`, across 106 files). The backlog
was cleared by dropping the redundant modifiers, and the flag was turned off permanently so the
axis cannot silently refill. Appending an exported `type` that only its own file references now
makes `bun run knip` report it and exit 1.

Keeping it off costs one recurring habit: export a symbol when something else imports it, not by
reflex. That is cheaper than re-running a 354-item census later.

Knip has one known limitation here. It does not resolve namespace-member access inside Svelte
markup, so `import * as X` plus `<X.Thing />` in a template reports `Thing` as unused. Use named
imports in `.svelte` files rather than suppressing the finding.

To take a census with a different setting, copy `knip.json`, edit the flag in the copy, and run
`bun run knip -- --config <copy> --reporter json --no-exit-code`; count the `exports` and `types`
arrays by full `file` path rather than the terminal reporter's abbreviated rows.

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
- `tests/fixtures/runs/equity-depository-deep/`

Recording a new fixture with `scripts/record-fixture-run.ts` runs under the same config replay
rebuilds from `meta.json`, so a live-only setting cannot leak into the cassettes. Supported live source
providers are recorded by name, use real credentials only while recording, and replay with fixture
tokens. Other data-provider keys must still be neutralised on the command line, and
`MARKET_BOT_FORECAST_DISAGREEMENT_MODELS` must be blank because it otherwise arms a replay
invariant the fixture cannot satisfy. Legacy Yahoo cassette entries keep exact `crumb` matching;
new entries pin the rotating value and replay falls back to that pinned key. Pinning rather than
deleting the crumb keeps the un-authed 401 and its authed 200 as separate entries, so replay still
walks the credential path; a legacy cassette never contains the placeholder, so the fallback cannot
hit it, and no live crumb can equal the placeholder.

Each fixture contains:

- `data-cassette.json` — scrubbed HTTP responses keyed by canonical request.
- `llm-cassette.json` — ordered model responses keyed by stage and model.
- `meta.json` — pinned run config, clock, command, and model settings.

Replays assert invariants, not byte-exact output
([ADR 0008](./adr/0008-replay-invariants-no-output-snapshots.md)). Every fixture in
`tests/equity-fixture/run.test.ts` must complete with a readable `report.json` and no
`failure.json`, persist exactly what the run generated (report, Markdown, analytics, outcomes,
evidence bundle), validate the persisted report against the report schema, pass the research-language gate, resolve every
evidence-bundle source id, keep `reportIntegrity` at `high`, and pass the
`tests/support/run-fixtures/` property checks. To read a replayed run by hand:

```sh
bun run scripts/replay-fixture-run.ts equity-aapl-brief # prints the retained temporary run directory
```

Retained directories are not removed automatically; delete them when finished.

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
bun run scripts/replay-fixture-run.ts equity-aapl-deep --live        # prints the token estimate only
bun run scripts/replay-fixture-run.ts equity-aapl-deep --live --yes  # spends
```

With `--yes` this writes a run under `data/evals/replay-live-<timestamp>/<fixture>/1/runs/`, never
`data/runs/`, and costs live model usage. Only run it with explicit approval. It requires the same provider setup
as normal CLI runs, for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or Codex login depending on
`MARKET_BOT_PROVIDER`. It does not refresh checked-in fixture cassettes.

The replay command accepts exactly one fixture name and the optional `--live` flag (plus `--yes`).

## Frozen-input evals

`scripts/eval-deep.ts` repeats live replay N times per fixture and compares labels:

```sh
bun run scripts/eval-deep.ts --fixtures equity-depository-deep,equity-earnings-release-deep --label base
bun run scripts/eval-deep.ts --fixtures equity-depository-deep,equity-earnings-release-deep --label base --yes
bun run scripts/eval-deep.ts --compare base branch
MARKET_BOT_SYNTHESIS_MODEL=<model> bun run scripts/eval-deep.ts --fixtures equity-depository-deep,equity-earnings-release-deep --label <arm> --live-stages final-synthesis
```

`--live-stages final-synthesis` keeps final synthesis live and replays every upstream stage from
the fixture's LLM cassette by stage name, so arms compare synthesis models on identical upstream
outputs; replayed stage durations are zeroed in the live prompt so it is byte-identical across
samples. A missing or exhausted upstream cassette entry throws, and because some stages swallow
that error, any replay miss also refuses every later live call so the sample fails before spending.
The estimate reserves the maximum final-synthesis call count (initial, prediction reprompts, report
retries) at the larger of the biggest recorded synthesis call and ~50k tokens. Only recorded
fixtures (`equity-depository-deep`, `equity-earnings-release-deep`) carry real upstream outputs.

Without `--yes` it prints the planned run count and token estimate and stops. An existing label or
sample dir is refused. Each sample records its status (`completed`, `failed-final-synthesis`, or
`threw`) and every `Fixture data cassette miss` key in `eval-sample.json`, even when the run fails;
`summary.json` is rewritten after every sample, and a sample dir without a record counts as
`incomplete`. A metric group a sample could not measure (no report on a failed run, no stages) is
left out of that sample's mean and shows as `n=k/N`, so a failure never reads as an improvement.
Synthetic fixtures (`equity-aapl-deep`, `equity-nbis-deep`, `equity-web-fallback-deep`) record tiny
cassette token counts, so the estimate floors each run at the ~438k of a real deep run.
`tests/eval-deep.test.ts` covers isolation, miss counting, compare output, and the final-synthesis-only
live provider with replayed models.

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

Recording creates or replaces fixture cassettes from a live run:

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
intentional shared price-path change before replaying all six fixtures.

## Fixture maintenance rules

- Keep harness helpers in `tests/support/run-fixtures/`.
- A fixture that exists to pin one behavior carries one targeted assertion for it in
  `tests/equity-fixture/run.test.ts`; never a snapshot of its output.
- Keep fixture test cases in `tests/equity-fixture/run.test.ts` and shared assertions in
  `tests/support/run-fixtures/assertions.ts`; do not mix test-only behavior into production
  pipeline code.
- Do not hand-edit cassettes unless you are removing an obvious secret and will re-record afterward.
