# TODO

## Known gaps vs AGENTS.md data rules

Current behavior short of the Financial data best practices in AGENTS.md. Close each as its own change with tests; remove the line when closed.

- EV preferred stock and temporary equity are carrying amounts, not market or redemption value.
- ROIC subtracts short-term investments only where the EV bridge resolves (us-gaap facts, current artifact keys); otherwise it is withheld with the bridge reason, like net debt.
- D&A is withheld when filed lines prove the selected value incomplete: AMD FY2020–25 (FY2023 $642M + $2,811M = $3,453M cash-flow D&A; FY2022 $4,174M), DDOG FY2022, and DDA-below-DA splits at DDOG, CRM, EBAY and RIOT. Publishing the totals needs cash-flow statement placement plus the calculation linkbase; a footing check on the latest 10-K (~170 src lines) would recover only AMD FY2023–25 from cached filings, so it is not built.
- D&A component sums (Depreciation + AmortizationOfIntangibleAssets) with no cash-flow D&A line are published but unverifiable: 18 issuers / 179 annual periods (INTC, ABBV, MSFT, ORCL, AVGO among them); a missing COGS or other amortization line goes undetected.
- ROIC's statutory-rate fallback uses the US federal rate only and the current `stateOfIncorporation`. A REIT outside SIC 6798 or a pass-through with a corporate-looking name is not caught; a filer-tagged `EffectiveIncomeTaxRateReconciliationAtFederalStatutoryIncomeTaxRate` would be the sourced alternative.
- Capex carries no operations-scope tag and is used as reported beside continuing OCF (the FCF basis says so); AMD's 2025 10-Q discontinued-operations capex extension is excluded unchecked. IFRS issuers have no continuing-OCF concept, so their discontinued periods are not checked.

## Possible wrong or false values

- Prior-run `dataGaps` reach every stage through `historicalContext` (`src/research/historical-context.ts:450`) now labeled prior-run observations to re-check (`priorRunDataGapsUse`) but not code-checked, so a gap later disproved can still be echoed (AMD 6349c37b "Data Center margins … not quantified"); label effect unevaluated. The check-sources prompt rule covers new declarations only; the HLIT RPO and final-synthesis cases are unevaluated (2-sample specialist eval only).

## Withheld but recoverable

- Debt: same-filing LongTermDebt scope rules withhold the latest debt for QCOM, CLSK, WULF, RIOT, XYZ, PYPL, RKLB and CORZ; non-commercial-paper current instruments beside a current-maturities line withhold AMZN, AMAT, GPN and MELI. The accession's balance-sheet presentation (via `FilingSummary.xml`) would recover most; PYPL also needs principal-to-carrying reconciliation, CORZ maturity evidence. When the newest instant is withheld, no older amount is published as latest debt.
- Debt: the noncurrent liabilities identity's allowlist fails closed on double tags (AMAT pension) and untagged lines (UBER reserves); a zero-valued unrecognized borrowing tag (Iridium FY2017) refuses the component sum.
- Debt: historical instants have no face-statement proof because runs fetch only the latest 10-K/10-Q faces (`faceDebtLines` requires `reportDate === periodEnd`); HLIT FY2019–2024 EV/revenue is withheld as `debt-unavailable` (split convertible and loan tags with no reconcilable total). Recovery needs per-FY 10-K face fetches, and the face proof's existing scope, lease and accession checks.
- ORCL has no canonical TTM revenue (peer-excluded): Q1 FY27 is tagged only as `RevenueFromContractWithCustomerExcludingAssessedTax` beside annual-only `Revenues`; switching concepts needs proof that both share scope across periods.
- CLFD FY2025 ROIC is withheld: debt and factoring sit in liabilities held for sale (10-K 0001171843-25-007594); publishing needs a continuing-operations debt scope rule.
- EV Bridge covers us-gaap only: IFRS filers (BNS) withhold EV, net debt and EV/revenue until `ifrs-full` current investments and `NoncontrollingInterests` are mapped.
- EV Bridge withholds for a dropped short-term investments line (LLY, ABBV, eBay), a combined cash-and-investments line above cash + short-term (Check Point FY2025 time deposits), or unreconciled temporary equity (MARA, APLD).

## Forecasts and evaluation

- After AMD earnings (2026-11-03) resolve the 10-20 runs' forecasts, rerun calibration and compare live range Brier with the 0.131/0.138 pre-change figures.
- Paired Skill excludes v1 range baselines (bc9fc853); check the v2 range cohort size before the 2027-01-15 review.
- Recapture the nbis, depository and earnings-release fixtures with an authorized live capture; their QQQ history entries are synthetic 503s.

## Run cost and citations

- SEC evidence summaries carry the whole bounded section packet plus `[Key Disclosures]` (HLIT 10-Q summary 9,061 chars) per extendedEvidence stage; the HLIT 10-K Key Disclosures repeats the top-10 customer sentence in two wordings.
- Final synthesis may invent peer source IDs on its first attempt (run 6349c37b: 3 retries, 233k tokens); measure the retry count on the next live runs.
- Final synthesis peer-median comparisons can omit peer sources (run a008bf63 bearCase[1]).
- Uncited deterministic "VIX term structure contango" bullet in `report.md` (0600df32, b35e25a2); the `market-yahoo-equity-^vix3m` source exists but the bullet carries no source ID.
- Earnings-date confirmation never gathered the AMD issuer release in runs 10-20/10-23, so the date stays provider-estimated; the ir.amd.com calendar page fails the future-tense check.
