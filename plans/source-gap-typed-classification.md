# Source Gap Typed Classification

## Summary

Deepen `SourceGap` from a message-only shape into typed internal meaning while preserving public report text behavior. Ship this first because it is the lowest-risk, highest-certainty refactor and removes analytics logic that currently depends on gap wording.

## Key Changes

- Add typed gap classification fields and helpers for provider, capability, cause, evidence-quality impact, and report text.
- Keep the existing `source` and `message` behavior available during migration so public `dataGaps` text remains stable.
- Replace wording-based analytics in `run-analytics.ts` with typed gap classification.
- Update Evidence Quality cap logic to use typed meaning instead of source/message string matching.
- Preserve Market Context gap non-cap behavior and Extended Evidence cap behavior.
- Preserve repeat fallback analytics without checking for specific message text such as "kept one repeat fallback".
- Update Source Provider gap emitters for missing credentials, fetch failures, stale fallbacks, circuit breaker fallbacks, unsupported coverage, repeat fallback, and malformed Evidence Request tool responses.

## Public Interfaces / Docs

- Extend the internal `SourceGap` contract; do not change the public report schema.
- Keep report `dataGaps` as human-readable text.
- Update source-provider contract wording to require typed cause/capability plus a human-readable message.
- Update architecture or how-it-works docs only where they describe message-only gap behavior.
- No new env vars.

## Test Plan

- Unit-test gap classification helpers for missing credentials, fetch failures, stale fallback, circuit breaker fallback, unsupported coverage, repeat fallback, and malformed Evidence Request responses.
- Update analytics tests to assert typed classes instead of message wording.
- Add or update Market Context tests proving these gaps do not cap Evidence Quality.
- Add or update Extended Evidence tests proving cap behavior is preserved.
- Keep existing source gap snapshot expectations stable where public report text is asserted.
- Run `bun run check`.

## Assumptions

- Public report text stability matters more than replacing all messages immediately.
- `SourceGap` remains internal research/source plumbing, not a new report schema.
- Optional provider absence should keep current product behavior.
