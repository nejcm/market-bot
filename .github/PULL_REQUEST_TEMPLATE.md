<!-- Thanks for contributing! Keep the research-only boundary in mind (ADR 0001). -->

## Summary

<!-- What does this change do and why? -->

## Related issues

<!-- "Closes #123", "Refs #456", or none. -->

## Type

<!-- Check one. Conventional Commits type should match. -->

- [ ] `feat` — new capability
- [ ] `fix` — bug fix
- [ ] `refactor` — no behavior change
- [ ] `perf` — performance
- [ ] `docs` — documentation only
- [ ] `test` — tests only
- [ ] `chore` / `ci` — tooling

## Research-only boundary

- [ ] No buy/sell calls, position sizing, or execution language.
- [ ] Any predictions are observable and resolvable from public price data (ADR 0004).

## Checks

- [ ] `bun run check` passes locally (lint + fmt:check + typecheck + test)
- [ ] Tests added or updated for the change
- [ ] No secrets in code, tests, fixtures, or artifacts
- [ ] Updated `docs/configuration.md` if a new env var was added
- [ ] No Node/Prettier/ESLint/Biome introduced (Bun + oxc only, ADR 0003)

## Notes for reviewers

<!-- Anything reviewers should pay attention to, scope decisions, trade-offs. -->
