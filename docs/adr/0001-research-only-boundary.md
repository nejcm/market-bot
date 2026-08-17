# ADR 0001: Research output boundary

## Status

Accepted

## Date

2026-06-30 (consolidated 2026-07-15; amended 2026-07-23; amended 2026-08-09:
attributed third-party source-text boundary)

## Context

The project produces market research artifacts and observable forecasts. Persisted artifacts must
not become trading instructions. The Research Console also has an ephemeral Run Chat whose current
implementation deliberately permits positioning and trade-oriented questions.

## Decision

- Persisted reports, alpha-search output, history narratives, and generated artifacts are
  research-only. They must not contain buy/sell/hold conclusions, position sizing, execution
  instructions, allocation changes, or portfolio actions.
- Predictions are probabilistic statements about public observable quantities, not
  recommendations. Their scored event is defined by the forecast DSL in ADR 0003.
- Report validation and research prompts enforce the persisted-output boundary.
- Run Chat is the sole current exception. It is not report-validated, is not persisted server-side,
  and may discuss positioning or trade ideas over run artifacts. Browser-local chat storage does
  not make chat a Run Artifact.
- The exception means the product as a whole is not uniformly “no trade-action surface.”
  Documentation must distinguish persisted research artifacts from ephemeral chat behavior.
- Provider and source integrations must never use account, order, portfolio, or execution
  endpoints.

Positional peer-implied price reference ranges are inside the research-only boundary when they use
only `below-range`, `within-range`, or `above-range` to describe an observed quote relative to a
fully disclosed peer-derived interval. Calling such an interval fair value or a target price,
claiming a margin of safety, or labeling a security undervalued or overvalued remains prohibited.

A persisted reverse-DCF artifact is inside the research-only boundary only as a solved-for
five-year FCF growth sensitivity grid across 8%–16% discount rates and 0%–4% terminal-growth
assumptions. It must disclose starting FCF, enterprise value, discount rate, terminal growth, and
the five-year horizon. It must not emit a model-derived price, price target, fair-value label,
observed-versus-derived comparison, percentage gap, margin of safety, or undervalued/overvalued
conclusion. The grid describes the growth input that reconciles each disclosed assumption pair; it
is not a valuation verdict.

Amendment: research-only enforcement applies to market-bot-authored and model-derived assertions.
Provenance-preserving third-party `report.sources[].title`, `summary`, and `snippet` text is outside
the boundary because the boundary governs assertions market-bot makes, not attributed third-party
evidence it cites. The exemption also includes source titles in the cited-source list rendered by
`src/report/markdown-primitives.ts:renderSources`. The only other exempt projection today is the
source-labelled search entry built by `src/report-search-entries.ts:sourceCandidates`; adding
another exempt projection requires an ADR amendment.

The exemption is only from the research-only screen. Prompt-injection sanitization remains
mandatory through `sanitizeOptionalWebText` and the news-path `sanitizeNewsSource`. Any source
wording copied or synthesized into authored report fields remains subject to
`src/report/schema.ts:assertSafeReportLanguage`. `src/sources/sec-filing-item.ts:buildSecFilingSourceItem`
puts sanitized filing-packet text in exempt `Source.snippet` and an excerpt of those same bytes in
gated `extendedEvidence[].summary`; `src/research/extended-evidence-projections.ts:webSubjectProfileExtra`
projects model-derived profile text into scanned extras. `assertSafeReportLanguage` covers authored
and derived text only.

The Phase 0 sweep of 35 `data/runs/*/report.json` artifacts scanned 1,795 sources and flagged 142
(7.9%), with 217 flagged field occurrences. By kind, the flagged sources were 78 web, 47 news, and
17 extended-evidence; by field, occurrences were 47 title, 95 summary, and 75 snippet. The most
common matches were `price target` (94), `you should` (22), `price targets` (16), `you need to`
(16), and `: buy` (8). The matcher is tuned for authored conclusions and therefore also flags
ordinary quoted journalism such as “Here's everything you need to know” and “…but must increase
prices.” The rejected ingress-redaction option would have reduced flagged sources only from 142 to
64, never to zero, because it preserved titles verbatim and did not reach SEC extended-evidence
snippets.

## Consequences

- Persisted research remains auditable and separated from execution.
- Reverse-DCF output remains an isolated, removable input-sensitivity artifact.
- Run Chat requires a separate safety and threat model; ephemerality is not equivalent to the
  persisted research-only policy.
- Expanding trade-oriented behavior beyond Run Chat requires a new ADR.

## Implementation validation

- `src/report/schema.ts` and research prompts reject trade-action language in reports.
- `src/history/artifacts.ts` validates narrative thesis deltas before persistence.
- `prompts/console-run-chat.md` implements the explicit chat exception.
- `src/research/source-text-audit.ts` performs the warn-only source-text scan, surfaced as aggregate
  `analytics.json:sourceTextResearchOnly` and per-field detail in `trace.json`, for both the equity
  `buildRunTrace` path and alpha-search in `src/alpha-search/workflow.ts`.
- Reverse-DCF rendering tests assert the disclosed assumptions and solved-growth grid structure,
  and semantically reject price, comparison, gap, and verdict output.
