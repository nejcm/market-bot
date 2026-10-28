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

- Forecast Grid job fact sheet (`src/forecast/grid-job.ts`) lists grid events without the ±1σ band or base rate that final synthesis now states. Share the framing.
- Per-call usage ledger does not cover Run Chat streams, eval judges, the standalone Forecast Grid job, or history-thesis-delta.
- Pre-2026-10-23 token totals (runs, variance bands, eval estimates) double-count Codex reasoning; correction size unknown.
- Earnings-date confirmation (after 7d305758): runs 10-20 and 10-23 never gathered the issuer release, so the date stays provider-estimated; a Web Gather query issue. The ir.amd.com IR-calendar page ("Nov 3, 2026 • 2:00 pm PDT Webcast") fails the future-tense text check; loosening it needs a false-positive decision. Issuers whose domain is neither ticker nor full name (lilly.com, Nebius) cannot confirm via filing-text domains.
- Range skill scoring should prefer the stamped `baselineProbability` (latent gap, 1 borderline flip in 131 predictions); needs an ADR 0003 change.
- Open-web snippet cap: lower to ~2,400 chars or use fewer Exa highlights (cut lost one TrendForce volume fact in AMD runs).
- Financial Lens: per-metric ids fixed in 178cab2e; section- and lens-level ids still carry peer ids, and the SEC-summary path cites the whole SEC item.
- Recapture the nbis, depository and earnings-release fixtures with an authorized live capture; their QQQ history entries are synthetic 503s (10cd0d2c, docs/testing.md).
- Paired Skill excludes v1 range baselines (bc9fc853), so the range cohort restarts until v2 range Predictions resolve; check the cohort size before the 2027-01-15 review.
- Relative benchmarks beyond SPY/QQQ still get a declared forecast-baseline gap; a QQQ 429 can still open the shared Yahoo circuit for later Yahoo calls.
- SEC evidence summaries now carry the whole bounded section packet: +14,000 chars (~3.5k tokens) per extendedEvidence stage on AMD run a008bf63. If that cost matters, give Risk Factors and Notes a smaller share outside the profile stage.
- Final synthesis peer-median comparisons can omit peer sources (run a008bf63 bearCase[1]; keyFindings[5] cites them correctly).
- Final synthesis may invent peer source IDs on its first attempt (run 6349c37b: market-yahoo-equity-<peer>-fundamentals, 3 retries, 233k tokens). Retries now name valid IDs (ab0747fb); measure the retry count on the next live runs. Validation error strings still echo raw model IDs into reportValidationErrors. Run 6349c37b dataGaps[13] still says Data Center margins are unquantified although the segment table reaches synthesis (57a36701).
- Summary-path Growth rows drop prior-period dates; withheld capex keeps only the dated current input. Carry prior dates through if prior inputs should be shown.
- Earnings-date confirmation runs only after Web Gather (orchestrator.ts), so the announcement search (627ae2e9) runs even when a collected 8-K would already confirm the date. Confirm before the web phase to save the search. Model compliance with the new instruction is unmeasured.
- Literal `<<`/`>>` in model prose now forces a synthesis repair (00fddf6d); add a prompt line so the model avoids them.
- Debt (LongTermDebt scope fix): a tagged `LongTermDebtCurrent` outranks a broader `DebtCurrent`, so untagged short-term borrowings inside `DebtCurrent` drop out (Intel FY2018: 25,859M selected vs 26,359M total), and a generic current line still swallows other tagged current instruments (`LinesOfCreditCurrent`).
- Debt: a zero-valued unrecognized borrowing tag (Iridium FY2017 `SeniorLongTermNotes=0`) still refuses the component sum. Same-filing LongTermDebt scope rules withhold the latest debt for QCOM, ADBE, CLSK, WULF, RIOT, NOW, XYZ, PYPL, RKLB and CORZ (CIFR now via the current-instrument rule) (HEAD values were wrong for all but CORZ). Reading the accession's balance-sheet presentation (statement found via `FilingSummary.xml`, not a fixed `R2.htm`) would recover QCOM, ADBE, CLSK, WULF, RIOT, NOW, XYZ, CIFR and RKLB; PYPL needs embedded current borrowings and principal-to-carrying reconciliation, CORZ same-filing maturity evidence.
- Debt: non-commercial-paper current instruments beside a nonzero current-maturities line gap unless a same-instant `DebtCurrent` (added) or total (left out) sums them; equal amounts prove nothing. This withholds AMZN (132,549M carrying), AMAT (6,544M: STB includes maturities), GPN (23,520.114M incl. settlement lines of credit), MELI and MARA (notes + lines of credit equal maturities) as of their 2026 10-Qs. Tags cannot tell inside from beside; the balance-sheet presentation (via `FilingSummary.xml`) would recover them. When the newest instant is withheld, no older amount is published as latest debt (dated `SEC debt withheld` gap), which also drops correct older figures (ADBE, RIOT, ORCL). Older instants that pass the rules but omit lines still show in dated balance-sheet history (AAOI March 2025 omits 134.229M convertibles). An instant with `LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths` > 0, no current debt line and no exact principal-minus-unamortized match is now withheld; this fails closed for issuers that classify refinanced maturities as noncurrent.
- Debt values still wrong after the deep-equity debt rework: VSAT 6,427.825M at 2026-06-30 is principal published as net debt (lease-exclusive carrying 6,299.7M); HIVE 12.995M at 2026-03-31 (legacy) vs 27.486M 10-K borrowings, the mortgage is untagged; AAOI 26.682M at 2024-12-31 vs ≈161.2M in the filing, `ConvertibleLongTermNotesPayable` 134.497M dropped.
- Debt: the gross-principal fallback publishes principal beside an incomplete note at the same instant on the canonical path while legacy withholds it: BLDN 1,248.5M, HUT 7,735.1M (carrying 7,638.4M). Instants with untagged principal due within a year (PYPL 2025-12-31, CRWV 2026-06-30) no longer fall back.
