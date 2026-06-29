# ADR 0031 — Deterministic peer comps for valuation evidence

**Status:** Accepted

## Context

Valuation Evidence previously used only the target ticker's already-collected Yahoo market cap and SEC Fundamental Evidence. That was enough to compute enterprise value and revenue multiples, but not enough to test claims such as "premium valuation" or "discount to peers" against a sourced comparison set.

The project already has a Peer Universe concept: comparable Instruments must come from deterministic provenance, not model-selected lists. The Research Subject Registry also carries representative listed-stock instruments that can serve as a conservative fallback when no ticker-specific mapping exists.

## Decision

Expand equity ticker Valuation Evidence from target-only valuation context to deterministic peer-comps research context for `ticker --deep --asset equity`.

The peer resolver:

- uses checked-in ticker peer mappings first;
- falls back to Research Subject Registry listed-stock representatives when the target appears there;
- excludes ETFs from peer comps because SEC company facts are required;
- requires each peer to carry role, rationale, and provenance source IDs;
- caps the resolved peer set.

The collection step fetches peer Yahoo quotes and peer SEC company facts through the existing source request/cache plumbing. Target SEC fundamentals are reused from the existing `sec-edgar` Extended Evidence item. SEC revenue freshness is anchored to the reported period end, not fetch time. Peers are excluded from comps when quote data, market cap, revenue, cash, debt, or revenue period end is missing or stale.

The run persists `normalized/valuation-comps.json` version `1`, with target row, peer rows, excluded peers, source IDs, freshness flags, summary stats, and supportability label. The report surface remains the existing `valuation` Extended Evidence category, enriched with compact peer metrics and source IDs. No new report schema field, prediction kind, scoring path, dependency, or environment variable is introduced.

Supportability rules:

- market quotes must be from the current run date;
- SEC revenue period end must exist and be no more than 180 calendar days before `generatedAt`;
- at least three usable core/secondary peers are required for median/IQR read-through;
- otherwise the result is `screening-only` or `not-supportable` with valuation SourceGaps.

## Consequences

Ticker Research Views can cite deterministic peer valuation context without asking the model to invent comparables. Unsupported tickers fail visibly with valuation SourceGaps and remain research-only.

The collector performs additional Yahoo and SEC requests only for deep equity ticker runs with base Valuation Evidence. Large SEC companyfacts payloads may hit the existing response-size cap; those peers are excluded rather than failing the run.

`normalized/valuation-comps.json` is a single-caller sidecar in v1. The app displays compact peer metrics through the existing valuation tile path, while the full sidecar remains available for audit.

## Rejected alternatives

- Let the model select peers. Rejected because it violates Peer Universe provenance discipline. (Superseded in part by [ADR 0039](./0039-model-proposed-validated-peer-universe.md): the model now _proposes_ candidates, code _validates_ each one deterministically, and a learned cache makes the resolved set reproducible — the model still never authors the peer set directly.)
- Run peer comps for every equity ticker brief. Rejected because the extra peer quote and SEC fetch cost belongs in deep ticker research.
- Add a new report prediction kind or valuation forecast. Rejected because valuation comps are research context, not scored forecasts.
- Add spreadsheet or workbook output. Rejected because the public interface is the normalized JSON sidecar.
