# Issues

Sorted by impact. Each entry stays at three lines or fewer, gives its issuer count where known, and has its evidence in the commit that changed it. The investigation logs from before this reshape are in `git show 93ea13bb:plans/issues.md`. Remove an entry when it closes.

A recovery for a withheld value is built only after `bun run sweep:sec --diff` shows that the rule publishes at least one instant on the cache and moves no other published value.

## Wrong-value risk

These publish today but may be wrong, mixed-scope, or unproven. They also cover the cases where code falls short of the AGENTS.md data rules.

- **Event Grid events issued before fad60b01 without the subject's closes.** VITROX.KL (`2026-11-05T11-14-53-208Z-f5a4cc80`) and MPI.KL (`2026-11-05T11-17-58-623Z-0089fcfc`) still hold `grid-relative-5` at p=0.5 in `report.json` (pending in `score.json`), cited only by `price-history-SPY`. If those tickers ever resolve, the events enter calibration. Left as is (2026-11-06): the name tickers 404 on Yahoo, so the events are unlikely to resolve.
- **Price performance is SPY-relative for every listing.** `spyPriceReturn*` metrics ignore the Exchange Profile benchmark.
- **USD-unit convenience translations in the legacy SEC summary.** `summarizeSecFundamentals` reads us-gaap `USD` units only, so a US-GAAP 20-F filer reporting in CNY that also tags USD convenience translations feeds those undeclared-rate values to alpha-search and, when no Financial Statements artifact exists, to Valuation Evidence. No saved run reproduces it yet.
- **Issuer Report Figures read the summary table only.** KLSE Screener's report and announcement pages hold only the "Summary of key financial information" table; cash flow, balance sheet and DPS (deep) never publish, and both code fetches read the same report through two URLs (a same-period identity rule would free the second slot). The statements are in the announcement's PDF attachment, so reaching them changes recorded requests (`equity-bursa-brief`/`-deep`).
- **Model attaches table quotes to metric references.** `equity-bursa-brief` final synthesis cited code-rendered issuer figures but added row quotes (`Revenue | 485,101 | …`, too short) and one wrong cell (34,720 vs 34,716), so the audit pruned 4 claims. `equity-bursa-deep` carries two hand-authored final-synthesis repair responses and `equity-bursa-brief` one: the recorded outputs cite the phase the lifecycle fix withholds and the trailing PE the EPS cross-check withholds.
- **Issuer Report Figure dates are not a cutoff bound.** Without a "Date Announced" line, "public by" is the provider's `publishedDate` (page metadata, can precede publication). When these figures feed an `infoCutoff` or Forecast Baseline, the run's `generatedAt` must be the public-by bound, with the provider date kept as context.
- **Issuer Report Figure scope fails closed on any cue.** A bare row with no scope caption in a table or page with a scope cue is withheld (`unproven-scope`), including an IFRS 5 total "Profit for the period" and column-split tables; a cue in unrelated prose withholds a whole page; any negation word in a continuing label, and inclusive totals worded other than "continuing and discontinued" / "including discontinued operations", are withheld too. So is a balance-sheet figure in a cued table or page unless a caption states total scope, including a bare "Total current assets" beside a held-for-sale line (IFRS 5.38 does not fix whether it includes those assets). Next step if real split tables appear: a model-supplied scope verified against a quoted caption (prompt change and `equity-bursa-*` cassette recapture).
- **Issuer `profit-before-tax` accepts a parent-scope row.** "Profit before tax attributable to owners" passes the label pattern.
- **Issuer net margin uses parent profit.** `issuer-report-net-margin-*` divides profit attributable to owners by revenue (basis says so), while the SEC rule divides income including NCI and lets parent income stand in only without NCI income. Profit for the period is already read beside it.
- **Issuer Report Figures feed no other surface.** The Business Framework (lifecycle phase), Financial Trends, and Valuation Evidence still read Yahoo or nothing on non-SEC runs.
- **Synthesis prompt names US benchmarks only.** On profiled listings code withholds a model Prediction with an off-exchange leg (`0097.KL` `pred-1` vs SPY), but the prompt never offers the Exchange Profile benchmark, so the model spends a Prediction slot on a withheld comparison.
- **US benchmark price history on profiled exchanges.** `collectPriceHistory` fetches SPY and QQQ for `0097.KL` beside `^KLSE`; QQQ is unused, and `report.md` publishes SPY 1/3/5-year returns ("quote currency USD") beside the MYR issuer. SPY stays while model relative Predictions may cite it; when it goes, switch the `-SPY` issuer-vs-benchmark history check in `tests/equity-fixture/run.test.ts` to the Exchange Profile benchmark.
- **Peer universe rejects numeric codes.** `LISTED_SYMBOL_RE` and `RESEARCH_SUBJECT_SYMBOL_RE` need a leading letter, so Bursa peers such as `3867.KL` cannot validate.
- **Capex scope beside continuing OCF.** Unproven periods publish with a `capex-scope-unproven` note (35 of 89 in the 2026-11-04 sweep); periods with nonzero discontinued investing/capex are withheld (50), with no materiality floor (NBIS FY2025 on −0.1M). Proofs come from the latest 10-K's and current 10-Q's calc linkbases, plus any older 10-K/10-Q whose linkbase the debt-face path already reads (CLFD 6m-2025/6m-2026); other older-filing periods stay unproven or withheld (CLFD 3m-2024/3m-2025 from 0001171843-26-000700). 20-F filers and filings a run does not fetch are never scanned for evidence. GPN FY2022 pairs total OCF with total capex beside continuing revenue.
- **D&A `unchecked-component-sum`.** 18 issuers and 126 annual periods (2026-10-30 cache) publish Depreciation + AmortizationOfIntangibleAssets with only a note. The proof reads the same calc linkbases as capex above (ORCL, ABBV, GLW FY2025 and AMD FY2023–25 pass). Without that proof, the D&A cash-flow pair also publishes with a note, which is an overstatement risk.
- **D&A withheld but unproven elsewhere.** AMD FY2020–22, DDOG FY2022, and DDA-below-DA at DDOG, CRM, EBAY, RIOT. These lack a component or carry a partial total and exit before any linkbase check, so recovering them needs a new rule, not a fetch; mixed-accession sums stay unprovable by any one linkbase; MSFT FY2025's calc tree has one unsplit extension line.
- **ROIC statutory-rate fallback.** Without `EffectiveIncomeTaxRateReconciliationAtFederalStatutoryIncomeTaxRate`, ROIC uses the US federal rate plus the state of incorporation. A REIT outside SIC 6798, or a pass-through with a corporate-looking name, gets the wrong rate.
- **ROIC short-term investments.** Subtracted only where the EV bridge resolves; otherwise ROIC is withheld with the bridge reason.
- **Debt filed before a discontinued-operations recast.** Publishes with a `debt-scope-unproven` note, carried in the EV/revenue and ROIC basis when the paired flow was restated by that filing. Annual Workbench rows now withhold restated revenue, so the note fires only on TTM rows and ROIC (it fired on 7 annual rows before, e.g. CLFD FY2023 2,112K beside restated 225,722K revenue). Whether the debt sat in the disposal group stays unproven; only held-for-sale evidence withholds. Provenance is the selected concept's own: VSAT FY2022 `LongTermDebt` was never re-filed, though the recast 10-K re-tagged the same total under other concepts.
- **Web figures co-cited with a deterministic source publish unchecked.** The Verified Web Figure check (ADR 0006) cannot attribute a figure to one cited source, so a claim citing web plus `extended-evidence`/`market-data`/`market-context` skips it: 133 of 224 web-cited claims (figures or not) in the 60 newest runs. Needs per-figure attribution, e.g. quotable filing text plus code-recorded metric substitutions.
- **Thousands-unit tables cannot verify.** A figure from a table headed `RM'000` fails at any scale but the bare row value, which drops the currency. The quote contract needs a way to cite the unit header (Bursa results, Phase C).
- **Outside the Verified Web Figure check.** News-kind sources, the report summary, spotlights, and `extras.webSubjectProfile` text drafted when no profile was collected.
- **Verified Web Figure parse limits** (`web-figure-verification.ts`). Dashes normalize to `-` before parsing, so a bulleted, em-dash-separated or em-dash-joined figure (`- $3.4bn`, `$6.7 billion — 58%`, `Revenue—$574.9 million`) withholds as sign-ambiguous, as does a prose aside (`($16.7 billion)`); reading the original dash and paren context would recover them (707 of 15,441 stored source figures across 79 runs are NaN on 2026-11-07). "9M" parses loosely on both sides, a word range drops its bare endpoint (`-9 to -3%` checks only -3%), and a bare number before an unparsed unit word is dropped (`5 - 6 pc`, `14 ppts`).
- **Derived diluted shares.** NI / diluted EPS diverges from the filed count with preferred dividends or rounded EPS (JPM FY2016 +8.3%, LTRX FY2017 −21%, HLIT FY2019 −5.5% in the 2026-11-05 sweep). Annual rows no longer derive a count withheld as restated; rows with no filed count still derive.
- **Legacy debt summary.** `summarizeSecFundamentals` (alpha-search `debtToMarketCap`) still subsumes a separate notes row. Aligning it needs filing faces, which alpha-search does not fetch.
- **Partial-comparative recovery** (`unsupersededDebtResolutions`). It misses a reclassification into a line outside `debtIdentityConcepts` when totals are unchanged.
- **Tagged-zero debt** (`sec-zero-borrowings-proof.ts`; only CLFD publishes). It trusts issuer tagging: an untagged, debit-tagged, or allowlist-folded borrowing passes the census.
- **EV equity components.** Preferred, NCI and temporary equity are carrying amounts, and the basis says so. Liquidation and redemption facts exist (57 and 22 cache files), but each needs a per-component check against the filing note before it can be swapped in.
- **FY-as-TTM first-filing lookup.** `firstPublicFiling` keys filed facts on concept, period key, filing date and value, so of two same-day filings carrying the same fact the last wins and the subsequent-event exemption checks that one. A composite or unmatched value keeps the selected accession and fails closed (withholds); revenue is not composite, so the workbench is unaffected. No cached hit checked.
- **FY-as-TTM rows on statements without `supersedingFacts`.** Statements saved before 06c072bd lack the field; a workbench built from them publishes FY TTM rows unchecked, and the reason sits in `suppressionReasons`, which Markdown and the Console show only when no row survives. No path rebuilds the workbench from saved statements today (`rerun-report` reuses the saved workbench); rebuilding old runs is a cache-funded decision.
- **Superseded-FY note outside the workbench.** Saved runs carry it on `consolidatedNetIncome`, `continuingIncome`, `consolidatedContinuingIncome`, `continuingDilutedEps` and `shareRepurchases`, none of which feed the workbench. Whether consolidated or continuing income should feed it is undecided.
- **Pretax `firstPublicAt`.** The standing-total branch can date a total from the other scope's equal value. Low risk; no cached hit.
- **Annualized-revenue rows read as point-in-time.** `annualizedRevenue`, `evToAnnualizedRevenue` and `marketCapToAnnualizedRevenue` carry only a revenue end date (`periodEndInput`, `financial-lens-sections.ts:1901`), so `metricPeriodLabel` labels them "As of <revenue end>" in report.md and the Console lens tiles. The fix is the span on the row, not a formatter rule.
- **Price-as-of fallbacks outside the lens tiles.** `equity-reader.ts:205`, `valuation-workbench-markdown.ts:115` and `run-workspace-valuation.ts:154` still fall back to `priceAsOf ?? quoteObservedAt`, and quote/fetch-time caption literals repeat across report and Console files; lens tiles read the frozen row since b80824e9. Candidate: one shared rendered-report model.

## Time-boxed

- **Range Paired Skill:** after the 2026-11-04 close the v2 range cohort has 31 events, ΔBrier −0.0029 [−0.0134, +0.0092]: not yet decidable, so no skill claim. Recheck before the 2027-01-15 review.
- **2026-11-18:** the AMD +20 range rows (`grid-range-20-AMD` 144ec654, `grid-range-20` 7912637b; one Forecast Event) resolve on the 11-17 close. Compare live range Brier with 0.138 model / 0.131 Gaussian reference (2026-11-04: 0.2075, n=78).

## Run cost and citations

- **Eval reference counts miss unprefixed catalog ids.** `synthesisFigureCounts` (`src/replay/eval-cases.ts`) counts only `<<metric:…>>` via `splitMetricReferences`, and has no catalog, so an unprefixed exact id that assembly now prefixes is not counted as a reference. Needs the run's `referenceMetricSections` passed in.
- **Digit-bearing names trip the uncited-figure prune.** `NUMERIC_CLAIM_PATTERN` (`post-synthesis-audit.ts`) matches the digits in "T1" and "Rev8", so TE and OUST lost their opening summary sentence; any uncited claim naming such an entity is at risk.
- **KEEL conditional forecast rejected by the parser.** The second leg was anchored at +5 instead of 0, costing one repair call.
- **Model forecasts restate the steering band (unproven defect).** 6 of 7 model range forecasts copy the +10 reference band at p 0.34–0.40 against a 0.34 base rate; 16 of 21 predictions are near base rate. Prompt guidance stays inside ADR 0003; dropping the anchor would amend it. Needs resolved Paired Skill, not a prompt change.
- **SEC excerpts.** 8–9k chars each reach specialist, instrument-evidence, market-behavior, critique and synthesis in full; all of them cite the prose. A cut would have to drop sections no stage cites, and which sections those are is unchecked.
- **Pre-quote Web Subject Profiles regenerate once.** Every saved profile predates `figureQuotes`, so reuse declines it (AAPL 4, OUST 2, AMD 1 failing figures on the newest) and the next deep run per subject pays one profile stage. Quote compliance of live stages is unmeasured; check with `eval-deep.ts --live-stages` before relying on it.

## Withheld correctly (coverage gaps)

Each of these publishes a declared Source Gap. Recover one only under the rule at the top.

- **No issuer EPS TTM on non-SEC listings.** When Yahoo trailing EPS sits below the issuer's quarter, year-to-date or financial-year basic EPS at the newest period end (`0097.KL`: 0.11 vs 13.45 sen), it, its trailing PE and the Yahoo-fallback payout ratio are withheld with an `issuer-report` gap. An issuer TTM (FY + YTD − prior YTD) needs the prior FY EPS, which the summary table does not carry.
- **Issuer IR pages are not report hosts.** Only the Exchange Profile hosts count (ADR 0006); non-SEC runs carry no issuer website, so the issuer's own IR domain cannot be recognised as primary.

- **Debt, unproven containment:** GPN, AMZN, AMAT, MELI, PYPL, XYZ, RIOT, Iridium, HLIT FY2019–24, GOOGL 2023-12-31, AVGO 2020-11-01, IBM 2018-12-31, ORCL 2023-08/11 quarter-ends and 2025-11-30/2026-02-28 (SeniorNotes).
- **Debt, unrecognized borrowing concepts:** CLSK, WULF, CORZ. Possible follow-up: accept a concept that is itself a row of a footed face (CMTL, VSAT). This needs a face fetch for unrecognized withholds and a cassette change.
- **CLFD held-for-sale:** FY2025 ROIC and 2025-09-30 (the 10-K and 10-Q disagree on the 7,468K). 2024-09-30 is settleable by exact match from the FY2025 10-K instance; left unbuilt 2026-11-04 because it needs a new fetch and a cassette change.
- **Tagged-zero widening:** 21 non-bank filers scanned 2026-11-04, and none would publish a zero. Most stop on catch-all rows (`OtherLiabilitiesNoncurrent`, `OtherAccruedLiabilities*`) or have no `Liabilities` total (CEVA, FFIV, LZB, DAKT, HURC).
- **EV bridge:** us-gaap only (no non-bank ifrs-only filer cached). Also withheld: dropped short-term-investment lines (LLY, ABBV, and eBay at 3 instants), Check Point's combined time deposits, and unreconciled temporary equity (MARA, APLD).
- **Exact-match fail-closed:** rounding drift or a newly tagged total in a comparative withholds debt the filings do prove. None in the cache (2026-11-03).
- **Pretax:** derived only from Domestic + Foreign (ORCL, PYPL).
- **Restated annual Workbench inputs:** 267 annual rows withhold an input first filed after the period's first filing (2026-11-05 sweep). Some are rounding-only re-tags (ADBE thousands→millions, CLFD dollars→thousands) or IFRS→US-GAAP switches (IREN FY2023–24, HIVE FY2024); recovery would need the as-filed original value and its own proof.

## Ruled out

Each was measured; don't reinvestigate without new evidence.

- **Note-schedule debt containment:** settles 0 instants (2026-11-04).
- **Calc-linkbase proof for catch-all rows:** would publish no zero, because every footed decomposition ends in an unprovable `Other*` leaf (2026-11-04; OLED shows the hazard).
- **Model reading of the debt note:** cannot prove containment, since title, magnitude and bound checks pass even when part of the borrowing sits in a non-debt row.
- **Discontinued-financing-flow rule for CLFD debt scope:** reverted. A flow is not a balance, and the rule over-fires (HLIT).
- **Amount equality as containment:** never proves it.
- **Fetching older filings' calc linkbases for capex/D&A:** 31 capex periods across 26 filings, ~7 real flips (all past periods), ~3 requests per filing at 1 req/s and 3 fixture recaptures; D&A gains notes only (2026-11-05). The zero-request debt-face piggyback ships instead.
- **GPN and Vistance continuing OCF:** neither filing states the split (checked 2026-11-04).

## Accepted exceptions

- Facts without an accession fall back to form + filing date as their identity (ADR 0004). 0 of 162,124 cached facts are affected.
