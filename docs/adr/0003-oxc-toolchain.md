# ADR 0003: Oxc Toolchain for Linting and Formatting

## Status

Accepted

## Context

The project needed a linter and formatter. The main contenders were:

- **ESLint + Prettier** — mature, ubiquitous, slow on large repos
- **Biome** — single Rust-based tool for both lint and format, mature
- **oxlint + oxfmt** — Oxc project tools, fastest available, but oxfmt is pre-1.0

## Decision

Use `oxlint` for linting and `oxfmt` for formatting.

oxlint runs 50–100× faster than ESLint, ships correctness/suspicious/perf rules that overlap with our strict tsconfig goals, and bundles typescript/unicorn/import/jsdoc/node plugins without extra npm packages. oxfmt is pre-1.0 but already opinionated, consistent, and interoperable with oxlint's codebase — using both keeps the full stack on the Oxc compiler pipeline.

Biome was rejected because it would make oxlint redundant (they cover overlapping rule sets) and its formatter has historically lagged on TypeScript-specific patterns.

## Consequences

- oxfmt's pre-1.0 status means occasional formatting edge cases may arise; the fallback is to pin the version and file a bug upstream.
- Migrating away from oxfmt to Prettier later would require a one-time reformatting pass and updating lefthook/CI scripts — medium effort.
- The speed advantage is meaningful locally (pre-commit hooks feel instant) and in CI (lint + format jobs complete in under 5 seconds).
