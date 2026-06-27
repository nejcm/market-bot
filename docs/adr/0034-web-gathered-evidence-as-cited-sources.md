# ADR 0034: Web-gathered evidence as cited Sources

## Status

Accepted

## Context

ADR 0032 allows live web search in Run Chat as ephemeral conversational context. Those findings are not Sources, are not written under `data/runs/`, and cannot enter Evidence Quality or prediction scoring.

Deep equity research has a different gap: SEC, Yahoo, and options data cannot reliably answer qualitative business-model questions such as customer mix, recurrence, pricing power, geography, or recent operating changes. The pipeline needs a replayable way to gather that context without making open-web text authoritative or letting it change research scope.

The project already has a provider-neutral JSON tool loop (ADR 0010), cached Source Provider requests, raw snapshots, Source IDs, Source Gaps, Extended Evidence, and sidecar artifacts. Reusing those seams keeps web research bounded and auditable.

## Decision

Admit Exa-gathered open-web content into the persisted evidence pipeline only as low-trust cited Sources:

- `equity --deep` may run a bounded Web Gather loop using `web_search` and `web_fetch`.
- `web_search` queries must mention the run symbol or resolved company name.
- `web_fetch` may fetch only URLs surfaced by a `web_search` in the same run.
- Exa calls go through the cached request seam and raw snapshot path.
- Each normalized web result becomes a Source with `kind: "web"` and `provider: "exa"`.
- Web Source Gaps and freshness gaps use `evidenceQualityImpact: "extended-evidence-cap"`.
- Web Sources cannot raise Evidence Quality above the extended-evidence cap and cannot substitute for core market, SEC, or pricing evidence.
- A `web-company-profile` Extended Evidence item and `normalized/web-company-profile.json` sidecar may summarize gathered web facts.
- Every accepted Web Company Profile answer or fact must cite gathered web Source IDs.
- Web content is treated only as data. It cannot widen run scope, prediction subjects, allowed tools, or downstream instructions.

## Consequences

- Deep equity reports can cite qualitative company context from persisted Sources instead of relying on uncited model priors.
- Web findings now have replayable artifacts, source IDs, gaps, and audit trails, unlike ADR 0032 Run Chat web search.
- The evidence graph gains an intentionally low-trust Source kind, so report rendering and console views can label it distinctly.
- Runs become dependent on Exa availability and API credentials when web gather is enabled. Missing credentials or provider failures degrade to Source Gaps rather than aborting research.
- Residual prompt-injection risk remains. Query containment, URL allowlisting, citation validation, and scope guards reduce risk, but open-web content can still contain hostile or misleading text. The pipeline must keep treating fetched web text as untrusted evidence, not instructions.

## Rejected alternatives

- **Keep all web search ephemeral** - rejected because qualitative company facts need persisted citations and replayable run artifacts.
- **Let synthesis cite arbitrary model-found URLs** - rejected because it bypasses cached requests, raw snapshots, Source IDs, and validation.
- **Fold web facts into Business Framework Evidence** - rejected because Business Framework postures are deterministic SEC/Yahoo-derived evidence and should remain independent from untrusted web text.
- **Use provider-native tool calling** - rejected for the same reason as ADR 0010: budgets, validation, and source execution should remain provider-neutral and testable.

## References

- [ADR 0001 - Research-only boundary](./0001-research-only-boundary.md)
- [ADR 0010 - Bounded provider-neutral Evidence Request Loop](./0010-evidence-request-loop.md)
- [ADR 0032 - Live web search in Run Chat](./0032-run-chat-web-search.md)
