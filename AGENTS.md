# market-bot — Agent Guide

Bun + TypeScript CLI that turns public market data into sourced research artifacts with measurable predictions, scoring, and calibration. A Svelte Research Console under `app/` reads those artifacts.

## Read first

- [CONTEXT.md](./CONTEXT.md) — domain glossary. Use its terms (Observable Prediction, Source Gap, Run Artifact, Web Gather, Extended Evidence, Domain Playbook, Miss Autopsy, Calibration) verbatim; don't paraphrase them into generic finance words.
- [docs/architecture.md](./docs/architecture.md) — layout, subsystems, data flow. The map lives there, not here.
- [docs/conventions.md](./docs/conventions.md) — code style, testing, commits.
- [docs/how-it-works.md](./docs/how-it-works.md) — end-to-end flow and full command reference.
- [docs/configuration.md](./docs/configuration.md) — env vars.
- [docs/adr/README.md](./docs/adr/README.md) — canonical ADR index.

The `run-review` skill is heavy on purpose — invoke it only when I name it. If parallel agents run, one owns `data/` writes and each owns disjoint `src/` paths; never two at once in `report-extras-contract.ts`.

## Non-negotiables

1. **Research-only.** No buy/sell/hold calls, sizing, or execution language ([ADR 0001](./docs/adr/0001-research-only-boundary.md)).
2. **Predictions must be observable.** Resolvable from public price data ([ADR 0003](./docs/adr/0003-forecasts-scoring-and-calibration.md)).
3. **No secrets in code, tests, or fixtures.** Env vars only.
4. **Bun + oxc only.** No Node, Prettier, ESLint, or Biome ([ADR 0002](./docs/adr/0002-platform-and-persistence.md)).
5. **No unsolicited planning docs, and never commit one.** `.plans/` is gitignored in
   full — write there only when I ask for a document, and never `git add -f` it,
   move it under `docs/`, or reproduce it in a commit message or PR body. A
   requested plan or run review is a working artifact for me, not a repo record.

Research-only is regex-enforced in `src/domain/research-language.ts`; the line is narrower than it looks:

```
bad  — trips the valuation-certainty pattern:
  Peer multiples imply a fair value of $214, a 12% valuation gap to spot.

good — same information, sanctioned framing:
  Peer-implied price reference range: $198–$226 vs $191 spot.
  Peer-derived reference range for context only; not a target price.
```

Blocked: "fair value", "intrinsic value", "price target", "under/overvalued", "margin of safety", "% gap", sentence-initial Buy/Sell/Hold, and "investors/traders/you should". Descriptive lowercase prose is fine.

The gate applies to what market-bot asserts, not what its sources say. `assertSafeReportLanguage` scans model-authored prose only; quoted source text — `sources[]`, `extendedEvidence[]` — and deterministic assembly text are exempt ([ADR 0001](./docs/adr/0001-research-only-boundary.md)). Widening it to quoted text makes reports unpublishable over an issuer's own filing wording, which no repair reprompt can fix. When you add a report surface, classify it per field and say which side it lands on; the exempt list is closed, so adding to it needs an ADR amendment.

The scanned text is joined with newlines, not `JSON.stringify`. The sentence-initial pattern needs `^` or `.!?;:\n` before the verb, and a JSON blob puts a quote there — under the old blob a field opening with "Buy the dip" passed. Keep the delimiter.

## ADR guidance

ADRs document current decisions and should be followed by default, but they can be changed when a better approach is justified.

- Don't silently ignore an ADR; name the record and explain why it no longer fits.
- Warn before changing one, and update or supersede it in the same change.
- Cite only canonical ADRs from [docs/adr/README.md](./docs/adr/README.md).

## Blast radius

Live runs cost real money and time — a deep equity run is ~12 minutes and ~438k live model tokens (a legacy estimate that double-counts Codex reasoning; correction size unknown).

- **Never run the CLI to "check something."** Read an existing artifact under `data/runs/` (newest first) or replay a fixture. Fixture replays are free.
- **Live-LLM fixture runs only via `scripts/eval-deep.ts --yes`** (or `scripts/replay-fixture-run.ts --live --yes`), and only with my explicit approval per batch — run without `--yes` first; it prints the run count and token estimate and spends nothing. Both write only under `data/evals/<label>/`, never `data/runs/`. Never run the fixture _recorder_ — it hits every provider and can capture secrets into cassettes.
- **Never delete or prune under `data/`.** `cache prune`, `index rebuild`, `history rebuild` throw away derived state that costs provider calls to rebuild. Ask instead.
- **Never read or echo `.env`.** It holds live keys; `.env.example` has the names.
- **Never kill a running CLI process.** The spend is already sunk; a killed run leaves only a hidden `data/.runs-<run-id>.partial` stage dir, never a run dir. Parallel runs are supported: run dirs publish whole, and score passes, calibration, index and history writes serialize on `data/shared-state.lock` (news-seen and learned-peer merges on their own `.lock` files). Source-provider rate limits are per process, so parallel runs double the request rate.

### Fast iteration on real data

Retest a change against saved run data instead of a fresh live run. Pick the narrowest tool that reaches the code you changed ([docs/testing.md](./docs/testing.md) has the full table):

| Changed                                               | Command                                                                                                                                                                                             | Cost                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Projection, report extras, Markdown renderer          | `bun run scripts/rerun-report.ts <run-dir> --label <fresh>` — works on any past run                                                                                                                 | ms, offline          |
| Final-synthesis prompt or logic, post-synthesis audit | `bun run scripts/replay-stage.ts --input <run>/replay/final-synthesis-input.json --label <fresh>` — replays recorded model output, so it proves wiring, not model quality                           | <1 s, offline        |
| Parser, collection, normalization, any upstream stage | `bun run scripts/replay-fixture-run.ts <fixture-name \| <run>/replay>` — whole pipeline, strict cassettes                                                                                           | <1 s, offline        |
| Model quality of one stage                            | `bun run scripts/eval-deep.ts --fixtures <case> --live-stages <stage> --label <fresh>` (or `--input <file>` for synthesis) — only that stage is live; estimate first, `--yes` only with my approval | tokens for one stage |
| Changed source request, or no capture exists          | Fresh live run with `MARKET_BOT_CAPTURE_REPLAY=1` — costs a full run, then becomes a replay case                                                                                                    | full run             |

- `<run>/replay/` exists only for runs made with `MARKET_BOT_CAPTURE_REPLAY=1`. Older runs support `rerun-report` only; they never stored request URLs or model identities.
- Replay is strict: a missing or exhausted recording fails the sample and blocks later live calls. A miss after a parser or query change means the recorded request no longer matches — recapture, don't loosen replay.
- Outputs go under `data/evals/<label>/` (fresh label each time) or a temp dir; original runs are never touched. Replays still don't replace `bun run check`.
- Judging a live-run delta: [docs/run-variance-baseline.md](./docs/run-variance-baseline.md) has same-code noise bands (AMD `--deep`) and a command to check whether they still apply.

Always fine: `bun test`, `bun run check`, fixture replays without `--live`, `scripts/eval-deep.ts` / `replay-fixture-run.ts --live` without `--yes` (prints the plan only), `eval-deep.ts --compare`, reading anything under `data/runs/` or `data/evals/`.

## Data layout

Artifacts land in `data/runs/<run-id>/` — `report.json`, `report.md`, `score.json`, `analytics.json`, `outcomes.json`, `stages.json`, `trace.json`, `normalized/`, `raw/`.

Failed final-synthesis runs leave `failure.json`, `outcomes.json`, `rejected-report.json`, `stages.json`, `normalized/`, and `raw/`; no `report.json`, `report.md`, `trace.json`, or `analytics.json`. Run dirs are staged and renamed into `data/runs/` whole (`publishRunArtifacts`), so a visible run dir is always complete.

`data/` also holds `calibration/`, `index.sqlite` (Run Artifact Index), `history/` (search index + instrument timelines), `cache/`, and `news-seen.json` (suppresses repeat news URLs for 30 days). All rebuildable, none disposable.

To find a cached payload, filter by adapter: `jq -r 'select(.adapter=="sec-companyfacts") | "\(input_filename) \(.payload.cik) \(.payload.entityName)"' data/cache/<date>/*.json`. Filenames are request-fingerprint hashes; neither cache entries nor `raw/snapshots.json` record the request URL.

Every run records `codeVersion` (package version, git branch/commit, dirty flag) in `trace.json`, `analytics.json`, and `failure.json` — check it before comparing runs across commits.

Outside `data/`, `.reviews/` (run-review output), and `.plans/` are gitignored working files, none a repo record. `plans/issues.md` (tracked) is the issue backlog.

`prompts/` holds the model stage prompts and Domain Playbooks — a stage's behavior is usually changed there, not in `src/`.

## Hit every surface

The recurring defect is a change that lands only on the path you tested (see `684e454`). Walk the chain end to end.

SEC parser changes (`src/sources/extended-evidence/financial-*`, `sec-edgar.ts`, `sec-filing-text.ts`) report a sweep delta with `bun run sweep:sec`.

**Every change, not just the ones below:** before calling a task done, check whether these need updating too — and say so either way ("console unaffected because X" / "updated console view-model Y" / "fixture invariants unaffected because Z"):

- Svelte Research Console — `app/client/**`.
- Fixture invariants — `tests/equity-fixture/run.test.ts` and `tests/support/run-fixtures/assertions.ts`, replayed by `bun run check` for every listed fixture. There are no output snapshots, so a behavior worth keeping needs its own assertion ([ADR 0005](./docs/adr/0005-testing-and-replay.md)). `bun run scripts/replay-fixture-run.ts <fixture-name | <run>/replay>` prints a replayed run directory to read.
- Prompt baseline — prompt text is pinned separately in `tests/support/prompt-baseline.golden.json`; refresh with `UPDATE_PROMPT_BASELINE=1 bun test tests/prompt-baseline.test.ts`.

The checklists below are the common cases; use them as a starting point, not a ceiling — think about any other surface (docs, CLI help, index projections) the change could touch.

**A new evidence field or report section:**

1. Collector — `src/sources/extended-evidence/<provider>.ts` and its contract file.
2. Projection — `src/research/extended-evidence-projections.ts`, the single producer of report extras.
3. Reader types — `src/report/report-extras-contract.ts`. **Read its header comment first**: producer types are strict, reader types structural.
4. Artifact schema — `src/report/schema.ts` for `report.json`; deep-equity `normalized/evidence-bundle.json` types in `src/deep-equity/types.ts`, shape validation in `src/deep-equity/artifact-schema.ts`, readers in `src/run-artifacts.ts`.
5. Markdown — the matching `src/report/markdown-*.ts` (equity, evidence, profile, market-update are separate renderers).
6. Source-id traversal — the citation walk must see the new rows, or the claim renders uncited. `webSubjectProfile` and `businessFramework` have one `*SourceRows` walk in `report-extras-contract.ts` that feeds validation, research-only segments, and citations; add the field there once.
7. Console view model — `app/client/view-model-*.ts` and the run-workspace modules.
8. Console component — `app/client/components/*.svelte`.
9. Index projection — the `src/run-artifact-index-*` modules, if the field should be searchable.
10. Tests — a unit test at the adapter seam, a fixture assertion if the field should be pinned, then `bun run check`, which replays every fixture listed in `tests/equity-fixture/run.test.ts` and asserts its invariants (a new fixture must be added to that list).

**A new env var:** `src/config.ts` → `.env.example` → `docs/configuration.md` → the run profiles under `src/config/runs/profiles/` if it is run-type-scoped. All four.

**A new CLI command:** `src/cli/args.ts` → the job registry → `src/domain/run-types.ts` if it is a research run type → `docs/run-types.md` → `app/jobs.ts` if the console can queue it.

**A new domain term:** add it to `CONTEXT.md` in the same change.

## Absence is a finding, not a no-op

Every feature can be off — `MARKET_BOT_*_DISABLE` flags, a missing key, a timed-out source. When you add a producer, say what happens when it produces nothing:

- Missing data becomes a declared source gap (`src/domain/source-gaps.ts`, `src/research/deterministic-gaps.ts`), never a silent omission.
- An empty or malformed row is **kept** for the source-id traversal; only the renderer decides to skip it.
- `undefined` and `[]` are different — omitted section vs bare header. Don't default one to the other.
- Every new flag gets its off-path tested, not just its on-path.

## Commands

```sh
bun run src/cli.ts equity AAPL           # costs tokens — see Blast radius
                                         # brief is the default; --deep is the only depth flag,
                                         # and unknown flags throw rather than being ignored
bun run app:dev                          # Research Console, hot reload
bun test tests/report.test.ts            # edit loop only, never the verification
bun run check                            # the only thing you may report as passing
```

`bun run check` is `fmt + lint + fmt:check + typecheck + knip + app:build + test:coverage`.

Gotchas:

- `bun test` is not `bun run test:coverage`; only the latter enforces the coverage floor.
- `bun run typecheck` is `tsc --noEmit` **and** `app:check` — a Svelte-only regression passes `tsc` and fails `check`.
- `bun run knip` fails on any unused export, so an export you don't yet consume breaks the build.
- `bun run fmt -- {files}` and `bun run lint:staged -- {files}` need `--`, or the args go to bun instead of oxfmt/oxlint.

Requirements:

- All checks pass before a task is complete. Only `bun run check` counts as verification.
- Tests ship in the same commit as the code.
- Never bypass hooks with `--no-verify`.
- No `Co-authored-by` trailers on commits.
- Update `docs/configuration.md` when introducing env vars.
- No backwards compatibility needed for now.

## Product goals

A long-term fundamental research view of a business, where every number can be traced and checked and every unknown is declared. It should be as deep as a paid deep-dive app, without the verdict.

When goals conflict, resolve in this order:

1. **Correct.** A wrong number is worse than a missing one.
2. **Sourced.** Every figure carries its source ID, period, as-of or filing date, unit, and currency.
3. **Complete or declared.** What a run did not see becomes a Source Gap.
4. **Fresh.** Use the newest filed period, state its as-of date, and gap anything stale.
5. **Forecasts.** Observable Predictions are the accountability layer on top of the evidence. Never bend the evidence to make a forecast work.
6. **Presentation.**

Horizon for equity instrument and thematic research: long-term first. That means multi-year history, business quality, moat, capital allocation, and balance-sheet resilience. Quarterly data and near-term catalysts are welcome as supporting detail, not as the frame. Market-overview, crypto, and alpha-search runs are short-horizon by design (`--horizon` in trading days), and this does not change them.

### Reference apps

Comparable products set the bar for coverage; [docs/reference-apps.md](./docs/reference-apps.md) maps their surfaces to ours. Their verdicts are out of bounds.

Never ship these, whatever a reference app does: a composite score, a grade or snowflake, a rank or grade of an instrument's quality or attractiveness, a Pass/Watch/Buy decision, a fair value or DCF target, or "under/overvalued" ([ADR 0001](./docs/adr/0001-research-only-boundary.md)). Ordering by an observed quantity, such as movers by move size or peers by fit, is fine. Show the component checks and postures, never one number that sums them up. A feature idea taken from a competitor gets reframed as evidence plus context before it is built.

## Financial data best practices

These rules apply when adding or fixing a metric, parser, or projection. They describe the target. Where current code falls short, the metric's `label` or `basis` says so, and if `plans/issues.md` exists its "Known gaps vs AGENTS.md data rules" section lists the gap. Close a gap deliberately, as its own change with its own tests, never as a side effect of an unrelated fix.

- **Use standard definitions.** Follow the textbook formula. Where the code deviates, its `label` or `basis` string says how (`freeCashFlowProxy`, `ebitdaProxy`, "period-end invested capital", "latest FY"). A new deviation needs the same.
  - FCF = operating cash flow − capex. FCF margin = FCF / revenue.
  - EV = market cap + debt + preferred + noncontrolling interest + redeemable (temporary) equity − cash − short-term investments. Net debt = debt − cash − short-term investments. Long-term securities stay out. Not applicable for depository issuers.
  - ROIC = NOPAT / invested capital, where NOPAT = operating income × (1 − effective tax rate) and invested capital = equity + debt − cash.
  - Interest coverage = operating income / interest expense. Current ratio = current assets / current liabilities.
  - Payout ratio = dividends / net income. Shareholder yield = (dividends + buybacks) / market cap, with gross or net-of-issuance stated.
  - Multi-year growth is a CAGR over complete fiscal years, never the mean of YoY changes.
- **Separate flows from stocks.** Income and cash-flow items are period flows. Balance-sheet items are point-in-time, so every return ratio states its balance basis (period-end, beginning, or average).
- **Never mix periods.** Annual, quarterly, YTD, and TTM are distinct. TTM is the sum of four quarters or FY + YTD − prior YTD (reconciled), never one quarter × 4 unless labeled annualized. Compare quarters YoY, not QoQ, because of seasonality. Fiscal years are not calendar years.
- **Point-in-time.** Information becomes public on the filing or release date, not the period end. Forecast Baselines and Predictions never use data published after their `infoCutoff`, because that is look-ahead bias. Valuation joins pair fundamentals with the first verified close on or after the date they became public, never an earlier one. Restated values replace prior ones, but the period identity is kept.
- **Per-share and splits.** EPS uses diluted weighted shares, and an approximation carries its disclosure note (`ttm:eps-approximation`). Prices and per-share series are split-adjusted. Share-count trend and SBC are dilution evidence, so read buybacks against them.
- **Accounting basis.** GAAP/IFRS as filed is the default. Non-GAAP figures and company-defined KPIs are labeled as such. Respect Accounting Scope (continuing vs total operations, parent vs NCI, SEC vs provider basis) and never divide across scopes.
- **Currency.** Keep Quote Currency and Reporting Currency apart, and convert at a declared date's FX rate. A currency mismatch suppresses the metric with a gap, never a silent division.
- **Not meaningful beats nonsense.** P/E on negative EPS, margins on near-zero revenue, and EV for banks are `not meaningful` with a reason, never a huge or negative number. Banks, insurers, REITs, and pre-revenue biotech need sector-appropriate metrics, or the metric is declared not applicable.
- **Moat is evidence with a neutral posture, not a rating.** Use the standard sources: intangibles, switching costs, network effects, cost advantage, efficient scale. Back them with numbers, such as ROIC sustained above cost of capital over years and stable gross margins. Missing evidence is a gap, not "no moat".
- **Valuation is context.** Use multiples vs the company's own history and vs a justified Peer Universe, plus what the price implies (reverse DCF). Never what it is "worth".
- **Forecast quality.** Use proper scoring (Brier), and judge skill by Paired Skill vs the Forecast Baseline, reliability and resolution, not by hit rate. Near-Base-Rate Predictions are not skill. Below the Paired Skill sample floor, make no skill claim and do not justify a prompt change with skill numbers. Check live deltas against [docs/run-variance-baseline.md](./docs/run-variance-baseline.md) if its bands still apply.

## Fixes and improvements workflow

Every value, metric, data, or behavior issue, whether found in a run review, a test, or by eye, goes through these steps in order. Typo and docs-only fixes can skip it. Do not skip a step because the fix looks obvious. "Obvious" fixes are how `684e454`-style one-path changes land.

1. **Validate.** Confirm the issue is real before touching code. Reproduce it from saved artifacts or a replay (see Blast radius), never a live run. Read `codeVersion` first, because the run may predate a fix that already landed. A reported issue that does not reproduce is closed with that evidence, not "fixed" anyway.
2. **Research how it should work.** Before deciding what is wrong, establish what right looks like and cite it:
   - **Definition:** the standard formula and basis, from a standard reference (CFA Institute curriculum, SEC/FASB rules, Damodaran) or the issuer's own definition for a company KPI.
   - **Source of truth:** which provider and field should feed it, and which filing form, XBRL concept, or endpoint. Prefer primary sources (SEC filing, issuer IR) over aggregators. Check whether `src/sources/` already pulls it before adding a provider.
   - **Expected value:** the correct figure for the reproducing case, checked by hand against the primary source online when feasible.
   - **Prior art:** how reference apps or the market-data convention present it, when that informs the definition, not the verdict.
3. **Debug to the root cause.** Trace the real path: raw payload → normalized → Metric Section → projection → Markdown renderer and Console. Find the first stage where the value diverges from the expected one. Fix there, once, in shared code. Patching the symptom at a downstream stage is not a fix. If the provider itself returns wrong or ambiguous data, declare a gap or disclosure. Do not add a heuristic that guesses.
4. **Scope the change.** List every surface it reaches (Hit every surface), what happens when the input is absent (Absence is a finding), and any ADR it touches. If the fix changes a documented decision, say so before building it.
5. **Fix and test.** Write a test that fails before the fix and passes after. A value fix pins the corrected number with the issuer, period, and filing it was checked against. Cover the off-path and the edge cases the research turned up: negative, zero, missing, mixed currency, depository issuers. Prefer a fixture assertion when the behavior should hold across runs.
6. **Verify on real data.** Re-run the narrowest replay from the Fast iteration table against the reproducing run, and confirm the value now matches the researched expectation. Then prove no other run regressed: replay every fixture in `tests/equity-fixture/run.test.ts` and `rerun-report` a few recent runs (different issuers, one deep) before and after, and explain every changed value. Run `bun run sweep:sec` for SEC parser changes. Then `bun run check`.
7. **Review.** Re-read the diff against steps 2–4:
   - Does the definition match the cited source?
   - Is every surface updated?
   - Is research-only wording intact?
   - Did anything else change that you did not intend?

   For non-trivial changes, get an independent review (the `code-review` skill or a second agent) and validate its findings against the code before acting on them.

8. **Record.** The PR or commit body states, in your own words, the issue, the evidence that it was real (artifact paths, numbers, the filing), the reference that defines correct behavior, the root cause, and how it was verified. Never paste `.reviews/` or `.plans/` content (Non-negotiable 5). Follow-ups you found but did not fix go to `plans/issues.md`, not into the same change.

Improvements and new features follow the same steps, with step 1 replaced by **Justify**: name the Product goals priority it serves and the user-visible gap it closes, and check that it does not cross the never-ship list above.
