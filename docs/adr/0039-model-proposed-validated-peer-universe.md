# Model-proposed, code-validated peer universe

## Status

Accepted. Partially supersedes [ADR 0031](./0031-deterministic-peer-comps-valuation.md).

## Context

Peer comps for `equity --deep` valuation resolve a Peer Universe through two deterministic tiers only ([ADR 0031](./0031-deterministic-peer-comps-valuation.md), [ADR 0027](./0027-subject-proxy-peer-universe-registry.md)): a checked-in ticker mapping, then Research Subject Registry listed-stock representatives. Any other ticker returns unresolved and the run emits an `unsupported-coverage` Source Gap. ADR 0031 explicitly rejected "let the model select peers" because it violates Peer Universe provenance discipline.

That gives auditability but narrow coverage: arbitrary large caps with no checked-in mapping degrade to a disclosed gap instead of peer comps. We want broader coverage without abandoning the deterministic-authoring principle that the rest of the codebase is built on ([ADR 0019](./0019-verified-market-snapshot.md), [ADR 0037](./0037-deterministic-evidence-quality-authority.md): model output cannot author the artifact).

## Decision

When no deterministic tier resolves, the quick model **proposes** candidate peers and code **validates** each one deterministically. The model never authors the peer set directly — it only nominates candidates that must pass the same gates a checked-in mapping would.

The new provenance value is `model-proposed-validated`. Resolution order (`resolvePeerUniverseWithFallback`):

1. The existing sync tiers (`resolvePeerUniverse`). If resolved, return — the model never fires for AAPL/NVDA/etc.
2. Learned-cache tier: a gitignored JSON store, consulted before any model call. A hit is re-validated and TTL-checked on every read, then returned (reproducible, no model call).
3. Live model tier: the model proposes up to `MAX_PEERS` candidates; each is validated against (a) symbol shape, (b) target/duplicate exclusion, (c) **existence in the SEC `company_tickers.json` directory** (anti-hallucination + guarantees a CIK for the downstream companyfacts fetch), (d) **US-listing** (`isUsListing`), and (e) official listed-universe common-stock eligibility, rejecting ETFs/funds, ADRs, warrants, units, preferreds, notes, and similar non-common-stock securities. The downstream fetchable-facts/fresh-quote pipeline and the SEC-revenue requirement remain the hard backstop. If at least `MIN_PROPOSED_PEERS` (3) survive, the validated set is written to the learned cache and returned; otherwise the run falls back to the existing `unsupported-coverage` gap.

The model call lives in the source-collection layer: a `PeerUniverseFallbackContext` is threaded through `CollectContext` into `collectValuationComps`, bound only for deep-equity runs. Grounding is symbol + company name only; sector/industry is not cleanly available for a single ticker today (only the mover screener parses `sector`). Weak grounding costs recall, never correctness, because every candidate is hard-validated. The cheapest future upgrade is capturing `sector` in `normalizeYahooQuote` (no new fetch).

Reports that use a model-proposed peer set carry a disclosure clause in the valuation evidence ("Peer set provenance: model-proposed (LLM-proposed, code-validated against SEC directory + US-listing; cached)"), so the provenance is visible wherever the comps are cited.

Configuration: `MARKET_BOT_PEER_UNIVERSE_LEARNED_PATH` (default a sibling of `news-seen.json`) and `MARKET_BOT_PEER_UNIVERSE_TTL_DAYS` (default 90). Cached entries are re-validated on every read regardless of TTL.

## Consequences

- Deep-equity runs cover arbitrary US-listed tickers without a checked-in mapping, while every cited peer still passes deterministic provenance gates.
- The model fires only on a deep-equity deterministic-tier miss with a cold cache — never for mapped tickers, and at most once per novel ticker per TTL window.
- **Bounded non-reproducibility window:** the very first run of a novel ticker (before the cache write) is not reproducible run-to-run even at `temperature:0`. The cache closes the window after one run. Accepted and documented.
- Reports will start citing model-proposed comps, which is hard to reverse once published. The `model-proposed-validated` provenance tag, the report disclosure clause, and the learned cache (which makes the set stable and auditable) are the mitigations.
- The learned cache is gitignored and never edited by the model into checked-in source. Promotion of a learned set into the curated `PEER_UNIVERSE_MAPPINGS` remains a manual, reviewed step.

## Rejected alternatives

- **Offline authoring tool only** (model proposes in a dev CLI, human reviews, result checked in; runtime stays deterministic). Rejected: keeps the default path fully reproducible but does not broaden runtime coverage, which was the goal.
- **Always-on with no cache / no reuse.** Rejected: every novel-ticker deep run becomes non-reproducible, with no path back to determinism.
- **Append validated peers into checked-in `PEER_UNIVERSE_MAPPINGS` at runtime.** Rejected: runtime rewriting TS source bypasses review and conflicts with the deterministic-authoring principle.
- **Feature flag, default off.** Rejected by the user in favor of always-on plus the learned cache.
