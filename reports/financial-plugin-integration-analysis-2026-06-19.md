# Financial Plugin Integration Analysis

Date: 2026-06-19

Scope:
- Anthropic `financial-services` repository, cloned to `%TEMP%\market-bot-financial-services-analysis`.
- OpenAI `public-equity-investing` plugin at `C:\Users\Nejc\.codex\plugins\cache\openai-curated-remote\public-equity-investing\0.1.29`.
- Fit against `market-bot` as a research-only Bun + TypeScript CLI with sourced reports, observable forecasts, scoring, calibration, source gaps, and local console.

## Executive Read

Both plugin packages are useful, but they should not be integrated as runtime plugins inside `market-bot`. They are primarily agent/skill prompt systems, while `market-bot` is a typed, auditable research pipeline. The right integration path is to port selected workflow patterns into first-class `market-bot` run types, prompts, source providers, validation rules, and artifacts.

Best ideas to adopt:
- Source-category routing from OpenAI PEI: map each workflow to required evidence categories before fetching.
- Deliverable lanes from OpenAI PEI: separate hero artifacts from support/audit sidecars.
- Source/freeze-time discipline from OpenAI PEI: every time-sensitive market input needs as-of/retrieved-at posture.
- Workflow decomposition from Anthropic: earnings reviewer and market researcher patterns map well to `market-bot` stages.
- Institutional connector catalog from Anthropic: FactSet, Daloopa, LSEG, S&P, Aiera, MT Newswires, Morningstar are useful future provider candidates.
- Excel/model QA principles from both: formulas over hardcodes, source tie-outs, and workbook audit checks can inform future model artifacts.

Do not adopt directly:
- Position sizing, hedge plans, add/trim/exit/cover rules, price targets, ratings, and trade ideas. These conflict with `market-bot` ADR 0001 unless rewritten as neutral research context or observable forecast framing.
- Generic agent autonomy that fetches from arbitrary connectors. `market-bot` should keep provider access behind typed source adapters, cache, gaps, and tests.
- Proprietary OpenAI PEI assets/scripts verbatim. Use as design reference only unless licensing allows reuse.

Highest-priority integration recommendation:
1. Add a source-category planning layer to `market-bot` source collection.
2. Add earnings-focused equity ticker workflows: `earnings-preview` and `earnings-review`, both research-only.
3. Add richer source posture and source ledger rendering: freeze time, as-of date, retrieved-at, provider, confidence, stale/conflict labels.
4. Add PEI-inspired domain playbooks for earnings, valuation context, catalysts, and idea triage.
5. Add optional institutional source providers only through `docs/source-provider-contract.md`.

## Current Market-Bot Fit

Relevant existing strengths:
- `src/sources/providers.ts` already composes provider capabilities by asset class and evidence role.
- `docs/source-provider-contract.md` already forbids trading/account behavior and requires `SourceGap` semantics.
- `src/report/schema.ts` validates research-only language and source IDs.
- `prompts/playbooks/registry.json` already supports selectable guidance by job type, asset class, depth, and stage.
- `src/research/orchestrator.ts` already has staged research, historical context, playbook selection, Evidence Request Loop, Coverage Panel, critique, and final synthesis.
- `src/forecast/observable.ts` and `src/scoring/` already enforce observable forecasts and calibration.
- `app/` already presents artifacts and calibration without changing the research-only boundary.

Main gaps versus the plugins:
- No explicit source-category plan before collection.
- Earnings events are not a first-class workflow surface.
- Catalyst/calendar support is narrow and mostly derived from existing report artifacts.
- Report artifacts are Markdown/JSON-first; OpenAI PEI assumes polished HTML or workbook hero artifacts.
- No workflow-specific source ledger with freeze-time/freshness posture near claims.
- No institutional provider adapters for FactSet, Daloopa, LSEG, S&P, Aiera, MT Newswires, or Morningstar.
- No model/workbook output path, except normal JSON/Markdown run artifacts.

## Plugin 1: Anthropic Financial Services

Source: `https://github.com/anthropics/financial-services`

### Structure

The repository is a marketplace of financial-services plugins and managed-agent templates, not a single narrow plugin.

Major areas:
- `plugins/vertical-plugins/financial-analysis`: core DCF, comps, LBO, 3-statement, Excel audit, deck QC, and connector config.
- `plugins/vertical-plugins/equity-research`: earnings, initiation, model update, morning note, sector overview, thesis tracker, catalyst calendar, idea generation.
- `plugins/agent-plugins/market-researcher`: sector/theme to overview, competitive landscape, comps, and ideas shortlist.
- `plugins/agent-plugins/earnings-reviewer`: earnings event to model update and post-earnings note.
- `plugins/partner-built/lseg`: LSEG data workflows across bonds, swaps, FX, macro, options, and equity research.
- `plugins/partner-built/spglobal`: S&P Global tear sheets, earnings previews, and funding digests.
- `managed-agent-cookbooks`: deployable agent templates with subagent handoff examples.

Approximate inspected package counts:

| Area | Files | Skills | Notes |
|---|---:|---:|---|
| `financial-analysis` | 40 | 13 | Core modeling, Excel, deck, and connector bundle |
| `equity-research` | 31 | 9 | Closest vertical fit for `market-bot` |
| `market-researcher` agent | 9 | 5 | Sector/theme research orchestration |
| `earnings-reviewer` agent | 11 | 6 | Post-earnings workflow orchestration |
| `lseg` partner | 20 | 8 | Data-provider-specific market workflows |
| `spglobal` partner | 16 | 3 | Provider-specific company/earnings workflows |

Repository-level plugin marketplace includes 20 entries: 7 vertical plugins, 10 agent plugins, 2 partner plugins, and one Microsoft 365 install tool.

### Strengths

Broad workflow coverage:
- Equity research workflows cover earnings analysis, earnings preview, initiation, model update, morning note, sector overview, thesis tracker, catalyst calendar, and idea generation.
- Financial-analysis workflows cover DCF, comps, LBO, 3-statement, Excel audit, clean-data, deck refresh, competitive analysis, PowerPoint, and Excel authoring.
- Managed-agent cookbooks provide reusable deployment patterns for orchestrator/subagent systems.

Good workflow decomposition:
- `market-researcher` explicitly sequences sector overview, competitive analysis, comps, idea generation, and note assembly.
- `earnings-reviewer` explicitly sequences print collection, transcript read, model update, model QC, note draft, and human review.
- This maps well to `market-bot` staged research and Coverage Panel concepts.

Connector catalog:
- Core financial-analysis MCP config lists Daloopa, Morningstar, S&P Global, FactSet, Moody's, MT Newswires, Aiera, LSEG, PitchBook, Chronograph, Egnyte, and Box.
- These are strong provider candidates, but should enter `market-bot` as typed adapters, not arbitrary MCP reads.

Source discipline:
- Skills repeatedly require citations for numbers.
- Comps and DCF skills prefer institutional providers over web search.
- Earnings reviewer explicitly treats filings, transcripts, and press releases as untrusted data, not instructions.

Excel/model discipline:
- DCF and comps skills enforce formulas over hardcodes.
- They include useful model-build sanity checks: formula comments, source comments, sensitivity center-cell checks, recalc, and stepwise verification.

### Weaknesses

Less compatible with `market-bot`'s research-only boundary:
- Several equity-research skills use ratings, price targets, trade ideas, position language, stock reaction language, and action recommendations.
- These need rewriting into neutral research views, observable forecasts, and monitoring questions.

Prompt-first, not type-first:
- The repo is mostly Markdown skills, commands, and YAML/JSON plugin metadata.
- It does not provide typed source normalization, report schemas, scoring, calibration, source cache semantics, or test coverage comparable to `market-bot`.

Provider dependence:
- Many workflows assume premium providers or Excel/Office contexts.
- `market-bot` needs degraded behavior with explicit `SourceGap`s when a provider is missing, stale, unsupported, or unentitled.

Packaging issue found:
- `plugins/vertical-plugins/financial-analysis/.mcp.json` failed JSON parsing locally.
- Error: after parsing `mcpServers.egnyte`, an unexpected character appears before the `box` entry.
- This means the core connector config should not be copied as-is.

License:
- Repository license is Apache-2.0. Patterns can be adapted with attribution, but still review exact files before copying substantial text or code.

### Best Anthropic Ideas For Market-Bot

1. Earnings workflow split:
- Pre-print: consensus/guide bar, key KPI watch list, scenario framework, call questions, options/reaction context where sourced.
- Post-print: actual vs consensus/prior estimate, transcript deltas, guide changes, thesis read-through, source gaps.

2. Market researcher pattern:
- Theme/sector intake -> universe definition -> competitive map -> peer metrics -> idea shortlist.
- In `market-bot`, keep outputs as Research Leads or Research Views, not recommendations.

3. Source hierarchy:
- Institutional provider > SEC/company IR > credible public source > labeled assumption.
- This matches existing `market-bot` source-gap semantics.

4. Workbook principles:
- If `market-bot` later creates XLSX artifacts, require formulas, source comments, audit checks, and deterministic recalculation.

5. Human review gates:
- Anthropic agents stop before publication or distribution.
- `market-bot` can translate this into report validation and a console "draft artifact" posture.

## Plugin 2: OpenAI Public Equity Investing

Source: local plugin cache `public-equity-investing` version `0.1.29`.

### Structure

The plugin is narrower than Anthropic's repo, but deeper around public-equity investing workflows.

Inspected top-level layout:
- `.codex-plugin/plugin.json`: plugin manifest.
- `.app.json`: connector/app declarations.
- `README.md`: workflow catalog and usage.
- `shared/`: common policies, artifact packaging, deliverable framework, source resolution, dashboard renderer, workbook helpers.
- `skills/`: 23 skills and workflow owners.
- `tests/`: bundled plugin tests.

Approximate inspected counts:

| Area | Files | Notes |
|---|---:|---|
| `skills` | 490 | 23 skills, 320 Markdown files, 87 Python scripts, 22 JSON files, 19 CSV files, 2 XLSX files |
| `shared` | 25 | Shared deliverable/source/artifact/dashboard/workbook policies and scripts |

Skill catalog:
- Router: `public-equity-investing`.
- Company/research: `company-tearsheet`, `initiating-coverage`, `memo-builder`, `meeting-prep`.
- Earnings: `earnings-preview`, `earnings-deep-dive`.
- Valuation/modeling: `comps-valuation`, `dcf-model-builder`, `three-statement-model-builder`, `equity-model-update`, `financials-normalizer`, `model-audit-tieout`, `scenario-sensitivity-generator`.
- Idea/events/monitoring: `idea-generation`, `event-driven-analyzer`, `economic-impact-report`, `catalyst-calendar`, `thesis-tracker`.
- Portfolio/trade-oriented: `long-short-pitch`, `portfolio-risk-management`.
- Support: `deck-report-qc`, `user-context`.

Declared app/connectors:
- Slack, PitchBook, FactSet, Morningstar, LSEG, S&P, Third Bridge, Daloopa, Quartr, Alpaca, Google Drive, Gmail, Outlook Email, SharePoint, Microsoft Teams.

### Strengths

Strong invocation gate:
- `shared/invocation-policy.md` activates only on explicit Public Equity Investing invocation or unmistakable listed-equity investor work.
- It avoids generic company research auto-routing.
- This is directly useful for adding new `market-bot` workflows without over-triggering them.

Clear source categories:
- `company_filings_ir`
- `earnings_transcripts_presentations`
- `internal_research`
- `portfolio_models_trackers`
- `market_data_estimates`

These categories are more useful than provider names during workflow design. They let a workflow declare what it needs while source adapters decide how to satisfy it.

Strong source-resolution discipline:
- Prefer user-named source, then active saved route, then smallest useful native read.
- Do not inspect unrelated source categories.
- Treat connector declarations as not proof of availability or entitlement.
- Continue from prompt context, uploaded/exported material, or public sources when possible.

Strong deliverable model:
- Shared `final-deliverable-framework.md` separates hero artifact lanes from support/audit files.
- Default hero artifacts are polished HTML reports or XLSX workbooks, with JSON/CSV/Markdown as support files.
- The framework requires point-of-use citation visibility and source ledgers.

Good public-equity workflow boundaries:
- Many skills include "do not use" sections that separate tearsheets, earnings, memos, models, catalysts, event underwriting, and risk workflows.
- Workflow owners delegate support work without losing ownership of final synthesis.

Deterministic support scripts:
- Many skills include Python validators/materializers for JSON, CSV, XLSX, dashboards, and reports.
- This pattern is compatible with `market-bot`'s existing preference for schema validation and deterministic sidecars.

Better fit to market-bot concepts:
- PEI's source posture, source ledger, freshness, missing evidence, and conflict labeling map naturally to `Source`, `SourceGap`, `EvidenceQuality`, and normalized sidecars.
- PEI's workflow-source categories can sit above `sourceProviders`.
- PEI's catalyst, earnings, and idea-generation workflows map to existing `ticker`, `research`, `alpha-search`, and `extras` concepts.

### Weaknesses

Licensing:
- Manifest license is proprietary. Treat as a design reference unless permission exists.

Too broad for research-only if copied literally:
- `long-short-pitch` and `portfolio-risk-management` include trade expression, sizing, hedge, exit, add/trim/cover, and action thresholds.
- `market-bot` must not output position sizing, execution, portfolio actions, or trade recommendations.

Connector availability is runtime-specific:
- `.app.json` declares connectors, but the plugin's own source-resolution policy says declarations are not proof of callable routes.
- `market-bot` should not assume those connectors exist.

High artifact complexity:
- HTML dashboards, workbook cover standards, source ledgers, support packs, and scripted materializers are valuable but too large to port in one step.
- `market-bot` should first improve report schema and source posture before adding new hero artifact formats.

Python-heavy:
- The plugin uses many Python scripts. `market-bot` is Bun + TypeScript and AGENTS.md says Bun + oxc only for this repo.
- Do not introduce Python runtime dependencies into `market-bot` core. Reimplement small deterministic validators in TypeScript if needed.

### Best OpenAI PEI Ideas For Market-Bot

1. Source-category plan:
- Add workflow-level evidence needs before provider collection.
- Example: earnings preview needs filings/IR, transcripts/events, market data/estimates, news/events, and optionally options context.

2. Source posture:
- Add `asOf`, `retrievedAt`, `period`, `provider`, `freshness`, `basis`, and `confidence` metadata to source-normalized evidence where available.

3. Deliverable lanes:
- Keep `report.json` as the contract.
- Add optional `report.html` later as a hero artifact.
- Keep `normalized/*.json`, CSV exports, and logs as support artifacts.

4. Workflow-specific "do not use" boundaries:
- Encode in prompt playbooks and validation.
- Prevent earnings preview from turning into post-earnings review, and prevent idea triage from turning into recommendations.

5. Catalyst and thesis tracking:
- Useful, but phrase as "research monitoring" and "evidence status", not action instructions.

6. Deterministic payload validators:
- Use TypeScript schema validators before rendering any new workflow artifact.

## Side-By-Side Fit

| Dimension | Anthropic Financial Services | OpenAI PEI | Market-Bot Fit |
|---|---|---|---|
| Scope | Broad FSI marketplace | Focused public-equity workflow suite | PEI is closer domain fit |
| Architecture | Prompt/skill/agent plugins | Router plus workflow skills and shared policies | Both need translation into typed pipeline |
| Connectors | Large MCP catalog | App connector declarations plus source categories | Use as provider candidate list only |
| Evidence discipline | Strong citations and provider preference | Strong source posture and lazy resolution | PEI source categories are most portable |
| Deliverables | Docs, decks, Excel, notes | HTML reports, dashboards, XLSX, support packs | Start with JSON/Markdown, later HTML |
| Testing/schema | Limited from inspected files | Many deterministic support scripts | Market-bot should keep TypeScript tests |
| Research-only compatibility | Mixed | Mixed but better gated | Must rewrite trade language |
| Licensing | Apache-2.0 | Proprietary manifest | Anthropic easier to reuse directly |
| Immediate value | Workflow decomposition, provider catalog | Source planning, deliverable framework | Combine both selectively |

## Recommended Market-Bot Integration Architecture

Do not load either plugin at runtime. Instead, add a `market-bot` native "workflow profile" layer:

```text
CLI command
  -> ResearchCommand
  -> WorkflowProfile
      -> source category needs
      -> prompt playbook candidates
      -> report extras allowed
      -> forecast policy
      -> source freshness rules
  -> collectSources via typed adapters
  -> orchestrator stages
  -> report.json validation
  -> optional hero renderer
  -> score/calibration where forecasts exist
```

Candidate TypeScript shape:

```ts
type SourceCategory =
  | "company_filings_ir"
  | "earnings_transcripts_presentations"
  | "market_data_estimates"
  | "news_events"
  | "macro_sector_context"
  | "options_volatility"
  | "historical_artifacts";

interface WorkflowProfile {
  readonly id: string;
  readonly jobType: "ticker" | "research" | "alpha-search" | "earnings-preview" | "earnings-review";
  readonly assetClass: "equity" | "crypto";
  readonly sourceCategories: readonly SourceCategory[];
  readonly playbookIds: readonly string[];
  readonly allowPredictions: boolean;
  readonly allowedExtras: readonly string[];
}
```

This should live near run configuration, not in provider modules:
- `src/config/runs.ts` or a new `src/research/workflow-profiles.ts`.
- Tests should verify profile selection, provider category mapping, and source-gap behavior.

## Proposed New Workflows

### 1. Earnings Preview

Purpose:
- Pre-earnings research setup for an equity ticker.
- No recommendation, no trade setup, no position language.

Inputs:
- `symbol`
- `assetClass=equity`
- fiscal period if user provides it
- optional `--deep`

Needed source categories:
- company filings/IR
- earnings transcripts/presentations
- market data/estimates
- news/events
- options volatility if configured
- historical artifacts

Output:
- Research View with `jobType: "earnings-preview"` or `jobType: "ticker"` plus `extras.earningsPreview`.
- Sections: setup summary, consensus/guide bar, KPI watch list, prior-quarter baseline, source-backed scenarios, call questions, evidence gaps.
- Optional forecasts only if observable from current providers. Price/volatility forecasts are possible; revenue/EPS forecasts need an earnings-data Observation provider first.

Do not include:
- expected stock reaction as advice
- trade direction
- sizing or hedging
- price target/rating

### 2. Earnings Review

Purpose:
- Post-earnings analysis after results/transcript.

Needed source categories:
- reported actuals
- SEC filing or earnings release
- transcript
- market data/estimates
- historical artifacts

Output:
- Actual vs prior/consensus variance table where source-backed.
- Guidance changes.
- Transcript deltas.
- Thesis read-through framed as research evidence.
- Observable forecasts only if supported.

Fit:
- This is the best Anthropic `earnings-reviewer` pattern to port.
- Keep model update and note draft concepts, but omit ratings/target/recommendation language.

### 3. Company Tearsheet

Purpose:
- Source-backed issuer baseline for ticker runs and Research Console.

Output:
- `normalized/company-tearsheet.json` and a rendered section in `report.md` or future `report.html`.
- Business profile, segments, leadership, recent events, valuation context, capital structure, key KPIs, source gaps.

Fit:
- OpenAI PEI `company-tearsheet` maps cleanly to `ExtendedEvidence`.
- Best implemented as a normalized sidecar first, not a separate CLI.

### 4. Catalyst Calendar V2

Purpose:
- Expand existing catalyst extras with provider-backed events.

Sources:
- Finnhub events
- SEC filing calendar
- earnings calendar provider
- FRED release calendar for macro-linked market overview
- prior prediction resolution dates from artifacts

Output:
- `extras.catalystCalendar` with dated events, source IDs, source status, and research relevance.

Constraints:
- No "position ahead of event" language.
- Event paths can become observable forecasts only when resolution data exists.

### 5. Idea Triage

Purpose:
- Improve `alpha-search` and `research <subject>` with PEI/Anthropic screening discipline.

Output:
- Research Leads, rejected candidates, evidence coverage, why each candidate is research-relevant.

Do not include:
- long/short recommendations
- expected return
- conviction
- portfolio fit

## Provider Candidate Roadmap

Use plugin connector catalogs as candidate input, then apply `docs/source-provider-contract.md`.

High value:
- FactSet: consensus, estimates, fundamentals, events.
- Daloopa: normalized public-company financials and KPI history.
- LSEG: market data, estimates, macro, options/rates context.
- S&P Global: tearsheets, company fundamentals, earnings previews.
- Aiera or Quartr: transcripts and event materials.
- MT Newswires: market/news coverage.
- Morningstar: fundamentals and ownership/context.

Lower priority or narrow:
- PitchBook, Third Bridge, Datasite, Hebbia: useful for diligence context, less aligned with public observable forecasts.
- Alpaca: avoid account/order/portfolio endpoints. Market data only, if used at all.
- Slack/Gmail/SharePoint/Teams/Drive: user document context only, not source providers for public market data.

Provider integration rules:
- Add one provider capability at a time.
- Default to report evidence only.
- Promote to scoring Observations only after historical coverage and resolver semantics are tested.
- Preserve source identity and provider IDs, but do not build a central security master yet.
- Every provider failure becomes a typed `SourceGap`.

## Prompt And Playbook Changes

Add playbooks rather than giant new prompts:
- `earnings-preview-discipline.md`
- `earnings-review-discipline.md`
- `source-posture-discipline.md`
- `valuation-context-discipline.md`
- `catalyst-calendar-discipline.md`
- `idea-triage-discipline.md`

Extend `prompts/playbooks/registry.json` with new job types or ticker subworkflows.

Prompt language rules:
- Replace "trade", "position", "add", "trim", "exit", "cover", "hedge", "sizing", "price target", "rating" with research-safe language.
- Use "monitor", "evidence to watch", "forecast", "scenario", "source gap", "observable event", "research lead".
- Keep probabilities tied to `measurableAs`, not analyst conviction.

## Schema And Artifact Changes

Short term:
- Keep current `ResearchReport` schema.
- Add workflow-specific `extras`:
  - `earningsPreview`
  - `earningsReview`
  - `sourcePosture`
  - `companyTearsheet`
  - expanded `catalystCalendar`

Medium term:
- Add source metadata fields when available:
  - `asOf`
  - `retrievedAt`
  - `period`
  - `provider`
  - `basis`
  - `freshness`
  - `confidence`
  - `sourceCategory`

Longer term:
- Add optional `report.html`.
- Keep `report.json` as source of truth.
- Treat HTML as rendered artifact, not schema authority.

## Validation And Tests

Required tests for any implementation:
- Profile selection for each new command/workflow.
- Source-category to provider-capability mapping.
- Missing credential emits expected `SourceGap`.
- Provider failure emits expected `SourceGap`.
- Report validation rejects trade-action language in new extras.
- Forecast validation rejects non-observable earnings claims unless an Observation provider exists.
- Renderer includes source IDs and handles missing optional modules.
- Historical context stays artifact-backed, not raw cache-backed.

Potential test files:
- `tests/workflow-profiles.test.ts`
- `tests/earnings-preview.test.ts`
- `tests/earnings-review.test.ts`
- `tests/source-posture.test.ts`
- `tests/report-extras-validation.test.ts`

## Implementation Plan

### Phase 1: Low-risk prompt/source posture

Deliverables:
- Add workflow profiles without new CLI commands.
- Add `sourceCategory` metadata to source collection internals.
- Add playbooks for source posture and earnings discipline.
- Extend report validation for any new extras.

Why first:
- Low blast radius.
- Improves all existing ticker and research runs.
- Does not require premium providers.

### Phase 2: Earnings Preview MVP

Deliverables:
- Add `earnings-preview <symbol> --asset equity` or `ticker <symbol> --workflow earnings-preview`.
- Use existing Yahoo, SEC, Finnhub events, Tradier IV, FRED, news, and historical artifacts.
- Emit no earnings-metric forecasts until a reliable earnings Observation source exists.

Recommendation:
- Prefer a new job type if artifacts need distinct search/calibration slices.
- Prefer ticker subworkflow if the report schema remains mostly unchanged.

### Phase 3: Earnings Review MVP

Deliverables:
- Add post-print workflow with actuals/guidance/transcript handling.
- Start with user-provided earnings release/transcript or SEC/IR public fetch.
- Add source gaps for missing consensus/transcript/provider coverage.

### Phase 4: Company Tearsheet Sidecar

Deliverables:
- Build deterministic `normalized/company-tearsheet.json`.
- Render compact issuer baseline in ticker reports and console.
- Use SEC/company IR/Yahoo/Massive/Finnhub/FRED where available.

### Phase 5: Catalyst Calendar V2

Deliverables:
- Expand `extras.catalystCalendar`.
- Add provider-backed earnings/filing/event dates.
- Add console calendar surface.

### Phase 6: Provider Expansion

Deliverables:
- Choose one provider with real credentials and narrow capability.
- Implement via `src/sources/`.
- Add source contract tests and provider-health checks.

Suggested first provider:
- Daloopa or FactSet if available for financials/estimates.
- Aiera or Quartr if transcript coverage is the first priority.

## Risks

Research-only drift:
- Biggest risk. Both plugins contain investment-action language.
- Mitigation: validation in `src/report/schema.ts`, prompt wording, and tests over new extras.

Provider sprawl:
- Plugins list many connectors.
- Mitigation: one adapter at a time; report evidence first; Observation promotion later.

Artifact complexity:
- HTML/workbook output can distract from typed research quality.
- Mitigation: keep `report.json` source of truth and add renderers only after schema stability.

Licensing:
- OpenAI PEI is proprietary.
- Mitigation: use concepts, not copied files or scripts.

Runtime mismatch:
- OpenAI PEI uses many Python scripts; market-bot is Bun + TypeScript.
- Mitigation: reimplement only small validators/materializers in TypeScript.

Malformed upstream config:
- Anthropic financial-analysis `.mcp.json` failed JSON parsing.
- Mitigation: never copy upstream manifests without validation.

## Concrete Backlog

P0:
- Add a source-category taxonomy matching PEI categories plus `news_events`, `macro_sector_context`, `options_volatility`, and `historical_artifacts`.
- Add source posture playbook and registry entry.
- Add report-language validation coverage for `extras`.
- Write an ADR or short design note for workflow profiles.

P1:
- Implement earnings preview MVP with existing providers.
- Add `extras.earningsPreview`.
- Add tests for source gaps, forecast constraints, and markdown rendering.

P2:
- Implement company tearsheet sidecar.
- Add console display for issuer baseline and source posture.

P3:
- Implement earnings review MVP.
- Add transcript/source support, initially from user-provided artifacts or public IR/SEC.

P4:
- Add catalyst calendar V2.
- Add provider-backed event dates and console calendar view.

P5:
- Add first institutional provider adapter, gated by credentials and source-provider tests.

## Bottom Line

OpenAI PEI is the better blueprint for `market-bot` workflow architecture. Anthropic financial-services is the better catalog of workflow decomposition, provider candidates, and modeling practices. The integration should be selective:

- Use PEI for source planning, deliverable discipline, and public-equity workflow boundaries.
- Use Anthropic for earnings/market-research workflow sequencing and provider candidate discovery.
- Keep `market-bot` native: typed sources, source gaps, schema validation, observable forecasts, calibration, and research-only enforcement.
