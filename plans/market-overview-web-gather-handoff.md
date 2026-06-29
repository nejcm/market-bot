# Market-Overview Web Gather — Implementation Handoff

## Status

- Planning and grilling are complete.
- The user approved the plan below.
- Implementation has not started.
- Item 2, obsolete research-gather configuration cleanup, is complete.
- Item 4, MCP and `.agents/skills` migration, remains deliberately deferred.

## Next-session objective

Implement Web Gather for deep market-overview runs using a separate Web Market Profile while
reusing the existing gather transport, security controls, sanitizer, budgets, and audit path.

## Suggested skills

- `implement-plan` — execute the approved plan without reopening settled decisions.
- `coding-principles` — keep the new market path separate without speculative refactoring.
- `javascript-testing-patterns` — add focused Bun tests for containment, parsing, reuse, and wiring.
- `domain-modeling` — record the separate Web Market Profile vocabulary and focused ADR.
- `code-quality` — run the repository definition of done.

## Repository constraints

Follow `AGENTS.md` and its referenced rules.

- Preserve the research-only boundary.
- Predictions remain observable and cannot be resolved from Web Market Profile facts.
- Bun + oxc only.
- Add tests in the same change.
- Update `docs/configuration.md` for the new environment variable.
- Do not alter the existing `SubjectKind` or Web Subject Profile semantics.
- Do not implement MCP, `.agents/skills`, readability, paywall, or robots work.
- Definition of done: `bun run check`.

## Current repository findings

- `RUN_TYPE_REGISTRY` has `supportsWebGather: false` for `market-overview`.
- CLI `daily` and `weekly` aliases normalize to canonical market-overview commands.
- The existing Web Gather path is deep-only and currently derives a single Web Subject Profile
  subject for equity, crypto, or research commands.
- `SubjectKind` remains `company | crypto-asset | theme`; market overview deliberately has no
  Subject Kind.
- Web Gather already provides Exa search/fetch, budgets, deterministic query validation,
  same-run URL allowlisting, sanitizer telemetry, raw snapshots, normalized low-trust Sources, and
  non-fatal gaps.
- Sanitized web text is projected only to the Web Subject Profile extraction stage. Later stages see
  structured cited profile data and source metadata.
- Current orchestration runs Web Gather before market spotlight selection, so a market profile added
  at that seam can inform spotlight selection and downstream analysis.
- `CollectedSources.webSubjectProfile`, report `extras.webSubjectProfile`, normalized
  `web-subject-profile.json`, reuse scanning, report rendering, console display, and analytics are
  singular and subject-specific. The market path needs parallel contracts.
- Per-Subject Kind TTLs are complete: company 30 days, crypto asset 7 days, and theme 7 days.
- Obsolete `researchGatherOptions` and `MARKET_BOT_RESEARCH_GATHER_*` runtime configuration are
  absent; the portable handoff already states this correctly.

## Complete decision Q&A

### Q1. What should market-overview Web Gather research as its bounded target?

Options considered:

- The whole asset market
- Selected market spotlights
- Only a user-supplied prompt theme

**Answer:** The whole asset market: the U.S. equity market for equity overviews and the global
crypto market for crypto overviews.

### Q2. Should the whole-market target become another `SubjectKind`?

Options considered:

- Add a new market Subject Kind
- Reuse the theme Subject Kind
- Keep the existing kinds unchanged and create a separate market artifact/path

**Answer:** Do not introduce a market Subject Kind. Keep existing Subject Kinds and Web Subject
Profiles unchanged; duplicate market-specific contracts where needed.

### Q3. What reuse policy should Web Market Profiles use?

Options considered:

- One-day TTL
- Never reuse
- Equity one day and crypto never

**Answer:** One-day TTL.

### Q4. What fixed questions should the Web Market Profile answer?

Options considered:

- Six market lenses
- A news digest
- Catalysts and risks only

**Answer:** Six citation-required market lenses:

- Current regime
- Breadth and liquidity
- Leadership and themes
- Catalysts and calendar
- Risks and tail risks
- Key debates and scenarios

### Q5. Which stages may consume the structured Web Market Profile?

Options considered:

- Analysis and synthesis, including spotlight selection
- Final synthesis only
- Analysis except spotlight selection

**Answer:** Spotlight selection, specialist analysis, coverage stages, critique, and final synthesis.
Raw/sanitized web prose remains extraction-only.

### Q6. How should market query containment work?

Options considered:

- Deterministically required asset-market anchor phrases
- Loose asset terms anywhere
- Prompt-only containment

**Answer:** Require approved anchor phrases in every query. Reject unanchored and cross-market
queries.

### Q7. Should the one-day market TTL be configurable?

Options considered:

- Dedicated environment variable
- Fixed code value

**Answer:** Add positive-integer `MARKET_BOT_WEB_MARKET_PROFILE_REUSE_DAYS`, defaulting to 1.

### Q8. Should profile reuse vary by forecast horizon?

Options considered:

- Asset class only
- Asset class plus horizon bucket

**Answer:** Asset class only. The gathered current-market facts are independent of forecast horizon.

### Q9. Should the market path share existing Web Gather implementation?

Options considered:

- Share gather infrastructure and split profile/reuse/rendering contracts
- Duplicate the full pipeline

**Answer:** Share Exa tools, budgets, sanitizer, URL allowlisting, raw snapshots, Sources, and audit.
Use separate market subject adaptation, profile, reuse, persistence, and rendering.

### Q10. Which market-overview depths are eligible?

Options considered:

- Deep only
- Brief and deep

**Answer:** Deep only.

## Approved plan

# Market-Overview Web Gather

## Summary

- Item 2 is complete: obsolete research-gather config/tests are removed and documentation corrected.
- Implement item 3 for deep market-overview runs using a separate Web Market Profile.
- Item 4 remains deferred; do not implement MCP or `.agents/skills` migration.

## Implementation Changes

- Enable `supportsWebGather` for canonical `market-overview`; brief runs remain disabled. Legacy
  daily/weekly CLI aliases inherit canonical behavior.
- Keep `SubjectKind` and Web Subject Profile unchanged.
- Share existing Exa tools, budgets, sanitizer, URL allowlisting, raw snapshots, Sources, and gather
  audit.
- Add a separate market target:
  - Equity: `us-equity-market`
  - Crypto: `global-crypto-market`
- Require deterministic query anchors:
  - Equity: approved phrases such as `US equity market`, `US stock market`, `S&P 500`,
    `Nasdaq Composite`, or `Russell 2000`.
  - Crypto: `crypto market`, `cryptocurrency market`, or `digital asset market`.
  - Reject bare ticker/asset queries and retain same-run `web_fetch` URL allowlisting.

## Web Market Profile

- Add a versioned `WebMarketProfile` keyed by `assetClass`, independent of forecast horizon.
- Persist `normalized/web-market-profile.json` and expose deterministic `extras.webMarketProfile`.
- Use six citation-required lenses:
  - `currentRegime`
  - `breadthAndLiquidity`
  - `leadershipAndThemes`
  - `catalystsAndCalendar`
  - `risksAndTailRisks`
  - `keyDebatesAndScenarios`
- Include market summary, recent material events, fact ledger, open gaps, source IDs, generation time,
  market ID, and label.
- Add a `web-market-profile` Extended Evidence category and market-profile source-plan lane with the
  existing low-trust evidence cap.
- Make sanitized text visible only to the market-profile extraction stage. Expose the structured
  profile to spotlight selection, specialist analysis, coverage stages, critique, and final
  synthesis.
- Add report validation/rendering, artifact reading, Research Console display, and Web Source Role
  accounting for market-profile citations.

## Reuse and Failure Handling

- Add positive-integer `MARKET_BOT_WEB_MARKET_PROFILE_REUSE_DAYS`, default `1`; reject zero and
  invalid values.
- Reuse by asset class only, across forecast horizons, with the existing inclusive TTL boundary.
- Reject future-dated profiles, wrong asset classes, malformed artifacts, and profiles whose cited
  Sources cannot be resolved.
- Missing Exa credentials, provider failures, rejected queries, and malformed profile output remain
  non-fatal Source Gaps.
- Older runs without the optional sidecar remain readable without migration.

## Orchestration and Documentation

- Run reuse/gather/extraction before market spotlight selection so downstream stages can consume the
  structured profile.
- Do not run Business Framework reconciliation for market profiles.
- Keep Web Subject Profile persistence and behavior unchanged.
- Add a focused ADR explaining the separate Web Market Profile instead of extending `SubjectKind`.
- Update architecture, configuration, glossary, artifact documentation, and the portable handoff:
  - Mark D4 shipped after implementation.
  - Keep D1 MCP and D2 skills migration deferred.
  - Keep readability/paywall hardening deferred.

## Test Plan

- Capability tests: deep canonical overview enabled; brief disabled; aliases normalize correctly.
- Containment tests for accepted equity/crypto anchors and rejected unanchored or cross-market
  queries.
- Parser tests for all six lenses, citation validation, malformed output, and empty-profile gaps.
- Reuse tests for fresh, expired, exact-boundary, future-dated, wrong-asset, cross-horizon, and
  unresolved-source cases.
- Orchestrator tests for gather, reuse skip, extraction failure, stage ordering, and non-fatal
  missing credentials.
- Artifact, report schema/markdown, Research Console, source-plan, analytics, and backward-read
  tests.
- Run focused tests, then `bun run check`.

## Assumptions

- Market Web Gather remains deep-only.
- Equity overview means the U.S. equity market; crypto overview means the global crypto market.
- Web Market Profiles never change allowed Prediction Subjects or resolve Predictions.
- No MCP, portable-skills, news-recency anchor, readability parser, or paywall work is included.

## Likely affected areas

- Run capability/configuration and shared Web Gather target adaptation.
- A new Web Market Profile parser, prompt, reuse reader, and normalized artifact contract.
- Orchestrator/context/report/console/analytics integration.
- Focused unit and integration tests for the new path.
- Configuration, architecture, glossary, ADR, and deferred-work documentation.

## Review addendum (pre-implementation)

Grounded against the current code. These refine, not replace, the approved plan.

### Containment decision (refines Q6)

- Accept a query only if it contains an approved anchor for the run's market. Equity anchor set
  includes the phrases plus common index tickers/variants: `S&P 500`, `S&P500`, `SPX`, `^GSPC`,
  `Nasdaq`, `Nasdaq Composite`, `Russell 2000`, `RUT`, `US equity/stock market`. Crypto anchor set:
  `crypto market`, `cryptocurrency market`, `digital asset market` (consider `BTC`/`ETH`-led market
  phrases). Pin the exact accepted/rejected set with tests since `normalizeTerm` folds `S&P 500` to
  `s p 500`.
- Also reject **cross-market** queries via an explicit denylist: reject if the *opposite* market's
  anchors appear. An allowlist alone (as in `isOnSubjectQuery`, `web-gather-loop.ts:518`) cannot
  reject `S&P 500 vs crypto market`. Add a market branch to containment plus the denylist rule.

### Critical implementation seams (easy to miss)

1. Flipping `supportsWebGather` for `market-overview` is necessary but not sufficient: the orchestrator
   web-gather block (`orchestrator.ts:570-617`) routes entirely through Web-Subject-Profile helpers
   that return undefined/no-op for market-overview (`web-subject-profile.ts:153-163`,
   `orchestrator.ts:397-400`). Add an explicit `isMarketUpdateJobType(command.jobType)` branch that
   dispatches market reuse/gather/extraction; otherwise the path is enabled-but-inert.
2. `WebGatherSubject.subjectKind` is typed `SubjectKind` (`web-gather-tools.ts:36-42`). Sharing
   `executeWebGatherTool` (Q9) requires widening this **sources-layer** type (e.g. add a `"market"`
   discriminator) — this is distinct from, and does not violate, the domain `SubjectKind` constraint.
3. Add a `web-market-profile` stage to the `StageOutput["stage"]` union, prompt-loader/`loadStagePrompt`,
   prompt files, and `buildStagePrompt` projection (sanitized prose visible only there; structured
   profile flows to spotlight/specialist/coverage/critique/synthesis).
4. New `market-profile` evidence lane (`source-plan.ts`) applies to **both** equity and crypto
   market-overview deep, and shifts `plannedLaneCount`/`coverageRatio`/analytics for existing
   market-overview runs — expect fixture/snapshot churn, not a regression.
5. Missing-Exa-key surfaces as an **uncovered lane**, not an emitted `SourceGap` (mirrors the subject
   path, which emits nothing explicit when `isWebGatherLoopEnabled` is false). Test the lane gap.
6. Parallel singular→market contracts to add: `report/schema.ts` extras validation, `report/markdown.ts`,
   `app/client/view-model.ts`, `run-workspace.svelte`, `run-analytics.ts`, `run-artifact-layout.ts`
   (`RUN_ARTIFACT_FILES`), `run-artifacts.ts` (scan + null-tolerant backward read), `app/artifacts.ts`,
   console artifact tests. Write `web-market-profile.json` unconditionally (null when absent), like
   `webSubjectProfile` at `orchestrator.ts:1028`.
7. Reuse env var: reuse the existing `readPositiveInteger` pattern (`config.ts:617-630`) — it already
   rejects zero/invalid and defaults; only a new default constant is needed.
8. Confirmed safe: Business-Framework reconcile (`orchestrator.ts:616`) is a no-op for market runs
   (instrument-only `businessFramework`, early return at `:473`) — add a test asserting it stays a
   no-op. Daily/weekly aliases already normalize to `jobType: "market-overview"` (`args.ts:126`), so
   flipping only the `market-overview` registry row is correct.

## Completion checks

1. Search for accidental changes to `SubjectKind` and existing Web Subject Profile behavior.
2. Run focused capability, gather, parser, reuse, orchestration, artifact, report, console, and
   analytics tests.
3. Run `bun run check`.
4. Inspect the final diff for unrelated MCP, skills, readability, or paywall work.
