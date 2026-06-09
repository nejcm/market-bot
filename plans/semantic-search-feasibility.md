# Feasibility: Semantic / Vector Search over Historical Artifacts

> Status: **Exploration / scoping only** — no decision taken, no code written.
> Date: 2026-06-09. Author: scoping session (human + agent).
> Next concrete artifact if pursued: a new ADR (next number is **0018**) superseding the
> "never embeddings" clause in [CONTEXT.md](../CONTEXT.md).

## Question

Is it feasible and worthwhile to use semantic/vector search across historical run artifacts,
and where would it actually help — for runs (prompt-time context) or other surfaces?

## TL;DR

- **Feasible:** yes, and it slots cleanly into the existing derived-artifact pattern
  (`data/history/`, rebuilt by `history rebuild`) without a database.
- **Worthwhile:** only for **one** use case — conceptual *cross-run thesis recall* as an
  **additive, audited** relevance signal in prompt-time selection. The other cases (fuzzy
  user search, dedup) are nice-to-haves that do not justify the dependency cost alone.
- **Blocking constraint:** it revises a documented architectural boundary (CONTEXT.md
  explicitly excludes embeddings) and collides with the no-network / no-key property of the
  history tools and the Bun + oxc-only discipline ([ADR 0003](../docs/adr/0003-oxc-toolchain.md)).
- **Decision taken in this session:** embedding source = **provider API** (OpenAI family),
  decoupled from `MARKET_BOT_PROVIDER`, gated as a capability that degrades to a soft
  Historical Context Gap when unavailable.

## Where we are today (baseline)

Two distinct retrieval mechanisms exist; **neither is semantic**.

1. **Prompt-time selection** — `src/research/historical-context.ts` decides *which prior runs*
   feed a run's prompt. Structured and explainable: relevance reasons `same-symbol`,
   `spotlight-symbol`, `same-cadence`, `cross-cadence`, plus recency, with an audit block
   recording *why* each run was pulled (selection counts, `resolvedMissRunCount`, `gapCount`).
   See [architecture.md](../docs/architecture.md) ("Historical Research Context").

2. **User-facing search** — `searchHistoryIndex` in
   [src/history/artifacts.ts](../src/history/artifacts.ts) (~line 524) is pure substring match:
   `entry.text.toLowerCase().includes(query)`, then structured filters (symbol, assetClass,
   jobType, section, provider, date range).

**The documented boundary.** [CONTEXT.md](../CONTEXT.md) ("Cross-run Intelligence") states it
draws only from curated prior state "...never raw `data/cache`, **embeddings**, or a database."
So adding semantic search is not merely a feature — it reverses a recorded decision. That
reversal is the real subject of this exploration and is what the ADR must own.

## Where semantic search genuinely helps

Filter: it helps only where relevance is **conceptual**, not **lexical or structural**.

### 1. Cross-instrument / cross-regime thematic recall — STRONGEST case
Today a daily equity run pulls priors by shared symbol or shared cadence. It **cannot** pull
"the prior runs where I described a *similar macro regime*" (e.g. rate-cut-anticipation breadth
thinning) across *different* symbols and cadences. Those runs share a **thesis**, not a ticker
or a keyword — exactly what embeddings capture and the current structured reasons cannot.

Payoff: richer prior-miss correction and calibration framing — e.g. "you've been wrong about
melt-up continuation in regimes that looked like this one." This is the only case that does
something the structured reasons fundamentally can't.

### 2. Fuzzy user search — WEAKEST justification
`history search "rate cut fears"` misses a run that said "anticipated FOMC easing" (no shared
substring). Semantic search closes that gap. But for a personal CLI you usually know the
symbol/date, and the structured filters already get you there. Not worth the cost alone.

### 3. Dedup / novelty signal — MINOR
Embeddings could flag a new finding as near-identical to one from N runs ago — an idea-level
analogue of the existing lexical seen-news suppression. Useful, secondary.

## The honest cost side

The architecture is unusually hostile to what embeddings drag in. Weigh these:

- **Determinism.** The codebase repeatedly emphasizes "no model call," deterministic mover
  ranking, deterministic deltas. Embedding similarity injects a nondeterministic,
  model-versioned axis into selection. It must be **additive and audited** (a new relevance
  reason with a score), never a replacement for the explainable structured reasons.
- **Offline / no-dependency property.** `history rebuild`/`search` are currently pure-local —
  no network, no secrets, no Source Provider fetch. Embeddings force a choice (see below).
- **Scale does not justify it yet.** Vector search earns its keep at thousands–millions of
  documents. This bot has at most hundreds of runs. Substring-over-JSON is adequate for
  *speed*; the case for embeddings is purely *relevance quality* (case 1), not performance.
- **Storage is cheap and clean.** One vector per index entry fits the existing
  `data/history/` derived-artifact pattern (rebuildable, gitignored). A flat float array per
  entry + in-process cosine is fine at this scale. **No DB needed.**

## Embedding source — provider asymmetry (decided: provider API)

Embeddings are **not symmetric** across the four providers the way chat is. In the
`src/model/` matrix:

| Provider | Embeddings? | Notes |
| --- | --- | --- |
| **OpenAI** | Yes | First-class endpoint (`text-embedding-3-small`/`-large`), reuses `OPENAI_API_KEY`. Clean path. |
| **OpenAI-compatible** | If the endpoint serves `/embeddings` | vLLM, LM Studio, etc. Gives a self-hosted/offline-ish option via plain HTTP — does **not** violate ADR 0003 (no bundled model). |
| **Anthropic** | No native API | Anthropic guidance points to a third party (Voyage). An Anthropic-provider run cannot embed through its own provider. |
| **Codex exec** | No | Agentic *chat* CLI; no embeddings interface. Helps narrative/synthesis paths, not vector production. |

**Consequence:** embeddings must be a **separate capability** on the provider abstraction, not
a guaranteed peer of `generate()`. Two providers can embed (OpenAI, openai-compatible), two
cannot (Anthropic native, Codex). Treat "embeddings available" as a capability check that
resolves to a soft **Historical Context Gap** when the active provider can't embed — exactly
like the existing `SourceGap` discipline. The structured relevance reasons keep working
unchanged; `semantic-neighbor` simply doesn't light up.

This *strengthens* the additive design: semantic recall becomes an **opportunistic
enrichment** — present on OpenAI-keyed runs, cleanly absent elsewhere, never a hard dependency.

## Recommended design (if pursued)

Shape that respects existing decisions:

1. **Capability, not a peer call.** Embeddings are an OpenAI-family-gated capability on the
   provider abstraction, **decoupled from `MARKET_BOT_PROVIDER`**, with its own env flag
   (an embeddings model + key that may differ from the chat provider).
2. **Derived artifact.** Store embeddings under `data/history/` alongside `index.json`,
   rebuilt by `history rebuild` — never a DB. Matches [ADR 0016](../docs/adr/0016-run-artifact-reader.md)'s
   "derive, don't rewrite."
3. **Additive, audited relevance reason.** Add `semantic-neighbor` (with its cosine score) to
   the existing audit block in `historical-context.ts`. Additive to — never replacing — the
   structured reasons.
4. **Graceful degradation.** When embeddings are unavailable (wrong provider, no key, flag
   off), record a soft **Historical Context Gap**. Offline/no-key path works unchanged.
5. **New ADR.** Supersede the "never embeddings" clause in CONTEXT.md and record the
   determinism / offline / capability-asymmetry trade-offs explicitly. Next number: **0018**.

### Primary target surface
`src/research/historical-context.ts` (prompt-time selection, case 1). The user-facing fuzzy
search in `searchHistoryIndex` is a **secondary**, lower-priority beneficiary.

## Open questions / decisions still needed

- [ ] Embedding model choice (`text-embedding-3-small` vs `-large`) and the cost/quality line.
- [ ] Env var naming for the embeddings model + key (separate from chat provider creds).
- [ ] Similarity threshold + max `semantic-neighbor` count fed into a prompt (budget control).
- [ ] Re-embed policy on `history rebuild` (cache by content hash to avoid re-charging for
      unchanged entries — mirror the existing sha256 cache-key discipline).
- [ ] Whether `semantic-neighbor` priors also become citeable `model` Sources (like the
      existing `history-report-<runId>` sources) or stay selection-only.

## Recommended next step

Draft **ADR 0018** (decision record only, no implementation) weighing the trade-off and
proposing the additive `semantic-neighbor` design, superseding the relevant CONTEXT.md clause.
Optionally follow with a throwaway prototype against real `data/runs/` to confirm relevance
actually improves before committing.
