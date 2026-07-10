# Product Strategy: market-bot `research` (thematic) run type

Scope note: this is a product analysis of the `research <subject>` run type only — the
thematic-equity path defined in `src/research/subject-registry.ts`, gated through
`researchPredictionGate` in `report-assembly.ts`, and rendered as `jobType: "research"`. Grounded
in a live run (`data/runs/2026-07-08T17-50-27-637Z-bd5cbc99`, subject "biotech").

## 1. Competitive landscape

**Metaculus / Manifold** — the calibration comps. Metaculus reports a ~0.111 aggregate Brier across
thousands of resolved questions (the best public track record); Manifold ~0.168. Both track per-user
calibration curves over time. Neither sources equity evidence or ties forecasts to observable
*market* quantities — they're crowd forecasting, not research artifacts. market-bot's self-scoring
loop (`src/scoring/`, `calibration.ts`) is conceptually the same discipline but grounded in public
price data and attached to a sourced Research View — a combination neither has.

**AlphaSense** (generative search, $500M+ ARR, 88% of S&P 100) — in Jan 2026 shipped a multi-agent
research agent whose *workflow agents* auto-build "market landscapes," primers, and competitive/SWOT
analyses with transparent sourcing. This is the closest competitor to what a `research` run
*produces*, and it's ahead on breadth of premium content and company-level structure. It has no
self-scored, calibrated prediction loop.

**BlackRock iShares THRO / thematic platform** — ranks a universe of 100+ themes *daily* using
systematic signals (sentiment, price performance, crowding, valuation) to produce dynamic return
forecasts. Directly relevant to market-bot's biggest weakness: THRO covers 100+ themes where the
registry covers **8**. It's a fund/product, not a research tool, and its signals aren't publicly
explained or calibration-scored.

**ARK Invest** — transparent, conviction-driven thematic research, but no observable/scored forecasts.

**Runchey Research (AI Forecast Markets)** — the single closest comp: a 9-model AI ensemble that
estimates event probabilities, scores them via Brier when events resolve, and feeds calibration back
into future estimates. Validates market-bot's core thesis; market-bot is ahead on rigor
(deterministic observable DSL, source ledger, research-only boundary) but behind on the multi-model
ensemble being a *user-facing* output.

**Where `research` is ahead:** self-scored observable predictions + deterministic evidence lanes +
local/private + cross-run intelligence. **Where it's behind:** theme coverage (8 vs 100+),
company-level granularity (ETF-proxy only), and the fact that a run frequently lands at Evidence
Quality `low` / Research Quality `low` (as the biotech run did).

## 2. New features (prioritized for the research run type)

| Feature | Description | User Value | Effort | Where it would live | Inspired by |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Dynamic theme resolution** | When a subject misses the 8-entry registry, let the quick model *propose* a proxy ETF + representatives, then validate deterministically (listed-universe existence, ETF eligibility) exactly as `peer-universe-proposal.ts` already does for peers — surviving sets tagged `model-proposed-validated` and cached. | Removes the hard wall where any subject outside 8 keys emits zero predictions and a degraded run. | Medium — validation pattern already exists internally. | `src/research/subject-registry.ts` + new `subject-proposal.ts` mirroring `peer-universe-proposal.ts` | No external precedent; internal precedent exists |
| **Theme Catalyst Calendar** | Deterministic sidecar (`normalized/theme-catalysts.json`) that extracts dated catalysts (PDUFA dates, readouts, deal closes) the model already surfaces in prose into a structured, sourced calendar. The biotech run *manually* listed "Nov 1 2026 PDUFA," "Q3 2026 close" in free text — capture them as data. | Turns narrative catalysts into a scannable, sortable calendar tied to the proxy's forecast horizon. | Medium | `src/research/` orchestrator + renderer; Console panel | AlphaSense workflow agents; ties to catalyst-scoring goal |
| **Cross-theme leaderboard** | A Console view ranking all registered (and cached dynamic) themes by regime posture, proxy momentum vs 50/200-day, and per-`subjectKey` calibration. | Lets the operator see *which theme to research next* instead of researching one at a time blind. | Medium | `app/` + Run Artifact Index rows | BlackRock THRO daily 100+ theme ranking |
| **Constituent breadth/dispersion panel** | Fetch live quotes for the registry's representatives and compute breadth (how many are above their 50-day, return dispersion) so the run can answer whether a theme move is broad or concentrated. | Directly fills a gap the biotech run itself flagged: "the single live proxy cannot reveal whether performance is broad or concentrated among XBI constituents." | Medium | `src/research/` + reuse of `verified-market-snapshot.ts` | No direct precedent |
| **Scheduled theme-watch digest** | A research-only recurring job that re-runs a theme set and emits a deterministic "what changed since last run" delta digest (regime flip, proxy trend test, newly-resolved predictions). | The operator monitors a theme portfolio without manually re-running; stays inside the research-only boundary. | Low–Medium — Market Update Delta machinery already exists for overviews. | CLI + `app/` jobs; adapt `market-update-delta.ts` | BlackRock "monitor themes in real-time"; AlphaSense automation |

## 3. Extend or improve existing features

**Extend: Prediction proxy (`predictionProxy` in `subject-registry.ts`)**
- *Current limitation:* At most **one** listed ETF per subject, and `ai-infrastructure` has **no**
  proxy at all → `canEmitPredictions: false` → a run that produces zero scored predictions. All
  predictions in the biotech run were single-instrument XBI direction/range/conditional.
- *Proposed extension:* Support a deterministic equal-weight **representative basket** as a
  prediction subject, so themes without a clean single ETF (like `ai-infrastructure`: NVDA/ANET/VRT)
  can still emit a scored, observable basket-return forecast.
- *User value:* Every registered theme becomes scoreable, and calibration accrues even for
  basket-shaped themes.

**Extend: Representative instruments (`representativeInstruments`)**
- *Current limitation:* Representatives are cited only by registry `sourceId`; no live snapshot. The
  biotech run emitted three `researchRepresentative:` gaps (AMGN, GILD, VRTX "no live market
  snapshot") and could not cross-validate the proxy.
- *Proposed extension:* Fetch live Yahoo quotes for representatives (the equity path already does
  this) and, on `--deep`, apply the existing `verified-market-snapshot.ts` to each.
- *User value:* Kills a recurring class of source gaps and lets findings cite named companies with
  real prices, not just the ETF.

**Extend: Web Subject Profile — `theme` Subject Kind**
- *Current limitation:* The `company` kind has a 7-question fixed set with SEC-10-K-first sourcing;
  the `theme` kind (always used by `research`, per CONTEXT.md) has a looser generic profile, and the
  resulting evidence is low-trust web commentary — driving Evidence Quality to `low`.
- *Proposed extension:* Give the theme profile its own fixed, citation-checked question set (primary
  driver, beneficiaries, valuation dispersion, crowding, key debate) and let it cite
  representative-company SEC facts once representatives have snapshots (see above).
- *User value:* Raises the evidence floor for themes so runs stop bottoming out at `low`.

**Extend: `history thesis-delta`**
- *Current limitation:* Per-instrument only; there is no thematic thesis-delta even though
  `research` runs already carry `subjectKey` and the biotech run *did* load a prior same-subject run
  into Historical Context.
- *Proposed extension:* Add a subject-keyed thesis-delta so "how did my biotech thesis change since
  last week" works the way it does for a ticker.
- *User value:* Makes the cross-run intelligence the run already collects usable for themes.

## 4. UX ideas and improvements

- **Unregistered subject = silent dead end.** Today → running `research quantum computing` (not in
  the 8 keys) resolves `unresolved`, emits zero predictions, and produces a degraded run. Friction →
  the user has no way to know only 8 subjects are supported or what they are. Change → on unresolved,
  print the supported subject list and the closest alias match (the `buildAliasIndex` fuzzy
  machinery already exists). **Effort: Low.**
- **No way to discover valid subjects before running.** Today → the Console queues
  `research <subject>` as free text. Friction → new users guess and get degraded runs. Change →
  expose the registry (display names + aliases) as an autocomplete/picker in the jobs view.
  **Effort: Low–Medium.**
- **`Research Quality: low` with no "why" or "how to improve."** Today → the header stamps `low`
  (biotech run) with no cause or remediation. Friction → the operator can't tell if `--deep`, a
  different subject, or richer keys would help. Change → append the dominant driver (e.g., "web-only
  low-trust evidence; representatives lack live snapshots") and a one-line remediation.
  **Effort: Low.**
- **Data Gaps list is flat and unranked.** Today → the biotech run mixes a thesis-critical gap ("no
  live snapshots for AMGN/GILD/VRTX") with a benign one ("massive-supplemental snapshot unavailable
  on current plan") in one bullet list. Friction → the reader can't tell which gap actually caps
  quality. Change → order/tag gaps by `evidenceQualityImpact` (the field already exists on
  SourceGap). **Effort: Low–Medium.**
- **Opaque `web-gather` rejection.** Today → the run surfaces `web-gather: web_search query must
  mention the run subject` as a raw data gap. Friction → reads like an internal error, not a research
  limitation. Change → render it in plain language ("a model web query was rejected for drifting
  off-subject"). **Effort: Low.**

## 5. One moonshot

**Concept — a calibrated thematic signal index ("Metaculus for sectors, self-scored").** A public,
continuously-updated board showing, for each theme, the model's current observable forecast *and its
historical calibration on that exact `subjectKey`* — so a reader can weight the forecast by how right
the model has actually been on that theme.

- **Why this product is positioned to build it:** No competitor combines all three assets `research`
  already has — checked-in themes with stable `subjectKey`s, observable predictions in a scored DSL,
  and per-slice calibration (`calibration.ts` already slices by job type; Regime-Sliced Calibration
  exists). BlackRock's signals aren't scored publicly; Metaculus isn't equity-grounded; AlphaSense
  doesn't self-score.
- **Smallest version worth prototyping:** A nightly cron that runs `research` across the 8 registered
  themes, adds a per-`subjectKey` calibration slice, and renders one Console leaderboard page
  (reuses the cross-theme leaderboard from §2).
- **Biggest risk:** Sample size. Actionable Negative Calibration already demands 30 resolved
  predictions / 10 distinct runs per slice — per-theme calibration will read "insufficient sample"
  for months, so the board must foreground uncertainty honestly or it looks empty/unreliable early.

## 6. Quick-win plan — completed

Pulled from the highest value-to-effort ideas above:

- [x] **Ship subject discoverability.** In the unresolved branch of
   `resolveResearchSubjectProxy` (`subject-registry.ts`), return the supported display names + the
   closest alias match, and print them from the CLI. Reuses the existing alias index; turns the most
   common failure (unregistered subject → silent zero-prediction run) into a guided one. **Low.**
- [x] **Give representatives live snapshots.** Reuse the equity Yahoo quote path to fetch quotes for
   `representativeInstruments`, eliminating the recurring `researchRepresentative:` gaps and enabling
   named-company citations. **Low–Medium, immediate evidence-quality lift.**
- [x] **Emit a Theme Catalyst Calendar sidecar.** Structure the dated catalysts the model already writes
   in prose (`normalized/theme-catalysts.json` + a report panel). High reader value, self-contained,
   and advances the deterministic-catalyst goal already on the roadmap. **Medium.**

## 7. Next quick-win plan

Prioritized for low implementation risk and direct impact on `research` run usability:

1. **Render data gaps by impact.** Sort/tag report data gaps by `evidenceQualityImpact`, with
   thesis-critical and quality-capping gaps above optional/supplemental gaps. This uses fields
   already present on `SourceGap` and makes `Research Quality: low` easier to diagnose.
   **Low–Medium.**
2. **Explain the dominant quality driver.** When `researchQuality` is below `medium`, append a short
   neutral driver such as "representative snapshots missing" or "web-only low-trust evidence" plus a
   one-line remediation. Keep it deterministic where possible by deriving from Evidence Quality,
   Report Integrity, Source Plan, and Source Gap classes. **Low.**
3. **Dropped: subject registry autocomplete.** Product decision: research subject entry stays pure
   free text with no suggestions, picker, or constraints in the Console or CLI. The registry enriches
   resolved subjects after entry; it does not shape what a user may type.
4. **Humanize web-gather rejection gaps.** Render common `web-gather` validation failures in
   operator-facing language, especially off-subject query rejection, while preserving raw codes in
   artifacts. **Low.**

## Sources

- [Metaculus review / Brier track record](https://predictionmarketsreviews.com/reviews/metaculus)
- [AlphaSense generative search 2026](https://www.alpha-sense.com/resources/product-articles/generative-search-next-generation/)
- [BlackRock iShares Thematic Rotation (THRO)](https://www.blackrock.com/us/financial-professionals/insights/tomorrows-themes-today)
- [Runchey Research AI Forecast Markets](https://www.runcheyresearch.com/forecasting)
- [ForecastBench](https://arxiv.org/pdf/2409.19839)
