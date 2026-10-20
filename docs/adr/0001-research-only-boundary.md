# ADR 0001: Research-only boundary

## Status

Accepted

## Context

Persisted research must remain sourced analysis with Observable Predictions, separate from execution.
Ephemeral Run Chat has a deliberately different boundary.

## Decision

- Persisted reports, alpha-search output, history narratives, and generated artifacts must contain no
  buy/sell/hold conclusions, sizing, execution instructions, allocation changes, or portfolio actions.
  Predictions describe public observable quantities under [ADR 0003](./0003-forecasts-scoring-and-calibration.md).
- Providers must never use account, order, portfolio, or execution endpoints.
- Run Chat is the sole current exception: it may discuss positioning and trade ideas, is not report-validated,
  and is not persisted server-side. Browser-local transcripts are not Run Artifacts. Documentation must
  distinguish this exception; extending trade-oriented behavior beyond chat requires a new ADR.
- Research prompts and persisted-report/history validation enforce the boundary. The exact matcher lives in
  `src/domain/research-language.ts`: trade actions, ticker-directed and sentence-initial imperatives,
  reader-directed advice, and valuation-certainty language are prohibited; neutral business prose is allowed.
  Sanctioned valuation disclaimers remain the matcher's explicit exceptions.
- Peer-implied price reference ranges may describe an observed quote as `below-range`, `within-range`, or
  `above-range` against a disclosed peer-derived interval. Fair/intrinsic value, target prices, percentage or
  valuation gaps, margin of safety, and under/overvalued conclusions remain prohibited.
- Reverse DCF is only a solved-for five-year FCF-growth sensitivity grid across 8%–16% discount rates and
  0%–4% terminal growth. Disclose starting FCF, enterprise value, both assumptions, and horizon. Emit no
  derived price, target, fair-value label, observed-versus-derived comparison, percentage gap, margin of
  safety, or under/overvalued conclusion. Keep this input-sensitivity artifact isolated and removable.
- `assertSafeReportLanguage` scans model-authored `summary`, `keyFindings`, `bullCase`, `bearCase`, `risks`,
  `catalysts`, `scenarios`, and model-authored fields within mixed extras. Classification is per field:
  Business Framework section text, the three Earnings Setup bullet arrays, Spotlight rationales, and
  projected Web Subject Profile prose stay scanned; adjacent collector fields do not become authored prose.
- Join scanned segments with **newlines**, never `JSON.stringify`. Sentence-initial matching requires `^`
  or `.!?;:\n` before the verb; JSON quotes and escaped newlines defeat that rule.
- The following exempt list is **closed**; adding any exempt surface requires amending this ADR:
  - Attributed `sources[].title`, `.summary`, and `.snippet`, including rendered source titles and
    source-labelled search entries.
  - Collector-derived `extendedEvidence[].title` and `.summary` containing filing/news text.
  - Deterministic `researchQualityDriver`.
  - Code-built `extras.historicalContext` and `extras.catalystCalendar`. Historical summaries are sanitized
    external ingress, not trusted because an older run passed an older matcher; calendar catalyst labels
    duplicate scanned catalysts.
  - Code-generated `extras.*.gaps`. This exemption does not extend to `report.dataGaps`.
  - `extras.metricSections`: labels, values, basis, and reasons are deterministic templates tested against
    the matcher. Assembly unconditionally strips draft-authored copies, including when none were collected.
  - `predictions[]`: public claims render from parsed observable expressions; `measurableAs` is parsed DSL.
- `report.dataGaps` remains an existing unscanned mixed-authorship surface, not an added exemption.
  Relocation of uncited findings/Business Framework text into it can bypass the screen; closing that gap is
  separate work, not a change authorized by consolidation.
- Metric references use `<<metric:<section>.<id>>>` or `<<metric:<section>.<id>|period>>`; brace-delimited forms are malformed. Merge citations,
  validate authored prose with tokens intact, substitute only deterministic formatted metric values, then
  screen resolved prose again inside the bounded report repair loop: substitution can construct blocked
  phrases such as a percentage followed by “gap”. No surrounding prose becomes exempt. Summary, data gaps,
  and Prediction expressions cannot contain references ([ADR 0004](./0004-evidence-and-model-stage-pipeline.md)).
- Exemption from the research-language screen never exempts source text from prompt-injection sanitization.
  Source wording copied or synthesized into an authored field is scanned there. Source-text research-language
  audits are warning-only and remain separate from report enforcement.

## Consequences

- Repair prompts address model-authored assertions rather than asking the model to rewrite quoted filings.
- Every new report surface needs an explicit per-field authored/collected classification.
- Run Chat needs a separate threat model; ephemerality does not imply the persisted research-only policy.
