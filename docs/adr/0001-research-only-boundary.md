# ADR 0001: Research output boundary

## Status

Accepted

## Date

2026-06-30 (consolidated 2026-07-15; amended 2026-07-23; amended 2026-08-09:
attributed third-party source-text boundary; amended 2026-08-26: model-authored report
validation scope)

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

Amendment (2026-08-26): research-only enforcement applies to what market-bot asserts, not to what
its sources say. `src/report/schema.ts:assertSafeReportLanguage` therefore scans model-authored
report prose only — `summary`, `keyFindings`, `bullCase`, `bearCase`, `risks`, `catalysts`,
`scenarios`, and the model-authored fields inside mixed extras. Collector-derived and deterministic
assembly text is outside report validation:

- Attributed third-party `report.sources[].title`, `summary`, and `snippet`, the source titles
  rendered by `src/report/markdown-primitives.ts:renderSources`, and the source-labelled search
  entries built by `src/report-search-entries.ts:sourceCandidates`.
- `report.extendedEvidence[].title` and `.summary`, which carry collector-derived filing and news
  text.
- The deterministic `researchQualityDriver` (`src/research/quality-driver.ts`).
- `extras.historicalContext` and `extras.catalystCalendar`, both code-built in
  `src/research/report-assembly.ts`; the catalyst labels duplicate `report.catalysts`, which is
  scanned. `historicalContext.items[].text` interpolates a prior run's summary, which is exempt
  because prior-run prose is **external ingress** — it is sanitized through
  `src/research/historical-context-sanitization.ts:24-35` with
  `provider: "historical-artifact"`, exactly like third-party source text. It is _not_ exempt on
  the grounds that it was screened on its own run: the patterns change over time (`6c9c5a2`
  widened them), so an older artifact was never screened by a newer pattern.
- The `gaps` arrays inside `extras`, which hold Source Gap strings emitted by code. This does _not_
  extend to `report.dataGaps`, which merges model-authored `payload.dataGaps` with deterministic gap
  text in `src/research/report-assembly.ts:761`; it is unscanned today and predates this amendment.
  A sweep of 77 `report.json` artifacts found 0 research-only matches across 2,125 `dataGaps`
  entries, so bringing it inside the scan would not reclassify any known run. This is not an inert
  gap: `partitionGapShapedFindings` and `relocateBusinessFrameworkClaims`
  (`src/research/report-assembly.ts:128-188`) _move_ uncited findings and business-framework text
  out of scanned fields into `dataGaps`, so a gap-shaped sentence can carry advice past the screen.
  Closing it is tracked separately.
- `predictions[]` needs no screen: `claim` is rendered from the parsed observable expression
  (`src/forecast/observable-candidates.ts:172`) and `measurableAs` is a parsed DSL expression, not
  free prose. Neither carries model wording the patterns could act on.

The exempt list above is closed. Adding another exempt surface requires an amendment to this
record, not a judgement call at the call site.

Mixed extras are classified per field rather than dropped whole:
`extras.businessFramework.sections[].text` and the three `extras.earningsSetup` bullet arrays are
model-authored and stay scanned, while the collected artifact fields beside them do not;
`extras.spotlights` rationales come from parsed model output and stay scanned;
`extras.webSubjectProfile` prose, projected by
`src/research/extended-evidence-projections.ts:webSubjectProfileExtra`, is model-derived and stays
scanned.

The precipitating evidence is run `2026-08-26T10-22-14-230Z-52aac308`: a deep AMD run failed after
13m44s and ~548k tokens on `"you should"`, a phrase from AMD's own 10-Q risk factors attached during
assembly. All four synthesis drafts were clean, so all three repair reprompts asked the model to
rewrite text it never wrote. Under the previous scope, any issuer whose filings carry
reader-directed risk language could never produce a passing report.

The exemption is only from the research-only screen. Prompt-injection sanitization remains
mandatory through `sanitizeOptionalWebText` and the news-path `sanitizeNewsSource`. Any source
wording copied or synthesized into a model-authored report field remains subject to
`assertSafeReportLanguage`: `src/sources/sec-filing-item.ts:buildSecFilingSourceItem` may put
filing bytes into an exempt `Source.snippet` and an exempt `extendedEvidence[].summary`, but the
same bytes restated in `summary` or `risks` still fail validation.

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
