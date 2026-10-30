# TODO

## Known gaps vs AGENTS.md data rules

Current behavior short of the Financial data best practices in AGENTS.md. Close each as its own change with tests; remove the line when closed.

- EV preferred stock and temporary equity are carrying amounts, not market or redemption value.
- ROIC subtracts short-term investments only where the EV bridge resolves (us-gaap facts, current artifact keys); otherwise it is withheld with the bridge reason, like net debt.
- D&A is withheld when filed lines prove the selected value incomplete (AMD FY2023–25 now publish the same-filing cash-flow pair): AMD FY2020–22 (FY2022 $626M + $3,548M = $4,174M has no intangible-amortization component to bound the add-back; FY2020–21 file one line only), DDOG FY2022, and DDA-below-DA splits at DDOG, CRM, EBAY and RIOT. Publishing the rest needs cash-flow statement placement plus the calculation linkbase.
- D&A component sums (Depreciation + AmortizationOfIntangibleAssets) with no cash-flow D&A line publish with an `unchecked-component-sum` note (2026-10-30 cache: 18 issuers / 126 annual periods, plus interim sums). Same-filing face verification was tried and dropped: name-pattern iXBRL scanning cannot prove the row set (extension names, nesting, units). MSFT FY2025 face `msft:DepreciationAmortizationAndOther` $34,153M vs 28.0B components (scope unproven); INTC face rows match companyfacts. Closing it needs the calculation linkbase or a model reading of the statement.
- The D&A cash-flow pair (`OtherDepreciationAndAmortization` + `AdjustmentForAmortization`, AMD FY2023–25) publishes overstated if an issuer's `OtherDepreciationAndAmortization` already includes intangible amortization and it also tags a small unrelated `AdjustmentForAmortization`; the guards bound the add-back by intangible amortization, not the face line's scope. No issuer in the 2026-10-28 sweep reproduces this.
- ROIC's statutory-rate fallback uses the US federal rate only and the current `stateOfIncorporation`. A REIT outside SIC 6798 or a pass-through with a corporate-looking name is not caught; a filer-tagged `EffectiveIncomeTaxRateReconciliationAtFederalStatutoryIncomeTaxRate` would be the sourced alternative.
- Capex carries no operations-scope tag and is used as reported beside continuing OCF (the FCF basis says so); AMD's 2025 10-Q discontinued-operations capex extension is excluded unchecked. IFRS issuers have no continuing-OCF concept, so their discontinued periods are not checked.

## Possible wrong or false values

None open.

## Withheld but recoverable

- Debt: a footed same-filing face whose rows carry LongTermDebt and the other compared lines as the same concepts now settles LongTermDebt scope (QCOM 0000804328-26-000086 $15,270M, RKLB 0001819994-26-000062 $14,845k); without that face the old withhold stands. GPN (0001123360-26-000084) stays withheld: its face rows are separate, but its LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities total is off-face, so recovery needs every reconciliation leg face-proven. Also still withheld (calc linkbases checked 2026-10-30; none proves containment): AMZN (ShortTermBorrowings and LongTermDebtCurrent sit inside accrued liabilities, no arc links them), AMAT (LongTermDebtCurrent is a note-only tag beside face ShortTermBorrowings, no arc), MELI (calc puts LinesOfCreditCurrent inside note LongTermDebtAndCapitalLeaseObligationsCurrent, which matches face LoansPayableCurrent only by amount), PYPL (current portion inside accrued liabilities; LongTermDebt is a principal schedule, so it also needs principal-to-carrying reconciliation), XYZ (note-only LongTermDebt equals face OtherLongTermDebtNoncurrent only by amount), RIOT (LongTermDebt is a principal-schedule total; the face does not foot in the parser). CLSK (LoansPayable) and WULF (ConvertibleDebt) are withheld as unrecognized borrowing concepts, and CORZ for omitted DebtCurrent/Combined (also needs maturity evidence). Amount equality never proves containment. When the newest instant is withheld, no older amount is published as latest debt.
- Debt: the complete-path face check runs only when every gross line is its own same-accession face row; a total off the face (e.g. `LongTermDebt` beside face legs) is not checked, and the face-less legacy summary (`summarizeSecFundamentals`, alpha-search) still subsumes a separate notes row.
- Debt: the noncurrent liabilities identity's allowlist fails closed on double tags (AMAT pension) and untagged lines (UBER reserves). Iridium stays withheld: FY2017 and FY2020 hit the LinesOfCreditCurrent-beside-LongTermDebtCurrent rule, 2020 quarters omit LongTermDebt.
- Debt: historical instants have no face-statement proof because runs fetch only the latest 10-K/10-Q faces (`faceDebtLines` requires `reportDate === periodEnd`); HLIT FY2019–2024 EV/revenue is withheld as `debt-unavailable` (split convertible and loan tags with no reconcilable total). Recovery needs per-FY 10-K face fetches, and the face proof's existing scope, lease and accession checks.
- Revenue concept: a newer lower-priority tag (ORCL `RevenueFromContractWithCustomerExcludingAssessedTax` to Q1 FY27) replaces annual-only `Revenues` only when, after the same restatement selection and 10-period annual cap over both tags' periods, it carries every capped `Revenues` period at the same value and one filing tags both for the newest one (ORCL 10-K 0001193125-26-277521, FY26 $67,357M); any mismatch, superseded anchor, or missing year keeps the withhold; ORCL TTM is now $71,776M. Without that same-accession dual tag the higher-priority tag stays and TTM is withheld. MSFT revenue TTM is still withheld for an unrelated reason (`unreconciled-ttm`: no latest-end interim starts at the FY boundary in the cached payload; not investigated).
- CLFD FY2025 ROIC is withheld: debt and factoring sit in liabilities held for sale (10-K 0001171843-25-007594); publishing needs a continuing-operations debt scope rule.
- EV Bridge covers us-gaap only: IFRS filers (BNS) withhold EV, net debt and EV/revenue until `ifrs-full` current investments and `NoncontrollingInterests` are mapped.
- EV Bridge withholds for a dropped short-term investments line (LLY, ABBV: face line removed in 2026 10-Qs and folded into "other current assets"/"prepaid expenses and other", so the amount is not separable; eBay: face line tagged `ebay:ShortTermInvestmentsExcludingEquitySecuritiesAccountedForUnderFairValueOption`, absent from companyfacts, needs the filing's own XBRL instance), a combined cash-and-investments line above cash + short-term (Check Point FY2025 time deposits), or unreconciled temporary equity (MARA, APLD).

## Forecasts and evaluation

- After AMD earnings (2026-11-03) resolve the 10-20 runs' forecasts, rerun calibration and compare live range Brier with the 0.131/0.138 pre-change figures.
- Paired Skill excludes v1 range baselines (bc9fc853); check the v2 range cohort size before the 2027-01-15 review.
- Recapture the nbis, depository and earnings-release fixtures with an authorized live capture; their QQQ history entries are synthetic 503s.

## Run cost and citations

- SEC evidence summaries carry the whole bounded section packet plus `[Key Disclosures]` (HLIT 10-Q summary 9,061 chars) per extendedEvidence stage.

- Final synthesis peer-median comparisons can omit peer sources (run a008bf63 bearCase[1]).
- Earnings-date confirmation never gathered the AMD issuer release in runs 10-20/10-23, so the date stays provider-estimated; the ir.amd.com calendar page fails the future-tense check.
