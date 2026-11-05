# Issues

Sorted by impact. Each entry stays at three lines or fewer, gives its issuer count where known, and has its evidence in the commit that changed it. The investigation logs from before this reshape are in `git show 93ea13bb:plans/issues.md`. Remove an entry when it closes.

A recovery for a withheld value is built only after `bun run sweep:sec --diff` shows that the rule publishes at least one instant on the cache and moves no other published value.

## Wrong-value risk

These publish today but may be wrong, mixed-scope, or unproven. They also cover the cases where code falls short of the AGENTS.md data rules.

- **Event Grid events issued before fad60b01 without the subject's closes.** VITROX.KL (`2026-11-05T11-14-53-208Z-f5a4cc80`) and MPI.KL (`2026-11-05T11-17-58-623Z-0089fcfc`) still hold `grid-relative-5` at p=0.5 in `outcomes.json`, cited only by `price-history-SPY`. If those tickers ever resolve, the events enter calibration. Left as is (2026-11-06): the name tickers 404 on Yahoo, so the events are unlikely to resolve.
- **Unresolved Bursa ticker runs every model stage.** Yahoo returns a `quoteType: NONE` stub, yet both runs spent ~221–225k estimated tokens on web-only reports, and the availability classifier counts any raw `yahoo-ticker` payload as available (`provider-endpoint-availability.ts`). Bursa codes are numeric (`0097.KL`, `3867.KL` return MYR history). Planned: verify web-cited figures in every run, then an identity gate before model stages, identity-based US classification (`KL` is missing from `NON_US_SUFFIXES`) and content-based availability.
- **Capex scope beside continuing OCF.** Unproven periods publish with a `capex-scope-unproven` note (35 of 89 in the 2026-11-04 sweep); periods with nonzero discontinued investing/capex are withheld (50), with no materiality floor (NBIS FY2025 on −0.1M). Proofs come from the latest 10-K's and current 10-Q's calc linkbases, plus any older 10-K/10-Q whose linkbase the debt-face path already reads (CLFD 6m-2025/6m-2026); other older-filing periods stay unproven or withheld (CLFD 3m-2024/3m-2025 from 0001171843-26-000700). 20-F filers and filings a run does not fetch are never scanned for evidence. GPN FY2022 pairs total OCF with total capex beside continuing revenue.
- **D&A `unchecked-component-sum`.** 18 issuers and 126 annual periods (2026-10-30 cache) publish Depreciation + AmortizationOfIntangibleAssets with only a note. The proof reads the same calc linkbases as capex above (ORCL, ABBV, GLW FY2025 and AMD FY2023–25 pass). Without that proof, the D&A cash-flow pair also publishes with a note, which is an overstatement risk.
- **D&A withheld but unproven elsewhere.** AMD FY2020–22, DDOG FY2022, and DDA-below-DA at DDOG, CRM, EBAY, RIOT. These lack a component or carry a partial total and exit before any linkbase check, so recovering them needs a new rule, not a fetch; mixed-accession sums stay unprovable by any one linkbase; MSFT FY2025's calc tree has one unsplit extension line.
- **ROIC statutory-rate fallback.** Without `EffectiveIncomeTaxRateReconciliationAtFederalStatutoryIncomeTaxRate`, ROIC uses the US federal rate plus the state of incorporation. A REIT outside SIC 6798, or a pass-through with a corporate-looking name, gets the wrong rate.
- **ROIC short-term investments.** Subtracted only where the EV bridge resolves; otherwise ROIC is withheld with the bridge reason.
- **Debt filed before a discontinued-operations recast.** Publishes with a `debt-scope-unproven` note, carried in the EV/revenue and ROIC basis when the paired flow was restated by that filing. Annual Workbench rows now withhold restated revenue, so the note fires only on TTM rows and ROIC (it fired on 7 annual rows before, e.g. CLFD FY2023 2,112K beside restated 225,722K revenue). Whether the debt sat in the disposal group stays unproven; only held-for-sale evidence withholds. Provenance is the selected concept's own: VSAT FY2022 `LongTermDebt` was never re-filed, though the recast 10-K re-tagged the same total under other concepts.
- **Web-cited figures publish unchecked.** The integrity audit only requires a current citation (`report-integrity-audit.ts`, `post-synthesis-audit.ts`), so a model-stated "RM1.13bn revenue [web-…]" publishes without code matching it to the source text. Affects every run with Web Gather.
- **Derived diluted shares.** NI / diluted EPS diverges from the filed count with preferred dividends or rounded EPS (JPM FY2016 +8.3%, LTRX FY2017 −21%, HLIT FY2019 −5.5% in the 2026-11-05 sweep). Annual rows no longer derive a count withheld as restated; rows with no filed count still derive.
- **Legacy debt summary.** `summarizeSecFundamentals` (alpha-search `debtToMarketCap`) still subsumes a separate notes row. Aligning it needs filing faces, which alpha-search does not fetch.
- **Partial-comparative recovery** (`unsupersededDebtResolutions`). It misses a reclassification into a line outside `debtIdentityConcepts` when totals are unchanged.
- **Tagged-zero debt** (`sec-zero-borrowings-proof.ts`; only CLFD publishes). It trusts issuer tagging: an untagged, debit-tagged, or allowlist-folded borrowing passes the census.
- **EV equity components.** Preferred, NCI and temporary equity are carrying amounts, and the basis says so. Liquidation and redemption facts exist (57 and 22 cache files), but each needs a per-component check against the filing note before it can be swapped in.
- **FY-as-TTM first-filing lookup.** `firstPublicFiling` keys filed facts on concept, period key, filing date and value, so of two same-day filings carrying the same fact the last wins and the subsequent-event exemption checks that one. A composite or unmatched value keeps the selected accession and fails closed (withholds); revenue is not composite, so the workbench is unaffected. No cached hit checked.
- **FY-as-TTM rows on statements without `supersedingFacts`.** Statements saved before 06c072bd lack the field; a workbench built from them publishes FY TTM rows unchecked, and the reason sits in `suppressionReasons`, which Markdown and the Console show only when no row survives. No path rebuilds the workbench from saved statements today (`rerun-report` reuses the saved workbench); rebuilding old runs is a cache-funded decision.
- **Superseded-FY note outside the workbench.** Saved runs carry it on `consolidatedNetIncome`, `continuingIncome`, `consolidatedContinuingIncome`, `continuingDilutedEps` and `shareRepurchases`, none of which feed the workbench. Whether consolidated or continuing income should feed it is undecided.
- **Pretax `firstPublicAt`.** The standing-total branch can date a total from the other scope's equal value. Low risk; no cached hit.
- **Annualized-revenue rows read as point-in-time.** `annualizedRevenue`, `evToAnnualizedRevenue` and `marketCapToAnnualizedRevenue` carry only a revenue end date (`periodEndInput`, `financial-lens-sections.ts:1894`), so `metricPeriodLabel` labels them "As of <revenue end>" in report.md and the Console lens tiles. The fix is the span on the row, not a formatter rule.
- **Price-as-of fallbacks outside the lens tiles.** `equity-reader.ts:203`, `valuation-workbench-markdown.ts:115` and `run-workspace-valuation.ts:154` still fall back to `priceAsOf ?? quoteObservedAt`, and quote/fetch-time caption literals repeat across report and Console files; lens tiles read the frozen row since b80824e9. Candidate: one shared rendered-report model.

## Time-boxed

- **Range Paired Skill:** after the 2026-11-04 close the v2 range cohort has 31 events, ΔBrier −0.0029 [−0.0134, +0.0092]: not yet decidable, so no skill claim. Recheck before the 2027-01-15 review.
- **2026-11-18:** the AMD +20 range rows (`grid-range-20-AMD` 144ec654, `grid-range-20` 7912637b; one Forecast Event) resolve on the 11-17 close. Compare live range Brier with 0.138 model / 0.131 Gaussian reference (2026-11-04: 0.2075, n=78).

## Run cost and citations

- **Eval reference counts miss unprefixed catalog ids.** `synthesisFigureCounts` (`src/replay/eval-cases.ts`) counts only `<<metric:…>>` via `splitMetricReferences`, and has no catalog, so an unprefixed exact id that assembly now prefixes is not counted as a reference. Needs the run's `referenceMetricSections` passed in.
- **Digit-bearing names trip the uncited-figure prune.** `NUMERIC_CLAIM_PATTERN` (`post-synthesis-audit.ts`) matches the digits in "T1" and "Rev8", so TE and OUST lost their opening summary sentence; any uncited claim naming such an entity is at risk.
- **KEEL conditional forecast rejected by the parser.** The second leg was anchored at +5 instead of 0, costing one repair call.
- **Model forecasts restate the steering band (unproven defect).** 6 of 7 model range forecasts copy the +10 reference band at p 0.34–0.40 against a 0.34 base rate; 16 of 21 predictions are near base rate. Prompt guidance stays inside ADR 0003; dropping the anchor would amend it. Needs resolved Paired Skill, not a prompt change.
- **SEC excerpts.** 8–9k chars each reach specialist, instrument-evidence, market-behavior, critique and synthesis in full; all of them cite the prose. A cut would have to drop sections no stage cites, and which sections those are is unchecked.
- **AMD earnings date.** It stays provider-estimated. The issuer release was never gathered (runs 10-20, 10-23), and the ir.amd.com calendar fails the future-tense check.

## Withheld correctly (coverage gaps)

Each of these publishes a declared Source Gap. Recover one only under the rule at the top.

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
