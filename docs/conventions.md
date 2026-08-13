# Conventions

## Code style

- **Immutability.** `readonly` fields, return new objects, never mutate inputs.
- **Explicit types on public exports.** Locals can be inferred.
- **`unknown` over `any`.** Narrow with type guards.
- **`interface`** for object shapes, **`type`** for unions/intersections/tuples.
- **Custom runtime validation at boundaries.** Validate untrusted reads with type guards (`isRecord`, `readString`, `readNumber`); see `src/report/schema.ts` and `src/guards.ts`. No Zod dependency.
- **No `console.log` in `src/`.** The CLI writes to `process.stdout` / `process.stderr` explicitly.
- **Early returns** over deep nesting (>4 levels is a smell).
- **Name your magic numbers.** Pattern in repo: `MAX_SCORE_ATTEMPTS`, `SCORE_FILE`.
- **No comments unless the "why" is non-obvious.** Don't restate what the code says.

## Testing

See [testing.md](./testing.md) for test commands, fixture replay setup, golden refresh, eval mode,
and fixture recording.

- Tests live in `tests/`, named `*.test.ts`, run with `bun test`.
- Add tests in the same change as the code. TDD preferred for fixes.
- **AAA structure** (Arrange / Act / Assert) with descriptive names.
- **Mock at the source adapter seam**, not at `fetch`.
- Static run fixtures are the exception to the usual unit-test seam: they mock only HTTP `fetch`
  and `ModelProvider.generate` so the real source adapters, cache, normalization, orchestration, and
  report assembly run.
- Keep fixture harness helpers under `tests/support/run-fixtures/`; tests should only load fixtures,
  run them, scrub output, and assert invariants.
- Refresh fixture golden output with `bun run scripts/replay-fixture-run.ts <fixture-name>
--write-golden` after intentional deterministic output changes.
- Tests claiming to verify a producer/consumer contract must obtain producer-owned artifacts by
  calling the writer, not by hand-building an object literal matching the reader's expectations;
  otherwise the test proves only that the reader accepts what the test author believes the writer
  emits. A focused unit test of a reader's own logic may construct its input.
- `tests/web-subject-profile-reuse.test.ts`, test `reuses an FPI profile from the filing evidence
collection path`, is the model: it calls `executeEvidenceRequestTool` with a raw SEC submissions
  payload and asserts on what the tool actually returns.
- Builders in `tests/support/fixtures.ts` remain correct for inputs the system does not produce
  (commands, config, provider payloads); they are not a licence to synthesize an artifact the system
  writes.
- Do not loosen an assertion to make a flaky test pass — find the cause.

### Implementation plan verification

Every phase of an implementation plan states verification in two tiers:

```text
Verification:
  focused (during edit): bun test tests/web-subject-profile-reuse.test.ts
  reportable:            bun run check
```

The focused command is for the edit loop. Apply the [Final Quality Check](../AGENTS.md) rule when reporting a phase as passing; only the reportable command may be cited.

- Review checklist: if anything under `tests/fixtures/*/golden-output/` moved, the commit body must state why. `bun run scripts/replay-fixture-run.ts <fixture> --write-golden` already prints a bucketed, escalation-aware diff before overwriting, and `git diff` is the durable record; no new tracking file is needed. The gap is that nobody reads it.

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

CI runs lint, format, TypeScript/Svelte typecheck, app build, test, knip, audit. All must pass.

Do not bypass hooks (`--no-verify`). Fix the root cause.

## Done means

```sh
bun run check
```

passes locally, and any new env var is documented in [configuration.md](./configuration.md).
