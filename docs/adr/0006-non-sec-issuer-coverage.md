# ADR 0006: Non-SEC issuer coverage

## Status

Accepted

## Context

Issuers without SEC filings (Bursa Malaysia first) have no structured filing facts, so their figures reach the
report through web and issuer-page sources that a model reads. Saved `.KL` runs showed the cost: a model wrote
"RM118.8 million" where its source said RM118.58mil, and the citation check passed because it only matches
source IDs. The same gap exists on US runs whenever a claim takes a figure from a web source.

## Decision

- **Verified Web Figure.** A figure a model states from a web source (`Source.kind === "web"`) carries a
  `figureQuotes` entry `{ sourceId, quote }`: a verbatim span from that cited source holding the figure.
- Code verifies before publishing, on every run, US included:
  - The quote, after NFKC, whitespace, quote/dash and Markdown-emphasis normalization, appears in the source's
    stored text. Stored text is the source's snippet plus its raw Exa/Firecrawl page text matched by
    canonical URL. A provider `summary` is a model-written abstract and never counts.
  - Every figure parsed from the claim matches a figure parsed from a verified quote on value, scale, currency,
    and unit. No cross-scale, rounding, or conversion matching. A figure is a number with a currency, scale,
    unit, decimal point, or thousands separator; bare integers (counts, ranks, years, "iPhone 17") are not.
  - Every quote on a claim must verify, whatever figure it holds, so every persisted quote is a proven span. A
    quote needs at least three words outside its figures; a bare number matches almost any page.
  - Web Gather stores at most `MAX_TEXT_CHARS` per page and the snippet cap; a figure beyond the stored text
    fails. A snippet-only source verifies only what the snippet holds. A source with no stored text fails every
    figure tied to it.
  - A claim that also cites a deterministic source (`market-data`, `market-context`, `extended-evidence`,
    which includes metric-reference sources) may carry figures without quotes, because code cannot tell which
    cited source a figure came from. News, prior-report, reference, and unknown IDs do not exempt.
- **Failure prunes and declares.** Final-synthesis findings, cases, risks, catalysts, scenarios, and Earnings
  Setup bullets drop whole; a Business Framework section loses its model text; each prune adds a
  `report.dataGaps` entry naming the figure, reason, and source, and is traced in `reportIntegrityAudit.pruned`
  with its `webFigure` reason. Web Subject Profile answers lose the failing sentences (a fully failed answer
  becomes a withheld notice); failing facts drop with a count notice; each failure is a profile Source Gap.
  Reuse re-verifies a prior profile against the prior run's stored source text; a candidate with any newly
  failing figure is not reused, so the run regenerates the profile instead of publishing it degraded.
- Final synthesis reads a fresh web source's snippet, falling back to the summary only when no snippet exists,
  so the quotable text is what the model sees.
- Quotes persist on report claims and profile rows. `figureQuotes[].quote` is quoted source text, exempt from
  the research-only scan ([ADR 0001](./0001-research-only-boundary.md)).

### Non-SEC foundation (amended 2026-11-06)

- **Identity Gate.** Every equity instrument run resolves its listing after market collection and before the
  parallel collection batch, which holds the first model call (peer universe). A priced quote or a typed Yahoo
  quote (`quoteType` other than `NONE`) resolves. Otherwise Yahoo search (`q=<code without suffix>`) runs once:
  a single listed-stock match (on the same suffix when the code has a non-US one), exact on code, full name, or first name word, redirects the run
  to that code and records `listingResolution` plus a `user-input` identity alias. Several exact matches stop
  as ambiguous, none stops as unresolved; both list candidates and spend no model tokens. A search failure
  stops a non-US-suffixed symbol and keeps a US-looking one on the old path. The redirect is recorded in
  `trace.json` as `listingResolution`. The listed-stock check is the one
  alpha-search uses (`sources/yahoo-quote-info.ts`).
- **US classification is identity-driven.** `isUsListing` reads the resolved exchange and quote currency first,
  then the suffix list, which now includes `KL`, `JK`, `BK`, and `TWO`. SEC, Tradier, and Finnhub company
  packets take `unsupported` for those listings.
- **Web Gather is the evidence base.** A non-SEC equity listing runs Web Gather at every depth, and the Identity
  Gate stops the run before any model stage when `MARKET_BOT_EXA_API_KEY` is unset or
  `MARKET_BOT_WEB_GATHER_DISABLE` is set: either removes the evidence base the coverage label names.
- **Exchange Profile.** A checked-in row per exchange (suffix, local benchmark, currency; Bursa: `^KLSE`, MYR)
  drives market regime and the Event Grid relative event. An exchange without a row keeps the US proxies and
  declares an `exchange-profile` Source Gap.
- **Forecasts.** A non-SEC listing without verified closes issues no Observable Predictions and declares a
  `forecast-book` gap; final synthesis is asked for no predictions or Event Grid, and no Prediction Shortfall
  is reported. With closes, [ADR 0003](./0003-forecasts-scoring-and-calibration.md) applies unchanged: a range
  Prediction whose scored sessions are unknown (non-US listing) omits its baseline with a `forecast-baseline`
  gap, direction and relative keep their 0.5 baseline, and range references fall back to 0.5.
- **Currency.** Valuation Evidence divides on a USD basis; a quote currency other than USD withholds it with a
  gap instead of dividing across currencies. Yahoo per-share values (EPS, dividend rate) name a non-USD quote
  currency.
- **Coverage label.** `report.coverageLabel` is "non-SEC issuer: web and issuer sources" on those runs, rendered
  in the Markdown header and the Console equity header. It is a deterministic constant, outside the
  research-only scan.
- **Endpoint availability is content-based.** `yahooQuote` counts only when the quote normalizes for the run
  symbol, and `secCompanyTickers` only when the ticker map holds it.

## Consequences

- Web-sourced figures without a quote, including every recorded pre-change model output, prune into gaps.
  Reports lose figures they published before; each loss is declared.
- Verification is lexical: it proves a cited span holds the number, not that the span is about the claim. Sign
  is not parsed ("fell 4%" matches "+4%"), a range carries its scale only on the last number ("$1.2-1.4
  billion" parses as $1.2), and "9M" reads as nine million; each is symmetric between claim and quote.
- A web figure in a claim that also cites a deterministic source is not checked.
- Pre-change profiles fail reuse once and are regenerated, one profile stage per subject.
- News-kind sources and the qualitative summary are outside the check.
- A redirected run collects market data twice (typed code, then the resolved code).
- Price performance stays SPY-relative for every listing until it reads the Exchange Profile.
