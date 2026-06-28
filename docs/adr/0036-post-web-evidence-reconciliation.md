# Post-web evidence reconciliation

After the Web Subject Profile is extracted (or reused), a deterministic reconciliation pass clears Business Framework qualitative gaps that the profile's structured answers have resolved. This avoids the report disclosing gaps that the system's own web evidence already covers.

## Scope

Business Framework v2 represents each qualitative gap as a stable code plus display text. Web Subject Profile v3 adds structured company questions for management track record, capital allocation, company-specific KPIs, and disclosed risk factors. Every supported question maps to one gap code; analyst consensus remains unresolved because the provider-neutral source policy has no authoritative consensus capability.

## Decision

- **Structured-only, deterministic.** Reconciliation checks only Web Subject Profile v3's structured `questions` object — it never scans `factLedger` prose. A non-empty answer with at least one cited `sourceId` resolves only its mapped code: `howItMakesMoney` → `segment-mix`, `customers` → `customer-concentration`, `purchaseRecurrence` → `purchase-recurrence`, `managementTrackRecord` → `management-track-record`, `capitalAllocation` → `capital-allocation`, `companyKpis` → `company-kpis`, and `riskFactors` → `risk-factors`.
- **Atomic gaps removed, postures frozen.** Reconciliation removes each resolved code from every section and the artifact-level gap list, then regenerates the `frameworkGap` SourceGap. Partial answers resolve independently. Postures, phase, metrics, and summaries are never changed.
- **No Evidence Quality impact.** Framework qualitative gaps carry `evidenceQualityImpact: "no-cap"`, so clearing them provably cannot move the EQ cap. Web evidence raising EQ would require a change to this contract and is out of scope.
- **Audit marker on the artifact.** A `reconciliation: { resolvedGaps, profileSourceIds }` field is added to `BusinessFrameworkArtifact`, surfaced through `extras.businessFramework` in the report, so downstream consumers can see what was reconciled and which web sources backed it.

## Seam

The reconciliation runs as a new step in `orchestrator.ts`, immediately after the web subject profile is either extracted or reused, before synthesis begins. It reads `collectedSources.businessFramework` and `collectedSources.webSubjectProfile`, and swaps the reconciled artifact and regenerated SourceGap back onto `collectedSources`.

## Rejected alternatives

- **Moving the framework build after web gather.** Would change the collector's timing contract and introduce ordering dependencies; the post-build reconciliation pass is less invasive.
- **Prose scanning / factLedger matching.** Fragile, non-deterministic, and prone to false positives. Structured questions give a reliable signal.
- **Web evidence raising Evidence Quality.** The `no-cap` contract on qualitative gaps means clearing them can't change EQ. Allowing web evidence to raise EQ is a larger design change for a separate ADR.
- **Bundled all-or-nothing gaps.** Bundling independent concepts caused cited evidence for one field to leave misleading unresolved text. Stable atomic codes make reconciliation auditable and independently resolvable.

## References

- [ADR 0001 — Research-only boundary](./0001-research-only-boundary.md)
- [ADR 0033 — Two-tier fundamental provenance](./0033-two-tier-fundamental-provenance.md)
- [ADR 0035 — Web Subject Profile across subject kinds](./0035-web-subject-profile-across-subject-kinds.md)
