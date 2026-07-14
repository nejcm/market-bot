# ADR 0028: Evidence governance, temporal integrity, and web evidence

## Status

Accepted

## Date

2026-06-30 (amended 2026-07-04: generalized untrusted model-input hardening;
amended 2026-07-08: thematic research web gather enabled for brief and deep runs;
amended 2026-07-12: near-duplicate headline dedupe at web-source acceptance)

## Context

Evidence completeness, freshness, source authority, and open-web content must be evaluated by code
rather than model confidence. Web evidence also introduces prompt-injection and reuse risks.

## Decision

- Build the immutable v2 Source Plan before the first source-provider I/O, deriving lane
  applicability and evidence class only from the resolved command, checked-in research subject,
  asset class, depth, and checked-in policy — never from collected outcomes, credentials,
  provider availability, or successful fetches. `generatedAt` is captured before collection.
- After collection, assess the frozen plan: Evidence Lanes and the Source Ledger grade coverage,
  gaps, freshness, and corroboration for every planned lane against collected sources and gaps.
  All three artifacts remain the existing v2 family; the tolerant v1/v2 reader is unchanged, and
  historical run directories are not rewritten (their plans were produced after collection).
- Classify applicable capability lanes as core, material, or supplemental. Because planned classes
  are pre-collection policy, outcome-dependent class promotion (e.g. derivatives-volatility to
  material on a dated earnings event, on-chain/subject-profile to material when collected,
  peer-valuation to material when the target is unusable) no longer occurs; those lanes are
  planned supplemental. Evidence Quality is derived entirely from observable lane coverage,
  freshness, corroboration, traceability, and gap severity; synthesis cannot author or lower it.
  Missing core evidence lowers Evidence Quality but does not abort synthesis.
- `low` means required/core evidence is unusable; `medium` means core evidence is complete but
  material optional coverage or corroboration is missing; `high` requires complete core and
  sufficiently broad, fresh, corroborated material evidence. Supplemental gaps do not lower it.
- Every model evidence payload carries `analysisAsOf`. Exclude facts published, filed, or ending
  after the cutoff where the adapter supports those semantics.
- Cache entries are freshness-budgeted and validated. Failed live refresh may retain stale payloads
  in raw audit snapshots, but stale payloads do not enter normalized current evidence.
- Deep instrument runs and all thematic research runs may gather bounded web results. Exa is the
  primary web-gather provider; when a configured Exa `web_search`/`web_fetch` hard-fails or returns
  empty/thin results, a Firecrawl fallback may serve the same request (fallback-only — it never
  substitutes for a missing Exa key, and web gather stays gated on `MARKET_BOT_EXA_API_KEY`).
  Regardless of provider, search/fetch is subject constrained, cached, persisted as low-trust `web`
  Sources tagged with their serving provider, and cannot substitute for core market, regulatory, or
  pricing evidence. The web-gather audit records attempted providers, the served provider, the
  fallback reason, and paid credits when the provider returns them.
- For company subjects, Stage-1 web gather derives which durable business-profile sections the
  deterministic SEC 10-K/10-Q packet already covers and rejects background searches that duplicate a
  covered section without a recency, corroboration, or explicit-gap rationale, so web budget is not
  spent re-gathering filed facts.
- Accepted web results are additionally screened by deterministic near-duplicate headline dedupe. A
  candidate whose normalized title token set matches an already-accepted web source at or above a
  0.8 similarity threshold (max of Jaccard and containment, minimum 3 comparable tokens, titles
  only, never domains) is rejected at result acceptance and recorded as a `duplicate-headline`
  rejection in the web-gather audit. Because every rejection requires an already-accepted
  duplicate, dedupe cannot empty web coverage and emits no source gap. This uses deterministic
  string logic only, with no embeddings or new dependencies.
- Web Subject Profiles use fixed cited question sets by subject kind and bounded reuse TTLs.
  Company reuse also considers SEC filing freshness.
- Sanitize provider-controlled prose and short labels before model exposure through one shared,
  profile-aware path. Profiles cover open web, news, SEC filing sections, short metadata, and
  prompt-bound legacy history. Sanitization occurs at provider-neutral normalized emit boundaries;
  SEC instruction filtering follows section extraction, and historical artifacts are never
  rewritten. Raw provider payloads remain unchanged in audit snapshots.
- Persist generalized, text-free sanitizer aggregates by provider/ingress, profile, and field role
  in trace and analytics while preserving the existing web-gather sanitizer block. Empty or rejected
  normalized content emits an aggregated non-fatal validation gap where applicable.
- Persist fingerprints of effective non-secret configuration and dirty source state for audit.

## Current governance limitations

- The sanitizer does not detect all Unicode homoglyph/confusable attacks.
- Post-synthesis unsupported-claim auditing is warning-only under ADR 0011; the separate Report
  Integrity Audit (ADR 0011) prunes structurally unsupported claims but makes no
  semantic-entailment guarantee.
- Company profile TTL reuse does not invalidate on every possible material non-filing event.

## Consequences

- Evidence Quality is comparable across current runs independently of model rhetoric.
- Raw replay data is separated from normalized current/model-visible evidence.
- Web evidence can close qualitative gaps without raising core evidence authority.

## Implementation validation

- `src/research/source-plan.ts` and `evidence-quality.ts` implement deterministic authority.
- `src/sources/cache.ts` implements freshness and stale-audit behavior.
- `src/sources/model-input-sanitizer.ts`, news collection, SEC filing emission, historical prompt
  projection, and `src/web-evidence/web-gather-loop.ts` implement profile-aware model-input hardening.
  `src/web-evidence/web-gather-emit.ts` remains the shared provider-neutral Exa/Firecrawl emit path.
- `src/web-evidence/web-subject-profile-reuse.ts` implements reuse.
- `src/reproducibility.ts` implements configuration and source-state fingerprints.

## Supersedes

- ADR 0034
- ADR 0035
- ADR 0037
- ADR 0038
- ADR 0040
