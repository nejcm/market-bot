# Same-code run variance baseline

Three consecutive `equity AMD --deep` runs on one commit, one session, one
market day, each in an identically seeded throwaway root. This is the
controlled-warm band (Band 2). Deltas that fall inside the ranges below are
single-run noise unless corroborated by independent evidence. Treat the ranges
as stale once any path in the command below changes after the baseline commit.

Cold-start Band 1 was not recorded. Three runs were authorized, not six.

- Commit: `87aa497da528` (`docs(adr): align 0004 completeness wording…`), clean
  tree (`dirty=false`)
- Branch: `docs/run-variance-baseline-rerecord`
- Date: 2026-08-31, executed 12:16–12:38 +08 (04:16–04:38 UTC). US regular
  session closed (00:16–00:38 America/New_York, Monday), so market data was
  static across runs
- Subject: AMD, `equity AMD --deep`. Three runs, none excluded (all exit 0, all
  Web Gather succeeded)
- Run ids (wall clock from wrapper start/exit; `stages.json` stage-sums
  6.97 / 7.80 / 7.16 min agree within ~10s):
  1. `2026-08-31T04-16-14-772Z-46ecce2f` (6m48s)
  2. `2026-08-31T04-23-22-520Z-8099f5b5` (7m39s)
  3. `2026-08-31T04-31-17-554Z-5db75cce` (7m16s)
- Seed Run Artifact: `2026-08-30T05-11-23-839Z-88e8586b`

The 2026-08-11 `0110528` AAPL bands are retired. Their watch list returns 27
changed files against this commit, they measured a different subject on a
serially dependent path, and they are not a current band.

Check whether this baseline still applies with one command:

```sh
git diff --name-only 87aa497..HEAD -- \
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

The previous watch list missed producers of the recorded metrics. The biggest
omission is `src/research/run-analytics.ts`, which produces nearly every row below.
`src/research/extended-evidence-projections.ts` (sole producer of report extras),
`src/domain/equity-analysis-completeness.ts` (`coverageLevel` and
`operatingKpis`), and `src/research/deterministic-gaps.ts` (declared Source
Gaps) have not drifted versus `0110528` yet; they are on the list because they
feed recorded rows. The other added paths have drifted.

## Isolation

Recipe actually used:

```sh
root=<throwaway>/warm-<n>          # fresh per run, seeded identically
MARKET_BOT_DATA_DIR=$root/runs \
MARKET_BOT_CACHE_DIR=$root/cache \
MARKET_BOT_NEWS_SEEN_PATH=$root/news-seen.json \
bun run src/cli.ts equity AMD --deep
```

`MARKET_BOT_NEWS_SEEN_PATH` was pinned explicitly. It is not strictly required
today: `.env` sets it to an empty string, and `readOptionalString` at
`src/config.ts:281` maps empty to `undefined`, so `deriveNewsSeenPath` applies.
A future non-empty value in `.env` would silently break isolation. Pin it.

Seed per run: `<root>/runs/2026-08-30T05-11-23-839Z-88e8586b/` (full run dir)
plus `<root>/news-seen.json` copied from `data/news-seen.json`.
`peer-universe-learned.json` does not exist under `data/`, so it was not
seeded: absent, not skipped. Unseeded and left for the run to create: `cache/`,
`history/`, `index.sqlite`, `calibration/`, `provider-health/`.
`provider-health/` is a fourth derived sibling the recording plan did not
enumerate.

The seed artifact `2026-08-30T05-11-23-839Z-88e8586b` was generated on branch
`feat/composite-debt-basis` at commit `4af2fcd7723e`, not on `master` and not on
the band commit. It is input state only. Do not assume the seed shares the
band's commit.

The three seeded roots were verified byte-identical before use (`diff -rq`
clean, shared checksum `4c5060ee…`). warm-2 and warm-3 were re-verified against
the template immediately before their runs.

`git status` on `data/` is not proof of isolation: `data/` is gitignored
(`.gitignore:2`) with zero tracked files, so it is clean either way. Isolation
was checked with before/after snapshots of file counts and newest mtimes for
`data/cache`, `data/runs`, `data/news-seen.json`, `data/index.sqlite`,
`data/calibration`, and `data/history`. All three runs produced zero drift in
the real `data/` (`data/cache` held at exactly 1520 files throughout).

`effectiveConfigHash` differs per run. That is expected, not drift.
Run 1 `4842dfd1cd22`, run 2 `9f5daf07f760`, run 3 `905f98863831`. The hash
(`src/reproducibility.ts:35`) covers the whole non-secret config, including
`dataDir` / `cacheDir` / `newsSeenPath`, which differ per throwaway root by
design. Per-run throwaway roots make an identical config hash unobtainable. Do
not read this divergence as config drift.

## Observed metrics

| Metric                                                    | Run 1                               | Run 2                               | Run 3                               | Observed range               |
| --------------------------------------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- | ---------------------------- |
| `webEvidenceUtilization.acceptedCurrentRun`               | 5                                   | 4                                   | 4                                   | 4–5                          |
| `webEvidenceUtilization.usedCurrentRun`                   | 0                                   | 0                                   | 1                                   | 0–1                          |
| `webEvidenceUtilization.ratio`                            | 0                                   | 0                                   | 0.25                                | 0.00–0.25                    |
| `webEvidenceUtilization.level`                            | low                                 | low                                 | medium                              | low–medium                   |
| `webSources.accepted`                                     | 5                                   | 4                                   | 4                                   | 4–5                          |
| `webSources.reportCited`                                  | 0                                   | 0                                   | 1                                   | 0–1                          |
| `webSources.usageRatio`                                   | 0                                   | 0                                   | 0.25                                | 0.00–0.25                    |
| `webGatherAcceptancePolicy.mode`                          | reused-profile-default              | reused-profile-default              | reused-profile-default              | stable                       |
| `webGatherAcceptancePolicy.sourceRunDirName`              | `2026-08-30T05-11-23-839Z-88e8586b` | `2026-08-30T05-11-23-839Z-88e8586b` | `2026-08-30T05-11-23-839Z-88e8586b` | stable (proves seeding took) |
| `webGatherAcceptancePolicy.priorUtilizationLevel`         | high                                | high                                | high                                | stable                       |
| `webGatherAcceptancePolicy.priorUtilizationRatio`         | 0.75                                | 0.75                                | 0.75                                | stable                       |
| `webGatherAcceptancePolicy.implicitPerQueryAcceptanceCap` | 3                                   | 3                                   | 3                                   | stable at 3                  |
| `predictions.count` (final)                               | 5                                   | 5                                   | 4                                   | 4–5                          |
| `predictions.byKind.relative`                             | 1                                   | 1                                   | 1                                   | stable at 1                  |
| `predictions.byKind.range`                                | 3                                   | 3                                   | 3                                   | stable at 3                  |
| `predictions.byKind.direction`                            | 1                                   | 1                                   | absent                              | 0–1                          |
| `predictions.horizonTradingDays` min / max                | 5 / 20                              | 5 / 20                              | 5 / 20                              | stable at 5 / 20             |
| `predictions.nearBaseRateCount` / `informativeCount`      | 0 / 5                               | 0 / 5                               | 0 / 4                               | 0 / 4–5                      |
| `predictions.citedCount` / `uncitedCount`                 | 5 / 0                               | 5 / 0                               | 4 / 0                               | uncited stable at 0          |
| `sourceFunnel.sourceGaps.total`                           | 18                                  | 18                                  | 18                                  | stable at 18                 |
| `sourceFunnel.sourceGapsByCause.repeat-fallback`          | 1                                   | 1                                   | 1                                   | stable at 1                  |
| `sourceFunnel.sourceGapsByCause.unsupported-coverage`     | 8                                   | 8                                   | 8                                   | stable at 8                  |
| `sourceFunnel.sourceGapsByCause.missing-credential`       | 1                                   | 1                                   | 1                                   | stable at 1                  |
| `sourceFunnel.sourceGapsByCause.provider-data-missing`    | 7                                   | 7                                   | 7                                   | stable at 7                  |
| `sourceFunnel.sourceGapsByCause.reused-in-window`         | 1                                   | 1                                   | 1                                   | stable at 1                  |
| `sourceFunnel.reportSources.total`                        | 50                                  | 49                                  | 49                                  | 49–50                        |
| `evidenceLanes.coverageRatio`                             | 0.7272727272727273                  | 0.7272727272727273                  | 0.7272727272727273                  | stable at 0.7272727272727273 |
| `subsystemOutcomes.byOutcome.produced`                    | 12                                  | 12                                  | 12                                  | stable at 12                 |
| `subsystemOutcomes.byOutcome.empty`                       | 1                                   | 1                                   | 2                                   | 1–2                          |
| `subsystemOutcomes.byOutcome.declined`                    | 4                                   | 4                                   | 3                                   | 3–4                          |
| `subsystemOutcomes.byOutcome.failed`                      | 0                                   | 0                                   | 0                                   | stable at 0                  |
| `subsystemOutcomes.byOutcome.blocked`                     | 1                                   | 1                                   | 1                                   | stable at 1                  |
| `subsystemOutcomes.expectedEmptyCount`                    | 0                                   | 0                                   | 1                                   | 0–1                          |
| `equityAnalysisCompleteness.coverageLevel`                | substantial                         | substantial                         | substantial                         | stable at `substantial`      |
| `operatingKpis.status`                                    | not-assessed                        | not-assessed                        | not-assessed                        | stable at `not-assessed`     |
| Estimated tokens (`trace.json:tokenEstimate`)             | 322,692                             | 332,889                             | 363,527                             | 322,692–363,527              |

`sourceFunnel.sourceGapsByCause.provider-data-missing` is 7 in all three band
runs, 6 in the seed, and 5 in the 2026-08-11 baseline. Absolute levels are not
comparable across baselines. `05cad67` (`feat(market-data): declare sessions
dropped for a missing close`) fully explains the seed-to-band move from 6 to 7.
In `src/sources/verified-market-snapshot.ts` it maps `droppedBars`, Yahoo chart
bars with missing or non-numeric fields newer than the latest usable bar, into
a `provider-data-missing` Source Gap (`Yahoo chart bar <date> has missing or
non-numeric fields: <fields>; latest usable session is <date>`).

These runs are accepted-but-uncited, not a gather failure. Web Gather succeeded
in all three (4–5 accepted each). The 2026-08-11 Run 2 that the recording plan
says to exclude had 0 accepted. That is a different phenomenon. Keep every row
in this band. A future run
with zero accepted web sources should still be triaged, never excused by this
band. Runs 1 and 2 raised audit warning `fresh-web-unused:1`, and **both** runs'
analytics carry `webSources.usageWarning` "Accepted web-source usage is
disproportionately low; review gather relevance and synthesis citations." Run 3
(ratio 0.25) carries neither. The warning is not band-specific: historical
artifact `a0ac583` (ratio 0.20) in `data/runs/` carries the same string.

The reused Web Subject Profile's 3 firecrawl sources were cited 3/3 in every
run, including the seed (`reusedProfileWebSources = {accepted:3, reportCited:3}`
throughout). Profile sources did not crowd out fresh ones. Fresh-source citation
specifically collapsed.

That observation does not on its own isolate _fresh gather_ as the variable.
All three profile sources are firecrawl and all three are business-and-strategy
content (TensorWave, the KeyBanc forum, the Q2 results release), so provider and
content type move together across the profile/fresh split. Separating them needs
per-source attribution, not the aggregate counts.

## Utilization finding (hypothesis)

All three runs sit at ratio 0.00–0.25, far below the seed run's 0.75 and below
the 0.20–0.75 spread of the six historical AMD artifacts on disk.

Hypothesis, not established: the fresh Exa results in these three runs skew
heavily to analyst-rating content. Quoted source titles in the gather set are
upgrade, downgrade, and valuation-stance headlines. The seed run's fresh Exa
results were business and strategy items (server share, a named Helios
deployment). This repo's research-only boundary
(`src/domain/research-language.ts`) blocks that vocabulary in model-authored
prose. Quoted source text is exempt ([ADR 0001](./adr/0001-research-only-boundary.md)),
so citing such a source is not impossible, but prose built on it is hard to
frame within the gate. Implication: web utilization is sensitive to what Exa
returns that day, and rating-heavy result sets appear to depress it. Not
established. It is a testable follow-up. All three post-seed code-changing
commits have now been examined, so this finding no longer has an unexamined
code confounder. It remains a hypothesis: n=3, AMD-specific, the Exa
result-mix mechanism is unproven and untested.

Three code-changing commits separate the seed's code state from the band
commit. The seed commit `4af2fcd` sits on a separate branch, but its tree is
byte-identical to squash commit `b07e624` (both tree `43f1213788ff`), so the
lineage is checkable: `05cad67`, `7b8e426`, `e88769d`, then docs-only
`87aa497`. All three have been examined. `7b8e426` (`fix(audit): let a claim
clear posture by declaring it unverified`) is ruled out: it touches only
`post-synthesis-audit.ts` / `report-integrity-audit.ts`, which run after
citation. `e88769d` (`feat(web-evidence): stamp profile origin across reuse
hops`) is ruled out: purely additive provenance, and it explicitly leaves
`webGatherAcceptancePolicyForReuse` untouched. `05cad67` changes only
`src/sources/collector.ts`, `src/sources/verified-market-snapshot.ts`,
`src/sources/yahoo.ts`, plus two test files, `.gitignore`, `AGENTS.md`, and a
deleted `plans/improvements-1.md`. It touches no Web Gather, synthesis,
research, or citation file, so it is not a plausible cause of the web
utilization collapse. A weak indirect channel cannot be formally excluded: a
changed declared Source Gap set could in principle shift what synthesis cites.

Consequence for the AMD 0.40 that prompted this recording: 0.40 is above this
controlled band's 0.00–0.25. It is not a low outlier against 0.75. Do not
declare that incident resolved. The band is AMD-specific, n=3, and the
mechanism is unproven.

## Reading the ranges

- Web utilization is 0.00–0.25 with 4–5 accepted and 0–1 cited. That is
  genuine utilization variance on a successful Web Gather, not a zero-accepted
  gather failure.
- Final Observable Prediction counts were 4–5. Relative and range kinds were
  stable (1 and 3). Direction was present in runs 1 and 2 and absent in run 3.
  Every horizon span was 5 / 20 trading days. Uncited count was 0 in all three.
- Source Gap totals were stable at 18, with the same by-cause mix in every run.
  Evidence Lane coverage was stable at 0.7272727272727273.
- Subsystem outcomes were stable on produced (12), failed (0), and blocked (1).
  empty was 1–2 and declined was 3–4; `expectedEmptyCount` was 0, 0, 1.
- Equity Analysis Completeness `coverageLevel` stayed at `substantial`.
  `operatingKpis.status` stayed at `not-assessed`.
- Estimated tokens ranged 322,692–363,527.
- The stable `webGatherAcceptancePolicy` rows (`reused-profile-default`, seed
  dir, prior utilization `high` / 0.75, cap 3) are the proof that controlled
  warm seeding held.

These are advisory ranges from three runs, not authoritative limits.
