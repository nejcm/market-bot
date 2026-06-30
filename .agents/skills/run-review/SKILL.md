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

Produce a single ranked list of everything worth doing: bugs, regressions,
evidence/coverage gaps, prediction-quality or calibration issues, determinism
concerns, telemetry blind spots, and improvements.

For each item:

- **Symptom** — what's wrong or weak
- **Evidence** — exact file:field and values backing it (no impressions)
- **Suspected cause**
- **Severity** + **effort**

# Review checklist

Check these explicitly before final ranking:

- Prediction quality: compare prediction count, probabilities, horizon buckets,
  `nearBaseRateCount`, `informativeCount`, and `signalTargetMet`.
- Score/autopsy state: distinguish pending horizons from resolved misses; use
  `miss-autopsy.json` only when present.
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

- Output the list only. Do NOT make changes, write code, or fix anything.
- Every finding must cite evidence from the artifacts. Don't guess.
- State latest reviewed and which run you used as the baseline.
- Use exact `file:field` citations and compact extracted values. Avoid pasting
  large `report.json` or `stages.json` snippets.
- Treat missing optional artifacts as context, not a finding, unless their
  absence blocks review quality.
