# Post-web evidence reconciliation

After the Web Subject Profile is extracted (or reused), a deterministic reconciliation pass clears Business Framework qualitative gaps that the profile's structured answers have resolved. This avoids the report disclosing gaps that the system's own web evidence already covers.

## Scope

Only `GAP[0]` (segment mix, customer concentration, purchase recurrence) is clearable today — it maps directly to the profile's `howItMakesMoney`, `customers`, and `purchaseRecurrence` structured questions. `GAP[1]` (management track record) and `GAP[2]` (analyst estimates, KPIs, risk buckets) have no matching structured questions in the profile and remain standing.

## Decision

- **Structured-only, deterministic.** Reconciliation checks only the profile's structured `questions` object — it never scans `factLedger` prose or any model-generated text. The predicate is: all three GAP[0] questions have a non-empty `answer` with ≥1 cited `sourceId`. All-or-nothing: partial resolution leaves the whole gap.
- **Gap strings removed, postures frozen.** Reconciliation removes gap strings from Business and Moat section `gaps`, artifact-level `gaps`, and regenerates the `frameworkGap` SourceGap. Postures, phase, metrics, and summaries are never changed — the framework's quantitative evidence base is unaffected.
- **No Evidence Quality impact.** Framework qualitative gaps carry `evidenceQualityImpact: "no-cap"`, so clearing them provably cannot move the EQ cap. Web evidence raising EQ would require a change to this contract and is out of scope.
- **Audit marker on the artifact.** A `reconciliation: { resolvedGaps, profileSourceIds }` field is added to `BusinessFrameworkArtifact`, surfaced through `extras.businessFramework` in the report, so downstream consumers can see what was reconciled and which web sources backed it.

## Seam

The reconciliation runs as a new step in `orchestrator.ts`, immediately after the web subject profile is either extracted or reused, before synthesis begins. It reads `collectedSources.businessFramework` and `collectedSources.webSubjectProfile`, and swaps the reconciled artifact and regenerated SourceGap back onto `collectedSources`.

## Rejected alternatives

- **Moving the framework build after web gather.** Would change the collector's timing contract and introduce ordering dependencies; the post-build reconciliation pass is less invasive.
- **Prose scanning / factLedger matching.** Fragile, non-deterministic, and prone to false positives. Structured questions give a reliable signal.
- **Web evidence raising Evidence Quality.** The `no-cap` contract on qualitative gaps means clearing them can't change EQ. Allowing web evidence to raise EQ is a larger design change for a separate ADR.
- **Partial GAP[0] resolution.** GAP[0] bundles three related concepts (segment mix, customer concentration, purchase recurrence). Resolving only one or two would leave a misleading partial gap string.

## References

- [ADR 0001 — Research-only boundary](./0001-research-only-boundary.md)
- [ADR 0033 — Two-tier fundamental provenance](./0033-two-tier-fundamental-provenance.md)
- [ADR 0035 — Web Subject Profile across subject kinds](./0035-web-subject-profile-across-subject-kinds.md)
