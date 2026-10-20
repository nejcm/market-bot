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

## Choosing the iteration loop

| Change to exercise                                       | Use                                                                                                                | Inputs and scope                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Parser, calculation, small deterministic rule            | Module test                                                                                                        | Small saved provider input; fastest behavioral assertion                    |
| Evidence projection, report extra or Markdown            | `scripts/rerun-report.ts <run-id-or-path> --label <fresh>`                                                         | Saved normalized evidence plus `report.json`; zero network/model            |
| Final-synthesis prompt construction, retries or assembly | `scripts/replay-stage.ts --input <file> --label <fresh>`                                                           | Final-Synthesis Input; strict recorded responses, current prompts/playbooks |
| Collection and downstream integration                    | `scripts/replay-fixture-run.ts <name-or-capture-directory>`                                                        | Whole pipeline, HTTP/model cassettes, isolated state, no pacing             |
| Selected model behavior                                  | `scripts/eval-deep.ts --fixtures <case> --live-stages <stage> --label <fresh>` or `--input <file> --label <fresh>` | Estimate-only first; an approved batch uses the existing approval flag      |
| Changed source request or unavailable recording          | Explicitly authorized fresh research run                                                                           | Fresh acquisition; enable capture for subsequent offline iteration          |

`bun run check` remains the final verification gate. Replayed model responses prove wiring and
contract behavior, not model quality after a prompt change.

### Capturing a future authorized run

Set `MARKET_BOT_CAPTURE_REPLAY=1` for an already-authorized research run. This adds no source/model
calls. A successful capture publishes `<run>/replay/{meta,data-cassette,llm-cassette,state}.json`,
`final-synthesis-input.json` and any large hashed bodies under `bodies/`; the synthesis input's
`rawSnapshots` and `secTargetPacket` subtrees over 32 KB are stored there once by content hash and
resolved on load (older inline captures still load). It records ordered HTTP
failures and every model boundary, plus the actual consumed cache/news-seen/learned-peer/history,
Calibration, profile-reuse, alpha and circuit state. Circuit decisions use per-host run-length
sequences, retaining transitions and exact invocation counts without one state row per URL.
The ordinary report stays unchanged.
Configured SEC contact identities, local paths and credentials are redacted at recording boundaries;
auth headers are excluded, with the existing
fixture-secret scan as the publication gate. If capture fails, use the research report normally;
`capture-failure.json` means no ready replay capture was published; handled failures remove only
their own private staging directory and leave research artifacts intact. Partial capture directories
are not supported cases. No capture is written with the flag off.

```sh
bun run scripts/replay-fixture-run.ts /absolute/run/replay
bun run scripts/rerun-report.ts /absolute/run --label projection-case
bun run scripts/replay-stage.ts --input /absolute/run/replay/final-synthesis-input.json --label synthesis-case
bun run scripts/eval-deep.ts --input /absolute/run/replay/final-synthesis-input.json --label synthesis-eval
```

The final command prints an offline planning estimate and spends nothing without the existing
approval flag. It prints an expected figure from the recorded calls' token estimates beside a
worst-case bound that reserves every bounded synthesis repair attempt with 25% headroom; estimates
are not provider cost caps. Tests inject fake providers and never invoke a spending script or approval flag.

Direct scripts write only fresh `data/evals/<label>/` directories and reject live flags; they never
refresh production Calibration/history/index/news-seen state. Their `eval-sample.json` declares
partial scope, duration, call counts and errors. Stage replay also stores current requests,
validated report/Markdown, synthesis attempts, audit diagnostics, token groups and semantic fact
deltas against the captured baseline; failures exit nonzero. Direct-input eval summaries have
phase-only scope: `--compare` shows status, durations, call/token counts and report-derived
predictions, citations, data gaps and integrity, and refuses to compare them with fixture labels.
Report Rerun recomputes projections/renderers from stored derived evidence, not the original
collector calculations. Missing required normalized inputs fail; explicit null retains absence.
Older runs without a complete Final-Synthesis Input cannot use direct stage replay. Direct replay
supports only final synthesis, excludes challenger calls and does not fabricate trace/analytics
for a completed run. Pipeline capture replay still includes recorded challengers.

Captured cases can be passed as directories to `--fixtures` for pipeline eval. The harness restores
captured effective settings with placeholder credentials and isolated paths. HTTP/model/state
misses never enable network access and fail the sample even if production catches them. Large
body paths and hashes are checked before use. New source queries may require a new capture.

Offline wall times on 2026-10-16: `equity-aapl-deep` 14.145 s before harness pacing removal,
0.170 s after; realistic `equity-depository-deep` 12.257 s before, 0.312 s after. These are single
local measurements including Bun startup, not live-quality or provider-speed claims. The Console
report/workspace is unchanged. Its artifact file browser and index file-list projection exclude
capture directories, private partial captures and capture-failure markers through a shared filter.

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
([ADR 0005](./adr/0005-testing-and-replay.md)). Every fixture in
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
suppressed. No mutation framework is added as a dependency either; [ADR 0002](./adr/0002-platform-and-persistence.md)
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

Offline replay also writes `eval-sample.json` and `summary.json` under its retained temporary root.
Both scripts exit nonzero for any non-completed sample after writing diagnostics and the summary.
Unused recorded responses alone do not fail a conditional replay.

The replay command accepts exactly one fixture name and the optional `--live` flag (plus `--yes`).

## Frozen-input evals

`scripts/eval-deep.ts` repeats live replay N times per fixture and compares labels:

```sh
bun run scripts/eval-deep.ts --fixtures equity-depository-deep,equity-earnings-release-deep --label base
bun run scripts/eval-deep.ts --fixtures equity-depository-deep,equity-earnings-release-deep --label base --yes
bun run scripts/eval-deep.ts --compare base branch
MARKET_BOT_SYNTHESIS_MODEL=<model> bun run scripts/eval-deep.ts --fixtures equity-depository-deep,equity-earnings-release-deep --label <arm> --live-stages final-synthesis
```

`--live-stages <stage>` selects exactly one audited stage per batch. Supported names:
`specialist-analysis`, `instrument-evidence-analysis`, `market-behavior-analysis`,
`regime-context-analysis`, `mover-theme-analysis`, `critique`, `final-synthesis`,
`web-gather`, `web-subject-profile`, `evidence-request`, `financial-table-mapping`,
`forecast-disagreement`, and `spotlight-selection`. Unknown names, comma-separated lists,
and peer-universe proposal are rejected before provider creation. Omitting the selector keeps
the existing whole-live evaluation. No selector was added to `replay-fixture-run.ts`.

For example, this invocation only plans a critique evaluation:

```sh
bun run scripts/eval-deep.ts --fixtures equity-depository-deep --label critique-arm --live-stages critique
```

The selected stage uses current production prompt construction and every invocation of that stage
is live, including its phase-bounded loops/repairs and all challenger models for
`forecast-disagreement`. Every other model call uses strict LLM Cassette replay by exact
stage/model, falling back to stage alone only when exactly one model was recorded. A missing,
ambiguous, or exhausted recording fails replay. Requests without a stage identity (including
peer-universe proposal) remain unsupported. A skipped or disabled selected stage produces
`not-exercised`, never successful stage evaluation.

This is pipeline execution with selected-stage evaluation, not direct phase replay. When changing
an upstream stage, downstream model reasoning stays recorded: a valid final report does not prove
those models reasoned about the changed output. Deterministic consumers still execute. This scope
is printed before spending and stored in `eval-sample.json`, `summary.json`, and compare output.
`priorStages[].durationMs` is zeroed wherever that array exists; bespoke prompts without it retain
their own shape. Final-synthesis prompts still require the array. The audited prompts need no
other wall-clock-field freezing.

Adaptive Web Gather/evidence evaluations are constrained to recorded source requests. Changed
queries, URLs, or request bodies must match the Data Cassette. Unseen requests invalidate the
sample and block subsequent model calls, even if production recovers; they never enable live
source fetching. Recorded HTTP failures such as a 403 remain valid inputs and ordinary Source
Gaps. Already-started concurrent calls are not cancelled.

Before selected-stage spending, planning executes one strict offline pipeline preflight per
fixture in disposable temporary state with index access disabled. It measures current selected
prompt sizes (characters/4, an approximation) and counts reached calls. Strict preflight failures
stop planning before live provider creation. The estimate reserves the phase's bounded attempts:
seven for final synthesis, configured rounds for Web Gather/evidence loops, configured challenger
count for Forecast Disagreement, one for other stages; observed calls provide a lower bound.
Web Gather's configured rounds conservatively include its deep-equity parse retry. Per-call tokens
are the largest of 50k, the largest recorded selected call, or measured maximum input plus largest
recorded selected output, with another 25% headroom. The plan also prints an expected figure:
the sum over observed preflight calls of measured input plus recorded output (or the recorded
token estimate when larger), without headroom. A whole-run plan prints no expected figure. This is a planning estimate, not a
provider-enforced cost cap; changed adaptive paths, repairs, output lengths and tokenization can
differ from preflight. A zero-call preflight is disclosed. Only recorded fixtures
(`equity-depository-deep`, `equity-earnings-release-deep`, `equity-amd-deep`) carry real upstream
outputs; AMD remains incomplete as described below, and `eval-deep` rejects `incomplete` fixtures
before any replay.

The existing estimate-first workflow still applies: inspect the estimate, obtain explicit approval
for that batch, then use the same invocation with `--yes`. No additional spending entry point was
introduced. Selected offline tests require an injected fake provider and cannot construct an
ambient live provider.

`equity-amd-deep` is an eval-only fixture. Unlike the fixtures listed above, it is not replayed by
`bun run check` and carries no invariant assertions because it fails invariant C15. Since
`bd4d4aa2` the replay requests the Q2 8-K EX-99.1 (`q22026991.htm`), which the source run never
fetched, so the cassette misses it and the Item 2.02 evidence falls back to the EX-99.2 slide-deck
snippet, which stops before any results content. The AMD peer roster has since grown past the
recorded `NVDA,AVGO,INTC`, so the batched Yahoo peer-quote request and the new peers' SEC requests
also miss and replay leaves no usable valuation peers. Rebuild it with `scripts/fixture-from-cache.ts` from
a later AMD deep run that has cached the EX-99.1; the converter keeps same-day cache entries fetched
at or before the run's start (latest per request), but it reproduces neither historical context nor a
reused profile's sources, so a source run whose recorded final synthesis cites either will not
convert.
`scripts/fixture-from-cache.ts` converted it offline from that run's `data/cache` entries and
`stages.json`, throwing on any request without a cache hit. It is not a faithful replay: the
web-subject-profile output is borrowed from an earlier run, history and news-seen state are empty,
Yahoo news requests 8 items where the run cached 15, FRED, Marketaux, and Massive are unconfigured
(Evidence Quality medium instead of high), and Finnhub endpoints that returned 403 replay as cassette
misses. Its `meta.json` `note` records the same.

Without `--yes` it prints the planned run count and token estimate and stops. An existing label or
sample dir is refused. Each sample records its status (`completed`, `failed-final-synthesis`, `threw`,
`incomplete`, or `not-exercised`), HTTP/model replay miss keys, replayed/live call counts, and
available consumed/unused response counts in `eval-sample.json`, even when the run fails.
The sample's `tokens.live` and `tokens.replayed`, exposed as `modelTokens.live` and
`modelTokens.replayed` in comparisons, sum successful provider response token estimates at each
boundary. Failed calls may have incurred usage unavailable to the harness; these totals are not
billing records. Existing `tokens.total` and per-stage metrics describe persisted stages and mix
live and replayed estimates.
`summary.json` is rewritten after every sample, and a sample dir without a record counts as
`incomplete`. A metric group a sample could not measure (no report on a failed run, no stages) is
left out of that sample's mean and shows as `n=k/N`, so a failure never reads as an improvement.
Synthetic fixtures (`equity-aapl-deep`, `equity-nbis-deep`, `equity-web-fallback-deep`) record tiny
cassette token counts, so the estimate floors each run at the ~438k of a real deep run.
`tests/eval-deep.test.ts` covers isolation, replay failures, selected-stage routing/current prompts,
unexercised stages, adaptive source misses, estimates, comparison scope, and final-synthesis repairs
using injected fake live providers. Cassette tests cover every selectable identity, repeated calls,
and bespoke prompts without `priorStages`. Tests never spawn spending scripts or approve a real
entry point.

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

`scripts/generate-fixture-price-series.ts` owns the shared issuer Yahoo chart bodies (`SEED = 17`)
and distinct SPY benchmark bodies (`BENCHMARK_SEED = 18`) in
`equity-aapl-brief`, `equity-aapl-deep`, `equity-analysis-comprehensive`,
`equity-analysis-estimated-suppressed`, `equity-fpi-quarterly`,
`equity-fpi-ifrs-semiannual`, and `equity-web-fallback-deep`. Do not re-record these chart entries
independently: preserve the existing chart bodies when updating unrelated cassette data, and use the generator only for an
intentional shared price-path change before replaying all seven fixtures.

## Fixture maintenance rules

- Keep harness helpers in `tests/support/run-fixtures/`.
- A fixture that exists to pin one behavior carries one targeted assertion for it in
  `tests/equity-fixture/run.test.ts`; never a snapshot of its output.
- Keep fixture test cases in `tests/equity-fixture/run.test.ts` and shared assertions in
  `tests/support/run-fixtures/assertions.ts`; do not mix test-only behavior into production
  pipeline code.
- Do not hand-edit cassettes unless you are removing an obvious secret and will re-record afterward.
