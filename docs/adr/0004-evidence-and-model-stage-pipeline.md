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
  not prove listing age. Issuer returns use own sessions; SPY comparisons require common completed sessions
  and benchmark coverage. Missing SPY preserves issuer returns; fetch failure declares Yahoo gap. Workbench
  outside-window status needs requested start and usable returned closes; unavailable history, interior
  missing bars, and failures remain material. Lifecycle values require cited classification inputs. Price
  Performance, Workbench, and snapshot share issuer history; the first two share completed split-adjusted
  closes/source IDs.
- Financial Lens metrics retain per-metric citations: SEC for filing-intrinsic facts, Yahoo for
  price-relative/non-US fallback. Parent `NetIncomeLoss` remains net income; consolidated `ProfitLoss` is
  otherwise separate, same-period disclosure. ROE/ROA keep parent income and existing balance scopes.
- The one sanctioned tag splice: a period without `NetIncomeLoss` takes a derived `ProfitLoss` net income
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
  through summaries, Growth, framework, trends, and Workbench P/E; label growth scope.
- Cash conversion pairs OCF/income by operations scope, period, currency, and unit. Missing compatible
  continuing income withholds ratio with gap; zero denominator withholds without gap. Deterministic
  Markdown/Console EPS/P/E disclosure retains provider basis as undisclosed and SEC approximate
  diluted/continuing TTM with dates; state two-decimal agreement, mismatch, or currency mismatch without
  substitution or invented explanation.
- Fundamental History selects revenue concepts by configured order within 100 days of newest eligible period;
  other series prefer newest period then order. Scope-bearing order outranks depth/prior availability, remains
  test-pinned, and whole-concept selection never splices tags, except operating cash flow: each period takes
  the continuing amount where it is tagged, differs from total, and is as current; else total when the period
  reports no discontinued operations; else total minus the discontinued component filed with the newest total (a recast supersedes it, APLD FY2023):
  `CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations` (HLIT FY2025: 107,966K − 2,532K); else it is withheld with a gap. Capex has no scope tag; FCF bases say it
  is used as reported. Narrower current concepts carry continuing-operation labels through every OCF/FCF consumer. Apply cutoff; keep up to ten 10–14-month 10-K
  periods and latest-filed restatements. Derive TTM as FY + aligned current YTD − prior YTD; mismatches are
  omitted/audited. EPS TTM is approximate; FCF/margins/CAGR/margin change need matched periods/units and CAGR
  is annual-only.
- A canonical versioned financial-statements artifact accepts standard us-gaap/ifrs-full 10-K/Q/20-F/6-K and
  amendments. It drives history, lenses, valuation, APIs, and completeness through tested seams; fundamental
  history has no legacy derivation. Offline canonical/legacy financial-lens corpus differences need matches
  or exact fixture-specific allowances. Historical non-deep
  artifacts without sidecars/completeness stay readable.
- Canonical facts apply cutoff before selection, one taxonomy/currency, no extension primary totals; matching
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
  constituent details. Restated components need one filing date (same-day accessions count together) and
  unchanged original total (reclassification), otherwise no composite. Later incomplete filings supersede
  earlier complete same-instant data. A debt series may mix recognized totals and
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
  depreciation (or nonproduction) plus intangible amortization, both known at cutoff; never infer zero.
  Equality/within tolerance keeps combined. Rejected/incomplete fallback emits period-specific omission/gap
  and Markdown/Console note; retain lineage and name EBITDA proxy basis. A selected combined fact more than 1%
  below the other same-period combined alias (DDA under DA) is withheld, never replaced by the higher alias; the
  reverse split publishes. IFRS is unchanged.
- Never splice alternative financial concepts to extend history. Shortening is silent unless an alias has a
  newer annual period, or any annual period when selected has none: emit `stale-concept-history` without
  combining. Offline alias detection requires eligible same-unit/currency strict annual superset with exact
  shared value/form/fiscal/period/filing tuples; no-overlap renames are not interchangeable proof. EPS TTM can
  mix independently restated YTD facts and remains approximate. Consistent integer/reciprocal share
  restatements mark older incompatible periods `mixed-share-basis`; never rescale, withhold touching TTM/EPS
  CAGR/priors, and disclose on charts/tables.
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
  `reporting-currency-incompatible`, `subsequent-financing-unreconciled`. All are no-cap; exclude
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
  debt/equity, debt/cap, net-debt/cap; retain dated raw cash/debt/history, and declare producer no-cap gaps
  with input dates. Metric Section stale ratio is missing with date reason.
- Depository issuers are classified once from valid own-SEC four-digit SIC major group 60 or 6120. EV, peers,
  EV/revenue, reverse DCF, and capex P/FCF are inapplicable with rationale; never compute EV. P/E, P/S, P/B
  remain when supported.
- Cited structured Web Subject Profile answers may clear matching atomic Business Framework gaps, never
  postures or Evidence Quality. Official earnings dates require exact future date/issuer identity and retained
  Source ID, URL, basis, span. Issuer HTTPS hosts come only from SEC metadata or hand-verified CIK fallback
  with exact-host/subdomain matching, or a `www.<label>.<tld>` host (a whole ASCII token bounded by
  whitespace or ASCII punctuation; two labels; TLD com/net/org or a 2-letter ccTLD; label exactly the 3+ char
  ticker or full normalized issuer name) in SEC filing text bound to the issuer: a sec-edgar www.sec.gov
  archive source under the submissions CIK with ticker alias, whose `rawRef` names exactly one current
  (not stale-fallback or compacted) filing-text snapshot. That domain matches only itself or its
  ir/investor(s)/media/news/newsroom/press subdomain. Accepted residual: a bound filing that names a
  ticker- or name-equal domain the issuer does not own would confirm from it. Absent/malformed identity
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
  omissions remain advisory.
- Apply the same classifier to uncitable summary sentences: prune numeric/technical sentences, retain
  qualitative ones, never infer citations, and use neutral cited-sections fallback if empty. Record
  `summary[i]` prunes. Stamp integrity high/no pruning, medium/pruning with required sections retained,
  low/pruning emptied previously populated required section; research quality is worse of evidence/integrity.
  Old fields are optional; counts persist, pruned Predictions never reach disagreement/scoring. Deterministic
  alpha-search stamps high without audit; only audited below-high reports may get deterministic quality
  driver. Model repair for pruning remains deferred pending real-run need.
- Metric references use `<<metric:<section>.<id>>>`: add own-source citations before relocation/validation,
  screen authored tokens, substitute deterministic formatted unit/currency values, rescreen inside repair
  loop, persist resolved prose. Model-quoted prose may resolve with metric provenance, never modify source
  text. Reject unknown/non-value/malformed (including brace-delimited, and any other `<<`/`>>` residue such as an unprefixed, nested or unclosed token, never auto-prefixed)/nonfinite/empty/uncited references; any placeholder surviving assembly outside quoted `sources`/`extendedEvidence` and collected extras fails the report; allow only cited
  findings/cases/risks/catalysts/scenarios/framework/Earnings Setup/Spotlights, never summary/gaps/Prediction
  expressions. An optional `|period` format appends the metric's period label; an unknown format or
  `|period` without `periodEnd` rejects for repair like an unknown id. References stay inline tokens, not a
  parallel field, so the existing repair loop, citation merge and replays of tokenless outputs are unchanged.
- Catalog includes Capital Return, five Operating Ratios, six issuer/SPY returns, framework/lenses,
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
