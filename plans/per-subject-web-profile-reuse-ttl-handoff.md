# Per-Subject Web Profile Reuse TTLs — Implementation Handoff

## Status

- Planning and grilling are complete.
- The user approved the plan below.
- Implementation is complete.
- Preserve the unrelated untracked file `plans/d3-web-evidence-sanitization-handoff.md`.

## Next-session objective

Implement per-Subject Kind Web Subject Profile reuse TTLs, clean up stale configuration
documentation/tests, and verify the repository with `bun run check`.

## Suggested skills

- `implement-plan` — execute the approved plan without reopening settled decisions.
- `coding-principles` — keep the config/type change surgical.
- `javascript-testing-patterns` — update the Bun tests and add focused TTL coverage.
- `code-quality` — run the repository definition of done.

## Repository constraints

Follow `AGENTS.md` and the referenced repository rules.

- Research-only behavior must remain unchanged.
- Bun + oxc only.
- Add or update tests in the same change.
- Update `docs/configuration.md` for environment-variable changes.
- Do not enable market-overview Web Gather.
- Do not modify sanitizer behavior.
- Definition of done: `bun run check`.

## Current repository findings

- `AppConfig.webProfileReuseDays` is currently a scalar configured by
  `MARKET_BOT_WEB_PROFILE_REUSE_DAYS`, defaulting to 30.
- `findReusableWebSubjectProfile` receives the scalar and applies it to every Subject Kind.
- Company reuse additionally requires a current SEC filing basis and rejects profiles superseded by
  a newer filing.
- Crypto-asset and theme reuse are time-only.
- Expiry is inclusive: age exactly equal to the TTL remains reusable.
- `RUN_TYPE_REGISTRY` still has `supportsWebGather: false` for market overview.
- Model-visible web sanitization is already implemented and documented by ADR 0040.
- `researchGatherOptions` and `MARKET_BOT_RESEARCH_GATHER_*` are absent from runtime config. Current
  config tests only assert that those obsolete names are ignored.
- Targeted baseline tests passed before implementation:
  `bun test tests/config.test.ts tests/web-subject-profile-reuse.test.ts --silent`
  (60 passed, 0 failed).

## Complete decision Q&A

### Q1. Should the existing `MARKET_BOT_WEB_PROFILE_REUSE_DAYS` remain as a backward-compatible fallback?

**Answer:** No. No backward compatibility is required.

### Q2. Which default TTLs should apply by Subject Kind?

Options considered:

- 30 / 7 / 7
- 30 / 3 / 7
- 30 / 7 / 14

**Answer:** Company 30 days, crypto asset 7 days, theme 7 days.

### Q3. Should the implementation include market-overview Web Gather?

Options considered:

- Stop after TTL/config cleanup
- Include market-overview design
- Include market-overview implementation

**Answer:** Stop after TTL/config cleanup. Evaluate market overview separately.

### Q4. What should happen if removed `MARKET_BOT_WEB_PROFILE_REUSE_DAYS` remains set externally?

Options considered:

- Ignore it
- Fail fast
- Warn

**Answer:** Ignore it like any unknown environment variable. Apply the new defaults.

### Q5. How should operators override the TTLs?

Options considered:

- Three independent environment variables
- Fixed code defaults only
- One JSON environment variable

**Answer:** Three independent environment variables.

### Q6. Should `0` disable reuse for one Subject Kind?

Options considered:

- Reject zero
- Treat zero as disabling reuse

**Answer:** Reject zero. Every TTL remains a positive integer day count.

## Approved plan

# Per-Subject Web Profile Reuse TTLs

## Summary

Replace the shared 30-day TTL with independently configured defaults:

- Company: 30 days
- Crypto asset: 7 days
- Theme: 7 days

This change stops after TTL hardening and stale documentation/test cleanup.

## Implementation Changes

- Replace `AppConfig.webProfileReuseDays` with
  `webProfileReuseDaysBySubjectKind: Readonly<Record<SubjectKind, number>>`.
- Add positive-integer environment variables:
  - `MARKET_BOT_WEB_PROFILE_COMPANY_REUSE_DAYS`
  - `MARKET_BOT_WEB_PROFILE_CRYPTO_ASSET_REUSE_DAYS`
  - `MARKET_BOT_WEB_PROFILE_THEME_REUSE_DAYS`
- Remove the old variable from code, documentation, and `.env.example`. If set externally, it is
  silently ignored.
- Pass the TTL map into profile reuse and select the value using the derived `subjectKind`.
- Preserve inclusive expiry boundaries and company SEC-filing invalidation.
- Keep crypto/theme time-only invalidation; do not add news-recency anchors.

## Documentation Cleanup

- Document the three variables and defaults in configuration guidance.
- Update `CONTEXT.md` to state that each Subject Kind has an independent reuse TTL without embedding
  configuration details.
- Amend ADR 0035 to record per-kind TTLs; no new ADR.
- Correct the portable handoff:
  - Sanitization is shipped under ADR 0040.
  - Per-kind TTL work is complete.
  - `researchGatherOptions` and `MARKET_BOT_RESEARCH_GATHER_*` are absent, not runtime config awaiting
    removal.
  - Market-overview, MCP, and skills migration remain deferred.
- Preserve the unrelated untracked D3 handoff file.

## Test Plan

- Assert default TTL map equals `30/7/7`.
- Assert each new environment variable overrides only its Subject Kind.
- Reject zero, negative, and invalid values for every new variable.
- Verify an eight-day profile is reusable for company but expired for crypto/theme.
- Retain SEC filing, future timestamp, subject mismatch, missing source, and exact-boundary coverage.
- Remove tests that memorialize ignored `MARKET_BOT_RESEARCH_GATHER_*` variables.
- Update affected `AppConfig` fixtures and run `bun run check`.

## Assumptions

- No compatibility alias, warning, or migration for the removed shared variable.
- Market-overview Web Gather is not enabled or designed in this change.
- Sanitizer behavior is unchanged.

## Likely affected areas

- `src/config.ts`
- `src/research/orchestrator.ts`
- `src/research/web-subject-profile-reuse.ts`
- `tests/config.test.ts`
- `tests/web-subject-profile-reuse.test.ts`
- Test fixtures that construct `AppConfig`
- `.env.example`
- `docs/configuration.md`
- `CONTEXT.md`
- `docs/adr/0035-web-subject-profile-across-subject-kinds.md`
- `plans/portable-agent-mcp-refactor-handoff.md`

## Completion checks

- [x] Search for remaining `webProfileReuseDays` and `MARKET_BOT_WEB_PROFILE_REUSE_DAYS` references.
- [x] Run focused config and reuse tests.
- [x] Run `bun run check`.
- [x] Inspect `git diff`; the D3 handoff named above was not present in the worktree.
