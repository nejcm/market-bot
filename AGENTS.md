# AGENTS.md

## Read first

- [CONTEXT.md](./CONTEXT.md) — domain glossary
- [docs/architecture.md](./docs/architecture.md) — layout, subsystems, data flow
- [docs/conventions.md](./docs/conventions.md) — code style, testing, commits
- [docs/configuration.md](./docs/configuration.md) — env vars
- [docs/adr/README.md](./docs/adr/README.md) — canonical ADR index; many ADR files are superseded redirects, cite only canonical records

## Project basics

market-bot is a Bun + TypeScript CLI that turns public market data into sourced research artifacts with measurable predictions, scoring, and calibration. The project is under active development; CLI commands, configuration, and output formats may change.

Core capabilities:

- Market overview for equity or crypto regime, movers, themes, risks, source gaps, and optional Market Spotlights.
- Instrument briefs for single-instrument equity or crypto research.
- Thematic equity research via `research <subject>` with checked-in subject/proxy identity.
- Alpha search for equity social-momentum discovery that emits Research Leads only.
- Prediction scoring, calibration, historical context, thesis deltas, and artifact search.
- Research Console, a local Svelte UI for browsing runs, calibration, provider health, and allowlisted job queueing.

Common commands:

```sh
bun install
bun run src/cli.ts market-overview --asset equity
bun run src/cli.ts market-overview --asset crypto --horizon 15 --deep
bun run src/cli.ts equity AAPL --deep
bun run src/cli.ts crypto BTC
bun run src/cli.ts research AI biotech --deep
bun run src/cli.ts alpha-search --asset equity
bun run src/cli.ts score
bun run src/cli.ts calibration
bun run src/cli.ts history search --query catalyst
bun run app      # build and serve Research Console at 127.0.0.1:4173
bun run app:dev  # start API + Vite dev server
```

Data output layout:

```text
data/
  runs/<run-id>/          report.json, report.md, score.json, normalized/, trace.json
  calibration/            summary.json, summary.md
  index.sqlite            derived Run Artifact Index (optional, rebuildable)
  history/                derived search index + instrument timelines
  cache/                  raw source + close caches
  news-seen.json          suppresses repeat news URLs (30 days)
```

Project layout:

```text
src/           CLI, orchestrator, sources, scoring, report schema
app/           Research Console (Svelte + Bun server)
prompts/       Model stage prompts and Domain Playbooks
tests/         Bun test suites
docs/          Architecture, configuration, ADRs
assets/        Logo and favicons
```

## ADR guidance

ADRs document current architectural decisions and should be followed by default, but they can be changed, updated, or adapted when a better solution or approach is justified.

- Do not silently ignore an ADR; identify the relevant record and explain why it no longer fits.
- Warn before changing an existing ADR.
- Update or supersede the ADR in the same change when architecture changes.
- Prefer small ADR amendments over broad rewrites.
- Cite only canonical ADRs from [docs/adr/README.md](./docs/adr/README.md).

## Non-negotiables

1. **Research-only.** No buy/sell/hold calls, sizing, or execution language ([ADR 0001](./docs/adr/0001-research-only-boundary.md)).
2. **Predictions must be observable.** Resolvable from public price data ([ADR 0004](./docs/adr/0004-predictions-as-observable-forecasts.md)).
3. **No secrets in code, tests, or fixtures.** Env vars only.
4. **Bun + oxc only.** Do not add Node, Prettier, ESLint, or Biome ([ADR 0002](./docs/adr/0002-typescript-bun-orchestration.md)).
5. **Scope discipline.** No speculative abstractions, no bundled refactors, no unsolicited planning docs.

## Final Quality Check

After making code changes, run the quality check suite to ensure your changes meet project standards. Execute this command at natural completion points or when you've reached a stable state:

```sh
bun run check    # fmt + lint + fmt:check + typecheck + test
```

Requirements:

- All checks must pass before marking the task as complete
- Never bypass Git hooks with --no-verify or skip CI checks
- Include tests within the same commit as the code changes
- Do not append `Co-authored-by` trailers to commit messages
- Update docs/configuration.md when introducing new env variables
