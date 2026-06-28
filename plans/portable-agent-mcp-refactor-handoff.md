# Portable Agent/MCP Refactor — Refined Plan

> **Status: v1 complete, plus v1.1 subject-broadening and a run-config module split.** All v1 slices
> (A–G) shipped on `feat/web-gather-slice-a`; crypto + research web-gather and the `src/config/runs/`
> module split / capability registry landed afterward.
> This document serves as a record of the decisions made and the deferred work remaining.

## Context

The original handoff proposed a from-scratch `ToolRegistry`, a central `company_profile.v1`
artifact, a parallel "web gather" layer, MCP client support, an Agent Skills migration, and an
in-bot subagent abstraction.

Grounding the plan in the actual code showed most of that architecture **already exists**:

| Originally proposed | Already in repo |
|---|---|
| ToolRegistry + request/result + execution loop | `src/research/json-tool-loop.ts` (`runJsonToolLoop`) — generic, provider-neutral, budget/audit/gap/merge semantics |
| "Web gather loop" coordinator | `src/research/evidence-request-loop.ts` — model→JSON→validate→execute→normalize→cite, for `equity --deep` |
| Tool adapters | `src/sources/evidence-request-tools.ts` — tool name → executor → `{rawSnapshots, sources, items, gaps}` |
| `company_profile.v1` (business questions) | `src/sources/extended-evidence/business-framework.ts` — Business/Phase/Moat/Growth/Management/Risk/Valuation, persists `normalized/business-framework.json` |
| Raw cache / source IDs / sidecars / artifact reader | all exist (`src/sources/cache.ts`, `src/run-artifacts.ts`) |

The genuinely-new, valuable capability is **live web research that produces cited Sources**. Today
the only web search is codex-native *ephemeral* chat context (ADR 0032), explicitly **not** a
Source. So this work adds an **Exa-backed web evidence path** that reuses every existing seam,
rather than building a second architecture beside it.

**Intended outcome:** on a deep run (`equity`/`crypto`/`research --deep`), the model can request bounded
Exa web searches/fetches; results are cached, cited as low-trust Sources, and normalized into a
deterministic `web-subject-profile` sidecar answering the subject-specific business-model questions that
SEC/Yahoo numeric facts structurally cannot (11 for a company: 7 legacy + management track record,
capital allocation, KPIs, risk factors; distinct question sets for crypto-asset and theme subjects).

## Non-negotiables (unchanged)

- Research-only boundary (ADR 0001): no buy/sell/hold, sizing, execution, portfolio actions.
- No raw MCP pass-through; curated allowlist only.
- No secrets in repo/config/cache/fixtures/artifacts; external API/MCP credentials env-var only.
- Bun + oxc only (ADR 0003); no Node/Prettier/ESLint/Biome.
- Tests in the same change as code; update `docs/configuration.md` for every new env var.
- Definition of done: `bun run check`.

## Locked decisions (from the grilling session)

1. **No parallel ToolRegistry.** Build on `runJsonToolLoop`; add a sibling coordinator next to
   `evidence-request-loop.ts`. `evidence-request-loop.ts` remains the SEC/Tradier coordinator.
2. **Web facts get their own home.** New `web-subject-profile` ExtendedEvidence item + sidecar with
   untrusted-web Sources. `business-framework.ts` stays **100% deterministic** (postures from
   SEC/Yahoo only) and is **not** modified to ingest web facts. It may cross-reference the profile,
   nothing more. *(Corrects the "extend business-framework to absorb facts" instinct, which would
   have eroded the determinism invariant.)*
3. **Trigger = always-on, reuse-gated.** Runs on every deep run whose run type sets `supportsWebGather`
   (equity, crypto, research) unless a fresh same-subject profile can be reused; bounded by budgets +
   kill switch + reuse skip. *("Gap-triggered" was a
   fiction — Business Framework's qualitative gaps (segment mix, customer concentration, purchase
   recurrence, management track record) are permanently unfillable from numeric sources, so a gap
   test is always true.)*
4. **MCP deferred to slice 2.** v1 ships web tools only. There is no MCP client in the repo;
   building one is the largest net-new subsystem and is not needed for company web research.
5. **Provider = Exa.** Workhorse `web_search` (search-with-content). `web_fetch` supported as a
   fallback for thin results, **constrained to URLs already surfaced by a `web_search` this run**
   (SSRF + on-subject guard).
6. **Defense-in-depth containment.** `web_search` queries must reference the run subject; web
   Sources tagged a distinct low-trust kind and capped in Evidence Quality; web content never alters
   run scope or prediction subjects. Fetched web content is **prompt-instructed** to be treated as
   untrusted data, never as instructions (`prompts/web-gather/base.md`). *(This is a prompt-level
   boundary at the gather stage only — structural instruction-stripping, and equivalent hardening of
   the profile-extraction and synthesis prompts, are deferred to D3.
   Do not read this as enforced containment.)*
7. **Reuse freshness = time-TTL + filing-aware (company only).** Reuse only if within
   `WEB_PROFILE_REUSE_DAYS` (~30d) AND no newer SEC 10-K/10-Q since the profile was built; else
   regather. Reuse age disclosed as a freshness gap. *(Reuse is the only real cost control under an
   always-on trigger.)* **Known limitation:** filing-aware invalidation is gated on
   `subjectKind === "company"`; crypto-asset and theme reuse fall back to **pure time-TTL** with no
   filing/news anchor, so a fast-moving subject can reuse a stale profile inside the 30-day window
   (disclosed only via the generic reuse-age gap). A per-`subjectKind` TTL or news-recency anchor is a
   logged follow-up (see D3).
8. **Skills-format migration and subagent/run-profile abstraction deferred** (speculative; overlap
   `config/runs.ts` + playbooks).

### Prior approved decisions that still stand (mechanism reframed)

Core-engine-first (market-bot owns runtime); curated MCP allowlist (no raw pass-through);
Claude-style `.mcp.json` import stays inert until mapped; future MCPs config-only when they fit an
existing shape; production specialization stays provider-neutral and inside market-bot; LLM-directed
fresh web search/fetch on demand; deep-equity auto trigger; `.agents/skills/*/SKILL.md` as the
portable guidance format; same-subject normalized reuse (no global store); env-vars-only secrets;
thin repo skills first; `research/research-skill.md`'s business questions shape the profile.

## What shipped (v1)

All seven slices landed in a single feature branch (`feat/web-gather-slice-a`):

- **Types & config (A):** `WebGatherToolName`, `Source.kind: "web"`, `SubjectKind`
  (`"company" | "crypto-asset" | "theme"`), `ExtendedEvidenceItem` category `"web-subject-profile"`,
  config keys `webGatherOptions`, `exaApiKey`, `webGatherDisabled`, `webProfileReuseDays`.
- **Exa tool executor (B):** `src/sources/web-gather-tools.ts` — cached Exa calls, stable Source IDs
  (`web-<subject>-<sha8(url)>`), `web_fetch` URL-allowlisted to prior `web_search` results, missing
  key → `missing-credential` gap.
- **Coordinator (C):** `src/research/web-gather-loop.ts` — sibling to `evidence-request-loop.ts`,
  own budget, on-subject query containment, `prompts/web-gather/base.md`.
- **Profile extraction (D):** `src/sources/extended-evidence/web-subject-profile.ts` — zod-validated
  subject-specific profile (11 company questions; distinct crypto-asset / theme shapes) with cited
  fact ledger; uncited facts rejected.
- **Reuse (E):** `src/research/web-subject-profile-reuse.ts` — time-TTL + filing-aware (company-only)
  freshness check via `run-artifacts.ts`.
- **Orchestrator wiring (F):** runs after evidence-request loop on deep runs; persists
  `web-subject-profile.json` + `web-gather-audit.json`; renders in report + Research Console.
- **Docs & ADR (G):** `docs/configuration.md`, `.env.example`, `CONTEXT.md` glossary,
  ADR 0034 (web-gathered evidence as cited sources).

## What shipped (v1.1 — subject broadening + run-config split)

Landed after the original v1 record:

- **Subject broadening:** `web-gather` is now live for **crypto** (`subjectKind: "crypto-asset"`) and
  **research/theme** (`subjectKind: "theme"`) runs, each with its own profile question set.
  `RUN_TYPE_REGISTRY` (`src/domain/run-types.ts`) sets `supportsWebGather: true` for equity, crypto,
  and research; only **market-overview** remains unwired. *(This was originally listed under D4 as
  deferred.)*
- **Run-config module split:** `config/runs.ts` was split into `src/config/runs/`
  (`types.ts`, `resolver.ts`, `profiles/*`) and run-type capability/eligibility now derives from the
  `RUN_TYPE_REGISTRY` capability registry.

---

## Deferred tasks (explicitly out of v1)

These were considered and deliberately pushed to later slices. Each is independent and reversible.

### D1. MCP support (slice 2)
- Build the MCP client transport (JSON-RPC over HTTP/SSE), tool discovery, env-var auth.
- `McpServerCatalog`: Claude-style `.mcp.json` server import, env-var names only, **inert** until
  mapped. No auto-enable on names like "news"/"search".
- `McpToolMapping`: explicit server-tool → market-bot capability/result-shape mapping declaring
  shape, cache keys, source rules, allowed run types.
- First mapped tool: **MT Newswires** (`search_news` → `news_search` shape), config-only once the
  shape exists. Future MCPs that fit an existing shape are config-only; new semantics require one new
  shape/normalizer in code.
- Predefined evidence packet shapes to formalize when needed: `news_search.v1`, `document_search.v1`,
  `document_fetch.v1`.

### D2. `.agents/skills` portable-skills migration
- Move `prompts/playbooks/*` guidance to `.agents/skills/*/SKILL.md` as the portable source of truth;
  market-bot imports selected skill instructions into stage prompts. Avoid maintaining duplicate
  Codex/Claude vs market-bot guidance. Deferred as a packaging/refactor with drift risk and no
  functional gain for the research goal.

### D3. `web_fetch` hardening + heavy sanitizer — *top deferred-risk item*
- **Risk note:** web content is currently raw Exa passthrough with **no** structural sanitization, and
  this path is no longer single-path — it is live across **three** run types, including the broad,
  least-anchored `theme`/research path. The only containment is the gather-stage prompt line in
  `prompts/web-gather/base.md` (see decision 6). Prioritize accordingly.
- If/when hardened: generic HTML readability extraction, robots/paywall handling, and a separate
  sanitization pass that strips instruction-like content before the profile-extraction and synthesis
  prompts see it.
- **Carries the freshness follow-up** from decision 7: a per-`subjectKind` `WEB_PROFILE_REUSE_DAYS`
  (shorter for crypto/theme) or a news-recency anchor for non-company subjects.

### D4. Broaden web gather to market-overview + dead-config cleanup
- *(crypto and research/theme broadening already shipped — see "What shipped (v1.1)".)*
- **Remaining run type:** **market-overview** (`supportsWebGather: false` in `RUN_TYPE_REGISTRY`).
- **Dead-config cleanup:** `researchGatherOptions` + `MARKET_BOT_RESEARCH_GATHER_*` remain
  defined-but-ignored (confirmed by `tests/config.test.ts`); research web-gather was wired via
  `webGatherOptions`, leaving this old config orphaned — wire or remove in a small cleanup PR (do not
  silently reuse for the web path).

### D5. Promote web data to scoring Observations
- Not in scope: web-gathered facts stay research-only evidence and never resolve Predictions. Only
  consider if a web quantity becomes publicly resolvable and observable (ADR 0004).

### D6. Cross-subject / global evidence store
- v1 reuse is same-subject only (keyed to `subjectId`). A global cross-subject normalized evidence store is explicitly out of
  scope.
