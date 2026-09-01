# AAPL equity Research View

Research-only note: This report is for market research only and does not provide investment advice, trade recommendations, position sizing, execution instructions, or portfolio changes. Predictions are probabilistic statements about future observable market quantities, not trade recommendations. Acting on them is the reader's decision.

Generated: 2026-06-15T14:30:00.000Z
Evidence Quality: medium
Report Integrity: high
Research Quality: medium
Research Quality Driver: macro indicator evidence missing; remediation: configure MARKET_BOT_FRED_API_KEY or rerun
Analysis Completeness: financial core `complete`

## What the Company Does

- No cited plain-language company description is available.

## Price and Market Date

Observed price: 198.5 USD; price as of fetch time 2026-06-15T14:30:00.000Z. [market-yahoo-equity-aapl]

## Financial Trends

Amounts in USD. FCF, where applicable, is the reported operating-cash-flow less capex proxy. [extended-sec-edgar-aapl-fundamentals]

Period | Revenue | Net income | Operating margin | FCF
--- | ---: | ---: | ---: | ---:
FY ending 2023-09-30 (filed 2023-11-01) | 383.0B | 97.0B | 30.0% | 99.0B
FY ending 2024-09-30 (filed 2024-11-01) | 391.0B | 102.0B | 31.5% | 106.0B
FY ending 2025-09-30 (filed 2025-11-01) | 405.0B | 108.0B | 32.1% | 112.0B
TTM (2026-03-31; filed 2026-05-01) | 426.0B | 116.0B | 32.9% | 118.0B

## Valuation Context

The observed quote is within the peer-implied price reference range of 145.60–264.73 USD as of fetch time 2026-06-15T14:30:00.000Z; this is valuation context, not a target price. [market-yahoo-equity-aapl] [extended-sec-edgar-aapl-filings] [extended-sec-edgar-aapl-fundamentals] [market-yahoo-equity-msft] [extended-sec-edgar-msft-fundamentals] [extended-sec-edgar-msft-filings] [market-yahoo-equity-googl] [extended-sec-edgar-googl-fundamentals] [extended-sec-edgar-googl-filings] [market-yahoo-equity-amzn] [extended-sec-edgar-amzn-fundamentals] [extended-sec-edgar-amzn-filings] [market-yahoo-equity-meta] [extended-sec-edgar-meta-fundamentals] [extended-sec-edgar-meta-filings] [market-yahoo-equity-dell] [extended-sec-edgar-dell-fundamentals] [extended-sec-edgar-dell-filings]

- **Observed metrics:** near-term options implied volatility 0.330, price/book 45.00x, EPS TTM 6.40 [extended-tradier-iv-aapl] [market-yahoo-equity-aapl]

## Catalysts

- AAPL fixture news remains the only current catalyst input. [news-equity-1]


## Key Findings

- AAPL has a current fixture market snapshot and verified close history. [market-yahoo-equity-aapl] [verified-snapshot-AAPL]
- Fixture news coverage is intentionally narrow for regression determinism. [news-equity-1]
- The fixture includes an issuer-confirmed earnings event and options reference bar. [news-equity-1] [extended-finnhub-events-aapl] [extended-tradier-earnings-implied-move-aapl]

## Risks

- Static cassette inputs can become stale versus live market conditions. [market-yahoo-equity-aapl]

## Upcoming Earnings and Consensus

- **Upcoming earnings:** AAPL on 2026-07-10 (amc; issuer-confirmed) [extended-finnhub-events-aapl] [news-equity-1]
- **EPS consensus:** 1.72 (single-provider snapshot) [extended-finnhub-events-aapl] [news-equity-1]
- **Revenue consensus:** 98.0B (single-provider snapshot) [extended-finnhub-events-aapl] [news-equity-1]
- **AAPL external EPS estimate consensus:** mean 1.7 for 2026-09-30 (28 estimates) [extended-finnhub-analyst-aapl-eps]
- **AAPL external revenue estimate consensus:** mean 98.0B for 2026-09-30 (24 estimates) [extended-finnhub-analyst-aapl-revenue]
- **AAPL external EBITDA estimate consensus:** mean 35.0B for 2026-09-30 (18 estimates) [extended-finnhub-analyst-aapl-ebitda]

## Material Data Gaps

- **Material:** sec-edgar: Missing SEC company facts: dilutedShares, currentAssets, currentLiabilities \[AAPL\]
- **Material:** sec-edgar: Missing comparable SEC company facts for YoY deltas: cash, debt \[AAPL\]
- **Material:** Fixture replay uses static source cassettes.
- **Material:** business-framework: Business Framework partial for AAPL: business-description: Business description is not available from current normalized sources
- **Material:** business-framework: Business Framework partial for AAPL: geographic-mix: Geographic revenue mix is not available from current normalized sources
- **Material:** business-framework: Business Framework partial for AAPL: segment-mix: Segment mix is not available from current normalized sources
- **Material:** business-framework: Business Framework partial for AAPL: customer-concentration: Customer concentration is not available from current normalized sources
- **Material:** business-framework: Business Framework partial for AAPL: purchase-recurrence: Purchase recurrence is not available from current normalized sources
- **Material:** business-framework: Business Framework partial for AAPL: pricing-power: Pricing power evidence is not available from current normalized sources
- **Material:** business-framework: Business Framework partial for AAPL: company-kpis: Company-specific KPI evidence is not available from current normalized sources
- **Material:** business-framework: Business Framework partial for AAPL: analyst-consensus: Analyst consensus is not available from a provider-neutral authoritative capability
- **Material:** business-framework: Business Framework partial for AAPL: management-track-record: Management track record is not available from current normalized sources
- **Material:** business-framework: Business Framework partial for AAPL: capital-allocation: Capital allocation commentary is not available from current normalized sources
- **Material:** business-framework: Business Framework partial for AAPL: risk-factors: Disclosed risk-factor evidence is not available from current normalized sources
- **Material:** business-framework: Business Framework partial for AAPL: cyclicality: Recession cyclicality evidence is not available from current normalized sources
- **Material:** emitted 2 of 5 target predictions; evidence did not support more

## Appendix

### Summary

equity-aapl-deep replayed AAPL research view uses fixture market, news, SEC, and verified snapshot evidence.

### Analysis Completeness

Coverage: `substantial`
Dimension Status: Primary financials `complete` · Valuation `complete` · Expectations `complete` · Capital & ownership `partial` · Operating KPIs `not assessed — inputs unavailable`

### Balance Sheet and Share Count

Cash and debt amounts in USD; diluted shares are weighted-average shares. [extended-sec-edgar-aapl-fundamentals]

Period | Cash | Debt | Diluted shares
--- | ---: | ---: | ---:
Interim ending 2026-03-31 (filed 2026-05-01) | 60.0B | 100.0B | —

### Bull Case

- The fixture shows positive price momentum in the latest close sequence. [verified-snapshot-AAPL]

### Bear Case

- The fixture omits live optional providers, limiting corroboration. [news-equity-1]

### Scenarios

- **Base:** AAPL remains within a fixture-defined evidence envelope. [market-yahoo-equity-aapl]

### Business Framework

Phase: operating-leverage

- **Moat** (criteria-supported): Moat criteria-supported \(Gross margin 47.6%, Operating margin 33.3%\) [extended-sec-edgar-aapl-filings] [extended-sec-edgar-aapl-fundamentals]
- **Management** (insufficient-data): Management insufficient-data
- **Risk** (criteria-supported): Risk criteria-supported \(Debt/market cap 3.3%\) [extended-sec-edgar-aapl-filings] [extended-sec-edgar-aapl-fundamentals] [market-yahoo-equity-aapl] [market-yahoo-equity-msft] [extended-sec-edgar-msft-fundamentals] [extended-sec-edgar-msft-filings] [market-yahoo-equity-googl] [extended-sec-edgar-googl-fundamentals] [extended-sec-edgar-googl-filings] [market-yahoo-equity-amzn] [extended-sec-edgar-amzn-fundamentals] [extended-sec-edgar-amzn-filings] [market-yahoo-equity-meta] [extended-sec-edgar-meta-fundamentals] [extended-sec-edgar-meta-filings] [market-yahoo-equity-dell] [extended-sec-edgar-dell-fundamentals] [extended-sec-edgar-dell-filings] [verified-snapshot-AAPL]
- **Valuation** (criteria-supported): Valuation criteria-supported \(Trailing PE 31.00x, Forward PE 28.00x, EV/revenue 7.24x\) [market-yahoo-equity-aapl] [extended-sec-edgar-aapl-filings] [extended-sec-edgar-aapl-fundamentals] [market-yahoo-equity-msft] [extended-sec-edgar-msft-fundamentals] [extended-sec-edgar-msft-filings] [market-yahoo-equity-googl] [extended-sec-edgar-googl-fundamentals] [extended-sec-edgar-googl-filings] [market-yahoo-equity-amzn] [extended-sec-edgar-amzn-fundamentals] [extended-sec-edgar-amzn-filings] [market-yahoo-equity-meta] [extended-sec-edgar-meta-fundamentals] [extended-sec-edgar-meta-filings] [market-yahoo-equity-dell] [extended-sec-edgar-dell-fundamentals] [extended-sec-edgar-dell-filings]

#### Framework Data Gaps

- Business description is not available from current normalized sources
- Geographic revenue mix is not available from current normalized sources
- Segment mix is not available from current normalized sources
- Customer concentration is not available from current normalized sources
- Purchase recurrence is not available from current normalized sources
- Pricing power evidence is not available from current normalized sources
- Company-specific KPI evidence is not available from current normalized sources
- Analyst consensus is not available from a provider-neutral authoritative capability
- Management track record is not available from current normalized sources
- Capital allocation commentary is not available from current normalized sources
- Disclosed risk-factor evidence is not available from current normalized sources
- Recession cyclicality evidence is not available from current normalized sources


### Analyst Estimate Distributions

#### AAPL external EPS estimate consensus [extended-finnhub-analyst-aapl-eps]

Period: 2026-09-30

Mean | Median | High | Low | Count
---: | ---: | ---: | ---: | ---:
1.7 | 1.7 | 1.9 | 1.5 | 28

#### AAPL external revenue estimate consensus [extended-finnhub-analyst-aapl-revenue]

Period: 2026-09-30

Mean | Median | High | Low | Count
---: | ---: | ---: | ---: | ---:
98.0B | 97.5B | 103.0B | 92.0B | 24

#### AAPL external EBITDA estimate consensus [extended-finnhub-analyst-aapl-ebitda]

Period: 2026-09-30

Mean | Median | High | Low | Count
---: | ---: | ---: | ---: | ---:
35.0B | 34.5B | 38.0B | 32.0B | 18

### External Analyst Estimate Context

External analyst estimate range from Finnhub \(context only, not market-bot authored\). [extended-finnhub-analyst-aapl-context]
- **Mean:** 240
- **Median:** 235
- **High:** 280
- **Low:** 190
- **Count:** 42
### External Ownership Context

External institutional ownership data from Finnhub \(context only, not market-bot authored\). [extended-finnhub-ownership-aapl-institutional]
- **Institutional holders:** 2
- **Reported shares:** 2230000000
- **Reported ownership percent:** 0.14800000000000002
External insider transaction data from Finnhub \(context only, not market-bot authored\). [extended-finnhub-ownership-aapl-insider-transactions]
- **Insider transactions:** 2
- **Purchases:** 1
- **Sales:** 1
- **Net share change:** 7000

### Earnings Setup

**Event:** AAPL earnings on 2026-07-10 (timing: amc) — date issuer-confirmed [news-equity-1]
**EPS estimate:** 1.72 — single-provider snapshot (Finnhub)
**Revenue estimate:** 98,000,000,000 — single-provider snapshot (Finnhub)
**Implied move:** ±3.5% (ATM strike 200, expiration 2026-07-17)

#### Expectation Bar

- The deterministic fixture records the issuer-confirmed date and options reference bar.[news-equity-1] [extended-finnhub-events-aapl] [extended-tradier-earnings-implied-move-aapl]

### Historical Context

No prior run artifacts matched this research scope.
- No prior ticker runs found for AAPL
- No prior equity market-update runs found


### Predictions

- [58%] (1d) AAPL closes higher than its pre-earnings close 1 trading days after the 2026-07-10 earnings event [news-equity-1] [extended-finnhub-events-aapl]
- [55%] (1d) AAPL moves more than 3.5% from its pre-earnings close 1 trading days after the 2026-07-10 earnings event [news-equity-1] [extended-finnhub-events-aapl] [extended-tradier-earnings-implied-move-aapl]

### Diagnostic Data Gaps

- 13 diagnostic data gaps; see the Research Console Advanced view or report.json for details.

### Sources

- [market-yahoo-equity-aapl] AAPL market snapshot
- [verified-snapshot-AAPL] AAPL verified market snapshot \(OHLCV + indicators, 2026-05-01\)
- [news-equity-1] Apple announces July 10, 2026 financial results webcast
- [extended-sec-edgar-aapl-filings] AAPL SEC filings
- [extended-sec-edgar-aapl-fundamentals] AAPL SEC fundamentals
- [extended-finnhub-events-aapl] AAPL equity events
- [extended-finnhub-analyst-aapl-eps] AAPL external EPS estimate consensus
- [extended-finnhub-analyst-aapl-revenue] AAPL external revenue estimate consensus
- [extended-finnhub-analyst-aapl-ebitda] AAPL external EBITDA estimate consensus
- [extended-finnhub-analyst-aapl-context] AAPL external analyst range context
- [extended-finnhub-ownership-aapl-institutional] AAPL external institutional ownership context
- [extended-finnhub-ownership-aapl-insider-transactions] AAPL external insider transactions context
- [extended-tradier-iv-aapl] AAPL options IV
- [market-yahoo-equity-msft] MSFT Yahoo valuation peer quote
- [extended-sec-edgar-msft-fundamentals] MSFT SEC fundamentals
- [extended-sec-edgar-msft-filings] MSFT SEC filings
- [market-yahoo-equity-googl] GOOGL Yahoo valuation peer quote
- [extended-sec-edgar-googl-fundamentals] GOOGL SEC fundamentals
- [extended-sec-edgar-googl-filings] GOOGL SEC filings
- [market-yahoo-equity-amzn] AMZN Yahoo valuation peer quote
- [extended-sec-edgar-amzn-fundamentals] AMZN SEC fundamentals
- [extended-sec-edgar-amzn-filings] AMZN SEC filings
- [market-yahoo-equity-meta] META Yahoo valuation peer quote
- [extended-sec-edgar-meta-fundamentals] META SEC fundamentals
- [extended-sec-edgar-meta-filings] META SEC filings
- [market-yahoo-equity-dell] DELL Yahoo valuation peer quote
- [extended-sec-edgar-dell-fundamentals] DELL SEC fundamentals
- [extended-sec-edgar-dell-filings] DELL SEC filings
- [extended-tradier-earnings-implied-move-aapl] AAPL earnings implied move
- 7 uncited normalized source(s) omitted from markdown (yahoo-news/news:1, yahoo/market-data:6). Full source arrays remain in report.json and console files.


### Valuation Workbench

As-reported multiples use first verified close within 7 calendar days on or after publicAt; statement period ends do not establish public availability. Reporting currency: USD. Quote currency: USD.

- Trailing basis: reconciled TTM through 2026-03-31, public 2026-05-01.

Basis | Statement period | Public date | First eligible close | P/E | P/S | EV/revenue | P/FCF
--- | --- | --- | --- | ---: | ---: | ---: | ---:
ANNUAL | 2023-09-30 | 2023-11-01 | — | — (price-history-unavailable) | — (price-history-unavailable) | — (cash-unavailable) | — (price-history-unavailable)
ANNUAL | 2024-09-30 | 2024-11-01 | — | — (price-history-unavailable) | — (price-history-unavailable) | — (cash-unavailable) | — (price-history-unavailable)
ANNUAL | 2025-09-30 | 2025-11-01 | — | — (price-history-unavailable) | — (price-history-unavailable) | — (cash-unavailable) | — (price-history-unavailable)
TTM | 2026-03-31 | 2026-05-01 | 216.60 USD (2026-05-01) | 28.50x | 7.76x | 7.85x | 28.02x

#### Peer comparison

- Supportability: supported.
- Reference range: 145.60–264.73 USD; midpoint 204.77; observed position within-range; fetch time 2026-06-15T14:30:00.000Z.
- Excluded peers: DELL (market cap outside 0.2x-5x of target).

Symbol | Role | Screen status | EV/revenue | Quote currency | Input dates
--- | --- | --- | ---: | --- | ---
AAPL | target | usable | 7.24x | USD | fetch time 2026-06-15T14:30:00.000Z; revenue 2026-03-31; cash 2026-03-31; debt 2026-03-31
MSFT | core | usable | 11.50x | — | fetch time 2026-06-15T14:30:00.000Z; revenue 2026-03-31
GOOGL | core | usable | 5.92x | — | fetch time 2026-06-15T14:30:00.000Z; revenue 2026-03-31
AMZN | core | usable | 3.43x | — | fetch time 2026-06-15T14:30:00.000Z; revenue 2026-03-31
META | core | usable | 8.90x | — | fetch time 2026-06-15T14:30:00.000Z; revenue 2026-03-31
DELL | secondary | excluded | 1.00x | — | fetch time 2026-06-15T14:30:00.000Z; revenue 2026-03-31



### Reverse DCF Input Sensitivity

The cells report the five-year FCF growth input that reconciles each disclosed discount-rate and terminal-growth assumption pair.

#### Assumptions

- Starting FCF: 118,000,000,000 USD; period ended 2026-03-31; public 2026-05-01.
- Enterprise value: 3,040,000,000,000 USD; fetch time 2026-06-15T14:30:00.000Z.
- Horizon: 5 years.
- Discount rates: 8%–16%.
- Terminal growth rates: 0%–4%.

#### Solved Five-Year FCF Growth Grid

| Discount rate \ Terminal growth | 0% | 1% | 2% | 3% | 4% |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 8% | 17.73% | 14.95% | 11.80% | 8.15% | 3.79% |
| 9% | 21.12% | 18.62% | 15.82% | 12.65% | 8.97% |
| 10% | 24.32% | 22.04% | 19.52% | 16.70% | 13.49% |
| 11% | 27.35% | 25.25% | 22.95% | 20.41% | 17.57% |
| 12% | 30.24% | 28.29% | 26.18% | 23.86% | 21.30% |
| 13% | 33.02% | 31.20% | 29.24% | 27.11% | 24.77% |
| 14% | 35.70% | 33.99% | 32.16% | 30.18% | 28.03% |
| 15% | 38.30% | 36.69% | 34.97% | 33.12% | 31.13% |
| 16% | 40.82% | 39.30% | 37.67% | 35.94% | 34.08% |
