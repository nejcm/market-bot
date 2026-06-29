# ADR 0010 — Bounded provider-neutral Evidence Request Loop

## Status

Accepted

## Context

Ticker deep research can need one more public filing or options-data pull after the first evidence pass. The previous pipeline was fixed-shot: collect configured sources, then run specialist, critique, and synthesis. Adding provider-native tool calling would couple model providers to source execution and make budgets, cache behavior, and source gaps harder to audit.

The project also has hard boundaries: research-only output, public data only, no account/trading endpoints, observable predictions, and normal source artifacts.

## Decision

Add a bounded Evidence Request Loop before `specialist-analysis` for `ticker --deep --asset equity` only. The loop:

- uses a new prompt stage, `evidence-request`, with JSON response format;
- does not use model-provider native tool APIs;
- accepts only `requests: [{ tool, args, rationale }]`;
- validates requests against enumerated public-data tools and the run symbol;
- enforces max rounds, max accepted tool calls, and declared source-unit budget;
- executes tools through the source collector seam, including timeout, retry, cache, rate limit, circuit breaker, stale fallback, and `SourceGap` behavior;
- merges outputs into normal Extended Evidence, Sources, raw snapshots, and `SourceGap`s;
- treats malformed JSON as a `SourceGap` and stops additional evidence-request rounds;
- records an optional trace audit instead of adding report schema fields.

V1 tools are:

- `sec_latest_filing` — SEC EDGAR latest 10-K and latest 10-Q filing text (two citeable Sources), 5 source units.
- `tradier_iv_term_structure` — Tradier public market-data IV term structure, 5 source units, available only when `MARKET_BOT_TRADIER_API_TOKEN` is set.

The env limits default to two rounds, two accepted tool calls, and eight source units. Setting any limit to `0` disables the loop.

## Consequences

- Deep equity ticker runs can adaptively add high-value public evidence without widening the report schema.
- Tool behavior remains provider-neutral and testable because model providers still receive plain JSON prompts.
- All fetched evidence remains visible through existing artifact categories.
- Validation failures and unavailable tools become `SourceGap`s instead of aborting research.
- The first version is intentionally narrow; crypto, daily, weekly, and brief ticker runs skip the loop.

## Rejected alternatives

- **Provider-native tool calling** — rejected because it would couple OpenAI/OpenAI-compatible/Codex behavior to source execution and make cross-provider tests harder.
- **Unbounded agentic loop** — rejected because source costs, rate limits, and report reproducibility require max rounds, max calls, and declared source-unit budgets.
- **New report schema fields** — rejected because fetched evidence already fits Extended Evidence, Sources, raw snapshots, and `SourceGap`s.

## References

- [ADR 0001 — Research-only boundary](./0001-research-only-boundary.md)
- [ADR 0009 — Source provider modules with optional capabilities](./0009-source-provider-modules.md)
