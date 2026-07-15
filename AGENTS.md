# AGENTS.md

## Read first

- [CONTEXT.md](./CONTEXT.md) — domain glossary
- [docs/architecture.md](./docs/architecture.md) — layout, subsystems, data flow
- [docs/conventions.md](./docs/conventions.md) — code style, testing, commits
- [docs/configuration.md](./docs/configuration.md) — env vars
- [docs/adr/README.md](./docs/adr/README.md) — canonical ADR index

## Project basics

market-bot is a Bun + TypeScript CLI that turns public market data into sourced research artifacts with measurable predictions, scoring, and calibration. The project is under active development; CLI commands, configuration, and output formats may change.

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
2. **Predictions must be observable.** Resolvable from public price data ([ADR 0003](./docs/adr/0003-forecasts-scoring-calibration-cross-run-intelligence.md)).
3. **No secrets in code, tests, or fixtures.** Env vars only.
4. **Bun + oxc only.** Do not add Node, Prettier, ESLint, or Biome ([ADR 0002](./docs/adr/0002-typescript-bun-orchestration.md)).
5. **Scope discipline.** No speculative abstractions, no bundled refactors, no unsolicited planning docs.

## Final Quality Check

After making code changes, run the quality check suite to ensure your changes meet project standards. Execute this command at natural completion points or when you've reached a stable state:

```sh
bun run check    # fmt + lint + fmt:check + typecheck + test:coverage
```

Requirements:

- All checks must pass before marking the task as complete
- Never bypass Git hooks with --no-verify or skip CI checks
- Include tests within the same commit as the code changes
- Do not append `Co-authored-by` trailers to commit messages
- Update docs/configuration.md when introducing new env variables
