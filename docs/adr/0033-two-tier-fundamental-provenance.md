# Two-tier fundamental provenance for Financial Lens

Financial Lens ratios are sourced from two tiers: SEC EDGAR facts (US listings, deterministic from raw XBRL) and Yahoo quote fields (all listings, pre-computed by Yahoo). SEC is preferred for filing-intrinsic ratios (ROE, ROA, D/E, Dividend Payout) where it is authoritative; Yahoo is preferred for price-relative ratios (PE, PBV) where its TTM-based definition is more accurate than a partial-year SEC computation. Yahoo also serves as the fallback for non-US listings where SEC EDGAR is gated off. Each metric's `sourceIds` record which tier supplied it.

## Yahoo fields are snapshot-sourced

Yahoo fundamental fields are captured once in `normalizeYahooQuote` onto a typed optional `MarketSnapshot.fundamentals` sub-object (single parse point), then the `yahoo-fundamentals` ExtendedEvidenceItem is derived from the normalized snapshot — not from the raw quote payload. This mirrors how `addValuationEvidence` derives an item from `marketSnapshots` and keeps the lens immune to the Massive quote fallback, which replaces the `yahoo-ticker` payload with a non-Yahoo shape carrying none of these fields: in that case `snapshot.fundamentals` is absent and no Yahoo item is produced (no crash, no metric).

## Dividend Payout posture is SEC-only

The Forbes "below 80%" sustainability threshold contributes a Financial Strength posture criterion (`<= 0.8`) **only when the payout is SEC-derived** (`abs(dividendsPaid) / netIncome`). The Yahoo-fallback payout (`trailingAnnualDividendRate / epsTrailingTwelveMonths`) is display-only, so a non-US listing with no SEC data does not flip Financial Strength out of `insufficient-data` on a single Yahoo-sourced criterion. All other new ratios (PE, Forward PE, PBV, ROE, ROA, D/E, PCF, Dividend Yield) are display-only — Forbes frames them as industry-relative, not absolute.

## Per-metric annualization

ROE, ROA, and PCF annualize each flow fact by its **own** `periodMonths` (exposed as `<key>PeriodMonths` from `sec-edgar.ts`), not a borrowed `revenuePeriodMonths`. The SEC selector does not disambiguate a 10-Q's 3-month vs YTD duration facts, so the selected `netIncome` period is not guaranteed to match revenue's; borrowing revenue's months can double the error (and the same ambiguity already affected shipped `netMargin`).

