# market-bot — Agent Guide

Bun + TypeScript CLI that turns public market data into sourced research artifacts with measurable predictions, scoring, and calibration. A Svelte Research Console under `app/` reads those artifacts.

## Read first

- [CONTEXT.md](./CONTEXT.md) — domain glossary. Use its terms (Observable Prediction, Source Gap, Run Artifact, Web Gather, Extended Evidence, Domain Playbook, Miss Autopsy, Calibration) verbatim; don't paraphrase them into generic finance words.
- [docs/architecture.md](./docs/architecture.md) — layout, subsystems, data flow. The map lives there, not here.
- [docs/conventions.md](./docs/conventions.md) — code style, testing, commits.
- [docs/configuration.md](./docs/configuration.md) — env vars.
- [docs/adr/README.md](./docs/adr/README.md) — canonical ADR index.

The orchestration skills (`improve-market-runs`, `run-review`) are heavy on purpose — invoke them only when I name them. If parallel agents run, one owns `data/` writes and each owns disjoint `src/` paths; never two at once in `report-extras-contract.ts`.

## Non-negotiables

1. **Research-only.** No buy/sell/hold calls, sizing, or execution language ([ADR 0001](./docs/adr/0001-research-only-boundary.md)).
2. **Predictions must be observable.** Resolvable from public price data ([ADR 0003](./docs/adr/0003-forecasts-scoring-calibration-cross-run-intelligence.md)).
3. **No secrets in code, tests, or fixtures.** Env vars only.
4. **Bun + oxc only.** No Node, Prettier, ESLint, or Biome ([ADR 0002](./docs/adr/0002-typescript-bun-orchestration.md)).
5. **No unsolicited planning docs.** `plans/` was deliberately purged.

Research-only is regex-enforced in `src/domain/research-language.ts`; the line is narrower than it looks:

```
bad  — trips the valuation-certainty pattern:
  Peer multiples imply a fair value of $214, a 12% valuation gap to spot.

good — same information, sanctioned framing:
  Peer-implied price reference range: $198–$226 vs $191 spot.
  Peer-derived reference range for context only; not a target price.
```

Blocked: "fair value", "intrinsic value", "price target", "under/overvalued", "margin of safety", "% gap", sentence-initial Buy/Sell/Hold, and "investors/traders/you should". Descriptive lowercase prose is fine.

## ADR guidance

ADRs document current decisions and should be followed by default, but they can be changed when a better approach is justified.

- Don't silently ignore an ADR; name the record and explain why it no longer fits.
- Warn before changing one, and update or supersede it in the same change.
- Cite only canonical ADRs from [docs/adr/README.md](./docs/adr/README.md).

## Blast radius

Live runs cost real money and time — a deep equity run is ~12 minutes and ~438k live model tokens.

- **Never run the CLI to "check something."** Read an existing artifact under `data/runs/` (newest first) or replay a fixture. Fixture replays are free.
- **Never pass `--live`**, and never run the fixture *recorder* — it hits every provider and can capture secrets into cassettes.
- **Never `--write-golden`** unless the change was intentionally output-changing, and say so in the commit body.
- **Never delete or prune under `data/`.** `cache prune`, `index rebuild`, `history rebuild` throw away derived state that costs provider calls to rebuild. Ask instead.
- **Never read or echo `.env`.** It holds live keys; `.env.example` has the names.
- **Never kill a running CLI process.** A partial run leaves a half-written run dir the index then picks up.

Always fine: `bun test`, `bun run check`, fixture replays without `--live`, reading anything under `data/runs/`.

## Data layout

Artifacts land in `data/runs/<run-id>/` — `report.json`, `report.md`, `score.json`, `analytics.json`, `stages.json`, `trace.json`, `normalized/`, `raw/`.

`data/` also holds `calibration/`, `index.sqlite` (Run Artifact Index), `history/` (search index + instrument timelines), `cache/`, and `news-seen.json` (suppresses repeat news URLs for 30 days). All rebuildable, none disposable.

`prompts/` holds the model stage prompts and Domain Playbooks — a stage's behavior is usually changed there, not in `src/`.

## Hit every surface

The recurring defect is a change that lands only on the path you tested (see `684e454`). Walk the chain end to end.

**A new evidence field or report section:**

1. Collector — `src/sources/extended-evidence/<provider>.ts` and its contract file.
2. Projection — `src/research/extended-evidence-projections.ts`, the single producer of report extras.
3. Reader types — `src/report/report-extras-contract.ts`. **Read its header comment first**: producer types are strict, reader types structural.
4. Artifact schema — `src/report/schema.ts`.
5. Markdown — the matching `src/report/markdown-*.ts` (equity, evidence, profile, market-update are separate renderers).
6. Source-id traversal — the citation walk must see the new rows, or the claim renders uncited.
7. Console view model — `app/client/view-model-*.ts` and the run-workspace modules.
8. Console component — `app/client/components/*.svelte`.
9. Index projection — the `src/run-artifact-index-*` modules, if the field should be searchable.
10. Tests and goldens — a unit test at the adapter seam, then a fixture replay with `--check-golden`.

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
