# ADR 0004: Evidence and model-stage pipeline

## Status

Accepted

## Context

Evidence acquisition, deterministic analysis, and model reasoning must share identity, temporal, citation, and
authority boundaries. Deep equity retains the measured stronger specialist/Coverage Panel path.

## Decision

- Keep `symbol + assetClass` as compatibility identity for CLI, matching, forecast DSL, history, and scoring.
  Preserve provider exchange, quote currency, name, IDs, and aliases. Derive one run-scoped identity from the
  collected market snapshot; no second identity fetch or cross-provider reconciliation. Disclose conflicts and
  inject identity into prompts.
- The local checked-in equity Research Subject Registry owns canonical keys, aliases, representatives,
  provenance, and optional single listed ETF proxies. Misses/no eligible proxy allow research without scored
  Predictions. Representatives are context, never implicit proxies or peers.
- Typed providers expose optional market, supplemental, news, Extended Evidence, and Market Context
  capabilities; compose one primary market adapter plus supplements by asset class. Shared HTTP execution owns
  timeouts, retries, rate limits, circuit breakers, freshness caching, stale audit fallback, and raw capture.
  Missing required primary coverage and configured failures emit typed Source Gaps; unconfigured optional
  providers may be silent.
- Yahoo is primary equity data; CoinGecko is primary crypto. Massive optionally supplements/falls back on
  selected Yahoo quote, benchmark, alpha-validation, and legacy scoring-close paths, never movers/regime
  labels. Scoring promotion requires explicit observation semantics/tests; fallback is not a generic registry
  capability ([ADR 0003](./0003-forecasts-scoring-and-calibration.md)).
- Thematic news derives search terms from checked-in names/aliases without changing generic-only providers. If
  no relevant provider item exists before seen filtering, bounded Exa/Firecrawl news fallback enters normal
  relevance, normalization, dedupe, seen, and selection processing.
- `observedAt`/Source `fetchedAt` means acquisition time, never quote freshness. Optional `quoteTimeUtc` is
  the provider's actual UTC quote timestamp, omitted if unknown, never null/fabricated. Deterministic
  renderers distinguish quote time from fetch-time-only; valuation freshness migration is separate. The model
  allowlist omits this field and preserves surviving JSON key order.
- Freeze Source Plan v2 and `generatedAt` before provider I/O, using only command, checked-in subject/policy,
  asset class, and depth; credentials, availability, and outcomes cannot alter applicability/class. Evidence
  Lanes/Source Ledger assess coverage, gaps, freshness, corroboration, and traceability afterward. Historical
  artifacts are not rewritten.
- Source Gaps persist deterministic `material`/`diagnostic` triage from structured cause, source/reason,
  provider, and symbol scope; readers prefer it and classify legacy gaps only when absent. `dataGaps` is a
  string projection.
- Evidence Quality is deterministic: unusable core → low; complete core with missing material
  coverage/corroboration or present-but-unsupportable material evidence → medium; high requires broad, fresh,
  corroborated, usable material coverage. Supplemental failures add rubric-v3 advisory reasons without
  lowering the grade. Models cannot author/lower it.
- Every model evidence payload carries `analysisAsOf`; exclude facts published, filed, or ending after cutoff
  where provider semantics allow. Validate freshness-budgeted cache entries; failed refresh leaves stale
  content raw-audit-only with a gap, never normalized current evidence.
- Accession-addressed HTTPS SEC archive GETs (CIK/18-digit accession/document, excluding generated indexes)
  reuse archived snapshots across days for 30 days from original fetch, then revalidate. Keep original fetch
  metadata, reparse each run, refetch invalid entries, and treat expired fallback as raw-only; companyfacts
  retains its 24-hour budget.
- Bound response bodies: default 5,000,000 bytes; SEC filing text, release exhibits, and companyfacts
  provisionally 16,000,000. Declared/streamed overflow emits `validation-failed`/`response-too-large`, without
  retry or circuit-breaker debit; Provider Health and failed-request audits still count failure.
- Deep instrument and all thematic runs may gather bounded subject-constrained web evidence. Exa is primary;
  Firecrawl is fallback for configured Exa failure/thinness, never a missing Exa key. Persist cached low-trust
  `web` Sources/provenance and attempted/serving provider, fallback reason, and paid-credit audits. Web
  evidence cannot replace core market/regulatory/pricing evidence.
- Company SEC 10-K/Q coverage rejects redundant background/current-subject searches without recency,
  corroboration, or explicit-gap rationale; news/market searches are exempt. Reused-profile coverage applies
  that guard to background only, including themes.
- Deep US-equity filing evidence includes latest 10-K, newer 10-Q, and up to two 8-Ks within 120 days. Routine
  reports postdate the periodic basis; newest Item 2.02 gets a slot regardless. Prefer substantive EX-99
  results, retain item/exhibit provenance, and gap absent substantive results. FPIs without 10-K/Q retain
  latest 20-F/40-F metadata and attempt two 6-Ks without earnings credentials; annual-section parsing remains
  unsupported. Domestic filers without 10-K/Q get no current-report packet.
- Company profile freshness uses durable 10-K/Q or FPI 20-F/40-F, excluding 8-K/6-K. Current events can
  therefore leave reused profiles valid until TTL; disclose age/filing basis. Title dedupe rejects incoming
  web candidates at maximum Jaccard/containment similarity 0.8 with at least three normalized tokens; audit
  `duplicate-headline`, never empty coverage or emit a gap.
- Web Subject Profiles use fixed cited questions and bounded TTLs. Reuse requires identical text for every
  already-collected cited Source; changed/text-less copies try older compatible profiles, else re-extract, and
  later gather collisions retain reused Sources. Extraction/validation share one selector: web plus company
  10-K/Q filing-text Sources only, excluding current reports, fundamentals, news, snapshots, history, and
  prior profiles.
- Sanitize all provider-controlled prose/labels, SEC text, and prompt-bound legacy history through
  provider-neutral profiles before model exposure; raw/history remain unchanged. Persist text-free
  provider/ingress/profile/role aggregates; rejected/empty normalized content emits aggregated non-fatal
  validation gaps where applicable. Fingerprint effective non-secret settings and dirty source state.
- Deep equity uses one explicit acquisition recipe: Yahoo target identity/quote, parallel provider packets
  (including supplemental market), dependent peers/web, deterministic derivations, finalized
  `DeepEquityEvidenceBundleV1`. Recipe keys supply frozen lanes and executable tasks, not a generic task
  graph. Bundle-only persistence/read authority follows [ADR 0002](./0002-platform-and-persistence.md).
- Fetch the target SEC ticker map, companyfacts, and submissions once; share SIC/filings across statements,
  history, lenses, financing, ownership, valuation, and framework. Base failure suppresses dependents with
  typed gaps; executor owns retries. Each peer packet shares the map and owns its Yahoo/SEC inputs. Tradier
  fetches expirations once and each unique event/7/30/60/90-day chain once; IV, implied move, and term
  structure derive deterministically.
- Adaptive deep-equity web acquisition uses one planning call and one parallel search/fetch batch; existing
  fallback, sanitization, relevance, dedupe, profile, and reconciliation authority remains.
- Every equity instrument attempts a citeable Yahoo OHLCV Verified Market Snapshot through cached requests and
  the locked indicator schema; failure is a core gap, never a Massive close substitute. Console renders from
  parsed artifacts regardless of bundle/sidecar layout. Deep thematic runs attempt representative snapshots
  with per-representative gaps, never primary core gaps. Raw indicators remain split-unadjusted; UTC slices
  may differ from local exchange dates.
- Metric Sections are flat ordered pure definitions over raw inputs, never other metrics. Persist deep
  `derived.metricSections`, project all layouts through report extras. Missing statements still produce
  Capital Return/Operating Ratios missing rows and section gaps; missing debt/buybacks never means zero.
  Structural `not-filed`, bounded issuer `insufficient-history`, and workbench `outside-price-history-window`
  are diagnostic; other missing inputs and independently unresolved inputs stay material.
- Issuer insufficient history requires completed data beginning 8–14 days after anniversary; later starts do
  not prove listing age. Issuer returns use own sessions; benchmark comparisons (SPY, or the Exchange Profile benchmark per
  ADR 0006) require common completed sessions and benchmark coverage. Missing benchmark history preserves
  issuer returns, never falls back to SPY; fetch failure declares Yahoo gap. Workbench
  outside-window status needs requested start and usable returned closes; unavailable history, interior
  missing bars, and failures remain material. Lifecycle values require cited classification inputs. When the
  `goodwill` balance-sheet series (undimensioned `Goodwill`, a cap follower) steps up by ≥10% of prior total assets
  (S-X 1-02(w)) between the revenue YoY period ends, Phase and both revenue YoY rows keep their values, cite both
  goodwill instants and prior total assets, and their basis says organic growth is not established. Price
  Performance, Workbench, and snapshot share issuer history; the first two share completed split-adjusted
  closes/source IDs.
- Financial Lens metrics retain per-metric citations: SEC for filing-intrinsic facts, Yahoo for
  price-relative/non-US fallback. Parent `NetIncomeLoss` remains net income; consolidated `ProfitLoss` is
  otherwise separate, same-period disclosure. ROE/ROA keep parent income and existing balance scopes.
- A sanctioned tag splice: a period without `NetIncomeLoss` takes a derived `ProfitLoss` net income
  only when no noncontrolling-interest income fact observable at the analysis cutoff is tagged for it, or
  all are zero and a zero `NetIncomeLossAttributableToNoncontrollingInterest` shares a filing with a
  `ProfitLoss` of the current value (partial-scope or comprehensive zeros alone, or any nonzero NCI,
  block); and the newest same filing/form/span/unit `NetIncomeLoss`/`ProfitLoss` pair agrees. An
  unexplained difference withholds without implying NCI. Untagged `GrossProfit` derives as revenue −
  `CostOfRevenue`/`CostOfGoodsAndServicesSold` only when current revisions share a defined accession, form,
  span, and unit. Both carry derived lineage, and metric basis, lens captions, and history cards disclose
  the formula (tagged cost of revenue may exclude amortization or D&A). Each withheld period is a declared
  gap.
- Keep operations scope (continuing/total), attribution (parent/NCI), and SEC/provider earnings basis
  independent; equal values do not establish equal scope. Continuing income/EPS are separate series (parent
  preferred on equal period), never replacements for total income/EPS or total-income ROE/ROA/payout. Net
  margin is the exception: revenue is a continuing, consolidated line (ASC 205-20, ASC 810), so it divides
  consolidated income including NCI (`ProfitLoss`, or continuing income including NCI where tagged for the
  period) by revenue. Parent-attributed income stands in only for a period with no NCI income. A period with
  discontinued operations and no continuing income, or with NCI income and no income including NCI, is
  withheld with a gap; a TTM is withheld when any FY, YTD, or prior-YTD component is.
  Older continuing data is history, not a current split. Current counterparts require total-operation labels
  through summaries, Growth, framework, trends, and Workbench P/E; label growth scope. A YoY is not meaningful
  on a zero or negative prior, a negative latest, or a positive income, gross profit or OCF prior below 2% of
  same-period revenue (EPS reads its income series); no same-period revenue publishes with a basis note
  (amended 2026-11-12: HLIT continuing income +1,666% on 0.88% of revenue).
- Cash conversion pairs OCF/income by operations scope, period, currency, and unit. Missing compatible
  continuing income withholds ratio with gap; a zero, negative or below-2%-of-same-period-revenue denominator
  withholds without gap (amended 2026-11-12: NBIS FY2025 published 41.0x on 9.8M of 529.8M revenue). Deterministic
  Markdown/Console EPS/P/E disclosure retains provider basis as undisclosed and SEC approximate
  diluted/continuing TTM with dates; state two-decimal agreement, mismatch, or currency mismatch without
  substitution or invented explanation.
- Fundamental History selects revenue concepts by configured order within 100 days of newest eligible period;
  other series prefer newest period then order. Scope-bearing order outranks depth/prior availability, remains
  test-pinned, and whole-concept selection never splices tags, except operating cash flow: each period takes
  the continuing amount where it is tagged, differs from total, and is as current; else total when the period
  reports no discontinued operations; else total minus the discontinued component filed with the newest total (a recast supersedes it, APLD FY2023):
  `CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations` (HLIT FY2025: 107,966K − 2,532K); else it is withheld with a gap. Beside continuing OCF, capex publishes unqualified when the OCF's own
  filing's calculation linkbase, with locators resolved against the FASB taxonomy and the filing's extension schema,
  reaches `NetCashProvidedByUsedInInvestingActivitiesContinuingOperations` from the capex concept on one path
  (no second parent, no cycle) at composed weight −1, and that filing tags the subtotal for the same period
  (AMD FY2025, CLFD FY2023–25). Without that proof, a period with a nonzero discontinued-operations investing or capex
  fact in any unit withholds capex and FCF with a gap (HLIT FY2025, EBAY FY2019–22). The fact can be companyfacts
  `CashProvidedByUsedInInvestingActivitiesDiscontinuedOperations`, `CapitalExpenditureDiscontinuedOperations` or the
  IFRS investing concept. It can also be an inline-XBRL fact, under any prefix and in any context, in a fetched
  filing of any form with a report date. That includes discontinued investing or capex concepts, and capex on a
  `Discontinued…Member`. Otherwise capex publishes as filed with a `capex-scope-unproven` note. Tag co-occurrence,
  equal values, and net-investing equality are not proofs. Only the latest 10-K's and current 10-Q's linkbases are
  fetched, plus any older 10-K/10-Q linkbase the debt-face zero-borrowings proof already read (no extra request), so
  20-F periods and other periods supplied by an older filing are never proven. Evidence is read only from filings the run fetches, so a 6-K without a report date, or
  a filing outside the selected set, is not scanned. IFRS OCF takes the tagged
  `CashFlowsFromUsedInOperatingActivitiesContinuingOperations` in a period with a nonzero discontinued profit,
  discontinued OCF or discontinued investing fact, or where it differs from total. It does so only when the
  continuing amount is filed no earlier than the newest total; otherwise the period is withheld. IFRS capex beside
  it follows the same capex rule. Narrower current concepts carry continuing-operation labels through every OCF/FCF consumer. Apply cutoff; keep up to ten 10–14-month 10-K
  periods and latest-filed restatements. A later filing's duration fact (per concept and unit) restates
  only when that filing also tags the concept on a duration ending at one of its statement dates (a pre-filing
  date with both an `Assets` instant and an 80+ day duration), in any year, ±7 days. Otherwise a value that
  differs from the standing one (the latest earlier filing's) is dropped before selection: the standing value
  keeps no `restatedFrom`, and for a series-selected concept an `unproven-restatement` Source Gap is declared
  unless a later filing within the cutoff supersedes it. Instants are never touched; with no statement date,
  latest-filed still wins (amended 2026-11-15: CLSK 10-Q 0001193125-26-338382 tagged its EPS table a quarter
  early). Derive TTM as FY + aligned current YTD − prior YTD; mismatches are
  omitted/audited. Each component is the fact its series already selected; a difference in concept or
  extraction method is disclosed on the published TTM with a `ttm-component-basis` note (also on the workbench TTM input derivation). EPS TTM is approximate; FCF/margins/CAGR/margin change need matched periods/units and CAGR
  is annual-only.
- A canonical versioned financial-statements artifact accepts standard us-gaap/ifrs-full 10-K/Q/20-F/6-K and
  amendments. It drives history, lenses, valuation, APIs, and completeness through tested seams; fundamental
  history has no legacy derivation. Offline canonical/legacy financial-lens corpus differences need matches
  or exact fixture-specific allowances. Historical non-deep
  artifacts without sidecars/completeness stay readable.
- Canonical facts apply cutoff before selection, one taxonomy/currency, no extension primary totals. Facts in
  the elected currency from a filing whose revenue names another currency are convenience translations: they are
  excluded, and a `translation-filing` gap names the filings; share counts stay. Matching
  periods resolve by filed date, amendment, accession, never unrelated periods. Preserve
  form/accession/filing/period/fiscal/taxonomy/unit/scale/extraction/citation provenance; absent accessions
  stay null with notes. Shared roster caps ten annual/twelve interim exact periods, detects cadence, and
  derives TTM only with exact FY/current/prior-YTD components retained. Disclose duplicates, mixed
  periods/currencies, incomplete statements, cutoff, caps, and unreconciled TTM.
- Debt is lease-exclusive borrowing, resolved per instant by the canonical rule (the SEC summary reads it): standard total
  first, otherwise disjoint component sum with every contributor and derived lineage.
  Aliases/totals/constituents are alternatives, never double-counted; generic noncurrent long-term debt and
  `DebtCurrent` subsume side instruments and convertible aliases. Issuers tag current instruments (short-term
  borrowings, lines of credit, notes, current convertibles) inside (AMAT) or beside (GPN) a nonzero
  current-maturities line, and equal amounts prove neither. An instrument added beside maturities needs the same
  instant's `DebtCurrent` to sum both; one left out needs the selected total to equal the lines plus it;
  otherwise the instant is a gap. Commercial paper is never a long-term maturity and adds beside it (Apple), but
  a selected total must still sum it. `DebtCurrent` is the balance-sheet current line and outranks narrower
  `LongTermDebtCurrent` maturities (INTC FY2018: 1,261M vs 761M), unless a nonzero `CapitalLeaseObligationsCurrent`
  shows a `DebtCurrent` above the maturities may hold leases no finance-lease leg deducts (LRCX FY2018). A combined total that differs
  from both same-filing classified lines and their component sum is refused for them (AVGO FY2024 principal, QCOM
  FY2019 omits paper).
- `LineOfCredit` covers both legs: use tagged legs instead only if their sum equals the tagged umbrella,
  otherwise refuse; with no legs but a generic side, refuse overlap. Continuity coverage requires both legs or
  tagged legs summing to the umbrella. Exclude operating/finance leases; subtract matching same-instant tagged
  finance leases from lease-inclusive aggregates, else retain with a no-cap possible-lease gap.
- Composite debt needs a borrowing line, no unrecognized standard borrowing tag, and coverage of every prior
  nonzero borrowing concept within 400 days or an earlier same-instant filing; generic sides cover prior
  constituent details. The lines that decide a published composite come from one filing: when the instant's
  debt lines, liability subtotals or principal inputs carry nonzero values from two filings, one filing's own
  values plus other filings' tagged zeros must resolve complete, either through the same nonzero lines as the
  mixed composite (an equal sum through other lines is not enough) or with every other same-form filing at
  the instant repeating its values (absent lines only if zero or a named non-borrowing row). That filing's own
  resolution then publishes attributed to it; otherwise the instant withholds with a note naming the filings
  (GOOGL 2023-12-31, IBM, AVGO FY2020). Other forms' filings resolve in their own groups. A mixed composite
  that resolves complete but is withheld still contests partial-comparative recovery with its value.
  Other filings' facts stay in that resolution as obligations (prior nonzero lines still need coverage,
  principal due within a year still needs a current line); they only stop vouching for its lines. An older filing's nonzero line is not proven to hold
  in a newer presentation, so it may neither add to nor prove another filing's result. A filing
  is its accession, else form and filing date; cached companyfacts always carry one (0 of 162,124 debt facts
  and 3,117 run facts lack it, 2026-11-03). Restated components need one filing date (same-day accessions count together) and
  unchanged original total (reclassification), otherwise no composite. Later incomplete filings supersede
  earlier complete same-instant data. Another filing's same-day resolution counts as later evidence for
  partial-comparative recovery; same-day resolutions that still conflict (an unrecovered partial, different
  totals, or a shared line at different values) withhold the instant with a note naming every same-day
  accession, never broken by accession order (CORZ 2024-12-31 recast, filed 2026-03-02). A debt series may mix recognized totals and
  composites resolved under these rules; YoY priors keep one basis, except that classified carrying lines and a
  `LongTermDebt` total equal to its own filing's nonzero lines compare across bases (NVDA 2025-07-27 8,466M
  noncurrent vs 2026-07-26 33,366M total); a lone or unreconciled total does not. `OtherLongTermDebt` is a
  constituent detail inside a tagged noncurrent line or total (AMD FY2016), and a gap when tagged nonzero with
  neither. A `DebtLongtermAndShorttermCombinedAmount` equal to current maturities plus noncurrent debt holds a
  short-term tag no larger than those maturities when any tagged `DebtCurrent` equals the maturities (AMD FY2025:
  874M tagged both ways, 3,222M combined); a larger tag or a `DebtCurrent` above the maturities still gaps. `LongTermDebt` scope is read only
  from lines its own filing tags at that instant: it is the total alone (no nonzero current debt in any filing,
  no short-term borrowing reported nonzero within 400 days) or when it equals nonzero current plus noncurrent
  lines, which outranks other totals (a combined total can be principal, AVGO) unless a later filing restated
  them; with explicit lines it may sit between the noncurrent line and their sum, or maturities plus noncurrent (principal vs carrying). Below the
  noncurrent line, above the sum, beside current debt with no noncurrent line, unless the same filing's
  `LiabilitiesNoncurrent` (else `Liabilities − LiabilitiesCurrent`) equals nonzero `LongTermDebt` plus the
  allowlisted noncurrent liability lines exactly, which proves it is the noncurrent line (ADBE 2026-08-28 6,363M,
  NOW 2026-06-30 7,517M); short-term borrowings alone never prove it (UBER), and an unclosed identity is a gap; or a total whose lines a later
  filing restated, it is a gap, never inferred from other filings or equal amounts. Absence is not zero, tagged zeros
  count, and standard-tag completeness is not proof about omitted dimensional/extension facts.
  A `LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities` total that differs from its own tagged
  current and noncurrent legs by exactly `DebtInstrumentUnamortizedDiscountPremiumAndDebtIssuanceCostsNet` is
  principal (VSAT 6,570.503M − 128.104M = 6,442.399M lines, 2026-06-30), so the legs are used and the lease total is
  deducted from both; any other difference keeps the total. Elsewhere a `FinanceLeaseLiability` total across two
  lease-inclusive legs is a gap (split unknown), and a later filing's restated lease deduction is a gap like any
  restated component. A nonzero instrument tag larger than the total or side line that would have to hold it cannot be
  inside it and is a gap (AAOI 134.497M convertibles vs 26.682M `LongTermDebt`, 2024-12-31). Continuity history on the
  legacy path also reads 20-F/40-F/6-K facts, as the canonical path does (HIVE).
  Without a total, a positive `LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths` beside no current
  debt line is incomplete unless principal minus unamortized costs equals the composite exactly (PYPL vs META).
- A complete instant whose every gross line is its own row on a footing face statement from the same accession is
  checked against that face: a tagged amount unequal to its face row withholds debt; another nonzero face borrowing
  row (standard, or an extension whose name and label both read as debt) is beside those lines and withholds debt
  rather than being subsumed; a face finance-lease row is not deducted and clears the possible-lease gap for its own
  side only (other sides keep their deductions and gaps).
- Never publish an incomplete debt instant, and never let an older amount stand in for one. Every incomplete instant
  emits a dated `incomplete-composite-series` note. When the newest debt instant is incomplete, both paths drop the
  latest-debt metrics: SEC prose, the lens debt row, the financial-position projection, peers, alpha debt features,
  target EV, net debt, debt/equity, debt/market cap and net debt/market cap. One dated `SEC debt withheld` Source Gap
  names the period end and reason. Complete older instants stay only as dated balance-sheet history; the lens debt row
  is also capped at 180 days. The Workbench drops debt when an incomplete instant falls at or before cash. Older
  instants are checked by the same rules, which prove only what the tagged facts show (see above). Direct facts remain
  `sec-companyfacts` without composite metadata; artifact extraction method stays companyfacts.
- A strictly newer `DebtInstrumentCarryingAmount` instant, calibrated to net debt at net's selected period within
  ±5% inclusive (zero matches zero) with no nonzero current debt or principal due within a year there, shows debt
  continues but tags only principal (face value, before unamortized discount and issuance costs). EV and net debt
  use the balance-sheet carrying amount, so that instant is withheld with an `incomplete-composite-series` note and
  no older or principal amount stands in (HUT 2026-06-30 principal 7,735.1M vs balance-sheet carrying 7,638.4M); without that
  calibration, net is retained.
- US-GAAP D&A prefers combined per period unless below either same-period/duration/unit component by over 1%
  of that component's absolute value. Missing/rejected combined falls back only to complete same-date/currency
  depreciation (or nonproduction) plus intangible amortization, both known at cutoff; never infer zero. When one
  filing tags both cash-flow lines (`OtherDepreciationAndAmortization` + `AdjustmentForAmortization`, no conflicting
  same-filing duplicate), the add-back is within 1% of or below intangible amortization, and their sum is not more
  than 1% below the components, that sum replaces the components (AMD FY2023–25).
  A plain component sum (annual or interim) publishes with an `unchecked-component-sum` note: it is not checked against the
  cash-flow statement. Same-filing face verification was tried and dropped, because name-pattern iXBRL scanning
  cannot prove the row set (extension names, nesting, units): MSFT FY2025 face `msft:DepreciationAmortizationAndOther`
  34,153M vs 28.0B components; INTC face rows match companyfacts. The filing's XBRL calculation linkbase proves the row
  set instead: the latest 10-K's and current 10-Q's schema (or the `_cal.xml` it references) is read once per filing, as is any older 10-K/10-Q linkbase the debt-face proof already read, and a component sum from that
  accession publishes without the note only when operating cash flow's D&A-like summation children are exactly its two
  concepts, each weight +1 (ORCL, ABBV, GLW). Amount equality is never the proof. Any other child set (MSFT's extension
  line), another accession, or no linkbase keeps the note and names the reason; a schema naming more than one
  calculation linkbase, or one beside an embedded calculationLink, reads as a conflict, since the unread network
  could change the child set.
  Equality/within tolerance keeps combined. Rejected/incomplete fallback emits period-specific omission/gap
  and Markdown/Console note; retain lineage and name EBITDA proxy basis. A selected combined fact more than 1%
  below the other same-period combined alias (DDA under DA) is withheld, never replaced by the higher alias; the
  reverse split publishes. IFRS is unchanged.
- Never splice alternative financial concepts to extend history, except a forward-only revenue extension: a
  newer total-revenue roster alias appends only periods ending after the selected concept's latest period end,
  when one of those filings tags, or derives as YTD less a later-starting part, a selected span with the exact
  same start, end and value; no raw or derived span differs in either direction, no other roster concept files a
  different value for an appended span, units match, and each appended period is public no earlier than its
  proof's filing. Emit `revenue-concept-splice` with structured proof fields, which invariant A10 checks
  (amended 2026-11-12: KEEL Q2 2026, TAYD Q1 FY2027). Otherwise, shortening is silent unless an alias has a
  newer period of any type, or any annual period when selected has none: emit `stale-concept-history` without
  combining. Offline alias detection requires eligible same-unit/currency strict annual superset with exact
  shared value/form/fiscal/period/filing tuples; no-overlap renames are not interchangeable proof. EPS TTM can
  mix independently restated YTD facts and remains approximate. Consistent integer/reciprocal share
  restatements mark older incompatible periods `mixed-share-basis`; never rescale, withhold touching TTM/EPS
  CAGR/priors, and disclose on charts/tables. Likewise a later filing's restatement of at least 0.1% of the originally filed value (any change
  from an original of 0) marks older retained annual history points it did not re-present `earlier-basis`
  (unless already on an earlier share basis); smaller deltas are re-roundings and mark nothing. Never splice
  or rescale, withhold CAGR/margin change touching them, and disclose on Financial Trends and history
  cards.
- Equity Analysis Completeness grades issuer-achievable reporting, distinct from source-achieved Evidence
  Quality. Only canonical primary financials determine `financialCoreStatus`; other dimensions affect
  coverage. Credentials/entitlements never mean not-applicable. Complete sourcing may coexist with incomplete
  reporting without lowering Evidence Quality.
- Primary completeness requires usable current annual basis, three comparable annual periods, one currency,
  applicable per-share evidence, and reconciled TTM or annual-as-current before cadence-specific interim due
  date. Evaluate quarterly/semiannual/irregular/annual-only/unknown separately. Missing current annual basis
  alone blocks; history/reconciliation/current material balance/cash-flow defects are partial, historical
  omissions are not. Four quarter-only periods or exact reconciled FY/YTD TTM establish trailing coverage;
  annual-as-current keeps an informational code. Missing shares stay missing unless checked-in evidence proves
  non-issuance.
- Expose `interimCadence`/`latestReportedPeriodEnd` on existing Financial Lens metrics whenever primary
  revenue has a reported period, plus due period when applicable; omit freshness block without one. Freshness
  Source Gap allowlist: `current-annual-statement-missing`, `annual-history-insufficient`,
  `latest-due-interim-missing`, `quarterly-periods-insufficient`, `semiannual-comparison-missing`,
  `irregular-comparison-missing`, `ttm-unreconciled`, `cadence-unestablished`, `per-share-evidence-missing`,
  `current-primary-statements-incomplete`, `untagged-interim-evidence`, `reporting-currency-missing`,
  `reporting-currency-ambiguous` (set on the blocked result when the reporting-currency election is
  ambiguous), `reporting-currency-incompatible`, `subsequent-financing-unreconciled`. All are no-cap; exclude
  informational/non-freshness reasons and blocked `current-annual-statement-unavailable` from this
  issuer-attributed channel.
- `not-assessed` means deployment inputs never configured/available, including KPI registry or estimate
  entitlements; `partial` means assessed/incomplete. Not-assessed never counts complete or grades above
  partial. Checked-in issuer KPI registry (ASTS/NBIS initially) alone controls applicability; generic
  financials cannot complete it. Unregistered → `operating-kpi-registry-unconfigured`; not-applicable needs
  explicit registry declaration backed by run-present Sources. KPI verification/completion remains deferred;
  aliases/section rules are declarative.
- Standard-tag post-period 8-K/6-K financing may form a bridge retaining disclosure/event dates, class,
  gross/net/costs, and citations. Never change filed balances/ratios/valuation or derive pro-forma cash; null
  costs remain null. Omit events covered by later canonical periods; otherwise unreconciled events mark
  Financial Strength partial. Narrative-only financing is outside this bridge.
- Additional dimension evidence keeps completeness v1/core authority unchanged. Finnhub entitlement is
  endpoint-observed: consume 200, gap/reason missing keys or 403 without abort. Expectations is not-assessed
  with no assessed inputs, otherwise partial if incomplete; EPS/revenue consensus or calendar fallback can
  complete it. Price targets are structured attributed external context only, never completeness or authored
  valuation. Institutional/insider context is supplementary; SEC share/SBC/payout/debt remains
  capital-ownership authority, and Finnhub cannot complete/change its status or make it not-applicable.
- Peer resolution prefers checked-in ticker mappings, then subject representatives, then cached/quick-model
  nominations validated for existence, US listing, common-stock eligibility, quotes/facts/freshness. Proposal
  prompts carry available SIC and 0.2x–5x market-cap/revenue bands. Revalidate learned peers; models never
  author the admitted set.
- Learned feedback records usable count and up to eight exclusions per generation, unless target cap/SIC is
  missing, a transient peer failure occurs, or stale cache is used; permanent rejects still record. Older
  feedback never replaces newer. Re-proposals receive fixed cause labels, never provider text, without
  changing allowance. Usable generations below three peers claim one refresh per TTL under lock before
  calling; insufficient results consume it while old peers serve. Release on directory/model unavailability or
  insufficient proposal with failed listing-directory unresolved candidates; healthy directories still
  validate survivors. Superseded proposer revisions do not consume the window.
- Expired/invalid learned entries re-propose as misses without spending refresh allowance; defer all proposals
  without positive target cap/SIC. Writes compare-and-set against observed generation.
  Deferred/unclaimed/unavailable/insufficient refresh emits diagnostic gap; directory/model inability leaves
  unresolved universe `provider-data-missing`, never unsupported coverage.
- Target and peer revenue is SEC TTM (FY + latest YTD − prior YTD, or a 12-month fact); never annualize a
  partial period. A peer without TTM is excluded with its reason; a target without it withholds revenue multiples.
- Peer median/IQR needs three fresh supported peers, inclusive 0.2x–5x target cap/revenue, and same two-digit
  SIC under full profile. Curated ticker mappings skip all three SIC checks (`curated-no-sic`); other tiers
  enforce full. Revenue-exempt profile takes precedence when target EV/revenue >50x or revenue <2% of cap:
  enforce SIC/cap, omit revenue band, label revenue not meaningful and peers size/sector-only. Missing inputs
  exclude with retained reasons; business-model metadata never overrides gates. Persist profile; disclose
  coarse economic comparability.
- Peer-implied range applies peer EV/revenue P25/median/P75 to target revenue, subtracts net debt and the
  target's noncontrolling interest, preferred stock and temporary equity, divides by Yahoo shares from the
  same quote as cap/price. Gates in order: supported comps, three peers, positive revenue, defined
  non-mixed-period net debt, known noncontrolling interest, preferred stock and temporary equity, positive
  shares, USD quote, three positive prices, defined current price. First failure persists reason/gap; retain
  formula/basis/inputs. Endpoints are within-range; only strict inequality is outside. This is context,
  never a composite score ([ADR 0001](./0001-research-only-boundary.md)).
- Preserve quote/cash/debt dates; date market cap by quote timestamp else explicitly fetch time, retaining
  acquisition provenance. Quote-to-balance gaps >92 days flag but do not suppress EV. Cash-to-debt gaps >92
  days withhold EV/net debt across target, peers, lenses, Workbench and emit target gap even in brief.
  Disclose borrowing-based, finance-lease-exclusive EV.
- EV = market cap + debt + preferred stock (carrying amount) + noncontrolling interest + temporary equity
  (redeemable noncontrolling interest and redeemable preferred, carrying amount) − cash − short-term
  investments; net debt = debt − cash − short-term investments; long-term investments stay out (CFA
  Institute market-based valuation; Damodaran's cash and marketable securities). One shared EV Bridge
  resolver serves the legacy summary, the canonical artifact, peers, lenses, reverse DCF and the Workbench
  (point-in-time at `publicAt`). Each component is read at the cash instant from priority alternatives,
  never summed (`ShortTermInvestments` > `MarketableSecuritiesCurrent` >
  `AvailableForSaleSecuritiesDebtSecuritiesCurrent` > `DebtSecuritiesCurrent`, else
  `CashCashEquivalentsAndShortTermInvestments` − cash; current equity securities add to a debt-only pick:
  `EquitySecuritiesFvNiCurrent` unless current assets already sum without it, and the generic
  `EquitySecuritiesFvNi` only when it closes the current-asset identity with receivables, inventory and other
  current assets all tagged (NVDA FY2027 Q2: 42,783M; usually it is a noncurrent holding, META, MRK); explicit
  current equity beside any other pick is incomplete. Added equity keeps its own lineage row and is disclosed as
  possibly sale-restricted, not cash on hand (NVDA Note 5); `MinorityInterest`; `PreferredStockValue` >
  `PreferredStockValueOutstanding`; the equity-stack temporary-equity carrying concepts, then
  `TemporaryEquityCarryingAmountAttributableToParent`). Tagged zeros count; a nonzero fact within 400 days
  but absent at the instant is incomplete (the composite-debt continuity rule), as is a combined line that
  differs from cash + the picked short-term line (an unclassified holding: Check Point FY2025 combines
  deposits and long-term securities), or nonzero temporary equity that does not equal assets − liabilities −
  equity (including NCI) exactly (filed face totals foot), or cannot be checked for lack of those lines; that identity
  is what keeps temporary equity from double counting `MinorityInterest`. Untagged `MinorityInterest` is
  derived as equity including NCI − parent equity only when positive and assets − liabilities − equity
  including NCI − temporary equity reconciles (UBER 2026-06-30: 903M); otherwise it is incomplete. Otherwise
  untagged counts as zero. Incomplete short-term investments withhold EV, net debt and their multiples;
  incomplete noncontrolling interest, preferred stock or temporary equity withholds EV only; both emit one
  no-cap `SEC EV bridge incomplete` gap, and peers exclude with that reason. Non-us-gaap issuers have no
  bridge yet, so EV and net debt are withheld rather than published without investments. An artifact whose
  bridge predates a resolver input still reads without the bridge, with a read-diagnostic drop: a fresh EV
  computation with the current resolver withholds EV, while the saved report and its re-projection keep the
  EV it published under its own saved basis and concepts.
- Financial Strength uses balance-sheet inputs within 180 days of cutoff and 92 days of newest current
  balance-sheet period; canonical ratios check paired period, fallback checks every input. Stale net
  debt/current ratio is unknown, not failed; framework Risk uses same current-ratio gate. Withhold stale
  debt/equity, debt/cap, net-debt/cap, and EV with its multiples (EV/TTM revenue, the comps target row,
  reverse DCF) when debt or cash is stale; retain dated raw cash/debt/net debt/history, and declare
  producer no-cap gaps with input dates. Metric Section stale ratio is missing with date reason.
- Depository issuers are classified once from valid own-SEC four-digit SIC major group 60 or 6120. EV, peers,
  EV/revenue, and reverse DCF are inapplicable with rationale; never compute EV. Every Metric Section row on
  operating cash flow, capex, or FCF is inapplicable through one metric-engine gate (`cashFlowBased`, or any
  such input), and the fundamental-history FCF proxy carries the same reason with no points. P/E, P/S, P/B remain when supported.
- Cited structured Web Subject Profile answers may clear matching atomic Business Framework gaps, never
  postures or Evidence Quality. Official earnings dates require exact future date/issuer identity and retained
  Source ID, URL, basis, span. Issuer HTTPS hosts come only from SEC metadata or hand-verified CIK fallback
  with exact-host/subdomain matching, or a `www.<label>.<tld>` host (a whole ASCII token bounded by
  whitespace or ASCII punctuation; two labels; TLD com/net/org or a 2-letter ccTLD; label exactly the 3+ char
  ticker, the full normalized issuer name, or its leading words joined when 4+ chars, the last only when the
  web source text also names the issuer or its ticker) in SEC filing text bound to the issuer: a sec-edgar www.sec.gov
  archive source under the submissions CIK with ticker alias, whose `rawRef` names exactly one current
  (not stale-fallback or compacted) filing-text snapshot. That domain matches only itself or its
  ir/investor(s)/media/news/newsroom/press subdomain. Accepted residual: a bound filing that names a
  ticker- or name-equal domain the issuer does not own, or a name-prefix domain whose page also names the
  issuer, would confirm from it. Absent/malformed identity
  fails closed, never publisher/self-links. SEC
  8-K/6-K must explicitly announce future results, not past Item 2.02.
- Exchange confirmation additionally requires direct disclosure/announcement on checked-in host/path allowlist
  and issuer name or ticker plus issuer context. Calendars, quotes, lookups, symbol equality alone, unknown
  paths, and provider agreement never confirm; Finnhub stays provider-estimated.
- Brief reasoning is specialist → critique → final synthesis; deep adds two concurrent Coverage Panel roles
  before critique, persisted deterministically: regime/mover-theme for overviews,
  instrument-evidence/market-behavior otherwise. Legacy specialist/Coverage Panel is the sole deep-equity
  production path.
- Deterministically include every eligible Domain Playbook per planned stage plus mandatory
  disciplines/subjects, deduped without caps or selector calls. Checked-in base prompts remain reviewable.
  Stages receive normalized evidence/prior output, never authority to widen tools, sources, subjects, or
  persistence. All requests with evidence/history/prior output append shared untrusted-nested-data rule; prior
  output stays nested and unrewritten.
- Final synthesis proposes; deterministic assembly/validation owns shape, Predictions, Evidence Quality, and
  research language. Relocate uncited gap-shaped findings/framework text after deterministic citation fallback
  into data gaps, recording original path/text. Relocation's broad predicate differs from precision-oriented
  warning predicate. Aggregate citation errors across findings/scenarios/completeness/rendered extras; expose
  first twelve plus remaining count. Repair carries latest twelve distinct accumulated errors and accurate
  call/repair counts. Unknown IDs travel as validator data (never re-parsed from messages) into a structured
  `sourceIdRepair`: fixed instruction plus `hints[{citedId, candidates}]`, citedId marked untrusted; candidates
  are catalog IDs whose full (hyphen-aware, longest-match) Source symbol the cited ID names. Off-shape IDs get
  no hint; hints, candidates and size are capped. The model picks; citations are never rewritten.
- Malformed synthesis/repair JSON enters the same bounded validation repair loop with parser
  diagnostic/full-object instruction; never trim or auto-repair reply text. Provider failures are outside it.
  Stop once valid.
- Warning-only audit records unsupported numeric/technical claims, posture omissions, and cited gap-shaped
  claims; no gate reads it, and it cannot prune, fail, or lower Evidence Quality. Separately, Report Integrity
  Audit after valid synthesis/before disagreement prunes findings/scenarios/Predictions without structurally
  eligible support, never asserting semantic entailment. Bare years/FY labels, valid ISO/capitalized-month
  dates, horizon wording, and cited historic forecast outcomes are exempt from numeric classification; posture
  omissions remain advisory. Both are one claim walk with a `warn | prune` severity per rule, so warnings and
  prunes share pre-prune locations; the separate post-prune posture advisory list is gone (amended 2026-11-09).
  Warn rules read the same text as prune rules (a scenario's `name: description`, each summary sentence) and
  also cover Earnings Setup bullets and Business Framework text; summary sentences skip the posture rule,
  since they carry no citations and it would flag every one (amended 2026-11-09).
- When peer comps were collected, the same audit prunes a non-negated peer-median(s) claim that cites no usable
  peer source (warned as `peer-median-uncited`), and any such summary sentence (summaries carry no citations);
  comps carry only EV/revenue, so a median whose own clause names another metric (any EV/x other than
  revenue/sales included) and not EV/revenue is out of scope. A quick-model `peer-median-audit` call (at most one per run,
  only when comps exist and a clause mentions a peer median) labels each clause's compared metric; code still
  decides the prune, and an omitted or unknown label, provider error, or malformed reply falls back to the clause regex. Negation is also judged per clause. Peer ids are never appended: the figure may not come
  from those peers.
- Tagged Zero Debt (collection, amended 2026-11-03; replaces the Verified Quote prose link): debt 0 on a
  footed face with no borrowing row publishes only from the same 10-K/10-Q's SEC-extracted XBRL instance, read as
  XML by a strict namespace-aware reader with a closed XBRL 2.1 grammar (DTDs and custom entities are refused;
  only the predefined and XML-legal numeric character references decode; unknown root subtrees, element children
  in simple values, non-calendar dates, and contexts without exactly one entity and one period throw; schemaRef,
  linkbaseRef, roleRef and arcroleRef must be empty, and a footnoteLink holds only locators, arcs and footnotes of
  XHTML markup; a concept is its expanded name, so any number of non-reserved prefixes may alias one namespace;
  `xml:base`, which the SEC EDGAR Filer Manual forbids, makes the instance, schema or linkbase unreadable),
  plus its `MetaLinks.json` balance and item types (an entry with a bad `crdr`, no `xbrltype`, or a conflicting
  duplicate makes MetaLinks unreadable). Every context must name the issuer's CIK under the SEC scheme; every fact
  at the instant must be in MetaLinks. A fact leaves the census only when its MetaLinks type is a known
  nonmonetary one and its unit fits that type (shares in `xbrli:shares`, per-share in currency over shares, pure
  and percent in `xbrli:pure`, other numeric types in a unit with no currency, non-numeric types with no unit); an
  empty or unknown type never does. A nonmonetary type on a fact MetaLinks gives a `crdr`, or on a us-gaap
  borrowing or listed credit concept, contradicts XBRL 2.1's balance-only-on-monetary rule and rejects as
  `metalinks-contradicts:<concept>`. Every other fact typed monetary, in a currency unit, or nonzero or nil and not
  debit needs exactly one `iso4217` measure in the issuer-wide `Liabilities` currency and a lexical decimal value
  (zero means no nonzero digit, never a number coercion); such a nil fact rejects unless debit or a nil `us-gaap:CommitmentsAndContingencies`, which the taxonomy defines as the balance-sheet caption. The
  instance must tag an allowlisted borrowing concept 0 at the instant, issuer-wide or on facility axes only, and a
  fail-closed census requires every nonzero non-debit monetary fact there, in any context, to be a closed us-gaap
  non-debt credit concept (liability totals only issuer-wide) or an extension-namespace concept the calculation
  linkbase places, with weight exactly 1 in every network (decided on the lexical decimal, so `+01.000` is one and
  `1.0000000000000000001` is not), only under us-gaap operating-lease parents. The schema is the instance's own
  single schemaRef and the linkbase the schema's calculation linkbaseRef, both read as XML and resolved as URLs
  against the document naming them; either outside the filing's accession folder is not fetched. Placement needs
  exactly one calculation source, with no DTS discovery: a second possible calculation linkbaseRef, a calculationLink embedded
  beside it, or a calculation linkbaseRef on the instance is `calculation-linkbase-ambiguous`. Links, locators and
  arcs must carry their XLink types (`extended`, `locator`, `arc`), and locator fragments are percent-decoded
  (a malformed escape is unreadable). A linkbaseRef counts as a calculation source unless its role is the standard
  presentation, label, definition or reference role, because an unspecified role may hold any extended link (XBRL 2.1
  §4.3.4); the same rule applies to the D&A read's conflict. Calc locators
  resolve as URLs against the linkbase: extension hrefs through the xsd's top-level element ids (a duplicate id
  makes it unreadable) and `targetNamespace`, us-gaap only from the `xbrl.fasb.org` schema. A schema whose
  `targetNamespace` is a standard taxonomy's (fasb.org, xbrl.org, sec.gov, ifrs.org, w3.org hosts) is unreadable,
  and placement never pardons a fact in such a namespace, whatever the schema says; conflicting, prohibited or
  non-decimal weights make the linkbase unreadable. The instance, MetaLinks, schema and linkbase are each a cited
  Source on the zero. Prose matching is gone: a regex sentence link and facility-word match were shown to publish
  unsupported zeros and to reject real ones. Residual reliance, not closed by these checks: a borrowing balance
  the issuer leaves untagged, tags as a debit, or folds into an allowlisted aggregate such as
  `AccruedLiabilitiesCurrent` would pass; facility identity is the tag's own members, not a prose reading. CLFD's 10-Qs 2025-12-31 through
  2026-06-30 publish 0 (`LineOfCredit` = 0 on the revolver and Bremer Bank loan agreement members). A rejection
  or a failed instance, MetaLinks or linkbase read withholds with its code and Source Gap.
  A face row off the non-borrowing list withholds as `face-row:<concept>` without requesting the instance. An
  issuer that never tagged debt is checked only at its newest Liabilities instant, from a face already fetched.
  `MARKET_BOT_TAGGED_ZERO_DEBT_DISABLE` withholds every such zero without requesting the instance, MetaLinks or linkbase.
  With the flag set, the withhold reason is always `tagged-zero debt disabled`, since the filing is never inspected.
- Extension short-term investments (collection, amended 2026-11-04): a 10-K/10-Q whose primary document names an issuer-extension
  concept as a typed `StatementOfFinancialPositionLocationBalanceAxis` member gets its XBRL instance, schema and
  calculation linkbase through the same strict readers and accession-scoped requests as Tagged Zero Debt
  (`src/sources/sec-extension-investments-proof.ts`, code only). That line counts as short-term investments at an
  instant only when it adds into `us-gaap:AssetsCurrent` at lexical weight exactly 1, the `AssetsCurrent` children
  (weights ±1) foot exactly to the filed total, and the closed list of us-gaap investment facts located on that line
  (`AvailableForSaleSecuritiesDebtSecurities`) sums exactly to its value, every amount an integer in one currency
  under the issuer's CIK. A located line outside current assets is not a candidate; two proven lines at one instant
  reject both. The proven value enters the EV Bridge only at an instant with no standard short-term investments tag
  and only beside a companyfacts `AssetsCurrent` fact of the same accession, date and value, whose filing date dates
  it; it carries extraction method `sec-xbrl-instance`, the proof text as `shortTermInvestmentsProof`, and one
  cited Source each for the instance, schema and linkbase. A proven line companyfacts cannot confirm (no such
  `AssetsCurrent` fact, a different total, or a currency other than the reporting currency) withholds the EV
  Bridge at that instant with its reason as `shortTermInvestmentsWithheld`, never reading as untagged 0. Proofs of
  one instant from several filings keep the latest filing's value, dated from the earliest filing in its trailing run
  of the same value. A rejection or failed read is a `sec-edgar` Source Gap
  and the bridge keeps its standard reading (eBay 10-Q 0001065088-26-000212: 809M at 2026-09-30 and 1,052M at
  2025-12-31). `MARKET_BOT_EXTENSION_SHORT_TERM_INVESTMENTS_DISABLE` skips the requests and declares
  `extension short-term investments disabled`. Residual reliance: the issuer's own calculation and location tagging.
- Apply the same classifier to uncitable summary sentences: prune numeric/technical sentences, retain
  qualitative ones, never infer citations, and use neutral cited-sections fallback if empty. Record
  `summary[i]` prunes. Stamp integrity high/no pruning, medium/pruning with required sections retained,
  low/pruning emptied previously populated required section; research quality is worse of evidence/integrity.
  Old fields are optional; counts persist, pruned Predictions never reach disagreement/scoring. Deterministic
  alpha-search stamps high without audit; only audited below-high reports may get deterministic quality
  driver. Model repair for pruning remains deferred pending real-run need. The same audit prunes claims that
  fail Verified Web Figure checks ([ADR 0006](./0006-non-sec-issuer-coverage.md)) and declares each as a
  `report.dataGaps` entry.
- Metric references use `<<metric:<section>.<id>>>`: add own-source citations before relocation/validation,
  screen authored tokens, substitute deterministic formatted unit/currency values, rescreen inside repair
  loop, persist resolved prose. Model-quoted prose may resolve with metric provenance, never modify source
  text. Reject unknown/non-value/malformed (including brace-delimited, and any other `<<`/`>>` residue such as a nested or unclosed token, or an unprefixed one whose text is not exactly a catalog section id and metric id; only that exact match, in a cited claim field, is prefixed in code and then validated like any reference, so residue is never rewritten into a cited number) (amended 2026-11-05: "never auto-prefixed" made a missing `metric:` prefix, the first defect reported in 6 of the newest 40 runs, cost up to three full repairs (CRWV 44ca936f); an exact-id match still guesses nothing, which was that rule's intent)/nonfinite/empty/uncited references; one repair error names each invalid claim-field token plus a single rejection for any reference in summary, dataGaps or predictions; any placeholder surviving assembly outside quoted `sources`/`extendedEvidence` and collected extras fails the report; allow only cited
  findings/cases/risks/catalysts/scenarios/framework/Earnings Setup/Spotlights, never summary/gaps/Prediction
  expressions. Each rendered value carries the metric's catalog label in parentheses, and an optional `|period`
  format adds the period label after it (`-162.8% (Diluted EPS YoY, 9-month period ending 2026-09-30)`); a
  change metric's label replaces the bare `change.over` suffix (an empty label keeps the suffix; a label
  that does not name its comparison, such as `Session change`, gets it inside the parentheses), and
  resolved prose is screened both labelled and with bare values, so a label cannot split a blocked phrase
  ([ADR 0001](./0001-research-only-boundary.md)) (amended 2026-11-11: CECO a620231d published diluted EPS YoY under "diluted shares increased" with nothing on
  the page naming the metric; matching the noun stays model judgment). An unknown format or
  `|period` without `periodEnd` rejects for repair like an unknown id. References stay inline tokens, not a
  parallel field, so the existing repair loop, citation merge and replays of tokenless outputs are unchanged.
- Catalog includes Capital Return, five Operating Ratios, six issuer/benchmark returns, framework/lenses,
  Workbench observations, and a reference-only `market-session` section built from the Verified Market
  Snapshot at prompt and assembly time (not persisted as a Metric Section). Rows retain exact ID/label/status, available formatted value, unit/currency,
  basis/period/citations; identical section metadata may inherit defaults, never another row. Exclude raw
  rows/duplicate IDs; reasons stay in artifacts/gaps. Compact JSON and frozen-duration eval preserve
  serialization. Omit exact symbol-scoped nested duplicate gaps only; all
  evidence/analysis/panel/critique/synthesis/repair stages receive catalog, Web Gather/Profile do not.
- Remove migrated framework/lens summary numbers and numeric/period keys from prompt projections, retaining
  nonmigrated prose/phase/posture/freshness. Canonical SEC stops emitting selected-value/period/month keys and
  payout marker; derived values enter catalog, pre-statements fallback reads raw keys. Raw facts/quotes/DSL
  authority and research boundary stay unchanged. Price Performance gaps reach synthesis/history; Web Gather
  excludes unclosable gaps using one predicate across gap lists. Deliberately refresh prompt hashes;
  targeted replay asserts resolved metric/citations ([ADR 0005](./0005-testing-and-replay.md)).
- Market-overview is canonical equity/crypto whole-market workflow: horizon defaults 15, legacy daily/weekly
  aliases map 5/15, new artifacts use canonical job type and old remain readable. Group
  Calibration/history/deltas/correction/provider health by horizon bucket. Catalyst calendars use existing evidence. Disclose daily Yahoo/24-hour CoinGecko mover mismatch with longer
  horizons.
- Alpha-search is deterministic equity-only discovery, not synthesis/scored forecasting: ApeWisdom aggregate
  momentum and SEC current filings originate candidates; official universe/Yahoo validate stock
  eligibility/limits without changing social ranking. Persist leads/rejects/profiles/provenance, no
  Predictions or immediate Calibration. Later explicit/research-triggered score passes may update
  validation/watchlist/attribution/cohorts as research state, never promotion verdicts or
  expected-return/trade language.
- Run Chat uses AI SDK text transport and incremental provider streaming; research/JSON stages remain
  buffered. Bound context to selected artifact/recent browser turns; server is stateless, localStorage may
  retain chat, never run data. Localhost default has same-origin POST protection, no auth/TLS. The
  research-boundary exception is [ADR 0001](./0001-research-only-boundary.md).
- Chat live search is configuration-enabled by default but active only for Codex after one process capability
  probe. Disclose that artifact/questions can leave for provider/web requests; other providers lack search
  until supported. Findings stay ephemeral URL/title-cited conversation, never persisted Sources, Evidence
  Quality, or Predictions.
- Untagged 6-K mapping is noncanonical and production-disabled: on canonical gap emit material gated gap
  before discovery/HTTP/packet/model work, no extraction sidecar. Tests/evals may enable the evaluated
  subsystem separately. Canonical admission needs a future merge/precedence/completeness/history decision;
  immutable corpus admission metadata never enables production.
- When explicitly exercised, map bounded sha256-addressed HTML table packets with cell/header/unit/source
  locators. Model returns allowlisted semantic fields/cell references only, no numeric
  values/periods/currency/scale/signs/calculations/confidence/corrections. Code rereads cells, rejects
  invalid/cross-table references except declared inherited headers, row/column mismatch, ambiguous
  numbers/signs/periods/units, mixed currencies, and duplicate mappings; enforce balance-sheet and available
  pre/post-FX cash reconciliations. Only complete validated statements get model-validated-table values;
  partial/rejected retain issues/gaps, never reclassify evidence. Images/PDF/oversized/ambiguous layouts
  remain unsupported.

## Consequences

- Missing evidence degrades transparently; raw replay data, normalized current evidence, and model-visible
  text remain distinct.
- Deterministic financial/peer views remain research context. SEC quarter/YTD ambiguity and coarse SIC
  economics require disclosures; diluted-EPS TTM is approximate, and the sanitizer does not cover every
  Unicode confusable.
- The retained deep reasoning path accepts extra tokens/latency. Warning audits do not prove factual
  correctness; structural pruning can empty sections and grades that honestly rather than padding.
- Chat can incur provider/search costs and disclose content; same-origin is not authentication when exposed.
  Unsupported table layouts need separate architectural evaluation, never silent canonical admission.
