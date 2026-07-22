# ADR 0004: Evidence, identity, providers, and deterministic analysis

## Status

Accepted

## Date

2026-06-30 (amended 2026-07-02: deterministic peer comparability gates; amended 2026-07-05:
tier-scoped SIC gate; amended 2026-07-09: research representative snapshots and thematic news;
amended 2026-07-12: near-duplicate web headline dedupe; consolidated 2026-07-15; amended
2026-07-16: clarified web-gather provider and contract module ownership; amended 2026-07-19:
present-but-unsupportable material target valuation caps Evidence Quality at medium, emitted as
rubric version 2; amended 2026-07-20: pre-commercial revenue-multiple applicability; amended
2026-07-21: normalized fundamental history; amended 2026-07-21: peer-implied price reference range)

## Context

Research runs combine provider evidence, deterministic governance and derived analysis, bounded
model-requested evidence, and several identity forms. These decisions must remain consistent across
provider composition, temporal integrity, web hardening, instrument analysis, and thematic subjects
without pretending the project has a global security master.

## Decision

### Identity and subject scope

- Keep `symbol + assetClass` as the compatibility identity for CLI input, matching, forecast DSL,
  history, and scoring.
- Preserve provider-normalized exchange, quote currency, display name, provider IDs, and aliases in
  normalized artifacts when available.
- Derive one run-scoped canonical instrument identity from the collected market snapshot. Do not
  perform a second identity fetch or cross-provider reconciliation; disclose conflicts.
- Use the checked-in equity Research Subject Registry for thematic research. Entries contain a
  canonical key, aliases, representative instruments, provenance, and an optional single listed ETF
  prediction proxy.
- Subject resolution is local and deterministic. Registry misses and subjects without an eligible
  proxy may produce research but produce no scored predictions.
- Representatives provide context only. They do not become forecast proxies or peer-comparison
  members unless another accepted rule explicitly selects them.

### Provider composition and request resilience

- Represent each provider as a typed module exposing any subset of market data, supplemental market
  data, news, Extended Evidence, or Market Context capabilities.
- Compose capabilities by asset class through the source registry: one primary market adapter plus
  optional news, supplemental, and Extended Evidence adapters.
- Route provider HTTP through the shared request executor for timeouts, retries, rate limits,
  circuit breaking, freshness-budgeted caching, stale audit fallback, and raw snapshot capture.
- Missing required primary coverage emits a `SourceGap`. Optional providers may be silent when
  unconfigured; configured failures emit typed gaps.
- Yahoo is primary equity market data and CoinGecko is primary crypto market data. Massive is an
  optional equity supplement and opportunistic fallback for selected Yahoo quote, benchmark,
  alpha-validation, and scoring-close paths; it does not supply movers or regime labels.
- News adapters may expose thematic search without changing providers that support only generic
  feeds. Resolved subjects derive terms from checked-in names and aliases. If the provider pool has
  no relevant thematic item before seen filtering, the existing Exa-to-Firecrawl path may provide a
  bounded fallback whose results enter normal normalization, relevance, dedupe, seen, and selection
  processing.
- Promotion into scoring requires explicit observation semantics and tests. Massive close fallback
  remains part of the Yahoo observation path, not a generic registry capability.

### Evidence governance and temporal integrity

- Build the immutable v2 Source Plan before the first provider I/O. Lane applicability and class
  derive only from resolved command, checked-in subject, asset class, depth, and checked-in policy,
  never outcomes, credentials, availability, or successful fetches. Capture `generatedAt` before
  collection.
- After collection, Evidence Lanes and the Source Ledger assess the frozen plan for coverage, gaps,
  freshness, corroboration, and traceability. Historical artifacts remain readable and are not
  rewritten.
- Plan applicable lanes as core, material, or supplemental. Evidence Quality is entirely
  deterministic: `low` means core evidence is unusable; `medium` means core is complete but material
  coverage or corroboration is missing, or a material lane acquired sources yet is not usable (the
  target-valuation lane is present but not supportable); `high` requires complete core plus
  sufficiently broad, fresh, corroborated, and usable material evidence. Supplemental gaps do not
  lower it, and synthesis cannot author or lower it.
- Every model evidence payload carries `analysisAsOf`. Adapters exclude facts published, filed, or
  ending after that cutoff when their data supports those semantics.
- Cache entries are freshness-budgeted and validated. A failed refresh may retain stale data in raw
  audit snapshots, but stale data never enters normalized current evidence.
- Deep instrument runs and all thematic research runs may gather bounded web results. Exa is
  primary; configured Exa failures or thin results may fall back to Firecrawl. Firecrawl never
  substitutes for a missing Exa key. Results are subject-constrained, cached, persisted as
  low-trust `web` Sources with provider provenance, and cannot replace core market, regulatory, or
  pricing evidence. Audits record attempted/serving providers, fallback reason, and returned paid
  credits.
- For company subjects, Stage-1 gather derives durable sections already covered by the SEC 10-K/Q
  packet and rejects duplicate background searches without a recency, corroboration, or explicit-gap
  rationale.
- Deterministic title dedupe rejects an incoming accepted-web candidate when normalized title tokens
  match an already-accepted source at a 0.8 maximum Jaccard/containment threshold with at least three
  tokens. Rejections are audited as `duplicate-headline`; the rule cannot empty coverage and emits
  no gap.
- Web Subject Profiles use fixed cited questions per subject kind and bounded reuse TTLs. Company
  reuse also checks SEC filing freshness.
- Sanitize provider-controlled prose and short labels through one provider-neutral, profile-aware
  path before model exposure. This covers web, news, SEC sections, metadata, and prompt-bound legacy
  history. Raw payloads and historical artifacts remain unchanged.
- Persist text-free sanitizer aggregates by provider/ingress, profile, and field role. Empty or
  rejected normalized content emits an aggregated non-fatal validation gap when applicable.
- Persist fingerprints of effective non-secret configuration and dirty source state for audit.

### Instrument and thematic deterministic analysis

- Instrument runs may add normalized Extended Evidence without changing the core report schema.
  Current categories include regulatory filings, events, macro, options IV, on-chain metrics,
  financial lenses, business framework, valuation, earnings setup, and Web Subject Profile.
- Deep US-equity runs may execute a bounded Evidence Request Loop before analysis. Requests use
  enumerated tools, subject validation, source-unit budgets, and the shared source request seam;
  they do not use provider-native model tools.
- Every equity instrument run attempts a Verified Market Snapshot from Yahoo OHLCV through the
  cached request seam. It computes the locked indicator set, adds a citeable source, and persists
  the normalized snapshot. Failure emits a core evidence gap; Massive closes are not an acceptable
  substitute for OHLCV.
- Deep `research` runs additionally attempt Verified Market Snapshots for checked-in
  subject-registry representatives. Successful representative snapshots are citeable market-data
  sources and persist as a plural normalized sidecar; failures emit per-representative gaps but do
  not create primary-instrument core gaps.
- Inject canonical instrument identity into prompts to prevent issuer substitution.
- Financial Lens metrics preserve per-metric source IDs. SEC facts are preferred for
  filing-intrinsic metrics; Yahoo snapshot fundamentals supply price-relative metrics and
  non-US fallback coverage.
- Equity runs persist `normalized/fundamental-history.json` as a deterministic SEC companyfacts
  sidecar without changing `report.json`. Each series selects the first configured concept with
  facts, filters by the analysis cutoff, retains up to ten 10-14-month 10-K periods, and resolves
  duplicate period ends to the latest-filed restatement. TTM flows use full FY plus latest YTD less
  aligned prior-year YTD; mismatched periods are omitted with an audit note. Diluted-EPS TTM is
  explicitly labeled an approximation because per-share periods are added without reweighting
  diluted shares. FCF proxy, margins, annual-only CAGR, and margin change are derived only from
  matched periods and compatible units.
- Deep equity valuation uses deterministic peer mappings or subject-registry representatives
  first. If unresolved, a quick model may nominate peers, but code validates symbol existence,
  US-listing status, common-stock eligibility, quote/fact availability, and freshness before use.
  Learned results are cached and revalidated.
- Peer median/IQR aggregates include only candidates that pass deterministic comparability gates:
  a two-digit SEC SIC group matching the target's, and market cap and annualized revenue each
  inclusively within 0.2x-5x of the target's, in addition to the existing freshness and
  valuation-input checks. SIC classification is normalized from the already-fetched SEC
  submissions payload for the target and every candidate. Missing SIC, market cap, annualized
  revenue, or freshness excludes a candidate with a recorded deterministic reason, and at least
  three qualifying peers are required before median/IQR aggregates are emitted. When the target's
  EV/annualized-revenue multiple exceeds 50x or annualized revenue is below 2% of market cap,
  revenue multiples are classified as not meaningful: the revenue-size band is skipped while SIC
  and market-cap gates remain enforced, the peer set is explicitly caveated as
  size/sector-comparable only, and target supportability records `not-meaningful` rather than
  conflating applicability with missing data.
- A supported peer aggregate may add a peer-implied price reference range to the valuation-comps
  sidecar without changing `report.json`. The derivation applies peer EV/annualized-revenue P25,
  median, and P75 multiples to target annualized revenue, subtracts target net debt, and divides by
  Yahoo `sharesOutstanding` from the same quote as market cap and current price. Yahoo shares are
  used instead of filing-dated diluted shares to keep price, shares, market cap, quote currency,
  and observation time point-in-time consistent. Derivation requires, in order, supported comps,
  at least three usable peers, positive annualized revenue, defined non-mixed-period net debt,
  positive shares, a USD quote, three positive derived prices, and a defined current price. The
  first failed gate persists as the suppression reason and emits a `SourceGap`; inputs, basis, and
  formula remain auditable. Quotes equal to either endpoint are `within-range`; only strict
  inequality yields `below-range` or `above-range`. This remains research context, not a composite
  score.
- The SIC-group gate is tier-scoped, not absolute. The checked-in `ticker-mapping` tier is a
  human-audited comparability judgment, so it runs the `curated-no-sic` gate profile: the three
  SIC checks (missing peer SIC, unavailable target SIC, group mismatch) are skipped and only the
  universal size and freshness gates apply. The `revenue-exempt` profile takes precedence for a
  target above the 50x applicability threshold or below the 2% de-minimis-revenue threshold, and
  enforces SIC plus market cap while omitting only the revenue-size band. All other tiers
  (subject-registry, cached, and model-proposed-validated) run the `full` profile with the SIC
  gate enforced, because the SIC gate exists to screen
  untrusted provenance and must not second-guess an audited mapping.
  Applying the registrant SIC uniformly zeroed out the flagship AAPL peer set — its mega-cap
  platform peers register under services SIC groups while AAPL registers under electronic
  computers — so the curated tier lost every comp. The applied profile is recorded on the
  valuation-comps summary (`gateProfile`) for audit. Business-model metadata may explain a
  candidate but still cannot override any gate that applies to its tier; rejected candidates and
  their reasons are retained as screening context.
- Web Subject Profile answers may deterministically clear matching atomic Business Framework gaps.
  Reconciliation uses structured cited fields only and does not alter postures or Evidence Quality.

## Current evidence limitations

- Raw OHLCV indicators are not split-adjusted, and UTC-sliced dates can differ from local exchange
  dates for non-US listings.
- SEC duration selection cannot always distinguish quarter-only from year-to-date facts. Derived
  annualized metrics must preserve period metadata and be treated as screening evidence.
- Fundamental history deliberately does not splice renamed or alternative SEC concepts within one
  series: the first configured concept with facts supplies the whole series. This keeps selection
  consistent and deterministic but can shorten history. Diluted-EPS TTM remains approximate when
  share counts vary across component periods. Because each period independently selects its
  latest-filed fact, a TTM calculation can combine a restated latest YTD with a prior-year YTD that
  was not restated in the same filing.
- Peer comparability gates enforce SIC industry group and size similarity deterministically; for
  revenue-exempt targets, size similarity is market-cap-only. Finer economic comparability
  (business model, segment mix, growth profile) remains weakly grounded and must be disclosed.
  Two-digit SIC groups are coarse and can admit peers with different economics or reject
  conglomerates classified under a different group.
- Company profile reuse can remain valid through material non-filing events until its TTL expires.
- The sanitizer does not detect every Unicode homoglyph or confusable attack.
- The post-synthesis unsupported-claim audit is warning-only; the separate Report Integrity Audit
  in ADR 0005 prunes structurally unsupported claims but does not establish semantic entailment.

## Consequences

- Evidence remains citeable and replayable through normalized and raw artifacts.
- Missing optional evidence degrades transparently instead of aborting a report.
- Derived financial and peer analysis is research context, not a composite investment score.
- Provider failures degrade by capability rather than collapsing a run, while provenance and cache
  semantics keep supplemental fallback visible.
- Existing symbol-based artifacts remain compatible; thematic predictions resolve against one
  declared listed proxy.
- Evidence Quality is comparable across current runs independently of model rhetoric. Raw replay
  data stays separate from normalized current and model-visible evidence.

## Implementation validation

- `src/research/evidence-request-loop.ts` and `src/sources/evidence-request-tools.ts` enforce the
  bounded tool flow.
- `src/sources/verified-market-snapshot.ts` and `src/sources/indicators.ts` implement snapshots.
- `src/sources/extended-evidence/` implements lenses, valuation, framework, and reconciliation.
- `src/research/peer-universe*.ts` implements deterministic, learned, and proposed peer tiers.
- `src/domain/instrument.ts`, `src/sources/instrument-identity.ts`,
  `src/research/subject-registry.ts`, and `research-subject-identity.ts` implement identity.
- `src/sources/providers.ts`, `registry.ts`, `collector.ts`, `yahoo-resilience.ts`, and
  `massive-fallback.ts` implement provider composition and fallback.
- `src/research/source-plan.ts` and `evidence-quality.ts` implement deterministic authority.
- `src/sources/cache.ts` implements freshness and stale-audit behavior.
- `src/sources/model-input-sanitizer.ts`, news collection, SEC filing emission, historical prompt
  projection, and `src/web-evidence/web-gather-loop.ts` implement profile-aware model-input hardening.
- `src/sources/web-gather-tools.ts`, `src/sources/firecrawl-web-tools.ts`, and
  `src/sources/web-gather-emit.ts` implement provider execution and normalized emission through the
  Source Provider seam; `src/web-evidence/web-gather-loop.ts` owns orchestration and policy.
- `src/web-evidence/contract.ts` is the dependency-neutral Web Subject Profile contract entry point.
- `src/web-evidence/web-subject-profile-reuse.ts` implements reuse.
- `src/reproducibility.ts` implements configuration and source-state fingerprints.
