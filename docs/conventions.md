# Conventions

## Code style

- **Immutability.** `readonly` fields, return new objects, never mutate inputs.
- **Explicit types on public exports.** Locals can be inferred.
- **`unknown` over `any`.** Narrow with type guards.
- **`interface`** for object shapes, **`type`** for unions/intersections/tuples.
- **Custom runtime validation at boundaries.** Validate untrusted reads with type guards (`isRecord`, `readString`, `readNumber`); see `src/report/schema.ts` and `src/sources/guards.ts`. No Zod dependency.
- **No `console.log` in `src/`.** The CLI writes to `process.stdout` / `process.stderr` explicitly.
- **Early returns** over deep nesting (>4 levels is a smell).
- **Name your magic numbers.** Pattern in repo: `MAX_SCORE_ATTEMPTS`, `SCORE_FILE`.
- **No comments unless the "why" is non-obvious.** Don't restate what the code says.

## Testing

- Tests live in `tests/`, named `*.test.ts`, run with `bun test`.
- Add tests in the same change as the code. TDD preferred for fixes.
- **AAA structure** (Arrange / Act / Assert) with descriptive names.
- **Mock at the source adapter seam**, not at `fetch`.
- Static run fixtures are the exception to the usual unit-test seam: they mock only HTTP `fetch`
  and `ModelProvider.generate` so the real source adapters, cache, normalization, orchestration, and
  report assembly run.
- Keep fixture harness helpers under `tests/support/run-fixtures/`; tests should only load fixtures,
  run them, scrub output, and assert invariants.
- Do not loosen an assertion to make a flaky test pass — find the cause.

## Commits

Conventional Commits. Allowed types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

Rules: lowercase subject, no trailing period, ≤72 characters.

```
feat: slice calibration by cadence
fix: address weekly update review feedback
```

## Hooks and CI

- `pre-commit`: oxlint --fix + oxfmt on staged files
- `commit-msg`: commitlint
- `pre-push`: typecheck + tests

CI runs lint, format, typecheck, test, knip, audit. All six must pass.

Do not bypass hooks (`--no-verify`). Fix the root cause.

## Done means

```sh
bun run check
```

passes locally, and any new env var is documented in [configuration.md](./configuration.md).
