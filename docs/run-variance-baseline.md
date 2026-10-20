# Same-code run variance baseline

Three consecutive `equity AMD --deep` runs on one commit, one session, one
market day, each in an identically seeded throwaway root. This is the
controlled-warm band (Band 2). Deltas that fall inside the ranges below are
single-run noise unless corroborated by independent evidence. Treat the ranges
as stale once any path in the command below changes after the baseline commit.

**Status: current** as of 2026-10-20. Re-recorded after the 2026-08-31 `87aa497`
band went stale (100+ watched files changed, `prompts/` included). The old band
and the 2026-08-11 `0110528` AAPL bands are retired; do not compare against them.

Cold-start Band 1 was not recorded. Three runs were authorized, not six.

- Commit: `6f4e6a111332` (`fix: address review of amd run-review follow-ups`),
  clean tree (`dirty=false`), package 1.5.1
- Branch: `fix/amd-run-review-todos`
- Date: 2026-10-20 (Tuesday), runs 07:18:01–07:25:41 UTC per `trace.json`
  `startedAt` / `completedAt` (03:18–03:26 America/New_York). Pre-market: the
  latest published session was 2026-10-19 in all three
  (`verifiedMarketSnapshot.latestSessionDate`), so market data was static across
  runs
- Subject: AMD, `equity AMD --deep`. Three runs, sequential, none excluded (all
  exit 0, all Web Gather succeeded, Exa served every run)
- Run ids (duration is the `stages.json` `durationMs` sum; no wrapper recorded
  wall clock; `trace.json` start-to-completion is 2m59s / 2m18s / 2m13s):
  1. `2026-10-20T07-18-01-691Z-144366d7` (2.51 min)
  2. `2026-10-20T07-21-05-329Z-628a3dd3` (1.89 min)
  3. `2026-10-20T07-23-27-957Z-df5b79ec` (1.85 min)
- Seed Run Artifact: `2026-10-20T07-09-03-517Z-6b4aa8ab`, a live AMD deep run
  on the band commit made with `MARKET_BOT_CAPTURE_REPLAY=1`

Check whether this baseline still applies with one command:

```sh
git diff --name-only 6f4e6a11..HEAD -- \
  prompts \
  src/research/prompts \
  src/research/final-synthesis.ts \
  src/web-evidence \
  src/forecast \
  src/scoring \
  src/research/run-analytics.ts \
  src/research/subsystem-outcomes.ts \
  src/sources/extended-evidence \
  src/research/extended-evidence-projections.ts \
  src/domain/source-gaps.ts \
  src/research/source-plan.ts \
  src/research/report-assembly.ts \
  src/research/orchestrator.ts \
  src/run-artifact-writer.ts \
  src/domain/equity-analysis-completeness.ts \
  src/research/deterministic-gaps.ts
```

Every path feeds a recorded row. `src/research/run-analytics.ts` produces
nearly all of them; `src/research/extended-evidence-projections.ts` is the sole
producer of report extras; `src/domain/equity-analysis-completeness.ts` sets
`coverageLevel` and `operatingKpis`; `src/research/deterministic-gaps.ts`
declares Source Gaps. Top-level `prompts/` (stage prompts and Domain Playbooks)
steers synthesis as directly as `src/research/prompts`.

## Isolation

`data/peer-universe-learned.json` now exists and must be seeded identically in each isolated root in the next re-record.

Recipe actually used:

```sh
root=<throwaway>/warm-<n>          # fresh per run, seeded identically
MARKET_BOT_DATA_DIR=$root/runs \
MARKET_BOT_CACHE_DIR=$root/cache \
MARKET_BOT_NEWS_SEEN_PATH=$root/news-seen.json \
bun run src/cli.ts equity AMD --deep
```

Pin `MARKET_BOT_NEWS_SEEN_PATH` explicitly. Unset or empty, `readOptionalString`
(`src/config.ts`) falls back to `deriveNewsSeenPath(dataDir)`, which is
isolated; a non-empty value in `.env` would silently break isolation.

Seed per run: `<root>/runs/2026-10-20T07-09-03-517Z-6b4aa8ab/` (full run dir)
plus `<root>/news-seen.json` copied from `data/news-seen.json`. Unseeded and
left for the run to create: `cache/`, `calibration/`, `provider-health/`. Not
seeded and not created: `peer-universe-learned.json` (derived as
`<root>/peer-universe-learned.json`; it exists under `data/` but was not
copied), `history/`, `index.sqlite`. Each root ended with 43 cache files, all
written by its own run.

The seed is itself a reused-profile run: its Web Subject Profile came from
`2026-10-18T08-13-28-001Z-1e2720bc` (origin `2026-10-08T04-38-55-243Z-a6cb6620`,
12.1 days old at band time). It is input state only.

The three seeded roots were verified identical before use (`diff -rq` clean).

`git status` on `data/` is not proof of isolation: `data/` is gitignored
(`.gitignore:2`) with zero tracked files, so it is clean either way. After the
runs, `data/runs` held no run dir newer than the seed, `data/cache` held 0
files newer than the seed's `trace.json`, and `data/news-seen.json` was last
written by the seed run (07:11:37 UTC).

`effectiveConfigHash` differs per run. That is expected, not drift.
Run 1 `83497c879937`, run 2 `fd1f3ccabac1`, run 3 `2529735ea806`. The hash
(`src/reproducibility.ts`) covers the non-secret config, including `dataDir` /
`cacheDir` / `newsSeenPath`, which differ per throwaway root by design. Those
roots feed calibration, prior-run context, cached payloads, and news
suppression, so they stay hashed; per-run throwaway roots make an identical
config hash unobtainable. Only output-only keys (`captureReplay`, index
`dbPath`) are excluded.

## Observed metrics

| Metric                                                    | Run 1                               | Run 2                               | Run 3                               | Observed range               |
| --------------------------------------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- | ---------------------------- |
| `webEvidenceUtilization.acceptedCurrentRun`               | 4                                   | 4                                   | 3                                   | 3–4                          |
| `webEvidenceUtilization.usedCurrentRun`                   | 3                                   | 1                                   | 2                                   | 1–3                          |
| `webEvidenceUtilization.ratio`                            | 0.75                                | 0.25                                | 0.6666666666666666                  | 0.25–0.75                    |
| `webEvidenceUtilization.level`                            | high                                | medium                              | insufficient-sample                 | varies                       |
| `webSources.accepted`                                     | 4                                   | 4                                   | 3                                   | 3–4                          |
| `webSources.reportCited`                                  | 3                                   | 1                                   | 2                                   | 1–3                          |
| `webSources.usageRatio`                                   | 0.75                                | 0.25                                | 0.6666666666666666                  | 0.25–0.75                    |
| `reusedProfileWebSources.reportCited` (of 3 accepted)     | 2                                   | 3                                   | 1                                   | 1–3                          |
| `webGatherAcceptancePolicy.mode`                          | reused-profile-default              | reused-profile-default              | reused-profile-default              | stable                       |
| `webGatherAcceptancePolicy.sourceRunDirName`              | `2026-10-20T07-09-03-517Z-6b4aa8ab` | `2026-10-20T07-09-03-517Z-6b4aa8ab` | `2026-10-20T07-09-03-517Z-6b4aa8ab` | stable (proves seeding took) |
| `webGatherAcceptancePolicy.priorUtilizationLevel`         | high                                | high                                | high                                | stable                       |
| `webGatherAcceptancePolicy.priorUtilizationRatio`         | 0.8                                 | 0.8                                 | 0.8                                 | stable                       |
| `webGatherAcceptancePolicy.implicitPerQueryAcceptanceCap` | 3                                   | 3                                   | 3                                   | stable at 3                  |
| `predictions.count` (final)                               | 1                                   | 3                                   | 2                                   | 1–3                          |
| `predictions.targetMet` / `shortfall.missingCount`        | false / 2                           | true / none                         | false / 1                           | target 3 met in 1 of 3       |
| `predictions.byKind.range`                                | 1                                   | 1                                   | 1                                   | stable at 1                  |
| `predictions.byKind.relative`                             | absent                              | 1                                   | 1                                   | 0–1                          |
| `predictions.byKind.direction`                            | absent                              | 1                                   | absent                              | 0–1                          |
| `predictions.horizonTradingDays` min / max                | 20 / 20                             | 5 / 5                               | 5 / 20                              | 5–20 / 5–20                  |
| `predictions.nearBaseRateCount` / `informativeCount`      | 0 / 1                               | 3 / 0                               | 2 / 0                               | 0–3 / 0–1                    |
| `predictions.signalTargetMet`                             | true                                | false                               | false                               | varies                       |
| `predictions.citedCount` / `uncitedCount`                 | 1 / 0                               | 3 / 0                               | 2 / 0                               | uncited stable at 0          |
| `sourceFunnel.sourceGaps.total`                           | 24                                  | 24                                  | 24                                  | stable at 24                 |
| `sourceFunnel.sourceGapsByCause.unsupported-coverage`     | 8                                   | 8                                   | 8                                   | stable at 8                  |
| `sourceFunnel.sourceGapsByCause.suppressed-by-design`     | 7                                   | 7                                   | 7                                   | stable at 7                  |
| `sourceFunnel.sourceGapsByCause.provider-data-missing`    | 6                                   | 6                                   | 6                                   | stable at 6                  |
| `sourceFunnel.sourceGapsByCause.missing-credential`       | 2                                   | 2                                   | 2                                   | stable at 2                  |
| `sourceFunnel.sourceGapsByCause.reused-in-window`         | 1                                   | 1                                   | 1                                   | stable at 1                  |
| `sourceFunnel.reportSources.total`                        | 63                                  | 63                                  | 62                                  | 62–63                        |
| `sourceFunnel.dataGaps.total`                             | 35                                  | 32                                  | 33                                  | 32–35                        |
| `evidenceLanes.coverageRatio`                             | 0.8181818181818182                  | 0.8181818181818182                  | 0.8181818181818182                  | stable at 0.8181818181818182 |
| `subsystemOutcomes.count`                                 | 18                                  | 18                                  | 18                                  | stable at 18                 |
| `subsystemOutcomes.byOutcome.produced`                    | 14                                  | 14                                  | 14                                  | stable at 14                 |
| `subsystemOutcomes.byOutcome.empty`                       | 0                                   | 0                                   | 0                                   | stable at 0                  |
| `subsystemOutcomes.byOutcome.declined`                    | 3                                   | 3                                   | 3                                   | stable at 3                  |
| `subsystemOutcomes.byOutcome.failed`                      | 0                                   | 0                                   | 0                                   | stable at 0                  |
| `subsystemOutcomes.byOutcome.blocked`                     | 1                                   | 1                                   | 1                                   | stable at 1                  |
| `subsystemOutcomes.expectedEmptyCount`                    | 0                                   | 0                                   | 0                                   | stable at 0                  |
| `equityAnalysisCompleteness.coverageLevel`                | substantial                         | substantial                         | substantial                         | stable at `substantial`      |
| `operatingKpis.status`                                    | not-assessed                        | not-assessed                        | not-assessed                        | stable at `not-assessed`     |
| Estimated tokens (`trace.json:tokenEstimate`)             | 394,112                             | 327,881                             | 323,311                             | 323,311–394,112              |

The seed itself read ratio 0.8 (5 accepted, 4 used), 3 predictions, 24 Source
Gaps with the same by-cause mix, and 358,919 estimated tokens.

`webEvidenceUtilization.level` is `insufficient-sample` whenever fewer than 4
web sources are accepted (`classifyWebEvidenceUtilization`), so run 3's level
says nothing about its 0.67 ratio. Run 3 also reads
`webEvidenceUtilization.structuredExtraCited` 1 against `webSources.extrasCited`
0: the latter excludes ids already report-cited, so the two differ by design.

No run carried `webSources.usageWarning` (it needs ≥4 accepted and a ratio below
0.25) and no run raised a report-integrity advisory warning
(`reportIntegrityAudit.advisoryWarningCount` 0, `prunedItemCount` 0).

### Reading new runs against the subsystem-outcome rows

All three runs emitted `web-search-provider` as `primary-provider-served`
(`produced`). Its other branches move the rows without being drift:

- Primary degraded (`primary-provider-degraded` as `failed`, including a
  covered Firecrawl fallback): produced 13, failed 1, count 18. Read a 1 against
  `providerEndpointAvailability.exaSearch` before treating it as a defect.
- Web Gather ran but accepted no `web_search` (provider row
  `no-accepted-requests` as `empty`, expectation `expected`): produced 13,
  empty 1, `expectedEmptyCount` 1, count 18. If it accepted no request at all,
  the `web-gather` row flips to `empty` too: produced 12, empty 2,
  `expectedEmptyCount` 2. Still triage a zero-accepted gather; this band never
  saw one.

### Reading new runs against the Source Gap rows

The band ran pre-market, so no `session-in-progress` Source Gap fired. A rerun
during US regular hours adds one: `sourceGaps.total` reads 25 and
`sourceGapsByCause.session-in-progress` reads 1. `dataGaps.total` and
`evidenceLanes.gapCount` move +1 in lockstep (nbis fixture replay: 30→31,
32→33, 12→13). `evidenceLanes.coverageRatio` is unchanged because the prior
completed session is still published. Treat a daytime +1 as that, not drift.

Absolute Source Gap levels are not comparable across baselines: by-cause mixes
changed between the 2026-08-31 band (18 total, with `repeat-fallback`) and this
one (24 total, with `suppressed-by-design`).

## Reading the ranges

- Web utilization is 0.25–0.75 with 3–4 accepted and 1–3 cited. The retired
  2026-08-31 band's 0.00–0.25 collapse, and its hypothesis that rating-heavy Exa
  result sets depress citation, did not reproduce here. The AMD 0.40 incident
  that prompted the earlier recording sits inside this band.
- Reused-profile citation also varies (1–3 of 3). Profile and fresh sources
  traded citations run to run; neither consistently crowded out the other.
- Final Observable Prediction counts were 1–3 against a target of 3; two of
  three runs fell short (missing 2 and 1). Only run 1 met the signal target, and
  it emitted a single prediction. Runs 2 and 3 clustered every prediction near
  the 0.5 base rate. Range kind was the only stable one. Uncited count was 0 in
  all three. The prediction stage is the noisiest part of this band: a count of
  1 or a near-base-rate set is inside it, so do not read one run's count as a
  regression without corroboration.
- Source Gap totals were stable at 24 with the same by-cause mix. Evidence Lane
  coverage was stable at 0.8181818181818182. `dataGaps.total` varied 32–35.
- Subsystem outcomes were identical across runs: produced 14, declined 3,
  blocked 1, empty 0, failed 0, count 18.
- Equity Analysis Completeness `coverageLevel` stayed at `substantial`.
  `operatingKpis.status` stayed at `not-assessed`.
- Estimated tokens ranged 323,311–394,112.
- The stable `webGatherAcceptancePolicy` rows (`reused-profile-default`, seed
  dir, prior utilization `high` / 0.8, cap 3) are the proof that controlled
  warm seeding held.

These are advisory ranges from three runs, not authoritative limits.
