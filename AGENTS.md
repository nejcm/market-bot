# AGENTS.md

Guidance for LLM coding agents working on this repo. Human contributors: see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Read first

- [README.md](./README.md) — what the project does
- [CONTEXT.md](./CONTEXT.md) — domain glossary
- [docs/architecture.md](./docs/architecture.md) — layout, subsystems, data flow
- [docs/conventions.md](./docs/conventions.md) — code style, testing, commits
- [docs/configuration.md](./docs/configuration.md) — env vars
- [docs/adr/](./docs/adr/) — accepted design decisions

## Non-negotiables

1. **Research-only.** No buy/sell/hold calls, sizing, or execution language ([ADR 0001](./docs/adr/0001-research-only-boundary.md)).
2. **Predictions must be observable.** Resolvable from public price data ([ADR 0004](./docs/adr/0004-predictions-as-observable-forecasts.md)).
3. **No secrets in code, tests, or fixtures.** Env vars only.
4. **Bun + oxc only.** Do not add Node, Prettier, ESLint, or Biome ([ADR 0003](./docs/adr/0003-oxc-toolchain.md)).
5. **Scope discipline.** No speculative abstractions, no bundled refactors, no unsolicited planning docs.

## Definition of done

```sh
bun run check    # lint + fmt:check + typecheck + test
```

Must pass. Do not bypass hooks (`--no-verify`) or skip CI. Add tests in the same change as the code. Update [docs/configuration.md](./docs/configuration.md) when adding an env var.
