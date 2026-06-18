# Run Analysis — Validation & Independent Review (2026-06-18)

Validates `reports/run-analysis-2026-06-18.md` (the external LLM review) against the
actual run artifacts and source code, then adds independent findings.

Runs reviewed:

- `market-overview --asset equity` → `data/runs/2026-06-18T10-04-01-275Z-2cd6e16d`
- `ticker AAPL --asset equity` → `data/runs/2026-06-18T10-06-24-859Z-2914f121`
- `alpha-search --asset equity` → `data/runs/2026-06-18T10-08-32-672Z-ae5c4f48`
- `research` → `data/runs/2026-06-18T10-19-30-563Z-62a1d416`

## Verdict on the external review

**High quality and largely accurate.** Every factual snapshot claim I spot-checked
(token counts, source counts, forecast shortfalls, evidence-quality labels, specific
values like FA's 133.5 upvotes/mention and AIB's truncated name) matched the artifacts.
The code-owner pointers were correct. Two code-level claims I verified directly in source
and confirmed true (research title branch, run-config fallthrough).

Three things the external review got slightly wrong or under-weighted, detailed below:

1. It lists the research failures as 8 separate findings; they are **one root-cause chain**.
2. It under-rates the severity: the research VIX forecast is an **ADR 0027 violation**, which
   makes it a correctness/observability bug, not a polish item.
3. Its playbook-telemetry fix suggestion ("dedupe by `(stage, playbookId)`") is inaccurate —
   that dedup already happens. The real cause is different (below).

---

## Phase 4 — Research run (most severe; reorder it first)

### Confirmed: single root cause behind external findings #2, #3, #4, #8

The proxy **is** resolved but never propagated. From `report.json` extras:

```
extras.proxyResolution.predictionProxySymbol = "XBI"
extras.depthProfile.predictionSubjects = [SPY, QQQ, ^VIX, DGS10, DGS2, T10Y2Y,
                                          FEDFUNDS, CPIAUCSL, UNRATE, DTWEXBGS]   ← no XBI
```

Mechanism, confirmed in code:

- `src/config/runs.ts:10` — `RunKey` has only `market-overview-equity | market-overview-crypto | ticker`.
- `src/config/runs.ts:216-221` — `toRunKey()` returns `market-overview-${assetClass}` for **any**
  non-ticker job, so `research` silently inherits `market-overview-equity`, including its
  `EQUITY_MARKET_UPDATE_PREDICTION_SUBJECTS` (`runs.ts:67-79`).

Everything downstream cascades from this:

- Predictions can only be drawn from SPY/QQQ/^VIX/FRED → the model emitted
  `max(close(^VIX), 0..+15) > 20`, a broad-market vol forecast unrelated to the AI-biotech subject.
- The XBI snapshot was never requested (source collection has no proxy in its subject list),
  hence the honest data gap "No supplied XBI market snapshot."
- Spotlights default to broad proxies (^VIX/QQQ/SPY) because that's all that was fetched.

**This is an ADR 0027 violation, not a nit.** ADR 0027 (lines 28–30, 32) states a research run
that resolves to a single-ETF proxy must emit predictions on that proxy, and one with **no**
proxy must emit **zero** predictions and disclose the gap. Here the subject resolved to XBI but
the run shipped a VIX forecast — it scores VIX, not biotech. Per the repo's own non-negotiable
("Predictions must be observable" / scoreable), I rate this **CRITICAL**, above where the
external review implicitly placed it.

Single highest-leverage fix: add a `research-equity` (and `-crypto`) run key, and inject the
resolved proxy into `predictionSubjects` when `proxyResolution.predictionProxySymbol` is set;
fetch the proxy snapshot in research source collection; gate forecasts to the proxy (else zero).
This one change resolves external findings #2, #3, #4, #5 (mostly), and #8 together.

### Confirmed: external finding #1 — wrong title

`src/report/markdown.ts:443-445`:

```ts
report.symbol
  ? `${report.symbol} ${report.assetClass} Research View`
  : `${report.assetClass} Market Overview`;
```

Any symbol-less report titles as "Market Overview". Confirmed by contrast across runs:
the AAPL run (has `symbol`) renders `# AAPL equity Research View`; research (no symbol)
renders `# equity Market Overview`. Alpha-search has its own branch ("Alpha Search Report"),
so the gap is specifically the `research` job type. Valid, low severity, trivial fix.

### Partial correction: external finding #7 — playbook telemetry

The trace shows `source-discipline` in **both** `selected` and `rejected` (reason
"duplicate selection") for the same `critique` and `final-synthesis` stages — genuinely confusing.

But the external review's fix ("dedupe by `(stage, playbookId)`") misdiagnoses it. Dedup already
happens: `src/research/playbooks.ts:386,392-393` keys `seen` by `${stage}:${playbookId}` and
rejects on hit. The real cause: mandatory selections are added first (`playbooks.ts:308-321`),
then the model **re-proposes** the same mandatory playbook, which is then logged as a "duplicate
selection" rejection. The correct fix is to either (a) not surface a rejection when the duplicate
target is already-selected for that stage, or (b) exclude mandatory playbooks from the candidate
list shown to the selector. Cosmetic/telemetry only — selection behavior is correct. LOW.

### Other Phase-4 findings (external #5, #6) — valid as written

Off-subject spotlights and market-overview-weighted historical context both follow from the
same config inheritance; they resolve once research has its own config + proxy sourcing.

---

## Phase 1 — Market Overview equity: confirmed

- Token estimate **331,495** confirmed (`analytics.json` runShape). Per-stage:
  spotlight-selection 53k, specialist 85k, critique 87k, final-synthesis 91k. The driver is
  re-sending **151 Yahoo market-data sources** to every model stage (`reportSources.byKind.market-data = 151`).
  External finding #4 (compact payloads) is well-targeted; cross-checks against the research run
  (28 sources → 129k tokens) confirm source count is the dominant token driver.
- QURE/SLBT spotlights with no company-specific catalyst evidence: confirmed in report Data Gaps.
  External #1 (symbol-specific spotlight news pass) is sound.
- Single-day mover universe disclosed in Data Gaps ("seeded from Yahoo day_gainers/losers/actives").
  External #2 (horizon-aligned trailing returns) valid.
- 1-of-2 forecast shortfall confirmed (`predictions.shortfall`). External #3 (prediction audit
  sidecar) is the most useful systemic recommendation — see cross-run note.
- Note I'd add: `persistentSuppressedNewsSourceCount = 14` here vs 0 in the research run — the
  seen-news index is doing real work on the overview path; worth surfacing in the report so the
  news set doesn't look thinner than what was actually fetched.

---

## Phase 2 — Ticker AAPL: confirmed, one sharpening

- 2-of-3 shortfall, low evidence quality, both DSL forecasts valid (`outside [285,310]`,
  `> close(AAPL,0)`): all confirmed.
- External #1 (weight "core" vs "nice-to-have" gaps): the 403s on Finnhub dividend/split and the
  unset Tradier token are disclosed as flat data gaps; they currently read with the same weight as
  a thesis-relevant gap. Valid.
- External #2 (realized-vol/ATR fallback for the range forecast when IV is absent): valid and high
  value — the report explicitly says options-implied move/skew is unavailable yet still emits an
  `outside`-range forecast calibrated by narrative. A deterministic ATR band would be more honest.
- **Sharpening of external #3 (valuation):** the period basis *is* disclosed in Extended Evidence
  ("9-month revenue $202.7B, annualized revenue $270.3B"). The misleading spot is the **Key
  Findings** headline (report.md:19) — "EV/annualized revenue near 16.22x" with no 9-month caveat.
  So the fix is narrower than "render the basis prominently": carry the "9-mo annualized, not TTM"
  qualifier into the headline metric, or prefer TTM from SEC company facts.
- External #5 (stage suggestions outside final DSL, e.g. "above 50-day SMA"): valid; final
  synthesis corrected it, so this is prompt-discipline hygiene, not an output defect.

---

## Phase 3 — Alpha Search: confirmed, all low/medium severity

- `FA`: 2 mentions, 267 upvotes → 133.5 upvotes/mention (report.md:17). Confirmed. External #2
  (sample-size confidence / winsorize / min thresholds) valid.
- `AIB` truncated to "BlockchAIn Digital Infrastructu" (report.md:21). Confirmed. External #1
  (prefer listed-universe / SEC entity names) valid.
- Every lead cites the same `[market-yahoo-alpha-search]` aggregate source. Confirmed.
  External #3 (per-symbol source IDs) valid for traceability.
- Disclaimer still says "Predictions are probabilistic statements…" though alpha-search emits none
  (report.md:3). Confirmed. External #6 valid — but note this same generic disclaimer is shared
  across all job types, so the fix is an alpha-specific (or job-type-aware) note.
- Fundamental gaps shown only as a count (`Fundamental gaps: 17`); 17 typed gaps exist in the
  sidecar. External #4/#7 valid, low priority.
- Strongly positive: filtering rationale is fully transparent (ETF, unresolved, over/under-cap,
  low-price, low-volume each disclosed per rejected candidate). This path is in good shape.

---

## Independent cross-run observations (not in the external review)

1. **Negative calibration skill is the backdrop for every shortfall.**
   `calibrationAtGeneration.assetClass` (equity): Brier 0.281, **Brier skill score −0.125**, i.e.
   worse than climatology over 23 resolved equity forecasts. The system's response — anchoring
   probabilities to ~44–46% and refusing to pad to target counts — is the *correct* behavior given
   negative skill. Frame the recurring "1 of 2/3" shortfalls as honest restraint, not a defect to
   engineer away. The prediction-audit sidecar (below) matters precisely because it makes that
   restraint legible.

2. **The prediction-audit sidecar is the single best systemic add.** Three of three forecasting
   runs missed target count and all three give the same opaque line ("evidence did not support
   more"). A persisted `prediction-audit.json` (candidate → validation status → drop reason →
   final-synthesis reason) would make shortfalls actionable across all job types at once. This
   should rank above most per-run polish items.

3. **Token cost scales with raw source fan-out, confirmed empirically.** 174 sources → 331k tokens
   (overview) vs 28 sources → 129k (research). The 151 raw Yahoo snapshots are re-serialized into
   every model stage. Ranked top-N + breadth/sector aggregates would cut the largest line item.

4. **Self-disclosure resilience is a genuine strength.** Every run honestly surfaced its own gaps —
   the research run even disclosed "No supplied XBI market snapshot … despite XBI being the
   prediction proxy," which is literally the system reporting its own config bug. The research-only
   boundary held in all four runs. Worth preserving as the runs are fixed.

---

## Recommended fix order (revised)

1. **Research run semantics (CRITICAL — ADR 0027).** Add `research-equity`/`-crypto` run keys;
   propagate `proxyResolution.predictionProxySymbol` into `predictionSubjects`; fetch proxy +
   subject sources in research source collection; gate forecasts to the proxy or emit zero.
   Add tests. Single change clears research findings #2–#5 and #8.
2. **Prediction-audit sidecar** (candidate/validation/drop/final reasons) — covers all three
   forecasting runs' shortfall opacity.
3. **Ticker range honesty:** realized-vol/ATR fallback when Tradier IV is missing; carry the
   "9-mo annualized, not TTM" qualifier into the headline valuation metric.
4. **Source coverage:** symbol-specific spotlight news pass (overview); horizon-aligned trailing
   movers (overview); issuer-specific second-pass news (ticker).
5. **Compact brief-run model payloads** (ranked top-N + breadth aggregates instead of raw arrays).
6. **Polish:** research markdown title; alpha lead display names, per-symbol Yahoo source IDs,
   social sample-size labels, grouped fundamental gaps; job-type-aware disclaimer for alpha;
   clean up duplicate-playbook rejection telemetry; render macro observation dates and
   market-update baseline age.
