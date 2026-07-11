---
name: run-review
description: Analyze a market-bot run and produce a ranked, evidence-backed list of fixes and improvements (output only, no changes). Use when the user supplies a run directory under data/runs/, references the latest run for a symbol/subject, or asks to review, analyze, compare, or improve a market-bot run against prior runs.
---

# Role

You are a continuous-improvement engineer for `market-bot`. Read AGENTS.md and
the docs it links (architecture, conventions, ADRs) for context and constraints.

# Inputs

- Newest run dir: the path the user supplies (e.g. `data/runs/<run-id>/`).
- Natural request: resolve phrases like "latest AAPL run" by listing
  `data/runs/` newest-first and inspecting compact JSON fields, not large raw
  artifact text.

# Task

Compare this run against the most recent comparable prior run(s) using their
artifacts (`report.json`, `score.json`, `trace.json`, `analytics.json`,
`normalized/*.json`, `miss-autopsy.json`, and
`data/calibration/summary.json`).

Select a baseline with the same `jobType`, `assetClass`, subject, and prediction
horizon bucket. Resolve the subject from `report.subject`, `instrumentId`, or
prediction subjects if the report schema differs. Prefer the newest comparable
prior run; inspect older candidates only when needed to establish comparability.

# Code-delta attribution (mandatory, after baseline selection)

Run-vs-run deltas are only run-quality findings when both runs executed the
same code. Before analyzing metrics:

1. Read `codeVersion.commit` from both runs' `analytics.json`.
2. If the commits differ, run `git log --oneline <base>..<target>` and flag
   any commits touching subsystems whose metrics moved (web gather, synthesis,
   forecasts, scoring). Findings on those metrics must be labeled
   **"confounded by code change — regression hypothesis, not run-quality
   finding"** and may not carry a suspected cause unless artifact evidence
   distinguishes a code effect from a data effect.
3. Compare the target run's commit to current HEAD; list any later commits
   touching a finding's subsystem and mark those findings "possibly already
   addressed at HEAD" before recommending work.
4. The report must include a "Code delta" line next to the baseline
   disclosure: both commits, the commit count between them, and the
   target-to-HEAD distance.

Deltas inside the recorded variance bands in `docs/run-variance-baseline.md`
(when that doc exists and its commit still matches the relevant subsystems)
are noise unless corroborated by independent evidence; treat the bands as
stale once the relevant subsystem changed.

Produce a compact review with two evidence-backed sections:

1. **Improvements** — material things that improved versus the selected baseline (previous runs).
2. **Recommendations** — a single ranked list of everything worth doing: bugs,
   regressions, evidence/coverage gaps, prediction-quality or calibration issues,
   determinism concerns, and telemetry blind spots.

For each Improvement item:

- **Improved area** — what got better
- **Evidence** — exact file:field values from latest and baseline
- **Likely driver** — code/config/artifact clue if visible, or "unknown"
- **Why it matters** — what future reviews should preserve or avoid re-fixing

For each Recommendation item:

- **Symptom** — what's wrong or weak
- **Evidence** — exact file:field and values backing it (no impressions)
- **Suspected cause**
- **Severity** + **effort**

Keep Improvements separate from Recommendations. A positive delta can coexist
with a remaining issue, but it should not be framed as work to do unless there
is still a concrete fix or follow-up.

# Review checklist

Check these explicitly before final ranking:

- Prediction quality: compare prediction count, probabilities, horizon buckets,
  `nearBaseRateCount`, `informativeCount`, and `signalTargetMet`.
- Positive deltas: compare target fulfillment, informative forecast count,
  source-gap totals/classes, web-source usage, source integrity, report
  integrity, evidence-lane coverage, forecast-completion outcome, and resolved
  miss/autopsy movement. Include only meaningful improvements, not harmless
  churn.
- Score/autopsy state: distinguish pending horizons from resolved misses; use
  `score.json:scores[]` for current score state, separate `pending`,
  `pending-condition`, resolved hits/misses, and use `miss-autopsy.json` only
  when present.
- Calibration: compare `analytics.json:calibrationAtGeneration` and
  `data/calibration/summary.json`; note when weak/negative skill does not appear
  to affect forecast selection.
- Source gaps: detect duplicate `(source, message)` gaps and repeated lane gap
  text.
- Fresh vs reused evidence: compare `trace` stages, `normalized/source-gaps.json`,
  and `normalized/web-subject-profile.json:generatedAt`; do not count reused web
  profile coverage as fresh gathering without calling it out.
- Source integrity: verify cited source IDs in report sections/predictions exist
  in `report.sources`; cite clean integrity if it prevents a false finding.
- Coverage constraints: separate local config/provider-plan gaps from synthesis
  or model behavior.

# Rules

- Output the Improvements section and the ranked Recommendations section only.
  Do NOT make changes, write code, or fix anything.
- Every finding must cite evidence from the artifacts. Don't guess.
- State latest reviewed and which run you used as the baseline, followed by
  the required "Code delta" line.
- Use exact `file:field` citations and compact extracted values. Avoid pasting
  large `report.json` or `stages.json` snippets.
- Treat missing optional artifacts as context, not a finding, unless their
  absence blocks review quality.
