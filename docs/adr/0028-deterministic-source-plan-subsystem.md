# ADR 0028: Evidence governance, temporal integrity, and web evidence

## Status

Accepted

## Date

2026-06-30

## Context

Evidence completeness, freshness, source authority, and open-web content must be evaluated by code
rather than model confidence. Web evidence also introduces prompt-injection and reuse risks.

## Decision

- Build deterministic Source Plan, Evidence Lanes, and Source Ledger sidecars from the run type,
  depth, asset class, dated-event context, collected sources, and gaps.
- Classify applicable capability lanes as core, material, or supplemental. Evidence Quality is
  derived entirely from observable lane coverage, freshness, corroboration, traceability, and gap
  severity; synthesis cannot author or lower it.
- `low` means required/core evidence is unusable; `medium` means core evidence is complete but
  material optional coverage or corroboration is missing; `high` requires complete core and
  sufficiently broad, fresh, corroborated material evidence. Supplemental gaps do not lower it.
- Every model evidence payload carries `analysisAsOf`. Exclude facts published, filed, or ending
  after the cutoff where the adapter supports those semantics.
- Cache entries are freshness-budgeted and validated. Failed live refresh may retain stale payloads
  in raw audit snapshots, but stale payloads do not enter normalized current evidence.
- Deep instrument and thematic runs may gather bounded web results. Exa is the primary web-gather
  provider; when a configured Exa `web_search`/`web_fetch` hard-fails or returns empty/thin results,
  a Firecrawl fallback may serve the same request (fallback-only — it never substitutes for a missing
  Exa key, and web gather stays gated on `MARKET_BOT_EXA_API_KEY`). Regardless of provider, search/fetch
  is subject constrained, cached, persisted as low-trust `web` Sources tagged with their serving
  provider, and cannot substitute for core market, regulatory, or pricing evidence. The web-gather
  audit records attempted providers, the served provider, the fallback reason, and paid credits when
  the provider returns them.
- For company subjects, Stage-1 web gather derives which durable business-profile sections the
  deterministic SEC 10-K/10-Q packet already covers and rejects background searches that duplicate a
  covered section without a recency, corroboration, or explicit-gap rationale, so web budget is not
  spent re-gathering filed facts.
- Web Subject Profiles use fixed cited question sets by subject kind and bounded reuse TTLs.
  Company reuse also considers SEC filing freshness.
- Sanitize provider-controlled titles, publishers, summaries, and snippets (Exa or Firecrawl) before
  model exposure through one shared sanitize path. Raw payloads remain exact in audit snapshots. Only
  the profile-extraction stage sees sanitized web prose; later stages receive metadata and the cited
  structured profile.
- Persist current-run web-source role telemetry, optional reused-profile web-source telemetry, and
  sanitizer telemetry. Empty sanitized content emits a non-fatal gap.
- Persist fingerprints of effective non-secret configuration and dirty source state for audit.

## Current governance limitations

- News-provider prose is injected into model evidence without the Exa sanitizer. It remains an
  untrusted-content gap in the current implementation.
- The sanitizer does not detect all Unicode homoglyph/confusable attacks.
- Post-synthesis unsupported-claim auditing is warning-only under ADR 0011.
- Company profile TTL reuse does not invalidate on every possible material non-filing event.

## Consequences

- Evidence Quality is comparable across current runs independently of model rhetoric.
- Raw replay data is separated from normalized current/model-visible evidence.
- Web evidence can close qualitative gaps without raising core evidence authority.

## Implementation validation

- `src/research/source-plan.ts` and `evidence-quality.ts` implement deterministic authority.
- `src/sources/cache.ts` implements freshness and stale-audit behavior.
- `src/research/web-gather-loop.ts`, `src/sources/web-gather-tools.ts`,
  `src/sources/web-gather-emit.ts` (shared provider-neutral sanitize/emit path),
  `src/sources/firecrawl-web-tools.ts`, and `web-text-sanitizer.ts` implement bounded sanitized web
  evidence, SEC-coverage-aware Stage-1 gating, and the Firecrawl fallback.
- `src/research/web-subject-profile-reuse.ts` implements reuse.
- `src/reproducibility.ts` implements configuration and source-state fingerprints.

## Supersedes

- ADR 0034
- ADR 0035
- ADR 0037
- ADR 0038
- ADR 0040
