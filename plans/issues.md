# TODO

## Known gaps vs AGENTS.md data rules

Current behavior short of the Financial data best practices in AGENTS.md. Close each as its own change with tests; remove the line when closed.

- EV omits preferred stock and noncontrolling interest (`valuation.ts`).
- Shareholder and buyback yield use gross repurchases, not net of issuance (`capital-return.ts`).
- ROIC and ROE use period-end balances, labeled as such.
- Diluted EPS TTM sums per-share periods without reweighting shares (disclosed as `ttm:eps-approximation`).
- Price Performance is price return, not total return.

## From AMD run-review cycle (2026-10-18, PR #107)

- After AMD earnings (2026-11-03) resolve the 10-20 runs' forecasts, rerun calibration and check whether the ±1σ range 0.32 base rate (#109/#110) improves live range Brier vs the 0.131/0.138 pre-change figures.
- Range skill still scores against 0.5. Kind-aware skill needs a per-forecast base-rate stamp at assembly plus a run-artifact index column, then an `index rebuild` (needs approval). Deferred in the ADR 0003 amendment.
- Prompt-change evals are weak: the band rule left relative probabilities clustered at 0.37–0.44, and the EPS gap-clause comparison (0/7 vs 2/10) used different AAPL inputs. Rerun a same-input base arm, on a base worktree without the `.env` symlink, which the classifier blocked.
- Live deep runs still produce mostly near-base-rate predictions, and the target of 3 pads with weak third calls (variance runs: 1/3/2 predictions). Kept at 3 by decision; revisit with an ADR 0003 amendment if resolved scores still show no skill.
- `scripts/eval-deep.ts` and `scripts/replay-fixture-run.ts` stderr-write change (in #110) claims to fix a check failure the reviewer could not reproduce. Find the real cause, likely `.env` loading or a pipe race in the test, or revert it.
- Split gap fires on any asset class; a large crypto jump reads as "split-like". Confirm wording/scope.
- Delete merged local branches: fix/amd-run-review-todos, fix/range-probability-anchor, fix/forecast-telemetry-and-catalysts.

## From forecast-baseline cycle (2026-10-22, PR #112)

- Trillion precision differs: Markdown `compactNumber` gives 1dp T (`$5.1T`), Console `scaleCurrency` 2dp T (`$5.07T`). Pick one; add a ≥1T case to the Console-vs-markdown parity tests in `tests/run-workspace-view.test.ts`.
- Stage ablation: all stages kept, no confirmatory batch (`docs/testing.md`). Revisit only if per-run tokens or judge variance change materially; n=823 pairs at margin 0.5, 52 at 2.0 (~265M tokens).
- Delete local branch feat/forecast-baseline once #112 merges.

## From deep-equity loop (2026-10-23, branch improve/deep-equity-loop)

- Forecast Baseline lags one session: it scales σ by √h from the last close, but the resolver counts +N from the first session on or after the run date, so premarket/intraday/weekend runs score N+1 sessions out. Biases range Paired Skill; fix needs a baseline version bump.
- Forecast Grid job fact sheet (`src/forecast/grid-job.ts`) lists grid events without the ±1σ band or base rate that final synthesis now states. Share the framing.
- Final-synthesis +10 range anchor still states 0.32; the session-true rate for run d18dcf30 is ~0.34. Use `rangeReferenceSessions` for it too.
- Per-call usage ledger does not cover Run Chat streams, eval judges, the standalone Forecast Grid job, or history-thesis-delta.
- Pre-2026-10-23 token totals (runs, variance bands, eval estimates) double-count Codex reasoning; correction size unknown.
- Earnings-date confirmation: when SEC website fields are empty, fall back to issuer hosts (AMD: `ir.amd.com`, `newsroom.amd.com`) in `earnings-date-confirmation.ts`.
- Range skill scoring should prefer the stamped `baselineProbability` (latent gap, 1 borderline flip in 131 predictions); needs an ADR 0003 change.
- Open-web snippet cap: lower to ~2,400 chars or use fewer Exa highlights (cut lost one TrendForce volume fact in AMD runs).
- Financial Lens citations carry 24–25 source ids per metric instead of per-metric ids (ADR 0004).
