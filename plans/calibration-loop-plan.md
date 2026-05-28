# Calibration Loop Plan

## Context

`market-bot` today produces sourced, research-only daily/weekly/ticker reports via a 3-stage LLM pipeline (specialist → critique → synthesis). ADR 0001 forbids trade actions.

Status: implemented. The current post-calibration focus is source-layer hardening and deeper data before alpha discovery.

Confirmed user framing: **research substrate for the user's own trade decisions** — the bot informs, the user acts.

Under that framing the load-bearing gap was that the report's `confidence` field was a vibe, not a measurement: nothing in the output was falsifiable, so the system could not be evaluated, tuned, or trusted to anchor decisions. That gap is now closed by observable predictions, scoring, and calibration summaries.

This plan closed that loop. The current follow-up priorities are tracked in [IMPROVEMENTS.md](../IMPROVEMENTS.md), starting with source-layer hardening and deeper data.

---

## Scope

### 1. Add falsifiable predictions to the report schema

New field on `ResearchReport` (src/domain/types.ts, src/report/schema.ts):

```ts
readonly predictions: ReadonlyArray<{
  readonly id: string;                      // stable within run
  readonly claim: string;                   // human-readable
  readonly kind: "direction" | "relative" | "volatility" | "range";
  readonly subject: string;                 // e.g. "SPY", "QQQ:SPY", "^VIX", "BTC"
  readonly measurableAs: string;            // machine-resolvable spec (see DSL below)
  readonly horizonTradingDays: number;      // 1..20
  readonly probability: number;             // 0..1, model's stated belief
  readonly sourceIds: readonly string[];
}>;
```

`measurableAs` DSL — four shapes only, parsed by the scorer, not by the LLM:

- `close(SUBJECT, +N) > close(SUBJECT, 0)` — direction
- `close(A, +N) / close(A, 0) > close(B, +N) / close(B, 0)` — relative outperformance
- `max(close(^VIX), 0..+N) > 20` — volatility threshold
- `close(SUBJECT, +N) outside [X, Y]` — range break

Counts per run:

| Job × Depth | Predictions | Subjects |
|---|---|---|
| `daily` brief | 2 | indexes only: SPY, QQQ, ^VIX, BTC |
| `daily --deep` | 3 | indexes only |
| `ticker` brief | 3 | the ticker symbol |
| `ticker --deep` | 5 | the ticker symbol |

Index-only daily predictions keep the daily calibration baseline stable over time (subjects don't churn). Ticker predictions concentrate calibration on what the user actually researches.

**Validator + LLM compliance (drop → repair → ship):**

- Each prediction validated independently. Bad ones (unparseable `measurableAs`, out-of-range `horizonTradingDays`, unknown `kind`, missing fields) silently dropped and logged in the run trace.
- If surviving count is below the depth profile minimum, the synthesis stage is re-prompted **once** with `{ previousErrors, unmetMinimum }` injected.
- If still below minimum, ship the report with whatever survived and add `"predictionShortfall: emitted N of M required"` to `dataGaps`. **Never crash a research run over predictions.**
- `measurableAs` parsed by a small hand-rolled observable-forecast parser (`src/forecast/observable.ts`) — grammar tiny, predictability beats dependency.
- Hedging behaviour (probabilities clustered at 0.5) is NOT a validator error; calibration surfaces it later.

### 1b. Source robustness (minimal)

- Add retry-with-exponential-backoff (3 attempts, 1s/3s/9s) on transient errors (HTTP 5xx, network, `AbortError`) inside `fetchJsonOrGap` (src/sources/collector.ts:84). Non-transient errors fail-fast as today.
- **Scorer must use Yahoo's `v8/finance/chart` endpoint with a date range**, not `v7/finance/quote`, so historical close lookups are deterministic regardless of when the scorer runs. New helper in `src/sources/yahoo.ts`. CoinGecko equivalent: `/coins/{id}/market_chart/range`.

### 2. Scoring subsystem

New module `src/scoring/` + new CLI verb `market-bot score`:

- Walks `data/runs/*/report.json`, finds predictions whose `horizonTradingDays` window has closed and that have no `score.json` yet.
- Re-fetches close prices via the new chart-endpoint helpers at the resolution date.
- Resolves each prediction deterministically against `measurableAs` (via `src/forecast/observable.ts`).
- Writes `data/runs/{id}/score.json` with `{ predictionId, resolved, outcome, observedAt, evidence }`.
- Trading-day horizons are inferred from Yahoo data gaps (no calendar library).
- Failed resolutions retried up to 5 times across subsequent scoring passes before being marked abandoned.
- Idempotent — re-runs are safe.

Reuses: `src/sources/yahoo.ts`, `src/sources/coingecko.ts`, `src/artifacts.ts`.

### 3. Calibration summary

New CLI verb `market-bot calibration`:

- Aggregates all resolved scores in `data/runs/`.
- Reports Brier score, reliability bins (predicted 0.6–0.7 → observed hit rate), accuracy by `kind` and by `assetClass`.
- Writes `data/calibration/summary.json` + a markdown overview.

### 4. Feed calibration back into runs (passive injection)

Before stage 1 in the orchestrator: read `data/calibration/summary.json` if present and inject a compact block into the evidence payload (`buildEvidencePayload`, orchestrator.ts:205) — e.g. "Past direction-kind predictions at p≈0.7 resolved at 0.52 hit rate". The LLM sees its own track record. No behavioural guarantee — the calibration data itself will show whether the model adjusts.

Honest expectation: the model probably mostly ignores this in v1. That's fine — the calibration record will surface it, and that's the foundation for a v2 presentation-layer isotonic remap once ≥50 predictions have resolved.

### 5. Scoring trigger (v1: piggyback)

Every `daily`/`ticker` invocation first scores any due predictions, then runs research. Fail-soft: scorer errors logged, never block the research output. Decoupling into a scheduled job is deferred to [IMPROVEMENTS.md](../IMPROVEMENTS.md).

### 6. ADR 0004 — Predictions as observable forecasts, not advice

Add `docs/adr/0004-predictions-as-observable-forecasts.md` recording:

- The carve-out from ADR 0001: probabilistic statements about observable market quantities (price direction, relative performance, volatility threshold, range break) are allowed; they are not trade actions or sizing.
- Validator additions: existing TRADE_ACTION_PATTERN still applies to all `claim` strings; additionally, predictions reject reader-directed modal phrases ("consider", "watch for", "should", "could be a", "expect to"). Predictions describe the *market*, not the *reader*.
- Expanded `notFinancialAdvice` disclaimer text covering predictions explicitly.
- Alternatives considered: stay purely qualitative (rejected — kills the calibration loop); sidecar `predictions.json` outside the report (rejected — user is comfortable with predictions in the main report).

---

## Critical files

- src/domain/types.ts — add `Prediction` type + field on `ResearchReport`
- src/report/schema.ts — extend validator, tightened prediction-claim language rules
- src/report/markdown.ts — render predictions section
- src/research/orchestrator.ts — extend `finalReportShape()`, `buildEvidencePayload()`, `readPredictions()`, depth profile mapping for prediction counts, synthesis-stage re-prompt-on-shortfall
- src/sources/collector.ts — retry/backoff in `fetchJsonOrGap`
- src/sources/yahoo.ts — `v8/finance/chart` historical helper
- src/sources/coingecko.ts — `/coins/{id}/market_chart/range` historical helper
- src/cli/args.ts + src/cli.ts — add `score` and `calibration` verbs
- src/forecast/observable.ts — hand-rolled `measurableAs` parser and observable forecast contract
- src/scoring/resolver.ts — resolve predictions against fetched closes
- src/scoring/index.ts — orchestrate the score pass
- src/scoring/calibration.ts — aggregate, Brier, reliability bins
- src/artifacts.ts — write `score.json`, `data/calibration/summary.json`
- docs/adr/0004-predictions-as-observable-forecasts.md — new ADR
- tests/ — schema tests, DSL parser tests, scorer with mocked fetches, calibration aggregation, golden tests updated for new field

## Verification

- `bun test` — unit + golden tests pass with new schema
- `bun market-bot daily --asset equity` produces a report containing 2–5 well-formed predictions
- `bun market-bot ticker SPY --asset equity --deep` produces 5 predictions on SPY
- `bun market-bot score` against a fixture run resolves predictions correctly (mocked chart fetches)
- `bun market-bot calibration` over ≥10 resolved predictions produces a Brier score and reliability table
- A run with the synthesis stage forced to emit malformed predictions still produces a valid report with a `predictionShortfall` data gap, no crash
- Source retry test: a flaky fetch with 2 consecutive 503s then 200 resolves successfully
- `bun run check` is green

## Non-goals for this plan

Anything in [IMPROVEMENTS.md](../IMPROVEMENTS.md). Specifically: no new data providers, no scheduler, no delivery channel, no cross-run watchlists, no real cost tracking, no caching layer, no probability remapping, no agentic tool use. The current post-calibration ordering is maintained there.
