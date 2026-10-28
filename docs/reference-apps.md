# Reference apps

Comparable research products set the bar for what a long-term fundamental view should cover. This maps what they display to the market-bot feature that covers it. A row with a gap on our side is a candidate improvement. Their verdicts stay out of bounds: see the never-ship list in [AGENTS.md](../AGENTS.md#reference-apps) and [ADR 0001](./adr/0001-research-only-boundary.md).

| Their surface                                                          | Ours                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Company overview, segments, customers, offerings                       | Web Subject Profile, Business Framework → Business                                |
| Phase, Moat, Growth, Management, Risk deep dive (StockSimplifier)      | Business Framework sections                                                       |
| Snowflake axes: value, growth, past, health, dividend (Simply Wall St) | Financial Lens: Quality, Growth, Financial Strength, Value, Momentum              |
| 5–10y financials, buyback and dividend history                         | Fundamental Evidence, financial statements, capital return                        |
| Valuation                                                              | Valuation Workbench, Peer Universe reference range, Reverse DCF Input Sensitivity |
| Performance vs S&P 500                                                 | Price Performance (price return only; total return is not implemented)            |
| Earnings beat/miss, upcoming earnings                                  | analyst expectations, Earnings Setup                                              |

Sources:

- [StockSimplifier](https://app.stocksimplifier.com/): Phase, Business, Moat, Growth, Management, and Risk deep dive, plus a composite score and Pass/Watch/Buy decision (out of bounds).
- [Simply Wall St Snowflake](https://support.simplywall.st/hc/en-us/articles/360001740916): five axes of six pass/fail checks each, summed into a shape (the sum is out of bounds).
- [Morningstar equity research methodology](https://s205.q4cdn.com/437373358/files/doc_downloads/2025/07/Morningstar-Equity-Research-Methodology-2023-06-14.pdf): moat sources (intangibles, switching costs, network effects, cost advantage, efficient scale) and moat trend. Fair value and star ratings are out of bounds.
