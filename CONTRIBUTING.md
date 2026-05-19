# Contributing

## Setup

```sh
bun install
bunx lefthook install
```

`lefthook install` wires up the git hooks. You only need to do this once per clone.

## Development scripts

| Script              | What it does                                     |
| ------------------- | ------------------------------------------------ |
| `bun test`          | Run all tests                                    |
| `bun run typecheck` | TypeScript type-check (no emit)                  |
| `bun run lint`      | Lint with oxlint (errors only block)             |
| `bun run lint:fix`  | Lint and auto-fix                                |
| `bun run fmt`       | Format with oxfmt                                |
| `bun run fmt:check` | Check formatting without writing                 |
| `bun run knip`      | Find unused exports and dependencies             |
| `bun run audit`     | Check for high-severity vulnerabilities          |
| `bun run check`     | Run lint + fmt:check + typecheck + test in order |

## Git hooks (via lefthook)

| Hook         | What runs                                         |
| ------------ | ------------------------------------------------- |
| `pre-commit` | oxlint --fix and oxfmt on staged files, re-staged |
| `commit-msg` | commitlint (conventional commits)                 |
| `pre-push`   | typecheck + bun test                              |

## Commit message format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>
```

Allowed types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

Rules: lowercase subject, no trailing period, max 72 characters.

## CI

All six CI jobs must pass before merging: **lint**, **format**, **typecheck**, **test**, **knip**, **audit**.
