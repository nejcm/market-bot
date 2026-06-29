# ADR 0040: Model-visible web text sanitization

## Status

Accepted

## Context

ADR 0034 admits Exa-gathered open-web results as low-trust Sources, with raw provider payloads retained for replay and audit. Those payloads can contain page chrome, HTML, prompt templates, or hostile instructions mixed with useful business facts.

Web Subject Profile extraction still needs factual prose for qualitative questions such as products, revenue streams, customers, geography, recurrence, pricing power, and cyclicality. Later synthesis does not need raw web prose once the cited structured profile exists, and should not receive it when profile extraction is empty or failed.

## Decision

Separate raw web payload retention from model-visible web text:

- Raw Web Snapshots stay exact provider payloads under the raw snapshot path.
- Before any web `summary` or `snippet` is written to normalized `Source` fields, the adapter sanitizes the text with a local dependency-free TypeScript sanitizer.
- Provider-controlled titles and publishers are sanitized and bounded; result URLs and publication dates are validated before entering normalized Source metadata.
- Sanitization strips high-confidence HTML/page chrome and prompt-risk spans, including scripts/styles/forms, tags/entities, code fences, cookie/subscribe/share/advertising lines, and explicit instruction-injection text.
- Sanitization preserves ordinary business prose and avoids false positives on words such as "instruct", "command", or "prompt" when used in normal context.
- If model-visible text becomes empty after sanitization, the web Source metadata is retained without `summary` or `snippet`, and a non-fatal `web-gather` SourceGap with `provider-data-missing` and `extended-evidence-cap` is emitted.
- Sanitizer telemetry is persisted in `normalized/web-gather-audit.json`: source count, sanitized source count, empty-after-sanitize count, input/output character counts, removed instruction span count, and removed chrome/html count.
- Sanitized web text is projected only to Web Subject Profile extraction. Other model stages receive web source metadata and, when present, the cited structured `webSubjectProfile`, not web summaries or snippets.

`Source` remains unchanged; sanitizer metadata belongs to the web gather audit sidecar.

## Consequences

- Web Subject Profile extraction keeps enough factual context to answer business-model questions.
- Final synthesis has a smaller prompt-injection surface because it cannot fall back to raw or sanitized web snippets when profile extraction is empty.
- Raw provider payloads remain available for audit/replay without becoming model instructions.
- The sanitizer is intentionally conservative, not a relevance classifier or truth judge. It strips only high-confidence prompt-risk and page-chrome spans.
- Format separators are normalized before instruction matching, but Unicode homoglyph and confusable detection remains out of scope.

## Rejected alternatives

- **Drop any page containing hostile text** - rejected because useful business facts are often mixed with boilerplate or hostile spans; span-level removal preserves value.
- **Add a parser/readability dependency** - rejected because the first hardening pass only needs deterministic local normalization and should not widen the toolchain.
- **Store sanitizer metadata on `Source`** - rejected because `Source` is shared repo-wide and the audit sidecar is the narrower contract.
- **Let synthesis see sanitized snippets on profile failure** - rejected because the intended downstream contract is structured cited profile plus web metadata only.

## References

- [ADR 0001 - Research-only boundary](./0001-research-only-boundary.md)
- [ADR 0034 - Web-gathered evidence as cited Sources](./0034-web-gathered-evidence-as-cited-sources.md)
- [ADR 0035 - Web Subject Profile across subject kinds](./0035-web-subject-profile-across-subject-kinds.md)
