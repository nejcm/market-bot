# ADR 0006: Instrument evidence and deterministic analysis

## Status

Accepted

## Date

2026-06-30 (amended 2026-07-02: deterministic peer comparability gates; amended 2026-07-05:
tier-scoped SIC gate)

## Context

Equity and crypto instrument runs combine provider evidence, deterministic derived analysis, and
bounded model-requested evidence. Earlier ADRs split these decisions across evidence loops,
verified snapshots, fundamentals, valuation peers, and post-web reconciliation.

## Decision

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
- Canonical instrument identity is derived from the collected market snapshot without a second
  fetch and is injected into prompts to prevent issuer substitution.
- Financial Lens metrics preserve per-metric source IDs. SEC facts are preferred for
  filing-intrinsic metrics; Yahoo snapshot fundamentals supply price-relative metrics and
  non-US fallback coverage.
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
  three qualifying peers are required before median/IQR aggregates are emitted.
- The SIC-group gate is tier-scoped, not absolute. The checked-in `ticker-mapping` tier is a
  human-audited comparability judgment, so it runs the `curated-no-sic` gate profile: the three
  SIC checks (missing peer SIC, unavailable target SIC, group mismatch) are skipped and only the
  universal size and freshness gates apply. All other tiers (subject-registry, cached, and
  model-proposed-validated) run the `full` profile with the SIC gate enforced, because the SIC
  gate exists to screen untrusted provenance and must not second-guess an audited mapping.
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
- Peer comparability gates enforce SIC industry group and size similarity deterministically, but
  finer economic comparability (business model, segment mix, growth profile) remains weakly
  grounded and must be disclosed. Two-digit SIC groups are coarse and can admit peers with
  different economics or reject conglomerates classified under a different group.
- Company profile reuse can remain valid through material non-filing events until its TTL expires.

## Consequences

- Evidence remains citeable and replayable through normalized and raw artifacts.
- Missing optional evidence degrades transparently instead of aborting a report.
- Derived financial and peer analysis is research context, not a composite investment score.

## Implementation validation

- `src/research/evidence-request-loop.ts` and `src/sources/evidence-request-tools.ts` enforce the
  bounded tool flow.
- `src/sources/verified-market-snapshot.ts` and `src/sources/indicators.ts` implement snapshots.
- `src/sources/extended-evidence/` implements lenses, valuation, framework, and reconciliation.
- `src/research/peer-universe*.ts` implements deterministic, learned, and proposed peer tiers.

## Supersedes

- ADR 0010
- ADR 0019
- ADR 0031
- ADR 0033
- ADR 0036
- ADR 0039
