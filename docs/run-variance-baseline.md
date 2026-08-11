# Same-code run variance baseline

Three consecutive `market-bot equity AAPL --deep` runs on one commit, one
session, one market day. Deltas between two runs that fall inside the ranges
below are single-run noise unless corroborated by independent evidence; treat
the ranges as stale once web gather, synthesis, forecasting, or scoring code
changes after the baseline commit.

- Commit: `0110528112f174ab7f56ff6072afb062097d1367` (clean tree)
- Date: 2026-08-11 (US regular session closed; runs executed 16:01–16:27 +08,
  so market data was static across runs)
- Runs: `2026-08-11T08-01-26-563Z-67f6b037`, `2026-08-11T08-11-02-641Z-c718bf56`,
  `2026-08-11T08-19-44-110Z-c2278c53`
- Web-input context: all three runs fetched the same news inputs (43 fetched,
  35 canonically deduped, with identical provider counts). Downstream web
  variance came from persistent news-suppression state and Exa failures;
  Firecrawl was unconfigured. Runs 2 and 3 recorded 2 and 1 failed Exa
  requests; Run 1 recorded no fallback block.

Check whether the baseline still applies with one command:

```sh
git diff --name-only 0110528..HEAD -- src/research/prompts src/research/final-synthesis.ts src/web-evidence src/forecast src/scoring
```

On 2026-08-11, the `69eb4edc` bands were retired because forecast and synthesis
changes violated their staleness rule and absolute levels had drifted so far
that the bands carried no information; they recorded 5/5/5 final predictions
with a conditional in each.

## Run independence

These runs are serially dependent: Run 2 reused Run 1's acceptance profile,
Run 3 reused Run 2's `insufficient-sample` / `0` profile, persistent news
suppression rose 8 → 19 → 23, and the Exa circuit breaker opened in Run 2 and
remained open in Run 3. The web rows and `circuit-open` are therefore a
trajectory, not a distribution. A genuinely independent baseline would reset
`data/news-seen.json` and the acceptance profile between runs.

## Observed metrics

| Metric                                                       | Run 1       | Run 2             | Run 3       | Observed range                |
| ------------------------------------------------------------ | ----------- | ----------------- | ----------- | ----------------------------- |
| `webSources.usageRatio`                                      | 0.333       | 0 (gather failed) | 1.000       | 0.333–1.000 (Run 2 excluded)  |
| `webSources.accepted`                                        | 6           | 0 (gather failed) | 5           | 5–6 (Run 2 excluded)          |
| `webSources.reportCited`                                     | 2           | 0 (gather failed) | 5           | 2–5 (Run 2 excluded)          |
| `predictions.completion.initialCount`                        | 3           | 3                 | 3           | stable at 3                   |
| Final prediction count                                       | 3           | 3                 | 4           | 3–4                           |
| `nearBaseRateCount` / `informativeCount`                     | 0 / 3       | 0 / 3             | 0 / 4       | 0 / 3–4                       |
| `sourceFunnel.sourceGaps.total`                              | 16          | 17                | 17          | 16–17                         |
| `evidenceLanes.coverageRatio`                                | 0.818       | 0.818             | 0.818       | stable at 0.818               |
| Estimated tokens (`trace.json:tokenEstimate`)                | 404,562     | 420,421           | 400,528     | 400,528–420,421               |
| `predictions.byKind.range`                                   | 1           | 1                 | 1           | stable at 1                   |
| `predictions.byKind.relative`                                | 1           | 1                 | 2           | 1–2                           |
| `predictions.byKind.direction`                               | 1           | 1                 | 1           | stable at 1                   |
| `predictions.byKind.conditional`                             | absent      | absent            | absent      | absent in all three artifacts |
| `predictions.horizonTradingDays` min / max                   | 5 / 5       | 5 / 5             | 5 / 5       | stable at 5 / 5               |
| `webEvidenceUtilization.usedCurrentRun`                      | 2           | 0 (gather failed) | 5           | 2–5 (Run 2 excluded)          |
| `webEvidenceUtilization.acceptedCurrentRun`                  | 6           | 0 (gather failed) | 5           | 5–6 (Run 2 excluded)          |
| `sourceFunnel.sourceGapsByCause.repeat-fallback`             | 1           | 1                 | 1           | stable at 1                   |
| `sourceFunnel.sourceGapsByCause.unsupported-coverage`        | 8           | 8                 | 8           | stable at 8                   |
| `sourceFunnel.sourceGapsByCause.missing-credential`          | 1           | 1                 | 1           | stable at 1                   |
| `sourceFunnel.sourceGapsByCause.provider-data-missing`       | 5           | 5                 | 5           | stable at 5                   |
| `sourceFunnel.sourceGapsByCause.stale-fallback`              | 1           | 1                 | 1           | stable at 1                   |
| `sourceFunnel.sourceGapsByCause.circuit-open`                | absent      | 1                 | 1           | absent–1                      |
| `report.json:equityAnalysisCompleteness.financialCoreStatus` | complete    | complete          | complete    | stable at `complete`          |
| `report.json:equityAnalysisCompleteness.coverageLevel`       | substantial | substantial       | substantial | stable at `substantial`       |

Run 2's 0 lower bound in every web row is a gather failure, not run variance. A
future run with zero accepted web sources should be triaged, never excused by
this band.

`predictions.byKind.conditional` and Run 1's
`sourceFunnel.sourceGapsByCause.circuit-open` are genuinely absent from
`analytics.json`. The final reports confirm that none of the three runs emitted
a conditional prediction; the two completeness rows come from `report.json`.

## Per-claim probabilities

Exact observable claims did not all recur across runs:

| Claim family                     | Run 1 | Run 2 | Run 3 |
| -------------------------------- | ----- | ----- | ----- |
| range (AAPL outside 285–335, 5d) | 0.27  | —     | —     |
| range (AAPL outside 290–330, 5d) | —     | 0.28  | 0.32  |
| relative (AAPL vs QQQ, 5d)       | 0.39  | 0.36  | 0.36  |
| direction (AAPL up, 5d)          | 0.38  | 0.38  | 0.38  |
| relative (AAPL vs IWM, 5d)       | —     | —     | 0.34  |

## Reading the ranges

- Web utilization was 0.333 in Run 1 and 1.000 in Run 3. Run 2's zeros were a
  total gather failure, not variance; the web rows provide no band that excuses
  a future zero-accepted run.
- The completion pass started from 3 predictions in every run; final counts
  were 3–4. No run emitted a conditional, and every horizon was 5 trading days.
- Source-gap totals were 16–17 while Evidence Lane coverage stayed at 0.818;
  financial core status and coverage level were also unchanged.
- Of the exact claims present in all three runs, AAPL-vs-QQQ probability spread
  was 0.03 and AAPL-up spread was 0.00. The 290–330 range claim spread was 0.04
  across only two runs; the sample does not support a general per-claim bound.
- Estimated tokens ranged 400,528–420,421, about 5% peak to trough.

These are advisory ranges from three runs, not authoritative limits.
