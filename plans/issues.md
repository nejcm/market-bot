# Issues

Sorted by impact. Each entry stays at three lines or fewer, gives its issuer count where known, and has its evidence in the commit that changed it. The investigation logs from before this reshape are in `git show 93ea13bb:plans/issues.md`. Remove an entry when it closes.

A recovery for a withheld value is built only after `bun run sweep:sec --diff` shows that the rule publishes at least one instant on the cache and moves no other published value.

## Wrong-value risk

These publish today but may be wrong, mixed-scope, or unproven. They also cover the cases where code falls short of the AGENTS.md data rules.

- **Capex scope beside continuing OCF.** Unproven periods publish with a `capex-scope-unproven` note (35 of 89 in the 2026-11-04 sweep); periods with nonzero discontinued investing/capex are withheld (50), with no materiality floor (NBIS FY2025 on −0.1M). Only 10-K calc linkbases are fetched, so interim/TTM periods are never proven (AMD YTD and lens TTM FCF, CLFD quarters); 20-F filers and filings a run does not fetch are never scanned for evidence. GPN FY2022 pairs total OCF with total capex beside continuing revenue.
- **D&A `unchecked-component-sum`.** 18 issuers and 126 annual periods (2026-10-30 cache) publish Depreciation + AmortizationOfIntangibleAssets with only a note. The proof reads only the latest 10-K's calc linkbase (ORCL, ABBV, GLW FY2025 and AMD FY2023–25 pass). Without that proof, the D&A cash-flow pair also publishes with a note, which is an overstatement risk.
- **D&A withheld but unproven elsewhere.** AMD FY2020–22, DDOG FY2022, and DDA-below-DA at DDOG, CRM, EBAY, RIOT. Each needs the linkbase of the older 10-K that supplied the period; MSFT FY2025's calc tree has one unsplit extension line.
- **ROIC statutory-rate fallback.** Without `EffectiveIncomeTaxRateReconciliationAtFederalStatutoryIncomeTaxRate`, ROIC uses the US federal rate plus the state of incorporation. A REIT outside SIC 6798, or a pass-through with a corporate-looking name, gets the wrong rate.
- **ROIC short-term investments.** Subtracted only where the EV bridge resolves; otherwise ROIC is withheld with the bridge reason.
- **CLFD FY2023 ROIC.** Unchecked mixed scope: the 2,112K DebtCurrent is Nestor factoring debt against continuing revenue. EV/revenue is withheld; ROIC is not. Debt scope has to move into debt resolution so EV, Console and ROIC agree.
- **Legacy debt summary.** `summarizeSecFundamentals` (alpha-search `debtToMarketCap`) still subsumes a separate notes row. Aligning it needs filing faces, which alpha-search does not fetch.
- **Partial-comparative recovery** (`unsupersededDebtResolutions`). It misses a reclassification into a line outside `debtIdentityConcepts` when totals are unchanged.
- **Tagged-zero debt** (`sec-zero-borrowings-proof.ts`; only CLFD publishes). It trusts issuer tagging: an untagged, debit-tagged, or allowlist-folded borrowing passes the census.
- **EV equity components.** Preferred, NCI and temporary equity are carrying amounts, and the basis says so. Liquidation and redemption facts exist (57 and 22 cache files), but each needs a per-component check against the filing note before it can be swapped in.
- **Pretax `firstPublicAt`.** The standing-total branch can date a total from the other scope's equal value. Low risk; no cached hit.

## Time-boxed

- **2026-11-04 close (21:00Z):** score pass, then calibration. The v2 range Paired Skill cohort should reach ~37 events, past the 30-event floor (last: 21 events, ΔBrier −0.0050 [−0.0200, 0.0122]). No skill claim below the floor. Recheck before the 2027-01-15 review.
- **2026-11-18:** the AMD +20 range rows (`grid-range-20-AMD` 144ec654, `grid-range-20` 7912637b; one Forecast Event) resolve on the 11-17 close. Compare live range Brier with 0.138 model / 0.131 Gaussian reference (2026-11-04: 0.2075, n=78).

## Run cost and citations

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

## Ruled out

Each was measured; don't reinvestigate without new evidence.

- **Note-schedule debt containment:** settles 0 instants (2026-11-04).
- **Calc-linkbase proof for catch-all rows:** would publish no zero, because every footed decomposition ends in an unprovable `Other*` leaf (2026-11-04; OLED shows the hazard).
- **Model reading of the debt note:** cannot prove containment, since title, magnitude and bound checks pass even when part of the borrowing sits in a non-debt row.
- **Discontinued-financing-flow rule for CLFD debt scope:** reverted. A flow is not a balance, and the rule over-fires (HLIT).
- **Amount equality as containment:** never proves it.
- **GPN and Vistance continuing OCF:** neither filing states the split (checked 2026-11-04).

## Accepted exceptions

- Facts without an accession fall back to form + filing date as their identity (ADR 0004). 0 of 162,124 cached facts are affected.
