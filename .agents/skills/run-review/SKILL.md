---
name: run-review
description: Analyze market-bot runs and produce a ranked, evidence-backed list of fixes and improvements (output only, no code changes).
---

# Role

You are a continuous-improvement engineer for `market-bot`. Read AGENTS.md and
the docs it links (architecture, conventions, ADRs) for context and constraints.

# Inputs

- **Run dir supplied:** the path the user gives (e.g. `data/runs/<run-id>/`).
- **Natural request:** resolve phrases like "latest AAPL run" by listing
  `data/runs/` newest-first and inspecting compact JSON fields, not large raw
  artifact text.
- **Nothing supplied:** resolve a target per Step 0.

# Step 0 — Resolve the target run

**Never run the CLI when any of these hold:**

- The user supplied a run dir.
- You were invoked by another skill or subagent (notably `improve-market-runs`,
  whose Review subagent calls this skill _after_ it has already executed the
  CLI). Running here would double-run and recurse.
- A comparable recent run already exists and the user did not ask for a fresh one.

Otherwise, prefer the newest existing comparable run. Execute the CLI **only**
when the user explicitly asked for a fresh run, or no comparable run exists.

When you do run it:

1. **Nothing supplied.** The user did not supply any run dir. A deep equity run
   takes ~12 minutes of wall clock and spends live model tokens
   (a recent NBIS deep run: 584s, ~438k tokens).
2. **Delegate to a cheap subagent.** Spawn a cheap worker (`codex exec -m
gpt-5.6-luna` at medium effort, or the host's general-purpose agent on a small
   model) to execute the CLI and return only the run-dir path plus the tail of
   any failure. The purpose is **context isolation** — keeping run logs out of
   the review — not model savings; the cost is market-bot's own model calls,
   which the driving agent does not change. Say so plainly if asked.
3. **Default to one run.** Repeat same-subject runs discriminate run-to-run
   variance, but that is the most expensive axis and the least common failure.
   Do N repeats only on explicit request, and state the total cost before starting.

Map requests to commands via `src/cli/job-registry.ts`, e.g.
`bun run src/cli.ts equity NBIS --deep`, `bun run src/cli.ts crypto BTC`,
`bun run src/cli.ts research <subject>`.

Running the CLI is the only side effect this skill may cause. It never edits code.

# Step 1 — Cohort scan (mandatory, before baseline selection)

A single target-plus-baseline pair cannot tell a subject-specific defect from a
fleet-wide one, and that distinction changes rankings. Scan the existing runs
first — this costs seconds and no model tokens, because the runs are already on disk.

List `data/runs/` newest-first and extract **one compact line per run** for the
most recent runs (aim for ~6-10, and always include every run sharing the
target's `codeVersion.commit`). Per run read only:

- `analytics.json`: `symbol`, `codeVersion.commit`, `depth`,
  `predictions.count`, `predictions.targetMet`, `evidenceQuality.label`,
  `sourceFunnel.sourceGaps.total`, `evidenceLanes.coverageRatio`
- `report.json`: prediction `kind`/`subject`/`probability` tuples, and counts of
  any gap text your candidate findings rest on

Runs sharing one commit across different subjects are the highest-value slice —
they isolate subject effects with code held constant.

Then **classify every finding** before ranking:

- `subject-specific` — present only for this subject
- `systemic` — present across subjects on the same commit
- `unknown` — cohort too thin to tell; say so rather than guessing

State the classification on each finding. A systemic finding outranks a
subject-specific one of equal severity. Report the cohort as a compact table in
the output.

# Step 2 — Baseline selection

Compare the target against the most recent comparable prior run(s) using their
artifacts (`report.json`, `score.json`, `trace.json`, `analytics.json`,
`normalized/*.json`, `miss-autopsy.json`, and `data/calibration/summary.json`).

Select a baseline with the same `jobType`, `assetClass`, subject, and prediction
horizon bucket. Resolve the subject from `analytics.json:symbol`,
`report.symbol`, `instrumentId`, or prediction subjects if the report schema
differs. Prefer the newest comparable prior run; inspect older candidates only
when needed to establish comparability.

# Step 3 — Code-delta attribution (mandatory)

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

# Output

Produce a compact review with two evidence-backed sections:

1. **Improvements** — material things that improved versus the selected baseline.
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
- **Scope** — `subject-specific` / `systemic` / `unknown`, per Step 1
- **Suspected cause** — subject to the cause-verification rule below
- **Severity** + **effort**

Keep Improvements separate from Recommendations. A positive delta can coexist
with a remaining issue, but it should not be framed as work to do unless there
is still a concrete fix or follow-up.

# Cause verification (mandatory)

Evidence citations prove _what_ moved. They never prove _why_. Artifact-only
cause inference is the dominant error mode of this review — it has repeatedly
produced recommendations to build mechanisms that already exist.

Before writing a **Suspected cause** that names code behavior:

1. Locate the implicated symbol (`grep`/`Glob`, then read the relevant slice).
2. Cite it as `path/file.ts:symbolName`.
3. **Check whether the mechanism already exists before claiming it is missing.**
   "There is no X check" requires having searched for X and found nothing. When
   a mechanism exists but did not fire, the finding is _why it did not fire_ —
   usually a narrower and more valuable defect than the one you started with.
4. If you did not read the code, write `cause: unverified — read <file/symbol>
to confirm` instead of guessing. This is an acceptable outcome; a confident
   wrong cause is not.

Prefer symbol names over pinned line numbers in all citations. Line numbers in
this file have rotted before; symbol names survive refactors.

# Review checklist

Check these explicitly before final ranking:

- Prediction quality: compare prediction count, probabilities, horizon buckets,
  `nearBaseRateCount`, `informativeCount`, and `signalTargetMet`.
  - Describe `informativeCount`, `signalTargetMet`, and `nearBaseRateCount` as
    non-blocking **forecast structural telemetry** (`RunAnalytics.predictions`
    in `src/research/run-analytics.ts`; see `docs/architecture.md` and ADR 0003),
    never as signal quality or forecast accuracy.
  - When predictions are `pending` or `pending-condition`, state that forecast
    quality is unknown until resolution; do not frame kind diversity or
    probability spread as an improvement.
  - Check relative forecasts for benchmark redundancy: same primary subject and
    horizon against two broad-market benchmarks at near-identical probabilities
    restates one view. The enforced class lives in
    `BROAD_US_INDEX_BENCHMARK_SYMBOLS` (`src/forecast/observable.ts`); a pair
    that escaped it is a roster gap, not a missing gate.
- Positive deltas: compare target fulfillment, informative forecast count,
  source-gap totals/classes, web-source usage, source integrity, report
  integrity, evidence-lane coverage, forecast-completion outcome, and resolved
  miss/autopsy movement. Include only meaningful improvements, not harmless
  churn.
  - Ratio metrics can improve by a shrinking denominator. Before calling a ratio
    an improvement, check the absolute numerator too (e.g.
    `webEvidenceUtilization.ratio` against `usedCurrentRun` and
    `acceptedCurrentRun`).
- Score/autopsy state: distinguish pending horizons from resolved misses; use
  `score.json:scores[]` for current score state, separate `pending`,
  `pending-condition`, resolved hits/misses, and use `miss-autopsy.json` only
  when present.
- Calibration: compare `analytics.json:calibrationAtGeneration` and
  `data/calibration/summary.json`; note when weak/negative skill does not appear
  to affect forecast selection.
  - Prior-calibration feedback **is** injected into the synthesis prompt
    (`buildCalibrationBlock` in `src/research/calibration-context.ts`, consumed
    by `src/research/prompts/final-synthesis.ts`). Do not recommend wiring it up.
    If guidance appears ineffective, that is the finding.
  - Treat `summary.json:bins` as a hypothesis, not a fact: check how many bins
    are populated and whether the underlying forecasts are independent. Near-
    duplicate claims resolve together, so effective n is below the raw counts.
    Do not recommend probability adjustment fitted to a thin or correlated corpus.
- Source gaps: detect duplicate `(source, message)` gaps and repeated lane gap
  text (including text repeated _within_ a single gap string).
- Fresh vs reused evidence: compare `trace.json` stages,
  `normalized/evidence-bundle.json:governance.sourceGaps`, and the web subject
  profile in `report.json:extras.webSubjectProfile`; do not count reused web
  profile coverage as fresh gathering without calling it out.
  - Web-subject-profile reuse is selected before Web Gather and independently
    of Exa/fetch outcomes (`src/web-evidence/web-evidence-phase.ts`,
    `web-subject-profile-reuse.ts`); never attribute profile reuse to a fetch or
    Exa failure.
  - Reuse within the configured window (company 30d / crypto 7d / theme 7d —
    `DEFAULT_WEB_PROFILE_COMPANY_REUSE_DAYS` and siblings in `src/config.ts`,
    gated on SEC-basis currency) is intended behavior, not a defect absent a
    stated freshness SLA.
  - Treat reused profile coverage and fresh web supplementation as separate
    lanes: compare `analytics.json:webSources` (fresh) and
    `reusedProfileWebSources` (reused) distinctly. `reusedProfileWebSources` is
    emitted only when a profile was actually reused; its absence is not a gap.
  - `trace.json:webSourceSynthesisInputs[].modelVisibleText` shows whether the
    synthesis model saw a web source's text or only profile-mediated facts.
    Citation counts alone overstate direct evidence use.
- Source integrity: verify cited source IDs in report sections/predictions exist
  in `report.sources`; cite clean integrity if it prevents a false finding.
- Coverage constraints: separate local config/provider-plan gaps from synthesis
  or model behavior.
- Artifact-set drift: the persisted `normalized/` set changes over time (deep
  equity runs consolidated ~24 sidecars into `evidence-bundle.json` at
  `c28326a`). When an expected artifact is absent, check whether it moved before
  treating it as missing — and if this file names an artifact that no longer
  exists, fix this file.

# Rules

- Output the Improvements section and the ranked Recommendations section only,
  preceded by the scope/cohort/code-delta disclosure. Do NOT edit code, write
  fixes, or change anything outside the permitted CLI run in Step 0.
- Every finding must cite evidence from the artifacts. Don't guess.
- State the run reviewed, whether it was supplied or freshly executed, the
  cohort scanned, which run you used as the baseline, and the "Code delta" line.
- Use exact `file:field` citations and compact extracted values. Avoid pasting
  large `report.json` or `stages.json` snippets.
- Treat missing optional artifacts as context, not a finding, unless their
  absence blocks review quality.
- Report any web-provider failure (`fetch-failed` / `circuit-open`) as a
  **PROVIDER-INCIDENT / OBSERVABILITY** item. Recommend changes to
  retry/circuit/reuse behavior only when a same-code reproduction demonstrates
  a systematic classification defect.
