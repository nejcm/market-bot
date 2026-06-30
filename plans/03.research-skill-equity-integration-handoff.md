# Handoff: Deepen research-skill.md integration into equity runs

**Status:** Plan approved (plan mode exited), no code written yet.
**Date:** 2026-06-29
**Branch:** master (clean at start). Create a feature branch before implementing.

This document is self-contained: it carries the handoff summary, the full approved plan, and
the complete grilling Q&A that produced it. A duplicate of the plan body also lives at
`C:\Users\Nejc\.claude\plans\stress-test-the-plan-to-nifty-quasar.md`.

---

## 1. Handoff summary

**Task origin:** Another agent reviewed how `research/research-skill.md` ("BUSINESS ANALYSIS
v2.1") is integrated into equity runs and listed "covered / partial / missing" items. The user
asked to grill that review and produce a plan for the substance still worth integrating.

**Key reframing from the grilling:** the review's "Missing / not implemented" list conflated
the skill's *cosmetic form* (emoji template, `## Sources` block, interactive "what company?"
trigger, free-Markdown output replacing the schema) with its *analytical substance*. The form
fights ADR 0001 (research-only), the deterministic `ResearchReport` schema, and the CLI-arg
design — so we explicitly **reject the form** and implement **substance only**.

**What's already done in the codebase (do not redo):**
- The skill's 7 questions are transposed into Web Subject Profile v3 company keys plus 4
  extensions (`src/sources/extended-evidence/web-subject-profile.ts`).
- Profile is reported (`renderWebSubjectProfile`, `src/report/markdown.ts:581`) and reconciled
  into the Business Framework (`business-framework-reconcile.ts`).
- Citations enforced; research-only guard runs over profile/framework text; web text sanitized
  (ADR 0040).

**What this plan adds (substance gaps):** 10-K-first sourcing by making SEC filing text a
citeable Source; fetch both latest 10-K and 10-Q; prompt-guided segment/geo % bullets;
pricing-power & cyclicality framework gap codes + reconciliation; SEC-only profile path when
Exa is absent on `equity --deep`; a rendered basis/verification line; and keeping the skill
file as a cited design reference.

**Recommended first implementation steps:** start with the two lowest-risk, self-contained
changes — (5) pricing/cyclicality gap codes + reconcile, and (1) the two-filing SEC fetch —
then (2)/(3) the orchestrator wiring, then (4) prompt + (6) render + (7) provenance. Run
`bun run check` after each. See verification section.

---

## 2. Approved plan (verbatim)

### Context

`research/research-skill.md` codifies a 10-K-first business-analysis protocol (7 questions
+ structured segment/geo % bullets + a verification statement + plain-English rule). Its 7
questions are already transposed into the **Web Subject Profile v3** company question set,
reported, and reconciled into the Business Framework. But three substantive parts of the
protocol are not honored, and the review conflated them with the skill's *cosmetic form*
(emoji template, interactive trigger, replacing the `ResearchReport` schema). We are **not**
adopting the form — that fights ADR 0001 (research-only), the deterministic schema, and the
CLI-arg design. We **are** closing the analytical substance gaps, all within the existing
deterministic + cited-source architecture.

Decisions locked via grilling:

1. **Substance only** — keep schema/CLI/research-only boundary; ignore emoji template + interactive trigger.
2. **Make SEC filing text a first-class citeable Source** for the company profile (10-K-first sourcing).
3. **Segment/geo % bullets** = prompt-guided cited bullets, **no schema change** (scope discipline).
4. **Pricing power & cyclicality** = add framework gap codes + reconcile from profile (existing pattern).
5. **Fetch both latest 10-K and latest 10-Q** as citeable Sources + render a basis/verification line.
6. **SEC-only company profile when Exa is absent**, on `equity --deep` US listings.
7. **Keep `research/research-skill.md` as a cited design reference** (record provenance; don't wire form/playbook).

### Key facts grounded in code

- Profile generation is a **separate orchestrator stage** (`runWebSubjectProfileExtraction`,
  `src/research/orchestrator.ts:395`), called after the web-gather loop — not inside it. It
  filters `collectedSources.extendedSources` to `kind === "web"` and bails when empty
  (`orchestrator.ts:399`).
- The whole reuse → web-gather → profile → reconcile sequence is wrapped in a single
  `if (isWebGatherLoopEnabled(...))` (`orchestrator.ts:571-618`). `isWebGatherLoopEnabled`
  requires `depth === "deep"` + Exa key + budgets (`web-gather-loop.ts:232`).
- The profile validator `readAnswer` (`web-subject-profile.ts:384`) only checks that answer
  `sourceIds` are members of the **passed-in source set** (`webSources` param) — it is
  source-kind-agnostic, so it generalizes to SEC sources for free.
- `sec_latest_filing` (`evidence-request-tools.ts:209`) fetches the **single latest** periodic
  form (`selectLatestPeriodicFiling`, sorted by filingDate) and emits one `Source`
  (`id: extended-sec-edgar-{sym}-latest-filing`, `kind: "extended-evidence"`,
  `snippet` = Item 7/Item 2 MDA excerpt, ~6000 chars). The `ExtendedEvidenceItem.metrics`
  already carries `form`, `filingDate`, `reportDate`.
- The Business Framework (`business-framework.ts`) has **no** `pricing-power`/`cyclicality`
  gap codes; `PROFILE_GAP_QUESTIONS` (`business-framework-reconcile.ts:15`) maps 7 keys but
  not `pricingPower`/`recessionCyclicality`.
- `renderWebSubjectProfile` (`src/report/markdown.ts:581`); profile prompt is
  `prompts/web-subject-profile/base.md`; research-only guard `violatesResearchOnly` already
  runs over profile/framework text (`src/report/schema.ts:103`).

### Changes

#### 1. SEC filing: fetch both 10-K and 10-Q as citeable Sources
`src/sources/evidence-request-tools.ts`
- Replace `selectLatestPeriodicFiling` (single) with selection of the **latest 10-K** and the
  **latest 10-Q** independently. Fetch both filing texts; emit two `Source`s with distinct ids
  (e.g. `extended-sec-edgar-{sym}-10k`, `extended-sec-edgar-{sym}-10q`), each with the
  form-appropriate MDA excerpt (`secFilingExcerpt`). Emit two `ExtendedEvidenceItem`s (or one
  with both metric sets) so `form`/`filingDate`/`reportDate` are available per form.
- When the current-year 10-Q is missing, still return the 10-K and add a disclosure
  `SourceGap` (matches skill Step 2). Update `EVIDENCE_REQUEST_TOOL_UNITS.sec_latest_filing`
  cost to reflect the second fetch.
- Reuse existing `findSecTicker`, `filingUrl`, `normalizeFilingText`, `secFilingExcerpt`,
  `secIdentity`, `truncateText`.

#### 2. Profile reads SEC filing text as an allowed citeable source
`src/research/orchestrator.ts` (`runWebSubjectProfileExtraction`, ~395)
- For company subjects, build the allowed-source set = web sources **+** the SEC filing
  Sources from `collectedSources.extendedSources` (kind `extended-evidence`, provider
  `sec-edgar`). Pass that set as `webSources` to `buildWebSubjectProfileEvidence`. Change the
  bail condition from "no web sources" to "no allowed sources".

`src/research/research-context.ts` (~221-226)
- For the `web-subject-profile` stage, include the SEC filing Sources' model-visible text
  (`snippet`) in `evidence.webSources` so the model can cite them. SEC text is high-trust
  primary (normalized via `normalizeFilingText`, not the web sanitizer) — keep the existing
  "treat *web* content as untrusted" framing for genuine web sources.

#### 3. SEC-only company profile when Exa is absent (equity --deep, US listing)
`src/research/orchestrator.ts` (~571-618)
- Add a predicate `shouldRunCompanyProfile` = `isWebGatherLoopEnabled(...)` **OR**
  (equity + `depth === "deep"` + US listing + ≥1 SEC filing Source present).
- Restructure so that when Exa/web-gather is disabled but the SEC condition holds, we **skip**
  the web-gather loop but still run `runWebSubjectProfileExtraction` (over SEC sources) and
  `reconcileBusinessFrameworkEvidence`. When Exa is present, behavior is unchanged (web +
  SEC sources both allowed).
- **Verify** the evidence-request loop (`sec_latest_filing`) runs on `--deep` independent of
  Exa so SEC sources exist on the no-Exa path (`availableEvidenceRequestTools`,
  `evidence-request-tools.ts:60`; evidence loop in `orchestrator.ts:~545-563`).

#### 4. Prompt: SEC-first sourcing, % bullets, plain-English
`prompts/web-subject-profile/base.md`
- Company subjects: instruct to **prioritize 10-K (Item 7 MDA) and 10-Q (Item 2 MDA) filing
  text** for the 7 questions, citing filing sourceIds first; use web sources to enrich, not
  replace. Keep "do not infer analyst consensus".
- Format `howItMakesMoney` as cited bullets `[segment]: $X (Y% of revenue)` and `geography`
  as `[region]: Z% of revenue` **where the filing discloses them**; fall back to cited prose
  otherwise. No JSON-shape change.
- Add plain-English rule ("smart 8th grader, no jargon").
- Add provenance comment pointing to `research/research-skill.md` as the design basis (decision 7).

#### 5. Pricing power & cyclicality get a deterministic home
`src/sources/extended-evidence/business-framework.ts`
- Add `"pricing-power"` and `"cyclicality"` to `BusinessFrameworkGapCode` and `QUALITATIVE_GAPS`.
- Attach `pricing-power` to the **Moat** section gaps and `cyclicality` to the **Risk** section gaps.

`src/sources/extended-evidence/business-framework-reconcile.ts`
- Extend `PROFILE_GAP_QUESTIONS` with `{ code: "pricing-power", question: "pricingPower" }`
  and `{ code: "cyclicality", question: "recessionCyclicality" }`. Cited answers now clear
  them, exactly like the existing 7.

#### 6. Render the basis/verification line
`src/report/markdown.ts` (`renderWebSubjectProfile`, ~581)
- For company profiles, render a `Basis:` line from the SEC filing items' metrics, e.g.
  `Basis: 10-K filed 2025-02-01 (FY 2024); 10-Q for period 2025-03-31`, plus the
  current-year-10-Q-unavailable disclosure when applicable. Source the dates from the SEC
  `ExtendedEvidenceItem.metrics` / `secFilingBasisDate`; extend the artifact's basis carrier
  only if needed to hold both forms.

#### 7. Skill file provenance (no form/playbook wiring)
- Leave `research/research-skill.md` in place; add the provenance reference from the prompt
  (change 4) and a one-line note in `CONTEXT.md` (or a short ADR) that its 7 questions +
  SEC-first protocol are the design basis for the company Web Subject Profile. Do **not** add
  it to `prompts/playbooks/registry.json`.

### Out of scope (explicitly rejected)
Emoji output template, standalone `## Sources` block, interactive "what company?" trigger,
replacing the `ResearchReport` schema, structured `revenueBreakdown[]`/`geoBreakdown[]` schema
arrays, deterministic XBRL segment extraction, deterministic pricing/cyclicality proxy metrics,
and brief-run profile coverage.

### Verification
- `bun run check` (lint + fmt:check + typecheck + test) must pass; add tests in the same change.
- New/updated tests:
  - `tests/web-subject-profile.test.ts` — answers may cite SEC filing sourceIds; both 10-K and 10-Q sources accepted.
  - `tests/business-framework-reconcile-wiring.test.ts` (+ reconcile unit tests) — `pricing-power`/`cyclicality` gaps present then cleared by cited `pricingPower`/`recessionCyclicality`.
  - evidence-request-tools tests — two filings fetched; missing-10-Q disclosure gap.
  - orchestrator test — SEC-only profile path runs when Exa disabled on `equity --deep`.
  - `tests/report.test.ts` — basis line renders; research-only guard still passes.
- Manual end-to-end: run an `equity --deep` US name (e.g. `AAPL`) **with** and **without**
  `MARKET_BOT_EXA_API_KEY` set; confirm (a) a Web Subject Profile is produced in both cases,
  (b) the 7 answers cite SEC filing sources, (c) the Basis line shows the 10-K + 10-Q used,
  (d) Business Framework `pricing-power`/`cyclicality` gaps are cleared via reconciliation.

---

## 3. Grilling Q&A (full transcript of decisions)

Each question was asked with a recommended option (marked "Recommended"); the user's selection
is recorded under **Answer**.

**Q1 — Goal.** The review's "Missing" list mixes the skill's cosmetic FORM (emoji template,
standalone Sources block, interactive "what company?" trigger, replacing the ResearchReport
schema with free Markdown) vs its analytical SUBSTANCE (10-K-first sourcing, segment/geo %
bullets, pricing-power & recession-cyclicality as first-class deterministic fields). Which is
the actual goal?
- **Answer: Substance only (Recommended).** Close analytical gaps while keeping the
  deterministic ResearchReport schema, CLI args, and research-only boundary. Ignore the emoji
  template and interactive trigger as incompatible with the codebase.

**Q2 — 10-K sourcing.** The skill's core guardrail is "always prioritize the company's own
10-K wording first." Today the Web Subject Profile can only cite Exa web pages; SEC 10-K/10-Q
MDA text lives in the separate synthesis-time evidence-request loop and isn't citeable by the
7 answers. How far to honor 10-K-first sourcing?
- **Answer: Make SEC filing text a citeable Source (Recommended).** Surface the SEC 10-K/10-Q
  MDA excerpt as a first-class Source inside the profile's allowed-source set so the model can
  (and is told to) cite filing wording before Exa pages.

**Q3 — Segment/geo %.** The skill mandates `$XXB (XX% of revenue)` / `XX% of revenue` bullets.
howItMakesMoney/geography are free-form cited prose today; XBRL company facts don't expose
clean segment/geo mix (it's in 10-K footnote text). How to handle the bullet format?
- **Answer: Prompt-guided bullets, no schema change (Recommended).** Instruct the prompt to
  format cited bullets with $ and % where the filing discloses them, prose otherwise. Avoids a
  fragile schema/validator; respects scope discipline (non-negotiable #5).

**Q4 — Pricing/cyclicality.** pricingPower and recessionCyclicality have NO Business Framework
gap code (unlike the other 7 which reconcile via PROFILE_GAP_QUESTIONS), so a cited answer
never fills anything deterministic. How to give them a home?
- **Answer: Add gap codes + reconcile from profile (Recommended).** Add `pricing-power` and
  `cyclicality` to BusinessFrameworkGapCode/QUALITATIVE_GAPS, attach to Moat (pricing) and Risk
  (cyclicality), extend PROFILE_GAP_QUESTIONS so cited answers clear them. No fragile new metrics.

**Q5 — 10-K + 10-Q.** Step 2 wants BOTH the latest 10-K and the current-year 10-Q plus a
verification line; today only the single most recent periodic form is fetched. How far to go?
- **Answer: Fetch both forms + render basis line (Recommended).** Extend the SEC fetch to
  return latest 10-K AND latest 10-Q as two citeable Sources, and render a basis/verification
  line driven from existing filing metrics.

**Q6 — Gating.** The entire profile runs only when isWebGatherLoopEnabled (equity --deep + Exa
key + budgets). No Exa / brief / non-US ⇒ no profile. Since the skill is 10-K-driven, should
the company profile be able to run from SEC text alone?
- **Answer: SEC-only profile when Exa absent, on --deep (Recommended).** On equity --deep US
  listings, run the company profile from SEC 10-K/10-Q Sources even when Exa is unavailable.
  Web/Exa still enriches when present. (Explicitly NOT extended to brief runs.)

**Q7 — Skill file.** `research/research-skill.md` is an orphan (not in prompts/, not in the
playbook registry, referenced only by a handoff doc). What happens to it?
- **Answer: Keep as cited design reference (Recommended).** Leave it as a non-loaded reference
  but cite it from the profile prompt and/or an ADR/CONTEXT note documenting that its 7
  questions + SEC-first protocol are the basis for the company profile.

---

## 4. Files in play (quick map)

| Concern | File |
| --- | --- |
| SEC filing fetch (two forms) | `src/sources/evidence-request-tools.ts` |
| Profile stage + gating + SEC-only path | `src/research/orchestrator.ts` (~395, ~571-618) |
| Model-visible source payload for profile stage | `src/research/research-context.ts` (~221) |
| Profile artifact / validator | `src/sources/extended-evidence/web-subject-profile.ts` |
| Framework gap codes / sections | `src/sources/extended-evidence/business-framework.ts` |
| Reconciliation mapping | `src/sources/extended-evidence/business-framework-reconcile.ts` |
| Profile prompt | `prompts/web-subject-profile/base.md` |
| Report render (basis line) | `src/report/markdown.ts` (~581) |
| Schema / research-only guard | `src/report/schema.ts` (313, 466, 103) |
| Skill provenance | `research/research-skill.md`, `CONTEXT.md` (or new ADR) |

Project guardrails (from AGENTS.md): research-only (ADR 0001), Bun + oxc only (no
Node/Prettier/ESLint/Biome, ADR 0003), no secrets, scope discipline, `bun run check` is the
definition of done, update `docs/configuration.md` if any env var is added (none planned here).

---

## 5. Suggested skills for the next session

- **implement-plan** — execute the approved plan phase by phase (the plan above is the source
  of truth; work the changes in the recommended order).
- **format-then-lint** / **code-quality** — run after edits; project uses `bun run check`
  (oxc), not Prettier/ESLint.
- **requesting-code-review** or **/code-review** — before merging, to verify correctness and
  reuse/simplification, especially around the orchestrator gating restructure.
- **git-workflow** / **commit-all** — branch off master first; commit when the user asks.

Do NOT invoke `equity-research:*` / `financial-analysis:*` skills — those are unrelated
spreadsheet/deck workflows, not this codebase's research pipeline.
