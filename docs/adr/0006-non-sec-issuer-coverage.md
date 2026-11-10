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
  `figureQuotes` entry `{ sourceId, quote, unitQuote? }`: a verbatim span from that cited source holding the figure.
- Code verifies before publishing, on every run, US included:
  - The quote, after NFKC, whitespace, quote/dash and Markdown-emphasis normalization, appears in the source's
    stored text. Stored text is the source's snippet plus its raw Exa/Firecrawl page text matched by
    canonical URL. A provider `summary` is a model-written abstract and never counts.
  - Every figure parsed from the claim matches a figure parsed from a verified quote on value, scale, currency,
    and unit. No cross-scale, rounding, or conversion matching. A figure is a number with a currency, scale,
    unit, decimal point, or thousands separator; bare integers (counts, ranks, years, "iPhone 17") are not.
  - Every persisted quote is a proven span. A quote that fails is dropped from the claim and recorded, and the
    claim is then judged on its figures alone (amended 2026-11-08). The earlier rule failed the whole claim on any
    failing quote, which pruned claims whose figures were all code-rendered over a redundant quote the prompt never
    asked for (run `b7171fdf`, three of its five prunes). A dropped quote is traced in
    `reportIntegrityAudit.droppedFigureQuotes` with its location and reason, or becomes a profile Source Gap on a
    Web Subject Profile row; a claim figure that only a dropped quote held fails with that quote's reason. A quote
    needs at least three words outside its figures; a bare number matches almost any page. A quote with
    `unitQuote` needs one word, since it verifies only as a whole-label monetary row and the label is the
    context (amended 2026-11-10); the three-word floor dropped a `| 1 | Revenue | 485,101 | 228,567 |` row as
    `quote-too-short` and withheld the profile's KPIs (run `ba3a337e`, 0097.KL).
  - A table figure whose currency and scale appear only in its column's unit header adds `unitQuote`, that header
    cell verbatim (amended 2026-11-09). Code splits the same stored text into pipe tables (a blank line, a non-table
    line, or a Markdown separator row starts a new one), finds each quoted figure's own cell, and walks up from its row to the table top. Every row
    it crosses must be proven, or the unit is blocked: either a data row whose single label is a listed monetary
    line and whose value cells are bare numbers, or a header row whose cell in this column is a unit cell, a scale
    cell, a period or date (`CURRENT YEAR QUARTER`, `30 Sep 2026`; exact month names only), or blank, and whose
    label cell is blank or a period or date. A missing cell blocks, and a blank cell passes only when every other
    cell in its row is blank or a period or date, since a merged header may cover it. A caption, a `%`, `CAD`, `US$`, or `Note` cell, or any unparsed row blocks. These are allowlists
    that fail closed, since no list of excluded ratio or unit words is complete. The walk must find exactly one unit
    cell for the column, at most one scale, and a currency; `unitQuote` must equal one of those unit or scale cells.
    Only a bare whole-cell amount takes the unit, on a row whose single label is wholly (not as a substring) a listed
    monetary line (revenue, profit before tax, profit for the period, profit attributable to owners, operating cash
    flow, capital expenditure, cash, total current assets or liabilities, total equity), and every value cell of
    that row must pass the same walk. Such a cell then matches at the header's scale and currency
    (`485,101` under `MYR'000` is `MYR 485,101 thousand`), and cells in other columns stay bare. Issuer Report
    Figures keeps its own header rule, and also withholds a column with a currency- or scale-looking cell it cannot
    parse (`unit-ambiguous`). A quote whose `unitQuote` heads none of its cells
    drops as `unit-not-in-source`. The quote had no unit field before, so an `RM'000` table figure verified only as
    the bare cell, without its currency.
  - Web Gather stores at most `MAX_TEXT_CHARS` per page and the snippet cap; a figure beyond the stored text
    fails. A snippet-only source verifies only what the snippet holds. A source with no stored text fails every
    figure tied to it.
  - A co-cited deterministic source (`market-data`, `market-context`, `extended-evidence`) exempts nothing
    (amended 2026-11-10): every model-typed figure in a web-cited claim needs a proven quote, and an ambiguous
    span fails the claim whatever else it cites. A quote may instead name a deterministic source, and is then
    checked against that source's stored collector text: its `snippet` (the sanitized SEC filing text, the
    only text a Web Subject Profile sees) and the `summary` of every Extended Evidence or Market Context item
    citing the ID, normalized and matched as web text is. Market-data rows hold structured values only, so
    nothing is stored under one, not even a multi-source item summary that lists it, and a quote on one
    fails as `no-stored-text`; their figures reach a web-cited claim as metric references, which code renders
    and blanks. The earlier rule let any model-cited deterministic ID exempt every
    figure in the claim and skipped the ambiguous-span check; on the 60 newest saved runs (2026-11-09) that
    published 39 unchecked figures in 18 claims, and a re-audit under this rule prunes 24 claims in 18 runs,
    all `figure-not-quoted`.
  - A metric reference substitutes a value code rendered from its Metric Section (`MYR 485.1M`, `112.2%`) and
    merges the metric's source IDs into the claim. The resolver records each substitution's field, offset, and
    text in `renderedMetrics`, and the IDs the claim did not already cite in `metricSourceIds`; only code sets
    them (a draft's own copies are stripped before citation), and both persist in `report.json` and survive the
    artifact reader. The check blanks exactly those spans, so only model-typed figures are verified: a typed
    figure that equals a rendered value still needs a quote, even when the merged source is deterministic. A
    span is blanked only when it stands alone: start of text, whitespace or `(` before it; end of text,
    whitespace, `;`, `:`, `)`, or `.`/`,` not followed by a letter or digit after it; no currency code across whitespace
    before it, and no scale, unit, or currency word or range bound across whitespace after it. The claim must also read
    the same figures with the span blanked as without it, which catches word ranges ("from 10 to"), parentheses,
    and a spaced sign. A span that fails either test is code-rendered text glued to typed text, which no quote can
    prove, so a web-cited claim holding one prunes as `figure-ambiguous`. A span whose text no longer matches is
    checked like typed text (amended 2026-11-08). The earlier rule let any deterministic ID exempt every figure,
    metric-reference sources included, so one `<<metric:financial-lens.revenue>>` exempted an unquoted web figure
    in the same sentence.
- **Failure prunes and declares.** Final-synthesis findings, cases, risks, catalysts, scenarios, and Earnings
  Setup bullets drop whole; a Business Framework section loses its model text; each prune adds a
  `report.dataGaps` entry naming the figure, reason, and source, and is traced in `reportIntegrityAudit.pruned`
  with its `webFigure` reason. Web Subject Profile answers lose the failing sentences (a fully failed answer
  becomes a withheld notice); failing facts drop with a count notice; each failure is a profile Source Gap.
  Reuse re-verifies a prior profile against the prior run's stored source text; a candidate with any newly
  failing figure is not reused, so the run regenerates the profile instead of publishing it degraded.
- Final synthesis reads a fresh web source's snippet, falling back to the summary only when no snippet exists,
  so the quotable text is what the model sees.
- Quotes persist on report claims and profile rows. `figureQuotes[].quote` and `.unitQuote` are quoted source text, exempt from
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
  packets and the Massive US snapshot and news calls take `unsupported` for those listings.
- **Web Gather is the evidence base.** A non-SEC equity listing runs Web Gather at every depth, and the Identity
  Gate stops the run before any model stage when `MARKET_BOT_EXA_API_KEY` is unset or
  `MARKET_BOT_WEB_GATHER_DISABLE` is set: either removes the evidence base the coverage label names.
- **Exchange Profile.** A checked-in row per exchange (suffix, local benchmark, currency; Bursa: `^KLSE`, MYR)
  drives market regime, the Event Grid relative event, the final-synthesis relative benchmark, and the Price
  Performance benchmark rows (amended 2026-11-07); such a listing collects no SPY or QQQ history. Its benchmark is never served by the US Massive
  fallback. An exchange without a row keeps the US proxies and declares an `exchange-profile` Source Gap, and a
  quote currency that differs from the row's currency declares one too; the two are never compared.
- **Forecasts.** A non-SEC listing without verified closes issues no Observable Predictions and declares a
  `forecast-book` gap; final synthesis is asked for no predictions or Event Grid, and no Prediction Shortfall
  is reported. With closes, [ADR 0003](./0003-forecasts-scoring-and-calibration.md) applies unchanged: a range
  Prediction whose scored sessions are unknown (a listing without an Exchange Profile, or a weekday between
  the reference close and the run date; amended 2026-11-10) omits its baseline with a `forecast-baseline`
  gap, and direction and relative keep their 0.5 baseline. Near-Base-Rate references a range Prediction on a listed ±1σ
  band to 0.32 when its session count is unknown, and to 0.5 when no band matches (amended 2026-11-10). On a listing
  with an Exchange Profile, a model Prediction with a leg outside that exchange other than its benchmark (SPY
  on a MYR listing) is withheld with a diagnostic `forecast-book` gap: its outcome would mix currencies and
  session calendars (amended 2026-11-06). The final-synthesis prompt offers that benchmark as the only relative
  benchmark on such a listing, in place of the US index examples (amended 2026-11-07).
- **Currency.** Valuation Evidence divides on a USD basis; a quote currency other than USD, or a Reporting
  Currency other than USD beside a USD quote (a CAD 40-F filer), withholds it with a gap instead of dividing
  across currencies. Yahoo per-share values (EPS, dividend rate) name a non-USD quote
  currency.
- **Coverage label.** `report.coverageLabel` is "non-SEC issuer: web and issuer sources" on those runs, rendered
  in the Markdown header and the Console equity header. It is a deterministic constant, outside the
  research-only scan.
- **Endpoint availability is content-based.** `yahooQuote` counts only when the quote normalizes for the run
  symbol, and `secCompanyTickers` only when the ticker map holds it.

### Issuer Report Figures (amended 2026-11-06)

- **Report hosts.** The Exchange Profile lists report hosts. Primary hosts are the exchange's own pages (Bursa:
  `bursamalaysia.com`). Mirror hosts are an allowlist of sites that republish the exchange filing as table text
  (Bursa: `klsescreener.com`, `marketscreener.com`, the two the first capture reached). Any other host is not a
  report source. The issuer's own IR domain is not yet recognised as primary, since non-SEC runs carry no
  issuer website field.
- **Fetch size.** `web_fetch` keeps 32,000 characters for a report host of a profiled listing, enough for an
  interim report's four statements (about 27,000 characters). Every other fetch and every search keeps
  `MAX_TEXT_CHARS` (5,000), so US runs send identical requests. The brief round loop asks for one report search
  and then a fetch. The deep single-round batch cannot fetch a page it has not yet seen, so the deep model is asked
  for the report search only, and after the batch code fetches up to two of the newest surfaced report-host
  pages, within budget, whose search text already holds a table and that the model did not fetch. The reserve is
  conditional: up to two fetches, fewer when the budget left after one model search cannot cover two, and none
  without an Exchange Profile. The deep model is shown, and held to, the budget minus that reserve. A failed fetch
  is a declared gap, and the issuer-report gap still fires when no report text arrives. Listings without an
  Exchange Profile keep the full budget and get no code fetch.
- **Model maps, code reads.** The `issuer-report-mapping` stage sees report tables as cell refs and text and
  returns only `{concept, cell}` pairs from a fixed concept list. Code reads the value from the cell and accepts
  it only when all of these hold:
  - the cell is numeric;
  - the row label matches the concept's label pattern; a sub-item row (a leading dash or bullet, or "Basic"/"Diluted") is
    read with its caption row above it, other rows alone. Revenue needs "revenue" or "turnover", attributable
    profit needs "attributable to … owners/equity holders", profit before tax excludes a share of associates or
    joint ventures and any attributable line (IAS 1.81B splits profit only after tax), profit for the period excludes gross, operating and comprehensive lines, total equity
    excludes the attributable-to-owners subtotal, and capex needs a purchase of property, plant and equipment;
  - no other concept in the same mapping claims the cell;
  - the header rows directly above its data block hold exactly one date, which is the period end;
  - the header text states the basis: "as at" for a stock, a month count, "quarter", "year ended", or "to date"
    with the Financial Year End;
  - the concept kind matches that basis: a flow needs a period length, a stock needs "as at";
  - the unit header gives the currency and scale, in one cell (`MYR'000`, `USD'mil`) or as a currency cell plus a
    scale cell (`RM` | `'000`); two different scales in one column are ambiguous and not read;
  - a per-share concept needs a subunit label (`(Subunit)`, `sen`, `cents`), which scales by 0.01;
  - the column currency matches the document's "Currency: … (XXX)" line;
  - the period end is not after the announcement date. An all-numeric date whose day and month are both 12 or
    less is ambiguous (day- or month-first) and is not read.

  A comparative column headed "restated" or "re-presented" publishes with that note on its row and on any
  derived row that uses it.

  Accounting Scope fails closed (amended 2026-11-06). A flow or per-share figure is total only when its table
  and the page's non-table lines carry no scope cue (in the table any "continu…", "held for sale/distribution",
  "disposal group", "HFS"/"NCAHFS", "cont./disc. ops", or the Malay "berterusan"/"diteruskan"/"dihentikan"; in page prose a
  continuing, continued or discontinued operations, activities, business or segment phrase, "cont./disc. ops",
  held for sale/distribution, "HFS"/"NCAHFS", disposal group, or the Malay "operasi berterusan"/"tidak diteruskan"/"dihentikan"; dashes are read as
  hyphens). Otherwise its row label, else the caption the walk upward reaches, must state the scope. The walk
  ignores row-number cells left of a label, skips unit and scale rows, skips data rows (a flow stops at a
  "total" or non-continuing one, which closes the section; a stock takes the scope of the first one that states
  one, except that a total-scope data row withholds it, since only a caption proves total), takes the first row with a label and nothing right
  of it as the caption (one stating no scope proves none), and stops at any other text row, such as a period
  header, a nil placeholder or a note reference; a flow whose walk stops without a caption is withheld. Any negation in a cued label
  ("not", "no", "non", "excluding", "except", "without", "exclusive of", "other than") withholds it.
  Otherwise "continuing operations" with no discontinued mention makes it continuing, labelled so on its row
  and keyed apart from the total, unless the row is a "total" row inheriting the scope from a caption.
  "continuing and discontinued" or "including discontinued operations" makes it total; other inclusive
  wordings are withheld. A discontinued,
  held-for-sale or disposal-group slice is withheld as `discontinued-operations`; anything else is withheld as
  `unproven-scope`. A balance-sheet figure in a cued table or page publishes only under a caption that states
  total scope ("continuing and discontinued", "including discontinued operations"); under a discontinued
  caption it is `discontinued-operations`, and otherwise (own scope label, no caption, an unstated or
  continuing caption) `unproven-scope`. That withholds a bare "Total current assets" beside a held-for-sale
  line: IFRS 5.38 presents disposal-group assets on their own line and does not fix whether a current total
  includes them. Derived rows pair inputs on the newest period the two share within one scope (total
  first on a tie); with no shared-scope pair, a mixed pair is `missing`; with both concepts of a cross-concept row read on the same basis but no shared period, the row is `missing`. Each `missing` derived row is named in an `issuer-report` Source Gap. The
  provider EPS cross-check reads only a total EPS. Parent vs NCI scope is carried by the concept (profit for
  the period vs profit attributable to owners); a parent-scope profit before tax row is withheld as a
  label mismatch. Net margin divides profit for the period (including NCI; IAS 1.81A–B) by revenue, as the SEC
  rule does; profit attributable to owners never stands in, since no checked figure can show a period has no
  NCI income, so a run that reads only parent profit withholds the row as `missing`.

  A figure that fails any check is withheld and named in an `issuer-report` Source Gap. So are two documents
  giving different values for one concept and period.

- **Labelled provenance.** Each Issuer Report Figure carries its source ID, verbatim row label and cell,
  declared unit, currency, period end and length, and basis. The basis names the document and host; a mirror
  reads "mirror copy of the issuer document … not the exchange's own page". It also gives the announcement date,
  or, when the page shows none, the source's date marked "provider published date, else fetch date": a web
  Source's `fetchedAt` is the provider's `publishedDate` when it sends one, which is page metadata and can
  precede real publication. Derived rows reuse only checked
  figures with standard formulas: same-basis YoY, net margin, FCF as operating cash flow − |capex|, and current
  ratio. Mixed currencies or scopes make a derived row `missing`, named in an `issuer-report` Source Gap; a
  zero or negative denominator makes it `not meaningful`, and so does a YoY whose current figure is negative, the
  rule the SEC statement path uses (amended 2026-11-11).
- **Absence.** A profiled listing with no report text, an invalid mapping, or no checked figure declares an
  `issuer-report` Source Gap. An unprofiled or SEC listing skips the phase and makes no model call.
- **Provider EPS cross-check.** A TTM to the newest report date contains that report's quarter and
  year to date, and equals its financial year when one ends there. When Yahoo trailing EPS sits below the
  largest positive same-currency basic EPS for that period end, the two cannot be shown to reconcile: a loss
  quarter outside the issuer period (not for a financial year, which is the TTM), a larger diluted or TTM share
  count and a stale print are among the explanations, and code cannot tell which without weighted share counts
  and, short of a financial year, the prior-fiscal-year EPS. It declares an `issuer-report` Source
  Gap and withholds the Yahoo EPS and every metric priced off it (trailing PE, Yahoo-fallback payout ratio) from
  every surface and every model stage after the phase; a metric row reads `not meaningful` with the reason. A
  loss or zero issuer EPS proves nothing about the TTM, so it is not checked. The web gather runs before the
  check and still sees the Yahoo values (amended 2026-11-06). Not below is not reconciled: the Yahoo value
  publishes, as on SEC listings, with an `issuer-report` Source Gap naming the unreconciled check, unless the
  financial-year EPS it matches at two decimals ends at the newest period end of any checked issuer figure.
  Reconciling a year-to-date period needs an issuer TTM (FY + YTD − prior YTD), which the phase does not
  compute (amended 2026-11-07).

## Consequences

- Web-sourced figures without a quote, including every recorded pre-change model output, prune into gaps.
  Reports lose figures they published before; each loss is declared.
- Verification is lexical: it proves a cited span holds the number, not that the span is about the claim. Each
  quoted figure is read whole from its own source table cell. A row with no closing `|` withholds the figures beside
  the line break, because the next line may wrap the cell or start a new row; a cell wrapped across lines never
  verifies. An attached minus makes a figure negative, and so do accounting parentheses that wrap a whole table cell
  (`| (125.5) |`); a sign mismatch fails. A figure in parentheses anywhere else ("revenue (RM5m)") or after a spaced
  single dash ("- RM5m") has an ambiguous sign and never verifies, in claim or source; a double dash ("Revenue --
  $5m") is punctuation. Since 2026-11-09 (amended), an em dash or horizontal bar is a word gap, never a sign
  ("Revenue—$574.9 million", "$6.7 billion — 58%"), except after a number and before another ("5—6%", "$5—$6 million"), where it joins a range like an en dash;
  an en dash, figure dash or minus sign stays a possible minus. An ASCII Markdown list dash at the start of a stored source
  line reads as that gap ("- $3.4bn"); a line-initial en dash, figure dash or minus does not. A parenthesized amount directly after an amount in another currency that reads
  whole (unsigned, not glued to a word, not a range end) is a translation and reads unsigned ("118.71 billion yuan ($16.7 billion)"); any other prose parenthesis
  stays ambiguous, since prose also writes losses that way ("was ($239.8 million) or ($0.89) per basic share").
  Quote matching treats every dash alike. Sign words are not parsed ("fell 4%" matches "4%"). Percentage
  points ("pp", "ppt", "ppts", "percentage pts", "percentage-point"), percent ("%", "pct", lower-case "pc", "per cent") and basis points
  ("bp", "bps", "basis point", "basis-point") are distinct units. A figure before "points", "pts" or "pt", spaced or glued ("14pts"), without a currency
  withholds, since the word may mean index points, percentage points or a price target ("13 points", "2% points"),
  as does one before upper-case "PC". A currency subunit ("sen", "cent", "cents", "¢", "pence") stays its own currency, unscaled,
  so "26.4 sen" never matches "RM26.4"; it reads the same glued ("26.4sen", "54cents", "26¢"), while a glued main-unit word
  does not. A glued lower-case "p" is pence ("20p"); upper-case "1P" and a time ("4:15p") are not figures. A figure with a prefix and a different suffix currency, or a currency followed by a subunit, withholds ("RM0.30 sen", "5 USD cents"). A tight dash before a digit or currency prefix joins a range, and both
  endpoints are checked as separate figures, not as a pair (`$1.2-1.4 billion` matches a quote stating $1.2 billion
  and $1.4 billion apart). The low endpoint takes the scale, unit and currency written once on the high ("$1.2-1.4
  billion", "RM5–6m", "5–6%"); the high takes only a missing currency. Neither endpoint of a range, tight or spaced,
  verifies when the range is parenthesized ("(5% - 7%)"). Neither endpoint of a tight range verifies when it mixes
  currencies or units ("$739.69-0.30%"), follows a currency glued to a word ("Corp$4.50-6%", "CorpRM 4.50-6%"),
  descends ("5%-3%", "RM500,000-RM1m"), runs from a negative or ambiguous low to an unsigned high ("-2%-8%"), keeps
  a scale or unit only on the low ("1.2bn-1.4", "7%-15"), has a high endpoint that does not parse, or chains three
  or more numbers ("1-2-3%"). An endpoint still bare after sharing withholds the claim when its partner is a figure,
  across a tight dash, a spaced dash, or a signed spaced number ("7% -15"). A spaced range shares nothing, so it
  withholds when one endpoint carries a scale, unit or currency the other lacks ("$1.2 - 1.4 billion"). A claim
  figure with an unreadable sign or range fails as `figure-ambiguous`. A hyphen glued to a word before a figure may be
  its sign, so the figure and any range it starts withhold ("Revenue-$574.9 million", "profit-5m-9"); a bare count
  there is dropped ("COVID-19"). A dash glued to a word after a figure keeps a scaled or unit figure whole ("$574.9
  million—up") and withholds one whose scale may follow ("$5-million"). A bare number there withholds, since the
  word may be a unit ("5-per-cent", "25-basis-point", "5-fold"), unless the word is a time noun, a month
  abbreviation, a single capital letter other than the scale letters K, M and B, or an SEC form code ("52-week",
  "30-Jun", "20-F", "10-K"; "5-M" withholds); such a count is dropped and ends any range. SEC accession ids
  ("sec-8k-0001193125-26-337999") are not figures. A whole number with only an M or B letter scale and no currency
  or unit ("9M FY2026", "3m ago", "1M 6M" chart tabs) may be a period or a time, so it withholds, with any range it
  ends; a currency, unit, decimal or comma grouping keeps it ("RM9m", "9M USD", "12.3M", "9,000M"), and "k" always
  stays a scale ("16k GPUs"). A word range ("-9 to -3%", "between 5 and 7%", "1 to 2 billion") keeps a plain low
  endpoint (no scale, unit or currency of its own), which takes the high's scale, unit and currency, unless the low
  is a year ("fiscal 2024 to 51%") or both endpoints are bare. The low withholds when it exceeds the high ("from 500
  to 2 million", "up 100 to $5 million") or the high withholds ("5 to $7-million").
- A deterministic source is quotable only through its snippet and item summaries; a figure held in a structured
  field those omit can reach a web-cited claim only as a metric reference, or the claim prunes.
- Pre-change profiles fail reuse once and are regenerated, one profile stage per subject.
- News-kind sources and the qualitative summary are outside the check.
- A redirected run collects market data twice (typed code, then the resolved code).
- Issuer Report Figures are interim and annual table rows only. TTM, multi-year history, and Valuation Evidence
  do not read them yet. The Business Framework reads their same-basis YoY rows (amended 2026-11-07): on a run
  without SEC facts, Revenue YoY and Net income YoY take the newest period end, then the longest length (annual,
  year to date, quarter), as the statement path does; net income is profit attributable to owners, the parent
  scope US GAAP net income has. A withheld row keeps its reason, and the framework is re-derived after the phase. The mapping call reads at most four documents, so four fetched 32k-character
  pages bound its input at about 32k tokens (one fetched report adds about 8k). A mirror page that changes its table layout degrades to withheld figures, never to a guessed value.
