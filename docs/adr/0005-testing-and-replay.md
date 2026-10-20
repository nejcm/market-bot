# ADR 0005: Testing and replay

## Status

Accepted

## Context

Replay must exercise the production pipeline without live calls. Correctness comes from independently
re-derived properties and targeted assertions, not approving large output snapshots by hash.

## Decision

- The primary static harness mocks only HTTP `fetch` and `ModelProvider.generate`; real collection, cache,
  normalization, planning, orchestration, assembly, and validation execute. Direct `CollectedSources`
  injection belongs in narrow unit tests, not this tier.
- HTTP cassettes replay below cache; ordered LLM responses key by `stage|model`, intentionally excluding prompt
  hashes. Regression mode is offline; eval mode replays data with the configured live model and can cost money.
  Keep cassettes, `runFixture`, dev-only recorder, and replay scripts; request/parser changes may need refreshes.
- Fixture replays assert invariants only; keep **no byte-exact run-output snapshots**. Every fixture completes
  with readable `report.json`, no `failure.json`, and persists exactly its generated report, Markdown,
  analytics, outcomes, and evidence bundle. Validate persisted schema/research language, resolve every bundle
  source ID, and require `reportIntegrity: high`. Each behavior-specific fixture needs its own assertion.
- Prompt text remains pinned separately in `tests/support/prompt-baseline.golden.json`: it is input, not output.
- Live correctness invariants derive statement/history/lens/provenance/completeness/gap-triage/numeric-hygiene
  relations from freshly replayed evidence using structural compatibility and conservative minimum depths,
  never golden values or exact financial-value pins. Cover cap-shape independence, history span/sign consistency,
  balance-sheet identity, and normalized citation closure; fault injection demonstrates their alarms.
- Two checks are intentionally one-directional: currency mismatch is permitted only with a `mixed-currencies`
  omission note; every computed incomplete-statement note must surface, but extra surfaced notes are allowed.
- Balance-sheet identities use uncapped facts: prefer equity including NCI plus temporary equity; otherwise
  add separately tagged minority interest to stockholders' equity. Prefer the accession shared by assets and
  liabilities to avoid cross-filing restatements. Never skip a period because NCI/temporary equity exists.
  Tolerance is max(one unit scale, 0.1% of largest fact magnitude); smaller residuals can escape detection.
- Annual-revenue depth floor is three points for CAGR, not a second per-fixture golden or proof against
  deeper history loss. Cap-shape/history-span/sign relations supply that coverage. Corpus coverage remains
  narrow; synthetic templates are regression evidence, not broad empirical validation.
- Re-derive every composite fact from stored contributors: one basis per series, arithmetic sum within identity
  tolerance, shared period end, and source-ID closure. Contributor mutation without corresponding value must fail.
  D&A alone may mix direct/composite periods: combined selection uses the 1% component tolerance under
  [ADR 0004](./0004-evidence-and-model-stage-pipeline.md), verified against raw selected components at cutoff.
  This never relaxes arithmetic tolerance; D&A composites require each of both component groups exactly once.
- Investigate invariant failures; fix the defect or narrow by a uniformly applicable domain structure.
  Never add fixture exceptions, skip lists, or allowance ledgers to live invariants. Offline corpus comparison
  allowances are a separate contract, not live-invariant exceptions.
- Artifact readers degrade per observation only after a known schema-version gate: retain valid nested rows,
  drop unreadable rows, and return drop counts/reasons. Never collapse one retired literal into whole-artifact
  absence. Keep retired values in read-only compatibility sets, excluded from live emitted unions; do not widen
  versions or accept malformed rows. Before accepting another version, discriminate the return type or migrate
  it to the declared live version; unchecked casts cannot relabel a newer payload as version 1.
- Standalone recording and opt-in Replay Capture canonicalize requests and reject known credentials through
  `scripts/fixture-secret-scan.ts`. `MARKET_BOT_CAPTURE_REPLAY` defaults off globally for research runs;
  when enabled, wrap source HTTP and every model request before collection, including peers/challengers.
  Explicit metadata identifies prose-only stages without changing prompts. Store engineering capture only at
  `<run>/replay/`, outside report fields/index projections.
- Captures contain versioned metadata, allowlisted effective settings, ordered HTTP/model cassettes, consumed
  cache/cross-run state, and versioned Final-Synthesis Input with embedded responses. Retain HTTP status and
  transport/model failures as failures. Large HTTP/state bodies, and Final-Synthesis Input `rawSnapshots` /
  `secTargetPacket` subtrees over 32 KB (as `{"$replayBody": <sha256>}` → `bodies/<sha256>.json`, a key
  capture refuses in payloads), are content-addressed; readers check hashes and path containment. Redact credentials, configured SEC contact identities, and local paths before recording;
  never store request auth headers.
- Publish captures only by renaming validated, secret-scanned private partial directories. Handled failure
  removes only private capture staging, never research artifacts, never invalidates research, and never publishes
  a ready capture. Optional `capture-failure.json` excludes credential-bearing errors. Captures, private partials,
  and failure markers are excluded from Run Artifact Index file projections and Console browsing/read endpoints.
- Strict replay requires the consumed clock, cache entries/fallbacks, host circuit decisions, news-seen,
  learned peers, Historical Research Context, Calibration, profile reuse, and alpha context. Recorded absence
  differs from missing recordings: an unrecorded dependency fails replay. All mutable writes stay inside the
  isolated sample root, never production state.
- Direct final-synthesis replay shares production prompt construction, phase retries, and deterministic
  post-audit functions. Validate input version/settings/evidence/context/source identities; reload current
  Domain Playbooks by default. Direct outputs are partial: no upstream collection, Forecast Disagreement,
  scoring, or production state writers.
- Offline direct scripts accept no live flags. Only `eval-deep.ts` may evaluate saved synthesis inputs live,
  after offline planning and explicit batch approval. Live fixture eval uses `eval-deep.ts --yes` or
  `replay-fixture-run.ts --live --yes` only after that approval; without `--yes` print plan/estimate and spend
  nothing. Offline fixture pacing/retry waits are skipped only through harness-scoped context, never env flags.
- Deterministic report reruns project saved normalized evidence, validate/render into fresh
  `data/evals/<label>/` roots, and never change original Run Artifacts. Missing canonical files fail; recorded
  null stays absence. No live evaluation writes to `data/runs/`.
- Deleting a pipeline stage is a human decision. It needs judged `eval-deep.ts --input --ablate` samples of
  that stage's isolated arm whose statistics meet the rule pre-registered in `docs/testing.md` (metric,
  margin and sample size fixed before any arm runs); a joint arm never supports deleting one of its stages.

## Consequences

- Output drift that violates no invariant is invisible to CI; meaningful behavior needs a targeted assertion.
- Replay correctness checks add artifact traversal, not provider/model work. Stage/model cassettes do not prove
  changed prompt behavior; prompt baselines and approved Frozen-Input Evals address that separately.
- Strict captures fail closed on missing dependencies while capture failure leaves research output usable.
- Partial reader loss stays visible, and schema evolution cannot silently misrepresent artifact versions.
