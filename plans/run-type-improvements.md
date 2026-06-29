# Run Type Improvements and Simplifications

Source: `docs/run-types.md` review with separate subagent passes for
`market-overview`, legacy aliases, `equity`, `crypto`, `research`, and
`alpha-search`.

## Scope

This is an implementation backlog, not an accepted design. Preserve the
research-only boundary: no buy/sell/hold calls, sizing, execution language, or
portfolio actions.

## Highest-Value Changes

1. Canonicalize legacy market-update runtime paths.
   - Current: `daily` / `weekly` CLI invocations parse to
     `jobType: "market-overview"` with `legacyAlias`, but many internals and
     tests still construct `{ jobType: "daily" | "weekly" }`.
   - Files: `src/cli/args.ts`, `src/cli/job-registry.ts`,
     `src/domain/run-types.ts`, `src/domain/types.ts`,
     `src/config/runs/resolver.ts`, tests under `tests/`.
   - Direction: keep legacy values readable in artifact/history/provider-health
     paths, but migrate new-run tests and internal call sites to canonical
     `MarketOverviewCommand`.
   - Benefit: fewer branches, less drift between cadence aliases and explicit
     horizon behavior.
   - Risk: medium to high due to broad fixture churn.

2. Centralize market-update helpers.
   - Current: `market-overview` / `daily` / `weekly` checks are repeated in
     source collection, provider adapters, source plan, news recency, and prior
     forecast error handling.
   - Files: `src/sources/collector.ts`, `src/sources/yahoo.ts`,
     `src/sources/coingecko.ts`, `src/sources/news-utils.ts`,
     `src/research/source-plan.ts`, `src/research/prior-forecast-errors.ts`.
   - Direction: use `isMarketUpdateJobType`, `marketUpdateHorizonOf`, and a
     shared market-update metadata helper consistently.
   - Benefit: horizon-first behavior becomes harder to regress.
   - Risk: low.

3. Share market-update trace/report extras construction.
   - Current: `marketUpdateTraceFields` and `marketUpdateExtras` duplicate
     horizon bucket / legacy alias logic.
   - Files: `src/research/orchestrator.ts`,
     `src/research/report-assembly.ts`.
   - Direction: extract a pure helper in a domain/research utility module.
   - Benefit: trace and report extras cannot drift.
   - Risk: low.

4. Split `collectSources` enrichment paths.
   - Current: `collectSources` handles sequencing, identity, news targets,
     verified snapshot, valuation, peer comps, Yahoo fundamentals, financial
     lens, business framework, earnings setup, and source gaps.
   - File: `src/sources/collector.ts`.
   - Direction: extract focused helpers for equity instrument enrichment and
     research subject enrichment; skip no-op extended-evidence calls for market
     overview.
   - Benefit: lower change risk in evidence collection.
   - Risk: medium due to ordering dependencies.

5. Fix source-plan and gap taxonomy drift.
   - Crypto deep web profiles are persisted but not represented in the
     `subject-profile` source-plan lane.
   - Web-gather gaps use `capability: "evidence-request"`, which groups Exa/web
     failures with SEC/Tradier request failures.
   - Files: `src/research/source-plan.ts`,
     `src/sources/web-gather-tools.ts`, `src/research/web-gather-loop.ts`.
   - Benefit: evidence quality, source ledger, and analytics match runtime
     behavior.
   - Risk: low to medium; update tests and fixtures.

## Market Overview

- Console prompt steering is missing. The CLI supports an optional positional
  prompt for `market-overview`, but the Research Console queue flow does not.
  Either expose it in the Console or document it as CLI-only.
- The spotlight/delta section in `runResearchJob` mutates context through
  several steps. Extracting `buildMarketUpdateContext` would isolate spotlight
  candidates, selected history context, ranked movers, and market-update delta.
- Deep market-overview web gather remains intentionally disabled today. There is
  already a dedicated handoff in `plans/market-overview-web-gather-handoff.md`;
  do not enable `supportsWebGather` without the separate Web Market Profile
  containment design.

## Legacy `daily` and `weekly`

- Treat as CLI aliases and legacy artifact identities, not product semantics.
- Keep old artifact reads, provider-health coverage mapping, calibration bucket
  mapping, and history search filters compatible with old `jobType` values.
- Prefer `market-overview --horizon 5` and `market-overview --horizon 15` in new
  examples and tests.

## Equity

- `collectSources` does too much for equity instrument runs; extract enrichment
  steps after primary market/news collection.
- Equity instrument runs fetch Yahoo regime symbols, but market-context artifacts
  are market-update-only. Decide whether to document this as ticker regime
  context or add a source-plan lane.
- Evidence-request and web-gather loops share validation/audit shape. Share small
  budget, duplicate, stale-gap, and accepted/rejected audit helpers while keeping
  tool-specific argument validation separate.
- Add a focused test for equity relative prediction allowlist behavior
  (`TICKER:BENCHMARK` where the primary subject must match the run symbol).

## Crypto

- Add crypto deep web profile coverage to source-plan lanes.
- Promote CoinGecko coin identity into `resolvedInstrumentIdentity` where
  possible to reduce symbol ambiguity.
- Split `cryptoProfile` from the shared equity/instrument profile so focus and
  prediction guidance reflect optional on-chain evidence and thinner issuer-style
  evidence.
- Replace top-250 symbol filtering with a more explicit CoinGecko ID resolution
  path if lower-ranked or duplicate-symbol assets matter.
- Decide whether FRED macro evidence is intentional for crypto. Either document
  it or reclassify/remove it to avoid surprising missing-key gaps.
- Make final-synthesis prediction guidance asset-aware so crypto runs do not see
  equity-specific IV/VIX examples unless relevant.

## Thematic `research`

- Centralize research subject resolution. Today `app.ts`, collector, context,
  report assembly, and prediction gate can each resolve or inspect registry
  identity.
- Preserve raw `subject` as authority when caller-provided `subjectKey` is bogus;
  tests rely on this safety property.
- Make proxy market collection explicit so proxy forecasts do not depend on
  whether a broad equity snapshot happens to include the proxy ETF.
- Align config and prediction gate authority. `runParams.predictionSubjects` and
  `researchPredictionGate` both encode proxy-only policy, but only the gate is
  authoritative at assembly.
- Add a first-class source-plan gap for resolved subjects with no prediction
  proxy.
- Reuse registry aliases and display names in web-gather query validation.
- Consider persisting a small normalized registry-subject artifact for console
  and artifact debugging.
- Be careful with fuzzy historical matching for unresolved subjects; normalized
  exact text is safer than semantic/fuzzy matching.

## Alpha Search

- Keep docs clear that `alpha-search` emits no predictions and skips
  post-research scoring/calibration. Alpha validation, watchlist, feature
  attribution, and cohorts are produced by later `score` runs.
- Check `normalized/rejected-candidates.json` shape against the cohort reader.
  The workflow writes internal rejected candidates, while cohort loading expects
  report-shaped `AlphaSearchRejectedCandidate` data.
- Asset handling is special-cased: CLI requires `--asset equity`, while the run
  registry marks `supportsAsset: false` and console request argv hardcodes
  equity. Consider a fixed-asset capability field if this keeps spreading.
- Trace stages omit the fundamentals collection step listed in docs. Add a trace
  stage or remove that stage from the docs if it is not meant as a trace step.
- Derive report extras and normalized sidecars from the same report-shaped
  objects where possible to reduce drift.
- Add search-index entries for `extras.researchLeads` and
  `extras.rejectedCandidates` so console/history search can find lead symbols,
  rejected symbols, and rejection reasons.

## Suggested Order

1. Low-risk cleanup: shared market-update helpers, trace/report extras helper,
   news recency by horizon, docs/tests for alias canonicalization.
2. Evidence drift fixes: crypto web-profile lane, web-gather gap capability,
   alpha rejected-candidates sidecar shape.
3. Collector refactor: equity enrichment extraction and no-op market-overview
   extended-evidence guard.
4. Research identity work: centralized subject resolution and explicit proxy
   market collection.
5. Larger product work: crypto profile split and market-overview Web Market
   Profile.
