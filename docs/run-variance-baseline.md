# Same-code run variance baseline

Three consecutive `market-bot equity AAPL --deep` runs on one commit, one
session, one market day. Deltas between two runs that fall inside the ranges
below are single-run noise unless corroborated by independent evidence; treat
the ranges as stale once web gather, synthesis, forecasting, or scoring code
changes after the baseline commit.

- Commit: `69eb4edc0115669566db90bb37b8e433300124c3` (clean tree)
- Date: 2026-07-12 (weekend session — market data static across runs; web
  news drift between runs remains a known residual confound)
- Runs: `2026-07-12T03-18-22-522Z-4c1c50bc`, `2026-07-12T03-25-33-567Z-fece9f6a`,
  `2026-07-12T03-32-15-563Z-396847dd`

## Observed metrics

| Metric                                        | Run 1   | Run 2   | Run 3       | Range     |
| --------------------------------------------- | ------- | ------- | ----------- | --------- |
| `webSources.usageRatio`                       | 0.50    | 0.43    | 0.50        | 0.43–0.50 |
| `webSources.accepted`                         | 10      | 7       | 10          | 7–10      |
| `webSources.reportCited`                      | 3       | 3       | 2           | 2–3       |
| `predictions.completion.initialCount`         | 2       | 4       | — (no pass) | 2–5       |
| Final prediction count                        | 5       | 5       | 5           | 5         |
| `nearBaseRateCount` / `informativeCount`      | 0 / 5   | 0 / 5   | 0 / 5       | stable    |
| `sourceFunnel.sourceGaps.total`               | 10      | 11      | 11          | 10–11     |
| `evidenceLanes.coverageRatio`                 | 0.818   | 0.818   | 0.818       | stable    |
| Estimated tokens (`trace.json:tokenEstimate`) | 373,565 | 385,767 | 336,192     | 336k–386k |

Run 3 emitted 5 primary predictions, so no completion pass fired; its
effective initial count is 5.

## Per-claim probabilities

Recurring claims were near-identical across runs (spread ≤ 0.02 per claim):

| Claim family                         | Run 1 | Run 2 | Run 3 |
| ------------------------------------ | ----- | ----- | ----- |
| range (AAPL outside band, 5d)        | 0.34  | 0.34  | 0.36  |
| relative (AAPL vs QQQ, 5d)           | 0.37  | 0.37  | 0.37  |
| conditional (up-then-up)             | 0.64  | 0.63  | 0.63  |
| direction (AAPL up)                  | 0.61  | 0.61  | 0.61  |
| earnings-direction (post-2026-07-30) | 0.39  | 0.39  | 0.38  |

## Reading the ranges

- Citation-ratio moves within 0.43–0.50 (or accepted counts within 7–10) are
  noise. The 0.50 → 0.09 collapse that motivated this baseline sits far
  outside it.
- Initial prediction count varies 2–5 on identical code; a 4-vs-5 delta
  between two runs is not signal.
- Same-claim probability spread is ≤ 0.02; polarity flips of near-band
  probabilities across runs would exceed this baseline and deserve a look.
- All 15 probabilities landed 0.01–0.04 outside the widened 0.40–0.60
  near-base-rate band (0.34–0.39 / 0.61–0.64). Watch
  `calibrationAtGeneration` on future resolved cohorts for band-escape
  overshoot (the risk noted in ADR 0003's 2026-07-12 amendment).
- Token totals swing ~15% run-to-run; treat sub-20% token deltas as noise.
