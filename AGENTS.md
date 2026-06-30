# AGENTS.md

Guidance for LLM coding agents working on this repo. Human contributors: see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Read first

- [README.md](./README.md) — what the project does
- [CONTEXT.md](./CONTEXT.md) — domain glossary
- [docs/architecture.md](./docs/architecture.md) — layout, subsystems, data flow
- [docs/conventions.md](./docs/conventions.md) — code style, testing, commits
- [docs/configuration.md](./docs/configuration.md) — env vars
- [docs/adr/README.md](./docs/adr/README.md) — canonical ADR index; many ADR files are superseded redirects, cite only canonical records

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
- Update docs/configuration.md when introducing new env variables
